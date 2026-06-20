import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSurface } from './web-surface';
import { startFixture } from './fixture';
import type { StartedFixture } from './fixture';

// The Phase 1 Validation, run for real: the WebSurface drives the fixture page and
// returns an accessibility snapshot plus a screenshot, and the rest of the contract
// (resize / interact / queryState) round-trips against a live browser.
//
// GATED. The codebase keeps `npm test` hermetic — no test spawns a real external
// process (the model adapters unit-test their pure parse/argv functions and never
// launch a CLI). This test spawns `npx @playwright/mcp` and a real browser, so it
// is opt-in via RELAY_SURFACE_INTEGRATION=1 and skipped otherwise. Run it on a
// machine with the Playwright browser installed:
//   RELAY_SURFACE_INTEGRATION=1 npx vitest run src/surface/web-surface.integration.test.ts
const RUN_INTEGRATION = process.env.RELAY_SURFACE_INTEGRATION === '1';
const integration = RUN_INTEGRATION ? describe : describe.skip;

integration('WebSurface against the fixture (live browser)', () => {
  let fixture: StartedFixture;
  let surface: WebSurface;

  beforeAll(async () => {
    fixture = await startFixture();
    surface = new WebSurface({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await surface.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  test('drives the fixture and returns an accessibility snapshot plus a screenshot', async () => {
    await surface.launch(fixture.url);
    await surface.resize(1024, 768);

    // The semantic-first read: the a11y snapshot carries the page's structure.
    const snap = await surface.snapshot();
    expect(snap.tree).toContain('Relay Surface Fixture');
    expect(snap.tree.toLowerCase()).toContain('run check');

    // The pixel fallback: a real PNG comes back inline (magic bytes prove it is
    // image bytes, not an empty/placeholder result).
    const shot = await surface.screenshot();
    expect(shot.mimeType).toContain('png');
    const bytes = Buffer.from(shot.data, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }, 120_000);

  test('a semantic interaction takes effect and is observable via queryState', async () => {
    await surface.launch(fixture.url);
    // Pre-state: the status text is the fixture's initial value.
    const before = await surface.queryState({
      function: '() => document.getElementById("status").textContent',
    });
    expect(before.value).toContain('idle');

    // Drive the button (selector form of a target ref) and read the effect back.
    await surface.interact({ kind: 'click', ref: '#go', element: 'Run check button' });
    const after = await surface.queryState({
      function: '() => document.getElementById("status").textContent',
    });
    expect(after.value).toContain('ran');
  }, 120_000);
});
