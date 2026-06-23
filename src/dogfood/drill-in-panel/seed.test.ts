import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readManifest, readNode, tryReadLayer } from '../../relay-state/index';
import { commitRoot } from '../../intake/index';
import { drillInPanelSeed } from './seed';
import { PANEL_FIXTURE, buildDrillInPanelFixture } from './fixture';

// Seed-production validation criterion 1: "The outcome spec, grounding, and
// deterministic fixture are committed via intake." The drill-in panel seed is compiled
// through the REAL intake compiler and committed by the REAL `commitRoot` — the same path
// a live conversation takes — so this is the falsifiable "spec+grounding+fixture commit
// via intake" claim, hermetic and deterministic (no live model).
describe('the drill-in panel outcome spec, grounding, and fixture commit via intake', () => {
  test('the seed compiles and commits as a childless root carrying the grounded visual outcome', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-drill-in-seed-'));
    const relayDir = join(base, '.relay');
    try {
      // Compiling already proves the visual outcome is grounded AND carries a valid
      // match-granularity + semantic-action path — intake rejects a seed missing any.
      const seed = drillInPanelSeed();
      expect(seed.spec.outcome).toMatch(/drill-in panel/i);
      expect(seed.spec.verifications).toHaveLength(1);
      const visual = seed.spec.verifications[0];
      expect(visual.kind).toBe('visual');
      expect(visual.grounding.trim()).not.toBe('');
      // The grounding declares the deterministic fixture: the route and the target
      // node it grades against, so the committed outcome names its own fixture.
      expect(visual.grounding).toContain(PANEL_FIXTURE.targetNodeId);
      expect(visual.grounding).toContain(PANEL_FIXTURE.hostRoute);

      const { rootId } = await commitRoot(relayDir, seed, {
        createdAt: '2026-06-20T00:00:00.000Z',
      });

      // The committed root carries the outcome spec and grounded visual verification
      // verbatim — the JSON replay spec in `check` round-trips through the manifest's
      // YAML front-matter, so the loop run reads back exactly what was committed.
      const manifest = await readManifest(relayDir);
      expect(manifest.spec).toEqual(seed.spec);

      // Intake commits NO binding decomposition: the root is a childless pending branch
      // with no layer manifest, and the commit is one clean atomic transaction.
      const root = await readNode(relayDir, rootId);
      expect(root.kind).toBe('branch');
      expect(root.status).toBe('pending');
      expect(root.children).toEqual([]);
      expect(await tryReadLayer(relayDir, rootId)).toBeNull();
      expect(await pendingIntents(relayDir, rootId)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Seed-production validation criterion 2: "A required match-granularity field and a
  // semantic-action path are present on the visual outcome." Re-checked here on the
  // COMMITTED spec, the form the loop run replays.
  test('the committed visual outcome carries a match-granularity and a non-empty semantic-action path', () => {
    const seed = drillInPanelSeed();
    const visual = seed.spec.verifications.find((v) => v.kind === 'visual');
    expect(visual).toBeDefined();
    const spec = JSON.parse(visual!.check) as {
      granularity: string;
      path: { kind: string; ref?: string }[];
      scope?: { ref: string };
      expectSubtree?: string[];
    };
    // The match-granularity field — structural is the gate the panel must pass and
    // is "structural-or-better", so the first pass earns a promoted baseline.
    expect(spec.granularity).toBe('structural');
    // The semantic-action path: a non-empty ordered sequence of interactions.
    expect(spec.path.length).toBeGreaterThan(0);
    expect(spec.path.every((step) => typeof step.kind === 'string')).toBe(true);
    // It is element-scoped to the panel, so an unrelated region cannot decide it,
    // and the structural facts it asserts are the second capture's (the navigated-to one).
    expect(spec.scope?.ref).toBe(PANEL_FIXTURE.selectors.panel);
    expect(spec.expectSubtree).toContain(PANEL_FIXTURE.targetNodeId);
    expect(spec.expectSubtree).toContain(PANEL_FIXTURE.captures[1].kind);
  });
});

// The deterministic fixture is what the committed grounding points at: the seeded
// `.relay/` run the read-only view renders. These assert it builds deterministically and
// that its target node carries the ordered captures `PANEL_FIXTURE` declares — so the
// loop run can trust the fixture as the graded grounding.
describe('the drill-in panel fixture seeds a node with ordered, navigable captures', () => {
  test('PANEL_FIXTURE declares more than one ordered capture so navigation is meaningful', () => {
    expect(PANEL_FIXTURE.captures.length).toBeGreaterThan(1);
    // Distinct kinds make each capture observably different as the panel navigates.
    const kinds = PANEL_FIXTURE.captures.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  test('the built fixture materializes the target node with exactly the declared captures', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-drill-in-fixture-'));
    try {
      const fx = await buildDrillInPanelFixture(base);
      expect(fx.targetNodeId).toBe(PANEL_FIXTURE.targetNodeId);

      // The target node carries exactly the declared evidence refs, in order — the shape
      // the read-only web view's projection lifts and the panel renders.
      const node = await readNode(fx.relayDir, fx.targetNodeId);
      expect(node.status).toBe('done');
      expect(node.evidenceRefs.map((r) => r.path)).toEqual(
        PANEL_FIXTURE.captures.map((c) => c.path),
      );
      expect(node.evidenceRefs.map((r) => r.kind)).toEqual(
        PANEL_FIXTURE.captures.map((c) => c.kind),
      );

      // Each capture file is materialized under the evidence dir for the panel to read.
      for (const c of PANEL_FIXTURE.captures) {
        const body = await readFile(join(fx.evidenceDir, c.path), 'utf8');
        expect(body).toContain(c.summary);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('the fixture is byte-deterministic: two builds produce identical node files', async () => {
    const a = await mkdtemp(join(tmpdir(), 'relay-drill-in-det-a-'));
    const b = await mkdtemp(join(tmpdir(), 'relay-drill-in-det-b-'));
    try {
      const fxA = await buildDrillInPanelFixture(a);
      const fxB = await buildDrillInPanelFixture(b);
      const nodeA = await readFile(join(fxA.relayDir, 'nodes', `${fxA.targetNodeId}.md`), 'utf8');
      const nodeB = await readFile(join(fxB.relayDir, 'nodes', `${fxB.targetNodeId}.md`), 'utf8');
      expect(nodeA).toBe(nodeB);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});
