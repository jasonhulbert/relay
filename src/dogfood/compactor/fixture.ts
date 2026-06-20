// The evidence-compactor dogfood fixture (design D2, M7 Phase 1): a byte-deterministic
// `.relay/` store plus a sibling content-addressed baseline store, and `GOLDEN` — the
// golden expectations the compactor is graded against. Phase 2's compactor runs over a
// freshly built copy of this fixture and asserts against `GOLDEN`.
//
// The fixture is built the same way the rest of the suite builds state: a programmatic
// writer into a caller-supplied dir (cf. `seedFixture`), with fixed content and
// timestamps so two builds are identical. The `.relay/` records are written through the
// real relay-state serializers, so the node files carry exactly the `evidenceRefs`
// shape the compactor will read — the fixture cannot drift from the on-disk contract.
//
// What the fixture deliberately models (and what it does not): live captures (named by
// a surviving node's refs), orphaned captures (left by a cancelled/superseded attempt,
// named by no live ref — exactly what the rehydration contract discards), and a
// baseline store that lives OUTSIDE `.relay/` so a scan of `.relay/` cannot reach it.
// Per-call usage/cost records are out of scope here: how the compactor treats those
// (F5 says they are prunable after rollup) is a Phase 2 design choice, not something
// Phase 1 should pre-decide into the fixture.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writeManifest, writeNode, writeUsage } from '../../relay-state/index';
import type { CallUsage, EvidenceRef, NodeRecord, RootManifest } from '../../relay-state/index';

const RUN_ID = 'run-1';
const CREATED_AT = '2026-06-19T00:00:00.000Z';

// A live capture's content is made repetitive so Phase 2's compression check is
// meaningful: a retained capture must be measurably smaller after compaction, which
// requires it to be compressible in the first place.
function captureBody(label: string): string {
  return `# ${label}\n\n${`relay evidence capture line for ${label}.\n`.repeat(40)}`;
}

// Live captures: each is named by a surviving (done) node's evidence ref. Path is
// relative to the run's evidence dir, matching `EvidenceRef.path` semantics.
const LIVE: { node: string; path: string; kind: EvidenceRef['kind']; summary: string }[] = [
  { node: 'leaf-a', path: 'leaf-a/diff.md', kind: 'diff', summary: 'leaf-a unified diff' },
  {
    node: 'leaf-a',
    path: 'leaf-a/self-report.md',
    kind: 'self-report',
    summary: 'leaf-a self-report',
  },
  { node: 'leaf-b', path: 'leaf-b/diff.md', kind: 'diff', summary: 'leaf-b unified diff' },
  { node: 'leaf-b', path: 'leaf-b/verdict.md', kind: 'verdict', summary: 'leaf-b critic verdict' },
];

// Orphaned captures: real files in the evidence dir that NO live ref points at — a
// superseded first-attempt transcript and a discarded re-dispatch's diff. The
// compactor must drop exactly these.
const ORPHANS: string[] = ['leaf-a/transcript-attempt-0.md', 'orphans/cancelled-leaf-c-diff.md'];

// The fixture baseline store's logical entries. Content-addressed: the on-disk path is
// derived from the content hash (F2), so the store is genuinely content-addressed
// rather than carrying invented filenames. The compactor must leave every one of these
// byte-for-byte unchanged.
const BASELINE_OBJECTS: { label: string; content: string }[] = [
  { label: 'home-view baseline', content: 'PNGDATA:home-view:v1:opaque-binary-stand-in\n' },
  { label: 'detail-panel baseline', content: 'PNGDATA:detail-panel:v1:opaque-binary-stand-in\n' },
];

function baselineObjectPath(content: string): string {
  // Content-addressed: `objects/<sha256>`; binaries never live in files-only `.relay/`,
  // only this sibling store (F2). The `.bin` suffix marks it opaque, not Markdown.
  const hash = createHash('sha256').update(content).digest('hex');
  return `objects/${hash}.bin`;
}

// F5 per-call usage/cost telemetry that lives UNDER the evidence dir but is NOT a
// capture (Phase 2 decision): one live node's executor usage record and the run-level
// cost rollup. Phase 1 left these out; Phase 2 adds them to PIN the decision that the
// compactor PRESERVES F5 telemetry (governed by F5's prune-after-rollup rule) rather
// than mistaking it for an orphan. `usage/` records and `cost.md` are excluded from the
// compactor's capture scan, so they must be byte-for-byte unchanged after a run.
const USAGE_RECORD: CallUsage = {
  runId: RUN_ID,
  nodeId: 'leaf-a',
  role: 'executor',
  seq: 1,
  provider: 'claude',
  model: 'claude-haiku-4-5',
  inputTokens: 1200,
  cachedInputTokens: 800,
  outputTokens: 240,
  wallClockMs: 5000,
  costUsd: 0.0012,
  costSource: 'direct',
};
// Evidence-dir-relative path the usage writer lands the record at.
const USAGE_REL = `${USAGE_RECORD.nodeId}/usage/${USAGE_RECORD.role}-${USAGE_RECORD.seq.toString()}.md`;
// The run-level cost rollup (design §8), a read-time projection over per-call records.
// A fixed stand-in body is enough: the compactor must leave it untouched, not parse it.
const COST_ROLLUP_REL = 'cost.md';
const COST_ROLLUP_BODY = `# cost rollup (${RUN_ID})\n\n- run total: $0.001200\n`;

// Golden expectations: the single enumeration Phase 2 grades the compactor against and
// the explicit answer to "which refs are live, which are orphaned, and which
// baseline-store paths must be untouched." Live refs and orphans are disjoint by
// construction; retained-for-compression is exactly the live set (a live capture is
// retained, and retained captures are compressed).
export const GOLDEN = {
  runId: RUN_ID,
  // Captures (relative to evidence/<runId>/) named by a live node ref — must survive.
  liveRefs: LIVE.map((c) => c.path),
  // Captures present on disk that no live ref names — must be dropped.
  orphanedCaptures: [...ORPHANS],
  // Retained captures the compactor must compress (== the live set).
  retainedForCompression: LIVE.map((c) => c.path),
  // Baseline-store files (relative to the baseline store dir) that must be untouched.
  untouchedBaselinePaths: BASELINE_OBJECTS.map((o) => baselineObjectPath(o.content)),
  // F5 telemetry under the evidence dir the compactor must PRESERVE byte-for-byte
  // (Phase 2 decision): per-call usage records and the cost rollup, not captures.
  preservedTelemetry: [COST_ROLLUP_REL, USAGE_REL],
} as const;

export interface CompactorFixture {
  // The built `.relay/` store root.
  relayDir: string;
  // The run's evidence dir (evidence/<runId>/) the compactor scans.
  evidenceDir: string;
  // The content-addressed baseline store, a SIBLING of `.relay/` (never under it).
  baselineStoreDir: string;
  runId: string;
}

function node(
  id: string,
  status: NodeRecord['status'],
  refs: EvidenceRef[],
  children: string[],
): NodeRecord {
  return {
    id,
    parentId: id === 'root' ? null : 'root',
    kind: children.length > 0 ? 'branch' : 'leaf',
    status,
    spec: {
      outcome: `${id} outcome`,
      verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
    },
    children,
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: refs,
    blocked: null,
  };
}

// Build the fixture into `baseDir`: a `.relay/` store with live-ref-bearing node files
// and an evidence dir holding both live and orphaned captures, plus a sibling
// content-addressed baseline store. Deterministic — fixed content and timestamps — so
// Phase 2 can rebuild a clean copy per run and compare exactly.
export async function buildCompactorFixture(baseDir: string): Promise<CompactorFixture> {
  const relayDir = join(baseDir, '.relay');
  const baselineStoreDir = join(baseDir, 'baselines');
  const evidenceDir = join(relayDir, 'evidence', RUN_ID);

  const refFor = (c: (typeof LIVE)[number]): EvidenceRef => ({
    runId: RUN_ID,
    path: c.path,
    kind: c.kind,
    summary: c.summary,
  });

  const manifest: RootManifest = {
    runId: RUN_ID,
    rootId: 'root',
    spec: {
      outcome: 'the evidence store carries live and orphaned captures',
      verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
    },
    sketch: { notes: [] },
    createdAt: CREATED_AT,
  };
  await writeManifest(relayDir, manifest);

  await writeNode(relayDir, node('root', 'done', [], ['leaf-a', 'leaf-b']));
  await writeNode(
    relayDir,
    node('leaf-a', 'done', LIVE.filter((c) => c.node === 'leaf-a').map(refFor), []),
  );
  await writeNode(
    relayDir,
    node('leaf-b', 'done', LIVE.filter((c) => c.node === 'leaf-b').map(refFor), []),
  );

  // Materialize every capture (live + orphaned) under the evidence dir.
  for (const c of LIVE) {
    const abs = join(evidenceDir, c.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, captureBody(c.path), 'utf8');
  }
  for (const path of ORPHANS) {
    const abs = join(evidenceDir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, captureBody(path), 'utf8');
  }

  // Materialize the sibling content-addressed baseline store (F2).
  for (const obj of BASELINE_OBJECTS) {
    const abs = join(baselineStoreDir, baselineObjectPath(obj.content));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, obj.content, 'utf8');
  }

  // F5 telemetry the compactor must preserve: a per-call usage record (written through
  // the real usage serializer, so it carries the on-disk shape the compactor's scan
  // must skip) and the run-level cost rollup.
  await writeUsage(relayDir, USAGE_RECORD);
  await writeFile(join(evidenceDir, COST_ROLLUP_REL), COST_ROLLUP_BODY, 'utf8');

  return { relayDir, evidenceDir, baselineStoreDir, runId: RUN_ID };
}
