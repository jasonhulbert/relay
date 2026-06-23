import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { deserializeUsage, readRunUsage, serializeUsage, writeUsage } from './usage';
import type { CallUsage } from './types';

function rec(over: Partial<CallUsage> = {}): CallUsage {
  return {
    runId: 'run-1',
    nodeId: 'leaf-1',
    role: 'executor',
    seq: 1,
    provider: 'codex',
    model: 'gpt-5.4-mini',
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 500,
    wallClockMs: 1234,
    costUsd: 0.00302,
    costSource: 'price-table',
    ...over,
  };
}

// WHY: the per-call record is the ground truth the rollup is composed from. A
// lossy codec would silently corrupt cost attribution, so the front-matter must
// round-trip every field exactly (the body is a generated rendering, not parsed).
describe('usage record codec', () => {
  test('round-trips every field through serialize/deserialize', () => {
    const u = rec();
    expect(deserializeUsage(serializeUsage(u))).toEqual(u);
  });

  test('round-trips an unpriced (null-cost) record', () => {
    const u = rec({ provider: 'codex', costUsd: null, costSource: 'unpriced' });
    expect(deserializeUsage(serializeUsage(u))).toEqual(u);
  });

  test('readRunUsage collects all nodes sorted by node/role/seq', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-usage-'));
    const relayDir = join(base, '.relay');
    try {
      // Written out of order across nodes and roles.
      await writeUsage(relayDir, rec({ nodeId: 'leaf-1', role: 'executor', seq: 1 }));
      await writeUsage(relayDir, rec({ nodeId: 'leaf-1', role: 'critic', seq: 1 }));
      await writeUsage(relayDir, rec({ nodeId: 'root', role: 'brain', seq: 0 }));
      await writeUsage(relayDir, rec({ nodeId: 'leaf-1', role: 'executor', seq: 2 }));

      const got = await readRunUsage(relayDir, 'run-1');
      expect(got.map((r) => `${r.nodeId}/${r.role}/${r.seq.toString()}`)).toEqual([
        'leaf-1/critic/1',
        'leaf-1/executor/1',
        'leaf-1/executor/2',
        'root/brain/0',
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('readRunUsage returns empty for a run that spent no model call', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-usage-'));
    try {
      expect(await readRunUsage(join(base, '.relay'), 'run-1')).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
