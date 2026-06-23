import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { classifyReplayFailure, parseRefs, replayAndGrade, replayPath } from './visual-critic';
import type { IntentJudge, VisualVerification } from './visual-critic';
import { SurfaceCallError, type Interaction, type Surface } from './types';

// A configurable in-memory Surface. Records the interactions it was driven with (so
// a replay can be asserted step-for-step), and lets each test script the snapshot it
// returns per scope, whether an interaction throws, and whether the liveness probe
// answers — so the whole visual critic path is exercised hermetically, no browser.
interface FakeConfig {
  // Snapshot tree returned for a given scope ref (undefined ref = whole frame).
  snapshotFor?: (ref: string | undefined) => string;
  // If set, `interact` throws this on the matching step index (0-based).
  throwOnStep?: { index: number; error: unknown };
  // If false, `queryState` throws (a dead app); defaults to alive.
  alive?: boolean;
}

function fakeSurface(cfg: FakeConfig = {}): { surface: Surface; interactions: Interaction[] } {
  const interactions: Interaction[] = [];
  const surface: Surface = {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: async () => undefined,
    resize: async () => undefined,
    snapshot: async (opts) => ({ tree: (cfg.snapshotFor ?? (() => ''))(opts?.ref) }),
    screenshot: async () => ({ data: 'x', mimeType: 'image/png' }),
    interact: async (action) => {
      const step = interactions.length;
      interactions.push(action);
      if (cfg.throwOnStep && cfg.throwOnStep.index === step) {
        throw cfg.throwOnStep.error;
      }
    },
    queryState: async () => {
      if (cfg.alive === false) throw new Error('app is gone');
      return { value: 'true' };
    },
    close: async () => undefined,
  };
  return { surface, interactions };
}

// WHY (deliverable: the path is a distinct critic-visible field that passes the
// narrative-inadmissibility property test): the visual verification is field-isolated
// — it carries the path, granularity, scope, and a semantic expectation, and
// structurally NO narrative field. If a self-report ever leaked onto it, the critic's
// verdict would be corruptible by the author's framing (the exact leak the
// evidence-only critic closes). This pins the key set the same way relay-state's
// projection test does, so adding a narrative field breaks it.
describe('VisualVerification is field-isolated (orchestrator narrative inadmissible)', () => {
  const NARRATIVE_KEYS = ['selfReport', 'learnings', 'narrative', 'self_report', 'rationale'];

  const arbInteraction: fc.Arbitrary<Interaction> = fc.oneof(
    fc.record({ kind: fc.constant<'click'>('click'), ref: fc.string() }),
    fc.record({ kind: fc.constant<'type'>('type'), ref: fc.string(), text: fc.string() }),
    fc.record({ kind: fc.constant<'press'>('press'), key: fc.string() }),
  );
  const arbScope = fc.option(fc.record({ ref: fc.string() }), { nil: undefined });
  // Conditionally include `scope` (omit the key when absent rather than setting it to
  // undefined, which `exactOptionalPropertyTypes` forbids) so the generated value is
  // a real `VisualVerification` — the type the narrative-inadmissibility invariant is asserted against.
  const arbVerification: fc.Arbitrary<VisualVerification> = fc.oneof(
    fc
      .tuple(fc.array(arbInteraction), arbScope, fc.string())
      .map(
        ([path, scope, intent]): VisualVerification =>
          scope
            ? { granularity: 'intent', path, scope, intent }
            : { granularity: 'intent', path, intent },
      ),
    fc
      .tuple(fc.array(arbInteraction), arbScope, fc.array(fc.string()))
      .map(
        ([path, scope, expectSubtree]): VisualVerification =>
          scope
            ? { granularity: 'structural', path, scope, expectSubtree }
            : { granularity: 'structural', path, expectSubtree },
      ),
    fc
      .tuple(
        fc.array(arbInteraction),
        arbScope,
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
      )
      .map(([path, scope, tolerance]): VisualVerification => {
        const base =
          tolerance === undefined
            ? { granularity: 'baseline-diff' as const, path }
            : { granularity: 'baseline-diff' as const, path, tolerance };
        return scope ? { ...base, scope } : base;
      }),
  );

  test('carries only its declared fields, never a narrative field', () => {
    const admissibleByGranularity: Record<string, Set<string>> = {
      intent: new Set(['granularity', 'path', 'scope', 'intent']),
      structural: new Set(['granularity', 'path', 'scope', 'expectSubtree']),
      'baseline-diff': new Set(['granularity', 'path', 'scope', 'tolerance']),
    };
    fc.assert(
      fc.property(arbVerification, (v) => {
        for (const key of Object.keys(v)) {
          expect(admissibleByGranularity[v.granularity].has(key)).toBe(true);
          expect(NARRATIVE_KEYS).not.toContain(key);
        }
        // No narrative ever rides in on the serialized declaration.
        const serialized = JSON.stringify(v);
        for (const banned of NARRATIVE_KEYS) {
          expect(serialized).not.toContain(`"${banned}"`);
        }
      }),
    );
  });
});

// WHY (element-scoping plumbing): the critic addresses an element by the opaque ref Playwright MCP
// embeds in the a11y tree as `[ref=eNN]`. The contract treats the tree as text, so
// the critic parses refs here; if parsing drifted, element-scoping could not
// target anything.
describe('parseRefs', () => {
  test('extracts refs in document order, deduplicated', () => {
    const tree = [
      '- region "panel" [ref=e1]',
      '  - heading "Relay Surface Fixture" [ref=e2]',
      '  - button "Run check" [ref=e3]',
      '  - button "Run check" [ref=e3]',
    ].join('\n');
    expect(parseRefs(tree)).toEqual(['e1', 'e2', 'e3']);
  });

  test('returns nothing for a tree with no refs', () => {
    expect(parseRefs('- plain text, no refs')).toEqual([]);
  });
});

// WHY (deliverable: the critic replays the executor-emitted path itself): the
// critic must drive the declared `Interaction[]` in order through the Surface — that
// is how it reaches the verifiable state to capture its OWN evidence, instead of
// trusting the executor's screenshot.
describe('replayPath', () => {
  test('drives every interaction through the surface in order', async () => {
    const { surface, interactions } = fakeSurface();
    const path: Interaction[] = [
      { kind: 'click', ref: 'e3', element: 'Run check button' },
      { kind: 'type', ref: 'e5', text: 'hello' },
      { kind: 'press', key: 'Enter' },
    ];
    await replayPath(surface, path);
    expect(interactions).toEqual(path);
  });
});

// WHY (Validation: the critic replays a declared path and grades at intent and
// structural granularity against the fixture): both rungs must reach a verdict after
// replaying. Structural asserts over the semantic subtree (no model); intent defers
// to the injected judge (the model seam), graded on the critic's own capture.
describe('replayAndGrade — match-granularity', () => {
  const path: Interaction[] = [{ kind: 'click', ref: 'e3' }];

  test('structural: passes when every expected semantic fact is present', async () => {
    const { surface, interactions } = fakeSurface({
      snapshotFor: () => '- region "panel"\n  - paragraph "ran"\n  - button "Run check"',
    });
    const verdict = await replayAndGrade(surface, {
      granularity: 'structural',
      path,
      expectSubtree: ['"ran"', 'button "Run check"'],
    });
    // Replayed first, then graded.
    expect(interactions).toEqual(path);
    expect(verdict).toEqual({
      outcome: 'graded',
      grade: { pass: true, rationale: expect.stringContaining('all 2 expected facts present') },
    });
  });

  test('structural: fails and names the missing fact', async () => {
    const { surface } = fakeSurface({ snapshotFor: () => '- paragraph "idle"' });
    const verdict = await replayAndGrade(surface, {
      granularity: 'structural',
      path,
      expectSubtree: ['"ran"'],
    });
    expect(verdict.outcome).toBe('graded');
    if (verdict.outcome === 'graded') {
      expect(verdict.grade.pass).toBe(false);
      expect(verdict.grade.rationale).toContain('ran');
    }
  });

  test('intent: grades the critic-captured evidence through the injected judge', async () => {
    const { surface } = fakeSurface({ snapshotFor: () => '- paragraph "ran"' });
    let sawIntent: string | null = null;
    const judge: IntentJudge = async (evidence) => {
      sawIntent = evidence.intent;
      // The judge sees the critic's own capture, not an executor screenshot.
      expect(evidence.screenshot.mimeType).toBe('image/png');
      return { pass: evidence.snapshot.tree.includes('"ran"'), rationale: 'looks ran' };
    };
    const verdict = await replayAndGrade(
      surface,
      { granularity: 'intent', path, intent: 'the check shows it ran' },
      { judge },
    );
    expect(sawIntent).toBe('the check shows it ran');
    expect(verdict).toEqual({ outcome: 'graded', grade: { pass: true, rationale: 'looks ran' } });
  });

  test('intent: refuses to grade without an injected judge (no silent pass)', async () => {
    const { surface } = fakeSurface();
    await expect(
      replayAndGrade(surface, { granularity: 'intent', path, intent: 'x' }),
    ).rejects.toThrow(/requires an injected IntentJudge/);
  });

  test('baseline-diff: refuses to grade without an injected grader (no silent skip)', async () => {
    // The baseline pipeline is wired in as an injected `BaselineGrader` (mirroring
    // the intent judge); the rung now grades when the grader is supplied and fails loud
    // when it is not — never silently skipping the strictest rung. The grader's own
    // behavior is covered hermetically in baseline.test.ts.
    const { surface } = fakeSurface();
    await expect(replayAndGrade(surface, { granularity: 'baseline-diff', path })).rejects.toThrow(
      /requires an injected BaselineGrader/,
    );
  });
});

// WHY (Validation: a step-timeout classifies as retry; a dead app as real-fail; a
// drifted step as re-dispatch, all without a model call): reachability is a fact the
// Surface already reports, so the loop — not a judgment — decides what a failed replay
// means. These pin each of the three buckets and that classification consults no
// model (only the Surface's typed error and a liveness probe).
describe('classifyReplayFailure — no model call', () => {
  test('a transient step-timeout classifies as retry', async () => {
    const { surface } = fakeSurface();
    const err = new SurfaceCallError(
      'browser_click',
      'Timeout 5000ms exceeded waiting for element',
    );
    expect(await classifyReplayFailure(surface, err)).toBe('retry');
  });

  test('a navigation error classifies as retry', async () => {
    const { surface } = fakeSurface();
    const err = new SurfaceCallError('browser_navigate', 'net::ERR_CONNECTION_REFUSED');
    expect(await classifyReplayFailure(surface, err)).toBe('retry');
  });

  test('a dead app (liveness probe throws) classifies as real-fail', async () => {
    const { surface } = fakeSurface({ alive: false });
    const err = new SurfaceCallError(
      'browser_click',
      'Target page, context or browser has been closed',
    );
    expect(await classifyReplayFailure(surface, err)).toBe('real-fail');
  });

  test('a drifted step against a healthy app classifies as re-dispatch', async () => {
    const { surface } = fakeSurface({ alive: true });
    const err = new SurfaceCallError('browser_click', 'No element matching ref e9 found');
    expect(await classifyReplayFailure(surface, err)).toBe('re-dispatch');
  });

  test('replayAndGrade returns the classification when replay throws a typed failure', async () => {
    // The app is alive but the second step targets a vanished element → drift.
    const { surface } = fakeSurface({
      alive: true,
      throwOnStep: { index: 1, error: new SurfaceCallError('browser_click', 'ref e9 not found') },
    });
    const verdict = await replayAndGrade(surface, {
      granularity: 'structural',
      path: [
        { kind: 'click', ref: 'e3' },
        { kind: 'click', ref: 'e9' },
      ],
      expectSubtree: ['"ran"'],
    });
    expect(verdict).toEqual({
      outcome: 'replay-failed',
      classification: 're-dispatch',
      error: expect.any(SurfaceCallError),
    });
  });

  test('a non-Surface error during replay propagates (a bug, not a reachability fact)', async () => {
    const { surface } = fakeSurface({
      throwOnStep: { index: 0, error: new TypeError('programmer error') },
    });
    await expect(
      replayAndGrade(surface, {
        granularity: 'structural',
        path: [{ kind: 'click', ref: 'e3' }],
        expectSubtree: [],
      }),
    ).rejects.toThrow(/programmer error/);
  });
});

// WHY (Validation: a component-scoped check ignores an unrelated changing region in
// the same frame): isolation is the whole point of element-scoping. The fixture's
// clock ticks every frame; a check scoped to the panel must be stable across frames,
// while the SAME check unscoped would flip as the clock changes. This proves scoping
// is what buys the stability, not luck.
describe('component scoping ignores an unrelated changing region', () => {
  // A frame whose unscoped tree carries the ever-changing clock, but whose
  // panel-scoped tree carries only the stable component.
  function frame(tick: number): (ref: string | undefined) => string {
    return (ref) =>
      ref === 'e-panel'
        ? '- region "panel"\n  - paragraph "ran"\n  - button "Run check"'
        : `- region "clock" "tick ${tick.toString()}"\n- region "panel"\n  - paragraph "ran"`;
  }
  const path: Interaction[] = [{ kind: 'click', ref: 'e3' }];

  test('the scoped check passes on two different frames; unscoped it would flip', async () => {
    const scopedVerification: VisualVerification = {
      granularity: 'structural',
      path,
      scope: { ref: 'e-panel', element: 'panel' },
      expectSubtree: ['region "panel"', '"ran"'],
    };

    // Two frames, clock advanced between them.
    const frame1 = fakeSurface({ snapshotFor: frame(1) });
    const frame2 = fakeSurface({ snapshotFor: frame(2) });
    const v1 = await replayAndGrade(frame1.surface, scopedVerification);
    const v2 = await replayAndGrade(frame2.surface, scopedVerification);
    expect(v1).toEqual(v2); // identical verdict despite the clock change
    expect(v1.outcome === 'graded' && v1.grade.pass).toBe(true);

    // Control: the same assertion UNSCOPED would include the clock and so differ
    // frame-to-frame — demonstrating scoping is what bought the stable verdict.
    const unscoped1 = frame(1)(undefined);
    const unscoped2 = frame(2)(undefined);
    expect(unscoped1).not.toBe(unscoped2);
    const scoped1 = frame(1)('e-panel');
    const scoped2 = frame(2)('e-panel');
    expect(scoped1).toBe(scoped2);
  });
});
