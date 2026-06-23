// The deterministic verification kinds, cheapest-first. Each is a CODE-checkable
// predicate the critic runs against the executor's produced change — never a model
// judgment (Rule 5; an uncheckable seam forces serialization, so code answers, not
// a model). They are the cheap grounding the independent agent critic stands on: a
// declared check that fails is ground truth the verdict cannot argue past.
//
// Three kinds land here (the ladder's first three):
//   - `command` (exit 0)   → run the check; pass iff it exits 0;
//   - `test`               → same mechanism, a test command; pass iff it exits 0;
//   - `artifact`           → a file/state assertion: the named path exists in the
//                            produced change.
// `structural`/`visual` are later steps; `agent-critic` is the model stage in
// agent-critic.ts; `human` is the decision-inbox gate.
//
// Every check runs in the leaf's worktree — the produced change — so a `command`
// like `npm test` or an `artifact` path is asserted against what the executor
// actually built, not the orchestrator's cwd.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Verification } from '../relay-state/index';

// The kinds this module evaluates deterministically. The remaining `VerificationKind`
// values are settled elsewhere (agent-critic) or in a later step.
const DETERMINISTIC_KINDS = new Set<Verification['kind']>(['command', 'test', 'artifact']);

export function isDeterministicKind(kind: Verification['kind']): boolean {
  return DETERMINISTIC_KINDS.has(kind);
}

export interface VerificationResult {
  kind: Verification['kind'];
  check: string;
  grounding: string;
  pass: boolean;
  // The concrete evidence the predicate observed — an exit code or a file fact —
  // so a verdict can cite it (a verdict citing no evidence is rejected).
  detail: string;
}

function runShell(check: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // `.relay/` is the orchestrator's; the worktree is the sandbox the produced
    // change lives in, so the check runs there (a `command`/`test` sees the files).
    const child = spawn('/bin/sh', ['-c', check], { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Evaluate ONE declared verification against the produced-change worktree. A kind
// this module does not own (e.g. `agent-critic`) is not its job — the caller
// filters with `isDeterministicKind` first, so reaching one here is a programming
// error and throws loud (Rule 11) rather than silently passing.
export async function runVerification(
  v: Verification,
  worktree: string,
): Promise<VerificationResult> {
  const base = { kind: v.kind, check: v.check, grounding: v.grounding };
  if (v.kind === 'command' || v.kind === 'test') {
    const code = await runShell(v.check, worktree);
    return { ...base, pass: code === 0, detail: `exit ${code.toString()}` };
  }
  if (v.kind === 'artifact') {
    // A file/state assertion: the produced change must contain the named artifact.
    // The check is a worktree-relative path (an absolute path is honored as-is).
    const target = isAbsolute(v.check) ? v.check : join(worktree, v.check);
    const exists = await fileExists(target);
    return { ...base, pass: exists, detail: exists ? 'artifact present' : 'artifact missing' };
  }
  throw new Error(`runVerification: \`${v.kind}\` is not a deterministic kind`);
}

// Run every declared deterministic verification against the worktree, in spec
// order (cheapest-first is the order the spec lists them). Non-deterministic kinds
// are skipped here — the agent-critic stage handles `agent-critic`. Returns the
// per-check results so the critic can short-circuit on a failure and cite the
// evidence in its verdict.
export async function runDeterministicVerifications(
  verifications: readonly Verification[],
  worktree: string,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const v of verifications) {
    if (!isDeterministicKind(v.kind)) continue;
    results.push(await runVerification(v, worktree));
  }
  return results;
}
