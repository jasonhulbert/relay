// The run seed the intake compiler produces (design §3.11, M6 Phase 1): the
// structured object a bounded conversation distills out of grilling the human.
// Phase 1 only PRODUCES it (in memory); Phase 2 commits it as the `.relay/` root.
//
// A seed is exactly three things, matching the design's "outcome spec + verification
// grounding + a non-binding high-level sketch":
//   - the verifiable outcome the run aims at (`spec.outcome`);
//   - how it will be judged, each check carrying explicit grounding
//     (`spec.verifications`, §6 — a verdict citing no grounding is rejected);
//   - a NON-binding sketch (`sketch`) — high-level orientation only.
//
// The `spec` is an `OutcomeSpec`, so it maps 1:1 onto `RootManifest.spec` when Phase
// 2 commits the root. The sketch is deliberately a separate, structurally minimal
// type (see `Sketch`) so intake cannot smuggle a binding plan into the seed.
import type { OutcomeSpec, Verification } from '../relay-state/index';

// The non-binding high-level sketch (design §3.3, I2): free-form orientation bullets
// the interviewer captures so the run starts pointed the right way. It is
// deliberately NOT a `Decomposition` — it carries no child specs, footprints, or
// seams — so it is structurally incapable of being a binding plan. The orchestrator's
// brain owns decomposition and is free to diverge from the sketch entirely (the
// sketch is orientation, allowed to be wrong, never a contract).
export interface Sketch {
  notes: string[];
}

// The full run seed: the outcome spec (with grounded verifications) and the
// non-binding sketch. This is the conversation's ONLY output (I1/I2).
export interface IntakeSeed {
  spec: OutcomeSpec;
  sketch: Sketch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
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
// what §6 rejects — so a missing grounding fails loud (Rule 11) rather than
// defaulting to an empty string.
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
      throw new Error('intake seed verification missing non-empty `grounding` (§6)');
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
