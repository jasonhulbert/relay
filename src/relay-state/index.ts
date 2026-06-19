// On-disk `.relay/` mechanics: node files, the root manifest, evidence refs, the
// human decision inbox, and the per-region write-ahead intent journal with
// idempotent roll-forward on rehydration (design §4, §9.3). Code is the sole
// writer of `.relay/` (C2). See docs/relay-state-layout.md for the conventions.
export type {
  NodeKind,
  NodeStatus,
  VerificationKind,
  Verification,
  OutcomeSpec,
  EvidenceRef,
  CriticVerdict,
  BlockedRecord,
  NodeRecord,
  OutcomeContract,
  DecisionKind,
  DecisionRecord,
  RootManifest,
} from './types';

export {
  relayPaths,
  assertSafeId,
  relativeManifestPath,
  relativeNodePath,
  relativeContractPath,
} from './paths';
export type { RelayPaths } from './paths';
export { atomicWriteFile, fsyncDir } from './io';
export { serializeFrontmatter, parseFrontmatter } from './frontmatter';
export { serializeNode, deserializeNode, readNode, writeNode } from './node';
export { serializeManifest, deserializeManifest, readManifest, writeManifest } from './manifest';
export {
  serializeContract,
  deserializeContract,
  readContract,
  writeContract,
  tryReadContract,
} from './contract';
export { commit, writeIntent, applyIntent, rollForwardPending, pendingIntents } from './journal';
export type { IntentWrite } from './journal';
export { serializeDecision, deserializeDecision, writeDecision, readInbox } from './inbox';
export { toCriticView, runCritic } from './projection';
export type { CriticView, CriticSpawn } from './projection';
