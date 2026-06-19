// The code-owned orchestrator state machine: the loop that owns dispatch, every
// `.relay/` write, and the promotion / done-blocked transitions (design §3, §9).
// One OS process per active orchestrator (C6).
export { runOrchestrator, InjectedKill } from './orchestrator';
export type { RunOptions, OrchestratorResult, FaultPoint, ChildInjection } from './orchestrator';
export { stubExecutor, scriptedExecutor, stubCapabilities, STUB_USAGE } from './executor';
export type {
  Executor,
  ExecutorInput,
  ExecutorResult,
  ExecutorContext,
  ExecutorUsage,
  ExecutorCapabilities,
  McpServerConfig,
  ScriptedExecutorOptions,
} from './executor';
// The Claude executor adapter (M4 Phase 1): the first real provider behind the
// uniform contract. Codex follows in Phase 2.
export {
  claudeExecutor,
  parseClaudeStream,
  buildExecutorPrompt,
  buildClaudeArgs,
  DEFAULT_CLAUDE_MODEL,
} from './adapters/claude';
export type { ClaudeAdapterOptions, ParsedClaudeStream } from './adapters/claude';
export { stubCritic, scriptedCritic } from './critic';
export type { ScriptedCriticOptions } from './critic';
// Promotion re-decomposition (design §3.9): the deterministic stub a promoted
// leaf's new branch children are seeded from; model-driven decomposition is M4.
export { stubDecompose } from './decompose';
export type { Decompose } from './decompose';
// The escalation ladder + budget rails (design §3.7, §3.9): the bounded
// verdict-handling machine a failing leaf walks before terminal `blocked`.
export { EscalationLadder, LADDER_RUNGS } from './ladder';
export type { Rung, AttemptSignal, LadderStep, ExhaustionReason } from './ladder';
export { capReached, checkGate, defaultGateConfig, GateRefusal } from './rails';
export type { RailUsage, RailCaps, CapKind, GatedAction, GateConfig } from './rails';
export { defaultSpawnChild } from './child-runner';
export type { SpawnChild, ChildSpawnInput, ChildSpawnResult } from './child-runner';
export { seedFixture, seedHierarchy } from './seed';
export type { SeedOptions, SeedResult, HierarchySeedResult } from './seed';
// The user-global relay store resolver (M4 Phase 2, design §4): real runs persist
// to a stable, per-project, `git init`'d `.relay/` under `~/.relay/`.
export {
  relayHome,
  projectKey,
  readProjectIndex,
  ensureProjectStore,
  commitStore,
} from './relay-home';
export type {
  RelayHomeOptions,
  ProjectIndex,
  ProjectIndexEntry,
  ProjectStore,
  EnsureStoreOptions,
} from './relay-home';
// The dev run harness (M4 Phase 2): the first operator-visible REAL run.
export { devRun } from './dev-run';
export type { DevRunOptions, DevRunResult } from './dev-run';
