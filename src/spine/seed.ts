// Hand-seeded fixture root: a branch with one leaf (M1 assumption). The real
// intake compiler that commits the `.relay/` root from a human conversation is
// M6 (design §3.11); here we write the seed directly so the walking-skeleton loop
// has a tree to drive. Seeding writes the initial state with the plain Phase-1
// writers (no transition to journal yet — there is no prior state to be atomic
// against).
import { writeManifest, writeNode } from '../relay-state/index';
import type { NodeRecord, OutcomeSpec, RootManifest } from '../relay-state/index';

export interface SeedOptions {
  runId?: string;
  rootId?: string;
  leafId?: string;
  // The leaf's command verification (design §6.3, kind `command`). Defaults to a
  // deterministic always-pass check so the skeleton's happy path is hermetic.
  check?: string;
}

export interface SeedResult {
  runId: string;
  rootId: string;
  leafId: string;
}

// M2 adds the sub-orchestrator level between root and leaf.
export interface HierarchySeedResult extends SeedResult {
  midId: string;
}

function commandSpec(outcome: string, check: string): OutcomeSpec {
  return {
    outcome,
    verifications: [{ kind: 'command', grounding: 'the verification command exits 0', check }],
  };
}

export async function seedFixture(relayDir: string, opts: SeedOptions = {}): Promise<SeedResult> {
  const runId = opts.runId ?? 'run-1';
  const rootId = opts.rootId ?? 'root';
  const leafId = opts.leafId ?? 'leaf-1';
  const check = opts.check ?? 'true';

  const manifest: RootManifest = {
    runId,
    rootId,
    spec: commandSpec('the seeded run completes end-to-end', check),
    // Fixed so the fixture is byte-deterministic across runs (kill-and-rehydrate
    // compares the resulting `.relay/` records exactly).
    createdAt: '2026-06-18T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);

  const leaf: NodeRecord = {
    id: leafId,
    parentId: rootId,
    kind: 'leaf',
    status: 'pending',
    spec: commandSpec('the leaf produces its change and the command check passes', check),
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  const root: NodeRecord = {
    id: rootId,
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: commandSpec('the seeded branch integrates its one leaf', check),
    children: [leafId],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  await writeNode(relayDir, leaf);
  await writeNode(relayDir, root);

  return { runId, rootId, leafId };
}

// Hand-seeded two-level fixture: a root branch whose one child is itself a branch
// (the sub-orchestrator) that owns one leaf (M2 assumption). This is the smallest
// tree that exercises one-process-per-orchestrator (C6): the root spawns the mid
// branch as a separate process, which runs the leaf in its own region. Same
// fixed-timestamp determinism as `seedFixture` so kill-and-rehydrate can compare
// the resulting `.relay/` byte-for-byte.
export async function seedHierarchy(
  relayDir: string,
  opts: SeedOptions & { midId?: string } = {},
): Promise<HierarchySeedResult> {
  const runId = opts.runId ?? 'run-1';
  const rootId = opts.rootId ?? 'root';
  const midId = opts.midId ?? 'mid';
  const leafId = opts.leafId ?? 'leaf-1';
  const check = opts.check ?? 'true';

  const manifest: RootManifest = {
    runId,
    rootId,
    spec: commandSpec('the seeded hierarchical run completes end-to-end', check),
    createdAt: '2026-06-18T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);

  const leaf: NodeRecord = {
    id: leafId,
    parentId: midId,
    kind: 'leaf',
    status: 'pending',
    spec: commandSpec('the leaf produces its change and the command check passes', check),
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  const mid: NodeRecord = {
    id: midId,
    parentId: rootId,
    kind: 'branch',
    status: 'pending',
    spec: commandSpec('the sub-orchestrator integrates its one leaf', check),
    children: [leafId],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  const root: NodeRecord = {
    id: rootId,
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: commandSpec('the seeded branch integrates its one sub-orchestrator', check),
    children: [midId],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  await writeNode(relayDir, leaf);
  await writeNode(relayDir, mid);
  await writeNode(relayDir, root);

  return { runId, rootId, midId, leafId };
}
