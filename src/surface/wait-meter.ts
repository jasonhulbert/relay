// Surface-wait instrumentation: the graduation metric for the tier-A runner is the
// visual-verification session-wait as a fraction of run wall-clock. "Session wait" is
// the time spent blocked inside the Surface's MCP calls — driving a real browser is
// slow, and the surface-wait fraction tells the operator how much of a run that
// visual session costs, the signal for graduating off tier-A.
//
// Instrumented at the Surface call boundary: `MeteredSurface` wraps any `Surface`,
// times every method, and accumulates the total into a shared `WaitMeter`. The runner
// measures run wall-clock around the whole check and divides. A wrapper, not a change
// to `WebSurface`, so the metric works for every driver and the driver stays a pure
// I/O seam.
import type {
  AccessibilitySnapshot,
  Interaction,
  QueryStateRequest,
  QueryStateResult,
  Screenshot,
  Surface,
  SurfaceCapabilities,
} from './types';

// A monotonic millisecond clock. Injected so tests drive the timeline
// deterministically instead of sleeping; defaults to the wall clock.
export type Clock = () => number;

// Accumulates the wall-clock spent inside Surface calls. One meter per run; the
// `MeteredSurface` adds each timed call into it. `waitMs` is the surface-wait
// numerator.
export class WaitMeter {
  #waitMs = 0;

  get waitMs(): number {
    return this.#waitMs;
  }

  add(ms: number): void {
    this.#waitMs += ms;
  }
}

// The fraction of run wall-clock spent waiting inside Surface calls. Guarded so
// a zero-or-negative wall-clock (a clock that did not advance) yields 0 rather than a
// divide-by-zero, and clamped to [0,1] so a metering/clock skew never reports an
// impossible >100% wait. Pure, so the metric is pinned by a unit test.
export function waitFraction(surfaceWaitMs: number, runWallClockMs: number): number {
  if (runWallClockMs <= 0) return 0;
  const f = surfaceWaitMs / runWallClockMs;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

// Wrap a `Surface` so every call's duration is added to the meter. Capability
// reads are static and free, so `capabilities()` is passed through untimed; every
// method that crosses the MCP boundary — including `close` teardown — is timed,
// because all of it is wall-clock the run spends on the visual session. The timing
// is in a `finally` so a thrown driver failure (which the drift re-dispatch
// classifier reads, once that is wired up) still counts its wait and still propagates.
export class MeteredSurface implements Surface {
  readonly #inner: Surface;
  readonly #meter: WaitMeter;
  readonly #now: Clock;

  constructor(inner: Surface, meter: WaitMeter, now: Clock) {
    this.#inner = inner;
    this.#meter = meter;
    this.#now = now;
  }

  async #timed<T>(op: () => Promise<T>): Promise<T> {
    const start = this.#now();
    try {
      return await op();
    } finally {
      this.#meter.add(this.#now() - start);
    }
  }

  capabilities(): SurfaceCapabilities {
    return this.#inner.capabilities();
  }

  launch(url: string): Promise<void> {
    return this.#timed(() => this.#inner.launch(url));
  }

  resize(width: number, height: number): Promise<void> {
    return this.#timed(() => this.#inner.resize(width, height));
  }

  snapshot(opts?: { ref?: string }): Promise<AccessibilitySnapshot> {
    return this.#timed(() => this.#inner.snapshot(opts));
  }

  screenshot(opts?: { ref?: string; element?: string }): Promise<Screenshot> {
    return this.#timed(() => this.#inner.screenshot(opts));
  }

  interact(action: Interaction): Promise<void> {
    return this.#timed(() => this.#inner.interact(action));
  }

  queryState(request: QueryStateRequest): Promise<QueryStateResult> {
    return this.#timed(() => this.#inner.queryState(request));
  }

  close(): Promise<void> {
    return this.#timed(() => this.#inner.close());
  }
}
