// Serializable runtime wiring for spawned sub-orchestrators. A child process
// cannot receive injected function objects, so production entry points pass this
// compact config and the child reconstructs real provider adapters from it.
import { dirname, join, resolve } from 'node:path';
import type { McpServerConfig } from '../relay-state/index';
import { agentCritic } from './agent-critic';
import type { AgentCriticOptions } from './agent-critic';
import { agentBrain, stubBrain } from './brain';
import type { AgentBrainOptions, Brain } from './brain';
import type { CriticSpawn } from '../relay-state/index';
import { stubExecutor } from './executor';
import type { Executor } from './executor';
import type { RunOptions } from './orchestrator';
import { stubCritic } from './critic';
import { buildProviderExecutor } from './run-support';
import type { Provider } from './run-support';

export const CHILD_ENTRY_BUNDLE = 'child-entry.cjs';

export interface ChildRuntimeConfig {
  projectPath: string;
  workRoot: string;
  provider: Provider;
  executorModel?: string;
  swapProvider: Provider;
  swapModel?: string;
  criticProvider: Provider;
  criticModel?: string;
  brainProvider: Provider;
  brainModel?: string;
  mcpServers: readonly McpServerConfig[];
  childEntry: string;
  // Test-only process-boundary seam: lets a spawned child use deterministic
  // providers without serializing function objects. Production configs omit it.
  testMode?: 'stub-providers';
}

export interface ResolveChildEntryOptions {
  env?: NodeJS.ProcessEnv;
  runningEntry?: string;
}

export function resolveChildEntry(opts: ResolveChildEntryOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.RELAY_CHILD_ENTRY) return env.RELAY_CHILD_ENTRY;
  const runningEntry = opts.runningEntry ?? process.argv[1] ?? join(process.cwd(), 'dist/index.js');
  return join(dirname(resolve(runningEntry)), CHILD_ENTRY_BUNDLE);
}

interface RuntimeFactories {
  executor?: (provider: Provider, model?: string) => Executor;
  critic?: (opts: AgentCriticOptions) => CriticSpawn;
  brain?: (opts: AgentBrainOptions) => Brain;
}

export function runOptionsFromChildRuntime(
  runtime: ChildRuntimeConfig,
  factories: RuntimeFactories = {},
): RunOptions {
  const buildExecutor = factories.executor ?? buildProviderExecutor;
  const buildCritic = factories.critic ?? agentCritic;
  const buildBrain = factories.brain ?? agentBrain;
  if (runtime.testMode === 'stub-providers') {
    return {
      executor: stubExecutor,
      swapExecutor: stubExecutor,
      critic: stubCritic,
      brain: stubBrain,
      workRoot: runtime.workRoot,
      projectPath: runtime.projectPath,
      mcpServers: runtime.mcpServers,
      childEntry: runtime.childEntry,
      childRuntime: runtime,
    };
  }

  const criticOpts: AgentCriticOptions = { provider: runtime.criticProvider };
  if (runtime.criticModel !== undefined) criticOpts.model = runtime.criticModel;
  const brainOpts: AgentBrainOptions = { provider: runtime.brainProvider };
  if (runtime.brainModel !== undefined) brainOpts.model = runtime.brainModel;

  const runOpts: RunOptions = {
    executor: buildExecutor(runtime.provider, runtime.executorModel),
    swapExecutor: buildExecutor(runtime.swapProvider, runtime.swapModel),
    critic: buildCritic(criticOpts),
    brain: buildBrain(brainOpts),
    workRoot: runtime.workRoot,
    projectPath: runtime.projectPath,
    mcpServers: runtime.mcpServers,
    childEntry: runtime.childEntry,
    childRuntime: runtime,
  };
  return runOpts;
}
