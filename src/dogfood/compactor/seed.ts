// The evidence-directory compactor dogfood's run seed. This is the FIRST real-work
// outcome the spine drives through its own loop, chosen because it is pure core-logic
// — no external CLI, no UI — so it isolates the loop from provider flakiness and is
// verified by command/test alone.
//
// One step only PRODUCES the seed and the fixture it grades against; a later step
// commits this seed via intake and runs it end-to-end (decompose → execute → critic →
// done). The seed is authored here as the interviewer's final message — prose wrapping
// a fenced ```json document — and compiled through the REAL intake path (`compileSeed`),
// so "the outcome spec and grounding are committed via intake" is exercised on the
// same code a live conversation would, not a hand-built object that skips intake's
// own validation (a check must carry verification grounding, etc.).
import { compileSeed } from '../../intake/index';
import type { IntakeSeed } from '../../intake/index';

// The compactor outcome, stated as five grounded facets the critic grades against:
// live-ref retention, orphan drop, retained-capture compression, manifest write, and
// baseline-store exclusion. Each verification is `test` kind — the dogfood is golden/
// property tested against the fixture — and each carries explicit grounding that cites
// that fixture, because verification grounding is required: a verdict that cites no
// evidence is rejected, and intake's compiler rejects an ungrounded check.
//
// The `check` lines name the vitest selectors the compactor tests will satisfy. They
// are the verifiable contract the run aims at, grounded in `GOLDEN` (see `fixture.ts`),
// which already enumerates every live ref, every orphan, and every untouched baseline
// path.
export const COMPACTOR_SEED_MESSAGE = [
  'I have enough to seed the evidence-compactor run. Here is the seed:',
  '',
  '```json',
  JSON.stringify(
    {
      kind: 'seed',
      outcome:
        'The evidence-directory compactor scans .relay/ for live evidence refs, drops orphaned captures, compresses retained ones, and writes a compaction manifest, leaving the content-addressed baseline store byte-for-byte untouched.',
      verifications: [
        {
          kind: 'test',
          grounding:
            'GOLDEN.liveRefs in the fixture enumerates every capture a live node evidence ref points at; each must still resolve after a compaction run.',
          check: 'vitest run dogfood/compactor -t "retains every live ref"',
        },
        {
          kind: 'test',
          grounding:
            'GOLDEN.orphanedCaptures enumerates the captures no live ref points at; each must be gone after a compaction run.',
          check: 'vitest run dogfood/compactor -t "drops orphaned captures"',
        },
        {
          kind: 'test',
          grounding:
            'GOLDEN.retainedForCompression enumerates the retained captures; each must be smaller on disk after compaction than the fixture wrote it.',
          check: 'vitest run dogfood/compactor -t "compresses retained captures"',
        },
        {
          kind: 'test',
          grounding:
            'The compaction manifest must enumerate kept/dropped/compressed entries matching GOLDEN (live kept, orphans dropped, retained compressed).',
          check: 'vitest run dogfood/compactor -t "writes a compaction manifest"',
        },
        {
          kind: 'test',
          grounding:
            'GOLDEN.untouchedBaselinePaths enumerates the content-addressed baseline-store files; the store must hash identically before and after a compaction run.',
          check:
            'vitest run dogfood/compactor -t "leaves the baseline store byte-for-byte unchanged"',
        },
      ],
      // Non-binding orientation only (a Sketch carries no children/footprints/seams,
      // so it cannot smuggle a binding plan into the root). The brain owns the real
      // decomposition at activation and is free to diverge from every note here.
      sketch: {
        notes: [
          'Find live refs by reading node files’ evidenceRefs through the relay-state schema, never by guessing filenames.',
          'A capture is orphaned iff no live ref names it; compress retained captures in place.',
          'The baseline store is a sibling of .relay/, never under evidence/ — the scan must not reach it.',
        ],
      },
    },
    null,
    2,
  ),
  '```',
  '',
  'Approve to commit.',
].join('\n');

// Compile the compactor seed through the real intake compiler. Deterministic (no
// live model): exactly the parse+validate the run later commits via `commitRoot`.
// Exported so both the "commits via intake" test and the end-to-end run use one source.
export function compactorSeed(): IntakeSeed {
  return compileSeed(COMPACTOR_SEED_MESSAGE);
}
