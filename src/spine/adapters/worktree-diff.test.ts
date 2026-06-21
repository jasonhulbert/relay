import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  captureDiff,
  composeMergeTree,
  establishBaseline,
  resolveSeedPlan,
  seedWorktree,
} from './worktree-diff';

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

// WHY: the seed mode is the load-bearing gate. The checkout path must engage ONLY
// for a clean git repo (forcing it elsewhere would drop the operator's uncommitted
// work or fail); a non-git dir or a dirty tree must take the snapshot path so Relay
// still runs "in any workspace"; a commit-less but clean repo has nothing to seed
// (empty); and an absent projectPath (the hermetic stub runs) must not even touch
// git. A gate that mis-fired here would corrupt the hermetic baseline tests or seed
// the executor against the wrong tree.
describe('resolveSeedPlan gating', () => {
  test('empty for absent projectPath and for a commit-less clean repo', async () => {
    expect(await resolveSeedPlan(undefined)).toEqual({ mode: 'empty' });

    const unborn = await mkdtemp(join(tmpdir(), 'relay-seed-unborn-'));
    try {
      // A git repo with no commit yet and no files: no base to fork from and nothing
      // to snapshot, so the empty path is exactly right.
      await git(unborn, 'init', '-q');
      expect(await resolveSeedPlan(unborn)).toEqual({ mode: 'empty' });
    } finally {
      await rm(unborn, { recursive: true, force: true });
    }
  });

  test('snapshot for a non-git dir and for a dirty git tree, with the notice recorded', async () => {
    const nonGit = await mkdtemp(join(tmpdir(), 'relay-seed-nongit-'));
    const dirty = await mkdtemp(join(tmpdir(), 'relay-seed-dirty-'));
    try {
      // A directory that is not a git repo → snapshot, tagged non-git.
      await writeFile(join(nonGit, 'file.txt'), 'x\n');
      expect(await resolveSeedPlan(nonGit)).toEqual({
        mode: 'snapshot',
        projectPath: nonGit,
        reason: 'non-git',
        notice: expect.stringContaining('not a git repository'),
      });

      // A git repo with uncommitted changes (an untracked file makes it dirty) →
      // snapshot, tagged dirty, with a notice that names the patch fallback.
      await git(dirty, 'init', '-q');
      await git(dirty, 'config', 'user.email', 'test@relay.local');
      await git(dirty, 'config', 'user.name', 'Relay Test');
      await writeFile(join(dirty, 'committed.txt'), 'x\n');
      await git(dirty, 'add', '-A');
      await git(dirty, 'commit', '-q', '--no-gpg-sign', '-m', 'init');
      await writeFile(join(dirty, 'unstaged.txt'), 'dirty\n');
      expect(await resolveSeedPlan(dirty)).toEqual({
        mode: 'snapshot',
        projectPath: dirty,
        reason: 'dirty',
        notice: expect.stringContaining('result.patch'),
      });
    } finally {
      await rm(nonGit, { recursive: true, force: true });
      await rm(dirty, { recursive: true, force: true });
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

// WHY: the snapshot path is what lets Relay run "in any workspace" — a non-git dir
// or a dirty tree the checkout path can't safely fork from. The executor must see
// the project's files (so it edits real code), the standard caches must NOT be
// dragged in, and after the empty-path baseline runs over the populated tree the
// critic must still grade ONLY the executor's change, not the whole seeded project.
// A snapshot that copied junk, missed the project, or diffed the whole tree would
// each be a silent correctness failure.
describe('snapshot seed path (non-git workspace)', () => {
  test('copies the project (minus standard excludes) and captures ONLY the change', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'relay-snap-nongit-'));
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-snap-wr-'));
    try {
      await writeFile(join(proj, 'existing.txt'), 'original content\n');
      await writeFile(join(proj, 'untouched.txt'), 'leave me alone\n');
      // Heavy/irrelevant dirs that must be excluded from the snapshot.
      await execFileP('mkdir', ['-p', join(proj, 'node_modules', 'pkg'), join(proj, '.git')]);
      await writeFile(join(proj, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n');
      await writeFile(join(proj, '.git', 'HEAD'), 'ref: refs/heads/main\n');

      const plan = await resolveSeedPlan(proj);
      expect(plan).toEqual({
        mode: 'snapshot',
        projectPath: proj,
        reason: 'non-git',
        notice: expect.any(String),
      });

      const wt = join(workRoot, 'leaf-1');
      await seedWorktree(wt, plan);

      // The executor sees the project's files...
      expect(await readFile(join(wt, 'existing.txt'), 'utf8')).toBe('original content\n');
      expect(await readFile(join(wt, 'untouched.txt'), 'utf8')).toBe('leave me alone\n');
      // ...but not the standard excludes.
      expect(await exists(join(wt, 'node_modules'))).toBe(false);
      expect(await exists(join(wt, '.git'))).toBe(false);

      // Snapshot is not a pre-seeded checkout: the empty-path baseline runs over it.
      await establishBaseline(wt);

      // The executor edits one file and adds another, leaving the third untouched.
      await writeFile(join(wt, 'existing.txt'), 'changed content\n');
      await writeFile(join(wt, 'new.txt'), 'brand new\n');

      const diff = await captureDiff(wt);

      expect(diff).toContain('-original content');
      expect(diff).toContain('+changed content');
      expect(diff).toContain('new.txt');
      expect(diff).toContain('+brand new');
      // ONLY the change: the untouched file is absent and exactly two files changed.
      expect(diff).not.toContain('untouched.txt');
      expect((diff.match(/^diff --git/gm) ?? []).length).toBe(2);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
    }
  });
});

// WHY: the integration gate verifies the WHOLE merged layer (A4) — but a project-
// seeded leaf worktree holds the entire project, not just its own change. Composing
// the layer by copying those worktrees over each other (the empty-path merge) would
// let the last copy overwrite an earlier sibling's edited file with its own base copy,
// silently DROPPING a verified change before the gate ever sees it. composeMergeTree
// must instead rebuild the base once and apply each disjoint diff, so the merged tree
// carries EVERY sibling's change. The clobber is the falsifiable failure here: leaf A
// edits a file leaf B leaves at base, so a stack-the-trees merge would lose A's edit.
describe('composeMergeTree (project-seeded concurrent-layer merge)', () => {
  test('checkout: composes disjoint leaf diffs onto the base without clobbering a sibling', async () => {
    const { repo, head } = await makeCleanRepo();
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-merge-wr-'));
    const patches = await mkdtemp(join(tmpdir(), 'relay-merge-patch-'));
    try {
      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'checkout') throw new Error('expected checkout');

      // Leaf A edits a tracked file leaf B never touches; leaf B adds a new file. The
      // footprints are disjoint, which is exactly what licensed running them at once.
      const wtA = join(workRoot, 'leaf-a');
      const wtB = join(workRoot, 'leaf-b');
      await seedWorktree(wtA, plan);
      await seedWorktree(wtB, plan);
      await writeFile(join(wtA, 'existing.txt'), 'changed by A\n');
      await writeFile(join(wtB, 'fromB.txt'), 'added by B\n');

      // Persist each leaf's captured diff exactly as the orchestrator does
      // (evidence/<run>/<leafId>/diff.patch), then compose from those files.
      const patchA = join(patches, 'a.patch');
      const patchB = join(patches, 'b.patch');
      await writeFile(patchA, await captureDiff(wtA, plan.base));
      await writeFile(patchB, await captureDiff(wtB, plan.base));

      const merged = join(workRoot, 'merged');
      await composeMergeTree(merged, plan, [patchA, patchB]);

      // The merged tree carries BOTH changes: A's edit survived (not clobbered back to
      // base by B's worktree), and B's addition is present.
      expect(await readFile(join(merged, 'existing.txt'), 'utf8')).toBe('changed by A\n');
      expect(await readFile(join(merged, 'fromB.txt'), 'utf8')).toBe('added by B\n');
      // The file neither leaf touched stays at its base content.
      expect(await readFile(join(merged, 'untouched.txt'), 'utf8')).toBe('leave me alone\n');
      // The merged tree forked from the captured base (the same base every leaf used).
      expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(`HEAD ${head}`);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(patches, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('snapshot: re-seeds the project and applies each disjoint leaf diff', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'relay-merge-snap-'));
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-merge-snapwr-'));
    const patches = await mkdtemp(join(tmpdir(), 'relay-merge-snappatch-'));
    try {
      await writeFile(join(proj, 'existing.txt'), 'original content\n');
      await writeFile(join(proj, 'untouched.txt'), 'leave me alone\n');
      const plan = await resolveSeedPlan(proj);
      if (plan.mode !== 'snapshot') throw new Error('expected snapshot');

      // A snapshot leaf is the empty path over a pre-populated tree: seed, baseline,
      // edit, then capture the change against that baseline (no base ref).
      const wtA = join(workRoot, 'leaf-a');
      const wtB = join(workRoot, 'leaf-b');
      await seedWorktree(wtA, plan);
      await seedWorktree(wtB, plan);
      await establishBaseline(wtA);
      await establishBaseline(wtB);
      await writeFile(join(wtA, 'existing.txt'), 'changed by A\n');
      await writeFile(join(wtB, 'fromB.txt'), 'added by B\n');

      const patchA = join(patches, 'a.patch');
      const patchB = join(patches, 'b.patch');
      await writeFile(patchA, await captureDiff(wtA));
      await writeFile(patchB, await captureDiff(wtB));

      const merged = join(workRoot, 'merged');
      await composeMergeTree(merged, plan, [patchA, patchB]);

      // Both disjoint changes compose onto a fresh snapshot of the project.
      expect(await readFile(join(merged, 'existing.txt'), 'utf8')).toBe('changed by A\n');
      expect(await readFile(join(merged, 'fromB.txt'), 'utf8')).toBe('added by B\n');
      expect(await readFile(join(merged, 'untouched.txt'), 'utf8')).toBe('leave me alone\n');
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(patches, { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
    }
  });

  test('a child that produced no change (missing/empty patch) is skipped, not failed', async () => {
    const { repo } = await makeCleanRepo();
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-merge-wr-'));
    const patches = await mkdtemp(join(tmpdir(), 'relay-merge-patch-'));
    try {
      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'checkout') throw new Error('expected checkout');
      const wtA = join(workRoot, 'leaf-a');
      await seedWorktree(wtA, plan);
      await writeFile(join(wtA, 'existing.txt'), 'changed by A\n');

      const patchA = join(patches, 'a.patch');
      const patchEmpty = join(patches, 'empty.patch');
      const patchMissing = join(patches, 'missing.patch');
      await writeFile(patchA, await captureDiff(wtA, plan.base));
      await writeFile(patchEmpty, ''); // a leaf that changed nothing

      const merged = join(workRoot, 'merged');
      // The empty and the absent patch must both be skipped without throwing.
      await composeMergeTree(merged, plan, [patchA, patchEmpty, patchMissing]);

      expect(await readFile(join(merged, 'existing.txt'), 'utf8')).toBe('changed by A\n');
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(patches, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('snapshot seed path (dirty git workspace)', () => {
  test('snapshots the WORKING-TREE state of tracked files and captures the change', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'relay-snap-dirty-'));
    const workRoot = await mkdtemp(join(tmpdir(), 'relay-snap-wr-'));
    try {
      await git(repo, 'init', '-q');
      await git(repo, 'config', 'user.email', 'test@relay.local');
      await git(repo, 'config', 'user.name', 'Relay Test');
      await writeFile(join(repo, 'tracked.txt'), 'committed content\n');
      await git(repo, 'add', '-A');
      await git(repo, 'commit', '-q', '--no-gpg-sign', '-m', 'init');
      // Uncommitted edit to a tracked file (what makes this the snapshot, not the
      // checkout, path — a checkout off HEAD would silently drop this work).
      await writeFile(join(repo, 'tracked.txt'), 'uncommitted edit\n');
      // An untracked file: not part of the tracked-file snapshot.
      await writeFile(join(repo, 'untracked.txt'), 'not tracked\n');

      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'snapshot') throw new Error('expected snapshot');
      expect(plan.reason).toBe('dirty');

      const wt = join(workRoot, 'leaf-1');
      await seedWorktree(wt, plan);

      // The worktree mirrors the WORKING TREE (the uncommitted edit), not HEAD...
      expect(await readFile(join(wt, 'tracked.txt'), 'utf8')).toBe('uncommitted edit\n');
      // ...and untracked files are excluded (only tracked files are snapshotted).
      expect(await exists(join(wt, 'untracked.txt'))).toBe(false);

      await establishBaseline(wt);

      // The executor's change is measured against the uncommitted snapshot baseline.
      await writeFile(join(wt, 'tracked.txt'), 'executor change\n');
      const diff = await captureDiff(wt);

      expect(diff).toContain('-uncommitted edit');
      expect(diff).toContain('+executor change');
      expect((diff.match(/^diff --git/gm) ?? []).length).toBe(1);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
