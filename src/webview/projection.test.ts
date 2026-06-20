import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { writeManifest, writeNode, writeUsage } from '../relay-state/index';
import type { CallUsage, NodeRecord, OutcomeSpec, RootManifest } from '../relay-state/index';
import { renderCostRollup } from '../spine/cost';
import { projectRun } from './projection';

function spec(outcome: string): OutcomeSpec {
  return {
    outcome,
    verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
  };
}

function node(over: Partial<NodeRecord> & Pick<NodeRecord, 'id'>): NodeRecord {
  return {
    parentId: null,
    kind: 'leaf',
    status: 'pending',
    spec: spec(`outcome for ${over.id}`),
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
    ...over,
  };
}

// A small but representative fixture: a root branch that decomposed into a
// sub-orchestrator branch (`mid`, owning one done leaf) and a directly-owned
// blocked leaf. It exercises every field the view composes — kinds, statuses, a
// critic verdict (and the provider lifted off it), evidence refs, and a blocked
// record — across two levels.
async function seedFixture(relayDir: string): Promise<void> {
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec: spec('ship the widget end-to-end'),
    createdAt: '2026-06-18T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);

  await writeNode(
    relayDir,
    node({
      id: 'root',
      parentId: null,
      kind: 'branch',
      status: 'active',
      spec: spec('integrate the decomposed layer'),
      children: ['mid', 'leaf-2'],
    }),
  );
  await writeNode(
    relayDir,
    node({
      id: 'mid',
      parentId: 'root',
      kind: 'branch',
      status: 'active',
      spec: spec('produce the sub-outcome'),
      children: ['leaf-1'],
    }),
  );
  await writeNode(
    relayDir,
    node({
      id: 'leaf-1',
      parentId: 'mid',
      kind: 'leaf',
      status: 'done',
      spec: spec('produce the change'),
      selfReport: 'I did the thing', // narrative — must NOT surface in the view
      verdict: {
        pass: true,
        provider: 'codex',
        rationale: 'the change satisfies the spec',
        evidenceRefs: [],
      },
      evidenceRefs: [
        { runId: 'run-1', path: 'leaf-1/diff.md', kind: 'diff', summary: 'the produced change' },
      ],
    }),
  );
  await writeNode(
    relayDir,
    node({
      id: 'leaf-2',
      parentId: 'root',
      kind: 'leaf',
      status: 'blocked',
      spec: spec('the unreachable change'),
      blocked: {
        reason: 'ladder exhausted',
        rungsSpent: ['retry x2', 'provider swap'],
        criticReason: 'spec never satisfied',
        humanFacing: 'needs a human decision',
      },
    }),
  );
}

describe('webview read-time projection', () => {
  // WHY: the view is a read-time projection composed from per-node files, never a
  // stored artifact (design §4, A6). This pins the exact composition — tree shape,
  // depths, pre-order run log, lifted provider, and that the orchestrator-visible
  // narrative does NOT ride into the supervision view — so a regression that
  // reshapes, reorders, or leaks fields fails here rather than silently.
  test('composes the whole tree, statuses, and run log to match the fixture', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);

      const projection = await projectRun(relayDir);

      const leaf1View = {
        id: 'leaf-1',
        parentId: 'mid',
        kind: 'leaf' as const,
        status: 'done' as const,
        outcome: 'produce the change',
        provider: 'codex',
        verdict: {
          pass: true,
          provider: 'codex',
          rationale: 'the change satisfies the spec',
          evidenceRefs: [],
        },
        evidenceRefs: [
          { runId: 'run-1', path: 'leaf-1/diff.md', kind: 'diff', summary: 'the produced change' },
        ],
        blocked: null,
        depth: 2,
        cost: null,
      };
      const leaf2View = {
        id: 'leaf-2',
        parentId: 'root',
        kind: 'leaf' as const,
        status: 'blocked' as const,
        outcome: 'the unreachable change',
        provider: null,
        verdict: null,
        evidenceRefs: [],
        blocked: {
          reason: 'ladder exhausted',
          rungsSpent: ['retry x2', 'provider swap'],
          criticReason: 'spec never satisfied',
          humanFacing: 'needs a human decision',
        },
        depth: 1,
        cost: null,
      };
      const midView = {
        id: 'mid',
        parentId: 'root',
        kind: 'branch' as const,
        status: 'active' as const,
        outcome: 'produce the sub-outcome',
        provider: null,
        verdict: null,
        evidenceRefs: [],
        blocked: null,
        depth: 1,
        cost: null,
      };
      const rootView = {
        id: 'root',
        parentId: null,
        kind: 'branch' as const,
        status: 'active' as const,
        outcome: 'integrate the decomposed layer',
        provider: null,
        verdict: null,
        evidenceRefs: [],
        blocked: null,
        depth: 0,
        cost: null,
      };

      expect(projection).toEqual({
        runId: 'run-1',
        rootId: 'root',
        rootOutcome: 'ship the widget end-to-end',
        createdAt: '2026-06-18T00:00:00.000Z',
        tree: {
          ...rootView,
          children: [
            { ...midView, children: [{ ...leaf1View, children: [] }] },
            { ...leaf2View, children: [] },
          ],
        },
        // Pre-order: root, then mid's subtree, then leaf-2.
        runLog: [rootView, midView, leaf1View, leaf2View],
        orphans: [],
        // The fixture seeds no usage records, so the rollup is the empty-run shape.
        cost: { calls: 0, total: 0, uncosted: 0, perNode: [] },
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: I3 — the view writes nothing to `.relay/`. Composing the projection must
  // not open any file for writing. An open-for-write truncates and rewrites (via
  // the atomic-write rename), which changes the file's identity/mtime; snapshotting
  // every file's content and mtime before and after and asserting exact equality
  // proves the projection touched nothing on disk.
  test('opens no `.relay/` file for writing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);

      const before = await snapshotTree(relayDir);
      await projectRun(relayDir);
      const after = await snapshotTree(relayDir);

      expect(after).toEqual(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('fails loud on a cycle rather than recursing forever', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await writeManifest(relayDir, {
        runId: 'run-1',
        rootId: 'a',
        spec: spec('root'),
        createdAt: '2026-06-18T00:00:00.000Z',
      });
      await writeNode(relayDir, node({ id: 'a', kind: 'branch', children: ['b'] }));
      await writeNode(relayDir, node({ id: 'b', kind: 'branch', children: ['a'] }));

      await expect(projectRun(relayDir)).rejects.toThrow(/cycle/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('fails loud when a referenced child has no file', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await writeManifest(relayDir, {
        runId: 'run-1',
        rootId: 'root',
        spec: spec('root'),
        createdAt: '2026-06-18T00:00:00.000Z',
      });
      await writeNode(relayDir, node({ id: 'root', kind: 'branch', children: ['ghost'] }));

      await expect(projectRun(relayDir)).rejects.toThrow(/ghost/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // A node file present on disk but unreachable from the root is surfaced as an
  // orphan, not dropped (Rule 11): a mid-write or corrupt tree stays visible.
  test('surfaces an unreachable node as an orphan', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await writeManifest(relayDir, {
        runId: 'run-1',
        rootId: 'root',
        spec: spec('root'),
        createdAt: '2026-06-18T00:00:00.000Z',
      });
      await writeNode(relayDir, node({ id: 'root', kind: 'branch', children: [] }));
      await writeNode(relayDir, node({ id: 'stray', status: 'pending' }));

      const projection = await projectRun(relayDir);
      expect(projection.orphans.map((o) => o.id)).toEqual(['stray']);
      expect(projection.runLog.map((n) => n.id)).toEqual(['root']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: Phase 3 — the F5 cost rollup is the operator's cost-per-outcome view, and
  // it must be composed at read time from the per-call usage records (not a stored
  // artifact) and must MATCH the `.relay/` rollup M4 writes. This seeds usage
  // records, then asserts (a) each node carries its attributed burn, with an
  // unpriced call surfaced as a gap not folded into the total, (b) the run total
  // sums the priced calls, and (c) the numbers equal what `renderCostRollup` (the
  // persisted Markdown rollup) reports — both compose from the same projection, so a
  // drift between the view and the rollup fails here.
  test('surfaces per-node and per-run cost matching the rollup', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);

      const call = (
        over: Partial<CallUsage> & Pick<CallUsage, 'nodeId' | 'role' | 'seq'>,
      ): CallUsage => ({
        runId: 'run-1',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        wallClockMs: 10,
        costUsd: 0.002,
        costSource: 'price-table',
        ...over,
      });
      const records: CallUsage[] = [
        call({ nodeId: 'leaf-1', role: 'executor', seq: 1, costUsd: 0.002 }),
        call({
          nodeId: 'leaf-1',
          role: 'critic',
          seq: 1,
          provider: 'claude',
          costUsd: 0.4,
          costSource: 'direct',
        }),
        call({ nodeId: 'root', role: 'brain', seq: 0, costUsd: 0.01 }),
        // An unpriced call on root — a gap, not $0.
        call({ nodeId: 'root', role: 'executor', seq: 1, costUsd: null, costSource: 'unpriced' }),
      ];
      for (const r of records) await writeUsage(relayDir, r);

      const projection = await projectRun(relayDir);

      // Run total sums only the priced calls; the unpriced call is a surfaced gap.
      expect(projection.cost.calls).toBe(4);
      expect(projection.cost.total).toBeCloseTo(0.412, 10);
      expect(projection.cost.uncosted).toBe(1);

      // Per-node burn is attributed to the right outcome and reachable off the tree.
      const byId = new Map(projection.runLog.map((n) => [n.id, n]));
      expect(byId.get('leaf-1')?.cost?.total).toBeCloseTo(0.402, 10);
      expect(byId.get('leaf-1')?.cost?.uncosted).toBe(0);
      expect(byId.get('root')?.cost?.total).toBeCloseTo(0.01, 10);
      expect(byId.get('root')?.cost?.uncosted).toBe(1);
      // A node with no attributed call has no cost (a purely structural branch).
      expect(byId.get('mid')?.cost).toBeNull();
      expect(byId.get('leaf-2')?.cost).toBeNull();

      // The view's numbers match the persisted Markdown rollup, byte-for-byte on the
      // formatted figures — both are projections of the same records.
      const rollup = renderCostRollup('run-1', records);
      expect(rollup).toContain('Run total: $0.412000');
      expect(rollup).toContain('`leaf-1`: $0.402000');
      expect(rollup).toContain('`root`: $0.010000');
      expect(`$${projection.cost.total.toFixed(6)}`).toBe('$0.412000');
      expect(`$${(byId.get('leaf-1')?.cost?.total ?? 0).toFixed(6)}`).toBe('$0.402000');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Recursively snapshot every file under `dir` as relpath -> "mtimeMs:content".
// Used to assert the projection wrote nothing.
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = join(current, e.name);
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else {
        const [content, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
        out[rel] = `${st.mtimeMs.toString()}:${content}`;
      }
    }
  }
  await walk(dir, '');
  return out;
}
