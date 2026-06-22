import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  commitStore,
  ensureProjectStore,
  projectKey,
  readProjectIndex,
  relayHome,
} from './relay-home';

// git commit needs an author identity; set one hermetically so the test does not
// depend on the runner's global git config.
beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Relay Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@relay.local';
  process.env.GIT_COMMITTER_NAME = 'Relay Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@relay.local';
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// WHY: the key is what makes a project's store stable and collision-free across
// runs (the §4 git-trackability rationale depends on resolving to the SAME path
// every time). A key that varied by cwd, or collided for two same-named projects,
// would scatter or merge their `.relay/` records.
describe('projectKey', () => {
  test('is stable for one path and disambiguates same-basename projects', () => {
    const a1 = projectKey('/Users/x/Projects/relay');
    const a2 = projectKey('/Users/x/Projects/relay');
    const b = projectKey('/Users/x/other/relay');

    expect(a1).toBe(a2);
    // Same basename, different absolute path → different key (the hash diverges).
    expect(a1.startsWith('relay-')).toBe(true);
    expect(b.startsWith('relay-')).toBe(true);
    expect(a1).not.toBe(b);
  });

  test('sanitizes a basename with filesystem-unsafe characters', () => {
    const key = projectKey('/tmp/My Project (v2)');
    // No spaces or parens leak into the path segment; the hash suffix remains.
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(key).toContain('My-Project-v2');
  });
});

describe('ensureProjectStore', () => {
  test('creates a git-inited store + index entry, and re-resolves to the SAME path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-'));
    try {
      const first = await ensureProjectStore(project, {
        home,
        now: () => '2026-01-01T00:00:00.000Z',
      });
      expect(first.created).toBe(true);
      expect(first.storeDir).toBe(join(home, first.key));
      // git-inited (design §4 git-trackability).
      expect(await exists(join(first.storeDir, '.git'))).toBe(true);
      // Worktree root is OUTSIDE the store so sandboxes never enter the git record.
      expect(first.workRoot.startsWith(first.storeDir)).toBe(false);
      // WHY: the operator's absolute project path is the source the executor sandbox
      // is seeded from and the repo a verified result lands back into. The store must
      // surface it (resolved once) so the run never re-derives it; a store that
      // dropped it would force every downstream step to re-resolve the cwd.
      expect(first.projectPath).toBe(resolve(project));

      const index1 = await readProjectIndex(home);
      expect(index1.projects[first.key]).toEqual({
        projectPath: project,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastRunAt: '2026-01-01T00:00:00.000Z',
      });

      // Re-resolving the same project: SAME key + path, not re-created, createdAt
      // preserved while lastRunAt advances.
      const second = await ensureProjectStore(project, {
        home,
        now: () => '2026-02-02T00:00:00.000Z',
      });
      expect(second.key).toBe(first.key);
      expect(second.storeDir).toBe(first.storeDir);
      expect(second.created).toBe(false);

      const index2 = await readProjectIndex(home);
      expect(index2.projects[first.key]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(index2.projects[first.key]?.lastRunAt).toBe('2026-02-02T00:00:00.000Z');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

// WHY: "operator can `git log` the store" is a Phase 2 validation criterion; an
// empty `git init` is not log-able. commitStore is what makes a run's `.relay/`
// land as a real commit, and it must tolerate a no-op re-run without failing.
describe('commitStore', () => {
  test('records a commit when the store changed, and is a no-op otherwise', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-'));
    try {
      const store = await ensureProjectStore(project, { home });
      await writeFile(join(store.storeDir, 'manifest.md'), '# seeded\n');

      expect(await commitStore(store.storeDir, 'first')).toBe(true);
      // Nothing changed since the last commit → no new commit, no throw.
      expect(await commitStore(store.storeDir, 'second')).toBe(false);
      expect(relayHome({ home })).toBe(home);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});
