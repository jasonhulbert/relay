import { describe, expect, test } from 'vitest';
import { buildSchedule, mayRunConcurrently } from './schedule';
import type { Footprint, LayerManifest } from '../relay-state/index';

// A layer manifest carrying just the footprints the scheduler reads. Seams are
// irrelevant to this phase's decision (the parent pre-declared them at decomposition
// per A8); footprints alone decide parallel-vs-serial here.
function layerOf(footprints: Record<string, Footprint>): LayerManifest {
  return { parentId: 'root', runId: 'run-1', footprints, seams: [] };
}

describe('buildSchedule — the concurrency law made operational (A2)', () => {
  // WHY: this is the headline of the phase. Two siblings the parent declared to
  // touch disjoint resources are the ONLY case parallelism is licensed, and they
  // must collapse into a single concurrent stage. If this regressed to serial, the
  // whole feature would be inert; if a conflicting pair leaked into one stage, it
  // would be unsafe.
  test('disjoint footprints run in one parallel stage', () => {
    const layer = layerOf({
      'root.c0': { writeGlobs: ['part-1/**'] },
      'root.c1': { writeGlobs: ['part-2/**'] },
    });
    expect(buildSchedule(['root.c0', 'root.c1'], layer)).toEqual({
      stages: [['root.c0', 'root.c1']],
    });
  });

  // WHY: the falsifiable safety direction. A shared resource is exactly what A2
  // forbids running concurrently; it must split into serial stages so each child
  // runs against the other's already-integrated result.
  test('a shared resource serializes into separate stages', () => {
    const layer = layerOf({
      'root.c0': { writeGlobs: ['shared/**'] },
      'root.c1': { writeGlobs: ['shared/config.ts'] },
    });
    expect(buildSchedule(['root.c0', 'root.c1'], layer)).toEqual({
      stages: [['root.c0'], ['root.c1']],
    });
  });

  // WHY: serial-by-default (A1) is the safe ground state. A hand-seeded branch has
  // no layer manifest, so the scheduler has no proof of disjointness and must NOT
  // optimistically parallelize — every child is its own stage, exactly the
  // pre-concurrency behavior the existing rehydration baselines depend on.
  test('no layer manifest ⇒ fully serial', () => {
    expect(buildSchedule(['a', 'b', 'c'], null)).toEqual({
      stages: [['a'], ['b'], ['c']],
    });
  });

  // WHY: a footprint that cannot be read cannot be proven disjoint, so the A1 bias
  // serializes it rather than guessing.
  test('a child with no footprint entry serializes', () => {
    const layer = layerOf({ 'root.c0': { writeGlobs: ['part-1/**'] } });
    expect(buildSchedule(['root.c0', 'root.c1'], layer)).toEqual({
      stages: [['root.c0'], ['root.c1']],
    });
  });

  // WHY: real layers mix disjoint and conflicting siblings. Greedy first-fit must
  // pack the disjoint ones together while pushing a conflict to a later stage, and
  // do so deterministically in child order so the schedule is stable across
  // rehydration.
  test('mixed layer packs disjoint siblings and serializes the conflict', () => {
    const layer = layerOf({
      a: { writeGlobs: ['src/a/**'] },
      b: { writeGlobs: ['src/b/**'] },
      c: { writeGlobs: ['src/a/overlap.ts'] }, // conflicts with a
    });
    // a, b disjoint → stage 0; c overlaps a → stage 1.
    expect(buildSchedule(['a', 'b', 'c'], layer)).toEqual({
      stages: [['a', 'b'], ['c']],
    });
  });
});

describe('mayRunConcurrently', () => {
  test('false without a manifest or a footprint, true for disjoint footprints', () => {
    expect(mayRunConcurrently(null, 'a', 'b')).toBe(false);
    const layer = layerOf({
      a: { writeGlobs: ['x/**'] },
      b: { writeGlobs: ['y/**'] },
    });
    expect(mayRunConcurrently(layer, 'a', 'b')).toBe(true);
    expect(mayRunConcurrently(layer, 'a', 'missing')).toBe(false);
  });
});
