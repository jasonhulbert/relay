// F5 cost derivation and rollup (design §8). Tokens are ground truth; dollars are
// either DIRECT (the provider reports the call's cost — Claude `total_cost_usd`) or
// DERIVED from a local, editable price table (Codex reports tokens, not dollars).
// This is deterministic code, not a model judgment (Rule 5): given a usage record
// and a price table, the dollar figure is a pure function.
//
// The price table is the single editable knob for the table-driven providers. It is
// pinned at build time from the account's published rates and is meant to be edited
// in one place when rates change — there is no billing API and no new credential
// path (the M4 constraint). A model with no row is reported `unpriced` rather than
// crashing a completed run; the rollup surfaces the gap loudly (Rule 11) so a
// missing rate is visible, not silently counted as $0.
import type { ExecutorUsage } from './executor';
import type { CallUsage, CostSource } from '../relay-state/index';

// Per-million-token USD rates for one model, split by the buckets `ExecutorUsage`
// already carries (uncached input, cached input, output). Per-MTok (not per-token)
// because that is how vendors publish rates, so the table stays human-editable.
export interface ModelPrice {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export type PriceTable = Record<string, ModelPrice>;

// The pinned local price table (editable; rates as of 2026-06). Only the table-
// driven providers need rows here — Claude calls carry their own `total_cost_usd`
// and are priced `direct`, never from this table. `gpt-5.4-mini` is the Codex
// executor/critic/brain cheapest default (the cost guardrail), so it is the row a
// default v0.1 run actually exercises.
export const DEFAULT_PRICE_TABLE: PriceTable = {
  'gpt-5.4-mini': {
    inputPerMTok: 0.25,
    cachedInputPerMTok: 0.025,
    outputPerMTok: 2.0,
  },
};

export interface ResolvedCost {
  costUsd: number | null;
  source: CostSource;
}

// Resolve a call's dollar figure. A provider-reported cost (Claude) is authoritative
// and used as-is (`direct`). Otherwise the figure is derived from the table by the
// token buckets (`price-table`); a model absent from the table is `unpriced`.
export function resolveCost(usage: ExecutorUsage, table: PriceTable): ResolvedCost {
  if (usage.costUsd !== null) {
    return { costUsd: usage.costUsd, source: 'direct' };
  }
  const price = usage.model === null ? undefined : table[usage.model];
  if (!price) {
    return { costUsd: null, source: 'unpriced' };
  }
  const costUsd =
    (usage.inputTokens * price.inputPerMTok +
      usage.cachedInputTokens * price.cachedInputPerMTok +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000;
  return { costUsd, source: 'price-table' };
}

function fmtUsd(cost: number | null): string {
  return cost === null ? 'n/a (unpriced)' : `$${cost.toFixed(6)}`;
}

// Sum a set of records' costs, treating an `unpriced` (null) figure as a gap rather
// than zero: the total is reported alongside a count of uncosted calls so a missing
// price row never silently understates the run cost.
function sumCost(records: readonly CallUsage[]): { total: number; uncosted: number } {
  let total = 0;
  let uncosted = 0;
  for (const r of records) {
    if (r.costUsd === null) uncosted += 1;
    else total += r.costUsd;
  }
  return { total, uncosted };
}

// Render the per-run cost rollup (Markdown, F5). Two sections: per-node (per-outcome)
// attribution — each node's calls summed, by role — and the run total. Composed
// purely from the persisted per-call records, so it is a faithful projection of the
// evidence store, not a separate source of truth.
export function renderCostRollup(runId: string, records: readonly CallUsage[]): string {
  const lines: string[] = [`# cost rollup \`${runId}\``, ''];

  const run = sumCost(records);
  lines.push(
    `- Calls: ${records.length.toString()}`,
    `- Run total: ${fmtUsd(records.length === 0 ? null : run.total)}` +
      (run.uncosted > 0 ? `  (+${run.uncosted.toString()} uncosted call(s))` : ''),
    '',
    '## Per-node (per-outcome)',
  );

  if (records.length === 0) {
    lines.push('- (no model calls this run)');
  }

  const byNode = new Map<string, CallUsage[]>();
  for (const r of records) {
    const list = byNode.get(r.nodeId) ?? [];
    list.push(r);
    byNode.set(r.nodeId, list);
  }
  for (const nodeId of [...byNode.keys()].sort()) {
    const nodeRecords = byNode.get(nodeId) ?? [];
    const node = sumCost(nodeRecords);
    lines.push(
      `- \`${nodeId}\`: ${fmtUsd(node.total)}` +
        (node.uncosted > 0 ? `  (+${node.uncosted.toString()} uncosted)` : ''),
    );
    for (const r of nodeRecords) {
      lines.push(
        `  - [${r.role} #${r.seq.toString()}] ${r.provider}` +
          `${r.model === null ? '' : `/${r.model}`} ` +
          `in=${r.inputTokens.toString()} cached=${r.cachedInputTokens.toString()} ` +
          `out=${r.outputTokens.toString()} -> ${fmtUsd(r.costUsd)} (${r.costSource})`,
      );
    }
  }

  return lines.join('\n');
}
