// The code-owned orchestrator state machine: the loop that owns dispatch, every
// `.relay/` write, and the promotion / done-blocked transitions.
// One OS process per active orchestrator.
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
// The Claude executor adapter: the first real provider behind the
// uniform contract. Codex follows.
export {
  claudeExecutor,
  parseClaudeStream,
  buildExecutorPrompt,
  buildClaudeArgs,
  DEFAULT_CLAUDE_MODEL,
} from './adapters/claude';
export type { ClaudeAdapterOptions, ParsedClaudeStream } from './adapters/claude';
// The Codex executor adapter: the second real provider behind the
// uniform contract, which the swap-provider rung switches to on failure.
export {
  codexExecutor,
  parseCodexStream,
  buildCodexArgs,
  DEFAULT_CODEX_MODEL,
} from './adapters/codex';
export type { CodexAdapterOptions, ParsedCodexStream } from './adapters/codex';
export { stubCritic, scriptedCritic } from './critic';
export type { ScriptedCriticOptions } from './critic';
// The real cross-provider critic: the independent agent that grades
// done-ness on the evidence-only projection + the deterministic verification kinds, on a
// different provider than the author by default.
export { agentCritic, buildCriticPrompt, parseCriticVerdict } from './agent-critic';
export type {
  AgentCriticOptions,
  CriticProvider,
  CriticInvocation,
  CriticInvocationResult,
} from './agent-critic';
// The deterministic verification kinds: code-checkable
// command/test/artifact predicates the critic grounds its verdict on (Rule 5).
export { runVerification, runDeterministicVerifications, isDeterministicKind } from './verify';
export type { VerificationResult } from './verify';
// The visual critic bridge: the `visual`-kind gate that
// replays the semantic-action path against a live Surface, grades at the declared
// match-granularity, and captures-and-promotes a baseline on a structural-or-better
// pass — the visual subsystem wired into the loop's critic path.
export { visualCritic, parseVisualCheck } from './visual-critic';
export type { VisualCriticOptions } from './visual-critic';
// The orchestrator brain: the model judgment for
// decomposing a layer (children + footprints + seams) and classifying each child
// leaf-vs-branch. `stubBrain` is the deterministic default for the spine tests;
// `agentBrain` is the real provider judgment connected to the granted MCP servers.
export {
  stubBrain,
  agentBrain,
  buildDecomposePrompt,
  buildBrainArgs,
  parseDecomposition,
} from './brain';
export type {
  Brain,
  BrainProvider,
  BrainContext,
  DecomposeRequest,
  Decomposition,
  DecomposeResult,
  ChildPlan,
  SeamPlan,
  AgentBrainOptions,
  BrainInvocation,
  BrainInvocationResult,
} from './brain';
// The sibling scheduler: builds the dispatch
// schedule from the concurrency law — disjoint footprints run parallel, a shared
// resource serializes.
export { buildSchedule, mayRunConcurrently } from './schedule';
export type { Schedule } from './schedule';
// Footprint primitives: disjointness for the
// scheduler, escape detection for the loud-violation catch, and the violation the
// ladder absorbs.
export {
  footprintsDisjoint,
  footprintEscapes,
  globsIntersect,
  FootprintViolation,
  TIER_A_SESSION,
} from './footprint';
// The unified failure rule's structural core: the
// seam-graph partition that decides cancel (seam-dependent) vs drain (seam-independent).
export { partitionBySeam } from './failure-rule';
export type { SeamPartition } from './failure-rule';
// The escalation ladder + budget rails: the bounded
// verdict-handling machine a failing leaf walks before terminal `blocked`.
export { EscalationLadder, LADDER_RUNGS } from './ladder';
export type { Rung, AttemptSignal, LadderStep, ExhaustionReason } from './ladder';
export { capReached, checkGate, defaultGateConfig, GateRefusal } from './rails';
export type { RailUsage, RailCaps, CapKind, GatedAction, GateConfig } from './rails';
export { defaultSpawnChild } from './child-runner';
export type { SpawnChild, ChildSpawnInput, ChildSpawnResult } from './child-runner';
export {
  CHILD_ENTRY_BUNDLE,
  resolveChildEntry,
  runOptionsFromChildRuntime,
} from './child-runtime';
export type { ChildRuntimeConfig, ResolveChildEntryOptions } from './child-runtime';
export { seedFixture, seedHierarchy } from './seed';
export type { SeedOptions, SeedResult, HierarchySeedResult } from './seed';
// The user-global relay store resolver: real runs persist
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
// The dev run harness: the first operator-visible REAL run.
export { devRun } from './dev-run';
export type { DevRunOptions, DevRunResult, Provider } from './dev-run';
// Shared real-run scaffolding: the per-role provider executor builder and the
// operator recap renderer, reused verbatim by the `relay run` command so it
// constructs providers and renders its recap identically to `dev-run`.
export { buildProviderExecutor, renderRecap } from './run-support';
