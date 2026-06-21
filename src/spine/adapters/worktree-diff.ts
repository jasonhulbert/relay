// Capturing the executor's `produced_changes` as a unified diff (design §5). A
// real provider CLI edits files in its sandbox worktree; the spine reads back the
// change with git rather than trusting the model to report its own diff. This is
// provider-agnostic on purpose: the Claude adapter (Phase 1) and the Codex
// adapter (Phase 2) both establish a baseline before dispatch and capture the
// diff after, so the critic grades the same kind of evidence regardless of who
// authored it.
//
// As of the workspace-substrate work the sandbox is no longer always an empty
// greenfield dir. When the run executes against a clean operator git repo, each
// leaf worktree is a real checkout of the project off a fixed per-run base ref, so
// the executor sees the actual code. `resolveSeedPlan`/`seedWorktree` own that
// branch; `establishBaseline` becomes a no-op on a pre-seeded checkout (its HEAD
// already IS the base); `captureDiff` diffs against the per-run base. The empty
// `git init` path stays the default for the hermetic stub runs and for non-clean
// (non-git / dirty) workspaces (the snapshot fallback is a later phase).
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// Fail loud (Rule 11): a git step that errors must not be mistaken for "no
// change". The diff is the critic's evidence, so a broken capture is a hard error.
async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.code.toString()}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}

// How a leaf's sandbox worktree is seeded for one run. `empty` is the hermetic /
// non-clean-workspace default (an empty `git init` dir, the original behavior).
// `checkout` is a real worktree of the operator project, detached at a fixed
// per-run `base`, so the executor edits against the actual code.
export type SeedPlan =
  | { mode: 'empty' }
  | { mode: 'checkout'; projectPath: string; base: string };

// All leaf worktrees in a run share the operator's single `.git` (worktree
// registration is a per-repo mutable resource). `git worktree add`/`prune` are
// code-owned, not model-driven, so we serialize them process-wide rather than
// lock the operator repo — an explicit, bounded deviation from no-shared-target,
// scoped to metadata git itself already guards.
let worktreeGitChain: Promise<unknown> = Promise.resolve();
function withWorktreeGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = worktreeGitChain.then(fn, fn);
  worktreeGitChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Decide, once at run start, how to seed this run's leaf worktrees. Gated on a
// clean operator git repo: a non-git, dirty, or commit-less (unborn HEAD)
// workspace falls back to `empty` (the snapshot fallback for those cases is a
// later phase), and an absent `projectPath` (the hermetic path) short-circuits
// with no git call at all so the stub runs stay byte-identical.
export async function resolveSeedPlan(projectPath: string | undefined): Promise<SeedPlan> {
  if (projectPath === undefined) return { mode: 'empty' };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], projectPath);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { mode: 'empty' };
  // A dirty tree would make "fork from HEAD" lose the operator's uncommitted work;
  // surface that as the snapshot/non-checkout path instead (handled next phase).
  const status = await git(['status', '--porcelain'], projectPath);
  if (status.code !== 0 || status.stdout.trim() !== '') return { mode: 'empty' };
  const head = await git(['rev-parse', 'HEAD'], projectPath);
  if (head.code !== 0) return { mode: 'empty' };
  return { mode: 'checkout', projectPath, base: head.stdout.trim() };
}

// Create the leaf's sandbox worktree per the run's seed plan. `empty` is a plain
// `mkdir` (the original behavior). `checkout` adds a detached worktree of the
// operator project at the per-run base, so the executor sees the project's files;
// `prune` first clears any stale registration a prior attempt's plain `rm` left
// (the orchestrator discards a worktree by removing the dir, not unregistering it).
export async function seedWorktree(worktree: string, plan: SeedPlan): Promise<void> {
  if (plan.mode === 'empty') {
    await mkdir(worktree, { recursive: true });
    return;
  }
  await withWorktreeGitLock(async () => {
    await mkdir(dirname(worktree), { recursive: true });
    await git(['worktree', 'prune'], plan.projectPath);
    await gitOrThrow(['worktree', 'add', '--detach', worktree, plan.base], plan.projectPath);
  });
}

// Establish a clean baseline so the post-run diff captures exactly the executor's
// produced change and nothing else. The worktree is the executor's sandbox and may
// not be a git repo yet (the orchestrator just `mkdir`'d it), so init idempotently
// and commit the current state as the baseline. The committer identity is a
// throwaway, set per-invocation so the run never depends on the machine's global
// git config (and never touches it).
//
// A pre-seeded checkout (`opts.preseeded`) already has its HEAD at the per-run
// base, and it shares the operator `.git`: re-initing would clobber that and a
// baseline commit would fold the executor's change INTO the base, leaving
// `captureDiff` empty. So skip entirely — the checkout IS the baseline.
export async function establishBaseline(
  worktree: string,
  opts: { preseeded?: boolean } = {},
): Promise<void> {
  if (opts.preseeded) return;
  await gitOrThrow(['init', '-q'], worktree);
  await gitOrThrow(['add', '-A'], worktree);
  await gitOrThrow(
    [
      '-c',
      'user.name=relay',
      '-c',
      'user.email=relay@local',
      'commit',
      '-q',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      'relay-baseline',
    ],
    worktree,
  );
}

// Capture the executor's produced change as a unified diff against the baseline:
// stage everything (so new files show as additions) and diff the index against the
// baseline. `base` is the per-run base ref on a pre-seeded checkout (HEAD may have
// moved if the executor committed, so diff against the captured base, not HEAD);
// it defaults to `HEAD` for the empty-init path (the baseline commit IS HEAD).
// Returns an empty string when the executor changed nothing — which the ladder
// reads as a non-gradeable attempt, not an error.
export async function captureDiff(worktree: string, base?: string): Promise<string> {
  await gitOrThrow(['add', '-A'], worktree);
  return gitOrThrow(
    ['-c', 'core.quotepath=false', 'diff', '--cached', base ?? 'HEAD'],
    worktree,
  );
}
