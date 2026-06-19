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
import { relayPaths, readNode } from '../relay-state/index';
import type { ExecutorUsage } from './executor';
import type { Executor } from './executor';
import { claudeExecutor } from './adapters/claude';
import type { ClaudeAdapterOptions } from './adapters/claude';
import { runOrchestrator } from './orchestrator';
import type { OrchestratorResult } from './orchestrator';
import { seedFixture } from './seed';
import type { SeedOptions } from './seed';
import { commitStore, ensureProjectStore } from './relay-home';
import type { EnsureStoreOptions } from './relay-home';

export interface DevRunOptions {
  // The project the run is for; its absolute path keys the global store.
  projectPath: string;
  // The concrete outcome the executor must achieve (seeded onto the leaf).
  outcome: string;
  // The leaf's command verification; defaults to an always-pass check so the
  // harness's happy path does not depend on a real test command existing yet.
  check?: string;
  // Override `~/.relay` (tests pass a temp dir).
  home?: string;
  // Per-role model override (the cost-guardrail knob). Omitted → the adapter's
  // cheapest default (`claude-haiku-4-5`).
  executorModel?: string;
  // The executor to drive. Defaults to the real Claude adapter; tests inject a
  // deterministic stand-in so the harness is exercisable without the CLI.
  executor?: Executor;
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
  // Per-call usage in dispatch order (not yet node-attributed — Phase 6).
  usages: ExecutorUsage[];
  // The rendered recap (also written to `log`).
  recap: string;
  // Whether the end-of-run commit recorded anything.
  committed: boolean;
}

// Capture each dispatch's usage without changing the executor's behavior, so the
// recap can report model/tokens/cost. (Orchestrator-level, node-attributed usage
// is Phase 6.)
function recordingExecutor(inner: Executor, sink: ExecutorUsage[]): Executor {
  return {
    capabilities: () => inner.capabilities(),
    async run(input) {
      const result = await inner.run(input);
      sink.push(result.usage);
      return result;
    },
  };
}

function formatUsd(cost: number | null): string {
  return cost === null ? 'n/a (price-table, Phase 6)' : `$${cost.toFixed(6)}`;
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
  usages: readonly ExecutorUsage[],
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

  lines.push('', 'per-call usage (dispatch order; node attribution lands in Phase 6):');
  if (usages.length === 0) {
    lines.push('  (no executor calls)');
  }
  for (const [i, u] of usages.entries()) {
    lines.push(
      `  [${i.toString()}] provider=${u.provider} model=${u.model ?? 'unknown'} ` +
        `in=${u.inputTokens.toString()} cached=${u.cachedInputTokens.toString()} ` +
        `out=${u.outputTokens.toString()} wall=${u.wallClockMs.toString()}ms cost=${formatUsd(u.costUsd)}`,
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

  const usages: ExecutorUsage[] = [];
  const claudeOpts: ClaudeAdapterOptions = {};
  if (opts.executorModel !== undefined) claudeOpts.model = opts.executorModel;
  const inner = opts.executor ?? claudeExecutor(claudeOpts);
  const executor = recordingExecutor(inner, usages);

  const result = await runOrchestrator(relayDir, 'root', {
    executor,
    // Worktrees are executor sandboxes, kept OUTSIDE the git-tracked store.
    workRoot: store.workRoot,
  });

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
    usages,
    recap,
    committed,
  };
}
