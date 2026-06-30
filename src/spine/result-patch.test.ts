import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import { STUB_USAGE, stubCapabilities } from './executor';
import { captureDiff, seedWorktree, resolveSeedPlan } from './adapters/worktree-diff';
import type { Executor, ExecutorInput, ExecutorResult } from './executor';
import type { Brain } from './brain';
import {
  relayPaths,
  tryReadContract,
  writeContract,
  writeLayer,
  writeManifest,
  writeNode,
} from '../relay-state/index';
import type {
  EvidenceRef,
  Footprint,
  LayerManifest,
  NodeRecord,
  RootManifest,
} from '../relay-state/index';
import { seedHierarchy } from './seed';

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

function commandSpec(outcome: string) {
  return {
    outcome,
    verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
  };
}

// A clean operator repo with one committed tracked file, so a seeded run resolves to
// the `checkout` path (fork each leaf off HEAD).
async function makeCleanRepo(): Promise<{ repo: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'relay-result-repo-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@relay.local');
  await git(repo, 'config', 'user.name', 'Relay Test');
  await writeFile(join(repo, 'existing.txt'), 'original content\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--no-gpg-sign', '-m', 'seed');
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
  return { repo, head };
}

// A childless branch root + manifest so branch-activation decomposition fires and the
// brain's leaves land in a layer the scheduler drives (mirrors concurrency.test.ts).
async function seedChildlessBranch(relayDir: string): Promise<void> {
  const spec = commandSpec('compose the layer');
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

async function seedRootWithDoneBranch(
  relayDir: string,
  seamEvidence: EvidenceRef[],
  extraChildren: NodeRecord[] = [],
): Promise<void> {
  const spec = commandSpec('compose the parent branch');
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec,
    sketch: { notes: [] },
    createdAt: '2026-06-20T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);
  const mid: NodeRecord = {
    id: 'mid',
    parentId: 'root',
    kind: 'branch',
    status: 'done',
    spec: commandSpec('done branch child'),
    children: ['mid.leaf'],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  const root: NodeRecord = {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec,
    children: ['mid', ...extraChildren.map((child) => child.id)],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
  await writeNode(relayDir, root);
  await writeNode(relayDir, mid);
  for (const child of extraChildren) await writeNode(relayDir, child);
  await writeContract(relayDir, {
    nodeId: 'mid',
    runId: 'run-1',
    claimedOutcome: mid.spec.outcome,
    criticCertified: true,
    verdictRefs: [
      { runId: 'run-1', path: 'mid/integration-verdict.md', kind: 'verdict', summary: 'certified' },
    ],
    seamEvidence,
  });
}

async function patchForRepoChange(
  repo: string,
  workRoot: string,
  rel: string,
  body: string,
): Promise<string> {
  const plan = await resolveSeedPlan(repo);
  if (plan.mode !== 'checkout') throw new Error('expected clean checkout seed plan');
  const worktree = join(workRoot, `patch-${rel.replaceAll('/', '-')}`);
  await seedWorktree(worktree, plan);
  const dest = join(worktree, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  return await captureDiff(worktree, plan.base);
}

async function writeEvidence(
  relayDir: string,
  runId: string,
  rel: string,
  body: string,
): Promise<void> {
  const file = join(relayPaths(relayDir).evidenceDir(runId), rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}

// A brain that decomposes into N disjoint-footprint leaves (`part-i/**`), so the
// scheduler runs them concurrently with no serializing seam.
function leavesWithFootprints(footprints: Footprint[]): Brain {
  return {
    decompose: () =>
      Promise.resolve({
        decomposition: {
          children: footprints.map((footprint, i) => ({
            spec: {
              outcome: `part ${(i + 1).toString()}`,
              verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
            },
            kind: 'leaf' as const,
            footprint,
          })),
          seams: [],
        },
        rationale: 'disjoint-footprint leaf parts',
      }),
  };
}

// An executor that edits its REAL checkout sandbox the way a provider adapter does:
// it adds a new file inside its leaf's footprint (`part-N/file-N.txt`, derived from
// the spec outcome `part N`), then captures the diff against the per-run base — so the
// persisted leaf `diff.patch` is a genuine, apply-able patch, not a fabricated string.
function projectEditingExecutor(): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run(input: ExecutorInput): Promise<ExecutorResult> {
      const n = /part (\d+)/.exec(input.spec.outcome)?.[1] ?? '1';
      const rel = `part-${n}/file-${n}.txt`;
      const dest = join(input.worktree, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, `content ${n}\n`);
      const diff = await captureDiff(input.worktree, input.baseRef);
      return {
        diff,
        selfReport: `wrote ${rel}`,
        usage: STUB_USAGE,
        exitStatus: 0,
        writes: [rel],
      };
    },
  };
}

function branchProjectEditingExecutor(): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run(input: ExecutorInput): Promise<ExecutorResult> {
      const rel = 'branch-child/change.txt';
      const dest = join(input.worktree, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, 'branch child content\n');
      const diff = await captureDiff(input.worktree, input.baseRef);
      return {
        diff,
        selfReport: `wrote ${rel}`,
        usage: STUB_USAGE,
        exitStatus: 0,
        writes: [rel],
      };
    },
  };
}

// A hermetic stub executor (no real project): fabricates a diff string like the
// hermetic spine tests, used to prove the empty path persists NO result.patch.
function stubDiffExecutor(): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run({ worktree }): Promise<ExecutorResult> {
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'CHANGE.txt'), 'change\n');
      return {
        diff: 'A CHANGE.txt\n+change',
        selfReport: 'stub',
        usage: STUB_USAGE,
        exitStatus: 0,
      };
    },
  };
}

// WHY: `result.patch` is the run's canonical apply-back artifact and the re-derivable
// record of what was applied. If the single-leaf case diverged from the leaf's own
// verified diff, or the multi-leaf case persisted a concat of evidence text instead of a
// clean composed patch, apply-back would land something the critic never
// certified. And if the hermetic path emitted a patch, every hermetic stub run would grow a
// spurious artifact. All three are silent correctness failures this locks down.
describe('result.patch — canonical verified result persisted at root done', () => {
  async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
    const base = await mkdtemp(join(tmpdir(), 'relay-result-'));
    return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
  }

  test('single-leaf run: result.patch equals the leaf diff verbatim', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }]),
        executor: projectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });
      expect(res.rootStatus).toBe('done');

      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      const resultPatch = await readFile(join(evDir, 'result.patch'), 'utf8');
      const leafDiff = await readFile(join(evDir, 'root.c0', 'diff.patch'), 'utf8');
      // Reused verbatim — exactly what the critic certified, no rebaselining.
      expect(resultPatch).toBe(leafDiff);
      expect(resultPatch).toContain('part-1/file-1.txt');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('concurrent multi-leaf run: result.patch is the merged composition, apply-able onto base', async () => {
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
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');

      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      const resultPatch = await readFile(join(evDir, 'result.patch'), 'utf8');

      // It carries BOTH leaves' disjoint changes — the merged whole, not one sibling's
      // diff (a regression that persisted a single leaf would drop the other addition).
      expect(resultPatch).toContain('part-1/file-1.txt');
      expect(resultPatch).toContain('part-2/file-2.txt');
      const leafA = await readFile(join(evDir, 'root.c0', 'diff.patch'), 'utf8');
      expect(resultPatch).not.toBe(leafA);

      // And it is a real apply-back patch: it applies cleanly onto a fresh checkout of
      // the operator base and yields both files (apply-back lands exactly this).
      const verifyWt = join(workRoot, 'verify');
      const plan = await resolveSeedPlan(repo);
      if (plan.mode !== 'checkout' || plan.base !== head)
        throw new Error('expected checkout at head');
      await seedWorktree(verifyWt, plan);
      const patchFile = join(base, 'result.patch.tmp');
      await writeFile(patchFile, resultPatch);
      await git(verifyWt, 'apply', '--whitespace=nowarn', patchFile);
      expect(await readFile(join(verifyWt, 'part-1/file-1.txt'), 'utf8')).toBe('content 1\n');
      expect(await readFile(join(verifyWt, 'part-2/file-2.txt'), 'utf8')).toBe('content 2\n');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('hermetic stub run (no project) persists NO result.patch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }]),
        executor: stubDiffExecutor(),
        workRoot,
        // No projectPath → seed mode 'empty' → the apply-back artifact gate is off.
      });
      expect(res.rootStatus).toBe('done');
      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      expect(await exists(join(evDir, 'result.patch'))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('non-root branch run writes a node-scoped result.patch, not the root result.patch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      await seedHierarchy(relayDir);
      const res = await runOrchestrator(relayDir, 'mid', {
        executor: branchProjectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });

      expect(res.rootStatus).toBe('done');
      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      const branchPatch = await readFile(join(evDir, 'mid', 'result.patch'), 'utf8');
      const leafDiff = await readFile(join(evDir, 'leaf-1', 'diff.patch'), 'utf8');

      expect(branchPatch).toBe(leafDiff);
      expect(branchPatch).toContain('branch-child/change.txt');
      expect(await exists(join(evDir, 'result.patch'))).toBe(false);
      expect(res.ownedWrites).toContain('evidence/run-1/mid/result.patch');
      expect(res.ownedWrites).not.toContain('evidence/run-1/result.patch');

      const contract = await tryReadContract(relayDir, 'mid');
      expect(contract?.seamEvidence).toEqual([
        {
          runId: 'run-1',
          path: 'mid/result.patch',
          kind: 'diff',
          summary: 'composed branch result patch',
        },
      ]);
      for (const ref of contract?.seamEvidence ?? []) {
        await expect(readFile(join(evDir, ref.path), 'utf8')).resolves.toBe(branchPatch);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('root result.patch composes a done branch-child seamEvidence patch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      const branchPatch = await patchForRepoChange(
        repo,
        workRoot,
        'branch-child/from-mid.txt',
        'from branch child\n',
      );
      await writeEvidence(relayDir, 'run-1', 'mid/result.patch', branchPatch);
      await seedRootWithDoneBranch(relayDir, [
        { runId: 'run-1', path: 'mid/result.patch', kind: 'diff', summary: 'branch result' },
      ]);

      const res = await runOrchestrator(relayDir, 'root', { workRoot, projectPath: repo });

      expect(res.rootStatus).toBe('done');
      const resultPatch = await readFile(
        join(relayPaths(relayDir).evidenceDir('run-1'), 'result.patch'),
        'utf8',
      );
      expect(resultPatch).toBe(branchPatch);
      expect(resultPatch).toContain('branch-child/from-mid.txt');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('missing branch-child result patch evidence fails loud without a partial root patch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      await seedRootWithDoneBranch(relayDir, []);

      await expect(
        runOrchestrator(relayDir, 'root', { workRoot, projectPath: repo }),
      ).rejects.toThrow('done branch child `mid` has no result-patch seam evidence');
      expect(await exists(join(relayPaths(relayDir).evidenceDir('run-1'), 'result.patch'))).toBe(
        false,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('concurrent branch-child layer runs the parent integration gate on the merged patch', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    const { repo } = await makeCleanRepo();
    try {
      const branchPatch = await patchForRepoChange(
        repo,
        workRoot,
        'branch-child/from-mid.txt',
        'from branch child\n',
      );
      await writeEvidence(relayDir, 'run-1', 'mid/result.patch', branchPatch);
      const leaf: NodeRecord = {
        id: 'leaf-2',
        parentId: 'root',
        kind: 'leaf',
        status: 'pending',
        spec: commandSpec('part 2'),
        children: [],
        selfReport: null,
        learnings: [],
        verdict: null,
        evidenceRefs: [],
        blocked: null,
      };
      await seedRootWithDoneBranch(
        relayDir,
        [{ runId: 'run-1', path: 'mid/result.patch', kind: 'diff', summary: 'branch result' }],
        [leaf],
      );
      const layer: LayerManifest = {
        parentId: 'root',
        runId: 'run-1',
        footprints: {
          mid: { writeGlobs: ['branch-child/**'] },
          'leaf-2': { writeGlobs: ['part-2/**'] },
        },
        seams: [],
      };
      await writeLayer(relayDir, layer);

      const res = await runOrchestrator(relayDir, 'root', {
        executor: projectEditingExecutor(),
        workRoot,
        projectPath: repo,
      });

      expect(res.rootStatus).toBe('done');
      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      expect(await exists(join(evDir, 'root', 'integration-verdict.md'))).toBe(true);
      const resultPatch = await readFile(join(evDir, 'result.patch'), 'utf8');
      expect(resultPatch).toContain('branch-child/from-mid.txt');
      expect(resultPatch).toContain('part-2/file-2.txt');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
