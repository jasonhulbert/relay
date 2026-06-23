import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { relayRun } from './run';
import { projectKey } from './spine/index';
import type { Brain, Executor, ExecutorInput, ExecutorResult } from './spine/index';
import { readNode } from './relay-state/index';
import { agentInterviewer } from './intake/index';
import type { Interviewer, AskHuman, IntakeSeed } from './intake/index';

const execFileP = promisify(execFile);

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Relay Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@relay.local';
  process.env.GIT_COMMITTER_NAME = 'Relay Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@relay.local';
});

// The seed a bounded interview distills: a verifiable outcome, one grounded
// always-pass command verification (so the stub critic certifies the leaf
// hermetically), and a short non-binding sketch.
const SEED: IntakeSeed = {
  spec: {
    outcome: 'RESULT.txt exists at the repo root with the run marker',
    verifications: [{ kind: 'command', grounding: 'the marker file is present', check: 'true' }],
  },
  sketch: { notes: ['write a single marker file'] },
};

// A scripted interviewer that grills once, then approves the seed — the same
// intake → decompose handoff the intake tests exercise, but driven here through the
// real `relay run` composition rather than `runIntake` directly.
function scriptedIntake(): { interviewer: Interviewer; ask: AskHuman } {
  let turn = 0;
  const interviewer: Interviewer = {
    next() {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({ done: false, question: 'what does done mean for this run?' });
      }
      return Promise.resolve({ done: true, seed: SEED });
    },
  };
  const ask: AskHuman = () => Promise.resolve('a marker file named RESULT.txt at the root');
  return { interviewer, ask };
}

// A deterministic executor that makes one apply-back-ready change: it writes the
// marker into its checkout sandbox and returns the REAL git diff for it (the
// orchestrator persists `result.diff` verbatim and `git apply`s it back, so a fake
// diff string would fail apply-back). Mirrors dev-run's hermetic executor.
function markerExecutor(): Executor {
  return {
    capabilities: () => ({
      provider: 'fake',
      json: true,
      resume: false,
      sandbox: true,
      mcp: false,
    }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      await writeFile(join(worktree, 'RESULT.txt'), 'relay was here\n');
      await execFileP('git', ['-C', worktree, 'add', 'RESULT.txt']);
      const { stdout: diff } = await execFileP('git', ['-C', worktree, 'diff', '--cached']);
      return {
        diff,
        selfReport: 'wrote RESULT.txt',
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
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function cleanGitProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'relay-run-proj-'));
  await execFileP('git', ['-C', project, 'init', '-q']);
  await execFileP('git', ['-C', project, 'config', 'user.email', 'test@relay.local']);
  await execFileP('git', ['-C', project, 'config', 'user.name', 'Relay Test']);
  await writeFile(join(project, 'app.ts'), 'export const x = 1;\n');
  await execFileP('git', ['-C', project, 'add', '-A']);
  await execFileP('git', ['-C', project, 'commit', '-q', '--no-gpg-sign', '-m', 'seed']);
  return project;
}

// WHY: this is the end-to-end contract on hermetic stand-ins — the whole
// point of `relay run` (vs the `dev-run` harness) is that it does NOT pre-seed a
// leaf. It must commit the intake seed as a CHILDLESS root, let the brain author the
// first layer at ACTIVATION, drive it to done, and land the verified result back as a
// reviewable `relay/<runId>` branch (never the operator's working tree). A regression
// that smuggled children into the committed root, skipped decomposition, or dropped
// apply-back would each break a distinct assertion below.
describe('relayRun (hermetic intake → decompose → apply-back)', () => {
  test('commits a childless root, decomposes at activation, applies back on done', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await cleanGitProject();
    const relayDir = join(home, projectKey(project));
    try {
      // Observe the root AT the moment the brain is asked to decompose it. The
      // orchestrator reads the committed root, then calls the brain to author the
      // first layer; so a root that is still childless here proves intake committed a
      // childless branch and that decomposition happens at activation, not at intake.
      let rootChildrenAtDecompose: readonly string[] | undefined;
      const brain: Brain = {
        async decompose(req) {
          rootChildrenAtDecompose = (await readNode(relayDir, 'root')).children;
          return {
            decomposition: {
              children: [{ spec: req.spec, kind: 'leaf', footprint: { writeGlobs: ['**'] } }],
              seams: [],
            },
            rationale: 'one-leaf split for the hermetic relay run',
          };
        },
      };

      const { interviewer, ask } = scriptedIntake();
      const res = await relayRun({
        projectPath: project,
        home,
        interviewer,
        ask,
        executor: markerExecutor(),
        brain,
        now: () => '2026-06-21T00:00:00.000Z',
        log: () => {},
      });

      // The intake seed — not a pre-baked plan — drove the run, after exactly one
      // grilling turn.
      expect(res.seed).toEqual(SEED);
      expect(res.questionsAsked).toBe(1);

      // The committed root was a childless branch when the brain decomposed it.
      expect(rootChildrenAtDecompose).toEqual([]);

      // Decomposition happened at activation: the root now points at the brain's layer.
      const root = await readNode(relayDir, 'root');
      expect(root.kind).toBe('branch');
      expect(root.children.length).toBeGreaterThan(0);

      // The run reached done and apply-back landed the verified result as a branch in
      // the OPERATOR repo (working tree untouched), not as a fail-loud patch-only.
      expect(res.result.rootStatus).toBe('done');
      expect(res.result.applyBack.kind).toBe('branch');
      if (res.result.applyBack.kind === 'branch') {
        expect(res.result.applyBack.branch).toBe('relay/run-1');
        // The branch exists and carries the verified change...
        const files = (
          await execFileP('git', ['-C', project, 'show', '--name-only', '--format=', 'relay/run-1'])
        ).stdout;
        expect(files).toContain('RESULT.txt');
      }
      // ...while the operator's own working tree was never touched.
      expect(await fileExists(join(project, 'RESULT.txt'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

// A claude `--output-format stream-json` stdout whose final result text is `message`,
// so the REAL `agentInterviewer` parse path runs without a live model (mirrors the
// adapter/session tests). The one-shot `relay run --outcome` path drives this same
// interviewer, so testing through it exercises the actual compile path the CLI wires.
function claudeStdout(message: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }),
    JSON.stringify({
      type: 'result',
      result: message,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    }),
  ].join('\n');
}

// The one-shot interviewer the `--outcome` path constructs (`agentInterviewer({ oneShot
// })`), here with an injected runner returning `seedDoc` as its single turn — so the
// seed is COMPILED through `parseInterviewerTurn`/`compileSeed`, not handed in pre-built.
function oneShotInterviewer(seedDoc: object): Interviewer {
  return agentInterviewer({
    provider: 'claude',
    oneShot: true,
    invoke: () =>
      Promise.resolve({
        stdout: claudeStdout('```json\n' + JSON.stringify(seedDoc) + '\n```'),
        code: 0,
      }),
  });
}

// stdin is forbidden on the `--outcome` path; this `ask` records and rejects so a test
// can prove it was never called (no silent stdin read) and fail loud if it were.
function forbiddenAsk(): { ask: AskHuman; calls: () => number } {
  let calls = 0;
  const ask: AskHuman = () => {
    calls += 1;
    return Promise.reject(new Error('one-shot --outcome must not read stdin'));
  };
  return { ask, calls: () => calls };
}

// WHY: the non-interactive `relay run --outcome` path must be a real run, not
// a degenerate one. It compiles a GROUNDED seed from a single model call with NO stdin,
// then composes the SAME childless-root → decompose → apply-back as the interactive
// path. The CLI wires this as `oneShot` interviewer + `opening: outcome` +
// `maxQuestions: 0` + a stdin-forbidden `ask`; this drives that exact shape. A
// regression that read stdin, pre-seeded the root, skipped decompose, or dropped
// apply-back would each break a distinct assertion. The malformed-seed case pins the
// fail-loud-before-commit invariant: a bad seed never lands a partial root.
describe('relayRun --outcome (one-shot grounded seed → decompose → apply-back)', () => {
  // The same SEED, but as the document the one-shot interviewer emits — so the run is
  // driven by a COMPILED seed (grounded verification + sketch), identical to SEED.
  const SEED_DOC = {
    kind: 'seed',
    outcome: SEED.spec.outcome,
    verifications: SEED.spec.verifications,
    sketch: SEED.sketch,
  };

  test('compiles a grounded seed with no stdin, commits a childless root, applies back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await cleanGitProject();
    const relayDir = join(home, projectKey(project));
    try {
      let rootChildrenAtDecompose: readonly string[] | undefined;
      const brain: Brain = {
        async decompose(req) {
          rootChildrenAtDecompose = (await readNode(relayDir, 'root')).children;
          return {
            decomposition: {
              children: [{ spec: req.spec, kind: 'leaf', footprint: { writeGlobs: ['**'] } }],
              seams: [],
            },
            rationale: 'one-leaf split for the hermetic relay run',
          };
        },
      };

      const { ask, calls } = forbiddenAsk();
      const res = await relayRun({
        projectPath: project,
        home,
        // The exact shape the CLI's --outcome branch builds.
        interviewer: oneShotInterviewer(SEED_DOC),
        ask,
        opening: SEED.spec.outcome,
        maxQuestions: 0,
        executor: markerExecutor(),
        brain,
        now: () => '2026-06-21T00:00:00.000Z',
        log: () => {},
      });

      // No stdin read, zero questions — and the seed is the COMPILED, grounded one.
      expect(calls()).toBe(0);
      expect(res.questionsAsked).toBe(0);
      expect(res.seed).toEqual(SEED);
      expect(res.seed.spec.verifications[0].grounding).toBe('the marker file is present');

      // The committed root was a childless branch when the brain decomposed it...
      expect(rootChildrenAtDecompose).toEqual([]);
      // ...and decomposition happened at activation.
      const root = await readNode(relayDir, 'root');
      expect(root.kind).toBe('branch');
      expect(root.children.length).toBeGreaterThan(0);

      // The run reached done and the verified result landed as a branch (not patch-only).
      expect(res.result.rootStatus).toBe('done');
      expect(res.result.applyBack.kind).toBe('branch');
      if (res.result.applyBack.kind === 'branch') {
        expect(res.result.applyBack.branch).toBe('relay/run-1');
        const files = (
          await execFileP('git', ['-C', project, 'show', '--name-only', '--format=', 'relay/run-1'])
        ).stdout;
        expect(files).toContain('RESULT.txt');
      }
      expect(await fileExists(join(project, 'RESULT.txt'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test('a malformed one-shot seed fails loud, never committing a partial root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-home-'));
    const project = await cleanGitProject();
    const relayDir = join(home, projectKey(project));
    try {
      const { ask, calls } = forbiddenAsk();
      // A seed turn with an empty outcome — `compileSeed` rejects it inside intake,
      // which runs BEFORE the store is created, so no root can be committed.
      await expect(
        relayRun({
          projectPath: project,
          home,
          interviewer: oneShotInterviewer({
            kind: 'seed',
            outcome: '',
            verifications: [],
            sketch: { notes: [] },
          }),
          ask,
          opening: 'do the thing',
          maxQuestions: 0,
          executor: markerExecutor(),
          now: () => '2026-06-21T00:00:00.000Z',
          log: () => {},
        }),
      ).rejects.toThrow();

      // Fail-loud-before-commit: intake threw before `ensureProjectStore`, so no store
      // (and therefore no partial root) was ever written, and stdin was never read.
      expect(calls()).toBe(0);
      expect(await fileExists(join(relayDir, 'manifest.md'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});
