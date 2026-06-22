// The minimal HTML render of a `RunProjection` for the operator web view (M5
// Phase 2). Pure string composition — no I/O, no server — so the render is
// unit-testable on its own and the server (server.ts) only has to wire a request
// to `projectRun` + this. It is strictly a view: it shows the structural,
// supervision-facing fields the projection already lifted (status, provider,
// critic verdict, evidence refs, blocked record) and CANNOT show the
// orchestrator-visible narrative — `NodeView` does not carry it (C7, design §3.6).
//
// Scope: tree + per-node status/provider/verdict/evidence (Phase 2) plus the F5
// budget burn and cost rollup (Phase 3) — per-node spend on each card and the
// whole-run total in the header, sourced from the projection's cost fields. The
// evidence drill-in panel is M9, not this; evidence refs render as their summary +
// path only.
import type {
  CriticVerdict,
  EvidenceRef,
  LayerManifest,
  NodeCost,
  RunCost,
} from '../relay-state/index';
import type { EvidenceContent, NodeView, RunProjection, SupervisorView, TreeNode } from './projection';

// Minimal HTML-attribute/text escaping. The projection's strings are operator
// outcomes and model rationales — untrusted free text — so every interpolated
// value passes through here before it reaches the page.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Dollars to the per-MTok precision the F5 rollup uses (6 dp), so the view reads
// identically to the persisted `cost.md`.
function fmtUsd(cost: number): string {
  return `$${cost.toFixed(6)}`;
}

// One node's budget burn (F5): its priced total, and — surfaced not hidden (Rule
// 11) — a count of any unpriced calls, since an unpriced call means the total
// understates real spend rather than being exact. A node with no attributed call
// has `cost === null` and renders nothing.
function costHtml(cost: NodeCost | null): string {
  if (cost === null) return '';
  const uncosted =
    cost.uncosted === 0
      ? ''
      : ` <span class="cost-uncosted">+${cost.uncosted.toString()} uncosted</span>`;
  return (
    `<div class="cost"><span class="cost-label">burn</span> ` +
    `<span class="cost-total">${fmtUsd(cost.total)}</span>${uncosted}</div>`
  );
}

function verdictHtml(verdict: CriticVerdict): string {
  const mark = verdict.pass ? 'pass' : 'fail';
  return (
    `<div class="verdict verdict-${mark}">` +
    `<span class="verdict-mark">critic: ${mark}</span> ` +
    `<span class="verdict-rationale">${esc(verdict.rationale)}</span>` +
    `</div>`
  );
}

function evidenceHtml(refs: EvidenceRef[]): string {
  if (refs.length === 0) return '';
  const items = refs
    .map(
      (r) =>
        `<li><span class="evidence-kind">${esc(r.kind)}</span> ` +
        `<span class="evidence-summary">${esc(r.summary)}</span> ` +
        `<code class="evidence-path">${esc(r.path)}</code></li>`,
    )
    .join('');
  return `<ul class="evidence">${items}</ul>`;
}

// The route the evidence drill-in panel for `nodeId` is reached at (M9). Capture 0 is
// the bare `/node/<id>`; later captures ride a `?capture=<n>` query — plain GET, no
// stored state (I3). The single source for both the run-page open-evidence link and
// the panel's prev/next navigation, so the served URLs always agree, and it mirrors
// the dogfood `PANEL_FIXTURE.panelRouteFor` the seed's path resolves against.
export function panelHref(nodeId: string, capture: number): string {
  const base = `/node/${encodeURIComponent(nodeId)}`;
  return capture <= 0 ? base : `${base}?capture=${capture.toString()}`;
}

// One node's supervision card. `provider` is the critic provider lifted onto the
// view (null before a verdict); blocked nodes surface their human-facing reason so
// the operator sees what needs a decision without opening the file.
function nodeHtml(node: NodeView): string {
  const provider =
    node.provider === null ? '' : `<span class="provider">${esc(node.provider)}</span>`;
  const verdict = node.verdict === null ? '' : verdictHtml(node.verdict);
  const blocked =
    node.blocked === null
      ? ''
      : `<div class="blocked"><span class="blocked-reason">blocked: ${esc(node.blocked.reason)}</span> ` +
        `<span class="blocked-human">${esc(node.blocked.humanFacing)}</span></div>`;
  // A node carrying evidence gets a drill-in control (M9): it opens that node's
  // evidence panel (`/node/<id>`). The `data-testid` is the panel DOM contract the
  // dogfood's semantic-action path clicks (PANEL_FIXTURE.selectors.openEvidence). A
  // node with no evidence has nothing to drill into, so it gets no control.
  const openEvidence =
    node.evidenceRefs.length === 0
      ? ''
      : `<a class="open-evidence" data-testid="open-evidence-${esc(node.id)}" ` +
        `href="${esc(panelHref(node.id, 0))}">open evidence →</a>`;
  return (
    `<div class="node-head">` +
    `<span class="status status-${esc(node.status)}">${esc(node.status)}</span> ` +
    `<span class="kind">${esc(node.kind)}</span> ` +
    `<span class="node-id">${esc(node.id)}</span> ` +
    provider +
    `</div>` +
    `<div class="outcome">${esc(node.outcome)}</div>` +
    costHtml(node.cost) +
    verdict +
    blocked +
    evidenceHtml(node.evidenceRefs) +
    openEvidence
  );
}

// The tree as nested lists; nesting (not a depth attribute) carries the hierarchy
// so the operator reads structure directly. Children render in the parent's
// authoritative `children` order (the layer it decomposed), which `TreeNode`
// preserves.
function treeHtml(node: TreeNode): string {
  const children =
    node.children.length === 0
      ? ''
      : `<ul class="children">${node.children.map((c) => `<li>${treeHtml(c)}</li>`).join('')}</ul>`;
  return `<div class="node">${nodeHtml(node)}</div>${children}`;
}

const STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; margin-bottom: 0.2rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .meta code { font-size: 0.85rem; }
  ul.children { list-style: none; margin: 0 0 0 1.2rem; padding-left: 1rem; border-left: 1px solid #ddd; }
  .node { padding: 0.4rem 0; }
  .node-head { display: flex; gap: 0.5rem; align-items: baseline; }
  .node-id { font-weight: 600; }
  .kind { color: #888; font-size: 0.8rem; text-transform: uppercase; }
  .provider { color: #555; font-size: 0.8rem; background: #eef; padding: 0 0.3rem; border-radius: 3px; }
  .outcome { color: #333; margin: 0.1rem 0; }
  .status { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; padding: 0.05rem 0.4rem; border-radius: 3px; color: #fff; }
  .status-pending { background: #999; }
  .status-active { background: #2a7; }
  .status-done { background: #27a; }
  .status-blocked { background: #c33; }
  .status-cancelled { background: #765; }
  .verdict { font-size: 0.85rem; margin: 0.15rem 0; }
  .verdict-pass .verdict-mark { color: #270; }
  .verdict-fail .verdict-mark { color: #a00; }
  .verdict-mark { font-weight: 600; }
  .blocked { font-size: 0.85rem; color: #a00; margin: 0.15rem 0; }
  .run-cost { color: #444; font-size: 0.9rem; margin: -1rem 0 1.5rem; }
  .run-cost .cost-total { font-weight: 600; font-variant-numeric: tabular-nums; }
  .cost { font-size: 0.8rem; color: #555; margin: 0.15rem 0; }
  .cost-label { text-transform: uppercase; font-size: 0.7rem; color: #888; }
  .cost-total { font-variant-numeric: tabular-nums; }
  .cost-uncosted { color: #a60; font-weight: 600; }
  ul.evidence { margin: 0.15rem 0; padding-left: 1.2rem; font-size: 0.8rem; color: #555; }
  .evidence-kind { font-weight: 600; }
  .evidence-path { color: #888; }
  .open-evidence { display: inline-block; margin: 0.2rem 0; font-size: 0.8rem; color: #27a; text-decoration: none; }
  .open-evidence:hover { text-decoration: underline; }
  .panel { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin-top: 0.5rem; max-width: 32rem; }
  .panel-node { font-size: 0.85rem; color: #555; margin-bottom: 0.6rem; }
  .panel-pos { font-size: 0.7rem; text-transform: uppercase; color: #888; letter-spacing: 0.03em; }
  .panel-kind { font-size: 0.9rem; margin: 0.2rem 0; }
  .panel-summary { color: #1a1a1a; margin: 0.2rem 0 0.4rem; }
  .panel-empty { color: #a60; }
  .panel-nav { display: flex; gap: 1rem; margin-top: 0.8rem; font-size: 0.85rem; }
  .panel-nav a { color: #27a; text-decoration: none; }
  .panel-nav a:hover { text-decoration: underline; }
  .back { color: #27a; text-decoration: none; }
  .supervisor { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin-top: 1rem; max-width: 48rem; }
  .supervisor h2 { font-size: 1rem; margin: 0 0 0.6rem; }
  .supervisor h3 { font-size: 0.85rem; text-transform: uppercase; color: #888; margin: 0.8rem 0 0.3rem; }
  .supervisor h4 { font-size: 0.8rem; color: #888; margin: 0.4rem 0 0.2rem; }
  .detail-block { margin: 0.4rem 0; }
  .prose { white-space: pre-wrap; font-size: 0.85rem; color: #222; }
  .prose-more { font-size: 0.75rem; color: #a60; margin-top: 0.3rem; }
  .artifact { margin: 0.4rem 0; }
  .artifact-head { font-size: 0.8rem; margin-bottom: 0.15rem; }
  .artifact-missing { font-size: 0.85rem; color: #a60; font-style: italic; }
  .seam-kind { font-weight: 600; }
  .orphans { margin-top: 2rem; border-top: 2px solid #c33; padding-top: 0.5rem; }
  .orphans h2 { font-size: 1rem; color: #c33; }
  .error { color: #a00; }
  pre { background: #f6f6f6; padding: 1rem; border-radius: 4px; overflow-x: auto; }
`;

function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body>${body}</body></html>`
  );
}

// The whole-run F5 rollup line for the header: the run total, call count, and any
// uncosted-call gap. `calls === 0` is a run that spent no model call (distinct from
// an all-$0 run), so it reads "no model calls" rather than "$0".
function runCostHtml(cost: RunCost): string {
  if (cost.calls === 0) {
    return `<div class="run-cost">cost <span class="cost-total">no model calls</span></div>`;
  }
  const uncosted =
    cost.uncosted === 0
      ? ''
      : ` <span class="cost-uncosted">+${cost.uncosted.toString()} uncosted call${
          cost.uncosted === 1 ? '' : 's'
        }</span>`;
  return (
    `<div class="run-cost">cost <span class="cost-total">${fmtUsd(cost.total)}</span> ` +
    `over ${cost.calls.toString()} call${cost.calls === 1 ? '' : 's'}${uncosted}</div>`
  );
}

// The whole-run page: header (run id, root outcome, created-at, F5 cost rollup),
// the composed tree with per-node burn, and — surfaced not dropped (Rule 11) — any
// orphan node files unreachable from the root.
export function renderRunPage(projection: RunProjection): string {
  const orphans =
    projection.orphans.length === 0
      ? ''
      : `<section class="orphans"><h2>Orphans (${projection.orphans.length.toString()} unreachable node file${
          projection.orphans.length === 1 ? '' : 's'
        })</h2>${projection.orphans.map((o) => `<div class="node">${nodeHtml(o)}</div>`).join('')}</section>`;

  const body =
    `<h1>${esc(projection.rootOutcome)}</h1>` +
    `<div class="meta">run <code>${esc(projection.runId)}</code> · ` +
    `root <code>${esc(projection.rootId)}</code> · ` +
    `created ${esc(projection.createdAt)}</div>` +
    runCostHtml(projection.cost) +
    `<section class="tree">${treeHtml(projection.tree)}</section>` +
    orphans;

  return page(`relay · ${projection.runId}`, body);
}

// One evidence capture rendered inside the drill-in panel (M9): its semantic facts —
// kind, summary, path — which are exactly what the structural visual check grades
// against (the node id is on the panel container). Drawn from the projection's
// evidence refs, never from a re-read of the capture file (I3, single-sourced codec).
function panelCaptureHtml(ref: EvidenceRef, index: number, total: number): string {
  return (
    `<div class="panel-capture">` +
    `<div class="panel-pos">capture ${(index + 1).toString()} of ${total.toString()}</div>` +
    `<div class="panel-kind evidence-kind">${esc(ref.kind)}</div>` +
    `<div class="panel-summary">${esc(ref.summary)}</div>` +
    `<code class="evidence-path">${esc(ref.path)}</code>` +
    `</div>`
  );
}

// The evidence drill-in panel SECTION for one node (M9, design §12 / D3): one
// `<section data-testid="evidence-panel">` rendering ONE capture index with prev/next
// navigation. Kept as its own builder so the node page can compose it ahead of the
// human-supervisor detail (Phase 3) without disturbing this exact markup — the
// `data-testid`s are the panel DOM contract the dogfood's PANEL_FIXTURE selectors
// address, and the dogfood scopes its structural grade to this single section by
// matching its first `</section>`, so the supervisor detail MUST stay a sibling after
// it, never nested within (V7 isolation).
function nodePanelSection(node: NodeView, captureIndex: number): string {
  const refs = node.evidenceRefs;
  const total = refs.length;
  if (total === 0) {
    return (
      `<section class="panel" data-testid="evidence-panel">` +
      `<div class="panel-node">node <code>${esc(node.id)}</code></div>` +
      `<div class="panel-empty">no evidence captures for this node</div>` +
      `</section>`
    );
  }

  // Clamp `?capture=` to a real index so an out-of-range request lands on the last
  // capture rather than rendering a blank panel (fail visible, not silent — Rule 11).
  const idx = Math.max(0, Math.min(captureIndex, total - 1));
  const ref = refs[idx];
  const prev =
    idx > 0 ? `<a class="panel-prev" href="${esc(panelHref(node.id, idx - 1))}">← prev</a>` : '';
  // `evidence-next` is the in-panel control the semantic-action path clicks to advance
  // a capture; present only when there is a next capture to reach.
  const next =
    idx < total - 1
      ? `<a class="panel-next" data-testid="evidence-next" href="${esc(panelHref(node.id, idx + 1))}">next →</a>`
      : '';

  return (
    `<section class="panel" data-testid="evidence-panel">` +
    `<div class="panel-node">node <code>${esc(node.id)}</code></div>` +
    panelCaptureHtml(ref, idx, total) +
    `<div class="panel-nav">${prev}${next}</div>` +
    `</section>`
  );
}

// The per-node page (M9 evidence panel + Sol 1 human-supervisor detail). The evidence
// drill-in panel renders ONE capture index and links to the next (navigation is plain
// GET on `?capture=<n>`, I3); when a `supervisor` view is supplied (the server always
// supplies it), the human-supervisor detail — self-report, evidence-file content,
// critic verdict, and the decompose footprints/seams/rationale — renders as a SIBLING
// section after the panel. That ordering is load-bearing: the dogfood scopes its
// structural grade to the `evidence-panel` section alone, and the header + detail sit
// outside it so neither can decide the verdict (V7 isolation point). The detail bounds
// untrusted model prose at render (Phase 3); the full text stays on disk for audit.
export function renderNodePanel(
  projection: RunProjection,
  node: NodeView,
  captureIndex: number,
  supervisor?: SupervisorView,
): string {
  const header =
    `<h1>evidence · <code>${esc(node.id)}</code></h1>` +
    `<div class="meta">run <code>${esc(projection.runId)}</code> · ` +
    `<a class="back" href="/">← run</a></div>`;
  const detail = supervisor === undefined ? '' : renderSupervisorDetail(supervisor);
  return page(
    `relay · ${node.id} · evidence`,
    header + nodePanelSection(node, captureIndex) + detail,
  );
}

// The render-time cap on an untrusted-prose block (Sol 1, Phase 3). The full text is
// persisted on disk for audit fidelity; the view shows at most this many characters
// and points at the on-disk path. Bounds self-report and decompose-rationale prose —
// model-authored free text that can be arbitrarily long — so one node's page cannot be
// blown up by a runaway report.
const PROSE_CAP = 2000;

// The on-disk path of an evidence ref (Sol 1): `evidence/<runId>/<ref.path>`, the
// pointer the bounded view shows so an auditor can read the full artifact. The ref
// carries its own `runId`, so the path is self-contained.
function evidenceDiskPath(ref: EvidenceRef): string {
  return `evidence/${ref.runId}/${ref.path}`;
}

// Render an untrusted-prose block bounded at `PROSE_CAP` (Sol 1, Phase 3). Always
// escaped (the text is model-authored free text — an injection sink otherwise). When
// it exceeds the cap, only the head is shown, followed by a "full text at <path>"
// pointer to the on-disk artifact — fail-visible truncation, never a silent cut.
function boundedProse(text: string, diskPath: string): string {
  if (text.length <= PROSE_CAP) {
    return `<div class="prose">${esc(text)}</div>`;
  }
  return (
    `<div class="prose prose-truncated">${esc(text.slice(0, PROSE_CAP))}` +
    `<span class="prose-ellipsis">…</span>` +
    `<div class="prose-more">full text at <code>${esc(diskPath)}</code></div>` +
    `</div>`
  );
}

// One on-disk evidence artifact for the supervisor detail (Sol 1): its kind, its disk
// path, and either its bounded content or — when the ref is present but the file is
// absent (a blocked node has a diff/self-report but no verdict; an errored executor may
// leave a ref's file unwritten) — an inline "(artifact missing)" notice. The notice is
// the fail-VISIBLE degradation (Rule 11): the route renders the rest of the node rather
// than 500-ing on one half-written file.
function evidenceArtifactHtml(item: EvidenceContent): string {
  const diskPath = evidenceDiskPath(item.ref);
  const head =
    `<div class="artifact-head"><span class="evidence-kind">${esc(item.ref.kind)}</span> ` +
    `<code class="evidence-path">${esc(diskPath)}</code></div>`;
  const body = item.missing
    ? `<div class="artifact-missing">(artifact missing)</div>`
    : boundedProse(item.content ?? '', diskPath);
  return `<div class="artifact">${head}${body}</div>`;
}

// The decompose JUDGMENT — per-child write footprints and the seam graph between the
// children — lifted off the branch's layer manifest (Sol 1). This is orchestrator-
// visible reasoning the critic never receives; the human supervisor sees it here.
function layerHtml(layer: LayerManifest): string {
  const footprints = Object.entries(layer.footprints)
    .map(
      ([childId, fp]) =>
        `<li><code>${esc(childId)}</code> → <code>${esc(fp.writeGlobs.join(', '))}</code></li>`,
    )
    .join('');
  const seams =
    layer.seams.length === 0
      ? ''
      : `<div class="seams"><h4>seams</h4><ul>${layer.seams
          .map(
            (s) =>
              `<li><span class="seam-kind">${esc(s.kind)}</span> ` +
              `<code>${esc(s.producer)}</code> → <code>${esc(s.consumer)}</code>: ${esc(s.intent)}</li>`,
          )
          .join('')}</ul></div>`;
  return `<div class="footprints"><h4>footprints</h4><ul>${footprints}</ul></div>${seams}`;
}

// The human-supervisor detail for one node (Sol 1, plan 03 Phase 3). The OTHER side of
// the C7 split: it surfaces the orchestrator-visible narrative (self-report, learnings)
// and the decompose judgment (footprints/seams/rationale) the critic never sees, plus
// the on-disk evidence content the auditor reviews. Untrusted model prose is bounded at
// render (`boundedProse`); the full text stays on disk. It is a sibling `<section>`
// AFTER the evidence panel — outside the dogfood's `evidence-panel` grade scope (V7).
function renderSupervisorDetail(view: SupervisorView): string {
  const blocks: string[] = [];

  // Self-report narrative — surfaced to the HUMAN, never the critic (C7). Bounded; the
  // pointer is the self-report.md artifact when present, else the node file where the
  // record narrative is persisted.
  if (view.selfReport !== null) {
    const selfReportRef = view.evidence.find((e) => e.ref.kind === 'self-report')?.ref;
    const diskPath = selfReportRef ? evidenceDiskPath(selfReportRef) : `nodes/${view.id}.md`;
    blocks.push(
      `<div class="detail-block"><h3>self-report</h3>${boundedProse(view.selfReport, diskPath)}</div>`,
    );
  }

  if (view.learnings.length > 0) {
    const items = view.learnings.map((l) => `<li>${esc(l)}</li>`).join('');
    blocks.push(`<div class="detail-block"><h3>learnings</h3><ul>${items}</ul></div>`);
  }

  if (view.verdict !== null) {
    blocks.push(
      `<div class="detail-block"><h3>critic verdict</h3>${verdictHtml(view.verdict)}</div>`,
    );
  }

  if (view.blocked !== null) {
    blocks.push(
      `<div class="detail-block"><h3>blocked</h3>` +
        `<div class="blocked"><span class="blocked-reason">blocked: ${esc(view.blocked.reason)}</span> ` +
        `<span class="blocked-human">${esc(view.blocked.humanFacing)}</span></div></div>`,
    );
  }

  if (view.layer !== null) {
    blocks.push(`<div class="detail-block"><h3>decompose judgment</h3>${layerHtml(view.layer)}</div>`);
  }

  // The on-disk artifacts (diff, decompose rationale, verdict file, self-report file):
  // each bounded, or an inline "(artifact missing)" notice when its file is absent.
  if (view.evidence.length > 0) {
    const artifacts = view.evidence.map(evidenceArtifactHtml).join('');
    blocks.push(`<div class="detail-block"><h3>evidence artifacts</h3>${artifacts}</div>`);
  }

  return (
    `<section class="supervisor" data-testid="supervisor-detail">` +
    `<h2>supervisor detail</h2>` +
    blocks.join('') +
    `</section>`
  );
}

// The error page. `projectRun` fails loud on an incoherent tree (missing root,
// dangling child, cycle); the server renders this instead of a blank or partial
// page so the operator sees the fault directly (Phase 1 notes, Rule 11).
export function renderErrorPage(message: string): string {
  return page(
    'relay · error',
    `<h1 class="error">Cannot render this run</h1>` +
      `<p>The <code>.relay/</code> projection could not be composed:</p>` +
      `<pre class="error">${esc(message)}</pre>`,
  );
}
