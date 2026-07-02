// See docs/relay-spec.md for the architecture this implements.
//
// Executors are disposable single-purpose workers behind a uniform adapter, so
// the loop never special-cases a provider. A fresh executor is
// spawned per leaf, does one outcome in its own worktree, and dies. It returns a
// compact verdict — `diff` (produced change, the critic's evidence) plus a
// narrative `selfReport` (orchestrator-only) — never its transcript, and it
// never writes `.relay/` (only the owning orchestrator does).
//
// A real provider CLI (`claude -p`, then `codex exec`) sits behind this
// same contract (see adapters/). The stubs below stay for the hermetic spine tests:
// they do a trivial deterministic change so the load-bearing mechanics (journal,
// projection, rehydration, ladder) can be exercised without a model.
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWriteFile } from '../relay-state/index';
import type { McpServerConfig, OutcomeSpec } from '../relay-state/index';
// The granted-MCP-server descriptor is a durable capability type, so it lives in
// relay-state alongside the other `.relay/` contracts; re-exported here so the
// executor adapters keep importing it from `../executor` (the critic grants the
// same shape). The real code-owned MCP loop is not yet built.
export type { McpServerConfig } from '../relay-state/index';

// What an executor is handed beyond its unit and sandbox: the keep-lesson
// reflections already accumulated on the node, so a retried or
// re-decomposed unit does not relearn what an earlier attempt established.
export interface ExecutorContext {
  learnings: readonly string[];
}

export interface ExecutorInput {
  // The unit of work: the verifiable outcome the executor must achieve.
  spec: OutcomeSpec;
  // Context carried into the attempt (prior learnings).
  context: ExecutorContext;
  // The sandbox worktree the executor may write; `.relay/` is off-limits.
  worktree: string;
  // The operator's resolved absolute project path the sandbox was seeded from, when
  // the run executes against a real workspace. Absent on the hermetic stub path (an
  // empty `git init` worktree), so injected-stub callers are unaffected.
  projectPath?: string;
  // The per-run base ref the worktree was checked out at, when it was seeded as a
  // real checkout of a clean operator repo. Present ⇒ the adapter skips
  // `establishBaseline` (HEAD already IS the base) and captures the diff against
  // this ref. Absent ⇒ the empty `git init` baseline path (hermetic / non-clean
  // workspace), so injected-stub callers are unaffected.
  baseRef?: string;
  // Granted MCP servers (empty until the code-owned MCP loop populates them).
  mcpServers: readonly McpServerConfig[];
}

// Per-call usage parsed from the provider stream (the cost rollup). Tokens are
// ground truth; dollars are direct when the provider reports them (Claude
// `total_cost_usd`) or `null` when they must be derived from a price table
// (Codex). The raw numbers are captured now; per-outcome attribution and
// run rollups are not yet built.
export interface ExecutorUsage {
  provider: string;
  // The concrete model the provider ran, when the stream names it.
  model: string | null;
  // Uncached input tokens.
  inputTokens: number;
  // Input tokens served through the prompt cache (created or read).
  cachedInputTokens: number;
  outputTokens: number;
  // Wall-clock the spine observed around the dispatch.
  wallClockMs: number;
  // Direct dollar cost when the provider reports it; `null` when it must be
  // derived from a local price table (not yet built).
  costUsd: number | null;
}

export interface ExecutorResult {
  // `produced_changes`: the diff the critic grades. Orchestrator and
  // critic both see this.
  diff: string;
  // Narrative for the orchestrator only — structurally withheld from the critic
  // by the evidence-only projection (orchestrator-visible narrative is never admissible to the critic).
  selfReport: string;
  // Per-call usage. Always present; the stubs report a zero record.
  usage: ExecutorUsage;
  exitStatus: number;
  // A sizing judgment the executor may raise instead of a gradeable change: the
  // outcome is too large to land as one leaf. It preempts the
  // critic and drives the ladder straight to promote (leaf→branch). Absent means
  // a normal attempt the critic then grades.
  sizeSignal?: 'too-big';
  // Machine-readable reason for the sizing judgment. Orchestrator-visible only:
  // it may shape promotion/re-decomposition context, but it is never critic
  // evidence.
  sizeRationale?: string;
  // The repo-relative paths this attempt actually wrote, for the footprint
  // hint/loud-violation check (a footprint escape is loud): the orchestrator compares them to
  // the leaf's declared footprint and throws a `FootprintViolation` on a write that
  // escapes it. Absent means the executor reports no write footprint, so no check
  // runs — the hermetic stub path, which stays byte-identical.
  writes?: string[];
}

// What an adapter supports, so the loop can choose rungs (resume, provider swap)
// without provider special-casing. Reported by `capabilities()`.
export interface ExecutorCapabilities {
  provider: string;
  // Structured (JSON/JSONL) stream output the spine can parse deterministically.
  json: boolean;
  // Session resume (re-dispatch continuing the prior attempt's context).
  resume: boolean;
  // Sandboxed file writes scoped to the worktree.
  sandbox: boolean;
  // Granted MCP tools inside the code-owned loop.
  mcp: boolean;
}

export interface Executor {
  run(input: ExecutorInput): Promise<ExecutorResult>;
  capabilities(): ExecutorCapabilities;
}

// The capability + usage shapes the stubs report: a stub runs no model, so it has
// no structured stream, no resume, no real sandbox, no MCP, and produces no
// tokens or cost. Shared so the hermetic test executors stay consistent.
export const stubCapabilities: ExecutorCapabilities = {
  provider: 'stub',
  json: false,
  resume: false,
  sandbox: false,
  mcp: false,
};

export const STUB_USAGE: ExecutorUsage = {
  provider: 'stub',
  model: null,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  wallClockMs: 0,
  costUsd: null,
};

const CHANGE_FILE = 'CHANGE.txt';
const CHANGE_BODY = 'relay walking-skeleton change\n';

export const stubExecutor: Executor = {
  capabilities: () => stubCapabilities,
  async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
    await mkdir(worktree, { recursive: true });
    await atomicWriteFile(join(worktree, CHANGE_FILE), CHANGE_BODY);
    return {
      diff: `A ${CHANGE_FILE}\n+${CHANGE_BODY.trimEnd()}`,
      selfReport: 'Created CHANGE.txt exactly as asked; I am confident this is correct.',
      usage: STUB_USAGE,
      exitStatus: 0,
    };
  },
};

// A controllable executor for the deterministic ladder tests. It produces the
// same trivial change as `stubExecutor`, but can raise a scripted `too-big`
// sizing judgment on a given attempt so a test can drive the ladder's
// promote-on-too-big path through a real executor seam rather than the
// controller boundary alone. The signal per call is consumed in order; the final
// entry repeats once the script is exhausted, so a one-entry script is a
// constant. The real provider CLIs sit behind the same contract.
export interface ScriptedExecutorOptions {
  // Size judgment per call, in order; the final entry repeats thereafter.
  // `ok` makes a normal gradeable change, `too-big` raises the sizing signal.
  signals: ('ok' | 'too-big')[];
  sizeRationale?: string;
}

export function scriptedExecutor(opts: ScriptedExecutorOptions): Executor {
  if (opts.signals.length === 0) {
    throw new Error('scriptedExecutor requires at least one signal');
  }
  let call = 0;
  return {
    capabilities: () => stubCapabilities,
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
          usage: STUB_USAGE,
          exitStatus: 0,
          sizeSignal: 'too-big',
          ...(opts.sizeRationale ? { sizeRationale: opts.sizeRationale } : {}),
        };
      }
      await atomicWriteFile(join(worktree, CHANGE_FILE), CHANGE_BODY);
      return {
        diff: `A ${CHANGE_FILE}\n+${CHANGE_BODY.trimEnd()}`,
        selfReport: 'Created CHANGE.txt exactly as asked; I am confident this is correct.',
        usage: STUB_USAGE,
        exitStatus: 0,
      };
    },
  };
}
