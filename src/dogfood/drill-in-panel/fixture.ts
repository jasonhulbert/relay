// The evidence drill-in panel dogfood fixture: a byte-deterministic `.relay/` store whose
// target node carries an ordered set of evidence captures, plus `PANEL_FIXTURE` — the
// declared deterministic grounding the visual outcome grades against (a visual outcome
// declares a deterministic fixture by default). A later step builds the panel and replays
// the seed's semantic-action path over a freshly built copy of this fixture.
//
// The fixture is built the same way the rest of the suite builds state: a programmatic
// writer into a caller-supplied dir (cf. `buildCompactorFixture`), with fixed content
// and timestamps so two builds are identical. The `.relay/` records are written through
// the real relay-state serializers, so the target node carries exactly the
// `evidenceRefs` shape the web view's projection already lifts — the fixture cannot
// drift from the on-disk contract the read-only view renders.
//
// What the fixture deliberately models: a single done leaf (`sample-leaf`) with THREE
// ordered captures of distinct kinds (diff → self-report → verdict), so the panel has a
// node to open, evidence to render, and more than one capture to navigate between. The
// view writes nothing: navigation is plain GET between server-rendered panel states, so
// the fixture needs no app-side mutable state.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeManifest, writeNode } from '../../relay-state/index';
import type { EvidenceRef, NodeRecord, RootManifest } from '../../relay-state/index';

const RUN_ID = 'run-1';
const ROOT_ID = 'root';
const TARGET_NODE_ID = 'sample-leaf';
const CREATED_AT = '2026-06-20T00:00:00.000Z';

// The target node's ordered evidence captures. Order is load-bearing: the panel opens
// at capture 0 and the seed's path navigates to capture 1, so the structural check
// grades the facts of the SECOND capture (the self-report). Distinct kinds make the
// navigation observable — the panel reads differently at each capture.
const CAPTURES = [
  {
    path: `${TARGET_NODE_ID}/diff.md`,
    kind: 'diff' as const,
    summary: 'unified diff sample-leaf produced',
  },
  {
    path: `${TARGET_NODE_ID}/self-report.md`,
    kind: 'self-report' as const,
    summary: 'sample-leaf executor self-report',
  },
  {
    path: `${TARGET_NODE_ID}/verdict.md`,
    kind: 'verdict' as const,
    summary: 'critic verdict accepting sample-leaf',
  },
] satisfies { path: string; kind: EvidenceRef['kind']; summary: string }[];

// The deterministic grounding the visual outcome declares and the single source of
// truth both the seed and the panel read from. It pins the seeded data (the run /
// target node / ordered captures), the route the panel is reached at, the frame size a
// deterministic capture is taken at, and the DOM contract the semantic-action path
// addresses — the `data-testid`s the panel must honor, so the seed's path/scope
// resolve against the real panel exactly as the compactor seed's `check` selectors
// pinned that dogfood's test names.
export const PANEL_FIXTURE = {
  runId: RUN_ID,
  rootId: ROOT_ID,
  targetNodeId: TARGET_NODE_ID,
  // The read-only web view is the host surface. The panel extends it: the run page
  // `/` lists nodes with an open-evidence control, and `/node/<id>` is the drill-in
  // panel for one node, navigating captures by `?capture=<n>` — all plain GET.
  hostRoute: '/',
  panelRouteFor: (nodeId: string, capture = 0): string =>
    capture === 0 ? `/node/${nodeId}` : `/node/${nodeId}?capture=${capture.toString()}`,
  // A pinned frame so a screenshot/baseline-diff rung is deterministic.
  frame: { width: 1024, height: 768 },
  captures: CAPTURES,
  // The drill-in panel's DOM contract: the test ids the seed's semantic-action path
  // clicks and the structural check scopes to. The panel renders these.
  selectors: {
    // The scoped panel container the structural rung asserts against.
    panel: '[data-testid="evidence-panel"]',
    // The run-page control that opens the target node's drill-in panel.
    openEvidence: `[data-testid="open-evidence-${TARGET_NODE_ID}"]`,
    // The in-panel control that advances to the next capture.
    nextCapture: '[data-testid="evidence-next"]',
  },
} as const;

export interface DrillInPanelFixture {
  // The built `.relay/` store root the read-only view renders.
  relayDir: string;
  // The run's evidence dir (evidence/<runId>/) the captures live under.
  evidenceDir: string;
  runId: string;
  targetNodeId: string;
}

// A capture's deterministic body. Kept human-readable (the captures are Markdown the
// panel renders) and fixed so two builds are byte-identical.
function captureBody(kind: string, summary: string): string {
  return `# ${kind}\n\n${summary}\n`;
}

function node(
  id: string,
  status: NodeRecord['status'],
  kind: NodeRecord['kind'],
  children: string[],
  refs: EvidenceRef[],
): NodeRecord {
  return {
    id,
    parentId: id === ROOT_ID ? null : ROOT_ID,
    kind,
    status,
    spec: {
      outcome: `${id} outcome`,
      verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
    },
    children,
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: refs,
    blocked: null,
  };
}

// Build the fixture into `baseDir`: a `.relay/` store with a done root branch over one
// done leaf (`sample-leaf`) that carries the ordered captures, and the capture files
// materialized under the run's evidence dir. Deterministic — fixed content and
// timestamps — so the loop run can rebuild a clean copy per run and grade the panel
// against `PANEL_FIXTURE`.
export async function buildDrillInPanelFixture(baseDir: string): Promise<DrillInPanelFixture> {
  const relayDir = join(baseDir, '.relay');
  const evidenceDir = join(relayDir, 'evidence', RUN_ID);

  const refs: EvidenceRef[] = CAPTURES.map((c) => ({
    runId: RUN_ID,
    path: c.path,
    kind: c.kind,
    summary: c.summary,
  }));

  const manifest: RootManifest = {
    runId: RUN_ID,
    rootId: ROOT_ID,
    spec: {
      outcome: 'a sample run whose leaf carries evidence the drill-in panel renders',
      verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
    },
    sketch: { notes: [] },
    createdAt: CREATED_AT,
  };
  await writeManifest(relayDir, manifest);

  await writeNode(relayDir, node(ROOT_ID, 'done', 'branch', [TARGET_NODE_ID], []));
  await writeNode(relayDir, node(TARGET_NODE_ID, 'done', 'leaf', [], refs));

  // Materialize each capture under the evidence dir so the panel has real files to read.
  for (const c of CAPTURES) {
    const abs = join(evidenceDir, c.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, captureBody(c.kind, c.summary), 'utf8');
  }

  return { relayDir, evidenceDir, runId: RUN_ID, targetNodeId: TARGET_NODE_ID };
}
