import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { captureDiff, establishBaseline, resolveSeedPlan, seedWorktree } from './worktree-diff';

const execFileP = promisify(execFile);

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Relay Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@relay.local';
  process.env.GIT_COMMITTER_NAME = 'Relay Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@relay.local';
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {});
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// A clean operator repo: two committed tracked files, so "only the change, not the
// whole tree" is falsifiable (an untouched tracked file must NOT appear in the diff).
async function makeCleanRepo(): Promise<{ repo: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'relay-seed-repo-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@relay.local');
  await git(repo, 'config', 'user.name', 'Relay Test');
  await writeFile(join(repo, 'existing.txt'), 'original content\n');
  await writeFile(join(repo, 'untouched.txt'), 'leave me alone\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--no-gpg-sign', '-m', 'seed');
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
  return { repo, head };
}

// WHY: this is the heart of the workspace-substrate change — the executor must edit
// the operator's REAL project, and the critic must grade ONLY what the executor
// changed (not the whole tree it was handed). A seam that copied the project but
// then diffed it whole, or that re-baselined and folded the change into the base,
// would either drown the critic in the entire codebase or grade an empty diff. Both
// are silent correctness failures the gradeable-evidence contract depends on.
describe('checkout seed path (clean git workspace)', () => {
  test('seeds a project checkout at the per-run base and captures ONLY the change', async () => {
    const { repo, head } = await makeCleanRepo();
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-seed-wr-'));
    try {
      // The clean repo resolves to a checkout off HEAD.
      const plan = await resolveSeedPlan(repo);
      expect(plan).toEqual({ mode: 'checkout', projectPath: repo, base: head });
      if (plan.mode !== 'checkout') throw new Error('unreachable');

      const wt = join(workRoot, 'leaf-1');
      await seedWorktree(wt, plan);

      // The executor sees the project's tracked files at base.
      expect(await readFile(join(wt, 'existing.txt'), 'utf8')).toBe('original content\n');
      expect(await readFile(join(wt, 'untouched.txt'), 'utf8')).toBe('leave me alone\n');

      // git worktree list shows the leaf forked from the captured base.
      const list = await git(repo, 'worktree', 'list', '--porcelain');
      expect(list).toContain(wt);
      expect(list).toContain(`HEAD ${head}`);

      // A pre-seeded checkout IS the baseline: establishBaseline must NOT touch it
      // (a re-init/commit here would fold the change into the base → empty diff).
      await establishBaseline(wt, { preseeded: true });

      // The executor edits: modify one tracked file, add a new one, leave the other.
      await writeFile(join(wt, 'existing.txt'), 'changed content\n');
      await writeFile(join(wt, 'new.txt'), 'brand new\n');

      const diff = await captureDiff(wt, plan.base);

      // The modification shows as a modification against base (a `-`/`+` hunk), which
      // is only possible because the worktree was a real checkout at base.
      expect(diff).toContain('-original content');
      expect(diff).toContain('+changed content');
      // The new file shows as an addition.
      expect(diff).toContain('new.txt');
      expect(diff).toContain('+brand new');
      // ONLY the change: the untouched tracked file is absent, and exactly two files
      // changed — the diff is not the whole project tree.
      expect(diff).not.toContain('untouched.txt');
      expect((diff.match(/^diff --git/gm) ?? []).length).toBe(2);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('captures changes even when the executor commits inside the checkout', async () => {
    const { repo, head } = await makeCleanRepo();
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-seed-wr-'));
    try {
      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'checkout') throw new Error('expected checkout');
      const wt = join(workRoot, 'leaf-1');
      await seedWorktree(wt, plan);

      // The model commits its work (moving the worktree HEAD off the base).
      await writeFile(join(wt, 'existing.txt'), 'committed change\n');
      await git(wt, 'add', '-A');
      await git(wt, 'commit', '-q', '--no-gpg-sign', '-m', 'model commit');
      expect((await git(wt, 'rev-parse', 'HEAD')).trim()).not.toBe(head);

      // Diffing against the captured base (not HEAD) still recovers the full change.
      const diff = await captureDiff(wt, plan.base);
      expect(diff).toContain('-original content');
      expect(diff).toContain('+committed change');
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// WHY: the checkout path is GATED — it must engage ONLY for a clean git repo. A
// non-git, dirty, or commit-less workspace has no safe base to fork from (forcing a
// checkout would drop the operator's uncommitted work or fail), so it falls back to
// the empty path, and an absent projectPath (the hermetic stub runs) must not even
// touch git. A gate that mis-fired here would corrupt the hermetic baseline tests.
describe('resolveSeedPlan gating', () => {
  test('falls back to empty for absent / non-git / dirty / commit-less workspaces', async () => {
    expect(await resolveSeedPlan(undefined)).toEqual({ mode: 'empty' });

    const nonGit = await mkdtemp(join(tmpdir(), 'relay-seed-nongit-'));
    const dirty = await mkdtemp(join(tmpdir(), 'relay-seed-dirty-'));
    const unborn = await mkdtemp(join(tmpdir(), 'relay-seed-unborn-'));
    try {
      // A directory that is not a git repo.
      expect(await resolveSeedPlan(nonGit)).toEqual({ mode: 'empty' });

      // A git repo with uncommitted changes (an untracked file makes it dirty).
      await git(dirty, 'init', '-q');
      await git(dirty, 'config', 'user.email', 'test@relay.local');
      await git(dirty, 'config', 'user.name', 'Relay Test');
      await writeFile(join(dirty, 'committed.txt'), 'x\n');
      await git(dirty, 'add', '-A');
      await git(dirty, 'commit', '-q', '--no-gpg-sign', '-m', 'init');
      await writeFile(join(dirty, 'unstaged.txt'), 'dirty\n');
      expect(await resolveSeedPlan(dirty)).toEqual({ mode: 'empty' });

      // A git repo with no commit yet (unborn HEAD → no base to fork from).
      await git(unborn, 'init', '-q');
      expect(await resolveSeedPlan(unborn)).toEqual({ mode: 'empty' });
    } finally {
      await rm(nonGit, { recursive: true, force: true });
      await rm(dirty, { recursive: true, force: true });
      await rm(unborn, { recursive: true, force: true });
    }
  });
});

// WHY: the empty path is the hermetic default and must stay intact — seedWorktree
// makes the dir, establishBaseline commits a real baseline, and captureDiff reports
// the change against it. This is the exact mechanism the byte-identical stub tests
// rely on; a regression here would break every hermetic run.
describe('empty seed path (default)', () => {
  test('mkdirs, baselines, and diffs the change against the baseline commit', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-seed-empty-'));
    try {
      const wt = join(workRoot, 'leaf-1');
      await seedWorktree(wt, { mode: 'empty' });
      expect(await exists(wt)).toBe(true);

      // A pre-existing file is part of the baseline (not the produced change).
      await writeFile(join(wt, 'baseline.txt'), 'baseline\n');
      await establishBaseline(wt);

      // The executor's change after the baseline.
      await writeFile(join(wt, 'produced.txt'), 'produced\n');
      const diff = await captureDiff(wt);

      expect(diff).toContain('produced.txt');
      expect(diff).toContain('+produced');
      expect(diff).not.toContain('baseline.txt');
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
