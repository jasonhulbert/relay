// Durable `.relay/` record schema (design §4, §9.3). These types are the on-disk
// contract: a rehydrated orchestrator must be reconstitutable from them alone
// (the rehydration contract, §3.2), so every load-bearing fact lives here.
//
// Evidence-ref discipline (design §3.2, §4): nodes hold compact summaries and
// *refs* into the run-scoped evidence store — never inline transcripts or
// screenshots. That is why `EvidenceRef` carries a `path`/`summary` and there is
// no field anywhere below for raw transcript bytes; `selfReport` is a bounded
// narrative summary, not a transcript.

// A granted MCP server the spine mediates into a model's judgment (C9, design
// §3.6, §9.4). The orchestrator grants the same shape to BOTH the executor and the
// critic — the critic needs tools too (e.g. a Surface server to reach the app for a
// visual outcome). A pure capability descriptor, so it lives with the durable
// types rather than the executor adapter; `spine/executor.ts` re-exports it for the
// adapters. The real code-owned MCP tool loop that populates a grant is Phase 5;
// the type rides the contracts now so the executor and critic surfaces are stable.
export interface McpServerConfig {
  name: string;
  // The stdio command (and args) the spine launches as the MCP server.
  command: string;
  args?: string[];
}

// A child's resource footprint (design §3.8, A3): the resources it is predicted to
// touch, pinned by the decomposing orchestrator at decomposition. It schedules
// sibling concurrency (A2) and grounds the `file-boundary` seam predicate against
// the intent-journal footprint — it is a hint, not a sandbox, allowed to be wrong
// and corrected by execution exactly like leaf-sizing. v0.1 pins the load-bearing
// resource — the repo-relative write globs — and leaves the ports/services/session
// resources for when concurrency lands (M10); persisting the footprint now is part
// of what "decomposing a layer" produces (§3.3).
export interface Footprint {
  // Repo-relative globs the child is expected to write (A8 file-boundary).
  writeGlobs: string[];
  // Named non-file resources the child contends on — ports, services, and the
  // shared tier-A session a visual leaf drives (design §7.3, M10 Phase 4). Two
  // footprints that name a common resource are NOT disjoint, so the scheduler
  // serializes them even when their write globs never collide (A2): two visual
  // leaves both holding the tier-A session cannot run concurrently. Absent ⇒ the
  // child contends on no named resource (the pre-concurrency default).
  resources?: readonly string[];
}

// The seam kinds (design §3.8, F3): each a typed contract with a code-checkable
// predicate. v0.1 ships the two code-checkable kinds — `file-boundary` and
// `interface` (M10); `http` and `data-schema` are deferred (§13) and have no v0.1
// predicate, so the scheduler treats them as uncheckable and serializes around them.
export type SeamKind = 'interface' | 'http' | 'file-boundary' | 'data-schema';

// The `file-boundary` seam payload (F3, M10): the repo-relative write globs each
// side of the seam claims. The predicate (`spine/seam.ts`) passes iff the two glob
// sets are disjoint — the same disjointness (`footprintsDisjoint`) that licenses the
// two children's concurrency (A2) is what this seam pins as their contract.
export interface FileBoundaryPayload {
  producerGlobs: string[];
  consumerGlobs: string[];
}

// The `interface` seam payload (F3, M10): the producer publishes a named symbol/type
// the consumer depends on. The predicate does a syntactic AST lookup over the
// producer's source: it passes iff the symbol is exported, and — when `signature` is
// present — iff that symbol's declared signature matches it (normalized comparison).
export interface InterfacePayload {
  // The exported symbol/type the consumer depends on the producer publishing.
  symbol: string;
  // The signature the producer's symbol must match (normalized). Absent ⇒ the
  // predicate checks only that the symbol is exported (a named-type seam).
  signature?: string;
  // Repo-relative module the symbol is published in; the integration gate reads it
  // to locate the producer source for the AST lookup.
  module?: string;
}

// A seam contract between two children of one decomposed layer (design §3.8, A8,
// F3): the typed discriminated-union artifact the parent authors into `.relay/`,
// so a seam mismatch becomes a verifiable element of each child's outcome rather
// than a silent discovery after whole subtrees have been spent. The producer/
// consumer reference child node-ids within the layer; the seam graph these form is
// the structural fact the failure rule (§3.9) traverses and the integration gate
// (§3.8) checks. The `kind` discriminates the `payload`: the two code-checkable
// kinds carry a typed payload their predicate reads; the deferred kinds keep a
// free-form payload until their predicates land.
interface SeamContractCommon {
  id: string;
  // Child node-ids on each side of the seam (the producer publishes; the consumer
  // depends on what it publishes).
  producer: string;
  consumer: string;
  // Natural-language intent for the critic (F3).
  intent: string;
}

export type SeamContract =
  | (SeamContractCommon & { kind: 'file-boundary'; payload: FileBoundaryPayload })
  | (SeamContractCommon & { kind: 'interface'; payload: InterfacePayload })
  | (SeamContractCommon & { kind: 'http' | 'data-schema'; payload: Record<string, unknown> });

// The child-manifest of the one layer a branch decomposed (design §4, §3.8). The
// orchestrator is its sole writer; it records the layer's structural facts beyond
// the child node files — each child's resource footprint and the seam graph
// between the children — and is committed in the SAME atomic transaction as the
// children themselves (C8), so rehydration never sees a layer whose footprints or
// seams disagree with its child nodes.
export interface LayerManifest {
  // The branch node whose decomposed children this layer describes.
  parentId: string;
  runId: string;
  // Per-child footprint, keyed by child node-id.
  footprints: Record<string, Footprint>;
  // The seams between the children (A8); empty when the layer has no cross-child
  // interface to pin.
  seams: SeamContract[];
}

export type NodeKind = 'branch' | 'leaf';

// Node lifecycle. M1 drives a leaf pending -> active -> done; `blocked` is the
// terminal exhaustion state (design §3.7) and `cancelled` is the terminal state a
// human decision (or the unified failure rule cancelling a seam-dependent) drives
// (design §3.9, §3.11). `quarantine` is the terminal state of seam-INDEPENDENT
// in-flight work the unified failure rule drained to completion when a sibling
// failed (design §3.9, §4, M10 Phase 4): its work is banked and reusable, but
// flagged un-integrated — it never witnessed the merged whole, so it is not `done`.
export type NodeStatus = 'pending' | 'active' | 'done' | 'blocked' | 'cancelled' | 'quarantine';

// Verification kinds, cheapest-first (design §6.3). M1 exercises `command`.
export type VerificationKind =
  | 'command'
  | 'test'
  | 'artifact'
  | 'structural'
  | 'visual'
  | 'agent-critic'
  | 'human';

export interface Verification {
  kind: VerificationKind;
  // Explicit grounding: a verdict citing no evidence artifact is rejected (§6).
  grounding: string;
  // The runnable check — e.g. the command line for kind `command`.
  check: string;
}

export interface OutcomeSpec {
  // The verifiable outcome statement the critic grades against (§3.6, §6).
  outcome: string;
  // At least one verification with explicit grounding (§6). Not enforced at the
  // type level (an empty array is representable); seed/decomposition guarantees it.
  verifications: Verification[];
}

// A reference into `.relay/evidence/<runId>/`. Holds the pointer and a short
// summary, never the artifact's content (evidence-ref discipline).
export interface EvidenceRef {
  runId: string;
  // Path relative to the run's evidence directory.
  path: string;
  kind: 'diff' | 'self-report' | 'transcript' | 'screenshot' | 'cost' | 'verdict';
  summary: string;
}

// The independent critic's verdict (design §3.6). Graded against the
// critic-visible projection only (spec + diff + evidence); see projection.ts.
export interface CriticVerdict {
  pass: boolean;
  // Critic provider — different from the author by default (§3.6).
  provider: string;
  rationale: string;
  evidenceRefs: EvidenceRef[];
}

// Self-sufficient exhaustion summary for a terminal-blocked node (design §3.7):
// authored so a fresh orchestrator decides "do not re-run the ladder" in one
// read, and a human can act on it via the decision inbox.
export interface BlockedRecord {
  reason: string;
  // Which ladder rungs were spent (retried xN, providers swapped, tiers raised).
  rungsSpent: string[];
  // The critic's standing reason for non-acceptance.
  criticReason: string;
  // The human-facing "here's what's wrong".
  humanFacing: string;
}

// One node in the durable tree (design §4). Field-partitioned into an
// orchestrator-visible audience (`selfReport` + `learnings`) and a critic-visible
// audience (`spec` + diff + `evidenceRefs`); the split is enforced structurally
// at the projection chokepoint (C7), never by prompting. See projection.ts.
export interface NodeRecord {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus;
  spec: OutcomeSpec;
  // Child node ids of the one decomposed layer; empty for a leaf (design §3.3).
  children: string[];
  // Orchestrator-visible narrative — NEVER admissible to the critic (C7, §3.6).
  selfReport: string | null;
  learnings: string[];
  verdict: CriticVerdict | null;
  // Refs only; transcripts/screenshots live in the evidence store (§4).
  evidenceRefs: EvidenceRef[];
  blocked: BlockedRecord | null;
}

// The verified outcome contract a sub-orchestrator hands up to its parent (A7,
// design §3.6, §3.8, §9.2). Across an orchestrator-process boundary there is no
// single merged diff to run a critic over, so the child returns this instead: the
// outcome it claims, the structural `.relay/` fact that its own critic gate
// certified it (read from the ledger, never its narrative), and the seam evidence
// the parent's integration gate needs to verify *composition*. The parent trusts
// the structural critic-certified fact; it does not re-verify the child's
// internals. Written into the child's own region; read by the parent.
export interface OutcomeContract {
  // The sub-orchestrator node-id this contract is for, and its run.
  nodeId: string;
  runId: string;
  // The outcome the sub-orchestrator claims it achieved (its spec outcome).
  claimedOutcome: string;
  // The structural critic-certified fact: this subtree reached `done` only via a
  // critic-pass transaction (§3.6, certified turtles-all-the-way-up). True is the
  // only admissible value for a `done` contract; the parent gates on it.
  criticCertified: boolean;
  // Refs to the certifying critic verdict(s) in the evidence store — the ledger
  // fact, not the child's say-so. Empty would mean "uncertified".
  verdictRefs: EvidenceRef[];
  // Seam evidence the parent needs to verify composition (A7/A8). Placeholder in
  // M2 — the typed seam union (F3) lands in a later milestone; the field is
  // present now so the contract shape is stable.
  seamEvidence: EvidenceRef[];
}

// The role an agent played in a call whose usage we attribute (F5, design §8).
// Every real model call in the loop is one of these three: the leaf executor, the
// independent critic, or the orchestrator brain's decompose judgment.
export type CallRole = 'executor' | 'critic' | 'brain';

// How a call's dollar figure was obtained (F5, design §8): the provider reported it
// directly (Claude `total_cost_usd`), it was derived from the local price table
// (Codex token counts), or no figure could be produced (no price row for the model).
export type CostSource = 'direct' | 'price-table' | 'unpriced';

// One model call's usage, attributed to the node it served (F5, design §8). Tokens
// are ground truth; `costUsd` is the resolved dollar figure (direct or price-table-
// derived) with `costSource` recording which. A raw per-call record in the run's
// evidence store, keyed by node-id + role + sequence; the per-run rollup is composed
// from these (a read-time projection, never a shared write target — design §4).
export interface CallUsage {
  runId: string;
  nodeId: string;
  role: CallRole;
  // Monotonic per (node, role): for executor/critic it is the escalation-ladder
  // attempt number; for the brain it is 0 (one decompose call per node). Ties the
  // record to the attempt that produced it and keeps re-dispatch idempotent.
  seq: number;
  provider: string;
  model: string | null;
  // Uncached input tokens.
  inputTokens: number;
  // Input tokens served through the prompt cache.
  cachedInputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  // Resolved dollar cost: provider-reported (`direct`) or price-table-derived
  // (`price-table`); `null` when neither is available (`unpriced`).
  costUsd: number | null;
  costSource: CostSource;
}

// A human decision queued in the decision inbox (I4, design §3.11). The inbox is
// a human-OWNED region: the human writes decisions into it and the orchestrator
// only reads and drains them at activation, applying each as an atomic transition
// within its own node region (never mutating the inbox — sole-writer ownership
// holds at both ends). `cancel` is the lone decision kind in M3 (serial-form
// cancellation); budget adjustments and gate approvals are later milestones.
export type DecisionKind = 'cancel';

export interface DecisionRecord {
  // Stable id, unique within the inbox; also the inbox filename stem. The
  // orchestrator never rewrites the inbox, so idempotency on re-drain comes from
  // the target node's own terminal status, not from removing this file.
  decisionId: string;
  kind: DecisionKind;
  // The node this decision acts on. The orchestrator applies only decisions whose
  // target is a node it owns (its branch or an in-process leaf child); a decision
  // for a sub-orchestrator's node is drained by that child's own process.
  targetNodeId: string;
  // Optional human note, folded into the cancellation reflection persisted to the
  // node before its worktree is discarded (the keep-lesson pattern, §3.5/§3.9).
  note: string | null;
}

// The non-binding high-level sketch the intake compiler captures (design §3.3,
// §3.11, I2): free-form orientation bullets that point a run the right way at
// commit time. It is deliberately NOT a `Decomposition` — it carries no child
// specs, footprints, or seams — so it is structurally incapable of being a binding
// plan. The orchestrator's brain owns decomposition and is free to diverge from
// the sketch entirely (orientation, allowed to be wrong, never a contract). It
// lives here, with the durable record schema, because the committed root carries
// it in the manifest; the intake module re-exports it.
export interface Sketch {
  notes: string[];
}

// The root manifest (design §4). Describes the run and the root node; run-level
// rollups (cost-per-outcome, §8) attach here in later milestones.
export interface RootManifest {
  runId: string;
  rootId: string;
  spec: OutcomeSpec;
  // The non-binding orientation sketch the intake compiler committed with the root
  // (design §3.11, M6). Present on every root: a hand-seeded fixture carries an
  // empty one; intake carries what the conversation distilled. Never a binding
  // decomposition (its `Sketch` shape cannot encode one).
  sketch: Sketch;
  // ISO-8601 creation timestamp.
  createdAt: string;
}
