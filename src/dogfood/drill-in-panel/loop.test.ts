// The dogfood headline: the SECOND pinned dogfood driven through the full loop, and the
// first to exercise the entire visual path. The committed drill-in-panel seed is compiled
// by the REAL intake compiler, committed by the REAL `commitRoot`, decomposed, executed,
// and gated by the visual critic bridge — which REPLAYS the seed's semantic-action path
// against the REAL read-only web view serving the panel, grades it at structural
// granularity scoped to the panel element, and captures-and-promotes a baseline. The loop
// reaches `done` ONLY because the panel actually renders the node's evidence — break the
// panel render and the structural facts vanish from the scoped snapshot, the grade fails,
// the leaf blocks, and the root never reaches `done`. That coupling is the dogfood's point.
//
// What is hermetic vs. real here: the intake compile + commit, the orchestrator state
// machine, the brain decomposition, the read-only web view (started for real over HTTP
// and serving the real `renderNodePanel`), the visual critic's replay + structural grade,
// and the baseline promote are all real. The ONE stand-in is the browser layer: the
// Surface drives the running server over plain GET (the same `panelHref` routes the
// server serves), and its a11y "snapshot" is the served panel HTML scoped to the
// element while its "screenshot" is that HTML's bytes — deterministic because the
// render is. No Chromium, exactly as the surface unit tests inject a stand-in Surface.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readNode, toCriticView } from '../../relay-state/index';
import type { NodeRecord } from '../../relay-state/index';
import { commitRoot, compileSeed } from '../../intake/index';
import { runOrchestrator, visualCritic, STUB_USAGE } from '../../spine/index';
import type {
  Brain,
  DecomposeRequest,
  DecomposeResult,
  Executor,
  ExecutorResult,
} from '../../spine/index';
import { startWebView, panelHref } from '../../webview/index';
import type { StartedWebView } from '../../webview/index';
import { BaselineStore, readBaselineRef, SurfaceCallError } from '../../surface/index';
import type { Interaction, Surface } from '../../surface/index';
import { DRILL_IN_PANEL_SEED_MESSAGE } from './seed';
import { PANEL_FIXTURE, buildDrillInPanelFixture } from './fixture';

// A one-leaf brain (cf. the compactor dogfood): decompose the committed childless root
// into a SINGLE leaf carrying the root's exact verifications (the visual outcome), so
// the visual critic grades that leaf against the committed spec.
const oneLeafBrain: Brain = {
  decompose(req: DecomposeRequest): Promise<DecomposeResult> {
    return Promise.resolve({
      decomposition: {
        children: [{ spec: req.spec, kind: 'leaf', footprint: { writeGlobs: ['**'] } }],
        seams: [],
      },
      rationale: 'single leaf carrying the root verifications (drill-in-panel dogfood)',
    });
  },
};

// The executor stand-in: in a real run it edits the read-only web view to build the
// panel; here the panel is the real production code already on disk and served, so it
// only produces a gradeable change. The visual critic ignores the diff and grades the
// live render — the same "checkout-emulating executor" shape the compactor dogfood uses.
const panelExecutor: Executor = {
  capabilities: () => ({
    provider: 'dogfood',
    json: false,
    resume: false,
    sandbox: true,
    mcp: false,
  }),
  run(): Promise<ExecutorResult> {
    return Promise.resolve({
      diff: 'M src/webview/render.ts\n+the evidence drill-in panel and its /node/<id> route',
      selfReport: 'Built the evidence drill-in panel on the read-only web view.',
      usage: STUB_USAGE,
      exitStatus: 0,
    });
  },
};

// Pull the `data-testid` out of a `[data-testid="X"]` selector ref (the form the seed's
// path and scope use). An unrecognized ref is a drifted step — a typed Surface failure.
function parseTestId(ref: string): string {
  const m = /\[data-testid="([^"]+)"\]/.exec(ref);
  if (!m) throw new SurfaceCallError('browser_click', `unsupported ref ${ref}`);
  return m[1];
}

// Slice the element carrying `data-testid="<testid>"` out of a served page — the
// element scope (only this subtree is graded). The panel is a single `<section>` with no
// nested section, so matching the opening tag's close is unambiguous.
function extractElement(html: string, testid: string): string {
  const marker = `data-testid="${testid}"`;
  const at = html.indexOf(marker);
  if (at === -1) return '';
  const start = html.lastIndexOf('<', at);
  const tagMatch = /^<([a-zA-Z0-9]+)/.exec(html.slice(start));
  if (!tagMatch) return '';
  const close = `</${tagMatch[1]}>`;
  const end = html.indexOf(close, at);
  return end === -1 ? html.slice(start) : html.slice(start, end + close.length);
}

// A Surface that drives the REAL web view over HTTP and grades the REAL panel render.
// Navigation is the same plain GET the server serves (`panelHref`), so the `/node/<id>`
// route, the `?capture=` capture navigation, and the panel DOM contract are exercised
// for real. Only the browser/a11y/pixel layer is a deterministic stand-in: the
// "snapshot" is the served panel HTML scoped to the element, and the "screenshot" is
// that HTML's bytes (deterministic because the render is).
function webPanelSurface(baseUrl: string): { surface: Surface; interactions: Interaction[] } {
  const interactions: Interaction[] = [];
  let lastHtml = '';
  let node: string | null = null;
  let capture = 0;

  const get = async (path: string): Promise<string> => {
    const res = await fetch(`${baseUrl}${path}`);
    if (res.status !== 200) {
      throw new SurfaceCallError('browser_navigate', `GET ${path} -> ${res.status.toString()}`);
    }
    return res.text();
  };

  const surface: Surface = {
    capabilities: () => ({ kind: 'web', semantic: true, screenshot: true, resize: true }),
    launch: async () => {
      lastHtml = await get('/');
    },
    resize: async () => undefined,
    snapshot: async (opts) => ({
      tree: opts?.ref ? extractElement(lastHtml, parseTestId(opts.ref)) : lastHtml,
    }),
    screenshot: async (opts) => {
      const html = opts?.ref ? extractElement(lastHtml, parseTestId(opts.ref)) : lastHtml;
      return { data: Buffer.from(html, 'utf8').toString('base64'), mimeType: 'image/png' };
    },
    interact: async (action) => {
      interactions.push(action);
      if (action.kind !== 'click') return;
      const testid = parseTestId(action.ref);
      if (testid.startsWith('open-evidence-')) {
        node = testid.slice('open-evidence-'.length);
        capture = 0;
        lastHtml = await get(panelHref(node, capture));
      } else if (testid === 'evidence-next') {
        if (node === null) {
          throw new SurfaceCallError(
            'browser_click',
            'evidence-next clicked before opening a node',
          );
        }
        capture += 1;
        lastHtml = await get(panelHref(node, capture));
      } else {
        throw new SurfaceCallError('browser_click', `no element for ${action.ref}`);
      }
    },
    queryState: async () => {
      await get('/');
      return { value: 'true' };
    },
    close: async () => undefined,
  };
  return { surface, interactions };
}

describe('the drill-in panel dogfood runs through the real loop from intake to done', () => {
  test('the committed seed builds the panel, replays the path, and promotes a baseline', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-drill-in-loop-'));
    const relayDir = join(base, '.relay'); // the OUTER run being graded
    const workRoot = join(base, 'worktrees');
    const store = new BaselineStore(join(base, 'baseline-store')); // sibling of `.relay/`
    let started: StartedWebView | undefined;
    try {
      // The deterministic fixture: a fresh seeded `.relay/` run whose leaf carries
      // the ordered captures the panel renders. The read-only web view hosts the panel
      // against it; the panel is reached over plain GET.
      const fx = await buildDrillInPanelFixture(join(base, 'fixture'));
      started = await startWebView({ relayDir: fx.relayDir });
      const { surface, interactions } = webPanelSurface(started.url);

      // Intake: compile the seed through the REAL compiler and commit the root — the
      // same path a live conversation takes (grounding + visual match-granularity +
      // semantic-action path all validated on the way in).
      const seed = compileSeed(DRILL_IN_PANEL_SEED_MESSAGE);
      await commitRoot(relayDir, seed, { createdAt: '2026-06-20T00:00:00.000Z' });

      // The full loop: decompose → execute → visual critic (replay + structural grade +
      // baseline promote) → done. The visual critic IS the done-ness gate.
      const result = await runOrchestrator(relayDir, 'root', {
        executor: panelExecutor,
        brain: oneLeafBrain,
        critic: visualCritic({
          surface,
          relayDir,
          outcomeId: 'drill-in-panel',
          store,
          sink: async () => undefined,
        }),
        workRoot,
      });

      // Validation 3: the full loop reached done from intake's committed root.
      expect(result.rootStatus).toBe('done');
      const leafId = 'root.c0';
      expect(result.leafStatuses[leafId]).toBe('done');

      // Validation 1: the leaf was certified by the visual critic at structural
      // granularity — and the semantic-action path was REPLAYED: open the node,
      // advance one capture, exactly the seed's path against the panel DOM contract.
      const leaf = await readNode(relayDir, leafId);
      expect(leaf.status).toBe('done');
      expect(leaf.verdict?.pass).toBe(true);
      expect(leaf.verdict?.provider).toBe('visual-critic');
      expect(interactions.map((i) => (i.kind === 'click' ? i.ref : i.kind))).toEqual([
        PANEL_FIXTURE.selectors.openEvidence,
        PANEL_FIXTURE.selectors.nextCapture,
      ]);

      // Validation 2: the first structural-or-better pass promoted a baseline — the ref
      // in `.relay/`, the binary in the sibling content-addressed store.
      const ref = await readBaselineRef(relayDir, 'drill-in-panel');
      expect(ref).not.toBeNull();
      expect(ref?.version).toBe(1);
      expect(ref?.granularity).toBe('structural');
      expect(await store.has(ref!.hash)).toBe(true);

      const root = await readNode(relayDir, 'root');
      expect(root.status).toBe('done');
    } finally {
      started?.server.close();
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (the dogfood coupling, falsifiable): the loop reaches done ONLY because the
  // panel renders the evidence. If the panel could not surface the navigated capture's
  // facts, the scoped structural grade would miss them — so a check whose expectation
  // the real render cannot satisfy must FAIL and promote no baseline. This proves the
  // green run above is earned by the render, not by a critic that passes regardless.
  test('a structural expectation the real panel cannot satisfy fails the gate', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-drill-in-neg-'));
    const relayDir = join(base, '.relay');
    const store = new BaselineStore(join(base, 'baseline-store'));
    let started: StartedWebView | undefined;
    try {
      const fx = await buildDrillInPanelFixture(join(base, 'fixture'));
      started = await startWebView({ relayDir: fx.relayDir });
      const { surface } = webPanelSurface(started.url);

      // Same committed seed, but demand a fact the panel does not render. Build the view
      // by hand to keep the negative isolated to the grade (intake + commit are proven
      // above); the path/scope are the real ones, only the expectation is unreachable.
      const seed = compileSeed(DRILL_IN_PANEL_SEED_MESSAGE);
      const visual = seed.spec.verifications[0];
      const check = JSON.parse(visual.check) as { expectSubtree: string[] };
      check.expectSubtree = ['a fact the panel never renders'];
      const node: NodeRecord = {
        id: 'leaf',
        parentId: 'root',
        kind: 'leaf',
        status: 'active',
        spec: {
          outcome: seed.spec.outcome,
          verifications: [
            { kind: 'visual', grounding: visual.grounding, check: JSON.stringify(check) },
          ],
        },
        children: [],
        selfReport: null,
        learnings: [],
        verdict: null,
        evidenceRefs: [],
        blocked: null,
      };

      const verdict = await visualCritic({
        surface,
        relayDir,
        outcomeId: 'drill-in-panel',
        store,
        sink: async () => undefined,
      })(toCriticView(node, ''), { worktree: '/unused', mcpServers: [] });

      expect(verdict.pass).toBe(false);
      expect(await readBaselineRef(relayDir, 'drill-in-panel')).toBeNull();
    } finally {
      started?.server.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
