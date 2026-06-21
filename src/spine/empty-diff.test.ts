import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runOrchestrator, scriptedCritic, seedFixture, STUB_USAGE } from './index';
import type { Executor, ExecutorInput, ExecutorResult } from './index';

async function freshRelay(): Promise<{ base: string; relayDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-empty-'));
  return { base, relayDir: join(base, '.relay') };
}

// An executor that produces NO change — an empty diff. Records each call so a test
// can count attempts (= rungs walked). Stands in for a real provider that decided the
// outcome was already satisfied, or for one that did nothing useful: which of the two
// it is is NOT the executor's to declare — the critic gates the empty diff (below).
function emptyDiffExecutor(calls: number[]): Executor {
  return {
    capabilities: () => ({ provider: 'empty', json: true, resume: false, sandbox: true, mcp: false }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      calls.push(1);
      await mkdir(worktree, { recursive: true });
      return {
        diff: '',
        selfReport: 'no change was necessary',
        usage: STUB_USAGE,
        exitStatus: 0,
      };
    },
  };
}

// WHY: after a run seeds the executor sandbox from the real project, an empty diff is
// AMBIGUOUS — it can mean "the outcome was already satisfied" (a legitimate done) or
// "the executor did nothing" (a non-attempt). The executor path must NOT resolve that
// ambiguity by auto-escalating an empty diff (which would burn the ladder on a leaf
// that was actually already done, or auto-pass one that wasn't). Done-ness is the
// critic's call (C7, §3.6): the empty diff is handed to the critic like any other
// evidence, and the critic's verdict — not the emptiness — decides. These two tests
// pin both directions of that gate.
describe('an empty diff is gated by the critic, not auto-escalated by the executor path', () => {
  test('empty diff + a passing critic resolves to done in ONE attempt — no rung walked', async () => {
    const { base, relayDir } = await freshRelay();
    const calls: number[] = [];
    try {
      await seedFixture(relayDir);

      // The critic judges the already-satisfied outcome met on the produced (empty)
      // evidence. If an empty diff auto-escalated, this would take more than one attempt
      // or never reach done at all.
      const result = await runOrchestrator(relayDir, 'root', {
        executor: emptyDiffExecutor(calls),
        critic: scriptedCritic({ results: ['pass'] }),
      });

      expect(result.leafStatuses['leaf-1']).toBe('done');
      expect(result.rootStatus).toBe('done');
      // Exactly one dispatch: the critic passed the empty diff on the first attempt, so
      // NO retry / swap-provider / raise-tier / promote rung was consumed.
      expect(calls.length).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('empty diff + a rejecting critic still escalates — it is not silently accepted', async () => {
    const { base, relayDir } = await freshRelay();
    const calls: number[] = [];
    try {
      await seedFixture(relayDir);

      // The critic rejects the empty diff (the outcome is NOT already met). A two-attempt
      // cap lets the ladder walk one rung (retry) and then exhaust to a blocked leaf, so
      // the escalation is observable without a deep promote cascade.
      const result = await runOrchestrator(relayDir, 'root', {
        executor: emptyDiffExecutor(calls),
        critic: scriptedCritic({ results: ['fail'] }),
        caps: { maxAttempts: 2, maxTokens: 1_000_000, maxWallClockMs: 1_000_000 },
      });

      // The rejected empty diff was re-dispatched (escalated), not accepted as done.
      expect(calls.length).toBe(2);
      expect(result.leafStatuses['leaf-1']).toBe('blocked');
      expect(result.rootStatus).not.toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
