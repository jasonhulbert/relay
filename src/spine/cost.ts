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
import { composeRunCost } from '../relay-state/index';
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

// Render the per-run cost rollup (Markdown, F5). Two sections: per-node (per-outcome)
// attribution — each node's calls summed, by role — and the run total. Composed from
// the structured `composeRunCost` projection of the persisted per-call records, the
// SAME projection the operator web view renders, so the Markdown and the view can
// never disagree on a node's burn or the run total. It is a faithful projection of
// the evidence store, not a separate source of truth.
export function renderCostRollup(runId: string, records: readonly CallUsage[]): string {
  const rollup = composeRunCost(records);
  const lines: string[] = [`# cost rollup \`${runId}\``, ''];

  lines.push(
    `- Calls: ${rollup.calls.toString()}`,
    `- Run total: ${fmtUsd(rollup.calls === 0 ? null : rollup.total)}` +
      (rollup.uncosted > 0 ? `  (+${rollup.uncosted.toString()} uncosted call(s))` : ''),
    '',
    '## Per-node (per-outcome)',
  );

  if (rollup.calls === 0) {
    lines.push('- (no model calls this run)');
  }

  for (const node of rollup.perNode) {
    lines.push(
      `- \`${node.nodeId}\`: ${fmtUsd(node.total)}` +
        (node.uncosted > 0 ? `  (+${node.uncosted.toString()} uncosted)` : ''),
    );
    for (const r of node.calls) {
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
