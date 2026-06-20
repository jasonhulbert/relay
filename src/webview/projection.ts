// The read-time projection of `.relay/` for the operator web view (M5, design §4,
// I3). A "global view" — the whole tree, every node's status, the run log — is NOT
// a stored artifact: there is no shared write target for it (A6, design §4). It is
// COMPOSED at read time from the per-node files each orchestrator region wrote
// independently. This module is that composition, and it is strictly read-only: it
// opens `.relay/` for reading and writes nothing (I3). The HTTP surface (Phase 2)
// and the cost rollups (Phase 3) build on top of what this returns.
//
// Reads go through the existing `.relay/` readers (readManifest/readNode) so the
// codec stays single-sourced; this module only enumerates and stitches.
import { readdir } from 'node:fs/promises';
import {
  composeRunCost,
  readManifest,
  readNode,
  readRunUsage,
  relayPaths,
} from '../relay-state/index';
import type {
  BlockedRecord,
  CriticVerdict,
  EvidenceRef,
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
// budget burn (F5) — its attributed per-call spend, composed at read time from the
// usage records — or `null` when no model call was attributed to the node (a purely
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
// time (design §4). `orphans` are node files present on disk but unreachable from
// the root; they are surfaced rather than silently dropped (Rule 11) so a corrupt
// or mid-write tree is visible to the operator instead of hidden. `cost` is the
// whole-run F5 rollup (per-node spend and the run total), composed from the same
// per-call usage records the per-node `cost` fields draw from.
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
// manifest and every node file and writes nothing (I3). Fails loud (Rule 11) on an
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

  // The F5 cost rollup, composed at read time from the per-call usage records — the
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
