// The tier-A LocalHostRunner (design §13, F4). v0.1 ships tier-A only: visual
// checks run on the operator's logged-in macOS session — a real, headed browser the
// operator can watch — not a headless CI container. That choice carries three host
// concerns this runner owns:
//
//   1. A HEADED surface. It builds `new WebSurface({ headless: false })`, pointed at
//      the run's working dir so Playwright MCP's session output lands in the run
//      scope rather than the process cwd (the plan's artifact-scoping note).
//   2. `caffeinate`. A long visual run must not let the session sleep mid-check (a
//      slept display stalls rendering and screenshots), so the runner holds a
//      `caffeinate` assertion for the run's lifetime and releases it after.
//   3. A one-time TCC grant path. Driving a headed browser on the logged-in session
//      needs macOS privacy permissions the OS only grants interactively. TCC cannot
//      be granted programmatically, so the runner surfaces the grant instructions
//      ONCE (marked by a per-user file) and stays quiet on later runs.
//
// F4 is instrumented here: the runner wraps the surface in a `MeteredSurface`, runs
// the check, and records the surface session-wait as a fraction of run wall-clock in
// the run summary (the graduation metric). Like Phase 1, this is a capability build
// exercised against the fixture — it is not yet wired into the orchestrator loop
// (M9 does that), matching the executor's threaded-but-unused pattern.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSurface } from './web-surface';
import type { WebSurfaceOptions } from './web-surface';
import { MeteredSurface, WaitMeter, waitFraction } from './wait-meter';
import type { Clock } from './wait-meter';
import type { Surface } from './types';

// The work a visual check performs against the surface — drive it to a state and
// read back what the check needs. The runner owns lifecycle (headed surface,
// caffeinate, F4) around it; the check owns only what to do with the surface. Its
// return value rides back in the run result.
export type VisualCheck<T> = (surface: Surface) => Promise<T>;

// Holds a system-wake assertion for the run's lifetime. Injected so a hermetic test
// records start/stop ordering without spawning a real process.
export interface CaffeinateController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

// The macOS `caffeinate` invocation that keeps the logged-in session awake for the
// run: prevent display sleep (`-d`, so rendering/screenshots stay live), idle system
// sleep (`-i`), and system sleep (`-s`). No `-t` timeout and no utility argument, so
// the assertion is held until the process is killed (release = stop). Pure, so the
// argv is pinned by a unit test.
export function caffeinateCommand(): { command: string; args: string[] } {
  return { command: 'caffeinate', args: ['-d', '-i', '-s'] };
}

// Default caffeinate controller: spawns and later kills the real `caffeinate`. Output
// is ignored — it produces none while holding the assertion. Impure (spawns a
// process), so only the gated integration path exercises it.
export function spawnCaffeinate(): CaffeinateController {
  let child: ChildProcess | null = null;
  return {
    start(): void {
      const { command, args } = caffeinateCommand();
      child = spawn(command, args, { stdio: 'ignore' });
    },
    stop(): void {
      if (child) {
        child.kill();
        child = null;
      }
    },
  };
}

// The one-time TCC grant path. macOS gates a headed, automated browser on the
// logged-in session behind interactive privacy grants the OS will not let code set;
// the most we can do is tell the operator how, once. Injected so a test drives both
// the first-run (notice) and already-granted (silent) branches without touching the
// real filesystem.
export interface TccGate {
  // Returns the grant instructions on the first run, then `null` once acknowledged.
  ensure(): Promise<string | null>;
}

// The interactive macOS grant instructions, surfaced once. Screen Recording covers
// screenshot capture and Accessibility covers automated input; both are per-user,
// per-app grants the operator sets in System Settings.
export function tccGrantNotice(): string {
  return [
    'Tier-A visual checks drive a headed browser on your logged-in macOS session.',
    'macOS requires a one-time privacy grant for the terminal app running relay:',
    '  System Settings -> Privacy & Security -> Screen Recording  (enable your terminal)',
    '  System Settings -> Privacy & Security -> Accessibility     (enable your terminal)',
    'Grant once, then re-run. This notice will not repeat.',
  ].join('\n');
}

// Default TCC gate: a per-user marker file records that the grant notice was shown,
// so it appears once across runs (the grant itself is per-machine, not per-run). The
// marker lives under the relay home, not the run scope, for that reason.
export function fileTccGate(markerPath: string): TccGate {
  return {
    async ensure(): Promise<string | null> {
      try {
        await access(markerPath);
        return null;
      } catch {
        await mkdir(dirname(markerPath), { recursive: true });
        await writeFile(markerPath, `tier-a tcc grant notice shown\n`, 'utf8');
        return tccGrantNotice();
      }
    },
  };
}

export interface LocalHostRunnerOptions {
  // The run's working dir; Playwright MCP session output is pointed here so tier-A
  // artifacts land in the run scope instead of the process cwd.
  outputDir?: string;
  // Browser/channel for the headed surface (chrome | firefox | webkit | msedge).
  browser?: string;
  // Initial viewport "WIDTHxHEIGHT" for a deterministic frame.
  viewportSize?: string;
  // Override `~/.relay`, where the one-time TCC marker lives (tests pass a temp dir).
  home?: string;
  // Seams (tests inject deterministic stand-ins; real runs use the defaults):
  // builds the surface from the headed options the runner assembles.
  surfaceFactory?: (opts: WebSurfaceOptions) => Surface;
  caffeinate?: CaffeinateController;
  tcc?: TccGate;
  now?: Clock;
  // Run-summary sink; defaults to stdout.
  log?: (line: string) => void;
}

export interface LocalHostRunResult<T> {
  // Whatever the visual check returned.
  value: T;
  // F4 numerator: wall-clock spent inside Surface calls.
  surfaceWaitMs: number;
  // F4 denominator: total run wall-clock.
  runWallClockMs: number;
  // F4: surface session-wait as a fraction of run wall-clock, in [0,1].
  waitFraction: number;
  // The one-time TCC grant notice if this run surfaced it, else null.
  tccNotice: string | null;
  // The rendered run summary (also written to `log`), carrying the F4 metric.
  summary: string;
}

// Render the run summary the F4 metric is recorded in (the plan's Validation: the
// metric must be visible in the run summary). Wait-fraction is shown as a percentage
// alongside the raw numerator/denominator so the ratio is auditable, not just
// asserted.
export function renderRunSummary(r: {
  surfaceWaitMs: number;
  runWallClockMs: number;
  waitFraction: number;
}): string {
  const pct = (r.waitFraction * 100).toFixed(1);
  return [
    '=== tier-A visual run summary ===',
    `runner: local-host (logged-in session, headed)`,
    `F4 surface-wait fraction: ${pct}% ` +
      `(${r.surfaceWaitMs.toString()}ms surface / ${r.runWallClockMs.toString()}ms run)`,
  ].join('\n');
}

// Run one visual check on the tier-A session and record F4. Order matters: surface
// the one-time TCC notice, then hold the caffeinate assertion for the whole check,
// then run the check against a headed, metered surface, then ALWAYS release
// caffeinate and close the surface (a `finally`, so a check that throws still tears
// the session down and still releases the wake assertion). F4 = the metered surface
// wait over the wall-clock measured around the check.
export class LocalHostRunner {
  readonly #opts: LocalHostRunnerOptions;
  readonly #now: Clock;
  readonly #log: (line: string) => void;
  readonly #caffeinate: CaffeinateController;
  readonly #tcc: TccGate;
  readonly #surfaceFactory: (opts: WebSurfaceOptions) => Surface;

  constructor(opts: LocalHostRunnerOptions = {}) {
    this.#opts = opts;
    this.#now = opts.now ?? ((): number => Date.now());
    this.#log =
      opts.log ??
      ((line: string): void => {
        process.stdout.write(`${line}\n`);
      });
    this.#caffeinate = opts.caffeinate ?? spawnCaffeinate();
    this.#tcc = opts.tcc ?? fileTccGate(join(opts.home ?? join(homedir(), '.relay'), 'tier-a-tcc'));
    this.#surfaceFactory = opts.surfaceFactory ?? ((o): Surface => new WebSurface(o));
  }

  // Assemble the headed surface options: the tier-A surface is never headless (the
  // operator watches it on the logged-in session), and Playwright MCP output is
  // pointed at the run scope. Browser/viewport thread through when set.
  #surfaceOptions(): WebSurfaceOptions {
    const o: WebSurfaceOptions = { headless: false };
    if (this.#opts.outputDir !== undefined) o.outputDir = this.#opts.outputDir;
    if (this.#opts.browser !== undefined) o.browser = this.#opts.browser;
    if (this.#opts.viewportSize !== undefined) o.viewportSize = this.#opts.viewportSize;
    return o;
  }

  async run<T>(check: VisualCheck<T>): Promise<LocalHostRunResult<T>> {
    const tccNotice = await this.#tcc.ensure();
    if (tccNotice !== null) this.#log(tccNotice);

    const meter = new WaitMeter();
    const surface = new MeteredSurface(
      this.#surfaceFactory(this.#surfaceOptions()),
      meter,
      this.#now,
    );

    const startMs = this.#now();
    await this.#caffeinate.start();
    let value: T;
    try {
      value = await check(surface);
    } finally {
      await this.#caffeinate.stop();
      await surface.close();
    }
    const runWallClockMs = this.#now() - startMs;

    const surfaceWaitMs = meter.waitMs;
    const fraction = waitFraction(surfaceWaitMs, runWallClockMs);
    const summary = renderRunSummary({ surfaceWaitMs, runWallClockMs, waitFraction: fraction });
    this.#log(summary);

    return {
      value,
      surfaceWaitMs,
      runWallClockMs,
      waitFraction: fraction,
      tccNotice,
      summary,
    };
  }
}
