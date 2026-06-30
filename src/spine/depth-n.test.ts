import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import esbuild from 'esbuild';
import {
  pendingIntents,
  readManifest,
  readNode,
  relayPaths,
  tryReadContract,
} from '../relay-state/index';
import { runOrchestrator, seedDeepHierarchy } from './index';
import type { ChildInjection, ChildRuntimeConfig, FaultPoint, SelfFaultPoint } from './index';

let childEntry: string;
let bundleBase: string;

beforeAll(async () => {
  bundleBase = await mkdtemp(join(tmpdir(), 'relay-depth-n-child-entry-'));
  childEntry = join(bundleBase, 'child-entry.cjs');
  await esbuild.build({
    entryPoints: ['src/spine/child-entry.ts'],
    outfile: childEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  });
});

afterAll(async () => {
  await rm(bundleBase, { recursive: true, force: true });
});

async function freshRelay(): Promise<{ base: string; relayDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-depth-n-'));
  return { base, relayDir: join(base, '.relay') };
}

async function collectRelay(relayDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (relPath === 'journal') continue;
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile() && !ent.name.includes('.tmp-')) {
        out[relPath] = await readFile(join(dir, ent.name), 'utf8');
      }
    }
  }
  await walk(relayDir, '');
  return out;
}

async function prepareDepthRun(
  base: string,
  relayDir: string,
): Promise<{
  projectPath: string;
  rootWorkRoot: string;
  runtimeWorkRoot: string;
  childRuntime: ChildRuntimeConfig;
}> {
  const projectPath = join(base, 'project');
  const rootWorkRoot = join(base, 'root-worktrees');
  const runtimeWorkRoot = join(base, 'runtime-worktrees');
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, 'README.md'), '# fixture\n');
  await seedDeepHierarchy(relayDir, { leafIds: ['leaf-1'] });

  return {
    projectPath,
    rootWorkRoot,
    runtimeWorkRoot,
    childRuntime: {
      projectPath,
      workRoot: runtimeWorkRoot,
      provider: 'claude',
      executorModel: 'claude-test',
      swapProvider: 'codex',
      swapModel: 'codex-test',
      criticProvider: 'codex',
      criticModel: 'critic-test',
      brainProvider: 'claude',
      brainModel: 'brain-test',
      mcpServers: [],
      childEntry,
      testMode: 'stub-providers',
    },
  };
}

async function runDepthRoot(
  relayDir: string,
  opts: Awaited<ReturnType<typeof prepareDepthRun>>,
  extra: { selfFaultAt?: SelfFaultPoint; childInjections?: Record<string, ChildInjection> } = {},
) {
  return await runOrchestrator(relayDir, 'root', {
    childEntry,
    childRuntime: opts.childRuntime,
    projectPath: opts.projectPath,
    workRoot: opts.rootWorkRoot,
    ...extra,
  });
}

describe('depth-N deterministic fixture', () => {
  // WHY: the recursive acceptance path must start from a stable ledger tree, not
  // live model decomposition. This pins the exact branch nesting and absence of
  // pre-certified contracts so the later process tests prove real execution.
  test('seeds root branch to mid branch to grandchild branch to leaves', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      const seeded = await seedDeepHierarchy(relayDir);

      expect(seeded).toEqual({
        runId: 'run-1',
        rootId: 'root',
        midId: 'mid',
        grandId: 'grand',
        leafId: 'leaf-1',
        leafIds: ['leaf-1', 'leaf-2'],
      });

      const manifest = await readManifest(relayDir);
      expect(manifest).toMatchObject({
        runId: 'run-1',
        rootId: 'root',
        createdAt: '2026-06-18T00:00:00.000Z',
      });

      const root = await readNode(relayDir, 'root');
      const mid = await readNode(relayDir, 'mid');
      const grand = await readNode(relayDir, 'grand');
      const leaf1 = await readNode(relayDir, 'leaf-1');
      const leaf2 = await readNode(relayDir, 'leaf-2');

      expect(root).toMatchObject({
        id: 'root',
        parentId: null,
        kind: 'branch',
        status: 'pending',
        children: ['mid'],
      });
      expect(mid).toMatchObject({
        id: 'mid',
        parentId: 'root',
        kind: 'branch',
        status: 'pending',
        children: ['grand'],
      });
      expect(grand).toMatchObject({
        id: 'grand',
        parentId: 'mid',
        kind: 'branch',
        status: 'pending',
        children: ['leaf-1', 'leaf-2'],
      });
      expect(leaf1).toMatchObject({
        id: 'leaf-1',
        parentId: 'grand',
        kind: 'leaf',
        status: 'pending',
        children: [],
      });
      expect(leaf2).toMatchObject({
        id: 'leaf-2',
        parentId: 'grand',
        kind: 'leaf',
        status: 'pending',
        children: [],
      });

      await expect(tryReadContract(relayDir, 'mid')).resolves.toBeNull();
      await expect(tryReadContract(relayDir, 'grand')).resolves.toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('depth-N process acceptance', () => {
  // WHY: the recursive process guarantee is not proven by one child spawn. The
  // mid branch must run as a real child process, then spawn the grandchild branch
  // as another real process, and the root must accept only their ledger contracts.
  test('root spawns mid, mid spawns grandchild, and root composes grandchild writes', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      const opts = await prepareDepthRun(base, relayDir);
      const res = await runDepthRoot(relayDir, opts);

      expect(res.rootStatus).toBe('done');
      expect(res.childStatuses.mid).toBe('done');
      expect(res.childContracts.mid?.criticCertified).toBe(true);

      await expect(readNode(relayDir, 'root')).resolves.toMatchObject({ status: 'done' });
      await expect(readNode(relayDir, 'mid')).resolves.toMatchObject({ status: 'done' });
      await expect(readNode(relayDir, 'grand')).resolves.toMatchObject({ status: 'done' });
      await expect(readNode(relayDir, 'leaf-1')).resolves.toMatchObject({ status: 'done' });

      const midContract = await tryReadContract(relayDir, 'mid');
      const grandContract = await tryReadContract(relayDir, 'grand');
      expect(midContract?.criticCertified).toBe(true);
      expect(grandContract?.criticCertified).toBe(true);
      expect(midContract?.seamEvidence).toEqual([
        {
          runId: 'run-1',
          path: 'mid/result.patch',
          kind: 'diff',
          summary: 'composed branch result patch',
        },
      ]);
      expect(grandContract?.seamEvidence).toEqual([
        {
          runId: 'run-1',
          path: 'grand/result.patch',
          kind: 'diff',
          summary: 'composed branch result patch',
        },
      ]);

      await expect(
        access(join(opts.runtimeWorkRoot, 'leaf-1', 'CHANGE.txt')),
      ).resolves.toBeUndefined();
      await expect(access(join(opts.rootWorkRoot, 'leaf-1', 'CHANGE.txt'))).rejects.toThrow();

      const evDir = relayPaths(relayDir).evidenceDir('run-1');
      const grandPatch = await readFile(join(evDir, 'grand', 'result.patch'), 'utf8');
      const midPatch = await readFile(join(evDir, 'mid', 'result.patch'), 'utf8');
      const rootPatch = await readFile(join(evDir, 'result.patch'), 'utf8');
      expect(grandPatch).toContain('CHANGE.txt');
      expect(midPatch).toBe(grandPatch);
      expect(rootPatch).toBe(grandPatch);

      const rootRegion = ['nodes/root.md', 'evidence/run-1/result.patch'];
      const midRegion = ['nodes/mid.md', 'contracts/mid.md', 'evidence/run-1/mid/result.patch'];
      const grandRegion = [
        'nodes/grand.md',
        'nodes/leaf-1.md',
        'contracts/grand.md',
        'evidence/run-1/grand/result.patch',
        'evidence/run-1/leaf-1/diff.patch',
      ];
      expect(rootRegion.filter((p) => midRegion.includes(p) || grandRegion.includes(p))).toEqual(
        [],
      );
      expect(midRegion.filter((p) => grandRegion.includes(p))).toEqual([]);
      expect(res.ownedWrites).not.toContain('nodes/mid.md');
      expect(res.ownedWrites).not.toContain('nodes/grand.md');
      expect(res.ownedWrites).not.toContain('nodes/leaf-1.md');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('depth-N rehydration', () => {
  let baseline: Record<string, string>;

  beforeAll(async () => {
    const { base, relayDir } = await freshRelay();
    try {
      const opts = await prepareDepthRun(base, relayDir);
      await runDepthRoot(relayDir, opts);
      baseline = await collectRelay(relayDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  async function expectRehydrated(fault: {
    selfFaultAt?: SelfFaultPoint;
    childInjections?: Record<string, ChildInjection>;
  }): Promise<void> {
    const { base, relayDir } = await freshRelay();
    try {
      const opts = await prepareDepthRun(base, relayDir);
      await expect(runDepthRoot(relayDir, opts, fault)).rejects.toThrow();

      const res = await runDepthRoot(relayDir, opts);
      expect(res.rootStatus).toBe('done');
      expect(await collectRelay(relayDir)).toEqual(baseline);
      await expect(pendingIntents(relayDir, 'root')).resolves.toEqual([]);
      await expect(pendingIntents(relayDir, 'mid')).resolves.toEqual([]);
      await expect(pendingIntents(relayDir, 'grand')).resolves.toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  const selfPoints: SelfFaultPoint[] = [
    'before-spawn-child',
    'after-child-contract',
    'branch-done-intent',
    'after-branch-done',
  ];

  describe.each(selfPoints)('root killed at seam %s', (point) => {
    test('rehydrating reaches the clean terminal state', async () => {
      await expectRehydrated({ selfFaultAt: point });
    });
  });

  describe.each(selfPoints)('mid killed at seam %s', (point) => {
    test('rehydrating from root re-dispatches the nested process tree', async () => {
      await expectRehydrated({ childInjections: { mid: { selfFaultAt: point } } });
    });
  });

  const leafPoints: FaultPoint[] = [
    'before-dispatch',
    'after-executor',
    'after-self-report',
    'leaf-done-intent',
    'after-leaf-done',
  ];

  describe.each(leafPoints)('grandchild killed at leaf seam %s', (point) => {
    test('rehydrating from root re-dispatches through mid to grandchild', async () => {
      await expectRehydrated({
        childInjections: {
          mid: { childInjections: { grand: { faultAt: { leafId: 'leaf-1', point } } } },
        },
      });
    });
  });
});
