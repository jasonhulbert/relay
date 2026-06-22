import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { relayRun } from './run';
import { projectKey } from './spine/index';
import { STUB_USAGE } from './spine/index';
import type { Brain, Executor, ExecutorInput, ExecutorResult } from './spine/index';
import { captureDiff, establishBaseline } from './spine/adapters/worktree-diff';
import { readNode } from './relay-state/index';
import type { Interviewer, AskHuman, IntakeSeed } from './intake/index';

const execFileP = promisify(execFile);

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Relay Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@relay.local';
  process.env.GIT_COMMITTER_NAME = 'Relay Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@relay.local';
});

// A MULTI-PART outcome — the exact thing `relay run` exists to handle correctly (and
// the bug it fixes: a multi-part outcome that ran as one agent turn). The seed states
// a verifiable two-part result; the brain (below) authors the two leaves at activation.
const SEED: IntakeSeed = {
  spec: {
    outcome: 'two marker files exist, one per part, each carrying its part number',
    verifications: [{ kind: 'command', grounding: 'each part marker is present', check: 'true' }],
  },
  sketch: { notes: ['split the work into two disjoint parts'] },
};

// A scripted interviewer that grills once, then approves the multi-part seed — the
// real intake handoff, driven here through the full `relay run` composition.
function scriptedIntake(): { interviewer: Interviewer; ask: AskHuman } {
  let turn = 0;
  const interviewer: Interviewer = {
    next() {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({ done: false, question: 'how should the work split?' });
      }
      return Promise.resolve({ done: true, seed: SEED });
    },
  };
  const ask: AskHuman = () => Promise.resolve('two parts, one marker file each');
  return { interviewer, ask };
}

// A brain that decomposes the childless root into TWO disjoint leaves at activation —
// the multi-part split the single-leaf `run.test.ts` brain does not exercise. Each
// leaf owns a disjoint footprint so the two run concurrently and apply back together.
// It records the root's children AT the moment it is asked to decompose, so the test
// can prove intake committed a CHILDLESS branch (decomposition is the brain's job at
// activation, not intake's).
function twoLeafBrain(relayDir: string): {
  brain: Brain;
  decomposeCalls: () => number;
  rootChildrenAtDecompose: () => readonly string[] | undefined;
} {
  let calls = 0;
  let observed: readonly string[] | undefined;
  const brain: Brain = {
    async decompose() {
      calls += 1;
      observed = (await readNode(relayDir, 'root')).children;
      return {
        decomposition: {
          children: [1, 2].map((n) => ({
            spec: {
              outcome: `part ${n.toString()}`,
              verifications: [
                { kind: 'command' as const, grounding: 'exit 0', check: 'true' },
              ],
            },
            kind: 'leaf' as const,
            footprint: { writeGlobs: [`part-${n.toString()}/**`] },
          })),
          seams: [],
        },
        rationale: 'two disjoint leaf parts, one marker file each',
      };
    },
  };
  return {
    brain,
    decomposeCalls: () => calls,
    rootChildrenAtDecompose: () => observed,
  };
}

// Edits its sandbox like a provider adapter: it RECORDS whether its worktree was
// seeded from the operator project (the committed `app.ts` is present — the Plan 1
// checkout seed), writes a marker inside its own footprint, and returns a genuine diff
// against the per-run base (a fake diff string would fail apply-back). The recorded
// observations let the test assert every leaf ran in a project-seeded worktree.
function recordingExecutor(): {
  executor: Executor;
  runs: () => Array<{ outcome: string; worktree: string; projectSeeded: boolean }>;
} {
  const runs: Array<{ outcome: string; worktree: string; projectSeeded: boolean }> = [];
  const executor: Executor = {
    capabilities: () => ({ provider: 'fake', json: true, resume: false, sandbox: true, mcp: false }),
    async run(input: ExecutorInput): Promise<ExecutorResult> {
      // Plan 1: each leaf worktree is a real checkout of the operator project, so the
      // operator's committed code is visible to the executor. A checkout seed leaves
      // HEAD at the per-run base, so the baseline is a no-op (preseeded).
      const projectSeeded = await fileExists(join(input.worktree, 'app.ts'));
      runs.push({ outcome: input.spec.outcome, worktree: input.worktree, projectSeeded });
      await establishBaseline(input.worktree, { preseeded: input.baseRef !== undefined });
      const n = /part (\d+)/.exec(input.spec.outcome)?.[1] ?? '1';
      const rel = `part-${n}/file-${n}.txt`;
      const dest = join(input.worktree, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, `content ${n}\n`);
      const diff = await captureDiff(input.worktree, input.baseRef);
      return { diff, selfReport: `wrote ${rel}`, usage: STUB_USAGE, exitStatus: 0, writes: [rel] };
    },
  };
  return { executor, runs: () => runs };
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function cleanGitProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'relay-run-int-proj-'));
  await execFileP('git', ['-C', project, 'init', '-q']);
  await execFileP('git', ['-C', project, 'config', 'user.email', 'test@relay.local']);
  await execFileP('git', ['-C', project, 'config', 'user.name', 'Relay Test']);
  await writeFile(join(project, 'app.ts'), 'export const x = 1;\n');
  await execFileP('git', ['-C', project, 'add', '-A']);
  await execFileP('git', ['-C', project, 'commit', '-q', '--no-gpg-sign', '-m', 'seed']);
  return project;
}

// WHY: this pins the WHOLE `relay run` contract end-to-end on hermetic stand-ins, for
// the multi-part case the single-leaf tests cannot reach. `relay run` exists because a
// multi-part outcome must NOT run as one agent turn: it must commit the intake seed as
// a CHILDLESS root, let the brain author MORE THAN ONE leaf at ACTIVATION, run each
// leaf in its own project-seeded worktree (Plan 1), and land the combined verified
// result back as a reviewable `relay/<runId>` branch — never the operator's tree.
// Each assertion below guards a distinct regression: smuggling children into the
// committed root, skipping decomposition, running a leaf in an un-seeded sandbox, or
// dropping apply-back would each break exactly one of them (Rule 8).
describe('relay run (integration: multi-part intake → decompose → seeded leaves → apply-back)', () => {
  test('childless root → brain splits into >1 leaf → each in a project-seeded worktree → relay/<runId> branch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-int-home-'));
    const project = await cleanGitProject();
    const relayDir = join(home, projectKey(project));
    try {
      const { brain, decomposeCalls, rootChildrenAtDecompose } = twoLeafBrain(relayDir);
      const { executor, runs } = recordingExecutor();
      const { interviewer, ask } = scriptedIntake();

      const res = await relayRun({
        projectPath: project,
        home,
        interviewer,
        ask,
        executor,
        brain,
        runId: 'run-1',
        now: () => '2026-06-21T00:00:00.000Z',
        log: () => {},
      });

      // The intake seed — the multi-part outcome, not a pre-baked plan — drove the run,
      // after exactly one grilling turn.
      expect(res.seed).toEqual(SEED);
      expect(res.questionsAsked).toBe(1);

      // The committed root was a CHILDLESS branch when the brain was asked to split it:
      // intake committed no children, and decomposition ran at activation (once).
      expect(decomposeCalls()).toBe(1);
      expect(rootChildrenAtDecompose()).toEqual([]);

      // Decomposition authored MORE THAN ONE leaf — the multi-part split that is the
      // whole reason `relay run` exists (a regression to a single agent turn fails here).
      const root = await readNode(relayDir, 'root');
      expect(root.kind).toBe('branch');
      expect(root.children.length).toBeGreaterThan(1);

      // Every leaf executed in its OWN worktree that was seeded from the operator
      // project (Plan 1 checkout): two distinct sandboxes, each with the committed
      // `app.ts` visible. An un-seeded (empty) worktree would set projectSeeded false.
      const executions = runs();
      expect(executions.length).toBe(2);
      expect(new Set(executions.map((e) => e.worktree)).size).toBe(2);
      expect(executions.every((e) => e.projectSeeded)).toBe(true);
      expect(new Set(executions.map((e) => e.outcome))).toEqual(new Set(['part 1', 'part 2']));

      // The run reached done and apply-back landed BOTH disjoint changes as a single
      // reviewable branch in the OPERATOR repo (working tree untouched).
      expect(res.result.rootStatus).toBe('done');
      expect(res.result.applyBack.kind).toBe('branch');
      if (res.result.applyBack.kind === 'branch') {
        expect(res.result.applyBack.branch).toBe('relay/run-1');
        const files = (
          await execFileP('git', ['-C', project, 'show', '--name-only', '--format=', 'relay/run-1'])
        ).stdout;
        expect(files).toContain('part-1/file-1.txt');
        expect(files).toContain('part-2/file-2.txt');
      }

      // The operator's own working tree was never touched by either leaf.
      expect(await fileExists(join(project, 'part-1'))).toBe(false);
      expect(await fileExists(join(project, 'part-2'))).toBe(false);
      expect((await execFileP('git', ['-C', project, 'status', '--porcelain'])).stdout.trim()).toBe('');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});
