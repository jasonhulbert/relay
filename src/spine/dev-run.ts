// The minimal dev run harness (operator-visibility over the files-only state model). It is
// the first path that runs the REAL orchestrator against a durable, inspectable
// store instead of a throwaway temp dir: resolve the user-global `.relay/` for the
// project, seed a root outcome, drive the real Claude executor (cheapest model by
// default — the cost guardrail), commit the store so it is `git log`-able, and
// print a recap that tells the operator exactly which files to read.
//
// Scope note: per-call `usage` is captured HERE by a thin recording
// wrapper so the recap can surface model/tokens/cost and the model default is
// assertable. Threading `usage` through the orchestrator into the evidence store
// with node-id attribution, the Codex price table, and the per-run rollups are
// not yet built — this harness does not write usage records into `.relay/`.
import { resolve } from 'node:path';
import { readRunUsage } from '../relay-state/index';
import type { CallUsage } from '../relay-state/index';
import type { Executor } from './executor';
import { runOrchestrator } from './orchestrator';
import type { OrchestratorResult, RunOptions } from './orchestrator';
import { agentCritic } from './agent-critic';
import type { AgentCriticOptions } from './agent-critic';
import { agentBrain } from './brain';
import type { AgentBrainOptions, Brain } from './brain';
import type { CriticSpawn } from '../relay-state/index';
import { seedFixture } from './seed';
import type { SeedOptions } from './seed';
import { commitStore, ensureProjectStore } from './relay-home';
import type { EnsureStoreOptions } from './relay-home';
// The provider executor builder and the operator recap renderer are shared verbatim
// with the `relay run` command; they live in run-support so both real-run entry
// points construct providers identically and emit an identical recap.
import { buildProviderExecutor, renderRecap } from './run-support';
import type { Provider } from './run-support';
import { resolveChildEntry } from './child-runtime';
import type { ChildRuntimeConfig } from './child-runtime';

export type { Provider } from './run-support';

export interface DevRunOptions {
  // The project the run is for; its absolute path keys the global store.
  projectPath: string;
  // The concrete outcome the executor must achieve (seeded onto the leaf).
  outcome: string;
  // Which provider drives the primary executor; defaults to Claude. The
  // swap-provider rung re-dispatches under the OTHER provider (cheapest model),
  // so a Codex run is observable through the same recap.
  provider?: Provider;
  // The leaf's command verification; defaults to an always-pass check so the
  // harness's happy path does not depend on a real test command existing yet.
  check?: string;
  // Override `~/.relay` (tests pass a temp dir).
  home?: string;
  // Per-role model override (the cost-guardrail knob). Omitted → the adapter's
  // cheapest default (`claude-haiku-4-5`).
  executorModel?: string;
  // Granted MCP servers to route into provider CLIs.
  mcpServers?: readonly import('../relay-state/index').McpServerConfig[];
  // Which provider renders the independent critic's verdict. Defaults
  // to the NOT-the-author provider, so the critic is cross-provider by default.
  criticProvider?: Provider;
  // Per-role cost-guardrail knob for the critic. Omitted → the critic provider's
  // cheapest default.
  criticModel?: string;
  // Which provider renders the orchestrator's own decompose/leaf-vs-branch judgment
  // (decompose/leaf-vs-branch). Defaults to the author (primary) provider — unlike the
  // critic, the brain is not required to be cross-provider.
  brainProvider?: Provider;
  // Per-role cost-guardrail knob for the brain. Omitted → the brain provider's
  // cheapest default.
  brainModel?: string;
  // The executor to drive. Defaults to the real Claude adapter; tests inject a
  // deterministic stand-in so the harness is exercisable without the CLI.
  executor?: Executor;
  // The critic to gate done-ness. Defaults to the real cross-provider agent critic
  // on a REAL run; tests inject a deterministic stand-in (and a test that injects
  // its own `executor` keeps the orchestrator's hermetic default critic).
  critic?: CriticSpawn;
  // The brain that decomposes a promoted/childless branch. Defaults to the real
  // agent brain on a REAL run; tests inject a deterministic stand-in (and a test
  // that injects its own `executor` keeps the orchestrator's hermetic stub brain).
  brain?: Brain;
  // Injected clock for the index's timestamps (deterministic tests).
  now?: () => string;
  // Recap sink; defaults to stdout.
  log?: (line: string) => void;
  // Evidence run id; defaults to `run-1`.
  runId?: string;
}

export interface DevRunResult {
  key: string;
  // The `.relay/` store root (== git repo root). Absolute, stable per project.
  storeDir: string;
  runId: string;
  result: OrchestratorResult;
  // The provider the independent critic ran (different from the author by default).
  criticProvider: Provider;
  // Node-attributed per-call usage records, read back from the persisted
  // evidence store. Spans executor, critic, and brain calls; sorted by node/role/seq.
  usages: CallUsage[];
  // The rendered recap (also written to `log`).
  recap: string;
  // Whether the end-of-run commit recorded anything.
  committed: boolean;
}

export async function devRun(opts: DevRunOptions): Promise<DevRunResult> {
  const log =
    opts.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const runId = opts.runId ?? 'run-1';

  // Build options conditionally (exactOptionalPropertyTypes: never pass an explicit
  // `undefined` for an optional field).
  const ensureOpts: EnsureStoreOptions = {};
  if (opts.home !== undefined) ensureOpts.home = opts.home;
  if (opts.now !== undefined) ensureOpts.now = opts.now;
  const store = await ensureProjectStore(opts.projectPath, ensureOpts);
  // The `.relay/` root IS the keyed store dir (git-trackable files-only state).
  const relayDir = store.storeDir;

  const seedOpts: SeedOptions = { runId, outcome: opts.outcome };
  if (opts.check !== undefined) seedOpts.check = opts.check;
  await seedFixture(relayDir, seedOpts);

  const provider: Provider = opts.provider ?? 'claude';
  // The provider the swap-provider rung re-dispatches under.
  const otherProvider: Provider = provider === 'claude' ? 'codex' : 'claude';
  // The independent critic is cross-provider by default: the not-the-author one.
  const criticProvider: Provider = opts.criticProvider ?? otherProvider;

  const executor = opts.executor ?? buildProviderExecutor(provider, opts.executorModel);
  const mcpServers = opts.mcpServers ?? [];

  const runOpts: RunOptions = {
    executor,
    // Worktrees are executor sandboxes, kept OUTSIDE the git-tracked store.
    workRoot: store.workRoot,
    // The operator's resolved absolute project path: the executor sandbox is seeded
    // from it on a real run, and the verified result lands back into it (a later step).
    projectPath: store.projectPath,
    mcpServers,
  };
  // The swap-provider rung dispatches under the OTHER provider at its cheapest
  // default (the per-role override raises only the primary). Skipped when a test
  // injects its own executor — it then owns the swap behavior too.
  if (opts.executor === undefined) {
    runOpts.swapExecutor = buildProviderExecutor(otherProvider);
  }
  // The real cross-provider critic gates done-ness. An explicit
  // injected critic wins; otherwise the real agent critic is wired only on a real
  // run (no injected executor), so a test injecting just an executor keeps the
  // orchestrator's hermetic default critic. Per-call usage is now persisted by the
  // orchestrator, node-attributed, and read back below for the recap — the
  // harness no longer captures it in-memory.
  if (opts.critic !== undefined) {
    runOpts.critic = opts.critic;
  } else if (opts.executor === undefined) {
    const criticOpts: AgentCriticOptions = { provider: criticProvider };
    if (opts.criticModel !== undefined) criticOpts.model = opts.criticModel;
    runOpts.critic = agentCritic(criticOpts);
  }
  // The orchestrator's own decompose/leaf-vs-branch judgment. An
  // injected brain wins; otherwise the real agent brain is wired only on a real run
  // (no injected executor), so a test injecting just an executor keeps the stub
  // brain. Its usage is persisted by the orchestrator like the others.
  if (opts.brain !== undefined) {
    runOpts.brain = opts.brain;
  } else if (opts.executor === undefined) {
    const brainOpts: AgentBrainOptions = { provider: opts.brainProvider ?? provider };
    if (opts.brainModel !== undefined) brainOpts.model = opts.brainModel;
    runOpts.brain = agentBrain(brainOpts);
  }
  if (opts.executor === undefined) {
    const childEntry = resolveChildEntry();
    const childRuntime: ChildRuntimeConfig = {
      projectPath: store.projectPath,
      workRoot: store.workRoot,
      provider,
      swapProvider: otherProvider,
      criticProvider,
      brainProvider: opts.brainProvider ?? provider,
      mcpServers,
      childEntry,
    };
    if (opts.executorModel !== undefined) childRuntime.executorModel = opts.executorModel;
    if (opts.criticModel !== undefined) childRuntime.criticModel = opts.criticModel;
    if (opts.brainModel !== undefined) childRuntime.brainModel = opts.brainModel;
    runOpts.childEntry = childEntry;
    runOpts.childRuntime = childRuntime;
  }

  const result = await runOrchestrator(relayDir, 'root', runOpts);

  // The per-call usage records the orchestrator persisted, node-attributed, read
  // back from the store (the recap is a faithful view of what was persisted, not an
  // in-memory side-channel).
  const usages = await readRunUsage(relayDir, runId);

  const recap = await renderRecap(
    relayDir,
    resolve(opts.projectPath),
    store.key,
    runId,
    result,
    usages,
  );

  // Commit so the store is `git log`-able (files-only state model). Done after the recap reads
  // the store, but the recap content does not depend on the commit.
  const committed = await commitStore(relayDir, `relay run ${runId}: root ${result.rootStatus}`);

  log(recap);

  return {
    key: store.key,
    storeDir: relayDir,
    runId,
    result,
    criticProvider,
    usages,
    recap,
    committed,
  };
}
