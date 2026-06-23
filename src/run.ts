// See docs/relay-spec.md for the architecture this implements.
// `relay run`: the real composing run. Unlike `dev-run`
// (the hermetic harness that hand-seeds a single leaf and never decomposes), this
// composes the already-built intake path into a real run: grill the human to a SEED
// (`runIntake`), commit it as a CHILDLESS root (`commitRoot`) so the brain owns the
// first decomposition at activation, drive the SAME orchestrator, and let the files-only
// state substrate land the verified result back as a reviewable `relay/<runId>` branch.
//
// Intake stays execution-free (the invariant the module is built around): `runIntake`
// returns a seed and runs nothing, `commitRoot` writes `.relay/` and stops; activation
// and decomposition are the orchestrator's job. This module only wires those stages in
// order — it adds no execution capability of its own to intake.
//
// The orchestration flow is written out here rather than shared with `dev-run` so the
// hermetic harness stays decoupled from the real entry point; only the genuinely
// generic pieces (provider construction, recap rendering) are reused from run-support.
import { resolve } from 'node:path';
import {
  agentBrain,
  agentCritic,
  buildProviderExecutor,
  commitStore,
  ensureProjectStore,
  renderRecap,
  runOrchestrator,
} from './spine/index';
import type {
  AgentBrainOptions,
  AgentCriticOptions,
  Brain,
  EnsureStoreOptions,
  Executor,
  OrchestratorResult,
  Provider,
  RunOptions,
} from './spine/index';
import type { CallUsage, CriticSpawn } from './relay-state/index';
import { readRunUsage } from './relay-state/index';
import { commitRoot, runIntake } from './intake/index';
import type { AskHuman, Interviewer, IntakeOptions, IntakeSeed } from './intake/index';
import type { CommitRootOptions } from './intake/index';

export interface RelayRunOptions {
  // The project the run is for; its absolute path keys the global store and seeds the
  // executor sandboxes. The verified result lands back into it as a branch.
  projectPath: string;
  // The intake collaborators: the conversational agent that grills
  // to a seed, and the human-answer source it grills through. Production wires
  // `agentInterviewer` + `stdinAsk`; tests inject scripted stand-ins so the whole run
  // is hermetic. These are the ONLY intake capabilities — there is deliberately no
  // execution handle here, so intake cannot bleed into running the loop.
  interviewer: Interviewer;
  ask: AskHuman;
  // Optional opening framing seeded as the human's first transcript line.
  opening?: string;
  // Max questions the grilling may put before it must converge on a seed.
  maxQuestions?: number;
  // Which provider drives the primary executor; defaults to Claude (mirrors dev-run).
  provider?: Provider;
  // Per-role model overrides (the cost-guardrail knobs). Omitted → cheapest default.
  executorModel?: string;
  // Which provider renders the independent critic; defaults to the NOT-the-author one,
  // so the critic is cross-provider by default.
  criticProvider?: Provider;
  criticModel?: string;
  // Which provider renders the orchestrator's decompose judgment; defaults to the
  // author (primary) provider — unlike the critic, the brain need not be cross-provider.
  brainProvider?: Provider;
  brainModel?: string;
  // The executor to drive. Defaults to the real provider adapter; tests inject a
  // deterministic stand-in. An injected executor keeps the orchestrator's hermetic
  // default critic/brain (matching dev-run), so a test need only inject the executor.
  executor?: Executor;
  // The critic to gate done-ness. Defaults to the real cross-provider agent critic on
  // a REAL run; tests inject a deterministic stand-in.
  critic?: CriticSpawn;
  // The brain that decomposes the childless root at activation. Defaults to the real
  // agent brain on a REAL run; tests inject a deterministic stand-in (or rely on the
  // orchestrator's stub brain when only an executor is injected).
  brain?: Brain;
  // Override `~/.relay` (tests pass a temp dir).
  home?: string;
  // Injected clock for the store index and the root commit timestamp (deterministic
  // tests). Omitted → wall-clock now.
  now?: () => string;
  // Recap sink; defaults to stdout.
  log?: (line: string) => void;
  // Evidence + commit run id; defaults to `run-1`.
  runId?: string;
}

export interface RelayRunResult {
  key: string;
  // The `.relay/` store root (== git repo root). Absolute, stable per project.
  storeDir: string;
  runId: string;
  // The committed root node-id the orchestrator activated from.
  rootId: string;
  result: OrchestratorResult;
  // The provider the independent critic ran (different from the author by default).
  criticProvider: Provider;
  // The seed intake compiled and `commitRoot` committed as the childless root.
  seed: IntakeSeed;
  // How many questions the human answered before the seed was approved.
  questionsAsked: number;
  // Node-attributed per-call usage records, read back from the persisted store.
  usages: CallUsage[];
  // The rendered recap (also written to `log`).
  recap: string;
  // Whether the end-of-run commit recorded anything.
  committed: boolean;
}

export async function relayRun(opts: RelayRunOptions): Promise<RelayRunResult> {
  const log =
    opts.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const runId = opts.runId ?? 'run-1';

  // 1. Intake: grill the human to a seed. This runs nothing and touches no `.relay/`
  //    — the conversation's only output is the seed. A non-converging
  //    interview throws loudly here (Rule 11) rather than committing a partial root.
  const intakeOpts: IntakeOptions = { interviewer: opts.interviewer, ask: opts.ask };
  if (opts.opening !== undefined) intakeOpts.opening = opts.opening;
  if (opts.maxQuestions !== undefined) intakeOpts.maxQuestions = opts.maxQuestions;
  const intake = await runIntake(intakeOpts);

  // 2. Resolve the durable per-project store (same path dev-run resolves).
  const ensureOpts: EnsureStoreOptions = {};
  if (opts.home !== undefined) ensureOpts.home = opts.home;
  if (opts.now !== undefined) ensureOpts.now = opts.now;
  const store = await ensureProjectStore(opts.projectPath, ensureOpts);
  // The `.relay/` root IS the keyed store dir (git-trackable files-only state).
  const relayDir = store.storeDir;

  // 3. Commit the seed as a CHILDLESS root through the atomic intent journal. No
  //    binding decomposition is written — the brain owns the first layer at activation.
  //    This is the structural fix for "the multi-part outcome ran as one agent
  //    turn": the root is a branch the orchestrator must decompose, not a pre-seeded leaf.
  const commitOpts: CommitRootOptions = { runId };
  if (opts.now !== undefined) commitOpts.createdAt = opts.now();
  const rootCommit = await commitRoot(relayDir, intake.seed, commitOpts);

  // 4. Orchestrator wiring. Identical in shape to dev-run's, written out here to keep
  //    the two command bodies distinct. An injected executor keeps the orchestrator's
  //    hermetic default critic/brain, so a test that injects only the executor exercises
  //    the real decompose/critic stubs; a real run (no injected executor) wires the real
  //    agent critic (cross-provider) and agent brain.
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
    // The operator's resolved project path: the executor sandbox is seeded from it and
    // the verified result lands back into it (apply-back, inside runOrchestrator).
    projectPath: store.projectPath,
  };
  // The swap-provider rung dispatches under the OTHER provider at its cheapest default;
  // skipped when a test injects its own executor (it then owns swap behavior too).
  if (opts.executor === undefined) {
    runOpts.swapExecutor = buildProviderExecutor(otherProvider);
  }
  if (opts.critic !== undefined) {
    runOpts.critic = opts.critic;
  } else if (opts.executor === undefined) {
    const criticOpts: AgentCriticOptions = { provider: criticProvider };
    if (opts.criticModel !== undefined) criticOpts.model = opts.criticModel;
    runOpts.critic = agentCritic(criticOpts);
  }
  if (opts.brain !== undefined) {
    runOpts.brain = opts.brain;
  } else if (opts.executor === undefined) {
    const brainOpts: AgentBrainOptions = { provider: opts.brainProvider ?? provider };
    if (opts.brainModel !== undefined) brainOpts.model = opts.brainModel;
    runOpts.brain = agentBrain(brainOpts);
  }

  // 5. Activate the orchestrator on the committed root. It rolls forward any pending
  //    root commit, decomposes the childless branch, drives the leaves, and (on
  //    a done root with a clean git project) applies the result back as a branch — all
  //    reported through `result.applyBack`.
  const result = await runOrchestrator(relayDir, rootCommit.rootId, runOpts);

  // 6. Read back the node-attributed per-call usage the orchestrator persisted,
  //    render the recap from the store, and commit so it is `git log`-able.
  const usages = await readRunUsage(relayDir, runId);
  const recap = await renderRecap(
    relayDir,
    resolve(opts.projectPath),
    store.key,
    runId,
    result,
    usages,
  );
  const committed = await commitStore(relayDir, `relay run ${runId}: root ${result.rootStatus}`);

  log(recap);

  return {
    key: store.key,
    storeDir: relayDir,
    runId,
    rootId: rootCommit.rootId,
    result,
    criticProvider,
    seed: intake.seed,
    questionsAsked: intake.questionsAsked,
    usages,
    recap,
    committed,
  };
}
