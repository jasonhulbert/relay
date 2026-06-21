// Injected at build time by scripts/build.mjs.
declare const __RELAY_VERSION__: string;

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { devRun, projectKey, relayHome } from './spine/index';
import type { DevRunOptions, Provider } from './spine/index';
import { startWebView } from './webview/index';

const USAGE = `relay v${__RELAY_VERSION__}
A terminal-based, multi-provider loop generator and orchestrator.

Usage:
  relay [command] [options]

Commands:
  dev-run --outcome <text>   Run the REAL orchestrator against this project's
                             user-global ~/.relay/ store and print a recap.
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
