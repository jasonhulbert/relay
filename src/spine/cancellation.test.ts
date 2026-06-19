import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readNode, writeDecision } from '../relay-state/index';
import type { Executor, ExecutorResult } from './index';
import { runOrchestrator, seedFixture, stubCapabilities } from './index';

const ROOT_ID = 'root';
const LEAF_ID = 'leaf-1';

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-cancel-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

// An executor that fails the test if it ever runs. A drained cancellation takes its
// target terminal BEFORE the dispatch loop, so a correctly-wired orchestrator never
// reaches this — it is the proof that cancellation preempts work, not the reverse.
const refusingExecutor: Executor = {
  capabilities: () => stubCapabilities,
  run(): Promise<ExecutorResult> {
    throw new Error('a cancelled node must not be dispatched');
  },
};

// Every durable `.relay/` record as text, keyed by path; the transient journal is
// excluded and checked separately via pendingIntents. The inbox IS included — it is
// durable human-owned state the orchestrator only reads, so it must be byte-stable
// across a rehydration.
async function collectRelay(relayDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (relPath === 'journal') continue;
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile() && !ent.name.includes('.tmp-')) {
        out[relPath] = await readFile(join(dir, ent.name), 'utf8');
      }
    }
  }
  await walk(relayDir, '');
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// WHY: the inbox is the human's only write channel onto a running tree (I4), and it
// is durable state the orchestrator merely reads — so a queued decision must take
// effect on the *next activation whoever runs it*, and survive teardown to be
// drained by a replacement. The transition must be atomic (no torn node + dangling
// intent on a crash mid-drain), and re-draining the same durable decision must not
// re-apply it. A wiring that applied the decision non-atomically, or re-cancelled on
// every rehydration, fails here.
describe('the decision inbox is drained at activation', () => {
  test('a queued decision is applied atomically on the next activation, and re-draining is idempotent', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);
      await writeDecision(relayDir, {
        decisionId: 'dec-1',
        kind: 'cancel',
        targetNodeId: LEAF_ID,
        note: null,
      });

      // First activation: a fresh orchestrator finds the queued decision in durable
      // state and applies it before dispatching anything (refusingExecutor proves the
      // leaf is never run).
      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: refusingExecutor,
        workRoot,
      });

      expect(res.cancelledNodes).toEqual([LEAF_ID]);
      expect(res.leafStatuses[LEAF_ID]).toBe('cancelled');
      const leaf = await readNode(relayDir, LEAF_ID);
      expect(leaf.status).toBe('cancelled');
      // The decision was applied as one atomic transition: no intent left dangling.
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);

      const afterFirst = await collectRelay(relayDir);

      // Second activation (rehydration): the decision is still in the durable inbox.
      // A correct drain sees the target already terminal and changes nothing.
      const res2 = await runOrchestrator(relayDir, ROOT_ID, {
        executor: refusingExecutor,
        workRoot,
      });

      // Idempotent: nothing cancelled this run (already terminal), byte-identical state.
      expect(res2.cancelledNodes).toEqual([]);
      expect(res2.leafStatuses[LEAF_ID]).toBe('cancelled');
      expect(await collectRelay(relayDir)).toEqual(afterFirst);
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: human cancellation rides the same terminal-failure machinery as ladder
// exhaustion (§3.9) — the node goes terminal and the failure surfaces up the parent
// chain with no route-around, the lesson is kept before the worktree is reset
// (§3.5), and in serial form NOTHING else happens: no seam graph is traced and no
// independent in-flight work is drained (both deferred to concurrency, M10). A
// wiring that let the parent reach `done` over a cancelled child, dropped the
// lesson, or left the worktree, fails here.
describe('serial-form cancellation marks the node terminal and halts', () => {
  test('a cancelled leaf is terminal, keeps its lesson, discards its worktree, and surfaces to the parent', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      // A stale worktree from a prior attempt: cancellation must reset it (§3.5).
      const leafWorktree = join(workRoot, LEAF_ID);
      await mkdir(leafWorktree, { recursive: true });
      await writeFile(join(leafWorktree, 'CHANGE.txt'), 'partial work\n');

      await writeDecision(relayDir, {
        decisionId: 'dec-1',
        kind: 'cancel',
        targetNodeId: LEAF_ID,
        note: 'operator changed direction',
      });

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: refusingExecutor,
        workRoot,
      });

      // The node is terminal...
      const leaf = await readNode(relayDir, LEAF_ID);
      expect(leaf.status).toBe('cancelled');
      expect(res.leafStatuses[LEAF_ID]).toBe('cancelled');

      // ...the lesson is kept (names the decision and the human's note)...
      const lesson = leaf.learnings[leaf.learnings.length - 1];
      expect(lesson).toContain('dec-1');
      expect(lesson).toContain('operator changed direction');

      // ...the worktree was discarded (persist-then-discard)...
      expect(await exists(leafWorktree)).toBe(false);

      // ...and the failure surfaced: the parent halts as blocked, never done, with a
      // self-sufficient record naming the cancelled descendant.
      expect(res.rootStatus).toBe('blocked');
      const root = await readNode(relayDir, ROOT_ID);
      expect(root.status).toBe('blocked');
      const record = root.blocked;
      if (!record) throw new Error('expected a surfaced record on the parent');
      expect(record.reason).toContain(LEAF_ID);
      expect(record.reason).toContain('cancelled');
      expect(record.humanFacing).toContain(LEAF_ID);

      // Serial form: only the targeted node is cancelled, no branch child was driven,
      // nothing was promoted — there is no seam graph to trace and no independent work
      // to drain (deferred to M10). The refusing executor never threw, proving no work
      // was run anywhere.
      expect(res.cancelledNodes).toEqual([LEAF_ID]);
      expect(res.childStatuses).toEqual({});
      expect(res.promotedNodes).toEqual([]);

      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('cancelling the branch itself halts the whole activation — no child is driven', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);
      await writeDecision(relayDir, {
        decisionId: 'dec-1',
        kind: 'cancel',
        targetNodeId: ROOT_ID,
        note: null,
      });

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: refusingExecutor,
        workRoot,
      });

      // The branch is terminal and the activation returned before driving any child:
      // the leaf is untouched (still pending) and the dispatch loop never ran.
      expect(res.rootStatus).toBe('cancelled');
      expect(res.cancelledNodes).toEqual([ROOT_ID]);
      expect(res.leafStatuses).toEqual({});
      const root = await readNode(relayDir, ROOT_ID);
      expect(root.status).toBe('cancelled');
      expect(root.learnings[root.learnings.length - 1]).toContain('dec-1');
      const leaf = await readNode(relayDir, LEAF_ID);
      expect(leaf.status).toBe('pending');

      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
