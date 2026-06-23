// The evidence drill-in panel dogfood's run seed. This is the SECOND pinned dogfood and
// the first to drive the full visual path: a bounded new feature on the read-only web
// view — open a node, render its evidence, navigate its captures — graded by a `visual`
// outcome that exercises the visual subsystem (replayed semantic-action path,
// match-granularity, semantic element-scoping, and a captured-and-promoted baseline at
// run time when the loop runs).
//
// The seed-production step only PRODUCES the seed and the fixture it grades against; a
// later step commits this seed via intake and runs it end-to-end. The seed is authored
// here as the interviewer's final message — prose wrapping a fenced ```json document —
// and compiled through the REAL intake path (`compileSeed`), so "the outcome spec and
// grounding are committed via intake" is exercised on the same code a live conversation
// would.
//
// The visual verification's structured replay spec rides as a JSON document in `check`
// (a `VisualVerification`): intake REQUIRES its match-granularity and semantic-action
// path (see `validateVisualCheck`), and the visual critic parses it back into a
// `VisualVerification` to replay. Authoring it as a typed object here — then serializing
// — keeps the seed and the critic on one shape rather than a hand-typed blob.
import { compileSeed } from '../../intake/index';
import type { IntakeSeed } from '../../intake/index';
import type { Interaction, VisualVerification } from '../../surface/index';
import { PANEL_FIXTURE } from './fixture';

// The capture the structural rung grades: index 1 (the self-report), reached by the
// path navigating one step from the panel's opening capture. Its semantic facts — the
// node id, the capture kind, and the capture summary — are what the scoped panel
// subtree must carry, so they are the structural expectation.
const GRADED_CAPTURE = PANEL_FIXTURE.captures[1];

// The executor-emitted semantic-action path the critic replays: on the read-only
// view's run page, open the target node's drill-in panel, then advance one capture.
// Navigation is plain GET between server-rendered panel states (the view writes nothing),
// driven here as clicks on the panel's pinned controls (`PANEL_FIXTURE.selectors`).
const PATH: Interaction[] = [
  {
    kind: 'click',
    ref: PANEL_FIXTURE.selectors.openEvidence,
    element: `open evidence for ${PANEL_FIXTURE.targetNodeId}`,
  },
  {
    kind: 'click',
    ref: PANEL_FIXTURE.selectors.nextCapture,
    element: 'next capture',
  },
];

// The visual outcome, declared at STRUCTURAL granularity: after the replay, the
// element-scoped panel subtree must carry the second capture's semantic facts. The
// structural rung is the gate the panel must pass and is "structural-or-better", so the
// first pass earns a promoted baseline. The runtime match-granularity ladder
// (intent → structural → baseline-diff) is for the loop run to walk; the seed declares
// the rung the outcome is pinned at.
const VISUAL: Extract<VisualVerification, { granularity: 'structural' }> = {
  granularity: 'structural',
  path: PATH,
  scope: { ref: PANEL_FIXTURE.selectors.panel, element: 'evidence drill-in panel' },
  expectSubtree: [PANEL_FIXTURE.targetNodeId, GRADED_CAPTURE.kind, GRADED_CAPTURE.summary],
};

// The grounding (required verification grounding): cite the deterministic fixture
// explicitly — the seeded run, the target node and its ordered captures, the host route,
// and the frame — so the committed visual outcome names exactly the deterministic fixture
// it is graded against.
const GROUNDING = [
  `The deterministic fixture (buildDrillInPanelFixture) seeds a .relay/ run`,
  `whose leaf \`${PANEL_FIXTURE.targetNodeId}\` carries ${PANEL_FIXTURE.captures.length.toString()} ordered`,
  `evidence captures (${PANEL_FIXTURE.captures.map((c) => c.kind).join(', ')}).`,
  `The read-only web view hosts the panel at route \`${PANEL_FIXTURE.hostRoute}\`;`,
  `the path opens that node and advances to capture 2 (the self-report), so the panel`,
  `subtree, scoped to ${PANEL_FIXTURE.selectors.panel}, must then carry the node id, the`,
  `self-report kind, and its summary "${GRADED_CAPTURE.summary}".`,
].join(' ');

// The interviewer's final message: prose wrapping the fenced ```json seed. The visual
// verification's `check` is the serialized `VisualVerification` (single-line so it
// round-trips cleanly through the manifest's YAML front-matter).
export const DRILL_IN_PANEL_SEED_MESSAGE = [
  'I have enough to seed the evidence drill-in panel run. Here is the seed:',
  '',
  '```json',
  JSON.stringify(
    {
      kind: 'seed',
      outcome:
        'The read-only web view gains an evidence drill-in panel: opening a node renders its evidence and navigating advances through that node’s ordered captures.',
      verifications: [
        {
          kind: 'visual',
          grounding: GROUNDING,
          check: JSON.stringify(VISUAL),
        },
      ],
      // Non-binding orientation only (a Sketch carries no children/footprints/seams, so
      // it cannot smuggle a binding plan into the root). The brain owns decomposition at
      // activation and may diverge from every note here.
      sketch: {
        notes: [
          'Extend the read-only web view (render.ts/server.ts): a `/node/<id>` panel route plus a per-node open-evidence control on the run page. Writes nothing; navigate captures by GET (?capture=<n>).',
          `Honor the panel DOM contract the seed addresses: ${PANEL_FIXTURE.selectors.panel} (scope), ${PANEL_FIXTURE.selectors.openEvidence} (open), ${PANEL_FIXTURE.selectors.nextCapture} (next).`,
          'Scope the structural check to the panel so an unrelated region in the frame cannot decide the verdict.',
          'The first structural-or-better pass promotes a baseline: ref in .relay/, binary in the content-addressed store.',
        ],
      },
    },
    null,
    2,
  ),
  '```',
  '',
  'Approve to commit.',
].join('\n');

// Compile the drill-in panel seed through the real intake compiler. Deterministic (no
// live model): exactly the parse + validate (incl. the visual match-granularity and
// semantic-action path checks) the loop run commits via `commitRoot`. Exported so both
// the "commits via intake" test and the full loop run use one source.
export function drillInPanelSeed(): IntakeSeed {
  return compileSeed(DRILL_IN_PANEL_SEED_MESSAGE);
}
