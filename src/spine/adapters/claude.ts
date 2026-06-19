// The Claude executor adapter (design §5, F5). Drives `claude -p --output-format
// stream-json --verbose` in the leaf's sandbox worktree, parses the JSONL stream
// for a compact self-report and per-call usage, and reads back the produced change
// as a git diff. It implements the same `Executor` contract as the stubs, so the
// orchestrator loop never special-cases the provider.
//
// Two audiences come out of one run (the C7 split the projection later enforces):
//   - critic-visible: the `diff` (produced change) — captured from the worktree,
//     never from the model's narrative;
//   - orchestrator-visible: the `selfReport` — the stream's final `result` text,
//     a bounded summary, NOT the transcript (the "bounded reflection" the phase
//     calls for).
//
// The real code-owned MCP tool loop is Phase 4; `mcpServers` is threaded into the
// CLI here so the surface is stable, but the orchestrator passes none yet.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { captureDiff, establishBaseline } from './worktree-diff';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorInput,
  ExecutorResult,
  ExecutorUsage,
  McpServerConfig,
} from '../executor';
import type { ExecutorContext } from '../executor';
import type { OutcomeSpec } from '../../relay-state/index';

// The cost guardrail (design §8, M4): with no per-role override the adapter pins
// Claude's cheapest model so dev/eval spend stays bounded. A default, not
// auto-routing (Rule 5) — `ClaudeAdapterOptions.model` is the single knob that
// raises it, and the later Codex adapter reuses the same per-role pattern.
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';

export interface ClaudeAdapterOptions {
  // Concrete model alias/name; omitted pins the cost-guardrail default
  // (`DEFAULT_CLAUDE_MODEL`), never the CLI's own (pricier) default.
  model?: string;
  // Tools the executor may use inside its sandbox. Defaults to the editing +
  // inspection set; `-p` is non-interactive, so anything not allowed is denied
  // rather than prompted.
  allowedTools?: readonly string[];
  // The `claude` binary; defaults to the one on PATH.
  bin?: string;
}

const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Glob',
  'Grep',
];

// Render the unit + carried context into a single prompt. Kept compact and
// declarative: the outcome to achieve, how it will be verified (so the executor
// aims at the critic's bar), and the prior learnings so it does not relearn them.
export function buildExecutorPrompt(spec: OutcomeSpec, context: ExecutorContext): string {
  const lines: string[] = [
    'Achieve the following outcome by editing files in the current working directory.',
    '',
    `Outcome: ${spec.outcome}`,
  ];
  if (spec.verifications.length > 0) {
    lines.push('', 'It will be verified by:');
    for (const v of spec.verifications) {
      lines.push(`- [${v.kind}] ${v.check} (grounding: ${v.grounding})`);
    }
  }
  if (context.learnings.length > 0) {
    lines.push('', 'Prior attempts established (do not relearn):');
    for (const l of context.learnings) {
      lines.push(`- ${l}`);
    }
  }
  return lines.join('\n');
}

// `--mcp-config` accepts a JSON document of server definitions. Threaded for
// Phase 4; an empty list contributes no flag.
function mcpConfigArg(servers: readonly McpServerConfig[]): string {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const s of servers) {
    mcpServers[s.name] = { command: s.command, args: s.args ?? [] };
  }
  return JSON.stringify({ mcpServers });
}

// Build the full `claude -p` argv for one dispatch. Pulled out of `run` so the
// cost-guardrail default (the `--model` flag is ALWAYS present) is testable
// without spawning the CLI. `--model` is unconditional: the resolved model is
// either the caller's override or `DEFAULT_CLAUDE_MODEL`, never the CLI default.
export function buildClaudeArgs(
  spec: OutcomeSpec,
  context: ExecutorContext,
  config: {
    model: string;
    allowedTools: readonly string[];
    mcpServers: readonly McpServerConfig[];
  },
): string[] {
  const args = [
    '-p',
    buildExecutorPrompt(spec, context),
    '--output-format',
    'stream-json',
    '--verbose',
    // The worktree is the sandbox boundary; auto-accept so a non-interactive run
    // can make its change without a hanging permission prompt. A real OS sandbox
    // is a later milestone.
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    ...config.allowedTools,
    '--model',
    config.model,
  ];
  if (config.mcpServers.length > 0) {
    args.push('--mcp-config', mcpConfigArg(config.mcpServers), '--strict-mcp-config');
  }
  return args;
}

// The fields the adapter pulls out of the JSONL stream. `model` comes from the
// `system/init` line; everything else from the terminal `result` line.
export interface ParsedClaudeStream {
  model: string | null;
  // The stream's final `result` text — the bounded self-report.
  selfReport: string;
  isError: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Parse the `claude -p --output-format stream-json --verbose` JSONL. The stream is
// one JSON object per line; the load-bearing lines are `system/init` (model) and
// the terminal `result` (final text + usage + `total_cost_usd`). A line that is
// not JSON is skipped defensively, but a stream with no `result` line is a hard
// error — we never silently treat a truncated run as a clean one (Rule 11).
export function parseClaudeStream(stdout: string): ParsedClaudeStream {
  let model: string | null = null;
  let result: Record<string, unknown> | null = null;

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
    if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.model === 'string') {
      model = obj.model;
    } else if (obj.type === 'result') {
      result = obj;
    }
  }

  if (!result) {
    throw new Error('claude stream-json carried no result line');
  }

  const usage = asRecord(result.usage) ?? {};
  const cacheRead = numberOr(usage.cache_read_input_tokens, 0);
  const cacheCreate = numberOr(usage.cache_creation_input_tokens, 0);
  const cost = result.total_cost_usd;

  return {
    model,
    selfReport: typeof result.result === 'string' ? result.result : '',
    isError: result.is_error === true,
    inputTokens: numberOr(usage.input_tokens, 0),
    // Both cache-served buckets (created and read) are input tokens that went
    // through the prompt cache; folded together so no token bucket is dropped.
    cachedInputTokens: cacheRead + cacheCreate,
    outputTokens: numberOr(usage.output_tokens, 0),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runClaude(bin: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function claudeExecutor(opts: ClaudeAdapterOptions = {}): Executor {
  const bin = opts.bin ?? 'claude';
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;

  const capabilities = (): ExecutorCapabilities => ({
    provider: 'claude',
    json: true,
    resume: true,
    sandbox: true,
    mcp: true,
  });

  return {
    capabilities,
    async run(input: ExecutorInput): Promise<ExecutorResult> {
      const { spec, context, worktree, mcpServers } = input;
      await mkdir(worktree, { recursive: true });
      // Baseline before dispatch so the captured diff is exactly what the model
      // produced this attempt (the orchestrator discards the worktree between
      // attempts, so each run re-baselines a clean tree).
      await establishBaseline(worktree);

      // Cost guardrail: with no explicit override, pin the cheapest model.
      const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
      const args = buildClaudeArgs(spec, context, { model, allowedTools, mcpServers });

      const start = Date.now();
      const { code, stdout } = await runClaude(bin, args, worktree);
      const wallClockMs = Date.now() - start;

      const parsed = parseClaudeStream(stdout);
      // Capture the produced change AFTER the run, from the worktree — never from
      // the model's narrative (which the critic must not see anyway, C7).
      const diff = await captureDiff(worktree);

      const usage: ExecutorUsage = {
        provider: 'claude',
        model: parsed.model,
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
