import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { agentCritic, buildCriticPrompt, parseCriticVerdict } from './agent-critic';
import type { CriticInvocation, CriticInvocationResult } from './agent-critic';
import { toCriticView } from '../relay-state/index';
import type { CriticContext, NodeRecord } from '../relay-state/index';
import type { ExecutorUsage } from './executor';

let worktree: string;
beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), 'relay-critic-'));
});
afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

function ctx(over: Partial<CriticContext> = {}): CriticContext {
  return { worktree, mcpServers: [], ...over };
}

// A node carrying a deliberately persuasive self-report + learnings — the narrative
// the C7 projection must withhold from the critic.
function nodeWithNarrative(check = 'true'): NodeRecord {
  return {
    id: 'leaf-1',
    parentId: 'root',
    kind: 'leaf',
    status: 'active',
    spec: {
      outcome: 'feature X works',
      verifications: [{ kind: 'command', grounding: 'exit 0', check }],
    },
    children: [],
    selfReport: 'I am absolutely certain I nailed this; trust me completely.',
    learnings: ['the tricky bit was the off-by-one in the parser'],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
}

// A minimal real `claude -p --output-format stream-json` capture whose result text
// carries the verdict line — enough for parseClaudeStream + parseCriticVerdict.
function claudeStream(reviewText: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }),
    JSON.stringify({
      type: 'result',
      result: reviewText,
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0 },
      total_cost_usd: 0.0002,
    }),
  ].join('\n');
}

function codexStream(reviewText: string): string {
  return [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reviewText } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 3 } }),
  ].join('\n');
}

describe('parseCriticVerdict reads the model verdict deterministically', () => {
  test('PASS/FAIL, case-insensitive, last verdict wins, null when absent', () => {
    expect(parseCriticVerdict('looks good\nVERDICT: PASS')).toBe(true);
    expect(parseCriticVerdict('nope\nVERDICT: FAIL')).toBe(false);
    expect(parseCriticVerdict('verdict: pass')).toBe(true);
    // A trailing restatement wins over an earlier draft verdict.
    expect(parseCriticVerdict('VERDICT: PASS\n...on reflection\nVERDICT: FAIL')).toBe(false);
    // No machine-readable verdict → null (the caller fails loud, never guesses pass).
    expect(parseCriticVerdict('I think it is probably fine')).toBeNull();
  });
});

// WHY: this is the C7 property re-run on the REAL critic path (the phase's headline
// validation). A juicy self-report + learnings go into the node; the prompt the
// real critic actually sends to the model is built from the projection only, so it
// must contain NEITHER. If buildCriticPrompt ever reached past the projection, the
// integrity leak reopens and this fails.
describe('the real critic prompt carries only the projection, never the narrative', () => {
  test('built from toCriticView, the prompt omits self-report and learnings', () => {
    const node = nodeWithNarrative();
    const view = toCriticView(node, 'A hello.txt\n+hi');
    const prompt = buildCriticPrompt(view, []);
    expect(prompt).toContain('feature X works'); // the spec outcome (admissible)
    expect(prompt).toContain('hi'); // the diff (admissible)
    expect(prompt).not.toContain('trust me completely'); // self-report (withheld)
    expect(prompt).not.toContain('off-by-one'); // learnings (withheld)
  });

  test('end-to-end the agent critic never sends the narrative to the model', async () => {
    const node = nodeWithNarrative();
    const view = toCriticView(node, 'A hello.txt\n+hi');
    let sentPrompt = '';
    const critic = agentCritic({
      provider: 'codex',
      invoke: (call: CriticInvocation): Promise<CriticInvocationResult> => {
        // The prompt is the trailing positional arg for codex.
        sentPrompt = call.args[call.args.length - 1];
        return Promise.resolve({ stdout: codexStream('grounded\nVERDICT: PASS'), code: 0 });
      },
    });
    const verdict = await critic(view, ctx());
    expect(verdict.pass).toBe(true);
    expect(sentPrompt).not.toContain('trust me completely');
    expect(sentPrompt).not.toContain('off-by-one');
  });
});

// WHY: cheapest-first (§6.3) — a declared deterministic check that fails is ground
// truth, and the critic must NOT pay for a model call to confirm a no. A loop that
// always spent the model would burn metered credit on settled failures.
describe('the critic short-circuits on a failed deterministic check', () => {
  test('a failing command verdicts FAIL without invoking the model', async () => {
    const node = nodeWithNarrative('exit 1');
    const view = toCriticView(node, 'some diff');
    let invoked = false;
    const critic = agentCritic({
      provider: 'codex',
      invoke: (): Promise<CriticInvocationResult> => {
        invoked = true;
        return Promise.resolve({ stdout: codexStream('VERDICT: PASS'), code: 0 });
      },
    });
    const verdict = await critic(view, ctx());
    expect(verdict.pass).toBe(false);
    expect(verdict.provider).toBe('codex');
    expect(verdict.rationale).toContain('deterministic verification failed');
    expect(invoked).toBe(false); // the model was never spawned
  });
});

describe('the critic spawns the cross-provider model when deterministic checks pass', () => {
  test('stamps the critic provider, returns the model verdict, records usage, reads read-only', async () => {
    const node = nodeWithNarrative('true');
    const view = toCriticView(node, 'A hello.txt\n+hi');
    const usages: ExecutorUsage[] = [];
    let seenArgs: string[] = [];
    const critic = agentCritic({
      provider: 'claude',
      invoke: (call: CriticInvocation): Promise<CriticInvocationResult> => {
        seenArgs = call.args;
        return Promise.resolve({ stdout: claudeStream('diff matches\nVERDICT: PASS'), code: 0 });
      },
      onUsage: (u) => usages.push(u),
    });
    const verdict = await critic(view, ctx());

    expect(verdict.pass).toBe(true);
    expect(verdict.provider).toBe('claude');
    expect(verdict.rationale).toContain('diff matches');
    // Usage was captured for the recap (F5; node-attribution is Phase 6).
    expect(usages).toHaveLength(1);
    expect(usages[0].provider).toBe('claude');
    expect(usages[0].outputTokens).toBe(4);
    // Read-only review: the independent critic inspects, never edits the change.
    expect(seenArgs).not.toContain('Write');
    expect(seenArgs).not.toContain('Edit');
    // Cost guardrail: the cheapest model is always pinned.
    expect(seenArgs[seenArgs.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
  });

  test('an unparseable model reply fails loud rather than guessing a pass', async () => {
    const node = nodeWithNarrative('true');
    const view = toCriticView(node, 'a diff');
    const critic = agentCritic({
      provider: 'codex',
      invoke: () =>
        Promise.resolve({ stdout: codexStream('I am unsure, no verdict here'), code: 0 }),
    });
    const verdict = await critic(view, ctx());
    expect(verdict.pass).toBe(false);
    expect(verdict.rationale).toContain('no parseable VERDICT');
  });

  test('the override raises the critic model off the cheapest default', async () => {
    const node = nodeWithNarrative('true');
    const view = toCriticView(node, 'a diff');
    let seenArgs: string[] = [];
    const critic = agentCritic({
      provider: 'codex',
      model: 'gpt-5.5',
      invoke: (call) => {
        seenArgs = call.args;
        return Promise.resolve({ stdout: codexStream('VERDICT: PASS'), code: 0 });
      },
    });
    await critic(view, ctx());
    expect(seenArgs[seenArgs.indexOf('--model') + 1]).toBe('gpt-5.5');
    // Codex review runs in a read-only sandbox.
    expect(
      seenArgs.slice(seenArgs.indexOf('--sandbox'), seenArgs.indexOf('--sandbox') + 2),
    ).toEqual(['--sandbox', 'read-only']);
  });
});

// WHY: Codex grants MCP via config, not a CLI flag (Phase 5). Granting servers now
// must fail loud, never silently drop the grant — the same stance as the executor.
describe('codex critic fails loud on an MCP grant before Phase 5', () => {
  test('rejects when granted servers it cannot yet wire', async () => {
    const node = nodeWithNarrative('true');
    const view = toCriticView(node, 'a diff');
    const critic = agentCritic({
      provider: 'codex',
      invoke: () => Promise.resolve({ stdout: '', code: 0 }),
    });
    await expect(
      critic(view, ctx({ mcpServers: [{ name: 's', command: 'srv' }] })),
    ).rejects.toThrow(/MCP/);
  });
});

// Gated real-CLI test (validation 1, headline): a real Codex critic grades a real
// produced change on a different provider than the (notional Claude) author. Opt-in
// via RELAY_E2E=1 — it hits the network, costs money, and is slow.
describe.skipIf(!process.env.RELAY_E2E)('agentCritic end-to-end (real CLI)', () => {
  test('a real codex critic renders an evidence-only verdict on a real diff', async () => {
    await writeFile(join(worktree, 'hello.txt'), 'hi from relay\n');
    const node: NodeRecord = {
      id: 'leaf-1',
      parentId: 'root',
      kind: 'leaf',
      status: 'active',
      spec: {
        outcome: 'A file hello.txt exists containing the text "hi from relay"',
        verifications: [{ kind: 'artifact', grounding: 'the file exists', check: 'hello.txt' }],
      },
      children: [],
      selfReport: 'do not read this narrative',
      learnings: [],
      verdict: null,
      evidenceRefs: [],
      blocked: null,
    };
    const view = toCriticView(node, 'A hello.txt\n+hi from relay');
    const usages: ExecutorUsage[] = [];
    const critic = agentCritic({ provider: 'codex', onUsage: (u) => usages.push(u) });
    const verdict = await critic(view, { worktree, mcpServers: [] });

    expect(verdict.provider).toBe('codex');
    expect(verdict.pass).toBe(true);
    expect(usages).toHaveLength(1);
    expect(usages[0].outputTokens).toBeGreaterThan(0);
  }, 180_000);
});
