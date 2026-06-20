import { describe, expect, test } from 'vitest';
import { MeteredSurface, WaitMeter, waitFraction } from './wait-meter';
import type { Surface } from './types';

// A fake surface whose every method advances a shared clock by a fixed step, so the
// metered wait is deterministic without sleeping. `close` advances too, since the
// MeteredSurface times teardown.
function fakeSurface(tick: () => void): Surface {
  const advance = async <T>(value: T): Promise<T> => {
    tick();
    return value;
  };
  return {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: () => advance(undefined),
    resize: () => advance(undefined),
    snapshot: () => advance({ tree: 'tree' }),
    screenshot: () => advance({ data: 'x', mimeType: 'image/png' }),
    interact: () => advance(undefined),
    queryState: () => advance({ value: 'v' }),
    close: () => advance(undefined),
  };
}

// WHY (F4): the wait-fraction is the graduation metric; it must be a real ratio in
// [0,1], never a divide-by-zero or an impossible >100% from clock skew. These pin
// the guards so a degenerate clock can't silently poison the metric.
describe('waitFraction', () => {
  test('is surface-wait over run wall-clock', () => {
    expect(waitFraction(300, 1000)).toBeCloseTo(0.3);
  });

  test('returns 0 when wall-clock did not advance (no divide-by-zero)', () => {
    expect(waitFraction(50, 0)).toBe(0);
    expect(waitFraction(50, -5)).toBe(0);
  });

  test('clamps to 1 when surface-wait exceeds wall-clock (clock skew)', () => {
    expect(waitFraction(1200, 1000)).toBe(1);
  });

  test('clamps to 0 on a negative numerator', () => {
    expect(waitFraction(-10, 1000)).toBe(0);
  });
});

// WHY (F4 instrumentation): F4 is instrumented at the Surface call boundary — the
// MeteredSurface must add EVERY crossing's duration into the meter, including
// teardown, and must keep the wrapped surface's results intact (it is a transparent
// decorator). If it dropped a call's time or mangled a result, the metric and the
// check would both be wrong.
describe('MeteredSurface', () => {
  test('accumulates each timed call into the meter and passes results through', async () => {
    let clock = 0;
    const STEP = 10;
    const meter = new WaitMeter();
    const surface = new MeteredSurface(
      fakeSurface(() => {
        clock += STEP;
      }),
      meter,
      () => clock,
    );

    // capabilities() is a static read, not an MCP crossing — it must not be timed.
    expect(surface.capabilities().semantic).toBe(true);
    expect(meter.waitMs).toBe(0);

    await surface.launch('http://x');
    const snap = await surface.snapshot();
    const shot = await surface.screenshot();
    await surface.interact({ kind: 'click', ref: 'e1' });
    const q = await surface.queryState({ function: '() => 1' });
    await surface.close();

    // Results ride through untouched.
    expect(snap.tree).toBe('tree');
    expect(shot.mimeType).toBe('image/png');
    expect(q.value).toBe('v');
    // Six timed crossings × STEP each (capabilities excluded).
    expect(meter.waitMs).toBe(6 * STEP);
  });

  test('still counts the wait when a timed call throws, then re-throws', async () => {
    let clock = 0;
    const meter = new WaitMeter();
    const inner = fakeSurface(() => {
      clock += 5;
    });
    inner.launch = async (): Promise<void> => {
      clock += 7;
      throw new Error('navigate failed');
    };
    const surface = new MeteredSurface(inner, meter, () => clock);

    await expect(surface.launch('http://x')).rejects.toThrow('navigate failed');
    // The throwing call's wait is still metered (the `finally`).
    expect(meter.waitMs).toBe(7);
  });
});
