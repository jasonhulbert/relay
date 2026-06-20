import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runIntegrationGate } from './integration-gate';
import type { GateInput } from './integration-gate';
import type {
  CriticSpawn,
  CriticVerdict,
  LayerManifest,
  NodeRecord,
  OutcomeSpec,
} from '../relay-state/index';

// The parent branch the gate re-grades: a minimal spec is enough — the deterministic
// layers never read it, and the critic layer is stubbed per test.
const PARENT_SPEC: OutcomeSpec = {
  outcome: 'compose the concurrent layer',
  verifications: [{ kind: 'command', grounding: 'exit 0', check: 'true' }],
};

function parentNode(): NodeRecord {
  return {
    id: 'root',
    parentId: null,
    kind: 'branch',
    status: 'pending',
    spec: PARENT_SPEC,
    children: ['root.c0', 'root.c1'],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };
}

function manifest(over: Partial<LayerManifest>): LayerManifest {
  return {
    parentId: 'root',
    runId: 'run-1',
    footprints: {},
    seams: [],
    ...over,
  };
}

// A critic that records whether it was called, so a deterministic-layer failure can
// assert the metered model call was never reached (the deterministic-first guarantee).
function spyCritic(result: 'pass' | 'fail'): { critic: CriticSpawn; calls: () => number } {
  let calls = 0;
  const critic: CriticSpawn = (): Promise<CriticVerdict> => {
    calls += 1;
    return Promise.resolve({
      pass: result === 'pass',
      provider: 'spy-critic',
      rationale: `spy critic returned ${result}`,
      evidenceRefs: [],
    });
  };
  return { critic, calls: () => calls };
}

// A critic that throws if reached — pins that a deterministic failure short-circuits
// before any model call (Rule 5: the cheap checks gate the expensive one).
const exploding: CriticSpawn = (): Promise<CriticVerdict> => {
  throw new Error('critic must not run after a deterministic-layer failure');
};

function baseInput(over: Partial<GateInput>): GateInput {
  return {
    parentNode: parentNode(),
    mergedDiff: '',
    mergedWorktree: '/nonexistent',
    layer: manifest({}),
    childWrites: {},
    critic: exploding,
    mcpServers: [],
    ...over,
  };
}

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'relay-gate-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// WHY (deterministic-first, layer 1): the footprint layer catches the loud violations
// over the merged WAL. An escape (a child wrote outside its declared footprint) and a
// clash (two children wrote a common path — the genuinely cross-sibling conflict no
// per-child critic can see) must both fail HERE, before the metered critic runs.
describe('layer 1 — footprint from the WAL', () => {
  test('a child whose actual writes escape its declared footprint fails at the footprint layer', async () => {
    const gate = await runIntegrationGate(
      baseInput({
        layer: manifest({ footprints: { 'root.c0': { writeGlobs: ['a/**'] } } }),
        childWrites: { 'root.c0': ['b/escapes.ts'] },
        critic: exploding,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('footprint');
    expect(gate.reason).toContain('escape');
    expect(gate.reason).toContain('root.c0');
  });

  test('two children that wrote a common path fail at the footprint layer (the cross-sibling clash)', async () => {
    const { critic, calls } = spyCritic('pass');
    const gate = await runIntegrationGate(
      baseInput({
        // Each stayed within its own declared footprint, yet both wrote the same
        // concrete path — only the merged WAL exposes it.
        layer: manifest({
          footprints: {
            'root.c0': { writeGlobs: ['**'] },
            'root.c1': { writeGlobs: ['**'] },
          },
        }),
        childWrites: { 'root.c0': ['shared/x.ts'], 'root.c1': ['shared/x.ts'] },
        critic,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('footprint');
    expect(gate.reason).toContain('clash');
    expect(calls()).toBe(0); // deterministic-first: the critic never ran
  });

  test('disjoint, in-footprint writes pass the footprint layer', async () => {
    // No seams; a passing critic, so the gate reaches and clears the critic too.
    const { critic } = spyCritic('pass');
    const gate = await runIntegrationGate(
      baseInput({
        mergedWorktree: workdir,
        layer: manifest({
          footprints: {
            'root.c0': { writeGlobs: ['a/**'] },
            'root.c1': { writeGlobs: ['b/**'] },
          },
        }),
        childWrites: { 'root.c0': ['a/x.ts'], 'root.c1': ['b/y.ts'] },
        critic,
      }),
    );
    expect(gate.ok).toBe(true);
    expect(gate.layer).toBe('critic');
  });
});

// WHY (deterministic-first, layer 2): the seam predicates verify the pinned contracts
// (A8) the parent authored — code answers, not a model. A broken seam must fail here,
// after the footprint layer and before the critic.
describe('layer 2 — seam predicates', () => {
  test('an overlapping file-boundary seam fails at the seam layer, before the critic', async () => {
    const gate = await runIntegrationGate(
      baseInput({
        layer: manifest({
          seams: [
            {
              id: 'seam-0',
              kind: 'file-boundary',
              producer: 'root.c0',
              consumer: 'root.c1',
              intent: 'producer and consumer must not collide',
              payload: { producerGlobs: ['src/a/**'], consumerGlobs: ['src/a/overlap.ts'] },
            },
          ],
        }),
        critic: exploding,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('seam');
    expect(gate.reason).toContain('seam-0');
  });

  test('an interface seam whose producer module is missing from the merged tree fails at the seam layer', async () => {
    const gate = await runIntegrationGate(
      baseInput({
        mergedWorktree: workdir, // empty — the module does not exist
        layer: manifest({
          seams: [
            {
              id: 'seam-1',
              kind: 'interface',
              producer: 'root.c0',
              consumer: 'root.c1',
              intent: 'producer must publish foo',
              payload: { symbol: 'foo', module: 'producer.ts' },
            },
          ],
        }),
        critic: exploding,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('seam');
    expect(gate.reason).toContain('not found');
  });

  test('an interface seam whose signature mismatches the merged source fails at the seam layer', async () => {
    await writeFile(
      join(workdir, 'producer.ts'),
      'export function foo(a: number): number { return a; }\n',
    );
    const gate = await runIntegrationGate(
      baseInput({
        mergedWorktree: workdir,
        layer: manifest({
          seams: [
            {
              id: 'seam-2',
              kind: 'interface',
              producer: 'root.c0',
              consumer: 'root.c1',
              intent: 'producer must publish foo: (a: number) => string',
              payload: {
                symbol: 'foo',
                signature: 'function foo(a: number): string',
                module: 'producer.ts',
              },
            },
          ],
        }),
        critic: exploding,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('seam');
    expect(gate.reason).toContain('mismatch');
  });

  test('a matching interface seam passes the seam layer and reaches the critic', async () => {
    await writeFile(
      join(workdir, 'producer.ts'),
      'export function foo(a: number): string { return String(a); }\n',
    );
    const { critic, calls } = spyCritic('pass');
    const gate = await runIntegrationGate(
      baseInput({
        mergedWorktree: workdir,
        layer: manifest({
          seams: [
            {
              id: 'seam-3',
              kind: 'interface',
              producer: 'root.c0',
              consumer: 'root.c1',
              intent: 'producer must publish foo',
              payload: {
                symbol: 'foo',
                signature: 'function foo(a: number): string',
                module: 'producer.ts',
              },
            },
          ],
        }),
        critic,
      }),
    );
    expect(gate.ok).toBe(true);
    expect(gate.layer).toBe('critic');
    expect(calls()).toBe(1);
  });
});

// WHY (deterministic-first, layer 3): the critic layer is the silent-violation catch —
// two diffs that pass every deterministic check yet are semantically incompatible. It
// runs ONLY when the deterministic layers cleared, and its verdict decides the gate.
describe('layer 3 — the parent re-runs its own critic on the merged whole', () => {
  test('a clean layer the critic accepts passes the gate, carrying the verdict', async () => {
    const { critic } = spyCritic('pass');
    const gate = await runIntegrationGate(baseInput({ mergedWorktree: workdir, critic }));
    expect(gate.ok).toBe(true);
    expect(gate.layer).toBe('critic');
    expect(gate.verdict?.pass).toBe(true);
  });

  test('a clean layer the critic rejects fails at the critic layer (the silent-conflict catch)', async () => {
    const { critic } = spyCritic('fail');
    const gate = await runIntegrationGate(baseInput({ mergedWorktree: workdir, critic }));
    expect(gate.ok).toBe(false);
    expect(gate.layer).toBe('critic');
    expect(gate.reason).toContain('rejected');
    expect(gate.verdict?.pass).toBe(false);
  });
});
