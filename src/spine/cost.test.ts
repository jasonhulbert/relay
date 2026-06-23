import { describe, expect, test } from 'vitest';
import { DEFAULT_PRICE_TABLE, renderCostRollup, resolveCost } from './cost';
import type { PriceTable } from './cost';
import type { ExecutorUsage } from './executor';
import type { CallUsage } from '../relay-state/index';

function usage(over: Partial<ExecutorUsage>): ExecutorUsage {
  return {
    provider: 'codex',
    model: 'test-mini',
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    wallClockMs: 0,
    costUsd: null,
    ...over,
  };
}

const TABLE: PriceTable = {
  'test-mini': { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 4 },
};

// WHY: the cost rollup's whole point is a deterministic dollar figure (Rule 5). A provider that
// reports its own cost (Claude `total_cost_usd`) must be trusted as-is, never
// re-derived; a token-only provider (Codex) must be priced from the table by the
// SAME buckets the adapter splits — getting either wrong silently misattributes spend.
describe('resolveCost', () => {
  test('a provider-reported cost is used directly, table untouched', () => {
    const r = resolveCost(usage({ provider: 'claude', model: 'haiku', costUsd: 0.123456 }), TABLE);
    expect(r).toEqual({ costUsd: 0.123456, source: 'direct' });
  });

  test('a token-only call is derived from the price table by bucket', () => {
    const r = resolveCost(
      usage({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500 }),
      TABLE,
    );
    // (1000*1 + 200*0.1 + 500*4) / 1e6 = 3020 / 1e6
    expect(r.source).toBe('price-table');
    expect(r.costUsd).toBeCloseTo(0.00302, 10);
  });

  test('a model absent from the table is unpriced, not silently zero', () => {
    const r = resolveCost(usage({ model: 'unknown-model', inputTokens: 999 }), TABLE);
    expect(r).toEqual({ costUsd: null, source: 'unpriced' });
  });

  test('the default table prices the Codex cheapest default (gpt-5.4-mini)', () => {
    const r = resolveCost(usage({ model: 'gpt-5.4-mini', outputTokens: 1 }), DEFAULT_PRICE_TABLE);
    expect(r.source).toBe('price-table');
    expect(r.costUsd).not.toBeNull();
  });
});

function record(over: Partial<CallUsage>): CallUsage {
  return {
    runId: 'run-1',
    nodeId: 'leaf-1',
    role: 'executor',
    seq: 1,
    provider: 'codex',
    model: 'test-mini',
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    wallClockMs: 0,
    costUsd: 0,
    costSource: 'price-table',
    ...over,
  };
}

// WHY: the rollup is the operator's cost-per-outcome view. It must sum per node and
// across the run, and must surface an unpriced call as a GAP rather than counting it
// as $0 — a silently-dropped cost reads as "cheaper than it was".
describe('renderCostRollup', () => {
  test('attributes cost per node and totals the run', () => {
    const md = renderCostRollup('run-1', [
      record({ nodeId: 'leaf-1', role: 'executor', costUsd: 0.002 }),
      record({
        nodeId: 'leaf-1',
        role: 'critic',
        provider: 'claude',
        costUsd: 0.4,
        costSource: 'direct',
      }),
      record({ nodeId: 'root', role: 'brain', costUsd: 0.01 }),
    ]);
    expect(md).toContain('# cost rollup `run-1`');
    expect(md).toContain('Run total: $0.412000');
    expect(md).toContain('`leaf-1`: $0.402000');
    expect(md).toContain('`root`: $0.010000');
    expect(md).toContain('[critic #1] claude');
  });

  test('surfaces an unpriced call rather than counting it as zero', () => {
    const md = renderCostRollup('run-1', [
      record({ costUsd: 0.005 }),
      record({ role: 'critic', costUsd: null, costSource: 'unpriced' }),
    ]);
    expect(md).toContain('Run total: $0.005000');
    expect(md).toContain('+1 uncosted call(s)');
  });

  test('an empty run renders no total figure', () => {
    const md = renderCostRollup('run-1', []);
    expect(md).toContain('Calls: 0');
    expect(md).toContain('(no model calls this run)');
  });
});
