// The code-owned orchestrator state machine: the loop that owns dispatch, every
// `.relay/` write, and the promotion / done-blocked transitions (design §3, §9).
// One OS process per active orchestrator (C6).
export { runOrchestrator, InjectedKill } from './orchestrator';
export type { RunOptions, OrchestratorResult, FaultPoint } from './orchestrator';
export { stubExecutor } from './executor';
export type { Executor, ExecutorInput, ExecutorResult } from './executor';
export { stubCritic } from './critic';
export { seedFixture } from './seed';
export type { SeedOptions, SeedResult } from './seed';
