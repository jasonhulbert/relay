import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSurface } from './web-surface';
import { startFixture } from './fixture';
import type { StartedFixture } from './fixture';
import { classifyReplayFailure, replayAndGrade } from './visual-critic';
import { SurfaceCallError, type Interaction, type Surface } from './types';

// The Phase 3 Validation, run for real against the fixture page over a live browser:
//   - the critic REPLAYS a declared semantic-action path and grades it (V1, V4);
//   - a component-scoped check ignores the fixture's ticking clock (V7);
//   - a drifted step against the healthy app classifies as re-dispatch (V5).
//
// GATED, like the Phase 1/2 surface integration tests: `npm test` stays hermetic, so
// this is opt-in and skipped otherwise. It spawns a real `npx @playwright/mcp` +
// browser (headless here — no logged-in session needed for the critic path itself):
//   RELAY_VISUAL_CRITIC_INTEGRATION=1 npx vitest run src/surface/visual-critic.integration.test.ts
const RUN_INTEGRATION = process.env.RELAY_VISUAL_CRITIC_INTEGRATION === '1';
const integration = RUN_INTEGRATION ? describe : describe.skip;

// Find the opaque ref on the a11y-tree line that names `label`. The fixture marks the
// panel and clock with `aria-label`, so each shows up as a labelled node carrying a
// `[ref=eNN]` the critic scopes to (V7).
function refForLabel(tree: string, label: string): string {
  const line = tree.split('\n').find((l) => l.includes(`"${label}"`) && /\[ref=/.test(l));
  const m = line ? /\[ref=([^\]]+)\]/.exec(line) : null;
  if (!m) throw new Error(`no ref found for label ${label} in tree:\n${tree}`);
  return m[1];
}

function refForButton(tree: string, text: string): string {
  const line = tree.split('\n').find((l) => l.includes('button') && l.includes(`"${text}"`));
  const m = line ? /\[ref=([^\]]+)\]/.exec(line) : null;
  if (!m) throw new Error(`no ref found for button ${text} in tree:\n${tree}`);
  return m[1];
}

integration('visual critic path against the fixture (live browser)', () => {
  let fixture: StartedFixture;
  let surface: Surface;

  beforeAll(async () => {
    fixture = await startFixture();
    surface = new WebSurface({ headless: true });
    await surface.launch(fixture.url);
    await surface.resize(1024, 768);
  }, 120_000);

  afterAll(async () => {
    await surface.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  test('replays a path and grades it structural, scoped to the panel (V1, V4, V7)', async () => {
    const tree = (await surface.snapshot()).tree;
    const panelRef = refForLabel(tree, 'panel');
    const buttonRef = refForButton(tree, 'Run check');

    const path: Interaction[] = [{ kind: 'click', ref: buttonRef, element: 'Run check button' }];
    const verdict = await replayAndGrade(surface, {
      granularity: 'structural',
      path,
      scope: { ref: panelRef, element: 'panel' },
      expectSubtree: ['ran'],
    });

    expect(verdict.outcome).toBe('graded');
    if (verdict.outcome === 'graded') {
      expect(verdict.grade.pass).toBe(true);
    }
  }, 180_000);

  test('a panel-scoped snapshot is stable while the unrelated clock ticks (V7)', async () => {
    const tree = (await surface.snapshot()).tree;
    const panelRef = refForLabel(tree, 'panel');

    const scopedA = (await surface.snapshot({ ref: panelRef })).tree;
    const wholeA = (await surface.snapshot()).tree;
    await new Promise((r) => setTimeout(r, 200)); // let the clock tick (50ms interval)
    const scopedB = (await surface.snapshot({ ref: panelRef })).tree;
    const wholeB = (await surface.snapshot()).tree;

    // The panel-scoped subtree carries no clock, so it is identical across the tick.
    expect(scopedB).toBe(scopedA);
    // The whole frame DID change (the clock advanced) — proving scoping is what
    // bought the stable verdict, not a static page.
    expect(wholeB).not.toBe(wholeA);
  }, 180_000);

  test('a drifted step against the healthy app classifies as re-dispatch (V5)', async () => {
    let thrown: unknown = null;
    try {
      await surface.interact({ kind: 'click', ref: 'e-does-not-exist', element: 'ghost' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SurfaceCallError);
    const classification = await classifyReplayFailure(surface, thrown as SurfaceCallError);
    // The app is alive (the fixture is still served and answering), so a step that
    // cannot resolve its element is drift, not a dead app.
    expect(classification).toBe('re-dispatch');
  }, 180_000);
});
