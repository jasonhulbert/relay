// The real cross-provider critic (design §3.6, §6.1) — the gate on done-ness this
// milestone makes real. It is an INDEPENDENT agent: a different provider than the
// author by default, that did not do the work, handed ONLY the C7 critic-visible
// projection (spec + diff + evidence) and never the executor's self-report. Its
// integrity is structural, not prompted: the projection withheld the narrative
// before this code ran.
//
// One critic stage, the §6.3 kinds composed cheapest-first:
//   1. run the declared DETERMINISTIC kinds (command/test/artifact) in code
//      (verify.ts, Rule 5). A declared check that fails is ground truth — short-
//      circuit to FAIL without paying for a model (cheapest-first);
//   2. otherwise spawn the cross-provider model (`agent-critic` kind, §6.3 #6) over
//      the projection plus those deterministic results, and parse its verdict
//      deterministically (the model judges; code reads the answer, Rule 5).
//
// Cost guardrail (design §8): the critic defaults to the provider's cheapest model,
// the same per-role knob the executor adapters use. The critic is granted
// `mcp_servers` exactly as the executor is (§3.252, C9); the real code-owned MCP
// loop that populates the grant is Phase 5 (today it is empty).
import { spawn } from 'node:child_process';
import { DEFAULT_CLAUDE_MODEL, parseClaudeStream } from './adapters/claude';
import { DEFAULT_CODEX_MODEL, parseCodexStream } from './adapters/codex';
import { claudeMcpArgs, codexMcpArgs } from '../mcp/index';
import { runDeterministicVerifications } from './verify';
import type { VerificationResult } from './verify';
import type { ExecutorUsage } from './executor';
import type {
  CriticContext,
  CriticSpawn,
  CriticVerdict,
  CriticView,
  McpServerConfig,
} from '../relay-state/index';

export type CriticProvider = 'claude' | 'codex';

export interface AgentCriticOptions {
  // Which provider renders the verdict. The orchestrator/harness picks the
  // not-the-author provider by default (design §3.6); this is that resolved choice.
  provider: CriticProvider;
  // Per-role cost-guardrail knob (design §8). Omitted pins the provider's cheapest
  // model — never the CLI's pricier default — mirroring the executor adapters.
  model?: string;
  // The provider binary; defaults to the one on PATH.
  bin?: string;
  // Injectable CLI runner so the critic is exercisable without the real model
  // (hermetic tests). Defaults to spawning `bin` with the built argv.
  invoke?: (call: CriticInvocation) => Promise<CriticInvocationResult>;
  // Observe each critic model call's usage (F5). The harness records it into the
  // same per-call sink as the executor so the recap surfaces it; node-attributed
  // usage and rollups are Phase 6.
  onUsage?: (usage: ExecutorUsage) => void;
}

export interface CriticInvocation {
  bin: string;
  args: string[];
  cwd: string;
}

export interface CriticInvocationResult {
  stdout: string;
  code: number;
}

// Render the critic prompt from the projection plus the deterministic grounding.
// Pure and exported so the prompt is testable without a model — and so a test can
// assert it carries NO narrative (the C7 guarantee re-checked on the real path):
// it only ever reads `view.spec`, `view.diff`, and the verification results, never
// a self-report or learnings (the projection has none to read).
export function buildCriticPrompt(
  view: CriticView,
  results: readonly VerificationResult[],
): string {
  const lines: string[] = [
    'You are an INDEPENDENT critic. You did NOT write the change below, and you must',
    'not assume its author succeeded — a confident change can still be wrong. Decide',
    'whether the outcome was actually achieved, judging ONLY the evidence given: the',
    'produced diff and the verification results. Cite the evidence for your decision.',
    '',
    `Outcome to verify: ${view.spec.outcome}`,
  ];
  if (view.spec.verifications.length > 0) {
    lines.push('', 'Declared verifications:');
    for (const v of view.spec.verifications) {
      lines.push(`- [${v.kind}] ${v.check} (grounding: ${v.grounding})`);
    }
  }
  lines.push('', 'Deterministic verification results (run by the harness on the produced change):');
  if (results.length === 0) {
    lines.push('- (none — no deterministic check was declared)');
  } else {
    for (const r of results) {
      lines.push(`- [${r.kind}] ${r.check}: ${r.pass ? 'PASS' : 'FAIL'} (${r.detail})`);
    }
  }
  lines.push(
    '',
    'Produced change (unified diff):',
    '```diff',
    view.diff === '' ? '(empty diff — no change was produced)' : view.diff,
    '```',
    '',
    'Give a short rationale grounded in the evidence above, then end with a final',
    'line that is EXACTLY one of:',
    'VERDICT: PASS',
    'VERDICT: FAIL',
  );
  return lines.join('\n');
}

// Deterministic read of the model's verdict (Rule 5: the model judges, code parses
// the answer). The LAST `VERDICT:` line wins, so trailing restatements are safe; an
// absent or unparseable verdict returns null and the caller fails loud (Rule 11)
// rather than guessing a pass.
export function parseCriticVerdict(text: string): boolean | null {
  let verdict: boolean | null = null;
  for (const raw of text.split('\n')) {
    const m = /^\s*VERDICT:\s*(PASS|FAIL)\b/i.exec(raw);
    if (m) verdict = m[1].toUpperCase() === 'PASS';
  }
  return verdict;
}

// Build the read-only review argv for the provider. The critic must not mutate the
// produced change, so Claude gets only inspection tools and Codex runs
// `--sandbox read-only`. The model is always pinned (cost guardrail), never the
// CLI default.
function buildCriticArgs(
  provider: CriticProvider,
  prompt: string,
  config: { model: string; mcpServers: readonly McpServerConfig[] },
): string[] {
  if (provider === 'claude') {
    return [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      // Read-only: the independent critic inspects, it never edits the change.
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      '--model',
      config.model,
      // The spine (MCP host) routes the granted server fleet into the critic's
      // config, exactly as it does the executor's; empty grant → no flags.
      ...claudeMcpArgs(config.mcpServers),
    ];
  }
  // Codex: read-only sandbox; granted MCP servers ride as `-c mcp_servers.*` config
  // overrides; the prompt is the trailing positional argument.
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--model',
    config.model,
    ...codexMcpArgs(config.mcpServers),
    prompt,
  ];
}

function defaultInvoke(call: CriticInvocation): Promise<CriticInvocationResult> {
  return new Promise((resolve, reject) => {
    // stdin ignored: like the Codex executor, an immediate EOF keeps a piped run
    // from blocking on input it was not given.
    const child = spawn(call.bin, call.args, { cwd: call.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

// Parse the provider stream into the critic's review text + per-call usage, reusing
// the executor adapters' stream parsers (one stream shape per provider, shared).
function parseProviderStream(
  provider: CriticProvider,
  stdout: string,
  model: string,
  wallClockMs: number,
): { review: string; usage: ExecutorUsage } {
  if (provider === 'claude') {
    const p = parseClaudeStream(stdout);
    return {
      review: p.selfReport,
      usage: {
        provider: 'claude',
        model: p.model ?? model,
        inputTokens: p.inputTokens,
        cachedInputTokens: p.cachedInputTokens,
        outputTokens: p.outputTokens,
        wallClockMs,
        costUsd: p.costUsd,
      },
    };
  }
  const p = parseCodexStream(stdout);
  return {
    review: p.selfReport,
    usage: {
      provider: 'codex',
      model: p.model ?? model,
      inputTokens: p.inputTokens,
      cachedInputTokens: p.cachedInputTokens,
      outputTokens: p.outputTokens,
      wallClockMs,
      costUsd: p.costUsd,
    },
  };
}

// Build the real cross-provider critic as a `CriticSpawn` (the C7-typed path: only a
// constructed `CriticView` can reach it). The deterministic kinds run first against
// the produced-change worktree; the cross-provider model renders the verdict on the
// projection only.
export function agentCritic(opts: AgentCriticOptions): CriticSpawn {
  const provider = opts.provider;
  const bin = opts.bin ?? provider;
  const model = opts.model ?? (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL);
  const invoke = opts.invoke ?? defaultInvoke;

  return async (view: CriticView, ctx: CriticContext): Promise<CriticVerdict> => {
    // Cheapest-first (§6.3): the deterministic kinds are ground truth. A declared
    // check that fails settles done-ness without spending a model call.
    const results = await runDeterministicVerifications(view.spec.verifications, ctx.worktree);
    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      const why = failed.map((r) => `[${r.kind}] ${r.check} (${r.detail})`).join('; ');
      return {
        pass: false,
        provider,
        rationale: `deterministic verification failed before model review: ${why}`,
        evidenceRefs: [],
      };
    }

    // The independent agent stage (§6.1, §6.3 #6): the cross-provider model judges
    // the projection. The prompt is built from the view + deterministic grounding —
    // structurally no narrative can ride in.
    const prompt = buildCriticPrompt(view, results);
    const args = buildCriticArgs(provider, prompt, { model, mcpServers: ctx.mcpServers });
    const start = Date.now();
    const { stdout } = await invoke({ bin, args, cwd: ctx.worktree });
    const wallClockMs = Date.now() - start;
    const { review, usage } = parseProviderStream(provider, stdout, model, wallClockMs);
    opts.onUsage?.(usage);

    const parsed = parseCriticVerdict(review);
    if (parsed === null) {
      // No machine-readable verdict: do not guess a pass (Rule 11).
      return {
        pass: false,
        provider,
        rationale: `critic returned no parseable VERDICT line; review: ${review.slice(0, 500)}`,
        evidenceRefs: [],
      };
    }
    return { pass: parsed, provider, rationale: review, evidenceRefs: [] };
  };
}
