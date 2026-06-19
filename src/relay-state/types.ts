// Durable `.relay/` record schema (design §4, §9.3). These types are the on-disk
// contract: a rehydrated orchestrator must be reconstitutable from them alone
// (the rehydration contract, §3.2), so every load-bearing fact lives here.
//
// Evidence-ref discipline (design §3.2, §4): nodes hold compact summaries and
// *refs* into the run-scoped evidence store — never inline transcripts or
// screenshots. That is why `EvidenceRef` carries a `path`/`summary` and there is
// no field anywhere below for raw transcript bytes; `selfReport` is a bounded
// narrative summary, not a transcript.

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
