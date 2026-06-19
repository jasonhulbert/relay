import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isDeterministicKind, runDeterministicVerifications, runVerification } from './verify';
import type { Verification } from '../relay-state/index';

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), 'relay-verify-'));
});
afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

// WHY: the deterministic kinds are the critic's cheap ground truth (§6.3). If a
// `command`/`test` ran in the wrong directory it would grade the orchestrator's
// cwd, not the produced change — so these pin that the check sees the WORKTREE and
// that exit 0 is the only pass.
describe('command and test kinds run in the worktree and pass only on exit 0', () => {
  test('command passes on exit 0 and fails on non-zero, citing the code', async () => {
    const pass = await runVerification(
      { kind: 'command', grounding: 'exits 0', check: 'true' },
      worktree,
    );
    expect(pass.pass).toBe(true);
    expect(pass.detail).toBe('exit 0');

    const fail = await runVerification(
      { kind: 'command', grounding: 'exits 0', check: 'exit 3' },
      worktree,
    );
    expect(fail.pass).toBe(false);
    expect(fail.detail).toBe('exit 3');
  });

  test('the check runs with the worktree as cwd', async () => {
    await writeFile(join(worktree, 'marker.txt'), 'hi');
    // `test -f marker.txt` only passes if cwd is the worktree.
    const r = await runVerification(
      { kind: 'test', grounding: 'marker present', check: 'test -f marker.txt' },
      worktree,
    );
    expect(r.pass).toBe(true);
    expect(r.kind).toBe('test');
  });
});

// WHY: the artifact kind is a file/state assertion, NOT a shell command — it must
// pass purely on the produced change containing the named path, so an outcome with
// no runnable command can still be grounded.
describe('artifact kind asserts the produced change contains the named path', () => {
  test('passes when the worktree-relative artifact exists, fails when it does not', async () => {
    await writeFile(join(worktree, 'built.bin'), 'x');
    const present = await runVerification(
      { kind: 'artifact', grounding: 'build output exists', check: 'built.bin' },
      worktree,
    );
    expect(present.pass).toBe(true);
    expect(present.detail).toBe('artifact present');

    const missing = await runVerification(
      { kind: 'artifact', grounding: 'build output exists', check: 'absent.bin' },
      worktree,
    );
    expect(missing.pass).toBe(false);
    expect(missing.detail).toBe('artifact missing');
  });
});

// WHY: the critic composes the deterministic kinds cheapest-first; non-deterministic
// kinds (agent-critic) are the model stage's job, never silently passed here.
describe('runDeterministicVerifications filters to the code-checkable kinds', () => {
  test('runs command/test/artifact in spec order and skips agent-critic', async () => {
    await writeFile(join(worktree, 'a.txt'), '1');
    const verifications: Verification[] = [
      { kind: 'command', grounding: 'g', check: 'true' },
      { kind: 'agent-critic', grounding: 'g', check: 'review the diff' },
      { kind: 'artifact', grounding: 'g', check: 'a.txt' },
    ];
    const results = await runDeterministicVerifications(verifications, worktree);
    expect(results.map((r) => r.kind)).toEqual(['command', 'artifact']);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  test('isDeterministicKind classifies the §6.3 kinds', () => {
    expect(isDeterministicKind('command')).toBe(true);
    expect(isDeterministicKind('test')).toBe(true);
    expect(isDeterministicKind('artifact')).toBe(true);
    expect(isDeterministicKind('agent-critic')).toBe(false);
    expect(isDeterministicKind('visual')).toBe(false);
  });

  test('a non-deterministic kind handed to runVerification throws (never silently passes)', async () => {
    await expect(
      runVerification({ kind: 'agent-critic', grounding: 'g', check: 'x' }, worktree),
    ).rejects.toThrow(/not a deterministic kind/);
  });
});
