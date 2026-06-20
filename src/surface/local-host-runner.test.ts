import { describe, expect, test } from 'vitest';
import {
  LocalHostRunner,
  caffeinateCommand,
  fileTccGate,
  tccGrantNotice,
  renderRunSummary,
} from './local-host-runner';
import type { CaffeinateController, TccGate } from './local-host-runner';
import type { WebSurfaceOptions } from './web-surface';
import type { Surface } from './types';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake surface that advances a shared clock on each call, records that it was
// closed, and tracks the options it was built with — so a test can assert the runner
// drove a real check and tore the session down without a browser.
function fakeSurface(state: { closed: boolean; clock: { t: number } }): Surface {
  const advance = async <T>(value: T): Promise<T> => {
    state.clock.t += 10;
    return value;
  };
  return {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: () => advance(undefined),
    resize: () => advance(undefined),
    snapshot: () => advance({ tree: 'Relay Surface Fixture\nRun check' }),
    screenshot: () => advance({ data: 'x', mimeType: 'image/png' }),
    interact: () => advance(undefined),
    queryState: () => advance({ value: 'ran' }),
    close: async () => {
      state.clock.t += 10;
      state.closed = true;
    },
  };
}

function recordingCaffeinate(events: string[]): CaffeinateController {
  return {
    start: () => {
      events.push('caffeinate:start');
    },
    stop: () => {
      events.push('caffeinate:stop');
    },
  };
}

const grantedGate: TccGate = { ensure: async () => null };

// WHY: the caffeinate argv keeps the logged-in session awake for the run's duration.
// If a flag dropped (or a `-t` timeout crept in), the display could sleep mid-check
// and stall rendering/screenshots. Pin the held-until-killed invocation.
describe('caffeinateCommand', () => {
  test('holds display/idle/system wake assertions until killed (no timeout)', () => {
    const { command, args } = caffeinateCommand();
    expect(command).toBe('caffeinate');
    expect(args).toEqual(['-d', '-i', '-s']);
    expect(args).not.toContain('-t');
  });
});

// WHY (Validation: the F4 metric must be visible in the run summary): the summary is
// where the metric is recorded, so it must actually render the fraction. A summary
// that omitted it would pass nothing for plan-reflect to observe.
describe('renderRunSummary', () => {
  test('records the F4 wait-fraction as a percentage with the raw ratio', () => {
    const s = renderRunSummary({ surfaceWaitMs: 300, runWallClockMs: 1000, waitFraction: 0.3 });
    expect(s).toContain('F4 surface-wait fraction: 30.0%');
    expect(s).toContain('300ms surface / 1000ms run');
  });
});

describe('LocalHostRunner', () => {
  // WHY (Validation: a visual check runs on the tier-A session): the runner must
  // build a HEADED surface in the run scope, run the check against it, hold the
  // caffeinate assertion for exactly the check's span, and tear the session down —
  // the tier-A contract. A headless surface or a leaked caffeinate/browser would
  // break the "logged-in session" guarantee.
  test('runs a check on a headed run-scoped surface, bracketed by caffeinate', async () => {
    const events: string[] = [];
    const clock = { t: 0 };
    const surfaceState = { closed: false, clock };
    let builtWith: WebSurfaceOptions | null = null;

    const runner = new LocalHostRunner({
      outputDir: '/run/scope',
      browser: 'chrome',
      surfaceFactory: (o) => {
        builtWith = o;
        return fakeSurface(surfaceState);
      },
      caffeinate: recordingCaffeinate(events),
      tcc: grantedGate,
      now: () => clock.t,
      log: () => {},
    });

    const result = await runner.run(async (surface) => {
      events.push('check:start');
      await surface.launch('http://fixture');
      const snap = await surface.snapshot();
      await surface.interact({ kind: 'click', ref: 'e1' });
      const q = await surface.queryState({ function: '() => 1' });
      events.push('check:end');
      return { heading: snap.tree, status: q.value };
    });

    // The check actually drove the surface.
    expect(result.value.heading).toContain('Relay Surface Fixture');
    expect(result.value.status).toBe('ran');
    // Headed, in the run scope, with the browser threaded.
    expect(builtWith).not.toBeNull();
    expect(builtWith!.headless).toBe(false);
    expect(builtWith!.outputDir).toBe('/run/scope');
    expect(builtWith!.browser).toBe('chrome');
    // Caffeinate wrapped the check; the surface was closed.
    expect(events).toEqual(['caffeinate:start', 'check:start', 'check:end', 'caffeinate:stop']);
    expect(surfaceState.closed).toBe(true);
  });

  // WHY (Validation: F4 recorded for the run): the metric must be the metered surface
  // wait over the run wall-clock, and exposed both as a number and in the summary.
  // The fake advances the clock 10ms per surface crossing and the check adds explicit
  // non-surface time, so the ratio is exact and asserts the instrumentation boundary
  // (not the whole run) is what F4 measures.
  test('records F4 as surface-wait over run wall-clock', async () => {
    const clock = { t: 0 };
    const surfaceState = { closed: false, clock };

    const runner = new LocalHostRunner({
      surfaceFactory: () => fakeSurface(surfaceState),
      caffeinate: recordingCaffeinate([]),
      tcc: grantedGate,
      now: () => clock.t,
      log: () => {},
    });

    const result = await runner.run(async (surface) => {
      await surface.launch('http://fixture'); // +10 surface
      await surface.snapshot(); // +10 surface
      clock.t += 70; // non-surface "work": pure run time, not surface wait
      return null;
    });

    // close() adds a third 10ms surface crossing => 30ms surface wait.
    expect(result.surfaceWaitMs).toBe(30);
    // 30 surface + 70 non-surface = 100ms run wall-clock.
    expect(result.runWallClockMs).toBe(100);
    expect(result.waitFraction).toBeCloseTo(0.3);
    expect(result.summary).toContain('30.0%');
  });

  // WHY: caffeinate and the surface are host resources; a check that throws must not
  // leak them. The `finally` must still release the wake assertion and close the
  // browser, then re-throw.
  test('releases caffeinate and closes the surface even when the check throws', async () => {
    const events: string[] = [];
    const clock = { t: 0 };
    const surfaceState = { closed: false, clock };

    const runner = new LocalHostRunner({
      surfaceFactory: () => fakeSurface(surfaceState),
      caffeinate: recordingCaffeinate(events),
      tcc: grantedGate,
      now: () => clock.t,
      log: () => {},
    });

    await expect(
      runner.run(async () => {
        throw new Error('check blew up');
      }),
    ).rejects.toThrow('check blew up');

    expect(events).toEqual(['caffeinate:start', 'caffeinate:stop']);
    expect(surfaceState.closed).toBe(true);
  });

  // WHY (deliverable: one-time TCC grant path): the grant notice must surface on the
  // first run and stay quiet after, driven by the per-user marker — so the operator
  // is told how to grant exactly once, not on every run.
  test('surfaces the TCC grant notice once, then stays silent (marker-driven)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-tcc-'));
    try {
      const marker = join(dir, 'tier-a-tcc');
      const gate = fileTccGate(marker);

      const first = await gate.ensure();
      expect(first).toBe(tccGrantNotice());
      // The marker now exists, recording that the notice was shown.
      expect((await readFile(marker, 'utf8')).length).toBeGreaterThan(0);

      const second = await gate.ensure();
      expect(second).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The runner threads the gate's notice into the result and logs it on first run.
  test('reports the TCC notice through the run result on a first run', async () => {
    const clock = { t: 0 };
    const logs: string[] = [];
    const runner = new LocalHostRunner({
      surfaceFactory: () => fakeSurface({ closed: false, clock }),
      caffeinate: recordingCaffeinate([]),
      tcc: { ensure: async () => 'GRANT ME' },
      now: () => clock.t,
      log: (l) => logs.push(l),
    });

    const result = await runner.run(async () => 'ok');
    expect(result.tccNotice).toBe('GRANT ME');
    expect(logs).toContain('GRANT ME');
  });
});
