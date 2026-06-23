// The sibling scheduler — the concurrency law made operational. A decomposed layer
// is SERIAL BY DEFAULT (the safe ground state); parallelism is the justified
// exception, licensed only by the concurrency law: a layer's children may run in
// parallel iff (1) their resource footprints are disjoint AND (2) the seam between
// them is pre-declarable.
//
// This builds the schedule the orchestrator dispatches: an ordered list of STAGES,
// each a set of child node-ids that may run concurrently; the stages run in
// sequence. Two siblings share a stage only when `mayRunConcurrently` holds; the
// rest serialize into later stages.
//
// What this module decides on, and what it defers:
//   - Condition (1) is computed from the layer's footprints (`footprintsDisjoint`).
//     A child whose footprint is unknown (no manifest, or no entry) cannot be PROVEN
//     disjoint, so it serializes — the bias toward the safe ground state.
//   - Condition (2): the parent authors every seam at decomposition into the layer
//     manifest, so a seam that exists IS pre-declared. The seam-checkability forcing
//     function — a seam the parent cannot reduce to a code-checkable kind forces
//     serialization — is enforced HERE: a seam between two siblings whose kind has no
//     code predicate yet (`http`/`data-schema`; see `seamIsCheckable`) makes them
//     serialize even with disjoint footprints, because an unverifiable seam cannot
//     gate their parallel merge. So the decision rests on BOTH conditions: disjoint
//     footprints and only-checkable seams between the pair. The seam graph the
//     manifest carries is also what the integration gate and the failure rule
//     consume.
import type { LayerManifest } from '../relay-state/index';
import { footprintsDisjoint } from './footprint';
import { seamIsCheckable } from './seam';

// The dispatch schedule: stages run in order; the children within a stage run
// concurrently (their footprints are pairwise disjoint). A fully serial layer is N
// single-child stages; a fully parallel one is a single N-child stage.
export interface Schedule {
  stages: string[][];
}

// May two siblings of one layer run concurrently under the concurrency law? Both
// conditions must hold: (1) their declared footprints are known and provably
// disjoint, AND (2) no seam between them is uncheckable. An absent manifest or a
// child without a footprint entry is not provably disjoint, so the answer is no; an
// uncheckable seam between the pair likewise forces no — both default to the safe
// ground state of serializing.
export function mayRunConcurrently(layer: LayerManifest | null, a: string, b: string): boolean {
  if (layer === null) return false;
  const fa = layer.footprints[a];
  const fb = layer.footprints[b];
  if (fa === undefined || fb === undefined) return false;
  if (!footprintsDisjoint(fa, fb)) return false;
  // Concurrency-law condition 2 (the seam-checkability forcing function): a seam the
  // parent could not reduce to a code-checkable kind cannot gate the two siblings'
  // parallel merge, so it forces serialization even when their footprints are disjoint.
  for (const seam of layer.seams) {
    const connects =
      (seam.producer === a && seam.consumer === b) || (seam.producer === b && seam.consumer === a);
    if (connects && !seamIsCheckable(seam.kind)) return false;
  }
  return true;
}

// Build the dispatch schedule for a layer's children. Greedy first-fit in
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
