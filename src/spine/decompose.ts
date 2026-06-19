// Promotion re-decomposes a leaf that could not be done into a branch with new
// child outcomes (design §3.9: "judged too big → PROMOTE leaf→branch", and the
// failure ladder's final rung). The real, model-driven decomposition arrives at
// M4; M3 ships a STUB so the promotion transaction has children to write and the
// keep-lesson path is exercised on deterministic stubs.
//
// A decomposer is PURE: given the parent's spec it returns the new child specs.
// It performs no `.relay/` write and makes no judgment of its own — the
// orchestrator owns the atomic transaction that persists the result (C2), and
// injects the failed attempt's reflection into each child's context.
import type { OutcomeSpec } from '../relay-state/index';

export type Decompose = (parentSpec: OutcomeSpec) => OutcomeSpec[];

// Deterministic 2-way split: the promoted branch gets two child leaves, each
// inheriting the parent's verifications so a driven child grades against the same
// checks. Fixed and pure so a kill-and-rehydrate reproduces identical child
// records (the rehydration contract, §3.2).
export const stubDecompose: Decompose = (parentSpec) => {
  return [0, 1].map((i) => ({
    outcome: `${parentSpec.outcome} (part ${(i + 1).toString()} of 2)`,
    verifications: parentSpec.verifications,
  }));
};
