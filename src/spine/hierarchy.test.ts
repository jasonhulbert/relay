import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import esbuild from 'esbuild';
import { pendingIntents, readNode, tryReadContract } from '../relay-state/index';
import { InjectedKill, runOrchestrator, seedHierarchy } from './index';
import type { FaultPoint, SpawnChild } from './index';

// The child sub-orchestrator runs in a fresh `node` process. The source uses
// extensionless, bundler-resolved imports Node cannot run from raw `.ts`, so we
// bundle the entry once (the same artifact shape the SEA binary will carry) and
// point the parent's spawner at it.
let childEntry: string;
let bundleBase: string;

beforeAll(async () => {
  bundleBase = await mkdtemp(join(tmpdir(), 'relay-child-entry-'));
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
  const base = await mkdtemp(join(tmpdir(), 'relay-hier-'));
  return { base, relayDir: join(base, '.relay') };
}

// Every durable `.relay/` file, relative to the `.relay/` root. Temp files
// (`.tmp-*`) are transient and never durable records.
async function listFiles(relayDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile() && !ent.name.includes('.tmp-')) {
        out.push(relPath);
      }
    }
  }
  await walk(relayDir, '');
  return out.sort();
}

// Every durable `.relay/` record as text, keyed by path. The journal is excluded:
// its intents are transient and carry nondeterministic ids/timestamps, so it is
// checked separately via `pendingIntents`. This is the byte-deterministic terminal
// state every kill-and-rehydrate variant must reproduce.
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

describe('ownership-partitioned regions', () => {
  // WHY: the whole no-shared-write-target premise is only real if two
  // orchestrators can never write the same file. This pins the footprints: the
  // sub-orchestrator owns its own node + its leaf; the parent owns only its own
  // node. The instant the parent reaches into the child's region (or vice versa),
  // the intersection is non-empty and this fails.
  test('parent and child own disjoint .relay/ write sets', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedHierarchy(relayDir);

      // The child process's footprint: drive the sub-orchestrator bound to `mid`.
      const childRes = await runOrchestrator(relayDir, 'mid');
      expect(childRes.region).toBe('mid');
      expect(childRes.ownedWrites).toContain('nodes/mid.md');
      expect(childRes.ownedWrites).toContain('nodes/leaf-1.md');
      // The child never writes the parent's node.
      expect(childRes.ownedWrites).not.toContain('nodes/root.md');

      // The parent's footprint: `mid` is now `done`, so the parent trusts the
      // ledger and records only its own node — it must spawn nothing.
      const parentRes = await runOrchestrator(relayDir, 'root', {
        spawnChild: () => {
          throw new Error('parent must not spawn an already-done child');
        },
      });
      expect(parentRes.region).toBe('root');
      expect(parentRes.ownedWrites).toEqual(['nodes/root.md']);
      expect(parentRes.rootStatus).toBe('done');

      const overlap = parentRes.ownedWrites.filter((p) => childRes.ownedWrites.includes(p));
      expect(overlap).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: a parent spawns each child orchestrator as a *separate OS process*
  // coordinating only through `.relay/`. This proves the real spawn
  // path: a fresh `node` subprocess writes the child's region to disk, and the
  // parent reaches done from that committed state — with no lockfile, because
  // coordination is disjoint regions, not mutual exclusion.
  test('the parent spawns the child as a separate process and the tree reaches done', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedHierarchy(relayDir);
      const res = await runOrchestrator(relayDir, 'root', { childEntry });

      expect(res.rootStatus).toBe('done');
      expect(res.childStatuses.mid).toBe('done');

      // The child really ran in its own process and committed its whole region.
      expect((await readNode(relayDir, 'root')).status).toBe('done');
      expect((await readNode(relayDir, 'mid')).status).toBe('done');
      expect((await readNode(relayDir, 'leaf-1')).status).toBe('done');
      // The child's leaf evidence exists, written by the child process.
      const diff = await readFile(
        join(relayDir, 'evidence', 'run-1', 'leaf-1', 'diff.patch'),
        'utf8',
      );
      expect(diff).toContain('CHANGE.txt');

      // No lockfile anywhere: no shared write target, no mutual exclusion.
      const files = await listFiles(relayDir);
      expect(files.filter((f) => /\.lock$|lockfile/i.test(f))).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('verified outcome contract via the ledger', () => {
  // WHY: the parent must reach `done` by reading the child's committed contract —
  // the structural critic-certified fact — not by trusting the child's process. A
  // real subprocess publishes its contract; the parent accepts from the ledger and
  // the certifying critic verdict propagates up into the contract.
  test('the child publishes a certified contract and the parent reaches done from it', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedHierarchy(relayDir);
      const res = await runOrchestrator(relayDir, 'root', { childEntry });

      expect(res.rootStatus).toBe('done');
      const contract = res.childContracts.mid;
      expect(contract).toBeDefined();
      expect(contract.criticCertified).toBe(true);
      expect(contract.nodeId).toBe('mid');
      // The certifying fact is the leaf's critic verdict, ridden up into the
      // contract — not the child's narrative.
      expect(contract.verdictRefs.map((r) => r.kind)).toEqual(['verdict']);

      // The contract is a committed `.relay/` record in the child's region.
      const onDisk = await tryReadContract(relayDir, 'mid');
      expect(onDisk).toEqual(contract);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: this is the gate's whole point. The child process exits 0 and even
  // shouts success on stdout, but commits no contract. If the parent trusted the
  // exit code or the stream, it would wrongly go done. Because it gates on the
  // committed contract (read from the ledger), it stays not-done — the falsifiable
  // proof of "contract-via-ledger only, never child stdout".
  test('withholding the contract leaves the parent not-done despite a clean exit', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedHierarchy(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        childEntry,
        childInjections: { mid: { contractFault: 'skip' } },
      });

      // The child ran to completion and committed its node as done...
      expect((await readNode(relayDir, 'mid')).status).toBe('done');
      // ...but published no contract, so the parent did not accept it.
      expect(await tryReadContract(relayDir, 'mid')).toBeNull();
      expect(res.childContracts.mid).toBeUndefined();
      expect(res.rootStatus).not.toBe('done');
      expect((await readNode(relayDir, 'root')).status).not.toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: disposability is the backbone (the rehydration contract), and it must hold
// across the process boundary. A kill at EITHER level — inside the child's leaf dispatch, or
// in the parent around its accept/done transition — must reconstitute from
// `.relay/` alone to the SAME terminal state, with no torn records. The clean
// two-process run is the byte-deterministic baseline every variant reproduces.
describe('multi-node rehydration', () => {
  let baseline: Record<string, string>;

  beforeAll(async () => {
    const { base, relayDir } = await freshRelay();
    try {
      await seedHierarchy(relayDir);
      await runOrchestrator(relayDir, 'root', { childEntry });
      baseline = await collectRelay(relayDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // A kill INSIDE the child process, at each leaf-dispatch seam. The parent sees a
  // failed child (no contract), and a fresh run re-dispatches it to completion.
  const leafPoints: FaultPoint[] = [
    'before-dispatch',
    'after-executor',
    'after-self-report',
    'leaf-done-intent',
    'after-leaf-done',
  ];
  describe.each(leafPoints)('child killed at leaf seam %s', (point) => {
    test('rehydrating re-dispatches the child and the tree reaches the identical state', async () => {
      const { base, relayDir } = await freshRelay();
      try {
        await seedHierarchy(relayDir);

        // First parent run: the child dies mid-leaf, so the parent's accept fails.
        await expect(
          runOrchestrator(relayDir, 'root', {
            childEntry,
            childInjections: { mid: { faultAt: { leafId: 'leaf-1', point } } },
          }),
        ).rejects.toThrow();
        // A killed child published no contract, so it was not accepted.
        expect(await tryReadContract(relayDir, 'mid')).toBeNull();

        // Rehydrate: a fresh parent re-spawns the non-`done` child, which completes.
        const res = await runOrchestrator(relayDir, 'root', { childEntry });
        expect(res.rootStatus).toBe('done');
        expect(res.childContracts.mid?.criticCertified).toBe(true);

        // Byte-identical terminal state; no torn records, no pending intents.
        expect(await collectRelay(relayDir)).toEqual(baseline);
        expect(await pendingIntents(relayDir, 'root')).toEqual([]);
        expect(await pendingIntents(relayDir, 'mid')).toEqual([]);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  // A kill of the PARENT process at each of its own seams. For the post-contract
  // seams the child subprocess already finished, so rehydration must reconstitute
  // the subtree WITHOUT re-running the already-`done` child — it reads the
  // committed contract and finishes (the after-commit-point case rolls forward).
  const selfPoints = [
    'before-spawn-child',
    'after-child-contract',
    'branch-done-intent',
    'after-branch-done',
  ] as const;
  describe.each(selfPoints)('parent killed at seam %s', (point) => {
    test('rehydrating reconstitutes the subtree and reaches the identical state', async () => {
      const { base, relayDir } = await freshRelay();
      try {
        await seedHierarchy(relayDir);

        await expect(
          runOrchestrator(relayDir, 'root', { childEntry, selfFaultAt: point }),
        ).rejects.toThrow(InjectedKill);

        // 'before-spawn-child' died before the child ran, so rehydration must
        // really spawn it; every later seam already has a `done` child, which the
        // rehydrated parent must NOT re-spawn.
        const guard: SpawnChild = () => {
          throw new Error('rehydration must not re-spawn an already-done child');
        };
        const res = await runOrchestrator(
          relayDir,
          'root',
          point === 'before-spawn-child' ? { childEntry } : { childEntry, spawnChild: guard },
        );
        expect(res.rootStatus).toBe('done');

        // Only the after-commit-point kill leaves an intent to roll forward.
        expect(res.rolledForward.length).toBe(point === 'branch-done-intent' ? 1 : 0);

        expect(await collectRelay(relayDir)).toEqual(baseline);
        expect(await pendingIntents(relayDir, 'root')).toEqual([]);
        expect(await pendingIntents(relayDir, 'mid')).toEqual([]);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });
});
