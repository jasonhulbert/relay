// The code-owned orchestrator state machine (design §3, §3.10). It owns the
// loop, every `.relay/` transition (through the intent journal, C8), and all
// dispatch; the model is called only for judgment (stubbed through M3). One OS
// process per active orchestrator (C6) — so `runOrchestrator` is BOTH the loop and
// the rehydration loader: re-running it against a node-id rolls forward any
// interrupted transaction and re-drives any non-`done` child (the rehydration
// contract, §3.2).
//
// M2 scope: a branch may have a branch child — a sub-orchestrator. That child is
// driven in its OWN process (C6): the parent spawns a fresh `node` invocation
// bound to the child node-id, the child writes its own disjoint `.relay/` region
// and exits, and the parent reads the result from the ledger (A7) — never from the
// child's return value or stdout. Leaf children keep the M1 in-process path.
// Executor + critic stay stubbed; the failure ladder (§3.9) is M3.
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  applyIntent,
  atomicWriteFile,
  commit,
  readManifest,
  readNode,
  relativeContractPath,
  relativeNodePath,
  relayPaths,
  rollForwardPending,
  runCritic,
  serializeContract,
  serializeNode,
  toCriticView,
  tryReadContract,
  writeIntent,
} from '../relay-state/index';
import type {
  CriticSpawn,
  EvidenceRef,
  IntentWrite,
  NodeRecord,
  NodeStatus,
  OutcomeContract,
} from '../relay-state/index';
import { stubExecutor } from './executor';
import type { Executor } from './executor';
import { stubCritic } from './critic';
import { defaultSpawnChild } from './child-runner';
import type { SpawnChild } from './child-runner';

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

// Seams in THIS orchestrator's own subtree drive — where a test models a kill of
// the *parent* process (as opposed to `FaultPoint`, which models a kill inside a
// leaf dispatch). `branch-done-intent` lands after the done transaction's commit
// point but before its apply, so rehydration must roll it forward (C8).
export type SelfFaultPoint =
  | 'before-spawn-child'
  | 'after-child-contract'
  | 'branch-done-intent'
  | 'after-branch-done';

export class InjectedKill extends Error {
  constructor(point: FaultPoint | SelfFaultPoint) {
    super(`injected kill at ${point}`);
    this.name = 'InjectedKill';
  }
}

// Faults applied within an orchestrator process, encoded as JSON across the spawn
// boundary so a parent can inject them into a spawned child. Test-only.
export interface ChildInjection {
  // Make this sub-orchestrator reach `done` but NOT publish its contract — the
  // withhold case proving the parent gates on the committed contract, never on
  // the child's exit code or stdout.
  contractFault?: 'skip';
  // Kill the child's leaf dispatch at a seam (forwarded to the child's own run),
  // so the parent observes a failed child and rehydration re-dispatches it.
  faultAt?: { leafId: string; point: FaultPoint };
}

export interface RunOptions {
  executor?: Executor;
  critic?: CriticSpawn;
  // Worktree root; defaults to a `worktrees/` sibling of `.relay/`. Worktrees are
  // executor sandboxes, never part of the `.relay/` record.
  workRoot?: string;
  // Test-only fault injection, scoped to one leaf so it fires deterministically.
  faultAt?: { leafId: string; point: FaultPoint };
  // How a branch child is spawned (C6). Defaults to a real subprocess; a test may
  // inject a stand-in to isolate the parent's own behavior.
  spawnChild?: SpawnChild;
  // The bundled child-entry the default spawner runs. Falls back to the
  // RELAY_CHILD_ENTRY env var (which the spawner sets on each child, so deeper
  // levels inherit it). Required only when a branch child must actually spawn.
  childEntry?: string;
  // Faults this process applies to its OWN run (forwarded in from a parent spawn).
  injection?: ChildInjection;
  // Faults to forward to spawned branch children, by child node-id.
  childInjections?: Record<string, ChildInjection>;
  // Test-only: model a kill of THIS (parent) process at one of its own seams.
  selfFaultAt?: SelfFaultPoint;
}

export interface OrchestratorResult {
  rootStatus: NodeStatus;
  // Leaf children driven in-process (M1 path), by node-id.
  leafStatuses: Record<string, NodeStatus>;
  // Branch children driven by a spawned sub-orchestrator (M2 path), by node-id.
  childStatuses: Record<string, NodeStatus>;
  // Accepted verified outcome contracts from branch children (A7), by node-id.
  childContracts: Record<string, OutcomeContract>;
  // Intent ids rolled forward at the start of this run (empty on a clean start).
  rolledForward: string[];
  // The node-id this process is bound to — its journal region (C6).
  region: string;
  // The `.relay/`-relative paths this process wrote: its ownership footprint (A6).
  // Disjoint from any concurrent sibling or parent process's footprint.
  ownedWrites: string[];
}

interface LeafContext {
  region: string;
  runId: string;
  executor: Executor;
  critic: CriticSpawn;
  workRoot: string;
  faultAt: RunOptions['faultAt'];
  // Accumulates this process's `.relay/`-relative write footprint (A6).
  writes: Set<string>;
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
  const { region, runId, executor, critic, workRoot, faultAt, writes } = ctx;
  const leafId = leaf.id;
  const evRel = (rel: string): string => `evidence/${runId}/${rel}`;
  const fault = (point: FaultPoint): void => {
    if (faultAt && faultAt.leafId === leafId && faultAt.point === point) {
      throw new InjectedKill(point);
    }
  };
  const commitNode = (record: NodeRecord): Promise<string> => {
    writes.add(relativeNodePath(leafId));
    return commit(relayDir, region, [
      { path: relativeNodePath(leafId), content: serializeNode(record) },
    ]);
  };

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
  writes.add(evRel(diffRel));
  writes.add(evRel(selfRel));
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
  const verdictRel = `${leafId}/verdict.md`;
  await atomicWriteFile(join(evDir, verdictRel), renderVerdict({ ...node, verdict }));
  writes.add(evRel(verdictRel));
  const verdictRef = evidenceRef(runId, verdictRel, 'verdict', 'critic verdict');
  const doneNode: NodeRecord = {
    ...node,
    status: 'done',
    verdict: { ...verdict, evidenceRefs: [verdictRef] },
    evidenceRefs: [diffRef, selfRef, verdictRef],
  };
  writes.add(relativeNodePath(leafId));
  const intentId = await writeIntent(relayDir, region, [
    { path: relativeNodePath(leafId), content: serializeNode(doneNode) },
  ]);
  fault('leaf-done-intent');
  await applyIntent(relayDir, region, intentId);
  fault('after-leaf-done');

  return doneNode;
}

// Drive one branch child as a sub-orchestrator in its own process (C6) and accept
// it via its verified outcome contract (A7). The parent never re-verifies the
// child's internals; it reads the child's committed contract from the ledger —
// never the child's return value or stdout. A child already certified on the
// ledger (e.g. seen on rehydration) is trusted without re-spawning; otherwise a
// fresh process is spawned bound to the child node-id. Returns the certified
// contract, or `null` if the child did not publish one (then the parent cannot be
// `done`).
async function driveChild(
  relayDir: string,
  child: NodeRecord,
  opts: RunOptions,
): Promise<OutcomeContract | null> {
  const existing = await tryReadContract(relayDir, child.id);
  if (child.status === 'done' && existing && existing.criticCertified) {
    return existing;
  }

  if (opts.selfFaultAt === 'before-spawn-child') {
    throw new InjectedKill('before-spawn-child');
  }

  const spawnChild = opts.spawnChild ?? defaultSpawnChild;
  const childEntry = opts.childEntry ?? process.env.RELAY_CHILD_ENTRY ?? '';
  const injection = opts.childInjections?.[child.id];
  const input = injection
    ? { relayDir, nodeId: child.id, childEntry, injection }
    : { relayDir, nodeId: child.id, childEntry };
  const { code } = await spawnChild(input);
  if (code !== 0) {
    // M2 surfaces a failed child by propagating; the unified failure rule is M3.
    throw new Error(`sub-orchestrator ${child.id} exited ${code.toString()}`);
  }

  // Read the verified outcome contract from the ledger (A7) — never from stdout.
  const contract = await tryReadContract(relayDir, child.id);
  if (!contract || !contract.criticCertified) {
    return null;
  }
  return contract;
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
  const writes = new Set<string>();

  // Rehydration step 1: before anything else, roll forward an intent left by a
  // transaction interrupted after its commit point (§3.2, C8).
  const rolledForward = await rollForwardPending(relayDir, region);

  const manifest = await readManifest(relayDir);
  let root = await readNode(relayDir, rootId);
  if (root.kind !== 'branch') {
    throw new Error('an orchestrator must be bound to a branch node');
  }

  const leafStatuses: Record<string, NodeStatus> = {};
  const childStatuses: Record<string, NodeStatus> = {};
  const childContracts: Record<string, OutcomeContract> = {};
  // The critic verdicts certifying this node's children — the structural fact that
  // rides up in this node's own contract (§3.6, certified turtles-all-the-way-up).
  const childVerdictRefs: EvidenceRef[] = [];
  for (const childId of root.children) {
    const child = await readNode(relayDir, childId);
    if (child.kind === 'leaf') {
      if (child.status === 'done') {
        leafStatuses[childId] = 'done';
        if (child.verdict) {
          childVerdictRefs.push(...child.verdict.evidenceRefs);
        }
        continue;
      }
      // Rehydration: a non-`done` leaf is discarded and re-dispatched (§3.2).
      await discardWorktree(workRoot, childId);
      const done = await dispatchLeaf(relayDir, child, {
        region,
        runId: manifest.runId,
        executor,
        critic,
        workRoot,
        faultAt: opts.faultAt,
        writes,
      });
      leafStatuses[childId] = done.status;
      if (done.verdict) {
        childVerdictRefs.push(...done.verdict.evidenceRefs);
      }
    } else {
      // Branch child → a sub-orchestrator in its own process (C6), accepted via
      // its verified outcome contract read from the ledger (A7).
      const contract = await driveChild(relayDir, child, opts);
      if (contract) {
        childStatuses[childId] = 'done';
        childContracts[childId] = contract;
        childVerdictRefs.push(...contract.verdictRefs);
      } else {
        childStatuses[childId] = (await readNode(relayDir, childId)).status;
      }
    }
  }

  const childDone = (id: string): boolean =>
    leafStatuses[id] === 'done' || childContracts[id] !== undefined;

  // A kill here models the parent dying after it has read+accepted the child's
  // contract but before recording its own done transition (the key rehydrate case:
  // the subtree must reconstitute without re-running the already-done child).
  if (opts.selfFaultAt === 'after-child-contract') {
    throw new InjectedKill('after-child-contract');
  }

  // Integration gate is required only when children ran concurrently (§3.8); M2 is
  // serial with one child, so the branch is `done` once its children are.
  if (root.status !== 'done' && root.children.every(childDone)) {
    root = { ...root, status: 'done' };
    writes.add(relativeNodePath(rootId));
    const txn: IntentWrite[] = [{ path: relativeNodePath(rootId), content: serializeNode(root) }];
    // A sub-orchestrator (one that has a parent) publishes its verified outcome
    // contract in the SAME atomic transaction as its done transition (A7), so the
    // parent never observes a `done` child without its contract. The withhold
    // fault deliberately omits it to prove the parent gates on the contract.
    if (root.parentId !== null && opts.injection?.contractFault !== 'skip') {
      const contract: OutcomeContract = {
        nodeId: rootId,
        runId: manifest.runId,
        claimedOutcome: root.spec.outcome,
        criticCertified: childVerdictRefs.length > 0,
        verdictRefs: childVerdictRefs,
        seamEvidence: [],
      };
      writes.add(relativeContractPath(rootId));
      txn.push({ path: relativeContractPath(rootId), content: serializeContract(contract) });
    }
    // Split write-ahead + apply so a kill after the commit point is recovered by
    // roll-forward at rehydration (C8) — the same protocol as the leaf-done step.
    const intentId = await writeIntent(relayDir, region, txn);
    if (opts.selfFaultAt === 'branch-done-intent') {
      throw new InjectedKill('branch-done-intent');
    }
    await applyIntent(relayDir, region, intentId);
    if (opts.selfFaultAt === 'after-branch-done') {
      throw new InjectedKill('after-branch-done');
    }
  }

  return {
    rootStatus: root.status,
    leafStatuses,
    childStatuses,
    childContracts,
    rolledForward,
    region,
    ownedWrites: [...writes].sort(),
  };
}
