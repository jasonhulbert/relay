import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { devRun } from './dev-run';
import { projectKey } from './relay-home';
import type { Executor, ExecutorInput, ExecutorResult } from './executor';

const execFileP = promisify(execFile);

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Relay Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@relay.local';
  process.env.GIT_COMMITTER_NAME = 'Relay Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@relay.local';
});

// A deterministic stand-in for a real provider: makes one gradeable change and
// reports a distinguishable usage record, so the harness can be exercised end-to-
// end (resolve store → seed → run → commit → recap) without the CLI.
const FAKE_DIFF = 'A CHANGE.txt\n+fake change';
function fakeExecutor(model: string): Executor {
  return {
    capabilities: () => ({
      provider: 'fake',
      json: true,
      resume: false,
      sandbox: true,
      mcp: false,
    }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'CHANGE.txt'), 'fake change\n');
      return {
        diff: FAKE_DIFF,
        selfReport: 'fake self-report',
        usage: {
          provider: 'fake',
          model,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          wallClockMs: 1,
          costUsd: 0.001,
        },
        exitStatus: 0,
      };
    },
  };
}

async function gitLogLines(storeDir: string): Promise<string[]> {
  const { stdout } = await execFileP('git', ['-C', storeDir, 'log', '--oneline'], {});
  return stdout.trim().split('\n').filter(Boolean);
}

// WHY: this is the Phase 2 contract end-to-end on a hermetic executor — a real run
// must leave an inspectable, git-log-able store at the SAME resolved path across
// runs, capture per-call usage, and emit a recap that actually points at the
// persisted evidence. A harness that printed a recap whose pointers missed the
// files, or that resolved a fresh path each run, would defeat operator visibility.
describe('devRun (hermetic executor)', () => {
  test('persists a git-log-able store, captures usage, and recaps the evidence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-'));
    const out: string[] = [];
    try {
      const res = await devRun({
        projectPath: project,
        outcome: 'create CHANGE.txt',
        home,
        executor: fakeExecutor('fake-cheap'),
        now: () => '2026-03-03T00:00:00.000Z',
        log: (line) => out.push(line),
      });

      // Resolved to the keyed global store, and reached done.
      expect(res.storeDir).toBe(join(home, projectKey(project)));
      expect(res.result.rootStatus).toBe('done');
      expect(res.result.leafStatuses['leaf-1']).toBe('done');

      // Usage captured for the recap (node attribution is Phase 6).
      expect(res.usages).toHaveLength(1);
      expect(res.usages[0]?.model).toBe('fake-cheap');

      // The store is git-log-able: the run committed exactly one recorded commit.
      expect(res.committed).toBe(true);
      expect((await gitLogLines(res.storeDir)).length).toBeGreaterThan(0);

      // The recap names the store path and the run's evidence files, and a reader
      // following the pointer reaches the real diff + self-report.
      const recap = res.recap;
      expect(recap).toContain(res.storeDir);
      expect(recap).toContain('leaf-1 [leaf] -> done');
      expect(recap).toContain('leaf-1/diff.patch');
      expect(recap).toContain('leaf-1/self-report.md');
      expect(recap).toContain('leaf-1/verdict.md');
      expect(recap).toContain('model=fake-cheap');
      // The recap was actually written to the sink.
      expect(out.join('\n')).toBe(recap);

      // Following the diff pointer reaches the produced change.
      const diff = await readFile(
        join(res.storeDir, 'evidence', res.runId, 'leaf-1', 'diff.patch'),
        'utf8',
      );
      expect(diff).toBe(FAKE_DIFF);

      // Re-running the same project resolves to the SAME store path.
      const again = await devRun({
        projectPath: project,
        outcome: 'create CHANGE.txt',
        home,
        executor: fakeExecutor('fake-cheap'),
        now: () => '2026-03-04T00:00:00.000Z',
        log: () => {},
      });
      expect(again.storeDir).toBe(res.storeDir);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

// Gated real-CLI test (the phase's headline validation): a real run leaves a
// populated, git-log-able store at ~/.relay/<key>, on Claude's cheapest model by
// default, and the recap points at the real evidence. Opt-in via RELAY_E2E=1; it
// hits the network and costs money.
describe.skipIf(!process.env.RELAY_E2E)('devRun end-to-end (real CLI)', () => {
  test('real run: git-log-able store, claude-haiku-4-5 by default, recap → real diff', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-e2e-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-e2e-'));
    try {
      const res = await devRun({
        projectPath: project,
        outcome: 'Create a file named hello.txt containing exactly the text: hi from relay',
        home,
        log: () => {},
      });

      // Store resolved to the keyed global path and survives the process.
      expect(res.storeDir).toBe(join(home, projectKey(project)));
      expect(res.result.rootStatus).toBe('done');

      // git-log-able.
      expect((await gitLogLines(res.storeDir)).length).toBeGreaterThan(0);

      // Cheapest model by default (the cost guardrail), as reported by the stream.
      expect(res.usages[0]?.model).toBe('claude-haiku-4-5');

      // Following the recap's pointer reaches the real diff + self-report.
      const diff = await readFile(
        join(res.storeDir, 'evidence', res.runId, 'leaf-1', 'diff.patch'),
        'utf8',
      );
      expect(diff).toContain('hello.txt');
      const selfReport = await readFile(
        join(res.storeDir, 'evidence', res.runId, 'leaf-1', 'self-report.md'),
        'utf8',
      );
      expect(selfReport.length).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);
});
