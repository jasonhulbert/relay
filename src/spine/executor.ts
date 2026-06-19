// Executors are disposable single-purpose workers behind a uniform adapter, so
// the loop never special-cases a provider (design §5, §3.1). A fresh executor is
// spawned per leaf, does one outcome in its own worktree, and dies. It returns a
// compact verdict — `diff` (produced change, the critic's evidence) plus a
// narrative `selfReport` (orchestrator-only) — never its transcript, and it
// never writes `.relay/` (only the owning orchestrator does, C2).
//
// M1 ships a STUB executor: a real provider CLI (`claude -p` / `codex exec`) is
// wired at M4. The stub does a trivial deterministic change so the spine's
// load-bearing mechanics (journal, projection, rehydration) can be exercised
// end-to-end without a model.
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWriteFile } from '../relay-state/index';
import type { OutcomeSpec } from '../relay-state/index';

export interface ExecutorInput {
  spec: OutcomeSpec;
  // The sandbox worktree the executor may write; `.relay/` is off-limits.
  worktree: string;
}

export interface ExecutorResult {
  // `produced_changes` (design §5): the diff the critic grades. Orchestrator and
  // critic both see this.
  diff: string;
  // Narrative for the orchestrator only — structurally withheld from the critic
  // by the C7 projection (§3.6).
  selfReport: string;
  exitStatus: number;
}

export interface Executor {
  run(input: ExecutorInput): Promise<ExecutorResult>;
}

const CHANGE_FILE = 'CHANGE.txt';
const CHANGE_BODY = 'relay walking-skeleton change\n';

export const stubExecutor: Executor = {
  async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
    await mkdir(worktree, { recursive: true });
    await atomicWriteFile(join(worktree, CHANGE_FILE), CHANGE_BODY);
    return {
      diff: `A ${CHANGE_FILE}\n+${CHANGE_BODY.trimEnd()}`,
      selfReport: 'Created CHANGE.txt exactly as asked; I am confident this is correct.',
      exitStatus: 0,
    };
  },
};
