import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { devRun } from './dev-run';
import { agentCritic } from './agent-critic';
import { projectKey } from './relay-home';
import { readNode } from '../relay-state/index';
import type { Executor, ExecutorInput, ExecutorResult, ExecutorUsage } from './executor';

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

// WHY: this is the operator-visibility contract end-to-end on a hermetic executor — a real run
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

      // Usage captured for the recap (node attribution is not yet built).
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

  // WHY: the executor sandbox must be seeded from (and the verified result landed
  // back into) the operator's real project, so the orchestrator and its executor
  // have to know which project that is. devRun is the only place that resolves the
  // store, so it must forward the resolved projectPath through RunOptions all the
  // way to the executor's ExecutorInput — observed here by capturing the input. A
  // regression that dropped the field would silently fall back to the empty-worktree
  // path on a real run.
  test('forwards the resolved projectPath through RunOptions into ExecutorInput', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-'));
    try {
      let capturedProjectPath: string | undefined;
      const capturingExecutor: Executor = {
        capabilities: () => ({
          provider: 'fake',
          json: true,
          resume: false,
          sandbox: true,
          mcp: false,
        }),
        async run(input: ExecutorInput): Promise<ExecutorResult> {
          capturedProjectPath = input.projectPath;
          await mkdir(input.worktree, { recursive: true });
          await writeFile(join(input.worktree, 'CHANGE.txt'), 'fake change\n');
          return {
            diff: FAKE_DIFF,
            selfReport: 'fake self-report',
            usage: {
              provider: 'fake',
              model: 'fake-cheap',
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              wallClockMs: 1,
              costUsd: 0,
            },
            exitStatus: 0,
          };
        },
      };

      await devRun({
        projectPath: project,
        outcome: 'create CHANGE.txt',
        home,
        executor: capturingExecutor,
        now: () => '2026-03-03T00:00:00.000Z',
        log: () => {},
      });

      expect(capturedProjectPath).toBe(resolve(project));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  // WHY: the whole point of the substrate is that a real run executes against the
  // operator's actual project, not an empty greenfield dir. So when projectPath is a
  // clean git repo, the orchestrator must seed each leaf worktree as a checkout of
  // it and tell the executor the base it forked from (baseRef). Observed here by
  // capturing the input and reading the seeded worktree. A regression that left the
  // worktree empty would silently turn a real run back into greenfield.
  test('seeds the leaf worktree as a project checkout for a clean git workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-git-'));
    try {
      // Make the operator project a clean git repo with a committed tracked file.
      await execFileP('git', ['-C', project, 'init', '-q'], {});
      await execFileP('git', ['-C', project, 'config', 'user.email', 'test@relay.local'], {});
      await execFileP('git', ['-C', project, 'config', 'user.name', 'Relay Test'], {});
      await writeFile(join(project, 'app.ts'), 'export const x = 1;\n');
      await execFileP('git', ['-C', project, 'add', '-A'], {});
      await execFileP('git', ['-C', project, 'commit', '-q', '--no-gpg-sign', '-m', 'seed'], {});
      const head = (await execFileP('git', ['-C', project, 'rev-parse', 'HEAD'], {})).stdout.trim();

      let capturedBaseRef: string | undefined;
      let sawProjectFile = false;
      const checkoutAwareExecutor: Executor = {
        capabilities: () => ({
          provider: 'fake',
          json: true,
          resume: false,
          sandbox: true,
          mcp: false,
        }),
        async run(input: ExecutorInput): Promise<ExecutorResult> {
          capturedBaseRef = input.baseRef;
          // The executor was handed a real checkout: the project's tracked file is
          // present in its sandbox.
          sawProjectFile = await readFile(join(input.worktree, 'app.ts'), 'utf8')
            .then((c) => c === 'export const x = 1;\n')
            .catch(() => false);
          await writeFile(join(input.worktree, 'app.ts'), 'export const x = 2;\n');
          return {
            diff: 'M app.ts',
            selfReport: 'edited app.ts',
            usage: {
              provider: 'fake',
              model: 'fake-cheap',
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              wallClockMs: 1,
              costUsd: 0,
            },
            exitStatus: 0,
          };
        },
      };

      const res = await devRun({
        projectPath: project,
        outcome: 'bump x to 2',
        home,
        executor: checkoutAwareExecutor,
        now: () => '2026-03-03T00:00:00.000Z',
        log: () => {},
      });

      // The orchestrator forked the worktree from the operator's HEAD and told the
      // executor which base, and the executor saw the real project file.
      expect(capturedBaseRef).toBe(head);
      expect(sawProjectFile).toBe(true);
      expect(res.result.rootStatus).toBe('done');

      // The operator's own working tree was untouched (the edit landed in the
      // sandbox worktree, not the project repo).
      expect(await readFile(join(project, 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  // WHY: the independent critic must be cross-provider by default.
  // With a Claude author the harness must select a Codex critic and surface it in
  // the recap, so an operator can see who graded done-ness. The real agentCritic is
  // driven with a faked model invoke so the assertion stays hermetic.
  test('selects the not-the-author provider for the critic and recaps its verdict', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-proj-'));
    try {
      const usages: ExecutorUsage[] = [];
      const res = await devRun({
        projectPath: project,
        outcome: 'create CHANGE.txt',
        home,
        // Author Claude → critic defaults to Codex (the other provider).
        provider: 'claude',
        executor: fakeExecutor('fake-cheap'),
        critic: agentCritic({
          provider: 'codex',
          invoke: () =>
            Promise.resolve({
              stdout: [
                JSON.stringify({
                  type: 'item.completed',
                  item: { type: 'agent_message', text: 'graded on the diff\nVERDICT: PASS' },
                }),
                JSON.stringify({
                  type: 'turn.completed',
                  usage: { input_tokens: 4, output_tokens: 2 },
                }),
              ].join('\n'),
              code: 0,
            }),
          onUsage: (u) => usages.push(u),
        }),
        now: () => '2026-03-03T00:00:00.000Z',
        log: () => {},
      });

      // The harness resolved the cross-provider critic and it certified the leaf.
      expect(res.criticProvider).toBe('codex');
      expect(res.result.leafStatuses['leaf-1']).toBe('done');
      const leaf = await readNode(res.storeDir, 'leaf-1');
      expect(leaf.verdict?.provider).toBe('codex');
      // The recap surfaces who graded done-ness (a different provider than the author).
      expect(res.recap).toContain('critic [codex] -> PASS');
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
      // `usages` is node-attributed (not dispatch-ordered), so query by role.
      const exec = res.usages.find((u) => u.role === 'executor');
      expect(exec?.model).toBe('claude-haiku-4-5');

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
