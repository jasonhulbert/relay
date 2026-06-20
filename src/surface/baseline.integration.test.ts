import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseFrontmatter, relayPaths } from '../relay-state/index';
import { WebSurface } from './web-surface';
import { startFixture } from './fixture';
import type { StartedFixture } from './fixture';
import {
  BaselineStore,
  DEFAULT_FLAKE_BUDGET,
  exactBytesDiffer,
  promoteBaseline,
  readBaselineRef,
  verifyBaselineDiff,
} from './baseline';
import type { BaselineContext, BaselineMismatch } from './baseline';
import type { Surface } from './types';

// The Phase 4 Validation, run for real against the fixture over a live browser:
//   - a real scoped screenshot is captured-and-promoted as a baseline — binary in the
//     content-addressed store, ref in `.relay/` (V6, F2);
//   - re-capturing the same STATIC panel grades within tolerance (the V7-scoped region
//     is byte-stable frame-to-frame), so the baseline-diff rung passes;
//   - a full-frame baseline drifts the moment the unrelated clock ticks, so a
//     persistent above-tolerance diff against the healthy app surfaces a mismatch
//     decision — never an auto-pass, never a silent fail.
//
// GATED, like the other surface integration tests; `npm test` stays hermetic:
//   RELAY_BASELINE_INTEGRATION=1 npx vitest run src/surface/baseline.integration.test.ts
const RUN_INTEGRATION = process.env.RELAY_BASELINE_INTEGRATION === '1';
const integration = RUN_INTEGRATION ? describe : describe.skip;

function refForLabel(tree: string, label: string): string {
  const line = tree.split('\n').find((l) => l.includes(`"${label}"`) && /\[ref=/.test(l));
  const m = line ? /\[ref=([^\]]+)\]/.exec(line) : null;
  if (!m) throw new Error(`no ref found for label ${label} in tree:\n${tree}`);
  return m[1];
}

integration('baseline pipeline against the fixture (live browser)', () => {
  let fixture: StartedFixture;
  let surface: Surface;
  let relayDir: string;
  let storeDir: string;
  let seen: BaselineMismatch[];

  function ctxFor(outcomeId: string): BaselineContext {
    return {
      store: new BaselineStore(storeDir),
      relayDir,
      outcomeId,
      differ: exactBytesDiffer,
      sink: async (m) => {
        seen.push(m);
      },
      budget: DEFAULT_FLAKE_BUDGET,
    };
  }

  beforeAll(async () => {
    fixture = await startFixture();
    surface = new WebSurface({ headless: true });
    await surface.launch(fixture.url);
    await surface.resize(1024, 768);
    const base = await mkdtemp(join(tmpdir(), 'relay-baseline-it-'));
    relayDir = join(base, '.relay');
    storeDir = join(base, 'baselines');
    seen = [];
  }, 120_000);

  afterAll(async () => {
    await surface.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  test('promotes a real scoped screenshot — binary in the store, ref in .relay/ (V6, F2)', async () => {
    const tree = (await surface.snapshot()).tree;
    const panelRef = refForLabel(tree, 'panel');
    const ctx = ctxFor('panel-baseline');

    const capture = await surface.screenshot({ ref: panelRef, element: 'panel' });
    const ref = await promoteBaseline(ctx, capture, { granularity: 'structural', tolerance: 0 });

    // Binary is retrievable from the store by hash; the ref lives in `.relay/` and the
    // store binary does NOT (files-only `.relay/`).
    const stored = await ctx.store.get(ref.hash);
    expect(stored?.length).toBeGreaterThan(0);
    expect(stored).toEqual(Buffer.from(capture.data, 'base64'));
    const parsed = parseFrontmatter(
      await readFile(relayPaths(relayDir).baselineRefFile('panel-baseline'), 'utf8'),
    );
    expect(parsed.data).toMatchObject({ hash: ref.hash, version: 1, granularity: 'structural' });
  }, 180_000);

  test('a re-capture of the static panel grades within tolerance (V7-scoped, byte-stable)', async () => {
    const tree = (await surface.snapshot()).tree;
    const panelRef = refForLabel(tree, 'panel');
    const ctx = ctxFor('panel-baseline');

    const grade = await verifyBaselineDiff(
      surface,
      { granularity: 'baseline-diff', path: [], scope: { ref: panelRef, element: 'panel' } },
      ctx,
    );
    expect(grade.pass).toBe(true);
    expect(grade.rationale).toMatch(/within tolerance/i);
    expect(seen).toHaveLength(0);
  }, 180_000);

  test('a full-frame baseline drifts as the clock ticks → mismatch surfaced (F2)', async () => {
    const ctx = ctxFor('frame-baseline');
    // Promote the whole frame (includes the ticking clock) as the baseline.
    const first = await surface.screenshot();
    await promoteBaseline(ctx, first, { granularity: 'structural', tolerance: 0 });

    // Let the clock advance, then grade — every re-capture differs from the baseline,
    // so the diff persists above tolerance against a healthy app → a mismatch decision.
    await new Promise((r) => setTimeout(r, 250));
    const grade = await verifyBaselineDiff(
      surface,
      { granularity: 'baseline-diff', path: [] },
      ctx,
    );

    expect(grade.pass).toBe(false); // never an auto-pass
    expect(seen.some((m) => m.outcomeId === 'frame-baseline' && m.kind === 'regression')).toBe(
      true,
    );
    expect((await readBaselineRef(relayDir, 'frame-baseline'))?.version).toBe(1); // not overwritten
  }, 180_000);
});
