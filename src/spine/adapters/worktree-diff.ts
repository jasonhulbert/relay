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
// already IS the base); `captureDiff` diffs against the per-run base.
//
// A workspace that is NOT a clean git repo (non-git, or a dirty tree with
// uncommitted work that forking from HEAD would drop) takes the `snapshot` path:
// the operator's tracked files are copied into the worktree, then the empty-path
// machinery runs over the populated dir — `establishBaseline` inits+commits the
// snapshot as the baseline, and `captureDiff` reports the executor's change against
// it. So a snapshot leaf is just an empty leaf with a pre-populated tree; the
// adapter needs no special case (it sees no `baseRef`). The empty `git init` path
// stays the default for the hermetic stub runs (no `projectPath`).
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

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

// How a leaf's sandbox worktree is seeded for one run. `empty` is the hermetic
// default (an empty `git init` dir, the original behavior). `checkout` is a real
// worktree of the operator project, detached at a fixed per-run `base`, so the
// executor edits against the actual code. `snapshot` copies the operator's tracked
// files into the worktree when there is no clean base to fork from (a non-git dir,
// or a dirty tree whose uncommitted work a checkout would drop); the executor still
// sees the project, but the result lands as a patch rather than a branch off HEAD.
export type SeedPlan =
  | { mode: 'empty' }
  | { mode: 'checkout'; projectPath: string; base: string }
  | { mode: 'snapshot'; projectPath: string; reason: 'dirty' | 'non-git'; notice: string };

// Human-facing notice the recap surfaces (a later phase) when a run falls back to
// the snapshot path: there is no clean operator base, so the verified result is
// delivered as a patch (`result.patch`), not an in-place `relay/<runId>` branch off
// HEAD. Keyed by the same discriminant `resolveSeedPlan` records on the plan.
export const SNAPSHOT_NOTICE: Record<'dirty' | 'non-git', string> = {
  dirty:
    'workspace has uncommitted changes; the verified result is delivered as a patch (result.patch), not a branch off HEAD',
  'non-git':
    'workspace is not a git repository; the verified result is delivered as a patch (result.patch), not a branch off HEAD',
};

// Standard excludes for the non-git snapshot walk: VCS metadata, Relay's own state,
// and dependency caches, matched at any depth. The dirty (git) path needs no such
// list — `git ls-files` already yields only tracked files, honoring `.gitignore`.
const SNAPSHOT_EXCLUDE = new Set(['.git', '.relay', 'node_modules']);

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

// Decide, once at run start, how to seed this run's leaf worktrees. An absent
// `projectPath` (the hermetic path) short-circuits with no git call at all so the
// stub runs stay byte-identical. With a project: a clean git repo forks each leaf
// from HEAD (`checkout`); a non-git dir or a dirty tree (uncommitted work a
// checkout would drop) takes the file `snapshot` path; only a commit-less but
// otherwise clean repo (unborn HEAD, nothing to copy) still falls back to `empty`.
export async function resolveSeedPlan(projectPath: string | undefined): Promise<SeedPlan> {
  if (projectPath === undefined) return { mode: 'empty' };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], projectPath);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    // Not a git repo at all: snapshot its files so Relay still runs "in any workspace".
    return { mode: 'snapshot', projectPath, reason: 'non-git', notice: SNAPSHOT_NOTICE['non-git'] };
  }
  // A dirty tree would make "fork from HEAD" lose the operator's uncommitted work;
  // snapshot the working tree instead so the executor sees that uncommitted state.
  const status = await git(['status', '--porcelain'], projectPath);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return { mode: 'snapshot', projectPath, reason: 'dirty', notice: SNAPSHOT_NOTICE.dirty };
  }
  const head = await git(['rev-parse', 'HEAD'], projectPath);
  // Clean repo with no commit yet (unborn HEAD): no base to fork from and a clean
  // tree means nothing to snapshot, so the empty path is exactly right.
  if (head.code !== 0) return { mode: 'empty' };
  return { mode: 'checkout', projectPath, base: head.stdout.trim() };
}

// Create the leaf's sandbox worktree per the run's seed plan. `empty` is a plain
// `mkdir` (the original behavior). `checkout` adds a detached worktree of the
// operator project at the per-run base, so the executor sees the project's files;
// `prune` first clears any stale registration a prior attempt's plain `rm` left
// (the orchestrator discards a worktree by removing the dir, not unregistering it).
// `snapshot` copies the operator's tracked files into a plain dir (see below).
export async function seedWorktree(worktree: string, plan: SeedPlan): Promise<void> {
  if (plan.mode === 'empty') {
    await mkdir(worktree, { recursive: true });
    return;
  }
  if (plan.mode === 'snapshot') {
    await seedSnapshot(worktree, plan);
    return;
  }
  await withWorktreeGitLock(async () => {
    await mkdir(dirname(worktree), { recursive: true });
    await git(['worktree', 'prune'], plan.projectPath);
    await gitOrThrow(['worktree', 'add', '--detach', worktree, plan.base], plan.projectPath);
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Seed a leaf by COPYING the operator's files into a plain dir (not a git worktree
// off the shared `.git`, so it needs no worktree lock). The empty-path machinery
// then runs over the populated tree: `establishBaseline` inits+commits the snapshot
// as the baseline and `captureDiff` reports the executor's change against it.
//
// Dirty git repo: copy the WORKING-TREE state of every tracked file (`git ls-files`
// lists the index; we read each path off disk so the executor sees the operator's
// uncommitted edits — the very work a checkout off HEAD would have dropped). A
// tracked file deleted in the working tree is intentionally skipped, so the
// snapshot mirrors the working tree, not the index.
//
// Non-git dir: there is no index to consult, so copy the tree, skipping the
// standard excludes at any depth. Honoring `.gitignore` beyond those names is not
// feasible without a repo; the excludes cover the common heavy/irrelevant dirs.
async function seedSnapshot(
  worktree: string,
  plan: Extract<SeedPlan, { mode: 'snapshot' }>,
): Promise<void> {
  await mkdir(worktree, { recursive: true });
  if (plan.reason === 'non-git') {
    await cp(plan.projectPath, worktree, {
      recursive: true,
      filter: (src) => {
        const rel = relative(plan.projectPath, src);
        if (rel === '') return true;
        return !rel.split(sep).some((seg) => SNAPSHOT_EXCLUDE.has(seg));
      },
    });
    return;
  }
  const listed = await gitOrThrow(['ls-files', '-z'], plan.projectPath);
  const files = listed.split('\0').filter((f) => f !== '');
  for (const rel of files) {
    const src = join(plan.projectPath, rel);
    // Skip a tracked-but-deleted file (dirty working tree) rather than failing —
    // mirroring the working tree is intentional here, not a swallowed error.
    if (!(await pathExists(src))) continue;
    const dest = join(worktree, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
  }
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
// Returns an empty string when the executor changed nothing — NOT an auto-failed
// attempt: the critic gates an empty diff against the spec like any other (the
// outcome may already be satisfied), so this is gradeable evidence, never an error.
export async function captureDiff(worktree: string, base?: string): Promise<string> {
  await gitOrThrow(['add', '-A'], worktree);
  return gitOrThrow(
    ['-c', 'core.quotepath=false', 'diff', '--cached', base ?? 'HEAD'],
    worktree,
  );
}

// Compose a concurrent layer's per-child diffs onto ONE fresh base tree — the
// integration gate's merged worktree (§3.8, A4) for a PROJECT-SEEDED run. On the
// checkout/snapshot paths each leaf worktree holds the WHOLE project, so the empty
// path's "copy every child worktree into one dir" would stack full trees and let the
// last copy clobber an earlier sibling's edit to a shared base file. Instead rebuild
// the run's base ONCE and `git apply` each footprint-disjoint child patch onto it:
//   - checkout: re-add a detached worktree at the per-run base (the same base every
//     leaf forked from), so applying the disjoint diffs reproduces the merged whole.
//   - snapshot: re-copy the project and `establishBaseline` so `git apply` has a repo
//     with a clean tree, mirroring how a snapshot leaf is built.
// `patchFiles` are the persisted `evidence/<run>/<leafId>/diff.patch` paths, so a
// rehydrated re-gate rebuilds an identical tree from disk. A missing or empty patch is
// skipped (a child that produced no change contributes nothing); a present patch that
// fails to apply is a HARD error (Rule 11) — a clash the disjoint-footprint law was
// meant to prevent must surface loudly, never be silently swallowed.
export async function composeMergeTree(
  mergedDir: string,
  plan: Extract<SeedPlan, { mode: 'checkout' | 'snapshot' }>,
  patchFiles: readonly string[],
): Promise<void> {
  await seedWorktree(mergedDir, plan);
  if (plan.mode === 'snapshot') {
    await establishBaseline(mergedDir);
  }
  for (const file of patchFiles) {
    if (!(await pathExists(file))) continue;
    const patch = await readFile(file, 'utf8');
    if (patch.trim() === '') continue;
    await gitOrThrow(['apply', '--whitespace=nowarn', file], mergedDir);
  }
}

// The outcome of landing a run's verified `result.patch` back into the operator
// repo (workspace-substrate §6). `branch` is the success path: a reviewable
// `relay/<runId>` branch off the per-run base now exists, working tree untouched.
// `patch-only` is the fail-loud path — there was no clean operator base to fork from
// (a dirty or non-git workspace) or the patch did not apply (`conflict`), so NO
// branch was created; the caller surfaces the `notice` + `patchPath` and exits
// non-zero. `none` means there was nothing to land (the hermetic/empty path).
export type ApplyBackOutcome =
  | { kind: 'none' }
  | { kind: 'branch'; branch: string; base: string; patchPath: string }
  | {
      kind: 'patch-only';
      reason: 'dirty' | 'non-git' | 'conflict';
      notice: string;
      patchPath: string;
    };

// Land the verified `result.patch` as a reviewable `relay/<runId>` branch in the
// operator repo WITHOUT touching its working tree or HEAD (workspace-substrate §6).
// Only the `checkout` path can produce a branch: it has a committed operator base the
// branch forks from, and `result.patch` is already a diff against exactly that base.
// The `snapshot` paths (dirty / non-git) have no such base, so the result stays a
// patch and the caller fails loud (the plan's "patch, not a branch off HEAD" case).
//
// The branch is built in a THROWAWAY detached worktree off `base` (under the run's
// scratch area, never the operator tree): apply the patch, commit it as one commit,
// point `relay/<runId>` at that commit, then remove the worktree — so only
// `.git/worktrees/` metadata and the new branch ref ever change. The commit identity
// is a throwaway set per-invocation, so the run never reads or writes the machine's
// git config (mirroring `establishBaseline`). A patch that fails to apply onto its own
// base is reported as a `conflict` (fail loud, non-zero exit) rather than thrown, so
// the recap can still surface the persisted `result.patch` and manual apply steps.
export async function applyBackBranch(
  plan: SeedPlan,
  runId: string,
  patchPath: string,
  scratchDir: string,
): Promise<ApplyBackOutcome> {
  if (plan.mode === 'empty') return { kind: 'none' };
  if (plan.mode === 'snapshot') {
    return { kind: 'patch-only', reason: plan.reason, notice: plan.notice, patchPath };
  }
  const branch = `relay/${runId}`;
  return withWorktreeGitLock(async () => {
    await rm(scratchDir, { recursive: true, force: true });
    await mkdir(dirname(scratchDir), { recursive: true });
    await git(['worktree', 'prune'], plan.projectPath);
    await gitOrThrow(['worktree', 'add', '--detach', scratchDir, plan.base], plan.projectPath);
    try {
      const patch = await readFile(patchPath, 'utf8');
      if (patch.trim() !== '') {
        const applied = await git(['apply', '--whitespace=nowarn', patchPath], scratchDir);
        if (applied.code !== 0) {
          return {
            kind: 'patch-only',
            reason: 'conflict',
            notice: `result.patch did not apply onto base ${plan.base}: ${applied.stderr.trim()}`,
            patchPath,
          };
        }
      }
      await gitOrThrow(['add', '-A'], scratchDir);
      // `--allow-empty`: an outcome already satisfied yields an empty `result.patch`;
      // the branch still records "this run produced no change" off the same base.
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
          `relay run ${runId}`,
        ],
        scratchDir,
      );
      const head = (await gitOrThrow(['rev-parse', 'HEAD'], scratchDir)).trim();
      // `-f`: re-running the same `runId` re-points the branch idempotently rather
      // than hard-failing on an existing ref.
      await gitOrThrow(['branch', '-f', branch, head], plan.projectPath);
      return { kind: 'branch', branch, base: plan.base, patchPath };
    } finally {
      // Remove our throwaway worktree so registrations do not accumulate in the
      // operator `.git/worktrees/`. Best-effort: a failure here must not mask the
      // outcome already computed above.
      await git(['worktree', 'remove', '--force', scratchDir], plan.projectPath);
      await git(['worktree', 'prune'], plan.projectPath);
    }
  });
}
