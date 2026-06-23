// The escalation ladder: the bounded sequence a leaf walks when its critic
// returns FAIL, before terminal `blocked`. Rungs, in order: retry (same
// provider) → swap-provider → raise-tier → promote (leaf→branch, re-decompose).
// A too-big judgment jumps straight to promote (judged too big → PROMOTE
// leaf→branch).
//
// This is a PURE controller: given the signal an attempt produced and the budget
// consumed so far, it returns the next rung to take or signals exhaustion. It
// performs no `.relay/` write and runs no executor — the orchestrator owns
// dispatch and persistence (it is the sole writer of `.relay/`). The two things
// that consume its output: the `promote` rung's atomic leaf→branch transaction,
// and the `blocked` record + halt-and-surface that consume `exhausted`.
import { capReached } from './rails';
import type { CapKind, RailCaps, RailUsage } from './rails';

export type Rung = 'retry' | 'swap-provider' | 'raise-tier' | 'promote';

// Canonical rung order. The controller walks this front-to-back on persistent
// failure; the ladder ends after `promote`.
export const LADDER_RUNGS: readonly Rung[] = ['retry', 'swap-provider', 'raise-tier', 'promote'];

// The signal an attempt produced, as judged by the critic / sizing call.
// `pass` ends the ladder successfully; `fail` advances one rung; `too-big` jumps
// to promote. These are currently injected by controllable stubs; later they are
// sourced from real providers.
export type AttemptSignal = 'pass' | 'fail' | 'too-big';

// Why the ladder ended without success.
export type ExhaustionReason =
  // A budget cap halted the ladder mid-walk (the rail guarantee).
  | { kind: 'cap'; cap: CapKind }
  // Every rung was walked (promote included) and the outcome was still not met.
  | { kind: 'rungs-walked' };

// What the controller decides after an attempt.
export type LadderStep =
  // Outcome met — stop, success.
  | { kind: 'done' }
  // Take this rung next; it has been recorded in `rungsSpent`.
  | { kind: 'rung'; rung: Rung }
  // Ladder is over without success → the caller writes the `blocked` record
  // and runs the unified failure rule.
  | { kind: 'exhausted'; reason: ExhaustionReason };

// Stateful per-leaf escalation walk. One instance tracks one leaf's progress
// down the ladder; the orchestrator drives it with the signal from each attempt.
export class EscalationLadder {
  private nextIndex = 0;
  // The rungs actually handed out, in order — the audit trail the blocked
  // record reports as "rungs spent".
  private readonly spent: Rung[] = [];

  constructor(private readonly caps: RailCaps) {}

  // Rungs handed out so far, in order. Read by the blocked record.
  get rungsSpent(): readonly Rung[] {
    return this.spent.slice();
  }

  // Decide the next step from the latest attempt's `signal` and the budget
  // `usage` consumed so far. A reached cap halts the ladder no matter which rung
  // would be next — the rail guarantee comes before the rung walk.
  step(signal: AttemptSignal, usage: RailUsage): LadderStep {
    if (signal === 'pass') {
      return { kind: 'done' };
    }
    const cap = capReached(this.caps, usage);
    if (cap !== null) {
      return { kind: 'exhausted', reason: { kind: 'cap', cap } };
    }
    if (signal === 'too-big') {
      // Skip the lower rungs and go straight to promote — but never walk
      // backwards if promote was already reached.
      this.nextIndex = Math.max(this.nextIndex, LADDER_RUNGS.indexOf('promote'));
    }
    if (this.nextIndex >= LADDER_RUNGS.length) {
      return { kind: 'exhausted', reason: { kind: 'rungs-walked' } };
    }
    const rung = LADDER_RUNGS[this.nextIndex];
    this.nextIndex += 1;
    this.spent.push(rung);
    return { kind: 'rung', rung };
  }
}
