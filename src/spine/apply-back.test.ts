import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import { devRun } from './dev-run';
import { STUB_USAGE, stubCapabilities } from './executor';
import {
  applyBackBranch,
  captureDiff,
  establishBaseline,
  resolveSeedPlan,
} from './adapters/worktree-diff';
import type { Executor, ExecutorInput, ExecutorResult } from './executor';
import type { Brain } from './brain';
import { writeManifest, writeNode } from '../relay-state/index';
import type { Footprint, NodeRecord, RootManifest } from '../relay-state/index';

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

// A clean operator repo with one committed tracked file → the `checkout` seed path.
async function makeCleanRepo(): Promise<{ repo: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'relay-applyback-repo-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@relay.local');
  await git(repo, 'config', 'user.name', 'Relay Test');
  await writeFile(join(repo, 'existing.txt'), 'original content\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--no-gpg-sign', '-m', 'seed');
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
  return { repo, head };
}

async function seedChildlessBranch(relayDir: string): Promise<void> {
  const spec = {
    outcome: 'compose the layer',
    verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
  };
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec,
    sketch: { notes: [] },
    createdAt: '2026-06-20T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);
  const root: NodeRecord = {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec,
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  await writeNode(relayDir, root);
}

function leavesWithFootprints(footprints: Footprint[]): Brain {
  return {
    decompose: () =>
      Promise.resolve({
        children: footprints.map((footprint, i) => ({
          spec: {
            outcome: `part ${(i + 1).toString()}`,
            verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
          },
          kind: 'leaf' as const,
          footprint,
        })),
        seams: [],
      }),
  };
}

// Edits its sandbox like a provider adapter: establish the baseline (a no-op on a
// pre-seeded checkout, an init+commit on a copied snapshot — exactly what the real
// adapters do around the CLI), write a new file inside its footprint, then capture a
// genuine diff against the per-run base. Works on BOTH the checkout and snapshot seed
// paths, so it drives the dirty/snapshot apply-back case too.
function projectEditingExecutor(): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run(input: ExecutorInput): Promise<ExecutorResult> {
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
}

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-applyback-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

// WHY: apply-back is the substrate's whole payoff — a verified run must land back as a
// REVIEWABLE branch the operator can inspect and merge, WITHOUT ever mutating their
// working tree or HEAD (a silent in-place write is the exact failure mode the design
// forbids). And when there is no clean base to branch from (dirty / non-git) or the
// patch will not apply, it must fail LOUD with the patch path, never auto-apply and
// never silently swallow the result. These tests pin both halves.
describe('apply-back — verified result lands as a reviewable relay/<runId> branch', () => {
  test('clean repo: creates relay/run-1 with the change as one commit; working tree untouched', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo, head } = await makeCleanRepo();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }]),
        executor: projectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });
      expect(res.rootStatus).toBe('done');

      // The result outcome the CLI renders/exits on.
      expect(res.applyBack).toEqual({
        kind: 'branch',
        branch: 'relay/run-1',
        base: head,
        patchPath: join(relayDir, 'evidence', 'run-1', 'result.patch'),
      });

      // The branch exists in the OPERATOR repo, forked from the captured base, with the
      // verified change as exactly one commit on top.
      expect((await git(repo, 'branch', '--list', 'relay/run-1')).trim()).not.toBe('');
      expect((await git(repo, 'rev-parse', 'relay/run-1^')).trim()).toBe(head);
      expect((await git(repo, 'show', 'relay/run-1:part-1/file-1.txt')).trim()).toBe('content 1');

      // The operator's own working tree and HEAD were NEVER touched.
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
      expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(head);
      expect(await exists(join(repo, 'part-1'))).toBe(false);

      // The throwaway build worktree was cleaned up (no registration accumulation).
      const wtList = await git(repo, 'worktree', 'list');
      expect(wtList).not.toContain('__applyback');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('concurrent multi-leaf clean repo: relay/run-1 carries both disjoint changes', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo, head } = await makeCleanRepo();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }, { writeGlobs: ['part-2/**'] }]),
        executor: projectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });
      expect(res.rootStatus).toBe('done');
      expect(res.applyBack.kind).toBe('branch');

      expect((await git(repo, 'rev-parse', 'relay/run-1^')).trim()).toBe(head);
      expect((await git(repo, 'show', 'relay/run-1:part-1/file-1.txt')).trim()).toBe('content 1');
      expect((await git(repo, 'show', 'relay/run-1:part-2/file-2.txt')).trim()).toBe('content 2');
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('dirty repo: NO branch, patch-only(dirty), result.patch still persisted', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      // An uncommitted edit makes the tree dirty → snapshot seed path (no clean base).
      await writeFile(join(repo, 'existing.txt'), 'locally edited\n');

      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }]),
        executor: projectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });
      expect(res.rootStatus).toBe('done');

      expect(res.applyBack.kind).toBe('patch-only');
      if (res.applyBack.kind === 'patch-only') {
        expect(res.applyBack.reason).toBe('dirty');
        expect(res.applyBack.patchPath).toBe(join(relayDir, 'evidence', 'run-1', 'result.patch'));
      }
      // The verified work is NOT lost — the patch is persisted...
      expect(await exists(join(relayDir, 'evidence', 'run-1', 'result.patch'))).toBe(true);
      // ...but NO branch was auto-created in the operator repo.
      expect((await git(repo, 'branch', '--list', 'relay/*')).trim()).toBe('');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('non-git workspace via devRun: recap names result.patch + NOT APPLIED, no branch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'relay-applyback-home-'));
    const project = await mkdtemp(join(tmpdir(), 'relay-applyback-nongit-'));
    try {
      const fakeExecutor: Executor = {
        capabilities: () => stubCapabilities,
        async run({ worktree, baseRef }: ExecutorInput): Promise<ExecutorResult> {
          await establishBaseline(worktree, { preseeded: baseRef !== undefined });
          await writeFile(join(worktree, 'NEW.txt'), 'new\n');
          const diff = await captureDiff(worktree, baseRef);
          return { diff, selfReport: 'wrote NEW.txt', usage: STUB_USAGE, exitStatus: 0 };
        },
      };
      const res = await devRun({
        projectPath: project,
        outcome: 'create NEW.txt',
        home,
        executor: fakeExecutor,
        now: () => '2026-03-03T00:00:00.000Z',
        log: () => {},
      });

      expect(res.result.rootStatus).toBe('done');
      expect(res.result.applyBack.kind).toBe('patch-only');
      if (res.result.applyBack.kind === 'patch-only') {
        expect(res.result.applyBack.reason).toBe('non-git');
        // The recap surfaces the loud reason AND the exact patch path (fail loud).
        expect(res.recap).toContain('NOT APPLIED (non-git)');
        expect(res.recap).toContain(res.result.applyBack.patchPath);
        expect(res.recap).toContain('apply manually');
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test('patch that does not apply onto its base → patch-only(conflict), no branch', async () => {
    const { base } = await freshRelay();
    const { repo, head } = await makeCleanRepo();
    try {
      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'checkout') throw new Error('expected checkout plan');
      // A non-patch payload cannot apply — the fail-loud conflict path (Rule 11).
      const patchPath = join(base, 'garbage.patch');
      await writeFile(patchPath, 'this is not a valid unified diff\n');

      const outcome = await applyBackBranch(
        plan,
        'run-x',
        patchPath,
        join(base, 'applyback-scratch'),
      );

      expect(outcome.kind).toBe('patch-only');
      if (outcome.kind === 'patch-only') {
        expect(outcome.reason).toBe('conflict');
        expect(outcome.patchPath).toBe(patchPath);
      }
      // No branch landed, base untouched, scratch worktree cleaned up.
      expect((await git(repo, 'branch', '--list', 'relay/run-x')).trim()).toBe('');
      expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(head);
      expect(await git(repo, 'worktree', 'list')).not.toContain('applyback-scratch');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
