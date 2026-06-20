// Field-projection chokepoint (C7, design §3.6, §4, §9.3). The executor's
// self-report is INADMISSIBLE as evidence of done: a confident narrative sets the
// frame and launders fluency into evidence, and no instruction reliably undoes
// that. So the narrative is withheld *structurally*, not by prompting.
//
// The `.relay/` node record is field-partitioned into two audiences:
//   - orchestrator-visible: self-report + learnings (admissible as learning);
//   - critic-visible: spec + diff + evidence refs only.
//
// This module is the single enforcement point:
//   1. `toCriticView` is the ONE constructor of the critic-visible projection;
//   2. `CriticView` is a branded type — a structurally-identical plain object is
//      NOT a `CriticView`, so the only way to obtain one is through (1);
//   3. `runCritic` (the critic-spawn path) accepts ONLY a `CriticView`, so a raw
//      node record cannot be handed to a critic;
//   4. a property test asserts the constructed view carries no narrative field.
//
// If a critic could read the whole record, the integrity leak silently reopens.
import type { CriticVerdict, EvidenceRef, McpServerConfig, NodeRecord, OutcomeSpec } from './types';

// A per-call usage observation a critic emits for F5 attribution (design §8). It is
// pure instrumentation — write-only telemetry the orchestrator persists keyed by the
// graded node — and carries NOTHING into the critic, so it cannot reopen the C7 leak
// (the projection is still spec + diff + evidence only). Kept structurally identical
// to the executor's `ExecutorUsage` without importing the spine, so relay-state stays
// the lower layer.
export interface CriticCallUsage {
  provider: string;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  costUsd: number | null;
}

// Phantom brand. Module-private and never exported, so no other module can name
// it to forge a `CriticView`; the value is never set at runtime (it is a
// type-level marker only).
declare const criticViewBrand: unique symbol;

// The critic-visible projection. Carries spec + diff + evidence refs and nothing
// else — structurally no narrative field exists to leak.
export interface CriticView {
  readonly spec: OutcomeSpec;
  readonly diff: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly [criticViewBrand]: true;
}

// The one constructor (C7). Copies only the critic-admissible fields off the
// node record; `selfReport` and `learnings` are never read here, so they cannot
// ride into the critic's context. `diff` is the executor's produced change — the
// critic's evidence — passed alongside, never sourced from the narrative.
export function toCriticView(node: NodeRecord, diff: string): CriticView {
  const view = {
    spec: node.spec,
    diff,
    evidenceRefs: node.evidenceRefs.slice(),
  };
  // The brand is a phantom (never set at runtime), so the object is exactly
  // {spec, diff, evidenceRefs} — pinned by the property test. Minting the brand
  // requires crossing through `unknown`; this single line is the only place a
  // `CriticView` is constructed, which is precisely the chokepoint.
  return view as unknown as CriticView;
}

// The non-evidentiary execution context a critic-spawn is granted alongside the
// projection (design §3.6, §3.252, C9). It is deliberately SEPARATE from the
// `CriticView`: nothing here is graded as evidence, so none of it can launder the
// narrative back in (the C7 property test still pins the view to spec + diff +
// evidence). It carries only what an independent critic needs to *act* — the
// produced-change worktree it runs its declared verification kinds against, and
// the granted MCP servers it may use to capture its own evidence. The orchestrator
// grants `mcpServers` to the critic exactly as it does the executor; the real
// code-owned MCP loop that populates it is Phase 5 (today it is empty).
export interface CriticContext {
  // The executor's produced-change worktree — the critic's evidence, the same
  // change the diff captured. NOT the orchestrator's `.relay/` (which carries the
  // narrative the critic must never read).
  readonly worktree: string;
  readonly mcpServers: readonly McpServerConfig[];
  // Optional F5 usage sink: the orchestrator supplies it at the call site (where it
  // knows the graded node), and the critic emits its model call's usage into it for
  // node-attributed persistence (design §8). Absent on the stub path and in direct
  // unit calls.
  readonly onUsage?: (usage: CriticCallUsage) => void;
}

// The independent critic itself (a separate agent, different provider by
// default, §3.6). Provided by the spine; here we only fix its signature. It is
// handed the restricted `CriticView` plus the non-evidentiary `CriticContext`; a
// critic that needs neither (the stubs) simply ignores the extra parameter.
export type CriticSpawn = (view: CriticView, ctx: CriticContext) => Promise<CriticVerdict>;

// The critic-spawn path. Accepts ONLY a branded `CriticView`, so a `NodeRecord`
// — which still carries the narrative — cannot be passed (enforced at the type
// level; see projection.test.ts). This is the runtime chokepoint the design
// requires: the critic is handed the restricted projection, never the record. The
// `ctx` rides alongside but is never evidence, so it cannot reopen the leak.
export async function runCritic(
  spawn: CriticSpawn,
  view: CriticView,
  ctx: CriticContext,
): Promise<CriticVerdict> {
  return spawn(view, ctx);
}
