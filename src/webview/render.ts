// The minimal HTML render of a `RunProjection` for the operator web view (M5
// Phase 2). Pure string composition — no I/O, no server — so the render is
// unit-testable on its own and the server (server.ts) only has to wire a request
// to `projectRun` + this. It is strictly a view: it shows the structural,
// supervision-facing fields the projection already lifted (status, provider,
// critic verdict, evidence refs, blocked record) and CANNOT show the
// orchestrator-visible narrative — `NodeView` does not carry it (C7, design §3.6).
//
// Scope (Phase 2): tree + per-node status/provider/verdict/evidence. Budget burn
// and the F5 cost rollups are Phase 3 — they are not in the projection yet (see
// the Phase 1 notes), so they are deliberately absent here. The evidence drill-in
// panel is M9, not this; evidence refs render as their summary + path only.
import type { CriticVerdict, EvidenceRef } from '../relay-state/index';
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
  return (
    `<div class="node-head">` +
    `<span class="status status-${esc(node.status)}">${esc(node.status)}</span> ` +
    `<span class="kind">${esc(node.kind)}</span> ` +
    `<span class="node-id">${esc(node.id)}</span> ` +
    provider +
    `</div>` +
    `<div class="outcome">${esc(node.outcome)}</div>` +
    verdict +
    blocked +
    evidenceHtml(node.evidenceRefs)
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
  ul.evidence { margin: 0.15rem 0; padding-left: 1.2rem; font-size: 0.8rem; color: #555; }
  .evidence-kind { font-weight: 600; }
  .evidence-path { color: #888; }
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

// The whole-run page: header (run id, root outcome, created-at), the composed
// tree, and — surfaced not dropped (Rule 11) — any orphan node files unreachable
// from the root.
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
    `<section class="tree">${treeHtml(projection.tree)}</section>` +
    orphans;

  return page(`relay · ${projection.runId}`, body);
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
