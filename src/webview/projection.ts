// The read-time projection of `.relay/` for the read-only operator web view. A
// "global view" — the whole tree, every node's status, the run log — is NOT a
// stored artifact: there is no shared write target for it. It is COMPOSED at read
// time from the per-node files each orchestrator region wrote independently. This
// module is that composition, and it is strictly read-only: it opens `.relay/` for
// reading and writes nothing. The HTTP surface and the cost rollups build on top of
// what this returns.
//
// Reads go through the existing `.relay/` readers (readManifest/readNode) so the
// codec stays single-sourced; this module only enumerates and stitches.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  composeRunCost,
  readManifest,
  readNode,
  readRunUsage,
  relayPaths,
  tryReadLayer,
} from '../relay-state/index';
import type {
  BlockedRecord,
  CriticVerdict,
  EvidenceRef,
  LayerManifest,
  NodeCost,
  NodeKind,
  NodeRecord,
  NodeStatus,
  RunCost,
} from '../relay-state/index';

// A node's supervision summary — the operator-facing fields lifted off a
// `NodeRecord` for rendering. Deliberately excludes the orchestrator-visible
// narrative (`selfReport`/`learnings`): the supervision view surfaces structural
// facts (status, provider, verdict, evidence refs), not the self-report. `provider`
// is the critic's provider off the verdict (the model that graded the node), or
// `null` before a verdict exists. `depth` is the node's distance from the root, so
// a renderer can indent without re-deriving the hierarchy. `cost` is this node's
// budget burn — its attributed per-call spend, composed at read time from the usage
// records — or `null` when no model call was attributed to the node (a purely
// structural branch that only decomposed).
export interface NodeView {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus;
  outcome: string;
  provider: string | null;
  verdict: CriticVerdict | null;
  evidenceRefs: EvidenceRef[];
  blocked: BlockedRecord | null;
  depth: number;
  cost: NodeCost | null;
}

// The composed tree node: a `NodeView` plus its children, recursively. The child
// order is the authoritative order from the parent's `children` array (the layer it
// decomposed), not directory order.
export interface TreeNode extends NodeView {
  children: TreeNode[];
}

// The whole-run projection the view renders. `tree` is the hierarchy rooted at the
// manifest's root; `runLog` is the same nodes flattened in pre-order (root first,
// then each child subtree in declared order) — the global run log composed at read
// time. `orphans` are node files present on disk but unreachable from the root; they
// are surfaced rather than silently dropped (Rule 11) so a corrupt or mid-write tree
// is visible to the operator instead of hidden. `cost` is the whole-run cost rollup
// (per-node spend and the run total), composed from the same per-call usage records
// the per-node `cost` fields draw from.
export interface RunProjection {
  runId: string;
  rootId: string;
  rootOutcome: string;
  createdAt: string;
  tree: TreeNode;
  runLog: NodeView[];
  orphans: NodeView[];
  cost: RunCost;
}

function toNodeView(
  node: NodeRecord,
  depth: number,
  costByNode: ReadonlyMap<string, NodeCost>,
): NodeView {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    status: node.status,
    outcome: node.spec.outcome,
    provider: node.verdict?.provider ?? null,
    verdict: node.verdict,
    evidenceRefs: node.evidenceRefs,
    blocked: node.blocked,
    depth,
    cost: costByNode.get(node.id) ?? null,
  };
}

// Compose the whole-run view from the per-node files. Read-only: it reads the
// manifest and every node file and writes nothing. Fails loud (Rule 11) on an
// incoherent tree — a missing root, a child referenced with no file, or a cycle —
// rather than rendering a silently-truncated tree.
export async function projectRun(relayDir: string): Promise<RunProjection> {
  const manifest = await readManifest(relayDir);
  const paths = relayPaths(relayDir);

  const ids = (await readdir(paths.nodesDir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length));

  const byId = new Map<string, NodeRecord>();
  for (const id of ids) {
    byId.set(id, await readNode(relayDir, id));
  }

  if (!byId.has(manifest.rootId)) {
    throw new Error(
      `.relay/ projection: root node \`${manifest.rootId}\` has no file under nodes/`,
    );
  }

  // The cost rollup, composed at read time from the per-call usage records — the
  // same projection the persisted Markdown rollup renders (composeRunCost), so the
  // view's per-node burn and run total always match the `.relay/` rollup. Each
  // node's `cost` is looked up from here; a node with no calls gets `null`.
  const cost = composeRunCost(await readRunUsage(relayDir, manifest.runId));
  const costByNode = new Map<string, NodeCost>(cost.perNode.map((n) => [n.nodeId, n]));

  const runLog: NodeView[] = [];
  const reached = new Set<string>();

  // Pre-order DFS from the root, following each node's authoritative `children`
  // order. `ancestors` guards against a cycle (a corrupt tree that would otherwise
  // recurse forever); `reached` records every composed id so orphans are whatever
  // is left over.
  function build(id: string, depth: number, ancestors: ReadonlySet<string>): TreeNode {
    const node = byId.get(id);
    if (node === undefined) {
      throw new Error(
        `.relay/ projection: node \`${id}\` is referenced as a child but has no file`,
      );
    }
    if (ancestors.has(id)) {
      throw new Error(`.relay/ projection: cycle detected at node \`${id}\``);
    }
    reached.add(id);
    const view = toNodeView(node, depth, costByNode);
    runLog.push(view);
    const childAncestors = new Set(ancestors).add(id);
    const children = node.children.map((childId) => build(childId, depth + 1, childAncestors));
    return { ...view, children };
  }

  const tree = build(manifest.rootId, 0, new Set());

  const orphans: NodeView[] = [];
  for (const id of [...byId.keys()].sort()) {
    if (reached.has(id)) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    orphans.push(toNodeView(node, 0, costByNode));
  }

  return {
    runId: manifest.runId,
    rootId: manifest.rootId,
    rootOutcome: manifest.spec.outcome,
    createdAt: manifest.createdAt,
    tree,
    runLog,
    orphans,
    cost,
  };
}

// One evidence ref paired with its on-disk content for the human-supervisor detail
// view. `content` is the FULL artifact text (self-report, diff, verdict, or
// decompose rationale); the read-time view bounds it at render, the disk keeps it
// whole for audit. `missing` marks "ref present but file absent" — a normal
// state (a blocked node has a diff/self-report but no verdict; an errored executor
// may leave a ref's file unwritten), surfaced rather than thrown so the route never
// 500s on a half-complete node (Rule 11).
export interface EvidenceContent {
  ref: EvidenceRef;
  content: string | null;
  missing: boolean;
}

// The human-supervisor detail of ONE node. Deliberately SEPARATE from the critic
// path: it lifts the orchestrator-visible narrative (`selfReport`/`learnings`) off
// the `NodeRecord` and reads evidence-file content directly. It NEVER constructs or
// consumes the critic projection — the audience split is structural, not prompting.
// The critic still sees evidence only,
// through the branded chokepoint in relay-state; this is a different reader over the
// same durable record for a different audience (the human). `layer` carries the
// decompose JUDGMENT — footprints + seams — for a branch that decomposed (null for a
// leaf or an undecomposed branch); the decompose rationale rides `evidence` as a
// `kind: 'rationale'` entry.
export interface SupervisorView {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus;
  outcome: string;
  // Orchestrator-visible narrative — surfaced to the HUMAN supervisor, never the
  // critic. This is exactly the field the critic projection withholds.
  selfReport: string | null;
  learnings: string[];
  verdict: CriticVerdict | null;
  blocked: BlockedRecord | null;
  evidence: EvidenceContent[];
  layer: LayerManifest | null;
}

// Read one evidence ref's file content, resolving it under the run's evidence dir
// (the ref `path` is relative to `evidenceDir(runId)`). A missing file yields a
// typed `missing` marker — never an exception — so a half-complete node degrades
// gracefully; any OTHER read error still fails loud (Rule 11).
async function readEvidenceContent(
  evidenceDir: string,
  ref: EvidenceRef,
): Promise<EvidenceContent> {
  try {
    return { ref, content: await readFile(join(evidenceDir, ref.path), 'utf8'), missing: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ref, content: null, missing: true };
    }
    throw err;
  }
}

// Compose the human-supervisor detail for one node. Read-only: it reads the node
// record, its evidence files, and (for a branch) its layer manifest, and writes
// nothing. It is structurally on the human side of the evidence-only-critic split —
// it neither builds nor spawns the critic projection. A missing evidence file is a
// `missing` marker, not a throw; a missing NODE file still fails loud (the route
// maps that to a not-found).
export async function projectSupervisorNode(
  relayDir: string,
  nodeId: string,
): Promise<SupervisorView> {
  const manifest = await readManifest(relayDir);
  const node = await readNode(relayDir, nodeId);
  const evidenceDir = relayPaths(relayDir).evidenceDir(manifest.runId);
  const evidence = await Promise.all(
    node.evidenceRefs.map((ref) => readEvidenceContent(evidenceDir, ref)),
  );
  // The decompose JUDGMENT lives in the layer manifest the branch committed; a leaf
  // or an undecomposed branch has none (tryReadLayer returns null gracefully).
  const layer = node.kind === 'branch' ? await tryReadLayer(relayDir, nodeId) : null;
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    status: node.status,
    outcome: node.spec.outcome,
    selfReport: node.selfReport,
    learnings: node.learnings,
    verdict: node.verdict,
    blocked: node.blocked,
    evidence,
    layer,
  };
}
