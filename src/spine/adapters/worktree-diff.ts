// Capturing the executor's `produced_changes` as a unified diff (design §5). A
// real provider CLI edits files in its sandbox worktree; the spine reads back the
// change with git rather than trusting the model to report its own diff. This is
// provider-agnostic on purpose: the Claude adapter (Phase 1) and the Codex
// adapter (Phase 2) both establish a baseline before dispatch and capture the
// diff after, so the critic grades the same kind of evidence regardless of who
// authored it.
import { spawn } from 'node:child_process';

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

// Establish a clean baseline so the post-run diff captures exactly the executor's
// produced change and nothing else. The worktree is the executor's sandbox and may
// not be a git repo yet (the orchestrator just `mkdir`'d it), so init idempotently
// and commit the current state as the baseline. The committer identity is a
// throwaway, set per-invocation so the run never depends on the machine's global
// git config (and never touches it).
export async function establishBaseline(worktree: string): Promise<void> {
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
// baseline commit. Returns an empty string when the executor changed nothing —
// which the ladder reads as a non-gradeable attempt, not an error.
export async function captureDiff(worktree: string): Promise<string> {
  await gitOrThrow(['add', '-A'], worktree);
  return gitOrThrow(['-c', 'core.quotepath=false', 'diff', '--cached', 'HEAD'], worktree);
}
