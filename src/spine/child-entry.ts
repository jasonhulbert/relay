// Entry point for a spawned sub-orchestrator process. The
// parent runs `node <thisBundle> <relayDir> <nodeId>`; this binds the orchestrator
// to that node-id, drives its subtree, writes its region to `.relay/`, and exits
// 0 on success / non-zero on failure. The parent reads the outcome from `.relay/`
// (the ledger), never from this process's stdout.
//
// This module is bundled (esbuild) into a single CJS file before it can be
// spawned: the source uses extensionless, bundler-resolved imports that Node's
// loader will not resolve from raw `.ts`. The bundle is the same artifact shape
// the SEA single-binary will later carry.
import { runOrchestrator } from './orchestrator';
import type { ChildInjection, RunOptions } from './orchestrator';

async function main(): Promise<number> {
  const [relayDir, nodeId, injectionRaw] = process.argv.slice(2);
  if (!relayDir || !nodeId) {
    process.stderr.write('child-entry: usage: <relayDir> <nodeId> [injectionJSON]\n');
    return 2;
  }
  const injection = injectionRaw ? (JSON.parse(injectionRaw) as ChildInjection) : undefined;
  const opts: RunOptions = {};
  if (injection?.contractFault) {
    opts.injection = { contractFault: injection.contractFault };
  }
  if (injection?.faultAt) {
    opts.faultAt = injection.faultAt;
  }
  const result = await runOrchestrator(relayDir, nodeId, opts);

  // Under the withhold fault the child exits 0 and even shouts success on stdout —
  // the parent must still treat it as not-done, because it reads the (absent)
  // contract from the ledger, never this stream (it trusts the structural ledger fact).
  if (injection?.contractFault === 'skip') {
    process.stdout.write(`CONTRACT certified=true status=${result.rootStatus}\n`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    // A modeled kill (InjectedKill) is an expected mid-run death, not a crash —
    // exit non-zero quietly so the parent re-dispatches on rehydration. Real
    // failures still surface on stderr.
    if (!(err instanceof Error && err.name === 'InjectedKill')) {
      process.stderr.write(`child-entry: ${err instanceof Error ? err.stack : String(err)}\n`);
    }
    process.exit(1);
  },
);
