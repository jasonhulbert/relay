import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readNode } from '../relay-state/index';
import { runOrchestrator, scriptedCritic, seedFixture } from './index';
import type { Executor, ExecutorInput, ExecutorResult } from './index';

async function freshRelay(): Promise<{ base: string; relayDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-swap-'));
  return { base, relayDir: join(base, '.relay') };
}

// A deterministic provider stand-in: makes a gradeable change and stamps its
// provider + a distinguishable self-report, and records every call into a shared
// log so a test can observe WHICH provider ran each attempt. Standing in for the
// real Claude/Codex adapters, which this rung switches between.
function fakeProvider(provider: string, calls: string[]): Executor {
  return {
    capabilities: () => ({ provider, json: true, resume: false, sandbox: true, mcp: false }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      calls.push(provider);
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'CHANGE.txt'), `change by ${provider}\n`);
      return {
        diff: `A CHANGE.txt\n+change by ${provider}`,
        selfReport: `self-report from ${provider}`,
        usage: {
          provider,
          model: `${provider}-cheap`,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          wallClockMs: 1,
          costUsd: null,
        },
        exitStatus: 0,
      };
    },
  };
}

// WHY: the swap-provider rung exists so a leaf that a provider cannot satisfy is
// re-tried under a DIFFERENT provider, not the same one again (design §3.7). A
// loop that re-dispatched the primary on swap-provider would burn the rung for
// nothing — the cross-provider critic and the whole multi-provider premise rest on
// this actually switching. This pins exactly that: two failures walk retry then
// swap-provider, and only the post-swap attempt (the alternate provider) is what
// carries the leaf to done.
describe('the swap-provider rung re-dispatches under the other provider', () => {
  test('a primary failure escalates to the alternate provider, which lands the leaf', async () => {
    const { base, relayDir } = await freshRelay();
    const calls: string[] = [];
    try {
      await seedFixture(relayDir);

      // Ladder walk under persistent-then-passing verdicts:
      //   attempt 1 (primary)  -> fail -> rung `retry`
      //   attempt 2 (primary)  -> fail -> rung `swap-provider`
      //   attempt 3 (alternate)-> pass -> done
      const result = await runOrchestrator(relayDir, 'root', {
        executor: fakeProvider('primary', calls),
        swapExecutor: fakeProvider('alternate', calls),
        critic: scriptedCritic({ results: ['fail', 'fail', 'pass'] }),
      });

      expect(result.rootStatus).toBe('done');
      expect(result.leafStatuses['leaf-1']).toBe('done');

      // The provider changed exactly on the swap-provider rung: the first two
      // attempts ran the primary, the third ran the alternate.
      expect(calls).toEqual(['primary', 'primary', 'alternate']);

      // The leaf that reached done carries the ALTERNATE provider's evidence —
      // proof the swap, not a same-provider retry, is what landed it.
      const leaf = await readNode(relayDir, 'leaf-1');
      expect(leaf.selfReport).toBe('self-report from alternate');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('without a configured alternate, swap-provider re-dispatches the primary (stub path)', async () => {
    const { base, relayDir } = await freshRelay();
    const calls: string[] = [];
    try {
      await seedFixture(relayDir);

      // No swapExecutor: the swap rung must fall back to the primary so the M1–M3
      // stub ladder behavior is unchanged.
      const result = await runOrchestrator(relayDir, 'root', {
        executor: fakeProvider('primary', calls),
        critic: scriptedCritic({ results: ['fail', 'fail', 'pass'] }),
      });

      expect(result.leafStatuses['leaf-1']).toBe('done');
      expect(calls).toEqual(['primary', 'primary', 'primary']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
