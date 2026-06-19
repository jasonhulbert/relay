// fast-check arbitraries for `.relay/` records, shared across the relay-state
// property tests (node round-trip, projection chokepoint). Kept out of the
// production bundle by being unreferenced from the spine entry point.
import fc from 'fast-check';
import type { NodeRecord, OutcomeContract, RootManifest } from './types';

// Path-safe ids (matches paths.ts `assertSafeId`, which also rejects the
// traversal segments `.` and `..`).
export const safeId = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,40}$/)
  .filter((s) => s !== '.' && s !== '..');

// Adversarial free text: fuzzed strings plus a battery of YAML-hostile literals
// (fences, leading colons, type-looking scalars, CRLF, control chars, unicode,
// leading/trailing whitespace, multi-line). Round-trip must survive all of them.
export const trickyText = fc.oneof(
  fc.string(),
  fc.constantFrom(
    '',
    ' ',
    '  ',
    '\n',
    '\t',
    'a\nb\nc',
    '---',
    '--- not a fence ---',
    ': leading colon',
    '#hash',
    '- dash',
    'true',
    'false',
    'null',
    '0',
    '123',
    '1.5',
    'yes',
    'no',
    '  leading-space',
    'trailing-space  ',
    'tab\tinside',
    'crlf\r\nline',
    'quote " and apostrophe \'',
    'emoji 🎯 ünïcödé',
    '> block quote',
    '| pipe scalar',
    '* star',
  ),
  fc.string().map((s) => `${s}\n${s}`),
);

const arbVerification = fc.record({
  kind: fc.constantFrom(
    'command',
    'test',
    'artifact',
    'structural',
    'visual',
    'agent-critic',
    'human',
  ),
  grounding: trickyText,
  check: trickyText,
});

const arbSpec = fc.record({
  outcome: trickyText,
  verifications: fc.array(arbVerification, { minLength: 1, maxLength: 3 }),
});

const arbEvidenceRef = fc.record({
  runId: safeId,
  path: trickyText,
  kind: fc.constantFrom('diff', 'self-report', 'transcript', 'screenshot', 'cost', 'verdict'),
  summary: trickyText,
});

const arbVerdict = fc.record({
  pass: fc.boolean(),
  provider: trickyText,
  rationale: trickyText,
  evidenceRefs: fc.array(arbEvidenceRef, { maxLength: 3 }),
});

const arbBlocked = fc.record({
  reason: trickyText,
  rungsSpent: fc.array(trickyText, { maxLength: 4 }),
  criticReason: trickyText,
  humanFacing: trickyText,
});

export const arbNodeRecord: fc.Arbitrary<NodeRecord> = fc.record({
  id: safeId,
  parentId: fc.option(safeId, { nil: null }),
  kind: fc.constantFrom('branch', 'leaf'),
  status: fc.constantFrom('pending', 'active', 'done', 'blocked'),
  spec: arbSpec,
  children: fc.array(safeId, { maxLength: 5 }),
  selfReport: fc.option(trickyText, { nil: null }),
  learnings: fc.array(trickyText, { maxLength: 4 }),
  verdict: fc.option(arbVerdict, { nil: null }),
  evidenceRefs: fc.array(arbEvidenceRef, { maxLength: 4 }),
  blocked: fc.option(arbBlocked, { nil: null }),
});

export const arbRootManifest: fc.Arbitrary<RootManifest> = fc.record({
  runId: safeId,
  rootId: safeId,
  spec: arbSpec,
  createdAt: trickyText,
});

export const arbOutcomeContract: fc.Arbitrary<OutcomeContract> = fc.record({
  nodeId: safeId,
  runId: safeId,
  claimedOutcome: trickyText,
  criticCertified: fc.boolean(),
  verdictRefs: fc.array(arbEvidenceRef, { maxLength: 3 }),
  seamEvidence: fc.array(arbEvidenceRef, { maxLength: 3 }),
});
