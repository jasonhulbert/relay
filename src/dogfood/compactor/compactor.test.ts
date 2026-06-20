import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  parseFrontmatter,
  pendingIntents,
  readManifest,
  readNode,
  tryReadLayer,
} from '../../relay-state/index';
import { commitRoot } from '../../intake/index';
import { compactorSeed } from './seed';
import { GOLDEN, buildCompactorFixture } from './fixture';
import { compactEvidence } from './compactor';

// A byte-for-byte digest of a directory tree (sorted rel paths + content hashes), used
// to prove the compactor left a region — the baseline store, the F5 telemetry —
// completely untouched. A single changed/added/removed byte changes the digest.
async function hashTree(root: string): Promise<string> {
  const parts: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Phase 1 validation criterion 1: "The outcome spec and grounding are committed via
// intake." The compactor seed is compiled through the REAL intake compiler and
// committed by the REAL `commitRoot` — the same path a live conversation takes — so
// this is the falsifiable "spec+grounding commit via intake" claim, hermetic and
// deterministic (no live model).
describe('the compactor outcome spec and grounding commit via intake', () => {
  test('the seed compiles and commits as a childless root carrying every grounded check', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-seed-'));
    const relayDir = join(base, '.relay');
    try {
      // The seed parses through intake's own validation (which rejects an ungrounded
      // check, §6) — so a successful compile already proves every check is grounded.
      const seed = compactorSeed();
      expect(seed.spec.outcome).toMatch(/compactor/i);
      // Five grounded facets: live-ref retention, orphan drop, retained compression,
      // manifest write, baseline-store exclusion (D2 / F2).
      expect(seed.spec.verifications).toHaveLength(5);
      expect(seed.spec.verifications.every((v) => v.grounding.trim() !== '')).toBe(true);
      expect(seed.spec.verifications.every((v) => v.kind === 'test')).toBe(true);
      // The baseline-store exclusion facet is present and grounded (F2) — the one the
      // compactor must honor even though baselines do not exist until M8.
      expect(seed.spec.verifications.some((v) => /baseline[- ]store/i.test(v.grounding))).toBe(
        true,
      );

      const { rootId } = await commitRoot(relayDir, seed, {
        createdAt: '2026-06-19T00:00:00.000Z',
      });

      // The committed root carries the outcome spec and grounded verifications verbatim.
      const manifest = await readManifest(relayDir);
      expect(manifest.spec).toEqual(seed.spec);

      // Intake commits NO binding decomposition: the root is a childless pending branch
      // with no layer manifest (the brain owns the first layer at activation), and the
      // commit is one clean atomic transaction (C8) — no pending intent left behind.
      const root = await readNode(relayDir, rootId);
      expect(root.kind).toBe('branch');
      expect(root.status).toBe('pending');
      expect(root.children).toEqual([]);
      expect(await tryReadLayer(relayDir, rootId)).toBeNull();
      expect(await pendingIntents(relayDir, rootId)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Phase 1 validation criterion 2: "The fixture enumerates which refs are live, which
// are orphaned, and which baseline-store paths must be untouched." These assert that
// GOLDEN is internally consistent AND that it matches what the fixture actually
// materializes — so Phase 2 can trust GOLDEN as the graded contract.
describe('the compactor fixture enumerates live refs, orphans, and untouched baselines', () => {
  test('GOLDEN is internally consistent: live and orphans disjoint, retained == live', () => {
    expect(GOLDEN.liveRefs.length).toBeGreaterThan(0);
    expect(GOLDEN.orphanedCaptures.length).toBeGreaterThan(0);
    expect(GOLDEN.untouchedBaselinePaths.length).toBeGreaterThan(0);

    // A capture cannot be both live and orphaned.
    const live = new Set(GOLDEN.liveRefs);
    expect(GOLDEN.orphanedCaptures.some((p) => live.has(p))).toBe(false);

    // Retained-for-compression is exactly the live set (a live capture is retained).
    expect([...GOLDEN.retainedForCompression].sort()).toEqual([...GOLDEN.liveRefs].sort());
  });

  test('the built fixture matches GOLDEN: live refs come from node files, orphans are unreferenced, baselines sit outside .relay/', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-fixture-'));
    try {
      const fx = await buildCompactorFixture(base);

      // "Which refs are live" — collect every evidence ref recorded across the node
      // files and assert it equals GOLDEN.liveRefs. The enumeration is grounded in the
      // actual `.relay/` records, not asserted alongside them.
      const refPaths: string[] = [];
      for (const id of ['root', 'leaf-a', 'leaf-b']) {
        const n = await readNode(fx.relayDir, id);
        for (const r of n.evidenceRefs) refPaths.push(r.path);
      }
      expect([...refPaths].sort()).toEqual([...GOLDEN.liveRefs].sort());

      // Every live capture exists on disk under the evidence dir and is reachable.
      for (const p of GOLDEN.liveRefs) {
        expect((await stat(join(fx.evidenceDir, p))).isFile()).toBe(true);
      }

      // "Which are orphaned" — each orphan exists on disk but is named by NO live ref.
      const liveSet = new Set(refPaths);
      for (const p of GOLDEN.orphanedCaptures) {
        expect((await stat(join(fx.evidenceDir, p))).isFile()).toBe(true);
        expect(liveSet.has(p)).toBe(false);
      }

      // "Which baseline-store paths must be untouched" — each exists in the baseline
      // store, and the store is a SIBLING of `.relay/` (a scan of `.relay/` cannot
      // reach it), so excluding baselines from compaction is structural (F2).
      const rel = relative(fx.relayDir, fx.baselineStoreDir);
      expect(rel.startsWith('..')).toBe(true);
      for (const p of GOLDEN.untouchedBaselinePaths) {
        const abs = join(fx.baselineStoreDir, p);
        expect((await stat(abs)).isFile()).toBe(true);
        // Content-addressed: the path's hash segment is the sha256 of the content.
        const body = await readFile(abs, 'utf8');
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256').update(body).digest('hex');
        expect(p).toContain(hash);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Phase 2 deliverable + validation: the compactor passes golden and property tests
// against the fixture. These five `test`-kind selectors are NAMED EXACTLY to satisfy
// the committed seed's checks (`vitest run dogfood/compactor -t "…"`, see seed.ts), so
// the run's critic grades the dogfood against the same suite a reader can run by hand.
// WHY each matters: the compactor is the FIRST real-work outcome the spine drives
// through its own loop (D2); if any facet — retain live, drop orphan, compress, write a
// truthful manifest, never touch baselines — were wrong, the loop would certify a
// broken compactor as done. The fixture (`GOLDEN`) is the graded ground truth.
describe('the evidence compactor honors its outcome facets against the fixture', () => {
  test('retains every live ref', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-live-'));
    try {
      const fx = await buildCompactorFixture(base);
      await compactEvidence(fx.relayDir, fx.runId);
      // Every live ref still resolves to a file after the run (compression is in
      // place, so the ref path is unchanged) — nothing a live node points at is lost.
      for (const p of GOLDEN.liveRefs) {
        expect(await fileExists(join(fx.evidenceDir, p))).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('drops orphaned captures', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-orphan-'));
    try {
      const fx = await buildCompactorFixture(base);
      const manifest = await compactEvidence(fx.relayDir, fx.runId);
      // Each orphan — present in the fixture, named by no live ref — is gone, and the
      // manifest's `dropped` set is exactly the golden orphan set.
      for (const p of GOLDEN.orphanedCaptures) {
        expect(await fileExists(join(fx.evidenceDir, p))).toBe(false);
      }
      expect(manifest.dropped).toEqual([...GOLDEN.orphanedCaptures].sort());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('compresses retained captures', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-compress-'));
    try {
      const fx = await buildCompactorFixture(base);
      // Capture each retained file's on-disk size BEFORE compaction.
      const before = new Map<string, number>();
      for (const p of GOLDEN.retainedForCompression) {
        before.set(p, (await stat(join(fx.evidenceDir, p))).size);
      }
      const manifest = await compactEvidence(fx.relayDir, fx.runId);
      // Every retained capture is measurably smaller on disk than the fixture wrote it.
      for (const p of GOLDEN.retainedForCompression) {
        const after = (await stat(join(fx.evidenceDir, p))).size;
        expect(after).toBeLessThan(before.get(p) ?? 0);
      }
      // The manifest's `compressed` set is exactly the retained set (each shrank).
      expect(manifest.compressed).toEqual([...GOLDEN.retainedForCompression].sort());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('writes a compaction manifest', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-manifest-'));
    try {
      const fx = await buildCompactorFixture(base);
      const manifest = await compactEvidence(fx.relayDir, fx.runId);
      // The returned manifest enumerates kept/dropped/compressed matching GOLDEN:
      // live kept, orphans dropped, retained compressed.
      expect(manifest.kept).toEqual([...GOLDEN.liveRefs].sort());
      expect(manifest.dropped).toEqual([...GOLDEN.orphanedCaptures].sort());
      expect(manifest.compressed).toEqual([...GOLDEN.retainedForCompression].sort());
      // It is also persisted to the evidence dir and round-trips through the
      // front-matter codec to the same machine record (the body is human-only).
      const persisted = await readFile(join(fx.evidenceDir, 'compaction.md'), 'utf8');
      expect(parseFrontmatter(persisted).data).toEqual(manifest);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('leaves the baseline store byte-for-byte unchanged', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-baseline-'));
    try {
      const fx = await buildCompactorFixture(base);
      // The content-addressed baseline store is a SIBLING of `.relay/` (F2); the
      // compactor never names it, so it must hash identically before and after.
      const beforeHash = await hashTree(fx.baselineStoreDir);
      await compactEvidence(fx.relayDir, fx.runId);
      expect(await hashTree(fx.baselineStoreDir)).toBe(beforeHash);
      // And every enumerated baseline object is still present.
      for (const p of GOLDEN.untouchedBaselinePaths) {
        expect(await fileExists(join(fx.baselineStoreDir, p))).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (Phase 2 F5 decision): per-call usage/cost telemetry lives UNDER the evidence
  // dir but is governed by F5's prune-after-rollup rule, not orphan-drop. A compactor
  // that swept the evidence dir naively would eat these (no live ref names them). This
  // pins the decision that the compactor PRESERVES them byte-for-byte.
  test('preserves F5 usage and cost telemetry', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-telemetry-'));
    try {
      const fx = await buildCompactorFixture(base);
      const before = new Map<string, string>();
      for (const p of GOLDEN.preservedTelemetry) {
        before.set(p, await readFile(join(fx.evidenceDir, p), 'utf8'));
      }
      const manifest = await compactEvidence(fx.relayDir, fx.runId);
      for (const p of GOLDEN.preservedTelemetry) {
        expect(await readFile(join(fx.evidenceDir, p), 'utf8')).toBe(before.get(p));
        // Telemetry is neither kept-as-capture, dropped, nor compressed.
        expect(manifest.kept).not.toContain(p);
        expect(manifest.dropped).not.toContain(p);
        expect(manifest.compressed).not.toContain(p);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Property tests: the golden fixture pins one hand-authored scenario; these assert the
// compactor's INVARIANTS hold across an arbitrary number of additional orphans. WHY:
// orphan-dropping must be exhaustive and indifferent to count/name (a real run leaves
// however many cancelled-attempt captures behind), and live retention + baseline/
// telemetry exclusion must survive regardless. A compactor that dropped only the
// fixture's two known orphans, or that scaled badly, would pass the golden tests and
// fail here.
describe('compactor invariants hold for any set of extra orphans', () => {
  // Distinct orphan file names under a dedicated subdir, disjoint from live refs and
  // telemetry by construction (so the arbitrary never collides with a retained path).
  const extraOrphans = fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,12}$/), { minLength: 0, maxLength: 6 })
    .map((names) => names.map((n) => `orphans/extra-${n}.md`));

  test('every orphan is dropped, every live ref kept, baselines+telemetry untouched', async () => {
    await fc.assert(
      fc.asyncProperty(extraOrphans, async (orphanPaths) => {
        const base = await mkdtemp(join(tmpdir(), 'relay-compactor-prop-'));
        try {
          const fx = await buildCompactorFixture(base);
          // Sprinkle arbitrary extra orphans into the evidence dir (no live ref names
          // them), then snapshot the regions that must not change.
          for (const rel of orphanPaths) {
            const abs = join(fx.evidenceDir, ...rel.split('/'));
            await mkdir(join(abs, '..'), { recursive: true });
            await writeFile(abs, `arbitrary orphan ${rel}\n`, 'utf8');
          }
          const baselineHash = await hashTree(fx.baselineStoreDir);
          const telemetryBefore = new Map<string, string>();
          for (const p of GOLDEN.preservedTelemetry) {
            telemetryBefore.set(p, await readFile(join(fx.evidenceDir, p), 'utf8'));
          }

          const manifest = await compactEvidence(fx.relayDir, fx.runId);

          // Invariant 1: every orphan (fixture + arbitrary) is gone and recorded.
          const allOrphans = [...GOLDEN.orphanedCaptures, ...orphanPaths].sort();
          expect(manifest.dropped).toEqual(allOrphans);
          for (const p of allOrphans) {
            expect(await fileExists(join(fx.evidenceDir, ...p.split('/')))).toBe(false);
          }
          // Invariant 2: every live ref survives.
          expect(manifest.kept).toEqual([...GOLDEN.liveRefs].sort());
          for (const p of GOLDEN.liveRefs) {
            expect(await fileExists(join(fx.evidenceDir, p))).toBe(true);
          }
          // Invariant 3: baselines and F5 telemetry are byte-for-byte unchanged.
          expect(await hashTree(fx.baselineStoreDir)).toBe(baselineHash);
          for (const p of GOLDEN.preservedTelemetry) {
            expect(await readFile(join(fx.evidenceDir, p), 'utf8')).toBe(telemetryBefore.get(p));
          }
        } finally {
          await rm(base, { recursive: true, force: true });
        }
      }),
      { numRuns: 12 },
    );
  });
});
