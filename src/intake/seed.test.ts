import { describe, expect, test } from 'vitest';
import { compileSeed } from './seed';

// A recorded final interviewer message (the "transcript fixture"): the model's prose
// wrapping a fenced ```json seed, exactly the shape `agentInterviewer` would emit on
// its `done` turn. The compiler must distill the structured seed out of it.
const TRANSCRIPT_FIXTURE = [
  'Thanks — I have enough to seed the run. Here is the seed:',
  '',
  '```json',
  '{',
  '  "kind": "seed",',
  '  "outcome": "the CLI exits 0 and prints the parsed config as JSON",',
  '  "verifications": [',
  '    { "kind": "command", "grounding": "the smoke command exits 0", "check": "node dist/cli.js --check" },',
  '    { "kind": "test", "grounding": "the parser unit tests pin the JSON shape", "check": "vitest run config" }',
  '  ],',
  '  "sketch": { "notes": ["reuse the existing yaml loader", "keep the flag surface tiny"] }',
  '}',
  '```',
  '',
  'Approve to commit.',
].join('\n');

// Validation 1 (the compile half): a structured seed — outcome spec + GROUNDED
// verifications + a non-binding sketch — is produced from a transcript fixture. This
// is the falsifiable core of Phase 1's first criterion, exercised without a live
// model.
describe('compileSeed distills a structured seed from a transcript fixture', () => {
  test('extracts the outcome, every grounded verification, and the sketch', () => {
    const seed = compileSeed(TRANSCRIPT_FIXTURE);

    expect(seed.spec.outcome).toBe('the CLI exits 0 and prints the parsed config as JSON');
    // Every verification carries explicit grounding — that is the "verification
    // grounding" deliverable, and §6 rejects an ungrounded check.
    expect(seed.spec.verifications).toHaveLength(2);
    expect(seed.spec.verifications[0]).toEqual({
      kind: 'command',
      grounding: 'the smoke command exits 0',
      check: 'node dist/cli.js --check',
    });
    expect(seed.spec.verifications.every((v) => v.grounding.trim() !== '')).toBe(true);
    // The sketch is captured as plain orientation notes.
    expect(seed.sketch.notes).toEqual([
      'reuse the existing yaml loader',
      'keep the flag surface tiny',
    ]);
  });

  test('reads a bare seed document with no surrounding prose or kind tag', () => {
    const bare = JSON.stringify({
      outcome: 'ship it',
      verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
      sketch: { notes: [] },
    });
    const seed = compileSeed(bare);
    expect(seed.spec.outcome).toBe('ship it');
    // An empty sketch is valid — a non-binding sketch is allowed to be thin — but the
    // field must be present and well-typed so the seed is structurally spec+sketch.
    expect(seed.sketch.notes).toEqual([]);
  });
});

// A seed is the run's load-bearing contract; a malformed one must fail loud (Rule 11)
// rather than seed a half-typed root downstream. Each case below would, if accepted,
// let an unverifiable or ungrounded run begin — which is exactly what intake exists
// to prevent.
describe('compileSeed rejects a malformed seed loudly', () => {
  test('a missing outcome is rejected', () => {
    const doc = JSON.stringify({
      verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
      sketch: { notes: [] },
    });
    expect(() => compileSeed(doc)).toThrow(/outcome/);
  });

  test('an empty verifications array is rejected — nothing could grade done-ness', () => {
    const doc = JSON.stringify({ outcome: 'x', verifications: [], sketch: { notes: [] } });
    expect(() => compileSeed(doc)).toThrow(/verifications/);
  });

  test('a verification missing grounding is rejected (§6)', () => {
    const doc = JSON.stringify({
      outcome: 'x',
      verifications: [{ kind: 'command', grounding: '', check: 'true' }],
      sketch: { notes: [] },
    });
    expect(() => compileSeed(doc)).toThrow(/grounding/);
  });

  test('a non-string note in the sketch is rejected', () => {
    const doc = JSON.stringify({
      outcome: 'x',
      verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
      sketch: { notes: ['ok', 7] },
    });
    expect(() => compileSeed(doc)).toThrow(/sketch/);
  });

  test('a message with no JSON document is rejected', () => {
    expect(() => compileSeed('no json here, just chatter')).toThrow(/no JSON/);
  });
});

// A `visual` outcome (design §13) carries a structured replay spec in `check`, not a
// shell line: the match-granularity it grades at (V4) and the semantic-action path the
// critic replays (V1). Intake REQUIRES both — a visual outcome missing either is
// unjudgeable, exactly what §6/Rule 11 reject — so each is validated at compile time,
// where the seed is produced, not deferred to an opaque crash at run time.
describe('compileSeed validates a visual verification’s match-granularity and path', () => {
  // A well-formed visual check: a structural-granularity spec with a one-step path.
  const visualCheck = JSON.stringify({
    granularity: 'structural',
    path: [{ kind: 'click', ref: '[data-testid="panel"]' }],
    expectSubtree: ['ok'],
  });
  const seedWith = (check: string): string =>
    JSON.stringify({
      outcome: 'the panel renders',
      verifications: [{ kind: 'visual', grounding: 'against the deterministic fixture', check }],
      sketch: { notes: [] },
    });

  test('accepts a visual check carrying a match-granularity and a semantic-action path', () => {
    const seed = compileSeed(seedWith(visualCheck));
    expect(seed.spec.verifications[0].kind).toBe('visual');
    // The structured spec round-trips through `check` for the Phase 2 critic to replay.
    const spec = JSON.parse(seed.spec.verifications[0].check) as {
      granularity: string;
      path: unknown[];
    };
    expect(spec.granularity).toBe('structural');
    expect(spec.path).toHaveLength(1);
  });

  test('rejects a visual check with no match-granularity (V4)', () => {
    const check = JSON.stringify({ path: [{ kind: 'click', ref: 'x' }] });
    expect(() => compileSeed(seedWith(check))).toThrow(/match-granularity/);
  });

  test('rejects a visual check with an unknown match-granularity', () => {
    const check = JSON.stringify({ granularity: 'pixelish', path: [{ kind: 'click', ref: 'x' }] });
    expect(() => compileSeed(seedWith(check))).toThrow(/match-granularity/);
  });

  test('rejects a visual check with an empty semantic-action path (V1)', () => {
    const check = JSON.stringify({ granularity: 'structural', path: [] });
    expect(() => compileSeed(seedWith(check))).toThrow(/path/);
  });

  test('rejects a visual check whose path step has no kind', () => {
    const check = JSON.stringify({ granularity: 'structural', path: [{ ref: 'x' }] });
    expect(() => compileSeed(seedWith(check))).toThrow(/kind/);
  });

  test('rejects a visual check that is not JSON', () => {
    expect(() => compileSeed(seedWith('vitest run panel'))).toThrow(/JSON replay spec/);
  });
});
