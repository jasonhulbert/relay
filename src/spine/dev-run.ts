// The minimal dev run harness (design §4 operator-visibility; M4 Phase 2). It is
// the first path that runs the REAL orchestrator against a durable, inspectable
// store instead of a throwaway temp dir: resolve the user-global `.relay/` for the
// project, seed a root outcome, drive the real Claude executor (cheapest model by
// default — the cost guardrail), commit the store so it is `git log`-able, and
// print a recap that tells the operator exactly which files to read.
//
// Scope note (M4 staging): per-call `usage` is captured HERE by a thin recording
// wrapper so the recap can surface model/tokens/cost and the model default is
// assertable. Threading `usage` through the orchestrator into the evidence store
// with node-id attribution, the Codex price table, and the per-run rollups are
// Phase 6 — this harness does not write usage records into `.relay/`.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { relayPaths, readNode, readRunUsage } from '../relay-state/index';
import type { CallUsage } from '../relay-state/index';
import type { Executor } from './executor';
import { claudeExecutor } from './adapters/claude';
import type { ClaudeAdapterOptions } from './adapters/claude';
import { codexExecutor } from './adapters/codex';
import type { CodexAdapterOptions } from './adapters/codex';
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

export type Provider = 'claude' | 'codex';

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
  // Which provider renders the independent critic's verdict (design §3.6). Defaults
  // to the NOT-the-author provider, so the critic is cross-provider by default.
  criticProvider?: Provider;
  // Per-role cost-guardrail knob for the critic. Omitted → the critic provider's
  // cheapest default.
  criticModel?: string;
  // Which provider renders the orchestrator's own decompose/leaf-vs-branch judgment
  // (design §3.3, §3.4). Defaults to the author (primary) provider — unlike the
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
  // Node-attributed per-call usage records (F5), read back from the persisted
  // evidence store. Spans executor, critic, and brain calls; sorted by node/role/seq.
  usages: CallUsage[];
  // The rendered recap (also written to `log`).
  recap: string;
  // Whether the end-of-run commit recorded anything.
  committed: boolean;
}

// Build a real provider executor at its cheapest default, with an optional
// per-role model override (the cost-guardrail knob). Both adapters expose the
// same `{ model }` option shape, so provider selection is a single switch.
function buildProviderExecutor(provider: Provider, model?: string): Executor {
  if (provider === 'claude') {
    const claudeOpts: ClaudeAdapterOptions = {};
    if (model !== undefined) claudeOpts.model = model;
    return claudeExecutor(claudeOpts);
  }
  const codexOpts: CodexAdapterOptions = {};
  if (model !== undefined) codexOpts.model = model;
  return codexExecutor(codexOpts);
}

function formatUsd(cost: number | null): string {
  return cost === null ? 'n/a (unpriced)' : `$${cost.toFixed(6)}`;
}

// Render the operator recap: where the store is, every node's status, the run's
// evidence files, the per-call usage/cost, and any blocked record. Built by
// reading the store back so it reflects what was actually persisted, not the
// in-memory result alone.
async function renderRecap(
  storeDir: string,
  projectPath: string,
  key: string,
  runId: string,
  result: OrchestratorResult,
  usages: readonly CallUsage[],
): Promise<string> {
  const paths = relayPaths(storeDir);
  const lines: string[] = [
    '=== relay run recap ===',
    `store (.relay/): ${storeDir}   [git log-able]`,
    `project: ${projectPath}   key=${key}`,
    `run: ${runId}   root status: ${result.rootStatus}`,
    '',
    'node statuses (read: nodes/<id>.md):',
  ];

  const nodeFiles = (await readdir(paths.nodesDir)).filter((f) => f.endsWith('.md')).sort();
  for (const file of nodeFiles) {
    const id = file.slice(0, -3);
    const node = await readNode(storeDir, id);
    lines.push(`  ${id} [${node.kind}] -> ${node.status}`);
    if (node.verdict) {
      // The independent critic's verdict (design §3.6): who graded it (a different
      // provider than the author by default) and the result it certified.
      lines.push(`    critic [${node.verdict.provider}] -> ${node.verdict.pass ? 'PASS' : 'FAIL'}`);
    }
    if (node.blocked) {
      lines.push(`    blocked: ${node.blocked.humanFacing}`);
    }
  }

  lines.push('', `evidence (evidence/${runId}/):`);
  try {
    const evRoot = paths.evidenceDir(runId);
    const groups = (await readdir(evRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const g of groups) {
      if (!g.isDirectory()) {
        lines.push(`  ${g.name}`);
        continue;
      }
      const files = (await readdir(`${evRoot}/${g.name}`)).sort();
      for (const f of files) {
        lines.push(`  ${g.name}/${f}`);
      }
    }
  } catch {
    lines.push('  (none persisted this run)');
  }

  lines.push('', 'per-call usage (node-attributed; F5):');
  if (usages.length === 0) {
    lines.push('  (no model calls)');
  }
  let runTotal = 0;
  let uncosted = 0;
  for (const u of usages) {
    if (u.costUsd === null) uncosted += 1;
    else runTotal += u.costUsd;
    lines.push(
      `  ${u.nodeId} [${u.role} #${u.seq.toString()}] provider=${u.provider} ` +
        `model=${u.model ?? 'unknown'} ` +
        `in=${u.inputTokens.toString()} cached=${u.cachedInputTokens.toString()} ` +
        `out=${u.outputTokens.toString()} wall=${u.wallClockMs.toString()}ms ` +
        `cost=${formatUsd(u.costUsd)} (${u.costSource})`,
    );
  }
  if (usages.length > 0) {
    lines.push(
      `  run total: ${formatUsd(runTotal)}` +
        (uncosted > 0 ? `  (+${uncosted.toString()} uncosted)` : ''),
      `  rollup: ${paths.costRollup(runId)}`,
    );
  }

  lines.push('', `read first: ${paths.nodesDir} and ${paths.evidenceDir(runId)}`);
  return lines.join('\n');
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
  // The `.relay/` root IS the keyed store dir (design §4 git-trackability).
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

  const runOpts: RunOptions = {
    executor,
    // Worktrees are executor sandboxes, kept OUTSIDE the git-tracked store.
    workRoot: store.workRoot,
    // The operator's resolved absolute project path: the executor sandbox is seeded
    // from it on a real run, and the verified result lands back into it (Phase 2+).
    projectPath: store.projectPath,
  };
  // The swap-provider rung dispatches under the OTHER provider at its cheapest
  // default (the per-role override raises only the primary). Skipped when a test
  // injects its own executor — it then owns the swap behavior too.
  if (opts.executor === undefined) {
    runOpts.swapExecutor = buildProviderExecutor(otherProvider);
  }
  // The real cross-provider critic gates done-ness (design §3.6). An explicit
  // injected critic wins; otherwise the real agent critic is wired only on a real
  // run (no injected executor), so a test injecting just an executor keeps the
  // orchestrator's hermetic default critic. Per-call usage is now persisted by the
  // orchestrator (F5), node-attributed, and read back below for the recap — the
  // harness no longer captures it in-memory.
  if (opts.critic !== undefined) {
    runOpts.critic = opts.critic;
  } else if (opts.executor === undefined) {
    const criticOpts: AgentCriticOptions = { provider: criticProvider };
    if (opts.criticModel !== undefined) criticOpts.model = opts.criticModel;
    runOpts.critic = agentCritic(criticOpts);
  }
  // The orchestrator's own decompose/leaf-vs-branch judgment (design §3.3, §3.4). An
  // injected brain wins; otherwise the real agent brain is wired only on a real run
  // (no injected executor), so a test injecting just an executor keeps the stub
  // brain. Its usage is persisted by the orchestrator (F5) like the others.
  if (opts.brain !== undefined) {
    runOpts.brain = opts.brain;
  } else if (opts.executor === undefined) {
    const brainOpts: AgentBrainOptions = { provider: opts.brainProvider ?? provider };
    if (opts.brainModel !== undefined) brainOpts.model = opts.brainModel;
    runOpts.brain = agentBrain(brainOpts);
  }

  const result = await runOrchestrator(relayDir, 'root', runOpts);

  // F5: the per-call usage records the orchestrator persisted, node-attributed, read
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

  // Commit so the store is `git log`-able (design §4). Done after the recap reads
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
