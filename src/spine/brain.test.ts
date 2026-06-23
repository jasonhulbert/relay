import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  agentBrain,
  buildBrainArgs,
  buildDecomposePrompt,
  parseDecomposition,
  stubBrain,
} from './brain';
import type { BrainContext, DecomposeRequest } from './brain';
import type { ExecutorUsage } from './executor';

const req: DecomposeRequest = {
  spec: {
    outcome: 'build the widget',
    verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
  },
  context: { learnings: ['the parser had an off-by-one'] },
};

const ctx: BrainContext = { worktree: '/tmp/relay-brain', mcpServers: [] };

// A real `claude -p --output-format stream-json` capture whose result text carries
// the decomposition JSON (a fenced block) — enough for parseClaudeStream.
function claudeStream(reviewText: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }),
    JSON.stringify({
      type: 'result',
      result: reviewText,
      is_error: false,
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0 },
      total_cost_usd: 0.0003,
    }),
  ].join('\n');
}

function fencedDecomposition(): string {
  const doc = {
    children: [
      {
        outcome: 'part A: the data layer',
        kind: 'leaf',
        verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
        footprint: { writeGlobs: ['src/data/**'] },
      },
      {
        outcome: 'part B: the UI on top of A',
        kind: 'branch',
        verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
        footprint: { writeGlobs: ['src/ui/**'] },
      },
    ],
    seams: [
      {
        id: 's1',
        kind: 'interface',
        producer: 0,
        consumer: 1,
        intent: 'A publishes the Widget type the UI consumes',
        payload: { symbol: 'Widget' },
      },
    ],
  };
  return `Here is the split:\n\`\`\`json\n${JSON.stringify(doc)}\n\`\`\`\n`;
}

// WHY: the stub brain is the spine's deterministic default — every promotion/branch
// decomposition test relies on it producing the SAME layer so a kill-and-rehydrate
// reproduces identical records. It must mirror the old stub decomposer's 2-leaf
// split AND now carry footprints + a seam (what "decomposing a layer" produces).
describe('stubBrain', () => {
  test('returns a deterministic 2-leaf split with disjoint footprints and one seam', async () => {
    const { decomposition: d, rationale } = await stubBrain.decompose(req, ctx);
    expect(d.children).toHaveLength(2);
    expect(d.children.map((c) => c.kind)).toEqual(['leaf', 'leaf']);
    expect(d.children.map((c) => c.spec.outcome)).toEqual([
      'build the widget (part 1 of 2)',
      'build the widget (part 2 of 2)',
    ]);
    // Children inherit the parent's verifications so a driven child grades the same.
    expect(d.children[0].spec.verifications).toEqual(req.spec.verifications);
    // Disjoint write footprints, and one file-boundary seam between them.
    expect(d.children[0].footprint.writeGlobs).not.toEqual(d.children[1].footprint.writeGlobs);
    expect(d.seams).toHaveLength(1);
    expect(d.seams[0]).toMatchObject({ kind: 'file-boundary', producer: 0, consumer: 1 });
    // The rationale is carried alongside — persisted as audit evidence, never
    // discarded; here it names the outcome it split.
    expect(rationale).toContain(req.spec.outcome);
  });

  test('is byte-identical across calls (rehydration determinism)', async () => {
    const a = await stubBrain.decompose(req, ctx);
    const b = await stubBrain.decompose(req, ctx);
    // The whole result — decomposition AND rationale — is byte-identical, so a
    // kill-and-rehydrate persists identical audit evidence (the rehydration contract).
    expect(a).toEqual(b);
  });
});

// WHY: the model judges, code reads the answer (Rule 5). The parser must extract the
// fenced JSON, classify each child leaf-vs-branch, carry footprints + seams, and —
// critically — FAIL LOUD on anything malformed (Rule 11) rather than commit a
// half-typed layer.
describe('parseDecomposition', () => {
  test('extracts children (leaf/branch), footprints, and seams from a fenced block', () => {
    const d = parseDecomposition(fencedDecomposition());
    expect(d.children.map((c) => c.kind)).toEqual(['leaf', 'branch']);
    expect(d.children[0].footprint.writeGlobs).toEqual(['src/data/**']);
    expect(d.seams[0]).toMatchObject({ kind: 'interface', producer: 0, consumer: 1 });
    expect(d.seams[0].payload).toEqual({ symbol: 'Widget' });
  });

  test('parses bare JSON with no fence', () => {
    const d = parseDecomposition(
      '{"children":[{"outcome":"x","kind":"leaf","verifications":[],"footprint":{"writeGlobs":[]}}],"seams":[]}',
    );
    expect(d.children).toHaveLength(1);
  });

  test('fails loud on no JSON, invalid kind, bad footprint, or out-of-range seam', () => {
    expect(() => parseDecomposition('no json here')).toThrow(/no JSON/i);
    expect(() =>
      parseDecomposition(
        '{"children":[{"outcome":"x","kind":"twig","verifications":[],"footprint":{"writeGlobs":[]}}]}',
      ),
    ).toThrow(/invalid kind/i);
    expect(() =>
      parseDecomposition('{"children":[{"outcome":"x","kind":"leaf","verifications":[]}]}'),
    ).toThrow(/writeGlobs/);
    expect(() =>
      parseDecomposition(
        '{"children":[{"outcome":"x","kind":"leaf","verifications":[],"footprint":{"writeGlobs":[]}}],' +
          '"seams":[{"id":"s","kind":"interface","producer":0,"consumer":5,"intent":"","payload":{}}]}',
      ),
    ).toThrow(/out of range/i);
  });

  test('rejects an empty decomposition', () => {
    expect(() => parseDecomposition('{"children":[]}')).toThrow(/no children/i);
  });
});

// WHY: the brain is an agent connected to the spine's granted MCP servers as a
// client; it inspects to inform the split but never edits. The argv must be
// read-only and must carry the granted grant the spine routed in.
describe('buildBrainArgs', () => {
  test('claude gets read-only tools, a pinned model, and the routed MCP grant', () => {
    const args = buildBrainArgs('claude', 'PROMPT', {
      model: 'claude-haiku-4-5',
      mcpServers: [{ name: 'probe', command: 'srv' }],
    });
    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 4)).toEqual([
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
  });

  test('codex runs a read-only sandbox and routes the grant via `-c mcp_servers.*`', () => {
    const args = buildBrainArgs('codex', 'PROMPT', {
      model: 'gpt-5.4-mini',
      mcpServers: [{ name: 'probe', command: 'srv' }],
    });
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'read-only',
    ]);
    expect(args).toContain('mcp_servers.probe.command="srv"');
    // The prompt is the trailing positional argument.
    expect(args[args.length - 1]).toBe('PROMPT');
  });
});

describe('buildDecomposePrompt', () => {
  test('carries the outcome, the prior learnings, and the JSON schema instruction', () => {
    const prompt = buildDecomposePrompt(req);
    expect(prompt).toContain('build the widget');
    expect(prompt).toContain('off-by-one');
    expect(prompt).toContain('"children"');
    expect(prompt).toContain('leaf');
    expect(prompt).toContain('branch');
  });
});

// WHY: end-to-end through the adapter (hermetic) — a granted brain dispatches with
// the routed grant, parses the model's decomposition, classifies leaf-vs-branch, and
// reports its own per-call usage. It writes nothing durable; the orchestrator commits.
describe('agentBrain', () => {
  test('parses the model decomposition and records the judgment usage', async () => {
    const usages: ExecutorUsage[] = [];
    let seenArgs: string[] = [];
    const brain = agentBrain({
      provider: 'claude',
      invoke: (call) => {
        seenArgs = call.args;
        return Promise.resolve({ stdout: claudeStream(fencedDecomposition()), code: 0 });
      },
      onUsage: (u) => usages.push(u),
    });

    const { decomposition: d, rationale } = await brain.decompose(req, {
      worktree: '/tmp/relay-brain',
      mcpServers: [{ name: 'probe', command: 'srv' }],
    });

    // The leaf-vs-branch classification survived the round trip.
    expect(d.children.map((c) => c.kind)).toEqual(['leaf', 'branch']);
    expect(d.seams).toHaveLength(1);
    // The raw model review is carried out as the rationale, not discarded
    // once parsed — it still contains the fenced JSON the parser read.
    expect(rationale).toContain('```json');
    // The spine routed the grant into the agent's argv.
    expect(seenArgs).toContain('--mcp-config');
    // The judgment's own usage was surfaced for the recap.
    expect(usages).toHaveLength(1);
    expect(usages[0].provider).toBe('claude');
    expect(usages[0].model).toBe('claude-haiku-4-5');
  });
});

// Gated real-CLI test (validation 1, headline): a real `claude -p` brain decomposes
// a real outcome into a layer carrying footprints + seams, on the cheapest model by
// default. Opt-in via RELAY_E2E=1 — it hits the network, costs money, and is slow;
// the hermetic tests above are the CI guard.
describe.skipIf(!process.env.RELAY_E2E)('agentBrain end-to-end (real CLI)', () => {
  test('decomposes a real outcome into children + footprints + seams', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-brain-e2e-'));
    try {
      const brain = agentBrain({ provider: 'claude' });
      const { decomposition: d } = await brain.decompose(
        {
          spec: {
            outcome:
              'Build a small CLI todo app: a data module that persists todos to a JSON ' +
              'file, and a command module on top of it for add/list/done.',
            verifications: [
              { kind: 'command', grounding: 'the build passes', check: 'npm run build' },
            ],
          },
          context: { learnings: [] },
        },
        { worktree: base, mcpServers: [] },
      );

      // A real multi-child layer, each child classified and footprinted.
      expect(d.children.length).toBeGreaterThanOrEqual(2);
      for (const c of d.children) {
        expect(c.spec.outcome.length).toBeGreaterThan(0);
        expect(['leaf', 'branch']).toContain(c.kind);
        expect(Array.isArray(c.footprint.writeGlobs)).toBe(true);
      }
      // Seams reference valid child indices when present.
      for (const s of d.seams) {
        expect(s.producer).toBeLessThan(d.children.length);
        expect(s.consumer).toBeLessThan(d.children.length);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);
});
