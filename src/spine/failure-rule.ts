// The unified failure rule's structural core — the seam graph made operational
// (design §3.9, B3/B4, M10 Phase 4). A terminal failure anywhere makes the run
// doomed-pending-human (§3.7): doneness-failure reaches root, so root is the single
// decision-maker (B2), and ONE rule governs every failure — dispatch nothing new,
// cancel what the failure invalidated, drain what it didn't, halt at root.
//
// The cancel-vs-preserve line is THE SEAM GRAPH — a structural fact in `.relay/`,
// not a judgment (B4). This module owns that decision and nothing else: given the
// dead node(s) and the layer's seams, it partitions every other child of the layer
// into two buckets by seam-reachability:
//
//   - cancel  (seam-DEPENDENT):  reachable from a dead node through the seam graph.
//       Its work was building toward or from a seam the dead node will never
//       fulfil, so it is stale — cancelled and its worktree discarded (the dead
//       node's own seam-connected siblings fall out here). Learnings persist first
//       (the §3.5 pattern, extended to cancelled work) — that is the orchestrator's
//       job; this module only decides the bucket.
//   - drain   (seam-INDEPENDENT): not reachable. No seam to the dead node, so it
//       stays valid across the human's fix — in-flight work is let run to
//       completion and quarantined (§8 credit scarcity is why that progress is
//       worth banking).
//
// Reachability is over the UNDIRECTED seam graph: a seam is a producer↔consumer
// dependency, and a break on either end invalidates the other, so direction does
// not gate staleness. The traversal is pure and deterministic (output order follows
// the caller's child order), so the impure half — the atomic cancel/quarantine
// transitions — stays in the orchestrator (C2).
import type { SeamContract } from '../relay-state/index';

// The seam-graph partition of a layer's non-dead children: `cancel` are the
// seam-dependents (reachable from a dead node), `drain` are the seam-independents.
export interface SeamPartition {
  cancel: string[];
  drain: string[];
}

// Partition `otherIds` (the layer's children minus the dead one(s)) by seam-
// reachability from `deadIds`. A child reachable from any dead node through the
// undirected seam graph is seam-dependent (cancel); the rest are seam-independent
// (drain). Pure: `deadIds` seed an undirected BFS over `seams`, and the buckets
// preserve `otherIds` order so the orchestrator's transitions are deterministic.
export function partitionBySeam(
  deadIds: readonly string[],
  otherIds: readonly string[],
  seams: readonly SeamContract[],
): SeamPartition {
  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    let neighbors = adjacency.get(from);
    if (neighbors === undefined) {
      neighbors = new Set<string>();
      adjacency.set(from, neighbors);
    }
    neighbors.add(to);
  };
  for (const seam of seams) {
    link(seam.producer, seam.consumer);
    link(seam.consumer, seam.producer);
  }

  const reachable = new Set<string>(deadIds);
  const queue: string[] = [...deadIds];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    for (const neighbor of adjacency.get(node) ?? []) {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const cancel: string[] = [];
  const drain: string[] = [];
  for (const id of otherIds) {
    if (reachable.has(id)) {
      cancel.push(id);
    } else {
      drain.push(id);
    }
  }
  return { cancel, drain };
}
