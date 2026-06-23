// Structured cost rollup composed from the per-call usage records. The per-call
// `CallUsage` records are ground truth; this is their read-time
// projection into per-node (per-outcome) and per-run dollar sums. It writes
// nothing — it is a pure function of the records, deterministic code rather than a
// model judgment (Rule 5).
//
// This is the SINGLE source for the summing semantics: the Markdown cost rollup the
// orchestrator persists (`renderCostRollup`, spine/cost.ts) and the operator web
// view (`projectRun`, webview/projection.ts) both compose from this, so the two can
// never silently disagree on a node's burn or the run total.
//
// An `unpriced` call (a model with no price-table row, `costUsd === null`) is
// counted as a GAP — `uncosted` is incremented and the call is left out of the
// dollar sum — never folded in as $0. A silently-dropped cost reads as "cheaper
// than it was", so the gap is surfaced, not hidden (Rule 11).
import type { CallUsage } from './types';

// One node's attributed spend: the priced dollar total, the count of unpriced
// calls (the gap), and the node's calls in their input order. `total` is the sum
// of priced calls only; `uncosted > 0` means `total` understates real spend by
// that many calls.
export interface NodeCost {
  nodeId: string;
  total: number;
  uncosted: number;
  calls: CallUsage[];
}

// The whole-run rollup: the run-wide call count and priced total, the run-wide
// uncosted-call count, and the per-node breakdown sorted by node id (so the rollup
// renders identically across runs). `calls === 0` is a run that spent no model
// call — distinct from a run whose every call was priced at $0.
export interface RunCost {
  calls: number;
  total: number;
  uncosted: number;
  perNode: NodeCost[];
}

function sum(records: readonly CallUsage[]): { total: number; uncosted: number } {
  let total = 0;
  let uncosted = 0;
  for (const r of records) {
    if (r.costUsd === null) uncosted += 1;
    else total += r.costUsd;
  }
  return { total, uncosted };
}

// Compose the structured rollup from a run's per-call records. Pure and read-only.
// Records are grouped by node, the groups sorted by node id; each node's calls keep
// their input order (the caller passes them pre-sorted by node/role/seq via
// `readRunUsage`), so the projection is stable.
export function composeRunCost(records: readonly CallUsage[]): RunCost {
  const byNode = new Map<string, CallUsage[]>();
  for (const r of records) {
    const list = byNode.get(r.nodeId) ?? [];
    list.push(r);
    byNode.set(r.nodeId, list);
  }

  const perNode: NodeCost[] = [...byNode.keys()].sort().map((nodeId) => {
    const calls = byNode.get(nodeId) ?? [];
    const { total, uncosted } = sum(calls);
    return { nodeId, total, uncosted, calls };
  });

  const run = sum(records);
  return { calls: records.length, total: run.total, uncosted: run.uncosted, perNode };
}
