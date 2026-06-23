import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readNode, rollForwardPending } from '../relay-state/index';
import type { Executor, ExecutorResult } from './index';
import {
  InjectedKill,
  runOrchestrator,
  scriptedCritic,
  scriptedExecutor,
  seedFixture,
  stubCapabilities,
} from './index';

const ROOT_ID = 'root';
const LEAF_ID = 'leaf-1';

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-promote-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Every durable `.relay/` record as text, keyed by path. The journal is excluded
// (transient, nondeterministic ids); it is checked separately via `pendingIntents`.
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

// WHY: this is the phase's reason to exist — the loop must answer FAIL, not only
// PASS. A leaf the critic never accepts must walk the rungs (re-dispatching on
// each) and then be PROMOTED to a branch, carrying forward WHY it failed so the
// re-decomposition does not relearn it. A wiring that jumped straight to promote
// would skip the rungs; one that lost the lesson would re-decompose blind; one
// that reset the worktree before persisting the lesson would lose evidence on a
// crash. Each is a real failure this test forces.
describe('persistent failure promotes the leaf, keeping the lesson', () => {
  test('walks the rungs, then promotes leaf→branch with the reflection in the children', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      // Count dispatches so we can assert the ladder actually re-dispatched on the
      // retry/swap/raise rungs rather than promoting on the first failure.
      let dispatches = 0;
      const counting: Executor = {
        capabilities: () => stubCapabilities,
        async run(input): Promise<ExecutorResult> {
          dispatches += 1;
          return scriptedExecutor({ signals: ['ok'] }).run(input);
        },
      };
      // The critic rejects every attempt: persistent failure down the whole ladder.
      const critic = scriptedCritic({ results: ['fail'] });

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: counting,
        critic,
        workRoot,
      });

      // The leaf was promoted, not done; the root cannot be done with a pending
      // sub-branch beneath it.
      expect(res.promotedNodes).toEqual([LEAF_ID]);
      expect(res.rootStatus).not.toBe('done');

      // The ladder re-dispatched: retry, swap-provider, raise-tier each re-ran the
      // executor before the promote rung (4 attempts: initial + 3 escalations).
      expect(dispatches).toBe(4);

      // The leaf became a branch with the stub's two re-decomposed children.
      const branch = await readNode(relayDir, LEAF_ID);
      expect(branch.kind).toBe('branch');
      expect(branch.status).toBe('pending');
      expect(branch.children).toEqual([`${LEAF_ID}.c0`, `${LEAF_ID}.c1`]);

      // Keep-lesson: the failed attempt's reflection is present in BOTH the branch
      // and every re-decomposed child's context, and it carries the critic's
      // standing reason — not a generic placeholder.
      const reflection = branch.learnings.at(-1);
      expect(reflection).toContain('promoted');
      // It carries the critic's standing reason (its last verdict rationale), not
      // a generic placeholder — so the re-decomposition knows WHAT was rejected.
      expect(reflection).toContain('scripted critic returned fail');
      for (const childId of branch.children) {
        const child = await readNode(relayDir, childId);
        expect(child.kind).toBe('leaf');
        expect(child.parentId).toBe(LEAF_ID);
        expect(child.learnings).toContain(reflection);
      }

      // The failed attempt's worktree is reset to clean.
      expect(await exists(join(workRoot, LEAF_ID))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: a too-big judgment is a different failure than a flaky one — re-running
// the same leaf is wasted metered spend, so the executor's sizing signal must
// drive the ladder STRAIGHT to promote with no retry/swap/raise. This proves the
// signal is plumbed through a real executor seam, not just the controller
// boundary (which ladder.test.ts already covers).
describe('a too-big executor signal promotes without walking the lower rungs', () => {
  test('one dispatch, then promote', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      let dispatches = 0;
      const tooBig: Executor = {
        capabilities: () => stubCapabilities,
        async run(input): Promise<ExecutorResult> {
          dispatches += 1;
          return scriptedExecutor({ signals: ['too-big'] }).run(input);
        },
      };
      // The critic would pass if reached — proving promotion came from the sizing
      // signal preempting the critic, not from a critic rejection.
      const critic = scriptedCritic({ results: ['pass'] });

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: tooBig,
        critic,
        workRoot,
      });

      expect(res.promotedNodes).toEqual([LEAF_ID]);
      expect(dispatches).toBe(1);

      const branch = await readNode(relayDir, LEAF_ID);
      expect(branch.kind).toBe('branch');
      // The reflection names the too-big judgment as the reason.
      expect(branch.learnings.at(-1)).toContain('too big');
      const child = await readNode(relayDir, `${LEAF_ID}.c0`);
      expect(child.learnings.at(-1)).toContain('too big');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: promotion rewrites several `.relay/` files at once (the leaf→branch flip
// and every new child). If that were not one atomic transaction, a crash mid-write
// could leave a branch pointing at children that do not exist, or children orphaned
// under a still-leaf parent — a torn state no rehydration could trust. The journal
// makes it all-or-nothing: a crash leaves EITHER the pre-promotion leaf OR the
// fully-formed post-promotion branch. A non-atomic promote fails this test.
describe('promotion is one atomic transaction (rehydration sees pre or post, never torn)', () => {
  const failingRun = {
    executor: scriptedExecutor({ signals: ['too-big'] }),
    critic: scriptedCritic({ results: ['fail'] }),
  };

  test('a kill before the commit point leaves the pre-promotion leaf', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      await expect(
        runOrchestrator(relayDir, ROOT_ID, {
          ...failingRun,
          workRoot,
          faultAt: { leafId: LEAF_ID, point: 'before-promote' },
        }),
      ).rejects.toThrow(InjectedKill);

      // No promotion intent was committed; the node is still the pre-promotion leaf.
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
      const node = await readNode(relayDir, LEAF_ID);
      expect(node.kind).toBe('leaf');
      // The re-decomposed children do not exist yet.
      await expect(readNode(relayDir, `${LEAF_ID}.c0`)).rejects.toThrow();
      // Sol 2: the decompose rationale rides the SAME atomic intent as the layer, so a
      // kill BEFORE the commit point leaves NEITHER — no rationale file, no ref.
      expect(
        await exists(join(relayDir, 'evidence', 'run-1', LEAF_ID, 'decompose-rationale.md')),
      ).toBe(false);
      expect(node.evidenceRefs.some((r) => r.kind === 'rationale')).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a kill after the commit point rolls forward to the whole post-promotion branch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      // Kill between the promotion intent's commit point and its apply.
      await expect(
        runOrchestrator(relayDir, ROOT_ID, {
          ...failingRun,
          workRoot,
          faultAt: { leafId: LEAF_ID, point: 'promote-intent' },
        }),
      ).rejects.toThrow(InjectedKill);

      // The committed-but-unapplied intent is pending; rehydration's roll-forward
      // applies it idempotently and completes the promotion.
      expect((await pendingIntents(relayDir, ROOT_ID)).length).toBe(1);
      const rolled = await rollForwardPending(relayDir, ROOT_ID);
      expect(rolled.length).toBe(1);

      // The post-promotion branch AND both children are present and consistent —
      // never a branch without its children.
      const branch = await readNode(relayDir, LEAF_ID);
      expect(branch.kind).toBe('branch');
      expect(branch.children).toEqual([`${LEAF_ID}.c0`, `${LEAF_ID}.c1`]);
      for (const childId of branch.children) {
        const child = await readNode(relayDir, childId);
        expect(child.parentId).toBe(LEAF_ID);
        expect(child.learnings).toContain(branch.learnings.at(-1));
      }
      // Sol 2: a kill AFTER the commit point rolls forward to BOTH the layer and its
      // rationale — the branch carries the `rationale` ref and the file is on disk.
      // (Together with the before-commit test, this pins "both or neither".)
      const ratRef = branch.evidenceRefs.find((r) => r.kind === 'rationale');
      expect(ratRef?.path).toBe(`${LEAF_ID}/decompose-rationale.md`);
      expect(
        await readFile(
          join(relayDir, 'evidence', 'run-1', LEAF_ID, 'decompose-rationale.md'),
          'utf8',
        ),
      ).toContain('stub decomposition');

      // Roll-forward is idempotent and exhaustive: nothing left pending, and the
      // resulting state matches an uninterrupted promotion byte-for-byte.
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);

      const clean = await freshRelay();
      try {
        await seedFixture(clean.relayDir);
        await runOrchestrator(clean.relayDir, ROOT_ID, {
          ...failingRun,
          workRoot: clean.workRoot,
        });
        expect(await collectRelay(relayDir)).toEqual(await collectRelay(clean.relayDir));
      } finally {
        await rm(clean.base, { recursive: true, force: true });
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
