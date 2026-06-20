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
  readInbox,
  readManifest,
  readNode,
  relativeContractPath,
  relativeLayerPath,
  relativeNodePath,
  relayPaths,
  rollForwardPending,
  runCritic,
  serializeContract,
  serializeLayer,
  serializeNode,
  toCriticView,
  tryReadContract,
  writeIntent,
} from '../relay-state/index';
import type {
  BlockedRecord,
  CriticSpawn,
  CriticVerdict,
  DecisionRecord,
  EvidenceRef,
  Footprint,
  IntentWrite,
  LayerManifest,
  McpServerConfig,
  NodeRecord,
  NodeStatus,
  OutcomeContract,
  SeamContract,
} from '../relay-state/index';
import { stubExecutor } from './executor';
import type { Executor } from './executor';
import { stubCritic } from './critic';
import { EscalationLadder } from './ladder';
import type { AttemptSignal, ExhaustionReason, Rung } from './ladder';
import type { RailCaps, RailUsage } from './rails';
import { stubBrain } from './brain';
import type { Brain, ChildPlan, Decomposition } from './brain';
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
  | 'after-leaf-done'
  // `before-promote` lands before the promotion transaction's commit point (the
  // pre-promotion leaf is still on disk); `promote-intent` lands after that
  // commit point but before its apply, so rehydration must roll it forward to the
  // post-promotion branch (C8). Together they pin promotion's atomicity.
  | 'before-promote'
  | 'promote-intent';

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
  // The alternate-provider executor the `swap-provider` rung re-dispatches under
  // (design §3.7): when a leaf fails on the primary, the ladder swaps Claude↔Codex
  // rather than re-running the same provider. Omitted (the M1–M3 stub path) keeps
  // the swap rung re-dispatching the primary, so stub ladder tests are unaffected.
  swapExecutor?: Executor;
  critic?: CriticSpawn;
  // Worktree root; defaults to a `worktrees/` sibling of `.relay/`. Worktrees are
  // executor sandboxes, never part of the `.relay/` record.
  workRoot?: string;
  // Test-only fault injection, scoped to one leaf so it fires deterministically.
  faultAt?: { leafId: string; point: FaultPoint };
  // Budget caps bounding each leaf's escalation ladder (design §3.7). Defaults to
  // generous stub caps where the attempt rail is the meaningful one; tight caps
  // and real token/wall-clock accounting arrive with real providers (M4).
  caps?: RailCaps;
  // The orchestrator brain (design §3.3, §3.4): the model judgment for decomposing
  // a layer (children + footprints + seams) and classifying each child leaf-vs-
  // branch. Drives both branch-activation decomposition (§3.10) and a promoted
  // leaf's re-decomposition (§3.9). Defaults to the deterministic stub brain so the
  // M1–M3 spine tests stay hermetic; a real run wires `agentBrain`.
  brain?: Brain;
  // The MCP servers the spine (as host) grants to every agent it spawns — the
  // executor, the critic, and the brain's judgment call (§3.252, §9.4, C9). Defaults
  // to none; the agents connect to whatever is granted as MCP clients and the code
  // remains the sole writer of `.relay/`.
  mcpServers?: readonly McpServerConfig[];
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
  // Leaves promoted to branches this run (design §3.9). A promoted node is now a
  // pending sub-branch its new children get driven on a later activation, so it is
  // reported here and counted not-done.
  promotedNodes: string[];
  // Nodes cancelled by a drained human decision this run (design §3.9, §3.11). A
  // cancelled node is terminal and not-done, so it halts and surfaces like a
  // blocked one; reported here for observability.
  cancelledNodes: string[];
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
  // The alternate provider the `swap-provider` rung dispatches under; falls back
  // to `executor` when no second provider is configured (the stub path).
  swapExecutor: Executor;
  critic: CriticSpawn;
  workRoot: string;
  faultAt: RunOptions['faultAt'];
  // Budget caps for this leaf's escalation ladder (design §3.7).
  caps: RailCaps;
  // The brain that re-decomposes a promoted leaf into child outcomes (design §3.9).
  brain: Brain;
  // The MCP servers granted to this leaf's executor and critic (§3.252, C9).
  mcpServers: readonly McpServerConfig[];
  // Accumulates this process's `.relay/`-relative write footprint (A6).
  writes: Set<string>;
}

// The result of driving one leaf: it reached `done`; its escalation ladder hit
// the `promote` rung and it became a branch with new children (design §3.9); or
// the ladder exhausted and it is terminally `blocked` with a self-sufficient
// record the parent chain surfaces (design §3.7).
type LeafOutcome =
  | { kind: 'done'; node: NodeRecord }
  | { kind: 'promoted'; node: NodeRecord; children: NodeRecord[] }
  | { kind: 'blocked'; node: NodeRecord };

// Generous stub caps: on M3 stubs the executor produces no real tokens or
// wall-clock, so the attempt rail is the only meaningful one, and it is set high
// enough that persistent failure walks the full ladder to `promote` rather than
// tripping a cap. The blocked-record exhaustion path that tight caps exercise is
// Phase 3; real token/time accounting is M4.
const DEFAULT_CAPS: RailCaps = {
  maxAttempts: 100,
  maxTokens: Number.MAX_SAFE_INTEGER,
  maxWallClockMs: Number.MAX_SAFE_INTEGER,
};

// The compact lesson carried forward when a leaf is promoted: why it could not be
// done as one outcome. Persisted into the new children's context before the
// worktree is reset (design §3.5), so the re-decomposition does not relearn it.
function promotionReflection(
  leafId: string,
  signal: AttemptSignal,
  verdict: CriticVerdict | null,
): string {
  if (signal === 'too-big') {
    return `leaf \`${leafId}\` was judged too big to complete as one outcome; promoted and re-decomposed.`;
  }
  const why = verdict ? verdict.rationale : 'no passing critic verdict';
  return `leaf \`${leafId}\` exhausted retry/swap-provider/raise-tier without a passing verdict; promoted. Last critic rationale: ${why}`;
}

// The standing "why" a leaf is terminally blocked (design §3.7), rendered from
// the ladder's exhaustion reason. `cap` is the path the orchestrator actually
// reaches — it takes the `promote` rung before the ladder can walk every rung, so
// `rungs-walked` is unreachable through this loop — but both are rendered so the
// blocked record is self-sufficient regardless of how the ladder ended.
function exhaustionReason(reason: ExhaustionReason): string {
  if (reason.kind === 'cap') {
    return `budget cap \`${reason.cap}\` reached before a passing verdict`;
  }
  return 'every escalation rung was walked without a passing verdict';
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

// Materialize a brain decomposition into the durable layer the orchestrator commits
// (design §3.3, §3.8). The orchestrator owns id assignment — the brain works in
// child indices — so this assigns each child `${parentId}.c${i}`, builds the child
// node records (each carrying the inherited learnings), and builds the layer
// manifest: each child's footprint by node-id, and the seam graph with producer/
// consumer remapped from indices to the assigned node-ids. Pure; the caller commits
// the result atomically.
function buildLayer(
  parentId: string,
  runId: string,
  decomposition: Decomposition,
  childLearnings: readonly string[],
): { children: NodeRecord[]; manifest: LayerManifest } {
  const children: NodeRecord[] = decomposition.children.map((plan: ChildPlan, i) => ({
    id: `${parentId}.c${i.toString()}`,
    parentId,
    kind: plan.kind,
    status: 'pending',
    spec: plan.spec,
    children: [],
    selfReport: null,
    learnings: [...childLearnings],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  }));
  const footprints: Record<string, Footprint> = {};
  for (const [i, plan] of decomposition.children.entries()) {
    footprints[children[i].id] = plan.footprint;
  }
  const seams: SeamContract[] = decomposition.seams.map((s) => ({
    id: s.id,
    kind: s.kind,
    producer: children[s.producer].id,
    consumer: children[s.consumer].id,
    payload: s.payload,
    intent: s.intent,
  }));
  return { children, manifest: { parentId, runId, footprints, seams } };
}

// A node that is terminal but NOT done — blocked (ladder exhaustion, §3.7) or
// cancelled (human decision, §3.9). Either makes an ancestor unable to integrate a
// complete layer, so the halt-and-surface gate treats them the same: the parent
// can never be `done`.
function isTerminalNotDone(status: NodeStatus | undefined): boolean {
  return status === 'blocked' || status === 'cancelled';
}

// The keep-lesson reflection persisted to a node when a human cancels it (§3.5's
// persist-then-discard pattern, extended to cancelled work, §3.9). Authored so the
// reason the work stopped survives the worktree reset.
function cancellationReflection(nodeId: string, d: DecisionRecord): string {
  const base = `node \`${nodeId}\` was cancelled by human decision \`${d.decisionId}\``;
  const why = d.note === null ? base : `${base}: ${d.note}`;
  return `${why}. Worktree discarded; learnings persisted.`;
}

// The self-sufficient record a parent takes when it halts-and-surfaces above a
// terminal-not-done child (§3.7). A blocked child contributes its standing critic
// reason; a cancelled child contributes its cancellation reflection. Either way the
// parent names the descendant so a reader up the chain sees what is wrong without
// descending.
function surfacedRecord(rootId: string, childId: string, child: NodeRecord): BlockedRecord {
  if (child.blocked !== null) {
    return {
      reason: `descendant \`${childId}\` is blocked`,
      rungsSpent: [],
      criticReason: child.blocked.criticReason,
      humanFacing: child.blocked.humanFacing,
    };
  }
  // Cancelled child: no blocked record, but the cancellation reflection (the last
  // learning) carries the standing reason.
  const reflection = child.learnings[child.learnings.length - 1];
  return {
    reason: `descendant \`${childId}\` was cancelled`,
    rungsSpent: [],
    criticReason: reflection ?? `descendant \`${childId}\` was cancelled by human decision`,
    humanFacing: `branch \`${rootId}\` halted: descendant \`${childId}\` was cancelled.`,
  };
}

// Drain the decision inbox at activation (design §3.10, §3.11). The inbox is a
// human-owned region this process only READS; for each pending decision targeting
// a node THIS process owns (its branch or an in-process leaf child), apply it as
// an atomic transition within this region. In M3 the lone decision kind is
// `cancel`: persist the keep-lesson reflection and flip the node to the terminal
// `cancelled` status in ONE atomic commit, then discard its worktree
// (persist-then-discard, §3.5). Idempotent across rehydration without ever writing
// the inbox back: a node already terminal is skipped, so its own terminal status —
// not a removed inbox file — is the applied-marker. A decision for a sub-
// orchestrator's node is left for that child's own process to drain.
async function drainDecisionInbox(
  relayDir: string,
  region: string,
  root: NodeRecord,
  workRoot: string,
  writes: Set<string>,
): Promise<{ root: NodeRecord; cancelled: string[] }> {
  const decisions = await readInbox(relayDir);
  const cancelled: string[] = [];
  let current = root;
  for (const d of decisions) {
    const targetId = d.targetNodeId;
    // Ownership: this process may write only its own branch node and its in-process
    // leaf children. A decision targeting a branch child (its own region/process)
    // or an unrelated node is not ours to apply.
    let owned = targetId === root.id;
    if (!owned && root.children.includes(targetId)) {
      owned = (await readNode(relayDir, targetId)).kind === 'leaf';
    }
    if (!owned) {
      continue;
    }
    const node = await readNode(relayDir, targetId);
    // Idempotent: a terminal node is never re-cancelled (re-drain after a teardown
    // lands here and stops). A still-running node is taken terminal.
    if (node.status === 'done' || isTerminalNotDone(node.status)) {
      continue;
    }
    const cancelledNode: NodeRecord = {
      ...node,
      status: 'cancelled',
      learnings: [...node.learnings, cancellationReflection(targetId, d)],
    };
    writes.add(relativeNodePath(targetId));
    await commit(relayDir, region, [
      { path: relativeNodePath(targetId), content: serializeNode(cancelledNode) },
    ]);
    // Learnings are now durable; only then reset the worktree (§3.5/§3.9).
    await discardWorktree(workRoot, targetId);
    cancelled.push(targetId);
    if (targetId === root.id) {
      current = cancelledNode;
    }
  }
  return { root: current, cancelled };
}

// One dispatch attempt's result: the persisted active node, the ladder signal it
// produced, and (when the critic graded it) its verdict.
interface AttemptResult {
  node: NodeRecord;
  signal: AttemptSignal;
  verdict: CriticVerdict | null;
}

// Drive one leaf: (re-)dispatch under the escalation ladder until it reaches
// `done`, is promoted (leaf→branch), or the ladder exhausts. Every `.relay/`
// write is an atomic journal transaction; the structural transitions (leaf-done,
// promotion) are split into write-ahead + apply so a kill can be injected between
// (the roll-forward case). The ladder is the C2 boundary: this code owns dispatch
// and persistence, the pure controller only decides the next rung (design §3.9).
async function dispatchLeaf(
  relayDir: string,
  leaf: NodeRecord,
  ctx: LeafContext,
): Promise<LeafOutcome> {
  const {
    region,
    runId,
    executor,
    swapExecutor,
    critic,
    workRoot,
    faultAt,
    caps,
    brain,
    mcpServers,
    writes,
  } = ctx;
  const leafId = leaf.id;
  const evDir = relayPaths(relayDir).evidenceDir(runId);
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

  // One dispatch attempt: a clean active state, the executor in a fresh worktree,
  // then either the executor's too-big sizing signal or the critic's graded
  // verdict. Re-runnable: each call discards the prior attempt's worktree first,
  // so a rehydrated run reproduces an identical record.
  const attempt = async (exec: Executor): Promise<AttemptResult> => {
    fault('before-dispatch');

    // T1: fresh active state, atop a discarded prior attempt (idempotent
    // (re-)dispatch — the same write whether this is the first rung or the fifth).
    await discardWorktree(workRoot, leafId);
    let node: NodeRecord = {
      ...leaf,
      status: 'active',
      selfReport: null,
      verdict: null,
      evidenceRefs: [],
    };
    await commitNode(node);

    const worktree = join(workRoot, leafId);
    await mkdir(worktree, { recursive: true });
    // Carry the node's accumulated learnings as context so a retried or
    // re-decomposed unit does not relearn them (design §3.5). The granted MCP
    // servers are routed to the executor by the spine (MCP host); the executor
    // connects as a client and may drive them, but only the orchestrator writes
    // `.relay/` (C2, §9.4).
    const result = await exec.run({
      spec: node.spec,
      context: { learnings: node.learnings },
      worktree,
      mcpServers,
    });
    fault('after-executor');

    // T2: persist the self-report (orchestrator-visible) + evidence refs. The diff
    // and self-report are written to the run-scoped evidence store; the node holds
    // only refs (evidence-ref discipline, §4).
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

    // The executor's sizing judgment preempts the critic: a too-big outcome is not
    // graded, it is promoted (design §3.9 "judged too big → PROMOTE").
    if (result.sizeSignal === 'too-big') {
      return { node, signal: 'too-big', verdict: null };
    }

    // The C7 chokepoint: the critic sees ONLY the constructed projection (spec +
    // diff + evidence), never the node's self-report. Alongside the projection it is
    // granted the non-evidentiary context an independent critic needs to act — the
    // produced-change worktree it runs its declared verification kinds against, and
    // the same mcp_servers the executor gets (§3.252, C9), routed by the spine (MCP
    // host) exactly like the executor above.
    const view = toCriticView(node, result.diff);
    const verdict = await runCritic(critic, view, { worktree, mcpServers });
    return { node, signal: verdict.pass ? 'pass' : 'fail', verdict };
  };

  // T3: leaf -> done, written as a separate intent so a kill after the commit
  // point but before apply is recoverable by roll-forward at rehydration.
  const finishDone = async (node: NodeRecord, verdict: CriticVerdict): Promise<NodeRecord> => {
    const verdictRel = `${leafId}/verdict.md`;
    await atomicWriteFile(join(evDir, verdictRel), renderVerdict({ ...node, verdict }));
    writes.add(evRel(verdictRel));
    const verdictRef = evidenceRef(runId, verdictRel, 'verdict', 'critic verdict');
    const doneNode: NodeRecord = {
      ...node,
      status: 'done',
      verdict: { ...verdict, evidenceRefs: [verdictRef] },
      evidenceRefs: [...node.evidenceRefs, verdictRef],
    };
    writes.add(relativeNodePath(leafId));
    const intentId = await writeIntent(relayDir, region, [
      { path: relativeNodePath(leafId), content: serializeNode(doneNode) },
    ]);
    fault('leaf-done-intent');
    await applyIntent(relayDir, region, intentId);
    fault('after-leaf-done');
    return doneNode;
  };

  // The `promote` rung: turn this leaf into a branch and re-decompose it into new
  // child outcomes, carrying the failed attempt's lesson forward. The brain renders
  // the decomposition (children + footprints + seams, each child classified leaf-vs-
  // branch); the code commits it. The leaf→branch flip, every new child node, AND
  // the layer manifest (footprints + seam graph) land in ONE atomic intent-journal
  // transaction, so rehydration sees the pre-promotion leaf or the post-promotion
  // branch, never a torn middle (the promotion-atomicity guarantee, design §3.5).
  const promote = async (failed: AttemptResult): Promise<LeafOutcome> => {
    const reflection = promotionReflection(leafId, failed.signal, failed.verdict);
    // The brain judgment (an agent) is granted the failed worktree to inspect and
    // the same MCP servers as the executor; it returns data and writes nothing —
    // the code below is the sole writer of `.relay/` (C2, §9.4).
    const decomposition = await brain.decompose(
      { spec: leaf.spec, context: { learnings: leaf.learnings } },
      { worktree: join(workRoot, leafId), mcpServers },
    );
    const { children, manifest } = buildLayer(leafId, runId, decomposition, [reflection]);
    const branch: NodeRecord = {
      ...leaf,
      kind: 'branch',
      status: 'pending',
      children: children.map((c) => c.id),
      selfReport: null,
      learnings: [...leaf.learnings, reflection],
      verdict: null,
      evidenceRefs: [],
      blocked: null,
    };
    const txn: IntentWrite[] = [
      { path: relativeNodePath(branch.id), content: serializeNode(branch) },
      ...children.map((c) => ({ path: relativeNodePath(c.id), content: serializeNode(c) })),
      { path: relativeLayerPath(branch.id), content: serializeLayer(manifest) },
    ];
    writes.add(relativeNodePath(branch.id));
    for (const c of children) {
      writes.add(relativeNodePath(c.id));
    }
    writes.add(relativeLayerPath(branch.id));
    fault('before-promote');
    const intentId = await writeIntent(relayDir, region, txn);
    fault('promote-intent');
    await applyIntent(relayDir, region, intentId);
    // The reflection is now durable in the children; only then reset the failed
    // attempt's worktree to clean (persist-then-discard, design §3.5).
    await discardWorktree(workRoot, leafId);
    return { kind: 'promoted', node: branch, children };
  };

  // Ladder exhaustion → the terminal `blocked` record (design §3.7). Authored to
  // be self-sufficient: a fresh orchestrator reads it in one pass and does NOT
  // re-run the ladder, and a human can act on it from the decision inbox (Phase 4).
  // One atomic write — no split write-ahead/apply, because no structural fan-out
  // follows it (unlike leaf-done or promote). The failed attempt's worktree is
  // left in place as the standing evidence of what could not be completed.
  const finishBlocked = async (
    failed: AttemptResult,
    reason: ExhaustionReason,
    rungsSpent: readonly Rung[],
  ): Promise<NodeRecord> => {
    const why = exhaustionReason(reason);
    const criticReason = failed.verdict
      ? failed.verdict.rationale
      : 'no passing critic verdict (executor judged the outcome too big)';
    const record: BlockedRecord = {
      reason: why,
      rungsSpent: [...rungsSpent],
      criticReason,
      humanFacing: `leaf \`${leafId}\` is blocked: ${why}. Standing critic reason: ${criticReason}.`,
    };
    const blockedNode: NodeRecord = { ...failed.node, status: 'blocked', blocked: record };
    await commitNode(blockedNode);
    return blockedNode;
  };

  // The verdict-handling loop: each iteration is one dispatch attempt whose signal
  // the ladder turns into the next rung — exactly the controller boundary the
  // design draws between code-owned dispatch and the pure ladder. Termination is
  // the ladder's guarantee (a pass, the promote rung, or a budget cap), not this
  // loop's; the empty-test `for` is bounded by the attempt cap inside `step`.
  const ladder = new EscalationLadder(caps);
  const usage: RailUsage = { attempts: 0, tokens: 0, elapsedMs: 0 };
  // The provider the next attempt dispatches under. Starts on the primary; the
  // `swap-provider` rung flips it to the alternate so a leaf that fails on one
  // provider is re-tried under the other (design §3.7). On the stub path
  // `swapExecutor === executor`, so the swap is a no-op and the rung is a plain
  // re-dispatch — exactly the pre-M4 behavior.
  let activeExecutor = executor;
  for (;;) {
    usage.attempts += 1;
    const result = await attempt(activeExecutor);
    const step = ladder.step(result.signal, usage);
    if (step.kind === 'done') {
      if (!result.verdict) {
        throw new Error(`leaf \`${leafId}\` reached done without a critic verdict`);
      }
      return { kind: 'done', node: await finishDone(result.node, result.verdict) };
    }
    if (step.kind === 'exhausted') {
      // The ladder ran out (a budget cap; the rungs-walked branch is unreachable
      // here because the loop takes the `promote` rung before the ladder can walk
      // past it). Write the self-sufficient `blocked` record and halt — no
      // route-around (design §3.7); `runOrchestrator` surfaces it up the parent
      // chain to root.
      return { kind: 'blocked', node: await finishBlocked(result, step.reason, ladder.rungsSpent) };
    }
    if (step.rung === 'promote') {
      return await promote(result);
    }
    // retry / swap-provider / raise-tier: re-dispatch. `swap-provider` flips to the
    // alternate provider for the next attempt (a real Claude↔Codex swap at M4);
    // retry and raise-tier keep the current provider. The loop re-attempts and the
    // ladder advances on the next verdict. (raise-tier as a real model-tier bump is
    // a later milestone; today it is a same-provider re-dispatch.)
    if (step.rung === 'swap-provider') {
      activeExecutor = swapExecutor;
    }
  }
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

// Branch-activation decomposition (design §3.10, §3.3): when an orchestrator
// activates on a branch that has no decomposed layer yet, it calls the brain (an
// agent) for the one-layer decomposition, then COMMITS the children + footprints +
// seams as one atomic transaction (C8) before dispatching any of them — the model
// judges, code persists (Rule 5, C2). Returns the branch re-read with its children
// populated. A branch that already has children (hand-seeded, or promoted with
// eager children) is returned untouched: decomposition is lazy and happens once.
async function decomposeBranch(
  relayDir: string,
  region: string,
  root: NodeRecord,
  runId: string,
  brain: Brain,
  grant: { workRoot: string; mcpServers: readonly McpServerConfig[] },
  writes: Set<string>,
): Promise<NodeRecord> {
  if (root.children.length > 0) {
    return root;
  }
  const worktree = join(grant.workRoot, root.id);
  await mkdir(worktree, { recursive: true });
  const decomposition = await brain.decompose(
    { spec: root.spec, context: { learnings: root.learnings } },
    { worktree, mcpServers: grant.mcpServers },
  );
  const { children, manifest } = buildLayer(root.id, runId, decomposition, root.learnings);
  const decomposed: NodeRecord = { ...root, children: children.map((c) => c.id) };
  const txn: IntentWrite[] = [
    { path: relativeNodePath(decomposed.id), content: serializeNode(decomposed) },
    ...children.map((c) => ({ path: relativeNodePath(c.id), content: serializeNode(c) })),
    { path: relativeLayerPath(decomposed.id), content: serializeLayer(manifest) },
  ];
  writes.add(relativeNodePath(decomposed.id));
  for (const c of children) {
    writes.add(relativeNodePath(c.id));
  }
  writes.add(relativeLayerPath(decomposed.id));
  await commit(relayDir, region, txn);
  return decomposed;
}

export async function runOrchestrator(
  relayDir: string,
  rootId: string,
  opts: RunOptions = {},
): Promise<OrchestratorResult> {
  const executor = opts.executor ?? stubExecutor;
  // No second provider configured → swap re-dispatches the primary (stub path).
  const swapExecutor = opts.swapExecutor ?? executor;
  const critic = opts.critic ?? stubCritic;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const brain = opts.brain ?? stubBrain;
  const mcpServers = opts.mcpServers ?? [];
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
  const promotedNodes: string[] = [];

  // Rehydration step 2: drain the decision inbox before driving any work (§3.10).
  // A pending human decision is applied as an atomic transition in this region; in
  // M3 that is serial-form cancellation, which takes its target terminal.
  const drained = await drainDecisionInbox(relayDir, region, root, workRoot, writes);
  root = drained.root;
  const cancelledNodes = drained.cancelled;
  // Cancelling the branch itself halts the whole activation: dispatch nothing new,
  // surface the terminal node, and return. (Serial form — no seam graph to trace
  // and no independent work to drain; both are deferred to concurrency, M10.)
  if (root.status === 'cancelled') {
    return {
      rootStatus: 'cancelled',
      leafStatuses,
      childStatuses,
      childContracts,
      promotedNodes,
      cancelledNodes,
      rolledForward,
      region,
      ownedWrites: [...writes].sort(),
    };
  }
  // Branch-activation decomposition (§3.10): a branch with no layer yet is
  // decomposed once — children + footprints + seams committed atomically — before
  // any child is dispatched. A branch already carrying children is left untouched.
  root = await decomposeBranch(
    relayDir,
    region,
    root,
    manifest.runId,
    brain,
    { workRoot, mcpServers },
    writes,
  );

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
      if (isTerminalNotDone(child.status)) {
        // A terminal leaf is read in ONE pass and never (re-)dispatched: a blocked
        // leaf's record already says "do not re-run the ladder" (§3.7), and a
        // cancelled leaf was taken terminal by a drained human decision (§3.9).
        leafStatuses[childId] = child.status;
        continue;
      }
      // Rehydration: a non-`done` leaf is (re-)dispatched under the ladder, which
      // discards any partial prior attempt before each attempt (§3.2, §3.9).
      const outcome = await dispatchLeaf(relayDir, child, {
        region,
        runId: manifest.runId,
        executor,
        swapExecutor,
        critic,
        workRoot,
        faultAt: opts.faultAt,
        caps,
        brain,
        mcpServers,
        writes,
      });
      if (outcome.kind === 'done') {
        leafStatuses[childId] = 'done';
        if (outcome.node.verdict) {
          childVerdictRefs.push(...outcome.node.verdict.evidenceRefs);
        }
      } else if (outcome.kind === 'blocked') {
        // Ladder exhausted: the leaf is terminally blocked. Not done, so the
        // parent cannot be done — the propagation gate below surfaces it up.
        leafStatuses[childId] = 'blocked';
      } else {
        // Promoted leaf→branch: now a pending sub-branch whose new children a
        // later activation drives. Not done, so the parent cannot be done either.
        promotedNodes.push(childId);
        childStatuses[childId] = outcome.node.status;
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

  // Halt-and-surface (design §3.7, §3.9): a branch with ANY terminal-not-done
  // descendant — blocked (ladder exhaustion) or cancelled (human decision) — can
  // never be `done`. It takes a `blocked` status carrying a self-sufficient record
  // that names the descendant and inherits its standing reason, so the failure (or
  // cancellation) propagates up the parent chain to root with no route-around.
  // Checked before the done gate; the two are mutually exclusive (a terminal child
  // is never `done`). Idempotent on rehydration: a branch already terminal is left
  // untouched.
  const terminalChildId = root.children.find(
    (id) => isTerminalNotDone(leafStatuses[id]) || isTerminalNotDone(childStatuses[id]),
  );
  // root is already non-cancelled here: a cancelled root returned early above.
  if (root.status !== 'blocked' && terminalChildId !== undefined) {
    const childNode = await readNode(relayDir, terminalChildId);
    root = {
      ...root,
      status: 'blocked',
      blocked: surfacedRecord(rootId, terminalChildId, childNode),
    };
    writes.add(relativeNodePath(rootId));
    await commit(relayDir, region, [
      { path: relativeNodePath(rootId), content: serializeNode(root) },
    ]);
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
    promotedNodes,
    cancelledNodes,
    rolledForward,
    region,
    ownedWrites: [...writes].sort(),
  };
}
