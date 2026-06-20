// The baseline pipeline (design §7.5, V6/F2) — the V4 baseline-diff rung Phase 3
// deliberately deferred. It captures, promotes, versions, and budgets baselines
// safely, and plugs into the visual critic as the injected `BaselineGrader`.
//
// Four design pins live here:
//   - V6 capture-and-promote: a baseline is captured from a passing run, never
//     authored from nothing, and promotion is gated at STRUCTURAL-OR-BETTER (an
//     intent-only pass cannot freeze a sloppy UI as ground truth). The first run
//     auto-promotes; there is nothing to diff against yet.
//   - F2 storage split: the binary lives in a durable, content-addressed store that
//     is a SIBLING of `.relay/` (so the evidence compactor, which scans only
//     `.relay/evidence/<runId>/`, can never reach it); `.relay/` holds only the
//     Markdown ref — hash, outcome-id, granularity, version, tolerance.
//   - F2 re-versioning: replacing a known-good baseline is the one spot a model
//     cannot rule (intended redesign vs regression is exactly the judgment V6 says
//     the baseline is not an oracle for), so code NEVER silently overwrites: a
//     re-version surfaces a mismatch decision for human approval, and prior versions
//     persist by hash (content addressing makes that structural).
//   - F2 flake budget: two per-outcome fields — a spatial tolerance (perceptual-diff
//     distance at-or-below which a diff passes) and the temporal retry count from
//     V5's transient path. A persistent above-tolerance diff against a HEALTHY app
//     surfaces a mismatch decision — never an auto-pass and never a silent fail.
//
// Two seams are injected, matching the rest of `src/surface/` (the `IntentJudge`
// pattern): the perceptual `ScreenshotDiffer` (the real sub-pixel algorithm is wired
// at M9; tests script distances) and the `MismatchSink` (M9 routes it to the human
// decision inbox / web view; tests record it). The module is unwired from the
// orchestrator loop — M9 wires it, like Phases 1–3.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  atomicWriteFile,
  parseFrontmatter,
  relayPaths,
  serializeFrontmatter,
} from '../relay-state/index';
import type {
  BaselineGrader,
  MatchGranularity,
  VisualGrade,
  VisualVerification,
} from './visual-critic';
import type { Screenshot, Surface } from './types';

// The baseline-diff arm of the verification union (V4 rung 3) — the only granularity
// this pipeline grades.
type BaselineVerification = Extract<VisualVerification, { granularity: 'baseline-diff' }>;

// The durable Markdown ref `.relay/baselines/<outcomeId>.md` carries (F2). The
// binary itself never lands here — only this pointer into the content-addressed
// store. `history` records every superseded version newest-last; each entry is
// still retrievable from the store by its hash (content addressing guarantees prior
// versions persist).
export interface BaselineRef {
  outcomeId: string;
  // sha256 of the current promoted capture's bytes; the store key.
  hash: string;
  // The rung the promotion was earned at — structural or baseline-diff (never
  // intent; V6 gates at structural-or-better).
  granularity: MatchGranularity;
  // 1-based; bumps only on a human-approved re-version.
  version: number;
  // Spatial flake tolerance: perceptual distance at-or-below which a diff passes.
  tolerance: number;
  // The image MIME type of the stored bytes, so a diff can reconstruct the
  // `Screenshot` shape the differ compares.
  mimeType: string;
  // Superseded versions, newest-last; each still in the store by `hash`.
  history: { hash: string; version: number }[];
}

// The perceptual-diff seam (the flake budget's spatial half). Returns a normalized
// distance in [0,1] — 0 = identical. The real sub-pixel algorithm (pixelmatch over
// decoded PNGs) is wired at M9; `exactBytesDiffer` is the honest v0.1 default and
// tests inject scripted distances to exercise the tolerance gradient. NO model.
export type ScreenshotDiffer = (baseline: Screenshot, candidate: Screenshot) => Promise<number>;

// The v0.1 default differ: identical bytes → 0, anything else → 1. A faithful lower
// bound (it never reports a within-tolerance pass for a frame that actually changed)
// that keeps the pipeline runnable before the perceptual differ is wired at M9 — the
// same "real algorithm injected later" discipline as the `IntentJudge`.
export const exactBytesDiffer: ScreenshotDiffer = (baseline, candidate) =>
  Promise.resolve(baseline.data === candidate.data && baseline.mimeType === candidate.mimeType ? 0 : 1);

// Why a known-good baseline is being asked to change (F2). `re-version` is an
// explicit replacement request (e.g. an intended redesign); `regression` is a
// persistent above-tolerance diff a run surfaced. Either way a human rules.
export type BaselineMismatchKind = 're-version' | 'regression';

// The decision the pipeline surfaces rather than overwriting or silently failing
// (F2). It mirrors a human-decision shape WITHOUT coupling to relay-state's
// human-owned `cancel` inbox — M9 maps it onto the surfacing region exactly as the
// spine maps a `VisualGrade` onto a durable `CriticVerdict`.
export interface BaselineMismatch {
  outcomeId: string;
  kind: BaselineMismatchKind;
  // The current known-good baseline (what a regression diverges from / a re-version
  // would replace).
  baselineHash: string;
  // The new capture proposed (re-version) or observed (regression), already stored
  // by hash so an approval can promote it by reference.
  candidateHash: string;
  // The current baseline version the decision acts on.
  version: number;
  // The perceptual distance for a regression; null for a direct re-version request.
  distance: number | null;
  tolerance: number;
  // The approve-new-baseline-or-treat-as-regression framing for the human.
  humanFacing: string;
}

// Where a surfaced mismatch goes (F2). Injected so the pipeline never writes the
// human-owned inbox itself; M9 routes it to the decision inbox / web view, tests
// record it.
export type MismatchSink = (mismatch: BaselineMismatch) => Promise<void>;

// The flake budget (F2): the two per-outcome knobs. Conservative defaults — strict
// tolerance (raised per-outcome only where rendering is non-deterministic) and a
// small temporal retry count to absorb a transient render flake before a diff is
// treated as a real mismatch.
export interface FlakeBudget {
  // Perceptual distance at-or-below which a diff passes.
  tolerance: number;
  // Re-capture attempts for a transient above-tolerance diff (V5's temporal path).
  retries: number;
}

export const DEFAULT_FLAKE_BUDGET: FlakeBudget = { tolerance: 0, retries: 2 };

// Everything the pipeline needs that the orchestrator (M9) owns. `relayDir` is where
// the Markdown ref lives; `store` is the sibling content-addressed binary store.
export interface BaselineContext {
  store: BaselineStore;
  relayDir: string;
  outcomeId: string;
  differ: ScreenshotDiffer;
  sink: MismatchSink;
  budget: FlakeBudget;
}

// Atomic binary write (mirrors relay-state's `atomicWriteFile`, which is utf8-only):
// temp sibling → fsync → rename, so a crash leaves the target old-or-new, never torn.
async function atomicWriteBytes(path: string, bytes: Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid.toString()}-${Date.now().toString()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh?.close();
  }
  await rename(tmp, path);
}

// The durable, content-addressed baseline binary store (F2). A SIBLING of `.relay/`
// — the caller roots it outside the `.relay/` tree, so the evidence compactor (which
// scans only `.relay/evidence/<runId>/`) is structurally incapable of reaching it.
// Content addressing is the versioning mechanism: a distinct capture has a distinct
// hash and thus a distinct path, so promoting a new version NEVER overwrites a prior
// one — prior versions persist by hash for free.
export class BaselineStore {
  constructor(private readonly root: string) {}

  // Sharded path `root/<aa>/<hash>` — no extension; bytes are opaque and the MIME
  // type lives in the ref. The two-char shard keeps any one directory small.
  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }

  // Store bytes and return their content hash. Write-once: identical content hashes
  // to the same path, so a re-put is a no-op rather than a rewrite.
  async put(bytes: Buffer): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = this.pathFor(hash);
    if (!(await this.has(hash))) {
      await atomicWriteBytes(path, bytes);
    }
    return hash;
  }

  async get(hash: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(hash));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(hash: string): Promise<boolean> {
    return (await this.get(hash)) !== null;
  }
}

function renderRefBody(ref: BaselineRef): string {
  const lines = [
    `# baseline \`${ref.outcomeId}\` (v${ref.version.toString()})`,
    '',
    `- Hash: \`${ref.hash}\``,
    `- Granularity: ${ref.granularity}`,
    `- Tolerance: ${ref.tolerance.toString()}`,
    `- MIME: ${ref.mimeType}`,
  ];
  if (ref.history.length > 0) {
    lines.push(`- Prior versions: ${ref.history.map((h) => `v${h.version.toString()}`).join(', ')}`);
  }
  return lines.join('\n');
}

// Fail loud (Rule 11) on a malformed ref rather than hand a half-typed baseline to
// the grade path, where a missing hash would silently mis-resolve the store.
function assertRefShape(data: unknown): asserts data is BaselineRef {
  const r = data as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) throw new Error('baseline ref is not a mapping');
  if (typeof r.outcomeId !== 'string') throw new Error('baseline ref missing string `outcomeId`');
  if (typeof r.hash !== 'string') throw new Error('baseline ref missing string `hash`');
  if (typeof r.version !== 'number') throw new Error('baseline ref missing number `version`');
  if (typeof r.tolerance !== 'number') throw new Error('baseline ref missing number `tolerance`');
  if (typeof r.mimeType !== 'string') throw new Error('baseline ref missing string `mimeType`');
}

export async function readBaselineRef(
  relayDir: string,
  outcomeId: string,
): Promise<BaselineRef | null> {
  const path = relayPaths(relayDir).baselineRefFile(outcomeId);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const { data } = parseFrontmatter(text);
  assertRefShape(data);
  return {
    outcomeId: data.outcomeId,
    hash: data.hash,
    granularity: data.granularity,
    version: data.version,
    tolerance: data.tolerance,
    mimeType: data.mimeType,
    history: data.history ?? [],
  };
}

export async function writeBaselineRef(relayDir: string, ref: BaselineRef): Promise<void> {
  const path = relayPaths(relayDir).baselineRefFile(ref.outcomeId);
  await atomicWriteFile(path, serializeFrontmatter(ref, renderRefBody(ref)));
}

function screenshotBytes(shot: Screenshot): Buffer {
  return Buffer.from(shot.data, 'base64');
}

// Capture-and-promote the FIRST baseline for an outcome (V6). Two gates are
// code-enforced rather than trusted to the caller:
//   - structural-or-better — an `intent` granularity is refused (V6: intent is the
//     loosest rung and would freeze a plausible-but-sloppy UI as ground truth);
//   - no silent overwrite — if a baseline already exists, promotion is refused and
//     the caller must go through `requestReVersion` + human approval (F2).
// Writes the binary to the sibling store and the ref to `.relay/` as version 1.
export async function promoteBaseline(
  ctx: BaselineContext,
  capture: Screenshot,
  opts: { granularity: MatchGranularity; tolerance: number },
): Promise<BaselineRef> {
  if (opts.granularity === 'intent') {
    throw new Error(
      'baseline promotion is gated at structural-or-better (V6); refusing to promote an intent-only pass',
    );
  }
  const existing = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (existing) {
    throw new Error(
      `baseline for "${ctx.outcomeId}" already exists (v${existing.version.toString()}); replacing a known-good baseline requires requestReVersion + human approval (F2)`,
    );
  }
  const hash = await ctx.store.put(screenshotBytes(capture));
  const ref: BaselineRef = {
    outcomeId: ctx.outcomeId,
    hash,
    granularity: opts.granularity,
    version: 1,
    tolerance: opts.tolerance,
    mimeType: capture.mimeType,
    history: [],
  };
  await writeBaselineRef(ctx.relayDir, ref);
  return ref;
}

// A re-version ATTEMPT on a known-good baseline (F2). It NEVER overwrites: it stores
// the candidate by hash (so an approval can promote it by reference, and the prior
// version stays retrievable) and surfaces a `re-version` mismatch decision for human
// approval. Returns the surfaced decision. Throws if there is no baseline to
// re-version (use `promoteBaseline` for the first one).
export async function requestReVersion(
  ctx: BaselineContext,
  candidate: Screenshot,
): Promise<BaselineMismatch> {
  const ref = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (!ref) {
    throw new Error(
      `no known-good baseline for "${ctx.outcomeId}" to re-version; promote a first baseline instead`,
    );
  }
  const candidateHash = await ctx.store.put(screenshotBytes(candidate));
  const mismatch: BaselineMismatch = {
    outcomeId: ctx.outcomeId,
    kind: 're-version',
    baselineHash: ref.hash,
    candidateHash,
    version: ref.version,
    distance: null,
    tolerance: ref.tolerance,
    humanFacing: `Re-version requested for "${ctx.outcomeId}" (currently v${ref.version.toString()}). Approve to replace the known-good baseline, or reject to keep it. The prior version stays retrievable by hash.`,
  };
  await ctx.sink(mismatch);
  return mismatch;
}

// Apply a human-APPROVED re-version (F2) — the deterministic transform the approval
// decision triggers (M9 drains the approval and calls this). Bumps the version,
// points the ref at the approved candidate, and pushes the superseded version into
// `history`; the prior binary stays in the store by its hash (content addressing),
// so it remains retrievable. Throws if the candidate is not in the store.
export async function approveReVersion(
  ctx: BaselineContext,
  candidateHash: string,
  opts: { granularity?: MatchGranularity; tolerance?: number } = {},
): Promise<BaselineRef> {
  const ref = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (!ref) throw new Error(`no baseline for "${ctx.outcomeId}" to re-version`);
  if (!(await ctx.store.has(candidateHash))) {
    throw new Error(`approved candidate ${candidateHash} is not in the baseline store`);
  }
  const next: BaselineRef = {
    outcomeId: ref.outcomeId,
    hash: candidateHash,
    granularity: opts.granularity ?? ref.granularity,
    version: ref.version + 1,
    tolerance: opts.tolerance ?? ref.tolerance,
    mimeType: ref.mimeType,
    history: [...ref.history, { hash: ref.hash, version: ref.version }],
  };
  await writeBaselineRef(ctx.relayDir, next);
  return next;
}

// The single-capture outcome of a baseline check, free of any retry/loop concern so
// the caller owns the temporal flake budget. `promoted` is the first-baseline
// auto-promote (V6); `within-tolerance` is a pass; `above-tolerance` may be a
// transient flake the caller retries, or — if it persists — a mismatch.
export type BaselineDiffResult =
  | { kind: 'promoted'; ref: BaselineRef }
  | { kind: 'within-tolerance'; distance: number }
  | { kind: 'above-tolerance'; distance: number };

// Diff one capture against the stored baseline (V6/F2). No baseline yet → auto-promote
// the first one (granularity `baseline-diff`, since reaching this rung is at-or-above
// structural). Otherwise reconstruct the baseline `Screenshot` from the store and run
// the injected perceptual differ; compare the distance to `tolerance`. Fails loud if
// the ref names a hash the store has lost.
export async function diffAgainstBaseline(
  ctx: BaselineContext,
  capture: Screenshot,
  tolerance: number,
): Promise<BaselineDiffResult> {
  const ref = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (!ref) {
    const promoted = await promoteBaseline(ctx, capture, {
      granularity: 'baseline-diff',
      tolerance,
    });
    return { kind: 'promoted', ref: promoted };
  }
  const baseBytes = await ctx.store.get(ref.hash);
  if (!baseBytes) {
    throw new Error(`baseline binary missing from store for hash ${ref.hash} ("${ctx.outcomeId}")`);
  }
  const baseline: Screenshot = { data: baseBytes.toString('base64'), mimeType: ref.mimeType };
  const distance = await ctx.differ(baseline, capture);
  if (distance <= tolerance) return { kind: 'within-tolerance', distance };
  return { kind: 'above-tolerance', distance };
}

// Probe the app's liveness the same way V5 does (a trivial `query_state`): a mismatch
// is only surfaced against a HEALTHY app (F2). If the probe throws, the app died —
// that is a real failure, not an intended-redesign-vs-regression judgment.
async function isHealthy(surface: Surface): Promise<boolean> {
  try {
    await surface.queryState({ function: '() => true' });
    return true;
  } catch {
    return false;
  }
}

// Grade a baseline-diff verification end to end (V4 rung 3 + V6/F2 + the flake
// budget). Re-captures up to `retries` times to absorb a transient above-tolerance
// diff (the temporal budget); a diff that PERSISTS above tolerance against a healthy
// app surfaces a `regression` mismatch decision and returns a non-pass — never an
// auto-pass and never a silent fail. If the app is not healthy, it is reported as an
// unhealthy non-pass (a real failure), NOT a mismatch (which requires a healthy app).
// Captures are V7-scoped to the verification's element when one is declared.
export async function verifyBaselineDiff(
  surface: Surface,
  verification: BaselineVerification,
  ctx: BaselineContext,
): Promise<VisualGrade> {
  const tolerance = verification.tolerance ?? ctx.budget.tolerance;
  const shotOpts = verification.scope
    ? verification.scope.element !== undefined
      ? { ref: verification.scope.ref, element: verification.scope.element }
      : { ref: verification.scope.ref }
    : undefined;

  // First capture + diff, then re-capture for each remaining retry. The first
  // within-tolerance (or promote) result wins; only a result that stays above
  // tolerance across the whole budget is treated as persistent.
  let lastDistance = Number.NaN;
  const attempts = Math.max(0, ctx.budget.retries) + 1;
  for (let i = 0; i < attempts; i++) {
    const capture = await surface.screenshot(shotOpts);
    const result = await diffAgainstBaseline(ctx, capture, tolerance);
    if (result.kind === 'promoted') {
      return {
        pass: true,
        rationale: `baseline-diff: first capture promoted as baseline v1 (${result.ref.granularity}), nothing to regress against yet`,
      };
    }
    if (result.kind === 'within-tolerance') {
      const note = i > 0 ? ` after ${i.toString()} retry(s)` : '';
      return {
        pass: true,
        rationale: `baseline-diff: within tolerance (distance ${result.distance.toString()} ≤ ${tolerance.toString()})${note}`,
      };
    }
    lastDistance = result.distance;
  }

  // Persistently above tolerance. A mismatch is only meaningful against a healthy
  // app; a dead app is a real failure on its own terms (V5), not a redesign judgment.
  if (!(await isHealthy(surface))) {
    return {
      pass: false,
      rationale: `baseline-diff: above tolerance (distance ${lastDistance.toString()} > ${tolerance.toString()}) but the app is not healthy — real failure, not a mismatch`,
    };
  }

  const ref = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (!ref) {
    // Unreachable in practice (an above-tolerance result implies a baseline existed),
    // but fail loud rather than surface a mismatch with no baseline to name.
    throw new Error(`above-tolerance diff for "${ctx.outcomeId}" but no baseline ref found`);
  }
  const candidateHash = await ctx.store.put(screenshotBytes(await surface.screenshot(shotOpts)));
  const mismatch: BaselineMismatch = {
    outcomeId: ctx.outcomeId,
    kind: 'regression',
    baselineHash: ref.hash,
    candidateHash,
    version: ref.version,
    distance: lastDistance,
    tolerance,
    humanFacing: `Baseline-diff for "${ctx.outcomeId}" stayed above tolerance (distance ${lastDistance.toString()} > ${tolerance.toString()}) against a healthy app. Approve the new capture as baseline v${(ref.version + 1).toString()}, or treat it as a regression.`,
  };
  await ctx.sink(mismatch);
  return {
    pass: false,
    rationale: `baseline-diff: persistent above-tolerance diff (distance ${lastDistance.toString()} > ${tolerance.toString()}) — mismatch decision surfaced for human approval`,
  };
}

// Build the injected `BaselineGrader` the visual critic calls for the baseline-diff
// rung (V4 rung 3). Closes over the pipeline context so `replayAndGrade` stays
// ignorant of the store/diff/decision machinery — the same seam shape as `IntentJudge`.
export function makeBaselineGrader(ctx: BaselineContext): BaselineGrader {
  return (surface, verification) => verifyBaselineDiff(surface, verification, ctx);
}
