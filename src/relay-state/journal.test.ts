import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { atomicWriteFile } from './io';
import { commit, applyIntent, pendingIntents, rollForwardPending, writeIntent } from './journal';
import { relayPaths } from './paths';

const REGION = 'root';

async function tmpRelay(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'relay-journal-'));
}

async function readRel(relayDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(relayDir, rel), 'utf8');
  } catch {
    return null;
  }
}

// Representative `.relay/` file content: multi-line, with its own `---` fences,
// proving the journal preserves arbitrary file bytes (including nested
// front-matter) through the intent's YAML.
const NODE_A_POST = '---\nid: a\nkind: leaf\nbody: |\n  line\n  ---\n  end\n---\n\n# node a\n';
const MANIFEST_POST = '---\nrunId: r1\nrootId: a\n---\n\n# manifest\n';

describe('intent journal — atomicity and roll-forward', () => {
  // WHY: a structural transition spans several files; rehydration must never see
  // a half-applied one. The commit point is the durable intent, so before it the
  // pre-state stands and after it the post-state is recoverable.
  test('commit lands a multi-file transaction and leaves no pending intent', async () => {
    const dir = await tmpRelay();
    try {
      await commit(dir, REGION, [
        { path: 'nodes/a.md', content: NODE_A_POST },
        { path: 'manifest.md', content: MANIFEST_POST },
      ]);
      expect(await readRel(dir, 'nodes/a.md')).toBe(NODE_A_POST);
      expect(await readRel(dir, 'manifest.md')).toBe(MANIFEST_POST);
      expect(await pendingIntents(dir, REGION)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a transaction interrupted before the commit point leaves the pre-state', async () => {
    const dir = await tmpRelay();
    try {
      // Pre-state.
      await atomicWriteFile(join(dir, 'nodes/a.md'), 'PRE');
      // Simulate a crash mid-`writeIntent`, before the atomic rename: a temp
      // intent file exists but was never promoted to `<id>.intent.md`.
      const journalDir = relayPaths(dir).journalDir(REGION);
      await mkdir(journalDir, { recursive: true });
      await writeFile(join(journalDir, 'intent-x.intent.md.tmp-999'), 'half-written post-state');

      expect(await pendingIntents(dir, REGION)).toEqual([]);
      expect(await rollForwardPending(dir, REGION)).toEqual([]);
      // The interrupted transaction left no trace; pre-state stands.
      expect(await readRel(dir, 'nodes/a.md')).toBe('PRE');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a transaction interrupted after the commit point rolls forward to the post-state', async () => {
    const dir = await tmpRelay();
    try {
      await atomicWriteFile(join(dir, 'nodes/a.md'), 'PRE');
      // Commit the intent (durable) but crash before applying any write.
      const intentId = await writeIntent(dir, REGION, [
        { path: 'nodes/a.md', content: NODE_A_POST },
        { path: 'manifest.md', content: MANIFEST_POST },
      ]);
      expect(await pendingIntents(dir, REGION)).toEqual([intentId]);
      // Targets are still pre-state — the writes have not been applied yet.
      expect(await readRel(dir, 'nodes/a.md')).toBe('PRE');
      expect(await readRel(dir, 'manifest.md')).toBeNull();

      // Rehydration rolls the intent forward: every file reaches the post-state.
      expect(await rollForwardPending(dir, REGION)).toEqual([intentId]);
      expect(await readRel(dir, 'nodes/a.md')).toBe(NODE_A_POST);
      expect(await readRel(dir, 'manifest.md')).toBe(MANIFEST_POST);
      expect(await pendingIntents(dir, REGION)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // WHY: roll-forward itself can be interrupted (after applying, before removing
  // the intent). Re-applying the same orphan intent must be a no-op-equivalent,
  // or rehydration could diverge. Full post-state in the intent makes apply
  // idempotent by construction.
  test('applying the same orphan intent twice yields the same result', async () => {
    const dir = await tmpRelay();
    try {
      const intentId = await writeIntent(dir, REGION, [
        { path: 'nodes/a.md', content: NODE_A_POST },
      ]);
      const intentFile = join(relayPaths(dir).journalDir(REGION), `${intentId}.intent.md`);
      const intentBytes = await readFile(intentFile, 'utf8');

      await applyIntent(dir, REGION, intentId);
      const afterFirst = await readRel(dir, 'nodes/a.md');

      // Simulate a roll-forward interrupted before it removed the intent: the
      // same orphan intent is present again.
      await writeFile(intentFile, intentBytes);
      await applyIntent(dir, REGION, intentId);
      const afterSecond = await readRel(dir, 'nodes/a.md');

      expect(afterFirst).toBe(NODE_A_POST);
      expect(afterSecond).toBe(afterFirst);
      expect(await pendingIntents(dir, REGION)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
