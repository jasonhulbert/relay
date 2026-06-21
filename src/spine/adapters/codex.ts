// The Codex executor adapter (design §5, F5), the second real provider behind the
// same `Executor` contract as the Claude adapter. Drives `codex exec --json
// --sandbox workspace-write` in the leaf's sandbox worktree, parses the JSONL
// event stream for a compact self-report and per-call usage, and reads the
// produced change back as a git diff. The orchestrator loop never special-cases
// the provider — the Claude↔Codex swap-provider rung relies on exactly this
// parity (design §3.7).
//
// The same two audiences come out of one run (the C7 split the projection later
// enforces):
//   - critic-visible: the `diff` (produced change) — captured from the worktree
//     via git, never from the model's narrative;
//   - orchestrator-visible: the `selfReport` — the stream's final `agent_message`
//     text, a bounded summary, NOT the transcript.
//
// MCP is NOT wired here. Codex grants MCP servers through config, not a single
// CLI flag like Claude, and the code-owned MCP loop is Phase 5 — so `capabilities`
// reports `mcp: false` and `run` fails loud (Rule 11) if servers are granted
// before that wiring exists, rather than silently dropping a grant.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { captureDiff, establishBaseline } from './worktree-diff';
// The executor prompt is provider-agnostic; reuse the Claude adapter's builder so
// both providers aim the executor at the same outcome + verifications + learnings.
import { buildExecutorPrompt } from './claude';
import { codexMcpArgs } from '../../mcp/index';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContext,
  ExecutorInput,
  ExecutorResult,
  ExecutorUsage,
  McpServerConfig,
} from '../executor';
import type { OutcomeSpec } from '../../relay-state/index';

// The cost guardrail (design §8, M4), mirroring `DEFAULT_CLAUDE_MODEL`: with no
// per-role override the adapter pins Codex's cheapest model so dev/eval spend
// stays bounded. A default, not auto-routing (Rule 5). Pinned from the account's
// model list at build time (`gpt-5.4-mini` — "Small, fast, and cost-efficient
// model for simpler coding tasks"); `CodexAdapterOptions.model` is the single knob
// that raises it, the same per-role pattern the Claude adapter established.
export const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';

export interface CodexAdapterOptions {
  // Concrete model id; omitted pins the cost-guardrail default
  // (`DEFAULT_CODEX_MODEL`), never the CLI's own (pricier) default.
  model?: string;
  // The `codex` binary; defaults to the one on PATH.
  bin?: string;
}

// Build the full `codex exec` argv for one dispatch. Pulled out of `run` so the
// cost-guardrail default (the `--model` flag is ALWAYS present) is testable
// without spawning the CLI, paralleling `buildClaudeArgs`. The resolved model is
// either the caller's override or `DEFAULT_CODEX_MODEL`, never the CLI default.
// `--skip-git-repo-check` is safe here: the worktree is always a git tree before
// dispatch — `establishBaseline` git-inits the empty path, and the checkout path is
// already a worktree of the operator repo — so the flag only keeps the run robust
// to that repo's state. Granted MCP servers are routed in as `-c mcp_servers.*` config
// overrides (Codex's grant path is config, not a single flag like Claude). The
// prompt is the trailing positional argument.
export function buildCodexArgs(
  spec: OutcomeSpec,
  context: ExecutorContext,
  config: { model: string; mcpServers: readonly McpServerConfig[] },
): string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--model',
    config.model,
    ...codexMcpArgs(config.mcpServers),
    buildExecutorPrompt(spec, context),
  ];
}

// The fields the adapter pulls out of the JSONL event stream. `codex exec --json`
// does not name the model in any event, so `model` is always `null` here and the
// adapter fills it from the resolved `--model` it dispatched with.
export interface ParsedCodexStream {
  model: string | null;
  // The stream's final `agent_message` text — the bounded self-report.
  selfReport: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  // Always `null`: Codex reports tokens, not dollars; the price-table derivation
  // is Phase 6 (design §8).
  costUsd: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Parse the `codex exec --json` JSONL. The stream is one JSON event per line; the
// load-bearing events are `item.completed` with an `agent_message` item (the
// model's prose — the LAST one is the bounded self-report) and the terminal
// `turn.completed` (carries the turn's token `usage`). A non-JSON line is skipped
// defensively, but a stream with no `turn.completed` is a hard error — a truncated
// run is never silently read as a clean one (Rule 11).
export function parseCodexStream(stdout: string): ParsedCodexStream {
  let selfReport = '';
  let usage: Record<string, unknown> | null = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let obj: Record<string, unknown> | null;
    try {
      obj = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!obj) continue;
    if (obj.type === 'item.completed') {
      const item = asRecord(obj.item);
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        // Keep the latest agent message; the final one is the run's summary.
        selfReport = item.text;
      }
    } else if (obj.type === 'turn.completed') {
      usage = asRecord(obj.usage);
    }
  }

  if (!usage) {
    throw new Error('codex exec --json carried no turn.completed line');
  }

  // Codex's `input_tokens` is the TOTAL prompt tokens, of which
  // `cached_input_tokens` were served from cache. Split them so the adapter's
  // `inputTokens` means uncached input — the same shape the Claude adapter
  // produces (uncached input + a separate cached bucket).
  const totalInput = numberOr(usage.input_tokens, 0);
  const cached = numberOr(usage.cached_input_tokens, 0);
  return {
    model: null,
    selfReport,
    inputTokens: Math.max(0, totalInput - cached),
    cachedInputTokens: cached,
    outputTokens: numberOr(usage.output_tokens, 0),
    costUsd: null,
  };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCodex(bin: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // stdin is ignored: with a piped/non-tty stdin, `codex exec` appends it as a
    // `<stdin>` block and waits on it. `/dev/null` gives an immediate EOF so a
    // spawned run never hangs reading input it was not given.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function codexExecutor(opts: CodexAdapterOptions = {}): Executor {
  const bin = opts.bin ?? 'codex';

  const capabilities = (): ExecutorCapabilities => ({
    provider: 'codex',
    json: true,
    resume: true,
    sandbox: true,
    // Codex grants MCP through config (`-c mcp_servers.*`), routed by the spine's
    // MCP host; the grant is honored, so the capability is reported truthfully.
    mcp: true,
  });

  return {
    capabilities,
    async run(input: ExecutorInput): Promise<ExecutorResult> {
      const { spec, context, worktree, mcpServers, baseRef } = input;
      await mkdir(worktree, { recursive: true });
      // Baseline before dispatch so the captured diff is exactly what the model
      // produced this attempt (the orchestrator discards the worktree between
      // attempts, so each run re-baselines a clean tree). A pre-seeded checkout
      // (`baseRef` set) is already at the base, so this is a no-op there.
      await establishBaseline(worktree, { preseeded: baseRef !== undefined });

      // Cost guardrail: with no explicit override, pin the cheapest model.
      const model = opts.model ?? DEFAULT_CODEX_MODEL;
      const args = buildCodexArgs(spec, context, { model, mcpServers });

      const start = Date.now();
      const { code, stdout } = await runCodex(bin, args, worktree);
      const wallClockMs = Date.now() - start;

      const parsed = parseCodexStream(stdout);
      // Capture the produced change AFTER the run, from the worktree — never from
      // the model's narrative (which the critic must not see anyway, C7). On a
      // checkout, diff against the per-run base (HEAD may have moved if the model
      // committed); otherwise against the baseline commit.
      const diff = await captureDiff(worktree, baseRef);

      const usage: ExecutorUsage = {
        provider: 'codex',
        // The stream never names the model; the resolved `--model` is ground truth.
        model: parsed.model ?? model,
        inputTokens: parsed.inputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
        outputTokens: parsed.outputTokens,
        wallClockMs,
        costUsd: parsed.costUsd,
      };

      return {
        diff,
        selfReport: parsed.selfReport,
        usage,
        exitStatus: code,
      };
    },
  };
}
