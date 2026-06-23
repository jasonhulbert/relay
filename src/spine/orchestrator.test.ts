import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { pendingIntents, readNode } from '../relay-state/index';
import { InjectedKill, runOrchestrator, seedFixture } from './index';
import type { FaultPoint } from './index';

async function freshRelay(): Promise<{ base: string; relayDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-spine-'));
  return { base, relayDir: join(base, '.relay') };
}

// Collect every durable `.relay/` record (nodes, manifest, evidence) as text,
// keyed by path. The journal is excluded: its intents are transient and carry
// nondeterministic ids/timestamps, so it is checked separately via
// `pendingIntents`. Temp files (`.tmp-*`) are never durable records.
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

const ROOT_ID = 'root';
const LEAF_ID = 'leaf-1';

// The byte-deterministic terminal `.relay/` state of a clean, uninterrupted run.
// Every kill-and-rehydrate variant must reproduce exactly this.
let baseline: Record<string, string>;

beforeAll(async () => {
  const { base, relayDir } = await freshRelay();
  try {
    await seedFixture(relayDir);
    await runOrchestrator(relayDir, ROOT_ID);
    baseline = await collectRelay(relayDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

describe('single-leaf loop reaches done end-to-end', () => {
  // WHY: this is the walking skeleton's reason to exist — proving the real
  // mechanics (journal, projection, rehydration) carry one leaf from a seeded
  // root to `done`, with `.relay/` recording spec, diff, evidence, and verdict
  // (not the executor's say-so).
  test('the leaf and root reach done, with spec/diff/evidence/verdict recorded', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedFixture(relayDir);
      const res = await runOrchestrator(relayDir, ROOT_ID);
      expect(res.rootStatus).toBe('done');
      expect(res.leafStatuses[LEAF_ID]).toBe('done');
      expect(res.rolledForward).toEqual([]);

      const leaf = await readNode(relayDir, LEAF_ID);
      expect(leaf.status).toBe('done');
      // spec recorded.
      expect(leaf.spec.outcome).toContain('the leaf produces its change');
      // verdict recorded — and it is the critic's, not the executor's say-so.
      expect(leaf.verdict?.pass).toBe(true);
      expect(leaf.verdict?.provider).toBe('stub-critic');
      // evidence recorded: diff + self-report + verdict refs, never inline.
      const kinds = leaf.evidenceRefs.map((r) => r.kind).sort();
      expect(kinds).toEqual(['diff', 'self-report', 'verdict']);
      expect(leaf.selfReport).not.toBeNull();

      // The referenced artifacts exist in the evidence store.
      const diff = await readFile(
        join(relayDir, 'evidence', 'run-1', LEAF_ID, 'diff.patch'),
        'utf8',
      );
      expect(diff).toContain('CHANGE.txt');
      const verdict = await readFile(
        join(relayDir, 'evidence', 'run-1', LEAF_ID, 'verdict.md'),
        'utf8',
      );
      expect(verdict).toContain('PASS');

      const root = await readNode(relayDir, ROOT_ID);
      expect(root.status).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: disposability is the system's backbone (the rehydration contract). A process killed mid-run
// must be reconstitutable from `.relay/` alone, reaching the SAME terminal state
// with no torn records. A thrown `InjectedKill` models the kill: `.relay/` is the
// only durable state, so a thrown fault at a seam is indistinguishable from a
// SIGKILL there for rehydration purposes. We cover every transition boundary,
// including the after-commit-point case that exercises journal roll-forward.
describe('kill-and-rehydrate reproduces the terminal done state', () => {
  const faultPoints: FaultPoint[] = [
    'before-dispatch',
    'after-executor',
    'after-self-report',
    'leaf-done-intent',
    'after-leaf-done',
  ];

  describe.each(faultPoints)('killed at %s', (point) => {
    test('a fresh run against the node-id reaches the identical terminal state', async () => {
      const { base, relayDir } = await freshRelay();
      try {
        await seedFixture(relayDir);

        // First process: dies at the injected point.
        await expect(
          runOrchestrator(relayDir, ROOT_ID, { faultAt: { leafId: LEAF_ID, point } }),
        ).rejects.toThrow(InjectedKill);

        // Replacement process: rehydrates from `.relay/` and completes.
        const res = await runOrchestrator(relayDir, ROOT_ID);
        expect(res.rootStatus).toBe('done');
        expect(res.leafStatuses[LEAF_ID]).toBe('done');

        // Only the after-commit-point kill leaves an intent to roll forward; the
        // others crashed between transactions, so there is nothing pending.
        expect(res.rolledForward.length).toBe(point === 'leaf-done-intent' ? 1 : 0);
        expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);

        // No torn records, and the terminal state is byte-identical to a clean run.
        expect(await collectRelay(relayDir)).toEqual(baseline);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });
});
