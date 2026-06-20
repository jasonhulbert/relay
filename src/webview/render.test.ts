import { describe, expect, test } from 'vitest';
import type { RunProjection, TreeNode } from './projection';
import { renderErrorPage, renderRunPage } from './render';

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
