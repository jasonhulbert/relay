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

  test('error page carries the failure message', () => {
    const html = renderErrorPage('cycle detected at node `a`');
    expect(html).toContain('Cannot render this run');
    expect(html).toContain('cycle detected at node `a`');
  });
});
