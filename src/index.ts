// Injected at build time by scripts/build.mjs.
declare const __RELAY_VERSION__: string;

const USAGE = `relay v${__RELAY_VERSION__}
A terminal-based, multi-provider loop generator and orchestrator.

Usage:
  relay [command] [options]

Options:
  -v, --version   Print the version and exit.
  -h, --help      Print this help and exit.

No commands are available yet; this is the v0.1 scaffold (M0).
`;

function run(argv: readonly string[]): number {
  const args = argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${__RELAY_VERSION__}\n`);
    return 0;
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  // No subcommands exist yet. Invoked with no (or unknown) args, print usage to
  // stderr and signal misuse with a non-zero exit.
  process.stderr.write(USAGE);
  return 1;
}

process.exit(run(process.argv));
