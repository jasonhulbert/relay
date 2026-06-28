import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CODEX_MODEL, buildCodexArgs, codexExecutor, parseCodexStream } from './codex';
import { SIZE_SIGNAL_TOO_BIG_MARKER } from './claude';
import type { OutcomeSpec } from '../../relay-state/index';

// A representative `codex exec --json` capture, trimmed from a real run so the
// parser is pinned to the actual event shape, not an invented one: the
// `thread.started`/`turn.started` framing, intermediate `agent_message` and
// tool items the parser must handle, the FINAL `agent_message` (the bounded
// self-report), and the terminal `turn.completed` (carries the token `usage`).
const SAMPLE_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: '019ee1b6-2e85-76e0' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.started', item: { id: '0', type: 'agent_message' } }),
  // An intermediate agent message — NOT the self-report (a later one supersedes it).
  JSON.stringify({
    type: 'item.completed',
    item: { id: '0', type: 'agent_message', text: "I'll create the file now." },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: '1', type: 'file_change', changes: [{ path: 'hello.txt' }], status: 'completed' },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: '2',
      type: 'command_execution',
      command: "printf 'hi' > hello.txt",
      exit_code: 0,
      status: 'completed',
    },
  }),
  // The terminal agent message: the bounded summary the orchestrator reads.
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: '3',
      type: 'agent_message',
      text: 'Done. Created `hello.txt` containing `hi from relay`.',
    },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 73354,
      cached_input_tokens: 61824,
      output_tokens: 2371,
      reasoning_output_tokens: 2040,
    },
  }),
].join('\n');

// WHY: per-call usage attribution and the evidence-only-critic split both ride on
// this parse. The orchestrator must get the model's COMPACT final summary as the
// self-report — not an earlier message or the tool transcript — and faithful
// per-call token numbers split into uncached vs cached the same way the Claude
// adapter reports them, or cost attribution and provider-agnostic usage are built
// on fiction.
describe('parseCodexStream', () => {
  test('extracts the final agent message and splits cached input tokens', () => {
    const p = parseCodexStream(SAMPLE_STREAM);

    // The self-report is the LAST agent_message — bounded, not the earlier message
    // and not the tool transcript.
    expect(p.selfReport).toBe('Done. Created `hello.txt` containing `hi from relay`.');
    expect(p.selfReport).not.toContain("I'll create the file now.");
    expect(p.selfReport).not.toContain('command_execution');

    // Codex's `input_tokens` is the TOTAL; the cached subset is split out so
    // `inputTokens` means uncached, matching the Claude adapter's shape.
    expect(p.inputTokens).toBe(73354 - 61824);
    expect(p.cachedInputTokens).toBe(61824);
    expect(p.outputTokens).toBe(2371);
    // Codex reports tokens, not dollars — the price-table derivation is not yet built.
    expect(p.costUsd).toBeNull();
    // The stream never names the model; the adapter fills it from `--model`.
    expect(p.model).toBeNull();
  });

  test('tolerates non-JSON noise but fails loud on a stream with no turn.completed', () => {
    const withNoise = `some non-json banner line\n${SAMPLE_STREAM}`;
    expect(parseCodexStream(withNoise).outputTokens).toBe(2371);

    // A truncated run (no turn.completed) must throw, never read as a clean zero.
    const truncated = SAMPLE_STREAM.split('\n').slice(0, 5).join('\n');
    expect(() => parseCodexStream(truncated)).toThrow(/no turn.completed line/);
  });
});

// WHY: the cost guardrail is "cheapest model unless overridden," mirrored from
// the Claude adapter. The `--model` flag must ALWAYS be present (never the CLI's
// pricier default), pinned to DEFAULT_CODEX_MODEL by default and to the override
// when one is given — that single knob is what bounds dev/eval spend.
describe('buildCodexArgs cost guardrail', () => {
  const spec: OutcomeSpec = { outcome: 'do a thing', verifications: [] };
  const ctx = { learnings: [] as string[] };

  test('pins the cheapest model by default and honors an override', () => {
    const def = buildCodexArgs(spec, ctx, { model: DEFAULT_CODEX_MODEL, mcpServers: [] });
    const i = def.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(def[i + 1]).toBe('gpt-5.4-mini');

    const overridden = buildCodexArgs(spec, ctx, { model: 'gpt-5.5', mcpServers: [] });
    expect(overridden[overridden.indexOf('--model') + 1]).toBe('gpt-5.5');
  });

  test('drives the documented non-interactive JSONL exec surface', () => {
    const args = buildCodexArgs(spec, ctx, { model: DEFAULT_CODEX_MODEL, mcpServers: [] });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'workspace-write',
    ]);
    // The prompt is the trailing positional argument (after every flag).
    expect(args[args.length - 1]).toContain('do a thing');
    expect(args[args.length - 1]).toContain(SIZE_SIGNAL_TOO_BIG_MARKER);
  });

  // WHY: Codex's MCP grant is wired through config (`-c mcp_servers.*`), not a
  // single flag like Claude. A granted server must appear as the dotted config
  // overrides Codex parses as TOML, so the agent can connect to the spine-hosted
  // server as a client.
  test('routes a granted MCP server through `-c mcp_servers.*` config overrides', () => {
    const args = buildCodexArgs(spec, ctx, {
      model: DEFAULT_CODEX_MODEL,
      mcpServers: [{ name: 'probe', command: 'srv', args: ['--flag'] }],
    });
    expect(args).toContain('mcp_servers.probe.command="srv"');
    expect(args).toContain('mcp_servers.probe.args=["--flag"]');
    // The prompt still trails every flag.
    expect(args[args.length - 1]).toContain('do a thing');
  });
});

// WHY: provider parity matters at the adapter boundary. Codex's final agent message
// is the orchestrator-visible self-report, so the exact marker there must become the
// same structured promotion signal Claude emits.
describe('codexExecutor size signal', () => {
  async function runFakeCodex(finalSelfReport: string) {
    const base = await mkdtemp(join(tmpdir(), 'relay-codex-size-signal-'));
    const bin = join(base, 'fake-codex.mjs');
    const worktree = join(base, 'wt');
    const stream = [
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: finalSelfReport },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 },
      }),
    ];
    await writeFile(
      bin,
      `#!/usr/bin/env node\nfor (const line of ${JSON.stringify(stream)}) console.log(line);\n`,
    );
    await chmod(bin, 0o755);
    try {
      const result = await codexExecutor({ bin }).run({
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

  test('maps the exact final agent-message marker line to too-big', async () => {
    await expect(
      runFakeCodex(`This leaf needs decomposition.\n${SIZE_SIGNAL_TOO_BIG_MARKER}`),
    ).resolves.toBe('too-big');
  });

  test('leaves sizeSignal undefined when the marker is absent', async () => {
    await expect(runFakeCodex('Done. Created the file.')).resolves.toBeUndefined();
  });
});

describe('codexExecutor capabilities', () => {
  test('reports json/resume/sandbox/mcp support (the config-routed MCP grant is wired)', () => {
    const caps = codexExecutor().capabilities();
    expect(caps).toEqual({
      provider: 'codex',
      json: true,
      resume: true,
      sandbox: true,
      mcp: true,
    });
  });
});

// Gated real-CLI test (the phase's headline validation): a real `codex exec` leaf
// returns a parsed diff and self-report, on Codex's cheapest model by default. It
// hits the network, costs money, and is slow, so it is opt-in via RELAY_E2E=1; the
// parser tests above are the hermetic guard that runs in CI.
describe.skipIf(!process.env.RELAY_E2E)('codexExecutor end-to-end (real CLI)', () => {
  test('a real leaf produces a captured diff, a bounded self-report, and the cheap model', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-codex-e2e-'));
    const worktree = join(base, 'wt');
    try {
      const spec: OutcomeSpec = {
        outcome: 'Create a file named hello.txt containing exactly the text: hi from relay',
        verifications: [
          { kind: 'command', grounding: 'the file exists', check: 'test -f hello.txt' },
        ],
      };
      const result = await codexExecutor().run({
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

      // Usage parsed from the stream, on the cheapest model by default.
      expect(result.usage.provider).toBe('codex');
      expect(result.usage.model).toBe(DEFAULT_CODEX_MODEL);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.wallClockMs).toBeGreaterThan(0);
      // Codex dollars are price-table-derived (not yet built), so direct cost is null.
      expect(result.usage.costUsd).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);
});
