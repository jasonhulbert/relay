// The code-owned orchestrator state machine (design §3, §3.10). It owns the
// loop, every `.relay/` transition (through the intent journal, C8), and all
// dispatch; the model is called only for judgment (stubbed in M1). One OS process
// per active orchestrator (C6) — so `runOrchestrator` is BOTH the loop and the
// rehydration loader: re-running it against a node-id rolls forward any
// interrupted transaction and re-drives any non-`done` child (the rehydration
// contract, §3.2).
//
// M1 scope: single process, a seeded branch with one leaf, stub executor + stub
// critic, command-only verification. Concurrency (§3.8), promotion (§3.5), and
// the failure ladder (§3.9) are later milestones.
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  applyIntent,
  atomicWriteFile,
  commit,
  readManifest,
  readNode,
  relativeNodePath,
  relayPaths,
  rollForwardPending,
  runCritic,
  serializeNode,
  toCriticView,
  writeIntent,
} from '../relay-state/index';
import type { CriticSpawn, EvidenceRef, NodeRecord, NodeStatus } from '../relay-state/index';
import { stubExecutor } from './executor';
import type { Executor } from './executor';
import { stubCritic } from './critic';

// Points at which a test may model a process kill. A thrown `InjectedKill` is
// indistinguishable from a SIGKILL for the rehydration contract: `.relay/` is the
// only durable state, so a fresh `runOrchestrator` starting from it must reach
// the same terminal state whether the prior process was killed or threw here.
export type FaultPoint =
  | 'before-dispatch'
  | 'after-executor'
  | 'after-self-report'
  | 'leaf-done-intent'
  | 'after-leaf-done';

export class InjectedKill extends Error {
  constructor(point: FaultPoint) {
    super(`injected kill at ${point}`);
    this.name = 'InjectedKill';
  }
}

export interface RunOptions {
  executor?: Executor;
  critic?: CriticSpawn;
  // Worktree root; defaults to a `worktrees/` sibling of `.relay/`. Worktrees are
  // executor sandboxes, never part of the `.relay/` record.
  workRoot?: string;
  // Test-only fault injection, scoped to one leaf so it fires deterministically.
  faultAt?: { leafId: string; point: FaultPoint };
}

export interface OrchestratorResult {
  rootStatus: NodeStatus;
  leafStatuses: Record<string, NodeStatus>;
  // Intent ids rolled forward at the start of this run (empty on a clean start).
  rolledForward: string[];
}

interface LeafContext {
  region: string;
  runId: string;
  executor: Executor;
  critic: CriticSpawn;
  workRoot: string;
  faultAt: RunOptions['faultAt'];
}

function evidenceRef(
  runId: string,
  rel: string,
  kind: EvidenceRef['kind'],
  summary: string,
): EvidenceRef {
  return { runId, path: rel, kind, summary };
}

function renderVerdict(node: NodeRecord): string {
  const v = node.verdict;
  if (v === null) {
    return '# verdict\n\n(none)\n';
  }
  return `# critic verdict\n\n- Provider: ${v.provider}\n- Result: ${v.pass ? 'PASS' : 'FAIL'}\n- Rationale: ${v.rationale}\n`;
}

async function discardWorktree(workRoot: string, leafId: string): Promise<void> {
  await rm(join(workRoot, leafId), { recursive: true, force: true });
}

// Drive one leaf from a clean (re-)dispatch to `done`. Every `.relay/` write is
// an atomic journal transaction; the leaf-done transition is split into
// write-ahead + apply so a kill can be injected between (the roll-forward case).
async function dispatchLeaf(
  relayDir: string,
  leaf: NodeRecord,
  ctx: LeafContext,
): Promise<NodeRecord> {
  const { region, runId, executor, critic, workRoot, faultAt } = ctx;
  const leafId = leaf.id;
  const fault = (point: FaultPoint): void => {
    if (faultAt && faultAt.leafId === leafId && faultAt.point === point) {
      throw new InjectedKill(point);
    }
  };
  const commitNode = (record: NodeRecord): Promise<string> =>
    commit(relayDir, region, [{ path: relativeNodePath(leafId), content: serializeNode(record) }]);

  fault('before-dispatch');

  // T1: fresh active state. Discarding any partial prior attempt is what makes
  // re-dispatch idempotent — a rehydrated run reproduces an identical record.
  let node: NodeRecord = {
    ...leaf,
    status: 'active',
    selfReport: null,
    verdict: null,
    evidenceRefs: [],
  };
  await commitNode(node);

  // Dispatch the executor in its own worktree.
  const worktree = join(workRoot, leafId);
  await mkdir(worktree, { recursive: true });
  const result = await executor.run({ spec: node.spec, worktree });
  fault('after-executor');

  // T2: persist the self-report (orchestrator-visible) + evidence refs. The diff
  // and self-report are written to the run-scoped evidence store; the node holds
  // only refs (evidence-ref discipline, §4).
  const evDir = relayPaths(relayDir).evidenceDir(runId);
  const diffRel = `${leafId}/diff.patch`;
  const selfRel = `${leafId}/self-report.md`;
  await atomicWriteFile(join(evDir, diffRel), result.diff);
  await atomicWriteFile(join(evDir, selfRel), result.selfReport);
  const diffRef = evidenceRef(runId, diffRel, 'diff', 'executor produced change');
  const selfRef = evidenceRef(
    runId,
    selfRel,
    'self-report',
    'executor self-report (orchestrator-only)',
  );
  node = { ...node, selfReport: result.selfReport, evidenceRefs: [diffRef, selfRef] };
  await commitNode(node);
  fault('after-self-report');

  // The C7 chokepoint: the critic sees ONLY the constructed projection (spec +
  // diff + evidence), never the node's self-report.
  const view = toCriticView(node, result.diff);
  const verdict = await runCritic(critic, view);
  if (!verdict.pass) {
    // M1 seeds an always-pass command check; the escalation ladder is M3.
    throw new Error(`M1 stub critic did not pass (${verdict.rationale}); the ladder lands in M3`);
  }

  // T3: leaf -> done, written as a separate intent so a kill after the commit
  // point but before apply is recoverable by roll-forward at rehydration.
  await atomicWriteFile(join(evDir, `${leafId}/verdict.md`), renderVerdict({ ...node, verdict }));
  const verdictRef = evidenceRef(runId, `${leafId}/verdict.md`, 'verdict', 'critic verdict');
  const doneNode: NodeRecord = {
    ...node,
    status: 'done',
    verdict: { ...verdict, evidenceRefs: [verdictRef] },
    evidenceRefs: [diffRef, selfRef, verdictRef],
  };
  const intentId = await writeIntent(relayDir, region, [
    { path: relativeNodePath(leafId), content: serializeNode(doneNode) },
  ]);
  fault('leaf-done-intent');
  await applyIntent(relayDir, region, intentId);
  fault('after-leaf-done');

  return doneNode;
}

export async function runOrchestrator(
  relayDir: string,
  rootId: string,
  opts: RunOptions = {},
): Promise<OrchestratorResult> {
  const executor = opts.executor ?? stubExecutor;
  const critic = opts.critic ?? stubCritic;
  // The journal region is the bound node-id: one OS process owns one region (C6).
  const region = rootId;
  const workRoot = opts.workRoot ?? join(dirname(relayDir), 'worktrees');

  // Rehydration step 1: before anything else, roll forward an intent left by a
  // transaction interrupted after its commit point (§3.2, C8).
  const rolledForward = await rollForwardPending(relayDir, region);

  const manifest = await readManifest(relayDir);
  let root = await readNode(relayDir, rootId);
  if (root.kind !== 'branch') {
    throw new Error('M1 root must be a branch (a seeded branch with one leaf)');
  }

  const leafStatuses: Record<string, NodeStatus> = {};
  for (const childId of root.children) {
    const child = await readNode(relayDir, childId);
    if (child.kind !== 'leaf') {
      throw new Error('M1 supports only leaf children; sub-orchestrators are M2');
    }
    if (child.status === 'done') {
      leafStatuses[childId] = 'done';
      continue;
    }
    // Rehydration: a non-`done` child is discarded and re-dispatched (§3.2).
    await discardWorktree(workRoot, childId);
    const done = await dispatchLeaf(relayDir, child, {
      region,
      runId: manifest.runId,
      executor,
      critic,
      workRoot,
      faultAt: opts.faultAt,
    });
    leafStatuses[childId] = done.status;
  }

  // Integration gate is required only when children ran concurrently (§3.8); M1
  // is serial with one child, so the branch is `done` once its children are.
  if (root.status !== 'done' && root.children.every((id) => leafStatuses[id] === 'done')) {
    root = { ...root, status: 'done' };
    await commit(relayDir, region, [
      { path: relativeNodePath(rootId), content: serializeNode(root) },
    ]);
  }

  return { rootStatus: root.status, leafStatuses, rolledForward };
}
