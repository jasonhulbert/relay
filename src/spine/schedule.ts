// The sibling scheduler — the concurrency law made operational (design §3.8/§3.10,
// A1/A2, M10 Phase 1). A decomposed layer is SERIAL BY DEFAULT (A1, the safe ground
// state); parallelism is the justified exception, licensed only by the concurrency
// law (A2): a layer's children may run in parallel iff (1) their resource footprints
// are disjoint AND (2) the seam between them is pre-declarable.
//
// This builds the schedule the orchestrator dispatches: an ordered list of STAGES,
// each a set of child node-ids that may run concurrently; the stages run in
// sequence. Two siblings share a stage only when `mayRunConcurrently` holds; the
// rest serialize into later stages.
//
// What this phase decides on, and what it defers:
//   - Condition (1) is computed from the layer's footprints (`footprintsDisjoint`).
//     A child whose footprint is unknown (no manifest, or no entry) cannot be PROVEN
//     disjoint, so it serializes — the A1 bias toward the safe ground state.
//   - Condition (2): the parent authors every seam at decomposition (A8) into the
//     layer manifest, so a seam that exists IS pre-declared. The forcing function —
//     a seam the parent cannot reduce to a checkable kind forces serialization (F3)
//     — lives at decomposition and in the seam predicates (Phase 2); a layer that
//     reached here with disjoint footprints already cleared it. So the scheduling
//     decision in this phase rests on footprint disjointness; the seam graph the
//     manifest carries is what the integration gate (Phase 3) and the failure rule
//     (Phase 4) consume.
import type { LayerManifest } from '../relay-state/index';
import { footprintsDisjoint } from './footprint';

// The dispatch schedule: stages run in order; the children within a stage run
// concurrently (their footprints are pairwise disjoint). A fully serial layer is N
// single-child stages; a fully parallel one is a single N-child stage.
export interface Schedule {
  stages: string[][];
}

// May two siblings of one layer run concurrently under the concurrency law (A2)?
// Decided from the layer's declared footprints: both must be known and provably
// disjoint. An absent manifest or a child without a footprint entry is not provably
// disjoint, so the answer is no (serialize — the A1 safe ground state).
export function mayRunConcurrently(layer: LayerManifest | null, a: string, b: string): boolean {
  if (layer === null) return false;
  const fa = layer.footprints[a];
  const fb = layer.footprints[b];
  if (fa === undefined || fb === undefined) return false;
  return footprintsDisjoint(fa, fb);
}

// Build the dispatch schedule for a layer's children (A2). Greedy first-fit in
// child order (so the schedule is deterministic and stable across rehydration): a
// child joins the earliest existing stage in which it may run concurrently with
// every current member, else it opens a new stage. Disjoint-footprint siblings
// collapse into one parallel stage; a shared-resource pair lands in separate serial
// stages. With no layer manifest (a hand-seeded branch), every child opens its own
// stage — fully serial, exactly the pre-concurrency behavior.
export function buildSchedule(childIds: readonly string[], layer: LayerManifest | null): Schedule {
  const stages: string[][] = [];
  for (const id of childIds) {
    const stage = stages.find((members) => members.every((m) => mayRunConcurrently(layer, id, m)));
    if (stage) {
      stage.push(id);
    } else {
      stages.push([id]);
    }
  }
  return { stages };
}
