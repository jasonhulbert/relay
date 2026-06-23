// Spawning a child sub-orchestrator as its own OS process. The
// orchestrator tree is a process tree of fresh `node` invocations, each bound to
// a node-id and coordinating ONLY through `.relay/`. A parent spawns each branch
// child here; the child writes its region (and its verified
// outcome contract) to `.relay/` and exits. The parent trusts the structural ledger
// fact that the gate fired — never this subprocess's stdout, which is why stdout is not
// piped back.
import { spawn } from 'node:child_process';
import type { ChildInjection } from './orchestrator';

// One child orchestrator invocation.
export interface ChildSpawnInput {
  relayDir: string;
  // The child node-id the spawned process is bound to (becomes its region).
  nodeId: string;
  // Path to the bundled child-entry the default spawner runs. The source uses
  // extensionless, bundler-resolved imports, so Node cannot run it directly; the
  // child must be an esbuild bundle (the same shape the SEA binary will take).
  childEntry: string;
  // Test-only faults forwarded into the child's own run, as a JSON argv.
  injection?: ChildInjection;
}

export interface ChildSpawnResult {
  // The child process exit code (0 = the sub-orchestrator reached its outcome).
  code: number;
}

// Seam for tests: the default spawns a real subprocess (the process-isolation
// guarantee under test); a test may inject a stand-in to isolate the parent's own behavior.
export type SpawnChild = (input: ChildSpawnInput) => Promise<ChildSpawnResult>;

export const defaultSpawnChild: SpawnChild = ({ relayDir, nodeId, childEntry, injection }) => {
  return new Promise((resolve, reject) => {
    if (!childEntry) {
      reject(
        new Error(
          'cannot spawn a sub-orchestrator: no child entry (set RunOptions.childEntry or RELAY_CHILD_ENTRY)',
        ),
      );
      return;
    }
    const args = [childEntry, relayDir, nodeId];
    if (injection) {
      args.push(JSON.stringify(injection));
    }
    const child = spawn(process.execPath, args, {
      // stdout is intentionally ignored: the parent reads the child's verdict from
      // the committed `.relay/` contract (the structural ledger fact), never from this stream. stderr is
      // inherited so a crashing child is debuggable.
      stdio: ['ignore', 'ignore', 'inherit'],
      // Propagate the entry so a deeper branch child can spawn its own children.
      env: { ...process.env, RELAY_CHILD_ENTRY: childEntry, NODE_NO_WARNINGS: '1' },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1 });
    });
  });
};
