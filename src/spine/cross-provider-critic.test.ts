import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readNode } from '../relay-state/index';
import { agentCritic, runOrchestrator, seedFixture } from './index';
import type { Executor, ExecutorInput, ExecutorResult } from './index';

async function freshRelay(): Promise<{ base: string; relayDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-xcritic-'));
  return { base, relayDir: join(base, '.relay') };
}

// A deterministic author stand-in stamping its provider, so a test can prove the
// critic ran a DIFFERENT provider than the executor on the same leaf.
function fakeAuthor(provider: string): Executor {
  return {
    capabilities: () => ({ provider, json: true, resume: false, sandbox: true, mcp: false }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'CHANGE.txt'), `change by ${provider}\n`);
      return {
        diff: `A CHANGE.txt\n+change by ${provider}`,
        selfReport: `self-report from ${provider} — please trust me`,
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

function codexCriticStream(verdict: 'PASS' | 'FAIL'): string {
  return [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: `graded on the diff\nVERDICT: ${verdict}` },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 2 } }),
  ].join('\n');
}

// WHY: this is the phase's headline — done-ness must be decided by an INDEPENDENT
// critic on a DIFFERENT provider than the author (design §3.6). It runs the REAL
// agentCritic through the REAL orchestrator dispatch path; only the model spawn is
// faked. If the wiring ever graded with the author's provider — or skipped the
// critic — the verdict provider would not differ and this fails.
describe('the real critic runs a different provider than the executor for the same leaf', () => {
  test('a Claude-authored leaf is graded by a Codex critic, and its verdict is persisted', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      // The seeded leaf declares a `command` check (default `true`), so the critic's
      // deterministic stage passes and it proceeds to the cross-provider model.
      await seedFixture(relayDir);

      const result = await runOrchestrator(relayDir, 'root', {
        executor: fakeAuthor('claude'),
        critic: agentCritic({
          provider: 'codex',
          invoke: () => Promise.resolve({ stdout: codexCriticStream('PASS'), code: 0 }),
        }),
      });

      expect(result.rootStatus).toBe('done');
      expect(result.leafStatuses['leaf-1']).toBe('done');

      const leaf = await readNode(relayDir, 'leaf-1');
      // The author was Claude; the critic that certified the leaf was Codex — a
      // different provider, on the same leaf.
      expect(leaf.verdict?.provider).toBe('codex');
      expect(leaf.verdict?.provider).not.toBe('claude');
      expect(leaf.verdict?.pass).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('the cross-provider critic can also reject: a FAIL verdict keeps the leaf out of done', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedFixture(relayDir);

      const result = await runOrchestrator(relayDir, 'root', {
        executor: fakeAuthor('claude'),
        // A critic that always rejects walks the leaf down the ladder; with the
        // default generous caps it is promoted rather than landing done.
        critic: agentCritic({
          provider: 'codex',
          invoke: () => Promise.resolve({ stdout: codexCriticStream('FAIL'), code: 0 }),
        }),
      });

      // Persistent rejection walks the ladder to the promote rung: the leaf becomes
      // a branch, never landing done on a FAIL verdict.
      expect(result.promotedNodes).toContain('leaf-1');
      expect(result.leafStatuses['leaf-1']).not.toBe('done');
      expect(result.rootStatus).not.toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
