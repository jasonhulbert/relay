import { describe, expect, test } from 'vitest';
import { runCritic, toCriticView } from '../relay-state/index';
import type { CriticSpawn, NodeRecord } from '../relay-state/index';
import {
  checkGate,
  defaultGateConfig,
  EscalationLadder,
  GateRefusal,
  scriptedCritic,
} from './index';
import type { AttemptSignal, LadderStep, RailCaps, Rung } from './index';

// A bare critic-visible projection over a throwaway node — the scripted critic
// ignores it, but routing through `toCriticView` keeps the verdict on the real
// C7 path rather than a hand-built object.
function critiqueView() {
  const node: NodeRecord = {
    id: 'leaf-x',
    parentId: 'root',
    kind: 'leaf',
    status: 'active',
    spec: { outcome: 'the leaf reaches its outcome', verifications: [] },
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  return toCriticView(node, '');
}

// Drive the ladder the way the orchestrator will: each iteration is one dispatch
// attempt whose verdict (from the injected critic) becomes the ladder signal;
// the ladder decides the next rung or that the ladder is over. The driver owns
// nothing but the loop — exactly the controller boundary the design draws
// between code-owned dispatch and the pure ladder decision.
async function walkLadder(
  critic: CriticSpawn,
  caps: RailCaps,
): Promise<{ rungs: Rung[]; final: LadderStep; spent: readonly Rung[] }> {
  const ladder = new EscalationLadder(caps);
  const rungs: Rung[] = [];
  const usage = { attempts: 0, tokens: 0, elapsedMs: 0 };
  const view = critiqueView();
  // Bounded so a controller bug surfaces as a failure, not a hang.
  for (let i = 0; i < 50; i += 1) {
    usage.attempts += 1;
    const verdict = await runCritic(critic, view);
    const signal: AttemptSignal = verdict.pass ? 'pass' : 'fail';
    const step = ladder.step(signal, usage);
    if (step.kind === 'done' || step.kind === 'exhausted') {
      return { rungs, final: step, spent: ladder.rungsSpent };
    }
    rungs.push(step.rung);
  }
  throw new Error('ladder did not terminate within the attempt bound');
}

// WHY: this is the phase's reason to exist — the loop must answer FAIL, not only
// PASS. A leaf whose critic never accepts it must escalate through the rungs in
// the design's order and then STOP, because the budget rails — not a judgment —
// guarantee termination (§3.7, §3.9). A controller that reordered the rungs, or
// failed to stop at a cap, would burn unbounded metered credit; this test fails
// in exactly those cases.
describe('escalation ladder under injected persistent failure', () => {
  test('walks retry → swap-provider → raise-tier → promote, then halts at the cap', async () => {
    // Persistent failure: the critic rejects every attempt.
    const critic = scriptedCritic({ results: ['fail'] });
    // Cap permits the initial dispatch plus all four rungs (5 attempts); the
    // sixth would-be attempt is what the cap refuses, after promote is spent.
    const caps: RailCaps = { maxAttempts: 5, maxTokens: 1_000_000, maxWallClockMs: 1_000_000 };

    const { rungs, final, spent } = await walkLadder(critic, caps);

    // Rung sequence, in the design's order.
    expect(rungs).toEqual(['retry', 'swap-provider', 'raise-tier', 'promote']);
    // The audit trail the (Phase 3) blocked record reads matches what was walked.
    expect(spent).toEqual(rungs);
    // And it stopped — on a budget cap, not by running forever.
    expect(final).toEqual({ kind: 'exhausted', reason: { kind: 'cap', cap: 'attempt' } });
  });

  test('a tight attempt cap halts mid-walk, before promote', async () => {
    const critic = scriptedCritic({ results: ['fail'] });
    // The first attempt is the initial dispatch; each later attempt is one rung,
    // so a cap of 3 permits the initial plus two escalations (retry, swap).
    const caps: RailCaps = { maxAttempts: 3, maxTokens: 1_000_000, maxWallClockMs: 1_000_000 };

    const { rungs, final } = await walkLadder(critic, caps);

    expect(rungs).toEqual(['retry', 'swap-provider']);
    expect(final).toEqual({ kind: 'exhausted', reason: { kind: 'cap', cap: 'attempt' } });
  });

  test('exhausts with rungs-walked when every rung fails within budget', async () => {
    const critic = scriptedCritic({ results: ['fail'] });
    // Generous caps so the natural end of the ladder — not a cap — stops it.
    const caps: RailCaps = { maxAttempts: 50, maxTokens: 1_000_000, maxWallClockMs: 1_000_000 };

    const { rungs, final } = await walkLadder(critic, caps);

    expect(rungs).toEqual(['retry', 'swap-provider', 'raise-tier', 'promote']);
    expect(final).toEqual({ kind: 'exhausted', reason: { kind: 'rungs-walked' } });
  });
});

// WHY: each rail must independently force a stop; if only the attempt cap were
// load-bearing, a cheap-but-slow or token-heavy loop could still run away.
describe('each budget rail independently halts the ladder', () => {
  test('the token cap halts the ladder', () => {
    const ladder = new EscalationLadder({
      maxAttempts: 50,
      maxTokens: 100,
      maxWallClockMs: 1_000_000,
    });
    const step = ladder.step('fail', { attempts: 1, tokens: 100, elapsedMs: 0 });
    expect(step).toEqual({ kind: 'exhausted', reason: { kind: 'cap', cap: 'token' } });
  });

  test('the wall-clock cap halts the ladder', () => {
    const ladder = new EscalationLadder({
      maxAttempts: 50,
      maxTokens: 1_000_000,
      maxWallClockMs: 5_000,
    });
    const step = ladder.step('fail', { attempts: 1, tokens: 0, elapsedMs: 5_000 });
    expect(step).toEqual({ kind: 'exhausted', reason: { kind: 'cap', cap: 'wall-clock' } });
  });
});

// WHY: a too-big judgment is a different failure than a flaky one — re-running
// the same leaf is wasted spend, so the ladder skips the lower rungs and goes
// straight to promote (§3.9). Fail-then-succeed proves the ladder is not a
// one-way street: a passing attempt ends it cleanly with no rung spent.
describe('ladder signals beyond persistent failure', () => {
  test('a too-big signal jumps straight to promote', () => {
    const ladder = new EscalationLadder({
      maxAttempts: 50,
      maxTokens: 1_000_000,
      maxWallClockMs: 1_000_000,
    });
    const step = ladder.step('too-big', { attempts: 1, tokens: 0, elapsedMs: 0 });
    expect(step).toEqual({ kind: 'rung', rung: 'promote' });
    expect(ladder.rungsSpent).toEqual(['promote']);
  });

  test('fail-then-succeed ends the ladder at done after one rung', async () => {
    const critic = scriptedCritic({ results: ['fail', 'pass'] });
    const caps: RailCaps = { maxAttempts: 50, maxTokens: 1_000_000, maxWallClockMs: 1_000_000 };

    const { rungs, final } = await walkLadder(critic, caps);

    expect(rungs).toEqual(['retry']);
    expect(final).toEqual({ kind: 'done' });
  });
});

// WHY: gates refuse actions the loop must never take autonomously. A write to a
// protected branch or an unpermitted macOS host action must be refused loudly
// (Rule 11), never silently skipped — a silent skip would let the loop believe
// it acted when it did not.
describe('action gates refuse forbidden actions', () => {
  test('a protected-branch git write is refused', () => {
    const config = defaultGateConfig();
    expect(config.protectedBranches).toContain('main');
    expect(() => {
      checkGate(config, { kind: 'git-write', branch: 'main' });
    }).toThrow(GateRefusal);
  });

  test('a write to a non-protected branch is permitted', () => {
    const config = defaultGateConfig();
    expect(() => {
      checkGate(config, { kind: 'git-write', branch: 'relay/leaf-1' });
    }).not.toThrow();
  });

  test('a macOS system action is refused by default and permitted when allowed', () => {
    const action = { kind: 'macos-system', action: 'empty Trash' } as const;
    expect(() => {
      checkGate(defaultGateConfig(), action);
    }).toThrow(GateRefusal);
    expect(() => {
      checkGate({ protectedBranches: [], allowMacosSystemActions: true }, action);
    }).not.toThrow();
  });
});
