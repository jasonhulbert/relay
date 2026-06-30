import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CLAUDE_MODEL,
  SIZE_SIGNAL_TOO_BIG_MARKER,
  buildClaudeArgs,
  buildExecutorPrompt,
  claudeExecutor,
  parseClaudeStream,
} from './claude';
import type { OutcomeSpec } from '../../relay-state/index';

// A representative `claude -p --output-format stream-json --verbose` capture: the
// `system/init` line (carries the model), some assistant/tool transcript lines the
// parser must IGNORE, and the terminal `result` line (final text + usage +
// total_cost_usd). Trimmed from a real run so the parser is pinned to the actual
// shape, not an invented one.
const SAMPLE_STREAM = [
  JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }),
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8', cwd: '/tmp/wt' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: "I'll create the file now." }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'hello.txt' } }] },
  }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 6762,
    result: 'Done. Created `hello.txt` containing `hi from relay`.',
    total_cost_usd: 0.124058,
    usage: {
      input_tokens: 4204,
      cache_creation_input_tokens: 8235,
      cache_read_input_tokens: 35126,
      output_tokens: 125,
    },
  }),
].join('\n');

// WHY: per-call usage attribution and the evidence-only-critic split both ride on
// this parse. The orchestrator must get the model's COMPACT final summary as the
// self-report — not the transcript that precedes it — and faithful per-call
// token/cost numbers, or cost attribution is built on fiction. A parser that
// returned a transcript line, or dropped a token bucket, would defeat both. These
// pin exactly that.
describe('parseClaudeStream', () => {
  test('extracts the compact self-report, model, tokens, and direct cost', () => {
    const p = parseClaudeStream(SAMPLE_STREAM);

    expect(p.model).toBe('claude-opus-4-8');
    // The self-report is the terminal `result` text — bounded, not the transcript.
    expect(p.selfReport).toBe('Done. Created `hello.txt` containing `hi from relay`.');
    expect(p.selfReport).not.toContain("I'll create the file now.");
    expect(p.selfReport).not.toContain('tool_use');

    expect(p.inputTokens).toBe(4204);
    // Both cache buckets (creation + read) fold into cachedInputTokens.
    expect(p.cachedInputTokens).toBe(8235 + 35126);
    expect(p.outputTokens).toBe(125);
    // Claude reports dollars directly; the adapter takes them as ground truth.
    expect(p.costUsd).toBe(0.124058);
    expect(p.isError).toBe(false);
  });

  test('tolerates non-JSON noise lines but fails loud on a result-less stream', () => {
    const withNoise = `warning: something to stderr-ish\n${SAMPLE_STREAM}`;
    expect(parseClaudeStream(withNoise).outputTokens).toBe(125);

    // A truncated run (no result line) must throw, never be read as a clean zero.
    const truncated = SAMPLE_STREAM.split('\n').slice(0, 3).join('\n');
    expect(() => parseClaudeStream(truncated)).toThrow(/no result line/);
  });

  test('reports null cost when the stream omits total_cost_usd', () => {
    const noCost = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }),
      JSON.stringify({
        type: 'result',
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ].join('\n');
    expect(parseClaudeStream(noCost).costUsd).toBeNull();
  });
});

describe('buildExecutorPrompt', () => {
  test('carries the outcome, its verifications, and prior learnings', () => {
    const spec: OutcomeSpec = {
      outcome: 'create hello.txt with the greeting',
      verifications: [{ kind: 'command', grounding: 'file exists', check: 'test -f hello.txt' }],
    };
    const prompt = buildExecutorPrompt(spec, { learnings: ['an earlier attempt over-scoped it'] });

    expect(prompt).toContain('create hello.txt with the greeting');
    expect(prompt).toContain('[command] test -f hello.txt');
    expect(prompt).toContain('an earlier attempt over-scoped it');
  });

  test('instructs oversized leaves to emit the exact promotion marker', () => {
    const spec: OutcomeSpec = { outcome: 'do the too-large thing', verifications: [] };
    const prompt = buildExecutorPrompt(spec, { learnings: [] });

    expect(prompt).toContain('too large to complete as one unit');
    expect(prompt).toContain(SIZE_SIGNAL_TOO_BIG_MARKER);
  });
});

// WHY: reactive promotion depends on the real adapter turning a bounded self-report
// marker into the structured `sizeSignal` the orchestrator already consumes. A parser
// that preserves the prose but drops the signal would leave real Claude runs unable to
// self-repair an overlarge leaf.
describe('claudeExecutor size signal', () => {
  async function runFakeClaude(finalSelfReport: string) {
    const base = await mkdtemp(join(tmpdir(), 'relay-claude-size-signal-'));
    const bin = join(base, 'fake-claude.mjs');
    const worktree = join(base, 'wt');
    const streamLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: finalSelfReport,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    await writeFile(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(streamLine)});\n`);
    await chmod(bin, 0o755);
    try {
      const result = await claudeExecutor({ bin }).run({
        spec: { outcome: 'do a thing', verifications: [] },
        context: { learnings: [] },
        worktree,
        mcpServers: [],
      });
      return result.sizeSignal;
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  test('maps the exact final self-report marker line to too-big', async () => {
    await expect(
      runFakeClaude(`This leaf needs decomposition.\n${SIZE_SIGNAL_TOO_BIG_MARKER}`),
    ).resolves.toBe('too-big');
  });

  test('leaves sizeSignal undefined when the marker is absent', async () => {
    await expect(runFakeClaude('Done. Created the file.')).resolves.toBeUndefined();
  });
});

// WHY: the cost guardrail is "cheapest model unless overridden." The
// `--model` flag must ALWAYS be present (never the CLI's pricier default), pinned
// to DEFAULT_CLAUDE_MODEL by default and to the override when one is given — that
// single knob is what bounds dev/eval spend.
describe('buildClaudeArgs cost guardrail', () => {
  const spec: OutcomeSpec = { outcome: 'do a thing', verifications: [] };
  const ctx = { learnings: [] as string[] };

  test('pins the cheapest model by default and honors an override', () => {
    const def = buildClaudeArgs(spec, ctx, {
      model: DEFAULT_CLAUDE_MODEL,
      allowedTools: ['Read'],
      mcpServers: [],
    });
    const i = def.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(def[i + 1]).toBe('claude-haiku-4-5');

    const overridden = buildClaudeArgs(spec, ctx, {
      model: 'claude-opus-4-8',
      allowedTools: ['Read'],
      mcpServers: [],
    });
    expect(overridden[overridden.indexOf('--model') + 1]).toBe('claude-opus-4-8');
  });

  // WHY: the workspace substrate closes the unconfined-write escape. The former
  // `--permission-mode bypassPermissions` skipped ALL permission checks, so an outcome
  // naming an absolute path could write outside the worktree sandbox. The argv must now
  // carry the worktree-scoped `acceptEdits` posture (symmetric to Codex's
  // `workspace-write`) and NEVER `bypassPermissions` — this pins that the escape stays
  // closed regardless of model/MCP config.
  test('carries the worktree-scoped acceptEdits posture, never bypassPermissions', () => {
    const args = buildClaudeArgs(spec, ctx, {
      model: DEFAULT_CLAUDE_MODEL,
      allowedTools: ['Read', 'Write'],
      mcpServers: [],
    });
    expect(args).not.toContain('bypassPermissions');
    const i = args.indexOf('--permission-mode');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('acceptEdits');
  });

  test('only adds --mcp-config when servers are granted', () => {
    const none = buildClaudeArgs(spec, ctx, {
      model: DEFAULT_CLAUDE_MODEL,
      allowedTools: ['Read'],
      mcpServers: [],
    });
    expect(none).not.toContain('--mcp-config');

    const withMcp = buildClaudeArgs(spec, ctx, {
      model: DEFAULT_CLAUDE_MODEL,
      allowedTools: ['Read'],
      mcpServers: [{ name: 's', command: 'srv' }],
    });
    expect(withMcp).toContain('--mcp-config');
    expect(withMcp).toContain('--strict-mcp-config');
  });
});

describe('claudeExecutor capabilities', () => {
  test('reports json/resume/sandbox/mcp support', () => {
    const caps = claudeExecutor().capabilities();
    expect(caps).toEqual({
      provider: 'claude',
      json: true,
      resume: true,
      sandbox: true,
      mcp: true,
    });
  });
});

// Gated real-CLI test (the phase's headline validation): a real `claude -p` leaf
// returns a parsed diff and a compact self-report. It hits the network, costs
// money, and is slow, so it is opt-in via RELAY_E2E=1; the parser tests above are
// the hermetic guard that runs in CI.
describe.skipIf(!process.env.RELAY_E2E)('claudeExecutor end-to-end (real CLI)', () => {
  test('a real leaf produces a captured diff and a bounded self-report', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-claude-e2e-'));
    const worktree = join(base, 'wt');
    try {
      const spec: OutcomeSpec = {
        outcome: 'Create a file named hello.txt containing exactly the text: hi from relay',
        verifications: [
          { kind: 'command', grounding: 'the file exists', check: 'test -f hello.txt' },
        ],
      };
      const result = await claudeExecutor().run({
        spec,
        context: { learnings: [] },
        worktree,
        mcpServers: [],
      });

      // The produced change was captured from the worktree as a real diff.
      expect(result.exitStatus).toBe(0);
      expect(result.diff).toContain('hello.txt');
      expect(result.diff).toContain('hi from relay');

      // The self-report is a bounded summary, not the JSONL transcript.
      expect(result.selfReport.length).toBeGreaterThan(0);
      expect(result.selfReport).not.toContain('"type":');

      // Usage was parsed from the stream.
      expect(result.usage.provider).toBe('claude');
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.wallClockMs).toBeGreaterThan(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);
});
