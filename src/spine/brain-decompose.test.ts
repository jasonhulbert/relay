import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import type { Brain } from './brain';
import {
  pendingIntents,
  readLayer,
  readNode,
  writeManifest,
  writeNode,
} from '../relay-state/index';
import type { NodeRecord, RootManifest } from '../relay-state/index';

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-brain-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Every `.relay/`-relative file path (the journal dir excluded — transient).
async function relayFiles(relayDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(join(dir, ent.name), relPath);
      } else if (!ent.name.includes('.tmp-')) {
        out.push(relPath);
      }
    }
  }
  await walk(relayDir, '');
  return out;
}

// Seed a CHILDLESS branch root so branch-activation decomposition fires —
// the seed fixture hands the root a child, which would skip decomposition.
async function seedChildlessBranch(relayDir: string, outcome: string): Promise<void> {
  const spec = {
    outcome,
    verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
  };
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec,
    sketch: { notes: [] },
    createdAt: '2026-06-19T00:00:00.000Z',
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

// Validation 1 (headline): the brain decomposes a real outcome into a layer carrying
// footprints AND seams, committed atomically. This also exercises leaf-vs-branch —
// the brain classifies one child a branch — and that the orchestrator (code) is what
// commits the model's judgment.
describe('branch-activation decomposition commits a real layer atomically', () => {
  test('children + footprints + seams land together, with leaf-vs-branch classes', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir, 'ship the widget');

      // A brain returning one leaf and one branch child, disjoint footprints, and a
      // seam between them. The orchestrator assigns ids and remaps the seam.
      const brain: Brain = {
        decompose: () =>
          Promise.resolve({
            decomposition: {
              children: [
                {
                  spec: {
                    outcome: 'the data layer',
                    verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
                  },
                  kind: 'leaf',
                  footprint: { writeGlobs: ['src/data/**'] },
                },
                {
                  spec: {
                    outcome: 'the UI on top of the data layer',
                    verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
                  },
                  kind: 'branch',
                  footprint: { writeGlobs: ['src/ui/**'] },
                },
              ],
              seams: [
                {
                  id: 's1',
                  kind: 'interface',
                  producer: 0,
                  consumer: 1,
                  intent: 'the data layer publishes the Widget type the UI consumes',
                  payload: { symbol: 'Widget' },
                },
              ],
            },
            rationale:
              'split into a data layer and a UI branch joined by the Widget interface seam',
          }),
      };

      const res = await runOrchestrator(relayDir, 'root', {
        brain,
        workRoot,
        // The branch child is not actually spawned (no-op, publishes no contract).
        spawnChild: () => Promise.resolve({ code: 0 }),
      });

      // The layer was committed: the branch now points at its children, with the
      // brain's leaf-vs-branch classification preserved on disk.
      expect((await readNode(relayDir, 'root')).children).toEqual(['root.c0', 'root.c1']);
      expect((await readNode(relayDir, 'root.c0')).kind).toBe('leaf');
      expect((await readNode(relayDir, 'root.c1')).kind).toBe('branch');

      // The layer manifest carries each child's footprint and the seam graph, with
      // producer/consumer remapped from the brain's indices to the assigned node-ids.
      const layer = await readLayer(relayDir, 'root');
      expect(layer.footprints['root.c0'].writeGlobs).toEqual(['src/data/**']);
      expect(layer.footprints['root.c1'].writeGlobs).toEqual(['src/ui/**']);
      expect(layer.seams).toHaveLength(1);
      expect(layer.seams[0]).toMatchObject({
        kind: 'interface',
        producer: 'root.c0',
        consumer: 'root.c1',
      });

      // Committed atomically: nothing left torn/pending after the decompose commit.
      expect(await pendingIntents(relayDir, 'root')).toEqual([]);
      // The owned-writes footprint records that CODE wrote the layer + children.
      expect(res.ownedWrites).toContain('layers/root.md');
      expect(res.ownedWrites).toContain('nodes/root.c0.md');

      // The brain's decompose rationale was persisted as node-attributed audit
      // evidence in the SAME commit as the layer — the decomposed branch carries a
      // `rationale` evidence ref into the on-disk file, and the file holds the raw
      // reasoning. A wiring that discarded the rationale, or wrote
      // it OUTSIDE the layer's atomic commit, fails here.
      const rationalePath = join(relayDir, 'evidence', 'run-1', 'root', 'decompose-rationale.md');
      expect(await readFile(rationalePath, 'utf8')).toContain('Widget interface seam');
      const branch = await readNode(relayDir, 'root');
      const ratRef = branch.evidenceRefs.find((r) => r.kind === 'rationale');
      expect(ratRef).toBeDefined();
      expect(ratRef?.path).toBe('root/decompose-rationale.md');
      expect(res.ownedWrites).toContain('evidence/run-1/root/decompose-rationale.md');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Validation 2 (headline): a tool-using judgment runs inside the code-owned loop,
// and ONLY code writes `.relay/`. The brain is granted a worktree + MCP servers but
// NO `.relay/` handle, so it is structurally incapable of writing the durable state
// (code is the sole writer of `.relay/`); here it performs a tool action in its sandbox worktree, and we assert
// every `.relay/` file is an orchestrator-owned record while the brain's artifact is
// not under `.relay/`.
describe('a tool-using brain judgment writes nothing to .relay/ (code is the sole writer)', () => {
  test('the judgment uses a tool in its worktree; code is the sole .relay/ writer', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir, 'generate the module');

      // A brain that drives a "tool" inside the code-owned loop: it writes a probe
      // into its GRANTED worktree (the agent's sandbox), reads it back, and lets the
      // tool result inform the decomposition. It never touches `.relay/` — it has no
      // handle to it.
      const toolBrain: Brain = {
        async decompose(_req, bctx) {
          expect(bctx.mcpServers.length).toBeGreaterThan(0); // the grant was routed
          await mkdir(bctx.worktree, { recursive: true });
          const probe = join(bctx.worktree, 'tool-probe.txt');
          await writeFile(probe, 'src/gen/**');
          const derivedGlob = await readFile(probe, 'utf8');
          return {
            decomposition: {
              children: [
                {
                  spec: {
                    outcome: 'the generated module',
                    verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
                  },
                  kind: 'leaf',
                  footprint: { writeGlobs: [derivedGlob] },
                },
              ],
              seams: [],
            },
            rationale: `derived the generated module footprint ${derivedGlob} from a tool probe`,
          };
        },
      };

      const res = await runOrchestrator(relayDir, 'root', {
        brain: toolBrain,
        workRoot,
        mcpServers: [{ name: 'probe', command: 'srv' }],
      });

      // A tool-using judgment ran: its artifact exists in the worktree sandbox...
      expect(await exists(join(workRoot, 'root', 'tool-probe.txt'))).toBe(true);
      // ...and it is NOT under `.relay/`.
      expect(await exists(join(relayDir, 'root', 'tool-probe.txt'))).toBe(false);

      // Only code wrote `.relay/`: every durable file is an orchestrator-owned record
      // (manifest / nodes / layers / journal), none authored by the brain.
      const files = await relayFiles(relayDir);
      for (const f of files) {
        expect(f).toMatch(/^(manifest\.md|nodes\/|layers\/|journal\/|evidence\/)/);
      }
      // The model's judgment was committed by code — the tool-derived footprint
      // landed in the layer manifest the orchestrator wrote.
      const layer = await readLayer(relayDir, 'root');
      expect(layer.footprints['root.c0'].writeGlobs).toEqual(['src/gen/**']);
      // The decomposed leaf was then driven to done by the rest of the loop.
      expect(res.leafStatuses['root.c0']).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
