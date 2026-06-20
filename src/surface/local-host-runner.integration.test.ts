import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostRunner } from './local-host-runner';
import { startFixture } from './fixture';
import type { StartedFixture } from './fixture';

// The Phase 2 Validation, run for real: a visual check runs on the tier-A session
// (a HEADED browser on the logged-in macOS session) against the fixture page, and
// the F4 wait-fraction metric is recorded for the run and visible in the run summary.
//
// GATED, like the Phase 1 surface integration test: `npm test` stays hermetic (no
// test spawns a real browser/process), so this is opt-in and skipped otherwise. It
// drives a HEADED browser, so run it on the logged-in macOS session with the
// Playwright browser installed:
//   RELAY_TIER_A_INTEGRATION=1 npx vitest run src/surface/local-host-runner.integration.test.ts
const RUN_INTEGRATION = process.env.RELAY_TIER_A_INTEGRATION === '1';
const integration = RUN_INTEGRATION ? describe : describe.skip;

integration('LocalHostRunner against the fixture (tier-A, headed)', () => {
  let fixture: StartedFixture;
  let home: string;

  beforeAll(async () => {
    fixture = await startFixture();
    // A temp relay-home so the one-time TCC marker write does not touch the real
    // `~/.relay`; the real fileTccGate path is still exercised.
    home = await mkdtemp(join(tmpdir(), 'relay-tier-a-'));
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  test('runs a visual check on the tier-A session and records the F4 metric', async () => {
    const lines: string[] = [];
    const runner = new LocalHostRunner({
      home,
      outputDir: home, // Playwright MCP session output lands in the run scope.
      log: (l) => lines.push(l),
    });

    const result = await runner.run(async (surface) => {
      await surface.launch(fixture.url);
      await surface.resize(1024, 768);

      // The semantic-first read against the live, headed session.
      const snap = await surface.snapshot();
      expect(snap.tree).toContain('Relay Surface Fixture');

      // A real interaction takes effect and is observable.
      await surface.interact({ kind: 'click', ref: '#go', element: 'Run check button' });
      const after = await surface.queryState({
        function: '() => document.getElementById("status").textContent',
      });
      expect(after.value).toContain('ran');

      // The pixel fallback comes back as real PNG bytes.
      const shot = await surface.screenshot();
      const bytes = Buffer.from(shot.data, 'base64');
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      return after.value;
    });

    // F4 is recorded for the run: a real headed session spends real time, so the
    // wait fraction is a positive, valid ratio.
    expect(result.value).toContain('ran');
    expect(result.surfaceWaitMs).toBeGreaterThan(0);
    expect(result.runWallClockMs).toBeGreaterThan(0);
    expect(result.waitFraction).toBeGreaterThan(0);
    expect(result.waitFraction).toBeLessThanOrEqual(1);

    // And it is visible in the run summary.
    expect(result.summary).toContain('F4 surface-wait fraction:');
    expect(lines).toContain(result.summary);
  }, 180_000);
});
