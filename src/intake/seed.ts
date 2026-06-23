// The run seed the intake compiler produces: the structured object a bounded
// conversation distills out of grilling the human. Intake only PRODUCES it (in
// memory); committing it as the `.relay/` root is a separate step.
//
// A seed is exactly three things — an outcome spec, verification grounding, and a
// non-binding high-level sketch:
//   - the verifiable outcome the run aims at (`spec.outcome`);
//   - how it will be judged, each check carrying explicit grounding
//     (`spec.verifications` — a verdict citing no grounding is rejected);
//   - a NON-binding sketch (`sketch`) — high-level orientation only.
//
// The `spec` is an `OutcomeSpec`, so it maps 1:1 onto `RootManifest.spec` when the
// root is committed. The sketch is deliberately a separate, structurally minimal
// type (see `Sketch`) so intake cannot smuggle a binding plan into the seed.
import type { OutcomeSpec, Verification, Sketch } from '../relay-state/index';

// The non-binding high-level sketch the interviewer captures. Its durable home is
// the relay-state record schema — the committed root carries it in the manifest — so
// the type is defined there and re-exported here; intake remains its producer.
export type { Sketch };

// The full run seed: the outcome spec (with grounded verifications) and the
// non-binding sketch. This is the conversation's ONLY output.
export interface IntakeSeed {
  spec: OutcomeSpec;
  sketch: Sketch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

// The match granularities a visual outcome may declare. Mirrored here as runtime
// values because intake validates the seed without depending on the
// surface module (whose `MatchGranularity` is a compile-time type only); the small
// duplication is the same kind the file already tolerates for `asRecord` and is
// pinned by `intake-rejects-an-unknown-granularity` in the test.
const VISUAL_GRANULARITIES = ['intent', 'structural', 'baseline-diff'] as const;

// Validate a `visual`-kind verification's `check`. A visual check is NOT a shell line
// but a structured replay spec: the executor-emitted semantic-action path the critic
// replays plus the match-granularity it grades at. It rides as a JSON document in
// `check` so the durable `Verification` shape is untouched — "the runnable check" for
// a visual kind is this spec — and the visual critic parses it back into a
// `VisualVerification`. Intake REQUIRES both fields: a visual outcome with no
// granularity is unjudgeable and one with no path replays nothing, exactly what the
// required-grounding rule and Rule 11 reject — so a missing field fails loud here,
// where the seed is compiled, rather than surfacing as an opaque crash at run time.
function validateVisualCheck(check: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(check);
  } catch {
    throw new Error('intake seed `visual` verification `check` must be a JSON replay spec');
  }
  const spec = asRecord(doc);
  if (!spec) {
    throw new Error('intake seed `visual` verification `check` is not a JSON object');
  }
  if (
    typeof spec.granularity !== 'string' ||
    !(VISUAL_GRANULARITIES as readonly string[]).includes(spec.granularity)
  ) {
    throw new Error(
      `intake seed \`visual\` verification missing match-granularity (one of ${VISUAL_GRANULARITIES.join(
        '/',
      )})`,
    );
  }
  if (!Array.isArray(spec.path) || spec.path.length === 0) {
    throw new Error('intake seed `visual` verification missing a non-empty semantic-action `path`');
  }
  if (
    spec.path.some((step) => asRecord(step) === null || typeof asRecord(step)?.kind !== 'string')
  ) {
    throw new Error('intake seed `visual` verification `path` step missing string `kind`');
  }
}

// Extract the seed's JSON document from the interviewer's final message. Prefer the
// last fenced ```json block; fall back to the first `{` … last `}` span so a model
// that emits bare JSON still parses. Mirrors the brain's `extractJson` — kept local
// so the intake module does not couple to the spine's private helper (the codebase
// tolerates this small duplication; cf. `asRecord` across the adapters).
function extractJson(text: string): string {
  const fence = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
    last = m[1];
  }
  if (last !== null) return last.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error('intake seed message carried no JSON document');
}

// Parse + validate the seed's verifications. Unlike the brain's decomposition parse,
// grounding is REQUIRED and must be non-empty: "verification grounding" is a
// first-class deliverable of intake, and a check the run cannot justify is exactly
// what the required-grounding rule rejects — so a missing grounding fails loud
// (Rule 11) rather than defaulting to an empty string.
function parseVerifications(value: unknown): Verification[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('intake seed `verifications` must be a non-empty array');
  }
  return value.map((raw) => {
    const v = asRecord(raw);
    if (!v || typeof v.kind !== 'string' || typeof v.check !== 'string') {
      throw new Error('intake seed verification missing string `kind`/`check`');
    }
    if (typeof v.grounding !== 'string' || v.grounding.trim() === '') {
      throw new Error('intake seed verification missing non-empty `grounding`');
    }
    // A `visual` outcome carries a structured replay spec in `check`; its
    // match-granularity and semantic-action path are required, validated the same way
    // and at the same point grounding is — a visual seed missing either fails loud.
    if (v.kind === 'visual') {
      validateVisualCheck(v.check);
    }
    return {
      kind: v.kind as Verification['kind'],
      grounding: v.grounding,
      check: v.check,
    };
  });
}

// The sketch is non-binding orientation: a present-but-possibly-empty list of string
// notes. The field must be present and well-typed (so the seed is structurally a
// "spec + sketch"), but an empty list is valid — a thin sketch is still orientation.
function parseSketch(value: unknown): Sketch {
  const s = asRecord(value);
  const notes = s?.notes;
  if (!Array.isArray(notes) || !notes.every((n) => typeof n === 'string')) {
    throw new Error('intake seed `sketch.notes` must be a string array');
  }
  return { notes };
}

// Deterministically parse + validate the structured seed from the interviewer's
// final message (Rule 5: the model converses, code reads the answer). A malformed
// seed fails loud (Rule 11) rather than letting a half-typed root be committed
// downstream. Exported so the compile step is testable from a transcript fixture
// without driving a live conversation.
export function compileSeed(message: string): IntakeSeed {
  const doc = asRecord(JSON.parse(extractJson(message)));
  if (!doc) {
    throw new Error('intake seed is not a JSON object');
  }
  if (typeof doc.outcome !== 'string' || doc.outcome.trim() === '') {
    throw new Error('intake seed missing non-empty string `outcome`');
  }
  return {
    spec: { outcome: doc.outcome, verifications: parseVerifications(doc.verifications) },
    sketch: parseSketch(doc.sketch),
  };
}
