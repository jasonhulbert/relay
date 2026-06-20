// The visual critic path (design §7.4–7.5, V1/V4/V5/V7). This is the verification
// side of the Surface seam: given a visual outcome's declared verification, the
// critic REPLAYS the executor-emitted semantic-action path against a Surface and
// grades the state it reaches — it never asks the executor to drive the app and hand
// back a screenshot (that would put the author of the change inside the evidence
// loop the independent critic exists to keep it out of, §3.6).
//
// Four design pins live here:
//   - V1 replay: the critic drives the executor's `Interaction[]` path itself via
//     `surface.interact(...)`, then captures its own evidence.
//   - V4 match-granularity: the verification declares intent / structural /
//     baseline-diff; grading is dispatched on it. v0.1 implements intent (judged)
//     and structural (semantic-subtree assertions); baseline-diff is the Phase 4
//     baseline pipeline's to own.
//   - V5 structural failure classification: a failed replay is classified
//     retry / real-fail / re-dispatch from the Surface's typed failure plus a
//     liveness probe — NO model call.
//   - V7 semantic element-scoping: when the verification names an element, snapshot/
//     screenshot are scoped to that ref, so an unrelated changing region in the same
//     frame cannot cause a false verdict.
//
// The `VisualVerification` is the *critic-visible* declaration (V1/V2): it carries
// the path, granularity, scope, and a semantic expectation — and NO narrative.
// Because the path is semantic and field-isolated, it passes the C7 projection
// property test (re-checked in this module's test): no self-report rides in on it.
import {
  SurfaceCallError,
  type AccessibilitySnapshot,
  type Interaction,
  type Screenshot,
  type Surface,
} from './types';

// The match granularity a visual outcome declares (V4, design §7.5):
//   - intent       — multimodal judgment that the capture satisfies the described
//                    intent; tolerant of incidental pixel variation (the default).
//   - structural   — assertions over the named element's semantic subtree (text,
//                    role, state); component-scoped by nature.
//   - baseline-diff — pixel comparison against a stored reference; owned by the
//                    Phase 4 baseline pipeline.
export type MatchGranularity = 'intent' | 'structural' | 'baseline-diff';

// The element a check is scoped to (V7). `ref` is the opaque semantic id parsed from
// the a11y tree (see `parseRefs`); `element` is the human-readable description the
// driver records for its interaction-permission log.
export interface ElementScope {
  ref: string;
  element?: string;
}

// The critic-visible visual verification (V1/V2). A discriminated union on
// granularity so each rung carries exactly the expectation it grades against and
// nothing else — there is structurally no narrative field to leak (C7). `path` is
// the executor-emitted semantic-action path the critic replays; `scope` is the
// optional V7 element the check is isolated to.
export type VisualVerification =
  | {
      granularity: 'intent';
      path: Interaction[];
      scope?: ElementScope;
      // What the capture must satisfy, judged multimodally (no assertion list).
      intent: string;
    }
  | {
      granularity: 'structural';
      path: Interaction[];
      scope?: ElementScope;
      // Substrings that must ALL be present in the (scoped) a11y subtree — the
      // semantic facts the outcome asserts (text/role/state).
      expectSubtree: string[];
    }
  | {
      granularity: 'baseline-diff';
      path: Interaction[];
      scope?: ElementScope;
      // Perceptual-diff tolerance; the diff itself is the Phase 4 pipeline's.
      tolerance?: number;
    };

// The evidence the intent judge grades — the critic's OWN capture after replay, not
// the executor's. Scoped to the named element when the verification declares one.
export interface IntentEvidence {
  snapshot: AccessibilitySnapshot;
  screenshot: Screenshot;
  intent: string;
}

// A single grade. Mirrors the shape of a `CriticVerdict`'s core (pass + rationale)
// without coupling to relay-state — the spine maps this into the durable verdict
// when it wires the visual critic into the loop (M9).
export interface VisualGrade {
  pass: boolean;
  rationale: string;
}

// The intent-granularity judge seam (V4 rung 1). Multimodal judgment is the one
// place a model is admissible on this path; it is injected so the deterministic
// fixture tests grade without a real model, exactly as the spine injects a scripted
// critic. Structural and baseline-diff grading never reach it.
export type IntentJudge = (evidence: IntentEvidence) => Promise<VisualGrade>;

// How a failed replay is classified (V5, design §7.4) — the visual-kind
// specialization of the unified failure rule (§3.9). The loop, not a judgment call,
// decides what an unreachable state means:
//   - retry       — a transient mode (step-timeout, navigation error); bounded
//                   retry of the replay.
//   - real-fail   — the app process died or errored; surfaced as a real failure.
//   - re-dispatch — a step persistently fails against a HEALTHY app (alive and
//                   answering), so the path has drifted from the app → back to the
//                   executor.
export type ReplayClassification = 'retry' | 'real-fail' | 're-dispatch';

// The verdict the visual critic returns: either the grade of a successfully replayed
// path, or — when replay itself failed — the structural classification of WHY,
// carrying the typed Surface error that produced it. A discriminated `outcome` so a
// caller can never read a classification as a grade or vice-versa.
export type VisualVerdict =
  | { outcome: 'graded'; grade: VisualGrade }
  | { outcome: 'replay-failed'; classification: ReplayClassification; error: SurfaceCallError };

// Parse the opaque semantic refs out of an a11y snapshot tree (V7). Playwright MCP
// serializes refs as `[ref=eNN]` tokens in the tree text; they are opaque at the
// Surface layer (the contract treats the tree as text), so the critic parses them
// here, where it needs to address an element. Returns refs in document order,
// deduplicated.
export function parseRefs(tree: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /\[ref=([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tree)) !== null) {
    const ref = m[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

// Replay the executor-emitted semantic-action path (V1). Drives each interaction
// through the Surface in order; the first step that throws a typed `SurfaceCallError`
// propagates so the caller can classify it (V5). A non-Surface error is a bug, not a
// reachability fact, so it propagates unwrapped too.
export async function replayPath(surface: Surface, path: Interaction[]): Promise<void> {
  for (const action of path) {
    await surface.interact(action);
  }
}

// True when a Surface failure is a transient reachability mode (V5 retry bucket):
// a step timeout or a navigation error. Matched on the typed `detail` the driver
// carried, lower-cased — never on the whole formatted message. Conservative: only
// these named modes are transient; everything else falls through to the liveness
// probe so a real failure is never silently retried.
function isTransient(error: SurfaceCallError): boolean {
  const d = error.detail.toLowerCase();
  return (
    d.includes('timeout') || d.includes('navigation') || d.includes('net::') || d.includes('err_')
  );
}

// Classify a failed replay structurally (V5) — NO model call. Transient modes are
// read off the typed error; otherwise the app's liveness is probed with a trivial
// `query_state` (the design's "process alive AND query_state returns" test): if the
// probe throws, the app is dead → real-fail; if it answers, the app is healthy and
// the step drifted → re-dispatch. The probe is the only extra Surface call; no model
// is ever consulted.
export async function classifyReplayFailure(
  surface: Surface,
  error: SurfaceCallError,
): Promise<ReplayClassification> {
  if (isTransient(error)) return 'retry';
  try {
    await surface.queryState({ function: '() => true' });
  } catch {
    // The app no longer answers a trivial read — it died or errored (real-fail),
    // not a drifted path against a healthy app.
    return 'real-fail';
  }
  // The app is alive and answering, yet the step failed — the path has drifted.
  return 're-dispatch';
}

// Grade the structural rung (V4 rung 2): every declared substring must be present in
// the scoped a11y subtree. Component-scoped by nature — the snapshot is taken at the
// verification's `scope.ref`, so an unrelated region in the same frame is not even in
// the tree being asserted (V7).
function gradeStructural(tree: string, expectSubtree: string[]): VisualGrade {
  const missing = expectSubtree.filter((s) => !tree.includes(s));
  if (missing.length === 0) {
    return {
      pass: true,
      rationale: `structural: all ${expectSubtree.length} expected facts present`,
    };
  }
  return {
    pass: false,
    rationale: `structural: missing ${missing.length} expected fact(s): ${missing
      .map((s) => JSON.stringify(s))
      .join(', ')}`,
  };
}

// Replay the declared path and grade the state it reaches (the visual critic path,
// end to end: replay → scope → capture → grade). On a typed Surface failure during
// replay, returns the V5 classification instead of a grade. The intent rung needs
// the injected `judge`; structural needs none; baseline-diff defers to Phase 4.
export async function replayAndGrade(
  surface: Surface,
  verification: VisualVerification,
  opts: { judge?: IntentJudge } = {},
): Promise<VisualVerdict> {
  try {
    await replayPath(surface, verification.path);
  } catch (err) {
    if (err instanceof SurfaceCallError) {
      const classification = await classifyReplayFailure(surface, err);
      return { outcome: 'replay-failed', classification, error: err };
    }
    throw err;
  }

  // V7: scope every capture to the named element when the verification declares one,
  // so grading ignores the rest of the frame.
  const scopeArg = verification.scope ? { ref: verification.scope.ref } : undefined;

  switch (verification.granularity) {
    case 'structural': {
      const snap = await surface.snapshot(scopeArg);
      return { outcome: 'graded', grade: gradeStructural(snap.tree, verification.expectSubtree) };
    }
    case 'intent': {
      const judge = opts.judge;
      if (!judge) {
        throw new Error('intent-granularity grading requires an injected IntentJudge');
      }
      const snapshot = await surface.snapshot(scopeArg);
      let shotOpts: { ref?: string; element?: string } | undefined;
      if (verification.scope) {
        shotOpts = { ref: verification.scope.ref };
        if (verification.scope.element !== undefined) shotOpts.element = verification.scope.element;
      }
      const screenshot = await surface.screenshot(shotOpts);
      const grade = await judge({ snapshot, screenshot, intent: verification.intent });
      return { outcome: 'graded', grade };
    }
    case 'baseline-diff':
      // Capture, store, and diff against a content-addressed baseline is the Phase 4
      // (V6/F2) baseline pipeline's responsibility; this path does not yet grade it.
      throw new Error('baseline-diff grading is owned by the Phase 4 baseline pipeline');
  }
}
