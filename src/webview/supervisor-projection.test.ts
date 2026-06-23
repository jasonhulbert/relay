import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  atomicWriteFile,
  relayPaths,
  writeLayer,
  writeManifest,
  writeNode,
} from '../relay-state/index';
import type {
  EvidenceRef,
  LayerManifest,
  NodeRecord,
  OutcomeSpec,
  RootManifest,
} from '../relay-state/index';
import { projectSupervisorNode } from './projection';

const RUN_ID = 'run-1';

function spec(outcome: string): OutcomeSpec {
  return {
    outcome,
    verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
  };
}

function node(over: Partial<NodeRecord> & Pick<NodeRecord, 'id'>): NodeRecord {
  return {
    parentId: null,
    kind: 'leaf',
    status: 'pending',
    spec: spec(`outcome for ${over.id}`),
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
    ...over,
  };
}

function ref(nodeId: string, file: string, kind: EvidenceRef['kind']): EvidenceRef {
  return { runId: RUN_ID, path: `${nodeId}/${file}`, kind, summary: `${kind} for ${nodeId}` };
}

async function seedManifest(relayDir: string): Promise<void> {
  const manifest: RootManifest = {
    runId: RUN_ID,
    rootId: 'root',
    spec: spec('ship the widget end-to-end'),
    sketch: { notes: [] },
    createdAt: '2026-06-18T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);
}

// Write an evidence file under the run's evidence dir, mirroring how the
// orchestrator persists artifacts (evidenceDir(runId)/<nodeId>/<file>).
async function writeEvidence(
  relayDir: string,
  nodeId: string,
  file: string,
  content: string,
): Promise<void> {
  await atomicWriteFile(join(relayPaths(relayDir).evidenceDir(RUN_ID), nodeId, file), content);
}

// WHY: the human-supervisor view is the OTHER side of the C7 split — it must surface
// the orchestrator-visible narrative AND the on-disk evidence content the operator
// audits, while the critic still sees evidence only. This pins that the reader lifts
// the self-report off the record, reads each evidence file's content, and exposes the
// decompose JUDGMENT (footprints + seams + rationale) for a decomposed branch. A
// reader that dropped the narrative (mistaking the human view for the critic view) or
// failed to read the layer would fail here.
describe('projectSupervisorNode surfaces the human-supervisor detail (Sol 1)', () => {
  test('a decomposed branch exposes narrative, evidence content, and footprints/seams', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-supervisor-'));
    const relayDir = join(base, '.relay');
    try {
      await seedManifest(relayDir);

      const branchRefs = [ref('root', 'decompose-rationale.md', 'rationale')];
      await writeNode(
        relayDir,
        node({
          id: 'root',
          parentId: null,
          kind: 'branch',
          status: 'active',
          spec: spec('integrate the decomposed layer'),
          children: ['root.c0', 'root.c1'],
          // Orchestrator-visible narrative — surfaced to the human, never the critic.
          selfReport: 'decomposed into a data layer and a UI layer',
          learnings: ['the data layer must land before the UI'],
          evidenceRefs: branchRefs,
        }),
      );
      await writeEvidence(
        relayDir,
        'root',
        'decompose-rationale.md',
        'split because the UI consumes the data layer Widget type',
      );

      const layer: LayerManifest = {
        parentId: 'root',
        runId: RUN_ID,
        footprints: {
          'root.c0': { writeGlobs: ['src/data/**'] },
          'root.c1': { writeGlobs: ['src/ui/**'] },
        },
        seams: [
          {
            id: 'seam-0',
            kind: 'interface',
            producer: 'root.c0',
            consumer: 'root.c1',
            intent: 'the data layer publishes the Widget type the UI consumes',
            payload: { symbol: 'Widget' },
          },
        ],
      };
      await writeLayer(relayDir, layer);

      // A done leaf with the full evidence trio (self-report, diff, verdict) on disk.
      const leafRefs = [
        ref('root.c0', 'self-report.md', 'self-report'),
        ref('root.c0', 'diff.patch', 'diff'),
        ref('root.c0', 'verdict.md', 'verdict'),
      ];
      await writeNode(
        relayDir,
        node({
          id: 'root.c0',
          parentId: 'root',
          kind: 'leaf',
          status: 'done',
          spec: spec('build the data layer'),
          selfReport: 'wrote the data module',
          verdict: {
            pass: true,
            provider: 'codex',
            rationale: 'the data layer satisfies the spec',
            evidenceRefs: [],
          },
          evidenceRefs: leafRefs,
        }),
      );
      await writeEvidence(relayDir, 'root.c0', 'self-report.md', 'wrote the data module in full');
      await writeEvidence(relayDir, 'root.c0', 'diff.patch', 'A src/data/widget.ts\n+export ...');
      await writeEvidence(
        relayDir,
        'root.c0',
        'verdict.md',
        '# critic verdict\n\n- Result: PASS\n',
      );

      // Branch: narrative lifted, rationale content read, layer exposed.
      const branch = await projectSupervisorNode(relayDir, 'root');
      expect(branch.selfReport).toBe('decomposed into a data layer and a UI layer');
      expect(branch.learnings).toEqual(['the data layer must land before the UI']);
      const ratEvidence = branch.evidence.find((e) => e.ref.kind === 'rationale');
      expect(ratEvidence?.missing).toBe(false);
      expect(ratEvidence?.content).toContain('Widget type');
      // The decompose JUDGMENT — footprints + seams — is surfaced for the branch.
      expect(branch.layer?.footprints['root.c0'].writeGlobs).toEqual(['src/data/**']);
      expect(branch.layer?.seams[0]).toMatchObject({ kind: 'interface', producer: 'root.c0' });

      // Leaf: self-report content, diff content, and verdict all read off disk.
      const leaf = await projectSupervisorNode(relayDir, 'root.c0');
      const byKind = new Map(leaf.evidence.map((e) => [e.ref.kind, e]));
      expect(byKind.get('self-report')?.content).toContain('wrote the data module in full');
      expect(byKind.get('diff')?.content).toContain('src/data/widget.ts');
      expect(byKind.get('verdict')?.content).toContain('PASS');
      expect(leaf.verdict?.provider).toBe('codex');
      // A leaf has no decomposed layer.
      expect(leaf.layer).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: a node can carry an evidence REF whose file is absent — a blocked node has a
  // diff/self-report but no verdict, and an errored executor may leave a ref's file
  // unwritten. The supervisor reader must degrade to a typed "missing" marker, never
  // throw, so the route can still render the rest of the node (fail-visible, Rule 11).
  // A reader that read files eagerly without guarding would throw here.
  test('a ref whose file is absent yields a missing marker, not an exception', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-supervisor-missing-'));
    const relayDir = join(base, '.relay');
    try {
      await seedManifest(relayDir);
      await writeNode(
        relayDir,
        node({
          id: 'root',
          parentId: null,
          kind: 'leaf',
          status: 'blocked',
          spec: spec('the unreachable change'),
          selfReport: 'attempted the change',
          evidenceRefs: [
            ref('root', 'self-report.md', 'self-report'),
            ref('root', 'verdict.md', 'verdict'), // never written — the node is blocked
          ],
        }),
      );
      await writeEvidence(relayDir, 'root', 'self-report.md', 'attempted the change in full');

      const view = await projectSupervisorNode(relayDir, 'root');
      const byKind = new Map(view.evidence.map((e) => [e.ref.kind, e]));
      expect(byKind.get('self-report')?.missing).toBe(false);
      expect(byKind.get('self-report')?.content).toContain('attempted the change in full');
      // The absent verdict file is a marker, not a throw.
      expect(byKind.get('verdict')?.missing).toBe(true);
      expect(byKind.get('verdict')?.content).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: the audience split is STRUCTURAL, not prompting (C7). The supervisor reader
  // is on the human side and must never construct or consume the critic projection —
  // a single import of `toCriticView`/`runCritic`/`CriticView` into this module would
  // be the leak. This grep encodes that boundary at the source level.
  test('the supervisor projection module never touches the critic view (C7)', async () => {
    const src = await readFile(new URL('./projection.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/toCriticView/);
    expect(src).not.toMatch(/runCritic/);
    expect(src).not.toMatch(/CriticView/);
  });
});
