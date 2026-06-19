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
  // A sizing judgment the executor may raise instead of a gradeable change: the
  // outcome is too large to land as one leaf (design §3.9). It preempts the
  // critic and drives the ladder straight to promote (leaf→branch). Absent means
  // a normal attempt the critic then grades.
  sizeSignal?: 'too-big';
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

// A controllable executor for M3's deterministic ladder tests. It produces the
// same trivial change as `stubExecutor`, but can raise a scripted `too-big`
// sizing judgment on a given attempt so a test can drive the ladder's
// promote-on-too-big path through a real executor seam rather than the
// controller boundary alone. The signal per call is consumed in order; the final
// entry repeats once the script is exhausted, so a one-entry script is a
// constant. The real provider CLIs arrive at M4.
export interface ScriptedExecutorOptions {
  // Size judgment per call, in order; the final entry repeats thereafter.
  // `ok` makes a normal gradeable change, `too-big` raises the sizing signal.
  signals: ('ok' | 'too-big')[];
}

export function scriptedExecutor(opts: ScriptedExecutorOptions): Executor {
  if (opts.signals.length === 0) {
    throw new Error('scriptedExecutor requires at least one signal');
  }
  let call = 0;
  return {
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      const signal = opts.signals[Math.min(call, opts.signals.length - 1)];
      call += 1;
      await mkdir(worktree, { recursive: true });
      if (signal === 'too-big') {
        // No gradeable change: the executor judged the outcome too large to land
        // as one leaf and asks to be promoted instead of being critiqued.
        return {
          diff: '',
          selfReport: 'Outcome is too large to complete as a single leaf; requesting promotion.',
          exitStatus: 0,
          sizeSignal: 'too-big',
        };
      }
      await atomicWriteFile(join(worktree, CHANGE_FILE), CHANGE_BODY);
      return {
        diff: `A ${CHANGE_FILE}\n+${CHANGE_BODY.trimEnd()}`,
        selfReport: 'Created CHANGE.txt exactly as asked; I am confident this is correct.',
        exitStatus: 0,
      };
    },
  };
}
