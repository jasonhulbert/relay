// The bridge wiring the M8 visual subsystem into the spine's critic path for the
// `visual` verification kind (design §6.3 #5, §7.4–7.5, M9). The critic is the gate on
// done-ness (§3.6); for a `command`/`test`/`artifact` outcome that gate runs the
// deterministic kinds in code (verify.ts), and for an `agent-critic` outcome it spawns
// the cross-provider model (agent-critic.ts). A `visual` outcome's gate is the M8
// visual critic: REPLAY the executor-emitted semantic-action path against a live
// Surface (V1), grade the state it reaches at the declared match-granularity (V4),
// scoped to the named element (V7), and — on a structural-or-better pass — capture and
// promote a baseline (V6). No model is consulted on the structural rung; the intent
// rung's judge and the baseline-diff rung's grader are the injected M8 seams.
//
// The encoding seam (M9 Phase 1): the critic-visible `VisualVerification` (the path,
// granularity, scope, expectation — and structurally NO narrative, C7) rides as a JSON
// document inside the durable `Verification.check`. Intake validated its shape on the
// way in (`validateVisualCheck`); this is the read-back, `JSON.parse(check) as
// VisualVerification`, guarded so a malformed check fails loud (Rule 11) instead of
// grading against a half-typed spec.
//
// Like `agentCritic`, this is a `CriticSpawn` FACTORY: everything the M8 path needs
// that the C7-restricted `(view, ctx)` call site cannot carry — the live Surface, the
// baseline store/ref location, the per-outcome id, the perceptual differ, and the
// human mismatch sink — is closed over at construction (the spine wires it per run),
// so the projection handed to the critic stays spec + diff + evidence only.
import {
  DEFAULT_FLAKE_BUDGET,
  exactBytesDiffer,
  makeBaselineGrader,
  promoteBaseline,
  readBaselineRef,
  replayAndGrade,
  verifyBaselineDiff,
} from '../surface/index';
import type {
  BaselineContext,
  BaselineStore,
  FlakeBudget,
  IntentJudge,
  MismatchSink,
  ScreenshotDiffer,
  Surface,
  VisualVerification,
} from '../surface/index';
import type { CriticSpawn, CriticVerdict, CriticView } from '../relay-state/index';

export interface VisualCriticOptions {
  // The live Surface the critic replays against (V1). The spine owns one long-lived
  // instance (the tier-A LocalHostRunner's headed WebSurface on a real run; a
  // deterministic stand-in in a hermetic test) and shares it across checks.
  surface: Surface;
  // Where the durable baseline ref lives (`.relay/baselines/<outcomeId>.md`, F2).
  relayDir: string;
  // The per-outcome baseline id — stable across runs so a later run diffs against the
  // version this run promoted (V6).
  outcomeId: string;
  // The content-addressed binary store, a SIBLING of `.relay/` (F2): the compactor,
  // which scans only `.relay/evidence/`, can never reach it.
  store: BaselineStore;
  // Where a surfaced baseline mismatch goes — the human decision region (F2). Routed,
  // never auto-resolved: replacing or regressing a known-good baseline is a human call.
  sink: MismatchSink;
  // The perceptual differ (the flake budget's spatial half); defaults to the honest
  // exact-bytes lower bound until the sub-pixel algorithm is wired.
  differ?: ScreenshotDiffer;
  // Per-outcome flake budget (spatial tolerance + temporal retries); defaults strict.
  budget?: FlakeBudget;
  // The intent-rung judge (the one admissible model seam, V4 rung 1). Omitted is fine
  // unless an outcome declares `intent` granularity.
  judge?: IntentJudge;
  // The verdict's provider label; the visual critic is code, not a model provider, so
  // it names the subsystem rather than claude/codex.
  provider?: string;
}

// Read the `VisualVerification` back out of a durable check (the M9 bridge). Fails
// loud on a malformed document rather than handing a half-typed spec to the replay
// path, where a missing path/granularity would mis-grade silently (Rule 11). Intake's
// `validateVisualCheck` already accepted the shape on commit; this re-guards at the
// trust boundary because the check is opaque text on disk by the time it is read.
export function parseVisualCheck(check: string): VisualVerification {
  const parsed: unknown = JSON.parse(check);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('visual check did not parse to an object');
  }
  const v = parsed as Record<string, unknown>;
  if (
    v.granularity !== 'intent' &&
    v.granularity !== 'structural' &&
    v.granularity !== 'baseline-diff'
  ) {
    throw new Error(
      `visual check has no valid match-granularity (got ${JSON.stringify(v.granularity)})`,
    );
  }
  if (!Array.isArray(v.path)) {
    throw new Error('visual check has no semantic-action path array');
  }
  return parsed as VisualVerification;
}

// The V7-scope argument shared by the structural snapshot and the baseline capture:
// the element ref (plus its human-readable description for the driver's permission
// record) when the verification names one, else undefined (the whole frame).
function scopeArg(verification: VisualVerification): { ref: string; element?: string } | undefined {
  if (!verification.scope) return undefined;
  return verification.scope.element !== undefined
    ? { ref: verification.scope.ref, element: verification.scope.element }
    : { ref: verification.scope.ref };
}

// V6 after a structural-or-better PASS: capture the graded frame and either promote it
// as the first baseline (nothing to diff against yet — the auto-promote) or, on a
// later run where a known-good baseline exists, diff against it under the flake budget.
// A persistent above-tolerance diff surfaces a `regression` mismatch for the human via
// the injected sink and fails — never an auto-pass, never a silent overwrite (F2). The
// surface is already at the navigated state (replay + grading ran), so the capture is
// the same frame the structural rung just passed.
async function captureAndPromote(
  ctx: BaselineContext,
  surface: Surface,
  verification: VisualVerification,
): Promise<{ pass: boolean; rationale: string }> {
  const existing = await readBaselineRef(ctx.relayDir, ctx.outcomeId);
  if (!existing) {
    const capture = await surface.screenshot(scopeArg(verification));
    const ref = await promoteBaseline(ctx, capture, {
      granularity: 'structural',
      tolerance: ctx.budget.tolerance,
    });
    return {
      pass: true,
      rationale: `baseline captured-and-promoted v${ref.version.toString()} at ${ref.granularity} (V6 first pass)`,
    };
  }
  const bd: Extract<VisualVerification, { granularity: 'baseline-diff' }> = verification.scope
    ? {
        granularity: 'baseline-diff',
        path: [],
        scope: verification.scope,
        tolerance: ctx.budget.tolerance,
      }
    : { granularity: 'baseline-diff', path: [], tolerance: ctx.budget.tolerance };
  const grade = await verifyBaselineDiff(surface, bd, ctx);
  return { pass: grade.pass, rationale: grade.rationale };
}

// Build the visual critic as a `CriticSpawn` (the C7-typed path: only a constructed
// `CriticView` reaches it). It grades the outcome's `visual` verification by replaying
// its declared path and grading the reached state, then promotes/diffs a baseline on a
// structural pass. The deterministic kinds are not its concern (verify.ts owns those);
// an outcome that mixes a `visual` check with `command`/`test` checks is composed by
// the spine running both gates, not by this critic.
export function visualCritic(opts: VisualCriticOptions): CriticSpawn {
  const provider = opts.provider ?? 'visual-critic';
  const budget = opts.budget ?? DEFAULT_FLAKE_BUDGET;
  const differ = opts.differ ?? exactBytesDiffer;
  const fail = (rationale: string): CriticVerdict => ({
    pass: false,
    provider,
    rationale,
    evidenceRefs: [],
  });

  return async (view: CriticView): Promise<CriticVerdict> => {
    const decl = view.spec.verifications.find((v) => v.kind === 'visual');
    if (!decl) {
      return fail('no visual verification declared on the outcome');
    }
    let verification: VisualVerification;
    try {
      verification = parseVisualCheck(decl.check);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`visual check is not a parseable VisualVerification: ${msg}`);
    }

    const baselineCtx: BaselineContext = {
      store: opts.store,
      relayDir: opts.relayDir,
      outcomeId: opts.outcomeId,
      differ,
      sink: opts.sink,
      budget,
    };

    // V1 replay + V4 granularity dispatch + V7 scope. The intent rung uses the
    // injected judge; the baseline-diff rung uses the baseline grader (promote-first
    // or diff-vs-baseline); the structural rung asserts semantic facts with no model.
    const opt: { judge?: IntentJudge; baseline: ReturnType<typeof makeBaselineGrader> } = {
      baseline: makeBaselineGrader(baselineCtx),
    };
    if (opts.judge !== undefined) opt.judge = opts.judge;
    const verdict = await replayAndGrade(opts.surface, verification, opt);
    if (verdict.outcome === 'replay-failed') {
      return fail(`visual replay failed (${verdict.classification}): ${verdict.error.message}`);
    }
    const grade = verdict.grade;
    if (!grade.pass) {
      return fail(grade.rationale);
    }

    // V6: a structural pass is structural-or-better, so it earns a captured-and-
    // promoted baseline here. The baseline-diff rung already ran its own promote/diff
    // inside `replayAndGrade`, and the intent rung is below the V6 gate (intent never
    // promotes), so only the structural rung adds this step.
    if (verification.granularity === 'structural') {
      const baseline = await captureAndPromote(baselineCtx, opts.surface, verification);
      const rationale = `${grade.rationale}; ${baseline.rationale}`;
      return baseline.pass
        ? { pass: true, provider, rationale, evidenceRefs: [] }
        : fail(rationale);
    }

    return { pass: true, provider, rationale: grade.rationale, evidenceRefs: [] };
  };
}
