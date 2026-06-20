import { describe, expect, test } from 'vitest';
import { runIntake, parseInterviewerTurn, agentInterviewer } from './session';
import type { AskHuman, Interviewer, InterviewerTurn, IntakeResult } from './session';
import type { IntakeSeed } from './seed';

const SEED: IntakeSeed = {
  spec: {
    outcome: 'the parser round-trips the sample config',
    verifications: [{ kind: 'command', grounding: 'the smoke check exits 0', check: 'true' }],
  },
  sketch: { notes: ['reuse the yaml loader'] },
};

// A scripted interviewer that walks a fixed list of turns and counts its calls, so a
// test can assert the loop stops exactly at the `done` turn (cf. the brain tests
// injecting an inline `Brain`).
function scriptedInterviewer(turns: InterviewerTurn[]): {
  interviewer: Interviewer;
  calls: () => number;
} {
  let i = 0;
  const interviewer: Interviewer = {
    next: () => {
      if (i >= turns.length) throw new Error('interviewer ran out of scripted turns');
      return Promise.resolve(turns[i++]);
    },
  };
  return { interviewer, calls: () => i };
}

// A scripted human that records every question put to it.
function scriptedAsk(answers: string[]): { ask: AskHuman; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const ask: AskHuman = (q) => {
    asked.push(q);
    if (i >= answers.length) throw new Error('human ran out of scripted answers');
    return Promise.resolve(answers[i++]);
  };
  return { ask, asked };
}

// Validation 1: a scripted intake session produces a structured seed (outcome spec +
// grounding + sketch) from a transcript fixture — the Q&A the script drives IS that
// fixture. Validation 2 rides along: the session terminates at the seed and returns
// it, never continuing into execution.
describe('runIntake grills the human and yields a structured seed (M6 Phase 1)', () => {
  test('two questions then a seed: the run seed is produced from the Q&A fixture', async () => {
    const { interviewer, calls } = scriptedInterviewer([
      { done: false, question: 'What does "done" mean for this run?' },
      { done: false, question: 'How will we verify it?' },
      { done: true, seed: SEED },
    ]);
    const { ask, asked } = scriptedAsk([
      'the parser round-trips the sample config',
      'a smoke command',
    ]);

    const result: IntakeResult = await runIntake({ interviewer, ask });

    // The seed: a verifiable outcome, a GROUNDED verification, and a non-binding sketch.
    expect(result.seed.spec.outcome).toBe('the parser round-trips the sample config');
    expect(result.seed.spec.verifications[0].grounding).toBe('the smoke check exits 0');
    expect(result.seed.sketch.notes).toEqual(['reuse the yaml loader']);

    // The transcript fixture: the interleaved Q&A, in order.
    expect(result.questionsAsked).toBe(2);
    expect(result.transcript).toEqual([
      { role: 'interviewer', text: 'What does "done" mean for this run?' },
      { role: 'human', text: 'the parser round-trips the sample config' },
      { role: 'interviewer', text: 'How will we verify it?' },
      { role: 'human', text: 'a smoke command' },
    ]);

    // Terminates rather than continuing into execution (I1/I2): the loop stopped the
    // instant the seed arrived — the interviewer was called exactly 3 times (q, q,
    // seed) and the human was not asked again after approval. The session's only
    // collaborators are the interviewer and `ask`; it has no executor to run, so the
    // seed is provably its sole output.
    expect(calls()).toBe(3);
    expect(asked).toHaveLength(2);
    expect(Object.keys(result).sort()).toEqual(['questionsAsked', 'seed', 'transcript']);
  });

  test('an opening line seeds the transcript before the first question', async () => {
    const { interviewer } = scriptedInterviewer([{ done: true, seed: SEED }]);
    const { ask } = scriptedAsk([]);
    const result = await runIntake({ interviewer, ask, opening: 'I want a config parser' });
    // The seed can be reached with zero questions; the opening is recorded as the
    // human's first line so the interviewer had context to finalize from.
    expect(result.questionsAsked).toBe(0);
    expect(result.transcript).toEqual([{ role: 'human', text: 'I want a config parser' }]);
  });

  // Bounded component (C3): an interview that never converges must terminate loudly,
  // not grill forever or silently truncate to an empty seed (Rule 11).
  test('it fails loud when the interview exceeds the question cap', async () => {
    const everAsking: Interviewer = {
      next: () => Promise.resolve({ done: false, question: 'and another thing?' }),
    };
    const { ask } = scriptedAsk(['a', 'b', 'c', 'd']);
    await expect(runIntake({ interviewer: everAsking, ask, maxQuestions: 3 })).rejects.toThrow(
      /within 3 questions/,
    );
  });
});

describe('parseInterviewerTurn reads the turn protocol deterministically', () => {
  test('a question turn', () => {
    const turn = parseInterviewerTurn('```json\n{"kind":"question","question":"why?"}\n```');
    expect(turn).toEqual({ done: false, question: 'why?' });
  });

  test('a seed turn compiles the seed from the same document', () => {
    const msg = JSON.stringify({
      kind: 'seed',
      outcome: 'ship it',
      verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
      sketch: { notes: [] },
    });
    const turn = parseInterviewerTurn(msg);
    expect(turn.done).toBe(true);
    if (turn.done) expect(turn.seed.spec.outcome).toBe('ship it');
  });

  test('a turn with no kind discriminant fails loud', () => {
    expect(() => parseInterviewerTurn('{"question":"why?"}')).toThrow(/kind/);
  });
});

// Build a `claude -p --output-format stream-json` stdout whose final result text is
// `message`, so the real interviewer's provider-parse path is exercised without the
// CLI (mirrors how the adapter tests feed recorded streams).
function claudeStdout(message: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }),
    JSON.stringify({
      type: 'result',
      result: message,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.001,
    }),
  ].join('\n');
}

function fenced(turn: object): string {
  return '```json\n' + JSON.stringify(turn) + '\n```';
}

// The real `agentInterviewer`, driven through `runIntake` with an injected CLI runner:
// it shells out per turn, parses the provider stream into a turn, and the loop drives
// it to a seed — proving the provider-agnostic shell-out path (C3) wires end-to-end.
describe('agentInterviewer parses a provider stream into turns', () => {
  test('a question stream then a seed stream drive the loop to a seed', async () => {
    const streams = [
      claudeStdout(fenced({ kind: 'question', question: 'what does done mean?' })),
      claudeStdout(
        fenced({
          kind: 'seed',
          outcome: 'the build passes',
          verifications: [{ kind: 'command', grounding: 'CI is green', check: 'npm test' }],
          sketch: { notes: ['small change'] },
        }),
      ),
    ];
    let call = 0;
    const invoke = (): Promise<{ stdout: string; code: number }> => {
      const stdout = streams[call++];
      return Promise.resolve({ stdout, code: 0 });
    };
    const interviewer = agentInterviewer({ provider: 'claude', invoke });
    const { ask } = scriptedAsk(['it builds cleanly']);

    const result = await runIntake({ interviewer, ask });

    expect(call).toBe(2);
    expect(result.questionsAsked).toBe(1);
    expect(result.seed.spec.outcome).toBe('the build passes');
    expect(result.seed.spec.verifications[0].grounding).toBe('CI is green');
    expect(result.seed.sketch.notes).toEqual(['small change']);
  });
});
