// The code-owned orchestrator state machine: the loop that owns dispatch, every
// `.relay/` write, and the promotion / done-blocked transitions (design §3, §9).
// One OS process per active orchestrator (C6).
export { runOrchestrator, InjectedKill } from './orchestrator';
export type { RunOptions, OrchestratorResult, FaultPoint, ChildInjection } from './orchestrator';
export { stubExecutor } from './executor';
export type { Executor, ExecutorInput, ExecutorResult } from './executor';
export { stubCritic, scriptedCritic } from './critic';
export type { ScriptedCriticOptions } from './critic';
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
