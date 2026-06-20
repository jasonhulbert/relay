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
import type { CriticVerdict, EvidenceRef, NodeCost, RunCost } from '../relay-state/index';
import type { NodeView, RunProjection, TreeNode } from './projection';

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

// The evidence drill-in panel for one node (M9, design §12 / D3): opening a node
// renders its evidence and navigating advances through that node's ordered captures.
// This is the bounded new feature on the M5 read-only view the second dogfood drives
// through the full visual path — the host surface the visual outcome's semantic-action
// path drives (V1) and its structural check grades, scoped to the `evidence-panel`
// element (V7). Strictly a view (I3): it renders ONE capture index and links to the
// next, navigation is plain GET on `?capture=<n>` (panelHref), and it writes nothing.
// The `data-testid`s are the panel DOM contract the dogfood's PANEL_FIXTURE selectors
// address, so the seed's path/scope/expectSubtree resolve against exactly this markup.
// The header sits OUTSIDE the scoped panel so a check scoped to `evidence-panel`
// ignores it — orientation only, never the capture facts (the V7 isolation point).
export function renderNodePanel(
  projection: RunProjection,
  node: NodeView,
  captureIndex: number,
): string {
  const refs = node.evidenceRefs;
  const total = refs.length;
  const header =
    `<h1>evidence · <code>${esc(node.id)}</code></h1>` +
    `<div class="meta">run <code>${esc(projection.runId)}</code> · ` +
    `<a class="back" href="/">← run</a></div>`;

  if (total === 0) {
    const empty =
      header +
      `<section class="panel" data-testid="evidence-panel">` +
      `<div class="panel-node">node <code>${esc(node.id)}</code></div>` +
      `<div class="panel-empty">no evidence captures for this node</div>` +
      `</section>`;
    return page(`relay · ${node.id} · evidence`, empty);
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

  const body =
    header +
    `<section class="panel" data-testid="evidence-panel">` +
    `<div class="panel-node">node <code>${esc(node.id)}</code></div>` +
    panelCaptureHtml(ref, idx, total) +
    `<div class="panel-nav">${prev}${next}</div>` +
    `</section>`;
  return page(`relay · ${node.id} · evidence`, body);
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
