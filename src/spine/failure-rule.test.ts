import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  atomicWriteFile,
  readNode,
  writeDecision,
  writeLayer,
  writeManifest,
  writeNode,
} from '../relay-state/index';
import type { Footprint, LayerManifest, RootManifest, SeamContract } from '../relay-state/index';
import { partitionBySeam } from './failure-rule';
import { runOrchestrator } from './orchestrator';
import { STUB_USAGE, stubCapabilities } from './executor';
import type { Executor } from './executor';
import type { Brain } from './brain';

// ── The pure partition: the cancel-vs-drain line IS the seam graph (B4) ──────────
// WHY: the entire failure rule rests on this being a STRUCTURAL decision, not a
// judgment. A node reachable from the dead one through the seam graph is invalidated
// (cancel); one with no seam path is still valid (drain). If the partition leaked
// the line — cancelling an unreachable node, or draining a reachable one — the rule
// would either discard valid banked work or integrate stale work. These pin the line.
describe('partitionBySeam splits the layer by seam-reachability from the dead node', () => {
  const seam = (id: string, producer: string, consumer: string): SeamContract => ({
    id,
    kind: 'file-boundary',
    producer,
    consumer,
    payload: { producerGlobs: [`${producer}/**`], consumerGlobs: [`${consumer}/**`] },
    intent: `${producer} serves ${consumer}`,
  });

  test('a directly seam-connected sibling cancels; an unconnected one drains', () => {
    const { cancel, drain } = partitionBySeam(['d'], ['s1', 's2'], [seam('e', 'd', 's1')]);
    expect(cancel).toEqual(['s1']); // seam d→s1 ⇒ dependent
    expect(drain).toEqual(['s2']); // no seam to d ⇒ independent
  });

  test('reachability is transitive and undirected', () => {
    // d ← s1 (s1 is the producer here) and s1 → s2: s2 is two hops from d, still
    // invalidated; direction does not gate staleness (a break on either end voids the seam).
    const { cancel, drain } = partitionBySeam(
      ['d'],
      ['s1', 's2', 's3'],
      [seam('e1', 's1', 'd'), seam('e2', 's1', 's2')],
    );
    expect(cancel.sort()).toEqual(['s1', 's2']);
    expect(drain).toEqual(['s3']);
  });

  test('no seams ⇒ every sibling is independent (all drain)', () => {
    const { cancel, drain } = partitionBySeam(['d'], ['s1', 's2'], []);
    expect(cancel).toEqual([]);
    expect(drain).toEqual(['s1', 's2']);
  });

  test('output order follows the caller child order (deterministic transitions)', () => {
    const { cancel } = partitionBySeam(
      ['d'],
      ['s2', 's1'],
      [seam('e1', 'd', 's1'), seam('e2', 'd', 's2')],
    );
    expect(cancel).toEqual(['s2', 's1']);
  });
});

// ── End-to-end: the unified failure rule in the orchestrator (B3) ────────────────

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-failrule-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const SPEC = {
  outcome: 'compose the layer',
  verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
};

async function seedChildlessBranch(relayDir: string): Promise<void> {
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec: SPEC,
    sketch: { notes: [] },
    createdAt: '2026-06-20T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);
  await writeNode(relayDir, {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: SPEC,
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  });
}

// A brain that decomposes into three disjoint-footprint leaves D / S1 / S2 with a
// single file-boundary seam D→S1. The seam is code-checkable, so it does NOT force
// serialization (F3) — all three run in one parallel stage — yet it is the structural
// edge the failure rule traces: S1 is seam-dependent on D, S2 is independent.
function threeLeavesOneSeam(): Brain {
  const child = (outcome: string, glob: string) => ({
    spec: { outcome, verifications: SPEC.verifications },
    kind: 'leaf' as const,
    footprint: { writeGlobs: [glob] } satisfies Footprint,
  });
  return {
    decompose: () =>
      Promise.resolve({
        decomposition: {
          children: [child('part D', 'd/**'), child('part S1', 's1/**'), child('part S2', 's2/**')],
          seams: [
            {
              id: 'seam-0',
              kind: 'file-boundary' as const,
              producer: 0, // D
              consumer: 1, // S1
              payload: { producerGlobs: ['d/**'], consumerGlobs: ['s1/**'] },
              intent: 'D publishes a file S1 consumes',
            },
          ],
        },
        rationale: 'three leaves D/S1/S2 with one file-boundary seam D→S1',
      }),
  };
}

// An executor scripted per child: the leaf whose outcome contains `failOutcome`
// reports a write OUTSIDE its declared footprint (a loud A3 violation → blocked under
// a tight cap); the others report an in-footprint write and reach done.
function loudViolationFor(failOutcome: string): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run({ worktree, spec }) {
      await mkdir(worktree, { recursive: true });
      await atomicWriteFile(join(worktree, 'CHANGE.txt'), 'change\n');
      const escapes = spec.outcome.includes(failOutcome);
      const rel = spec.outcome.includes('S1')
        ? 's1/x.ts'
        : spec.outcome.includes('S2')
          ? 's2/x.ts'
          : 'd/x.ts';
      return {
        diff: `A ${rel}\n+change`,
        selfReport: escapes ? 'loud violation' : `wrote ${rel}`,
        usage: STUB_USAGE,
        exitStatus: 0,
        writes: escapes ? ['outside/x.ts'] : [rel],
      };
    },
  };
}

// An executor that fails the test if it is ever run — proves the unified rule
// preempted (dispatched nothing new) rather than driving a doomed run's siblings.
const refusingExecutor: Executor = {
  capabilities: () => stubCapabilities,
  run() {
    throw new Error('a doomed run must dispatch nothing new');
  },
};

describe('the unified failure rule cancels seam-dependents and drains seam-independents (B3/B4)', () => {
  // WHY (validation 1): the phase's reason to exist. When a node in a concurrent
  // layer dies, the cancel-vs-preserve line must be the SEAM GRAPH, not a blanket
  // "cancel the layer" or "keep everything." The seam-dependent sibling's work is
  // stale (it was building toward a seam the dead node will never fulfil) and must be
  // cancelled with its worktree discarded; the seam-independent sibling drained to
  // completion and its work is valid across the human's fix, so it is quarantined —
  // banked, un-integrated, worktree retained. A rule that cancelled the independent,
  // or quarantined the dependent, would either burn reusable credit or bank stale work.
  test('a terminal failure cancels the seam-dependent sibling and quarantines the independent one', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: threeLeavesOneSeam(),
        executor: loudViolationFor('part D'),
        workRoot,
        caps: {
          maxAttempts: 1,
          maxTokens: Number.MAX_SAFE_INTEGER,
          maxWallClockMs: Number.MAX_SAFE_INTEGER,
        },
      });

      // D failed (loud violation under a tight cap); the cancel/drain split follows
      // the seam graph: S1 (seam to D) cancelled, S2 (no seam) quarantined.
      expect(res.leafStatuses['root.c0']).toBe('blocked');
      expect(res.leafStatuses['root.c1']).toBe('cancelled');
      expect(res.leafStatuses['root.c2']).toBe('quarantine');
      expect(res.cancelledNodes).toContain('root.c1');
      expect(res.quarantinedNodes).toEqual(['root.c2']);

      // The cancelled dependent keeps its lesson (names the rule + the dead node) and
      // its worktree is discarded; the quarantined independent keeps its lesson and
      // RETAINS its worktree as banked, reusable progress.
      const s1 = await readNode(relayDir, 'root.c1');
      expect(s1.status).toBe('cancelled');
      expect(s1.learnings[s1.learnings.length - 1]).toContain('seam-dependent');
      expect(s1.learnings[s1.learnings.length - 1]).toContain('root.c0');
      expect(await exists(join(workRoot, 'root.c1'))).toBe(false);

      const s2 = await readNode(relayDir, 'root.c2');
      expect(s2.status).toBe('quarantine');
      expect(s2.learnings[s2.learnings.length - 1]).toContain('quarantine');
      expect(s2.learnings[s2.learnings.length - 1]).toContain('root.c0');
      expect(await exists(join(workRoot, 'root.c2'))).toBe(true);

      // Root halts and surfaces the ROOT CAUSE — the blocked node, not a downstream
      // cancellation — with no route-around to done.
      expect(res.rootStatus).toBe('blocked');
      const root = await readNode(relayDir, 'root');
      expect(root.status).toBe('blocked');
      expect(root.blocked?.reason).toContain('root.c0');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// A pre-decomposed branch with three leaf children D / S1 / S2 and a layer manifest
// carrying the file-boundary seam D→S1, so an inbox decision can target an existing
// child and the rule has a seam graph to trace before any dispatch.
async function seedDecomposedBranch(relayDir: string): Promise<void> {
  const rootManifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec: SPEC,
    sketch: { notes: [] },
    createdAt: '2026-06-20T00:00:00.000Z',
  };
  await writeManifest(relayDir, rootManifest);
  const childIds = ['root.c0', 'root.c1', 'root.c2'];
  await writeNode(relayDir, {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: SPEC,
    children: childIds,
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  });
  for (const [i, id] of childIds.entries()) {
    await writeNode(relayDir, {
      id,
      parentId: 'root',
      kind: 'leaf',
      status: 'pending',
      spec: { outcome: `part ${i.toString()}`, verifications: SPEC.verifications },
      children: [],
      selfReport: null,
      learnings: [],
      verdict: null,
      evidenceRefs: [],
      blocked: null,
    });
  }
  const layer: LayerManifest = {
    parentId: 'root',
    runId: 'run-1',
    footprints: {
      'root.c0': { writeGlobs: ['d/**'] },
      'root.c1': { writeGlobs: ['s1/**'] },
      'root.c2': { writeGlobs: ['s2/**'] },
    },
    seams: [
      {
        id: 'seam-0',
        kind: 'file-boundary',
        producer: 'root.c0',
        consumer: 'root.c1',
        payload: { producerGlobs: ['d/**'], consumerGlobs: ['s1/**'] },
        intent: 'D publishes a file S1 consumes',
      },
    ],
  };
  await writeLayer(relayDir, layer);
}

describe('a decision-inbox cancellation preempts and runs the unified rule (I4/§3.9)', () => {
  // WHY (validation 2): human cancellation rides the SAME rule and preempts — it does
  // not wait for work to run. Cancelling D at activation must (a) dispatch nothing new
  // anywhere (the refusing executor never runs), (b) cancel D's seam-dependent sibling
  // S1 by the same seam-graph traversal, and (c) leave the independent S2 untouched
  // (no in-flight work to drain). A wiring that dispatched the siblings, or failed to
  // cascade the cancellation along the seam, would burn metered credit on a doomed run.
  test('cancelling a node preempts dispatch and cancels its seam-dependent sibling', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedDecomposedBranch(relayDir);
      await writeDecision(relayDir, {
        decisionId: 'dec-1',
        kind: 'cancel',
        targetNodeId: 'root.c0',
        note: 'operator changed direction',
      });

      const res = await runOrchestrator(relayDir, 'root', {
        executor: refusingExecutor, // proves nothing new is dispatched
        workRoot,
      });

      // The cancelled node and its seam-dependent sibling are both terminal-cancelled;
      // the independent sibling is preempted (never started), left pending.
      expect(res.leafStatuses['root.c0']).toBe('cancelled');
      expect(res.leafStatuses['root.c1']).toBe('cancelled');
      expect(res.leafStatuses['root.c2']).toBe('pending');
      expect(res.cancelledNodes).toContain('root.c0');
      expect(res.cancelledNodes).toContain('root.c1');
      expect(res.quarantinedNodes).toEqual([]);

      // The cascade-cancelled sibling carries the seam-dependent lesson naming the dead node.
      const s1 = await readNode(relayDir, 'root.c1');
      expect(s1.status).toBe('cancelled');
      expect(s1.learnings[s1.learnings.length - 1]).toContain('seam-dependent');
      expect(s1.learnings[s1.learnings.length - 1]).toContain('root.c0');

      // The independent sibling is untouched — preempted, not cancelled or quarantined.
      const s2 = await readNode(relayDir, 'root.c2');
      expect(s2.status).toBe('pending');
      expect(s2.learnings).toEqual([]);

      // Root halts and surfaces the cancellation with no route-around.
      expect(res.rootStatus).toBe('blocked');
      const root = await readNode(relayDir, 'root');
      expect(root.blocked?.reason).toContain('root.c0');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
