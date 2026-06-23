import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { toCriticView } from '../relay-state/index';
import type { CriticView, NodeRecord } from '../relay-state/index';
import { BaselineStore, readBaselineRef } from '../surface/index';
import { SurfaceCallError } from '../surface/index';
import type { BaselineMismatch, Interaction, Surface, VisualVerification } from '../surface/index';
import { parseVisualCheck, visualCritic } from './visual-critic';

// A configurable in-memory Surface (the visual-critic.test.ts pattern): a scripted
// snapshot tree and screenshot bytes, with `interact` recorded so a replay can be
// asserted and optionally scripted to throw a typed failure (the drift re-dispatch
// path). No browser.
function fakeSurface(cfg: {
  tree?: string;
  shotData?: string;
  alive?: boolean;
  throwOnStep?: { index: number; error: unknown };
}): { surface: Surface; interactions: Interaction[] } {
  const interactions: Interaction[] = [];
  const surface: Surface = {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: async () => undefined,
    resize: async () => undefined,
    snapshot: async () => ({ tree: cfg.tree ?? '' }),
    // `Screenshot.data` is base64 image bytes (the contract), so encode the scripted
    // frame the same way a real driver would — else the baseline store's decode/encode
    // round-trip would not match a "same frame" capture.
    screenshot: async () => ({
      data: Buffer.from(cfg.shotData ?? 'shot-bytes', 'utf8').toString('base64'),
      mimeType: 'image/png',
    }),
    interact: async (action) => {
      const step = interactions.length;
      interactions.push(action);
      if (cfg.throwOnStep && cfg.throwOnStep.index === step) throw cfg.throwOnStep.error;
    },
    queryState: async () => {
      if (cfg.alive === false) throw new Error('app is gone');
      return { value: 'true' };
    },
    close: async () => undefined,
  };
  return { surface, interactions };
}

// Build the evidence-only critic view for an outcome carrying one `visual` verification
// whose check is the serialized `VisualVerification` — exactly the on-disk encoding the
// bridge reads back.
function visualView(verification: VisualVerification): CriticView {
  const node: NodeRecord = {
    id: 'leaf',
    parentId: 'root',
    kind: 'leaf',
    status: 'active',
    spec: {
      outcome: 'the panel renders a node’s evidence',
      verifications: [
        {
          kind: 'visual',
          grounding: 'the deterministic fixture',
          check: JSON.stringify(verification),
        },
      ],
    },
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  return toCriticView(node, 'a diff');
}

const PATH: Interaction[] = [
  { kind: 'click', ref: '[data-testid="open-evidence-sample-leaf"]' },
  { kind: 'click', ref: '[data-testid="evidence-next"]' },
];

const structural = (expectSubtree: string[]): VisualVerification => ({
  granularity: 'structural',
  path: PATH,
  scope: { ref: '[data-testid="evidence-panel"]', element: 'evidence drill-in panel' },
  expectSubtree,
});

// WHY (the bridge is `JSON.parse(check) as VisualVerification`, re-guarded at the
// trust boundary): the check is opaque text on disk by the time the critic reads it. A
// malformed document must fail loud, not silently grade against a half-typed spec.
describe('parseVisualCheck', () => {
  test('round-trips a serialized VisualVerification', () => {
    const v = structural(['x']);
    expect(parseVisualCheck(JSON.stringify(v))).toEqual(v);
  });

  test('fails loud on a check with no valid match-granularity', () => {
    expect(() => parseVisualCheck(JSON.stringify({ path: [] }))).toThrow(/match-granularity/);
  });

  test('fails loud on a check with no semantic-action path', () => {
    expect(() => parseVisualCheck(JSON.stringify({ granularity: 'structural' }))).toThrow(
      /semantic-action path/,
    );
  });
});

describe('visualCritic (the visual-critic bridge)', () => {
  async function ctx(): Promise<{
    relayDir: string;
    store: BaselineStore;
    cleanup: () => Promise<void>;
  }> {
    const base = await mkdtemp(join(tmpdir(), 'relay-visual-critic-'));
    return {
      relayDir: join(base, '.relay'),
      store: new BaselineStore(join(base, 'baseline-store')),
      cleanup: () => rm(base, { recursive: true, force: true }),
    };
  }

  // WHY (Validation: the visual outcome passes at structural granularity AND the first
  // structural-or-better pass promotes a baseline): a structural pass is the gate,
  // and because it is structural-or-better it must capture-and-promote the first
  // baseline — ref in `.relay/`, binary in the sibling store.
  test('a structural pass grades pass and promotes the first baseline', async () => {
    const c = await ctx();
    try {
      const { surface, interactions } = fakeSurface({
        tree: 'node sample-leaf\nself-report\nsample-leaf executor self-report',
        shotData: 'panel-frame-bytes',
      });
      const sink = async (): Promise<void> => undefined;
      const critic = visualCritic({
        surface,
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
        sink,
      });

      const verdict = await critic(
        visualView(structural(['sample-leaf', 'self-report', 'sample-leaf executor self-report'])),
        { worktree: '/unused', mcpServers: [] },
      );

      // The path was replayed before grading.
      expect(interactions).toEqual(PATH);
      expect(verdict.pass).toBe(true);
      expect(verdict.provider).toBe('visual-critic');

      // Ref in `.relay/`, binary in the store, promoted at the structural rung.
      const ref = await readBaselineRef(c.relayDir, 'drill-in-panel');
      expect(ref).not.toBeNull();
      expect(ref?.version).toBe(1);
      expect(ref?.granularity).toBe('structural');
      expect(await c.store.has(ref!.hash)).toBe(true);
    } finally {
      await c.cleanup();
    }
  });

  // WHY: a missing structural fact is a real fail — the panel did not render the
  // evidence the outcome asserts. It must fail and NOT promote a baseline (baseline
  // promotion never freezes a UI that did not pass its gate).
  test('a structural miss fails and promotes no baseline', async () => {
    const c = await ctx();
    try {
      const { surface } = fakeSurface({ tree: 'node sample-leaf\ndiff' });
      const critic = visualCritic({
        surface,
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
        sink: async () => undefined,
      });
      const verdict = await critic(visualView(structural(['self-report'])), {
        worktree: '/unused',
        mcpServers: [],
      });
      expect(verdict.pass).toBe(false);
      expect(verdict.rationale).toContain('self-report');
      expect(await readBaselineRef(c.relayDir, 'drill-in-panel')).toBeNull();
    } finally {
      await c.cleanup();
    }
  });

  // WHY (drift re-dispatch: a failed replay is classified, no model): a step that fails against a
  // healthy app is a drifted path — re-dispatch — surfaced as a non-pass carrying the
  // classification, never a silent pass.
  test('a replay failure against a healthy app fails with its classification', async () => {
    const c = await ctx();
    try {
      const { surface } = fakeSurface({
        alive: true,
        throwOnStep: { index: 1, error: new SurfaceCallError('browser_click', 'ref not found') },
      });
      const critic = visualCritic({
        surface,
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
        sink: async () => undefined,
      });
      const verdict = await critic(visualView(structural(['x'])), {
        worktree: '/unused',
        mcpServers: [],
      });
      expect(verdict.pass).toBe(false);
      expect(verdict.rationale).toContain('re-dispatch');
    } finally {
      await c.cleanup();
    }
  });

  // WHY: on a later run a known-good baseline already exists, so the bridge diffs
  // against it instead of re-promoting (which baseline promotion refuses) — an identical frame is
  // within tolerance and passes, with no second baseline version written.
  test('a second pass diffs against the existing baseline instead of re-promoting', async () => {
    const c = await ctx();
    try {
      const make = (): Surface =>
        fakeSurface({
          tree: 'node sample-leaf\nself-report\nsample-leaf executor self-report',
          shotData: 'identical-frame',
        }).surface;
      const opts = {
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
        sink: async (): Promise<void> => undefined,
      };
      const expect3 = ['sample-leaf', 'self-report', 'sample-leaf executor self-report'];

      const first = await visualCritic({ ...opts, surface: make() })(
        visualView(structural(expect3)),
        {
          worktree: '/unused',
          mcpServers: [],
        },
      );
      expect(first.pass).toBe(true);
      const v1 = await readBaselineRef(c.relayDir, 'drill-in-panel');

      const second = await visualCritic({ ...opts, surface: make() })(
        visualView(structural(expect3)),
        { worktree: '/unused', mcpServers: [] },
      );
      expect(second.pass).toBe(true);
      expect(second.rationale).toContain('within tolerance');
      // Still version 1 — content addressing + no re-version means no second promote.
      const v2 = await readBaselineRef(c.relayDir, 'drill-in-panel');
      expect(v2?.version).toBe(v1?.version);
    } finally {
      await c.cleanup();
    }
  });

  // WHY: a frame that diverges from the known-good baseline beyond tolerance, against a
  // healthy app, is a regression the human must rule on — surfaced via the sink, never
  // auto-resolved or silently swallowed.
  test('a divergent later frame surfaces a regression mismatch to the human', async () => {
    const c = await ctx();
    try {
      const expect3 = ['sample-leaf', 'self-report', 'sample-leaf executor self-report'];
      const tree = 'node sample-leaf\nself-report\nsample-leaf executor self-report';
      const opts = {
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
      };
      const surfaced: BaselineMismatch[] = [];
      const sink = async (m: BaselineMismatch): Promise<void> => {
        surfaced.push(m);
      };

      await visualCritic({
        ...opts,
        sink,
        surface: fakeSurface({ tree, shotData: 'frame-a' }).surface,
      })(visualView(structural(expect3)), { worktree: '/unused', mcpServers: [] });
      const second = await visualCritic({
        ...opts,
        sink,
        surface: fakeSurface({ tree, shotData: 'frame-b', alive: true }).surface,
      })(visualView(structural(expect3)), { worktree: '/unused', mcpServers: [] });

      expect(second.pass).toBe(false);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0].kind).toBe('regression');
    } finally {
      await c.cleanup();
    }
  });

  // WHY (Rule 11): an outcome with no visual verification is a wiring error, not a
  // pass — the bridge must refuse rather than certify nothing.
  test('refuses an outcome with no visual verification', async () => {
    const c = await ctx();
    try {
      const node: NodeRecord = {
        id: 'leaf',
        parentId: 'root',
        kind: 'leaf',
        status: 'active',
        spec: {
          outcome: 'x',
          verifications: [{ kind: 'command', grounding: 'g', check: 'true' }],
        },
        children: [],
        selfReport: null,
        learnings: [],
        verdict: null,
        evidenceRefs: [],
        blocked: null,
      };
      const verdict = await visualCritic({
        surface: fakeSurface({}).surface,
        relayDir: c.relayDir,
        outcomeId: 'drill-in-panel',
        store: c.store,
        sink: async () => undefined,
      })(toCriticView(node, ''), { worktree: '/unused', mcpServers: [] });
      expect(verdict.pass).toBe(false);
      expect(verdict.rationale).toContain('no visual verification');
    } finally {
      await c.cleanup();
    }
  });
});
