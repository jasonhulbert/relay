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
}

// The seam kinds (design §3.8, F3): each a typed contract with a code-checkable
// predicate. v0.1 persists the authored seam; the integration gate that verifies
// each kind deterministic-first is a later milestone (M10 concurrency).
export type SeamKind = 'interface' | 'http' | 'file-boundary' | 'data-schema';

// A seam contract between two children of one decomposed layer (design §3.8, A8,
// F3): the typed discriminated-union artifact the parent authors into `.relay/`,
// so a seam mismatch becomes a verifiable element of each child's outcome rather
// than a silent discovery after whole subtrees have been spent. The producer/
// consumer reference child node-ids within the layer; the seam graph these form is
// the structural fact the failure rule (§3.9) traverses and the integration gate
// (§3.8) checks.
export interface SeamContract {
  id: string;
  kind: SeamKind;
  // Child node-ids on each side of the seam (the producer publishes; the consumer
  // depends on what it publishes).
  producer: string;
  consumer: string;
  // The typed payload the kind's predicate checks. Free-form per kind in v0.1; the
  // typed-union payloads firm up with the integration gate (M10).
  payload: Record<string, unknown>;
  // Natural-language intent for the critic (F3).
  intent: string;
}

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
// human decision drives from the decision inbox (design §3.9, §3.11). Later
// milestones add quarantine.
export type NodeStatus = 'pending' | 'active' | 'done' | 'blocked' | 'cancelled';

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

// The root manifest (design §4). Describes the run and the root node; run-level
// rollups (cost-per-outcome, §8) attach here in later milestones.
export interface RootManifest {
  runId: string;
  rootId: string;
  spec: OutcomeSpec;
  // ISO-8601 creation timestamp.
  createdAt: string;
}
