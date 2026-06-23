import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseFrontmatter, relayPaths } from '../relay-state/index';
import { compactEvidence } from '../dogfood/compactor/compactor';
import { replayAndGrade } from './visual-critic';
import type { VisualVerification } from './visual-critic';
import type { Screenshot, Surface } from './types';
import {
  BaselineStore,
  DEFAULT_FLAKE_BUDGET,
  approveReVersion,
  diffAgainstBaseline,
  exactBytesDiffer,
  makeBaselineGrader,
  promoteBaseline,
  readBaselineRef,
  requestReVersion,
  verifyBaselineDiff,
} from './baseline';
import type { BaselineContext, BaselineMismatch, ScreenshotDiffer } from './baseline';

// A capture identified by its bytes, so a hash/diff assertion is meaningful.
function shot(data: string, mimeType = 'image/png'): Screenshot {
  return { data: Buffer.from(data).toString('base64'), mimeType };
}

// A byte-for-byte digest of a directory tree (sorted rel paths + content hashes), to
// prove the compactor left the baseline store completely untouched — a single
// changed/added/removed byte changes the digest. Mirrors the compactor test's helper.
async function hashTree(root: string): Promise<string> {
  const parts: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), childRel);
      else if (e.isFile()) {
        const body = await readFile(join(dir, e.name));
        parts.push(`${childRel}:${createHash('sha256').update(body).digest('hex')}`);
      }
    }
  }
  await walk(root, '');
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// A configurable in-memory Surface for the grade tests: screenshots come from a
// per-call list (so a retry sees a different frame), and `queryState` throws when the
// app is scripted dead (the liveness probe the mismatch path gates on).
function fakeSurface(cfg: { shots: Screenshot[]; alive?: boolean }): Surface {
  let i = 0;
  return {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: async () => undefined,
    resize: async () => undefined,
    snapshot: async () => ({ tree: '' }),
    screenshot: async () => {
      // Last frame repeats once the list is exhausted (a steady state after retries).
      const s = cfg.shots[Math.min(i, cfg.shots.length - 1)];
      i += 1;
      return s;
    },
    interact: async () => undefined,
    queryState: async () => {
      if (cfg.alive === false) throw new Error('app is gone');
      return { value: 'true' };
    },
    close: async () => undefined,
  };
}

// A sink that records every surfaced mismatch, so a test can assert a decision was
// surfaced (rather than an overwrite or a silent pass).
function recordingSink(): {
  sink: (m: BaselineMismatch) => Promise<void>;
  seen: BaselineMismatch[];
} {
  const seen: BaselineMismatch[] = [];
  return {
    seen,
    sink: async (m) => {
      seen.push(m);
    },
  };
}

async function tempBase(): Promise<{ relayDir: string; storeDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-baseline-'));
  return { relayDir: join(base, '.relay'), storeDir: join(base, 'baselines') };
}

function ctxFor(
  relayDir: string,
  storeDir: string,
  opts: { outcomeId?: string; differ?: ScreenshotDiffer; sink?: BaselineContext['sink'] } = {},
): { ctx: BaselineContext; seen: BaselineMismatch[] } {
  const rec = recordingSink();
  return {
    seen: rec.seen,
    ctx: {
      store: new BaselineStore(storeDir),
      relayDir,
      outcomeId: opts.outcomeId ?? 'outcome-1',
      differ: opts.differ ?? exactBytesDiffer,
      sink: opts.sink ?? rec.sink,
      budget: DEFAULT_FLAKE_BUDGET,
    },
  };
}

// WHY (deliverable: capture-and-promote at structural-or-better; store/ref split;
// structural-or-better gating). The first structural-or-better pass promotes a
// baseline whose BINARY is in the content-addressed store and whose REF is a Markdown
// file in `.relay/` — binaries never enter files-only `.relay/`. The
// structural-or-better gate is what keeps a loose intent pass from freezing a sloppy
// UI as ground truth, so it is code-enforced, not trusted to the caller.
describe('capture-and-promote', () => {
  test('first structural pass writes the binary to the store and the ref to .relay/', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    const capture = shot('frame-A');

    const ref = await promoteBaseline(ctx, capture, { granularity: 'structural', tolerance: 0.02 });

    // The ref carries exactly the content-addressed-store fields (hash, outcome-id,
    // granularity, version, tolerance) and is version 1.
    expect(ref).toMatchObject({
      outcomeId: 'outcome-1',
      granularity: 'structural',
      version: 1,
      tolerance: 0.02,
      mimeType: 'image/png',
    });
    expect(ref.hash).toBe(createHash('sha256').update(Buffer.from('frame-A')).digest('hex'));

    // Binary is in the store (retrievable by hash), bytes intact.
    const stored = await ctx.store.get(ref.hash);
    expect(stored?.toString()).toBe('frame-A');

    // Ref is a real Markdown file in `.relay/baselines/`, parseable, machine record
    // matches — and the store binary is NOT under `.relay/` (files-only).
    const refPath = relayPaths(relayDir).baselineRefFile('outcome-1');
    const parsed = parseFrontmatter(await readFile(refPath, 'utf8'));
    expect(parsed.data).toMatchObject({ hash: ref.hash, version: 1, granularity: 'structural' });
    const onDisk = await readBaselineRef(relayDir, 'outcome-1');
    expect(onDisk).toEqual(ref);
  });

  test('an intent-only pass is refused (promotion is gated at structural-or-better)', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    await expect(
      promoteBaseline(ctx, shot('frame-A'), { granularity: 'intent', tolerance: 0 }),
    ).rejects.toThrow(/structural-or-better/i);
    expect(await readBaselineRef(relayDir, 'outcome-1')).toBeNull();
  });

  test('promoting over an existing baseline is refused — re-version needs approval', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'structural', tolerance: 0 });
    await expect(
      promoteBaseline(ctx, shot('frame-B'), { granularity: 'structural', tolerance: 0 }),
    ).rejects.toThrow(/already exists|requestReVersion/i);
  });
});

// WHY (deliverable: content-addressed store EXCLUDED from the compactor). The store is
// a sibling of `.relay/`, so the evidence compactor — which scans only
// `.relay/evidence/<runId>/` — is structurally incapable of touching it. This pins
// that: a real compaction run that drops an orphan capture leaves the store's digest
// byte-for-byte identical. If someone ever rooted the store inside `.relay/evidence/`,
// this fails.
describe('the baseline store is excluded from a compaction run', () => {
  test('a compaction that drops an orphan leaves the sibling store untouched', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    const ref = await promoteBaseline(ctx, shot('frame-A'), {
      granularity: 'structural',
      tolerance: 0,
    });

    // A minimal real evidence dir with one ORPHAN capture (no node names it) so the
    // compactor has actual work to do — it must drop the orphan but never the store.
    const runId = 'run-1';
    await mkdir(relayPaths(relayDir).nodesDir, { recursive: true });
    const evidenceDir = relayPaths(relayDir).evidenceDir(runId);
    await mkdir(join(evidenceDir, 'leaf'), { recursive: true });
    const orphan = join(evidenceDir, 'leaf', 'orphan.txt');
    await writeFile(orphan, 'orphaned capture');

    const before = await hashTree(storeDir);
    const manifest = await compactEvidence(relayDir, runId);
    const after = await hashTree(storeDir);

    expect(manifest.dropped).toContain('leaf/orphan.txt'); // compaction actually ran
    expect(after).toBe(before); // ...and the store is byte-for-byte untouched
    expect((await ctx.store.get(ref.hash))?.toString()).toBe('frame-A'); // still retrievable
  });
});

// WHY (deliverable: re-versioning a known-good baseline needs human approval; prior
// versions persist by hash). Code never silently overwrites a baseline — telling an
// intended redesign from a regression is the one judgment the baseline is not
// an oracle for. A re-version ATTEMPT surfaces a decision and leaves the ref alone;
// only an APPROVED re-version bumps the version, and the prior binary stays
// retrievable by hash.
describe('re-versioning is human-gated; prior versions persist by hash', () => {
  test('a re-version attempt surfaces a decision rather than overwriting', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx, seen } = ctxFor(relayDir, storeDir);
    const v1 = await promoteBaseline(ctx, shot('frame-A'), {
      granularity: 'structural',
      tolerance: 0,
    });

    const mismatch = await requestReVersion(ctx, shot('frame-B'));

    // A decision was surfaced (not an overwrite, not a silent pass).
    expect(seen).toHaveLength(1);
    expect(mismatch.kind).toBe('re-version');
    expect(mismatch.baselineHash).toBe(v1.hash);
    expect(mismatch.candidateHash).toBe(
      createHash('sha256').update(Buffer.from('frame-B')).digest('hex'),
    );

    // The ref is UNCHANGED — still v1, still pointing at frame-A.
    const stillV1 = await readBaselineRef(relayDir, 'outcome-1');
    expect(stillV1?.version).toBe(1);
    expect(stillV1?.hash).toBe(v1.hash);
    // The prior (current) version remains retrievable by hash.
    expect((await ctx.store.get(v1.hash))?.toString()).toBe('frame-A');
  });

  test('an approved re-version bumps the version; the prior stays retrievable by hash', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    const v1 = await promoteBaseline(ctx, shot('frame-A'), {
      granularity: 'structural',
      tolerance: 0,
    });
    const mismatch = await requestReVersion(ctx, shot('frame-B'));

    const v2 = await approveReVersion(ctx, mismatch.candidateHash);

    expect(v2.version).toBe(2);
    expect(v2.hash).toBe(mismatch.candidateHash);
    expect(v2.history).toEqual([{ hash: v1.hash, version: 1 }]);
    // BOTH versions are retrievable by hash (content addressing: nothing overwritten).
    expect((await ctx.store.get(v1.hash))?.toString()).toBe('frame-A');
    expect((await ctx.store.get(v2.hash))?.toString()).toBe('frame-B');
    // The current ref on disk reflects v2.
    expect((await readBaselineRef(relayDir, 'outcome-1'))?.version).toBe(2);
  });

  test('approving a candidate not in the store fails loud', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'structural', tolerance: 0 });
    await expect(approveReVersion(ctx, 'deadbeef')).rejects.toThrow(/not in the baseline store/i);
  });
});

// WHY (deliverable: flake budget = spatial tolerance + retry count; never auto-pass,
// never silent fail). The grade path is the baseline-diff-rung + structural-or-better
// behavior the visual critic delegates to: a within-tolerance diff passes, a transient
// above-tolerance diff is absorbed by the retry budget, and a PERSISTENT
// above-tolerance diff against a healthy app surfaces a mismatch decision AND returns a
// non-pass — the two halves of "never an auto-pass and never a silent fail".
describe('baseline-diff grading + flake budget', () => {
  const baselineDiff = (tolerance?: number): VisualVerification =>
    tolerance === undefined
      ? { granularity: 'baseline-diff', path: [] }
      : { granularity: 'baseline-diff', path: [], tolerance };

  test('the first capture auto-promotes (nothing to regress against yet)', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    const grade = await verifyBaselineDiff(
      fakeSurface({ shots: [shot('frame-A')] }),
      baselineDiff(0) as Extract<VisualVerification, { granularity: 'baseline-diff' }>,
      ctx,
    );
    expect(grade.pass).toBe(true);
    expect(grade.rationale).toMatch(/promoted/i);
    expect((await readBaselineRef(relayDir, 'outcome-1'))?.version).toBe(1);
  });

  test('an identical second frame passes within tolerance', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'baseline-diff', tolerance: 0 });
    const grade = await verifyBaselineDiff(
      fakeSurface({ shots: [shot('frame-A')] }),
      baselineDiff(0) as Extract<VisualVerification, { granularity: 'baseline-diff' }>,
      ctx,
    );
    expect(grade.pass).toBe(true);
    expect(grade.rationale).toMatch(/within tolerance/i);
  });

  test('a scripted distance at-or-below tolerance passes; above-then-within is absorbed by retries', async () => {
    const { relayDir, storeDir } = await tempBase();
    // Differ keyed on the candidate's bytes: 'good' → 0.01 (within 0.05), 'bad' → 0.5.
    const differ: ScreenshotDiffer = async (_b, c) =>
      Buffer.from(c.data, 'base64').toString().startsWith('bad') ? 0.5 : 0.01;
    const { ctx } = ctxFor(relayDir, storeDir, { differ });
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'baseline-diff', tolerance: 0.05 });

    // First frame is 'bad' (above tolerance) but the retry sees 'good' (within) — the
    // temporal flake budget absorbs the transient frame, so the grade passes.
    const grade = await verifyBaselineDiff(
      fakeSurface({ shots: [shot('bad-1'), shot('good-1')] }),
      baselineDiff(0.05) as Extract<VisualVerification, { granularity: 'baseline-diff' }>,
      ctx,
    );
    expect(grade.pass).toBe(true);
    expect(grade.rationale).toMatch(/after 1 retry/i);
  });

  test('a persistent above-tolerance diff against a healthy app surfaces a mismatch (no auto-pass)', async () => {
    const { relayDir, storeDir } = await tempBase();
    const differ: ScreenshotDiffer = async () => 0.9; // always above any sane tolerance
    const { ctx, seen } = ctxFor(relayDir, storeDir, { differ });
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'baseline-diff', tolerance: 0.05 });

    const grade = await verifyBaselineDiff(
      fakeSurface({ shots: [shot('drift')], alive: true }),
      baselineDiff(0.05) as Extract<VisualVerification, { granularity: 'baseline-diff' }>,
      ctx,
    );

    expect(grade.pass).toBe(false); // never an auto-pass
    expect(seen).toHaveLength(1); // ...and never a silent fail — a decision is surfaced
    expect(seen[0]).toMatchObject({ kind: 'regression', tolerance: 0.05, distance: 0.9 });
    expect(grade.rationale).toMatch(/mismatch decision surfaced/i);
  });

  test('a persistent above-tolerance diff against a DEAD app is a real failure, not a mismatch', async () => {
    const { relayDir, storeDir } = await tempBase();
    const differ: ScreenshotDiffer = async () => 0.9;
    const { ctx, seen } = ctxFor(relayDir, storeDir, { differ });
    await promoteBaseline(ctx, shot('frame-A'), { granularity: 'baseline-diff', tolerance: 0.05 });

    const grade = await verifyBaselineDiff(
      fakeSurface({ shots: [shot('drift')], alive: false }),
      baselineDiff(0.05) as Extract<VisualVerification, { granularity: 'baseline-diff' }>,
      ctx,
    );

    expect(grade.pass).toBe(false);
    expect(seen).toHaveLength(0); // a mismatch requires a HEALTHY app
    expect(grade.rationale).toMatch(/not healthy|real failure/i);
  });
});

// WHY (deliverable: wire baseline-diff into `replayAndGrade`, which the structural rung
// left throwing "owned by the baseline-diff rung"). The grader is injected exactly like
// the intent judge:
// with it, `replayAndGrade` grades the rung; without it, it fails loud rather than
// silently skipping the strictest rung.
describe('replayAndGrade baseline-diff integration', () => {
  const v: VisualVerification = { granularity: 'baseline-diff', path: [], tolerance: 0 };

  test('with an injected BaselineGrader, replayAndGrade grades the baseline rung', async () => {
    const { relayDir, storeDir } = await tempBase();
    const { ctx } = ctxFor(relayDir, storeDir);
    const surface = fakeSurface({ shots: [shot('frame-A')] });
    const verdict = await replayAndGrade(surface, v, { baseline: makeBaselineGrader(ctx) });
    expect(verdict.outcome).toBe('graded');
    if (verdict.outcome === 'graded') expect(verdict.grade.pass).toBe(true);
  });

  test('without a grader, the baseline rung fails loud (no silent skip)', async () => {
    const surface = fakeSurface({ shots: [shot('frame-A')] });
    await expect(replayAndGrade(surface, v)).rejects.toThrow(
      /requires an injected BaselineGrader/i,
    );
  });
});

// A direct exercise of the single-capture decision, independent of the retry loop —
// promote-first, then within/above the tolerance boundary.
describe('diffAgainstBaseline single-capture decision', () => {
  test('promotes when absent, then classifies within/above tolerance', async () => {
    const { relayDir, storeDir } = await tempBase();
    const differ: ScreenshotDiffer = async (_b, c) =>
      Buffer.from(c.data, 'base64').toString() === 'frame-A' ? 0 : 0.3;
    const { ctx } = ctxFor(relayDir, storeDir, { differ });

    const first = await diffAgainstBaseline(ctx, shot('frame-A'), 0.1);
    expect(first.kind).toBe('promoted');

    const same = await diffAgainstBaseline(ctx, shot('frame-A'), 0.1);
    expect(same).toEqual({ kind: 'within-tolerance', distance: 0 });

    const drifted = await diffAgainstBaseline(ctx, shot('frame-Z'), 0.1);
    expect(drifted).toEqual({ kind: 'above-tolerance', distance: 0.3 });
  });
});
