// On-disk `.relay/` mechanics: node files, the root manifest, evidence refs, the
// human decision inbox, and the per-region write-ahead intent journal with
// idempotent roll-forward on rehydration. Code is the sole writer of `.relay/`.
// See docs/relay-spec.md for the architecture this implements.
// See docs/relay-state-layout.md for the conventions.
export type {
  McpServerConfig,
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
  Footprint,
  SeamKind,
  FileBoundaryPayload,
  InterfacePayload,
  SeamContract,
  LayerManifest,
  DecisionKind,
  DecisionRecord,
  Sketch,
  RootManifest,
  CallRole,
  CostSource,
  CallUsage,
} from './types';

export {
  relayPaths,
  assertSafeId,
  relativeManifestPath,
  relativeNodePath,
  relativeContractPath,
  relativeLayerPath,
  relativeUsagePath,
  relativeCostRollupPath,
  relativeRationalePath,
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
export { serializeLayer, deserializeLayer, readLayer, writeLayer, tryReadLayer } from './layer';
export { serializeUsage, deserializeUsage, writeUsage, readRunUsage } from './usage';
export { composeRunCost } from './cost-rollup';
export type { NodeCost, RunCost } from './cost-rollup';
export { commit, writeIntent, applyIntent, rollForwardPending, pendingIntents } from './journal';
export type { IntentWrite } from './journal';
export { serializeDecision, deserializeDecision, writeDecision, readInbox } from './inbox';
export { toCriticView, runCritic } from './projection';
export type { CriticView, CriticSpawn, CriticContext, CriticCallUsage } from './projection';
