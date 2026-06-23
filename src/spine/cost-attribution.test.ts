import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import { seedFixture } from './seed';
import type { PriceTable } from './cost';
import type { Executor, ExecutorResult } from './executor';
import {
  readRunUsage,
  relativeCostRollupPath,
  relativeUsagePath,
  relayPaths,
} from '../relay-state/index';
import type { CriticSpawn } from '../relay-state/index';

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-cost-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// A Codex-shaped executor: reports tokens but NO dollar figure (costUsd null), so
// its cost must be derived from the price table.
function codexishExecutor(): Executor {
  return {
    capabilities: () => ({ provider: 'codex', json: true, resume: true, sandbox: true, mcp: true }),
    run: (): Promise<ExecutorResult> =>
      Promise.resolve({
        diff: 'A f.txt\n+x',
        selfReport: 'did the thing',
        usage: {
          provider: 'codex',
          model: 'test-mini',
          inputTokens: 1000,
          cachedInputTokens: 200,
          outputTokens: 500,
          wallClockMs: 7,
          costUsd: null,
        },
        exitStatus: 0,
      }),
  };
}

// A Claude-shaped critic: reports its own dollar figure (direct), and passes. It
// emits usage into the orchestrator-supplied usage sink, attributed to the graded leaf.
function claudeishCritic(directCost: number): CriticSpawn {
  return (_view, ctx) => {
    ctx.onUsage?.({
      provider: 'claude',
      model: 'test-haiku',
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      wallClockMs: 3,
      costUsd: directCost,
    });
    return Promise.resolve({
      pass: true,
      provider: 'claude',
      rationale: 'looks done',
      evidenceRefs: [],
    });
  };
}

const TABLE: PriceTable = {
  'test-mini': { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 4 },
};

// Validation (headline): a multi-call run produces per-node cost attribution AND a
// per-run rollup in `.relay/`; the Claude figure equals the stream's direct cost and
// the Codex figure equals the price-table derivation from its tokens (fixed table).
describe('per-call cost attribution and rollup', () => {
  test('per-call records (direct vs derived) and a per-run rollup land in .relay/', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir, { outcome: 'do the outcome', check: 'true' });

      const res = await runOrchestrator(relayDir, 'root', {
        executor: codexishExecutor(),
        critic: claudeishCritic(0.42),
        workRoot,
        priceTable: TABLE,
      });
      expect(res.rootStatus).toBe('done');

      const records = await readRunUsage(relayDir, 'run-1');
      // The leaf had two model calls: its executor and its critic — both attributed
      // to leaf-1 (per-node attribution).
      expect(records.map((r) => `${r.nodeId}/${r.role}`).sort()).toEqual([
        'leaf-1/critic',
        'leaf-1/executor',
      ]);

      // Codex: derived from the fixed table by bucket.
      // (1000*1 + 200*0.1 + 500*4) / 1e6 = 0.00302
      const exec = records.find((r) => r.role === 'executor');
      expect(exec?.provider).toBe('codex');
      expect(exec?.costSource).toBe('price-table');
      expect(exec?.costUsd).toBeCloseTo(0.00302, 10);

      // Claude: the provider's own dollar figure, used directly.
      const critic = records.find((r) => r.role === 'critic');
      expect(critic?.provider).toBe('claude');
      expect(critic?.costSource).toBe('direct');
      expect(critic?.costUsd).toBe(0.42);

      // The raw records and the rollup are code-owned `.relay/` writes.
      expect(res.ownedWrites).toContain(relativeUsagePath('run-1', 'leaf-1', 'executor', 1));
      expect(res.ownedWrites).toContain(relativeUsagePath('run-1', 'leaf-1', 'critic', 1));
      expect(res.ownedWrites).toContain(relativeCostRollupPath('run-1'));

      // The per-run rollup exists in `.relay/` and names the node + the run total.
      const rollupPath = relayPaths(relayDir).costRollup('run-1');
      expect(await exists(rollupPath)).toBe(true);
      const rollup = await readFile(rollupPath, 'utf8');
      expect(rollup).toContain('`leaf-1`');
      // run total = 0.00302 (codex) + 0.42 (claude) = 0.42302
      expect(rollup).toContain('Run total: $0.423020');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: usage telemetry is about REAL spend. The hermetic stub path runs no model, so
  // it must persist NO usage records and write NO rollup — otherwise every hermetic
  // spine run would gain telemetry files and the ownership-footprint assertions
  // (e.g. hierarchy's exact ownedWrites) would shift under it.
  test('the stub path writes no telemetry', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir, { check: 'true' });
      // Default executor/critic/brain == the stubs.
      const res = await runOrchestrator(relayDir, 'root', { workRoot });
      expect(res.rootStatus).toBe('done');
      expect(await readRunUsage(relayDir, 'run-1')).toEqual([]);
      expect(await exists(relayPaths(relayDir).costRollup('run-1'))).toBe(false);
      expect(res.ownedWrites.some((w) => w.includes('/usage/') || w.endsWith('cost.md'))).toBe(
        false,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
