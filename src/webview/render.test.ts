import { describe, expect, test } from 'vitest';
import type { EvidenceRef } from '../relay-state/index';
import type { NodeView, RunProjection, TreeNode } from './projection';
import { panelHref, renderErrorPage, renderNodePanel, renderRunPage } from './render';

function leaf(over: Partial<TreeNode> & Pick<TreeNode, 'id'>): TreeNode {
  return {
    parentId: 'root',
    kind: 'leaf',
    status: 'done',
    outcome: `outcome for ${over.id}`,
    provider: null,
    verdict: null,
    evidenceRefs: [],
    blocked: null,
    depth: 1,
    cost: null,
    children: [],
    ...over,
  };
}

function projection(over: Partial<RunProjection>): RunProjection {
  const root: TreeNode = {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'active',
    outcome: 'ship it',
    provider: null,
    verdict: null,
    evidenceRefs: [],
    blocked: null,
    depth: 0,
    cost: null,
    children: [],
  };
  return {
    runId: 'run-1',
    rootId: 'root',
    rootOutcome: 'ship it',
    createdAt: '2026-06-18T00:00:00.000Z',
    tree: root,
    runLog: [root],
    orphans: [],
    cost: { calls: 0, total: 0, uncosted: 0, perNode: [] },
    ...over,
  };
}

describe('webview render', () => {
  // WHY: outcomes, rationales, and evidence summaries are untrusted free text
  // (operator-authored or model-authored). Rendering them into HTML unescaped would
  // be an injection sink. This pins that angle brackets are escaped, so a crafted
  // outcome cannot smuggle markup onto the supervision page.
  test('escapes untrusted free text', () => {
    const root = {
      ...projection({}).tree,
      outcome: '<script>alert(1)</script>',
    };
    const html = renderRunPage(projection({ tree: root, rootOutcome: '<img src=x onerror=1>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x onerror=1>');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
  });

  // WHY: orphan node files (unreachable from the root) are surfaced, not dropped
  // (Rule 11) — a mid-write or corrupt tree must stay visible to the operator.
  test('surfaces orphans in their own section', () => {
    const html = renderRunPage(projection({ orphans: [leaf({ id: 'stray', children: [] })] }));
    expect(html).toContain('Orphans');
    expect(html).toContain('stray');
  });

  // WHY: Phase 3 — budget burn is the operator's cost-per-outcome signal. The
  // per-node total must render on the card and the run total in the header, both at
  // the 6-dp precision the F5 rollup uses so the view reads identically to the
  // persisted `cost.md`.
  test('renders per-node burn and the per-run cost total', () => {
    const burnt = leaf({
      id: 'leaf-1',
      cost: { nodeId: 'leaf-1', total: 0.402, uncosted: 0, calls: [] },
    });
    const html = renderRunPage(
      projection({
        tree: { ...projection({}).tree, children: [burnt] },
        cost: {
          calls: 3,
          total: 0.412,
          uncosted: 0,
          perNode: [{ nodeId: 'leaf-1', total: 0.402, uncosted: 0, calls: [] }],
        },
      }),
    );
    expect(html).toContain('$0.402000');
    expect(html).toContain('$0.412000');
    expect(html).toContain('over 3 calls');
  });

  // WHY: an unpriced call (no price-table row) must surface as a GAP, not be folded
  // into the total as $0 — a silently-dropped cost reads as "cheaper than it was"
  // (Rule 11). This pins that the uncosted count shows on both the node and the run.
  test('surfaces an uncosted-call gap rather than hiding it', () => {
    const html = renderRunPage(
      projection({
        cost: {
          calls: 2,
          total: 0.005,
          uncosted: 1,
          perNode: [{ nodeId: 'root', total: 0.005, uncosted: 1, calls: [] }],
        },
        tree: {
          ...projection({}).tree,
          cost: { nodeId: 'root', total: 0.005, uncosted: 1, calls: [] },
        },
      }),
    );
    expect(html).toContain('uncosted');
    expect(html).toContain('+1 uncosted call');
  });

  // WHY: a run that spent no model call is distinct from an all-$0 run — it must
  // read "no model calls", never "$0.000000", so the header is honest about whether
  // any spend happened at all.
  test('a run with no model calls reads as such, not $0', () => {
    const html = renderRunPage(projection({}));
    expect(html).toContain('no model calls');
    expect(html).not.toContain('$0.000000');
  });

  test('error page carries the failure message', () => {
    const html = renderErrorPage('cycle detected at node `a`');
    expect(html).toContain('Cannot render this run');
    expect(html).toContain('cycle detected at node `a`');
  });
});

// The M9 evidence drill-in panel render. These pin the panel DOM contract the dogfood
// drives (the `data-testid`s and `/node/<id>` route shape), capture navigation, and
// the V7 isolation the structural visual check relies on.
describe('webview evidence drill-in panel (M9)', () => {
  const ref = (kind: EvidenceRef['kind'], summary: string, path: string): EvidenceRef => ({
    runId: 'run-1',
    path,
    kind,
    summary,
  });

  // Extract the `evidence-panel` section the way a scoped snapshot/screenshot does
  // (V7): only this subtree is graded, so a test asserting scoping reads exactly it.
  function panelScope(html: string): string {
    const at = html.indexOf('data-testid="evidence-panel"');
    expect(at).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<', at);
    const end = html.indexOf('</section>', at) + '</section>'.length;
    return html.slice(start, end);
  }

  const withEvidence = (over: Partial<NodeView> = {}): NodeView =>
    leaf({
      id: 'sample-leaf',
      status: 'done',
      evidenceRefs: [
        ref('diff', 'unified diff sample-leaf produced', 'sample-leaf/diff.md'),
        ref('self-report', 'sample-leaf executor self-report', 'sample-leaf/self-report.md'),
        ref('verdict', 'critic verdict accepting sample-leaf', 'sample-leaf/verdict.md'),
      ],
      ...over,
    });

  // WHY (panelHref is the single source for the open-evidence link AND the panel's own
  // prev/next): if the two ever disagreed, a click would 404 or skip a capture. Capture
  // 0 is the bare route; later captures ride `?capture=`.
  test('panelHref pins the route shape capture 0 and capture n', () => {
    expect(panelHref('sample-leaf', 0)).toBe('/node/sample-leaf');
    expect(panelHref('sample-leaf', 2)).toBe('/node/sample-leaf?capture=2');
  });

  // WHY (Validation: the panel renders a node's evidence): the open-evidence control is
  // the run-page entry point the semantic-action path clicks. It must carry the exact
  // `data-testid` the dogfood addresses and link to the node's panel route.
  test('the run page gives a node with evidence an open-evidence control', () => {
    const node = withEvidence();
    const html = renderRunPage(projection({ tree: { ...node, children: [] } }));
    expect(html).toContain('data-testid="open-evidence-sample-leaf"');
    expect(html).toContain('href="/node/sample-leaf"');
  });

  // WHY: a node with no evidence has nothing to drill into, so it must NOT get a
  // control — a dead link would be worse than no link.
  test('a node with no evidence gets no open-evidence control', () => {
    const html = renderRunPage(projection({}));
    expect(html).not.toContain('open-evidence-');
  });

  // WHY (Validation: navigating advances through the ordered captures): the panel
  // renders ONE capture at the requested index and exposes the `evidence-next` control
  // pointing at the following capture — the exact step the dogfood's path replays.
  test('renders the requested capture and links to the next', () => {
    const node = withEvidence();
    const html = renderNodePanel(projection({}), node, 1);
    const scope = panelScope(html);
    // The second capture's semantic facts — the structural expectation — are present.
    expect(scope).toContain('sample-leaf');
    expect(scope).toContain('self-report');
    expect(scope).toContain('sample-leaf executor self-report');
    expect(scope).toContain('capture 2 of 3');
    // The next control advances to capture 2.
    expect(scope).toContain('data-testid="evidence-next"');
    expect(scope).toContain('href="/node/sample-leaf?capture=2"');
  });

  // WHY (V7 isolation, the whole reason the check is element-scoped): the capture facts
  // must live INSIDE the scoped panel, not in the surrounding header. If a graded fact
  // leaked into an unscoped region, a check scoped to the panel could pass on the wrong
  // evidence — the false-verdict failure mode V7 closes.
  test('the graded capture facts are inside the scoped panel, not the header', () => {
    const node = withEvidence();
    const html = renderNodePanel(projection({}), node, 1);
    const scope = panelScope(html);
    const outsidePanel = html.replace(scope, '');
    expect(outsidePanel).not.toContain('sample-leaf executor self-report');
  });

  // WHY: the last capture has nothing after it, so the next control must be absent —
  // otherwise the path could click past the end into a clamped no-op.
  test('the last capture exposes no next control', () => {
    const node = withEvidence();
    const html = renderNodePanel(projection({}), node, 2);
    expect(panelScope(html)).not.toContain('data-testid="evidence-next"');
  });

  // WHY (Rule 11, fail visible): an out-of-range `?capture=` must clamp to a real
  // capture rather than render a blank panel — the operator sees the last one, not
  // nothing.
  test('an out-of-range capture clamps to the last real one', () => {
    const node = withEvidence();
    const html = renderNodePanel(projection({}), node, 99);
    const scope = panelScope(html);
    expect(scope).toContain('capture 3 of 3');
    expect(scope).not.toContain('data-testid="evidence-next"');
  });

  // WHY: a node with no captures must render the panel shell with an explicit "no
  // evidence" message, not crash or 500 — the route exists for the node even if empty.
  test('a node with no evidence renders an explicit empty panel', () => {
    const node = leaf({ id: 'bare', evidenceRefs: [] });
    const html = renderNodePanel(projection({}), node, 0);
    const scope = panelScope(html);
    expect(scope).toContain('no evidence captures');
    expect(scope).not.toContain('data-testid="evidence-next"');
  });
});
