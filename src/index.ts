// Injected at build time by scripts/build.mjs.
declare const __RELAY_VERSION__: string;

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { devRun, projectKey, relayHome } from './spine/index';
import type { DevRunOptions, Provider } from './spine/index';
// The intake collaborators (Plan 2): the real conversational interviewer and the
// stdin human-answer source the interactive `relay run` grills through. `relayRun`
// composes intake -> commit a childless root -> decompose -> apply-back.
import { agentInterviewer, stdinAsk } from './intake/index';
import type { IntakeProvider } from './intake/index';
import { relayRun } from './run';
import type { RelayRunOptions } from './run';
import { startWebView } from './webview/index';

const USAGE = `relay v${__RELAY_VERSION__}
A terminal-based, multi-provider loop generator and orchestrator.

Usage:
  relay [command] [options]

Commands:
  run                        Compose a REAL run: grill intake (or compile a seed
                             from --outcome) -> commit a childless root ->
                             decompose -> apply back to a relay/<runId> branch.
    [--project <path>]       Project to run for (default: cwd).
    [--outcome <text>]       Non-interactive: compile a grounded seed from this
                             outcome (omit to grill interactively).
    [--provider <name>]      Primary executor: claude | codex (default: claude).
    [--model <name>]         Executor model override (default: cheapest).
    [--critic-provider <n>]  Critic provider (default: the not-the-author one).
    [--critic-model <name>]  Critic model override (default: cheapest).
    [--brain-provider <n>]   Decompose-judgment provider (default: the author).
    [--brain-model <name>]   Brain model override (default: cheapest).

  dev-run --outcome <text>   Dev/eval HARNESS (not the real entry — see run):
                             hand-seed a SINGLE-LEAF root (no intake, no
                             decomposition) and drive the real orchestrator
                             against this project's ~/.relay/ store; print a recap.
    [--project <path>]       Project to run for (default: cwd).
    [--provider <name>]      Primary executor: claude | codex (default: claude).
    [--model <name>]         Executor model override (default: cheapest).
    [--critic-provider <n>]  Critic provider (default: the not-the-author one).
    [--critic-model <name>]  Critic model override (default: cheapest).
    [--brain-provider <n>]   Decompose-judgment provider (default: the author).
    [--brain-model <name>]   Brain model override (default: cheapest).
    [--check <command>]      Leaf command verification (default: always-pass).

  web                        Serve the read-only web view of this project's
                             user-global ~/.relay/ store in a browser.
    [--project <path>]       Project whose store to render (default: cwd).
    [--port <n>]             Port to bind on loopback (default: 4317).

Options:
  -v, --version   Print the version and exit.
  -h, --help      Print this help and exit.
`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function devRunCommand(args: readonly string[]): Promise<number> {
  const outcome = flag(args, '--outcome');
  if (!outcome) {
    process.stderr.write('dev-run: --outcome <text> is required\n');
    return 2;
  }
  const devOpts: DevRunOptions = {
    projectPath: flag(args, '--project') ?? process.cwd(),
    outcome,
  };
  const provider = flag(args, '--provider');
  if (provider !== undefined) {
    if (provider !== 'claude' && provider !== 'codex') {
      process.stderr.write(`dev-run: --provider must be claude or codex (got ${provider})\n`);
      return 2;
    }
    devOpts.provider = provider satisfies Provider;
  }
  const model = flag(args, '--model');
  if (model !== undefined) devOpts.executorModel = model;
  const criticProvider = flag(args, '--critic-provider');
  if (criticProvider !== undefined) {
    if (criticProvider !== 'claude' && criticProvider !== 'codex') {
      process.stderr.write(
        `dev-run: --critic-provider must be claude or codex (got ${criticProvider})\n`,
      );
      return 2;
    }
    devOpts.criticProvider = criticProvider satisfies Provider;
  }
  const criticModel = flag(args, '--critic-model');
  if (criticModel !== undefined) devOpts.criticModel = criticModel;
  const brainProvider = flag(args, '--brain-provider');
  if (brainProvider !== undefined) {
    if (brainProvider !== 'claude' && brainProvider !== 'codex') {
      process.stderr.write(
        `dev-run: --brain-provider must be claude or codex (got ${brainProvider})\n`,
      );
      return 2;
    }
    devOpts.brainProvider = brainProvider satisfies Provider;
  }
  const brainModel = flag(args, '--brain-model');
  if (brainModel !== undefined) devOpts.brainModel = brainModel;
  const check = flag(args, '--check');
  if (check !== undefined) devOpts.check = check;
  const out = await devRun(devOpts);
  // The harness already printed the recap; signal a non-`done` run as misuse so a
  // scripted caller (or the operator's shell) sees the failure (Rule 11).
  if (out.result.rootStatus !== 'done') return 1;
  // Apply-back fail-loud (workspace-substrate §6): a dirty / non-git workspace or a
  // patch that did not apply produced NO branch — the verified result was delivered
  // as `result.patch` instead. The recap already names it; echo a loud one-liner to
  // stderr and exit non-zero so an operator (or scripted caller) cannot mistake the
  // patch-only outcome for an applied branch. Never an inbox write.
  if (out.result.applyBack.kind === 'patch-only') {
    process.stderr.write(
      `dev-run: result NOT applied as a branch (${out.result.applyBack.reason}); ` +
        `${out.result.applyBack.notice}\n` +
        `         verified patch: ${out.result.applyBack.patchPath}\n`,
    );
    return 1;
  }
  return 0;
}

// `relay run`: the real composing command (Plan 2). It grills intake to a seed (or,
// with --outcome, compiles one non-interactively), commits a CHILDLESS root, lets the
// orchestrator decompose + execute it, and applies the verified result back as a
// relay/<runId> branch via the Plan 1 substrate. Phase 1 parses the flags and confirms
// the intake compiler is reachable from the CLI; the composition lands in Phase 2/3.
async function runCommand(args: readonly string[]): Promise<number> {
  const KNOWN_FLAGS = new Set([
    '--project',
    '--outcome',
    '--provider',
    '--model',
    '--critic-provider',
    '--critic-model',
    '--brain-provider',
    '--brain-model',
  ]);
  // Fail loud on any unrecognized argument with a usage message, rather than silently
  // ignoring it. Each known flag consumes the following token as its value.
  for (let i = 0; i < args.length; i++) {
    if (!KNOWN_FLAGS.has(args[i])) {
      process.stderr.write(`run: unknown argument '${args[i]}'\n\n${USAGE}`);
      return 2;
    }
    i++;
  }

  const provider = flag(args, '--provider');
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') {
    process.stderr.write(`run: --provider must be claude or codex (got ${provider})\n`);
    return 2;
  }
  const criticProvider = flag(args, '--critic-provider');
  if (criticProvider !== undefined && criticProvider !== 'claude' && criticProvider !== 'codex') {
    process.stderr.write(
      `run: --critic-provider must be claude or codex (got ${criticProvider})\n`,
    );
    return 2;
  }
  const brainProvider = flag(args, '--brain-provider');
  if (brainProvider !== undefined && brainProvider !== 'claude' && brainProvider !== 'codex') {
    process.stderr.write(`run: --brain-provider must be claude or codex (got ${brainProvider})\n`);
    return 2;
  }

  const projectPath = flag(args, '--project') ?? process.cwd();
  const outcome = flag(args, '--outcome');

  // Both paths compose the SAME run (intake → childless root → decompose → apply-back);
  // they differ only in how the seed is sourced. The interviewer runs on the primary
  // provider (the author) at its cheapest default, from the project dir (intake runs
  // before any worktree exists). Per-role provider/model overrides thread straight
  // through to `relayRun`'s orchestrator wiring below.
  const interviewerProvider: IntakeProvider = provider === 'codex' ? 'codex' : 'claude';
  // Non-interactive (`--outcome`): compile a grounded seed in ONE model call with no
  // stdin (Plan 2 Phase 3). The one-shot interviewer is driven to emit a `seed` turn
  // immediately and `maxQuestions: 0` forbids a follow-up question; the seed validates
  // through the same compile path as the interactive `done` turn. A one-shot turn that
  // can't produce a valid seed (asks a question, or emits a malformed seed) fails loud
  // inside `relayRun` BEFORE any root is committed (intake precedes commitRoot), so a
  // degenerate seed never lands a partial root (Rule 11). Interactive (no `--outcome`):
  // grill the human through the real conversational interviewer + stdin.
  const runOpts: RelayRunOptions =
    outcome !== undefined
      ? {
          projectPath,
          interviewer: agentInterviewer({
            provider: interviewerProvider,
            cwd: projectPath,
            oneShot: true,
          }),
          // `maxQuestions: 0` makes a non-converging turn throw before `ask` is reached,
          // so a call here would be a bug — fail loud rather than secretly read stdin.
          ask: () =>
            Promise.reject(
              new Error('run: --outcome is non-interactive and must not read stdin'),
            ),
          opening: outcome,
          maxQuestions: 0,
        }
      : {
          projectPath,
          interviewer: agentInterviewer({ provider: interviewerProvider, cwd: projectPath }),
          ask: stdinAsk(),
        };
  if (provider !== undefined) runOpts.provider = provider as Provider;
  const executorModel = flag(args, '--model');
  if (executorModel !== undefined) runOpts.executorModel = executorModel;
  if (criticProvider !== undefined) runOpts.criticProvider = criticProvider as Provider;
  const criticModel = flag(args, '--critic-model');
  if (criticModel !== undefined) runOpts.criticModel = criticModel;
  if (brainProvider !== undefined) runOpts.brainProvider = brainProvider as Provider;
  const brainModel = flag(args, '--brain-model');
  if (brainModel !== undefined) runOpts.brainModel = brainModel;

  const out = await relayRun(runOpts);
  // The recap is already printed. Signal a non-`done` run as misuse so a scripted
  // caller (or the operator's shell) sees the failure (Rule 11) — mirrors dev-run.
  if (out.result.rootStatus !== 'done') return 1;
  // Apply-back fail-loud (workspace-substrate §6): a dirty / non-git workspace or a
  // patch that did not apply produced NO branch — the verified result was delivered
  // as `result.patch` instead. The recap already names it; echo a loud one-liner so
  // an operator cannot mistake the patch-only outcome for an applied branch.
  if (out.result.applyBack.kind === 'patch-only') {
    process.stderr.write(
      `run: result NOT applied as a branch (${out.result.applyBack.reason}); ` +
        `${out.result.applyBack.notice}\n` +
        `     verified patch: ${out.result.applyBack.patchPath}\n`,
    );
    return 1;
  }
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// `relay web`: serve the read-only render of the project's global `.relay/` store.
// It RESOLVES the existing store (never creating one — the view writes nothing,
// I3); a project with no store yet is a loud error, not an empty page. The server
// recomposes the projection on every request, so it keeps running until the
// operator interrupts it (Ctrl-C). Returns a promise that only settles on a bind
// failure — while listening it stays pending so the process does not exit.
async function webCommand(args: readonly string[]): Promise<number> {
  const projectPath = flag(args, '--project') ?? process.cwd();
  const portArg = flag(args, '--port');
  let port = 4317;
  if (portArg !== undefined) {
    const parsed = Number(portArg);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      process.stderr.write(`web: --port must be an integer 0-65535 (got ${portArg})\n`);
      return 2;
    }
    port = parsed;
  }

  // Resolve the store the same way the orchestrator does, but read-only: no
  // ensureProjectStore (that would create/`git init` a store the operator never ran).
  const storeDir = join(relayHome({}), projectKey(projectPath));
  if (!(await exists(join(storeDir, 'manifest.md')))) {
    process.stderr.write(
      `web: no relay store for ${projectPath} at ${storeDir}\n` +
        `     run \`relay dev-run --outcome ...\` for this project first.\n`,
    );
    return 1;
  }

  const { url } = await startWebView({ relayDir: storeDir, port });
  process.stdout.write(`relay web: serving ${storeDir}\n  ${url}\n  (read-only; Ctrl-C to stop)\n`);

  // Stay alive while the server listens. The server keeps the event loop busy; the
  // returned promise never resolves on the happy path, so `main` does not exit.
  return new Promise<number>(() => {
    /* runs until the process is signalled */
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${__RELAY_VERSION__}\n`);
    return 0;
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args[0] === 'run') {
    return runCommand(args.slice(1));
  }

  if (args[0] === 'dev-run') {
    return devRunCommand(args.slice(1));
  }

  if (args[0] === 'web') {
    return webCommand(args.slice(1));
  }

  // No other subcommands exist yet. Invoked with no (or unknown) args, print usage
  // to stderr and signal misuse with a non-zero exit.
  process.stderr.write(USAGE);
  return 1;
}

main(process.argv).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `relay: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  },
);
