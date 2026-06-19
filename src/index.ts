// Injected at build time by scripts/build.mjs.
declare const __RELAY_VERSION__: string;

import { devRun } from './spine/index';
import type { DevRunOptions } from './spine/index';

const USAGE = `relay v${__RELAY_VERSION__}
A terminal-based, multi-provider loop generator and orchestrator.

Usage:
  relay [command] [options]

Commands:
  dev-run --outcome <text>   Run the REAL orchestrator against this project's
                             user-global ~/.relay/ store and print a recap.
    [--project <path>]       Project to run for (default: cwd).
    [--model <name>]         Executor model override (default: cheapest).
    [--check <command>]      Leaf command verification (default: always-pass).

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
  const model = flag(args, '--model');
  if (model !== undefined) devOpts.executorModel = model;
  const check = flag(args, '--check');
  if (check !== undefined) devOpts.check = check;
  const out = await devRun(devOpts);
  // The harness already printed the recap; signal a non-`done` run as misuse so a
  // scripted caller (or the operator's shell) sees the failure (Rule 11).
  return out.result.rootStatus === 'done' ? 0 : 1;
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
