import { describe, expect, test } from 'vitest';
import { buildSchedule, mayRunConcurrently } from './schedule';
import type { Footprint, LayerManifest, SeamContract } from '../relay-state/index';

// A layer manifest carrying the footprints and (optionally) seams the scheduler reads.
function layerOf(footprints: Record<string, Footprint>, seams: SeamContract[] = []): LayerManifest {
  return { parentId: 'root', runId: 'run-1', footprints, seams };
}

describe('buildSchedule — the concurrency law made operational', () => {
  // WHY: this is the headline. Two siblings the parent declared to
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

  // WHY: the falsifiable safety direction. A shared resource is exactly what the
  // concurrency law forbids running concurrently; it must split into serial stages so each child
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

  // WHY: serial-by-default is the safe ground state. A hand-seeded branch has
  // no layer manifest, so the scheduler has no proof of disjointness and must NOT
  // optimistically parallelize — every child is its own stage, exactly the
  // pre-concurrency behavior the existing rehydration baselines depend on.
  test('no layer manifest ⇒ fully serial', () => {
    expect(buildSchedule(['a', 'b', 'c'], null)).toEqual({
      stages: [['a'], ['b'], ['c']],
    });
  });

  // WHY: a footprint that cannot be read cannot be proven disjoint, so the
  // serial-by-default bias serializes it rather than guessing.
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

// WHY (validation 3): the concurrency law has two conditions, and footprint
// disjointness is only the first. A seam the parent could not reduce to a code-checkable
// kind (http/data-schema — no code predicate yet) cannot gate the pair's parallel merge,
// so it must force serialization EVEN when their footprints are disjoint. A checkable seam
// between the same disjoint pair leaves them parallel. This is the seam-checkability
// forcing function in the scheduler; without it, two siblings would merge across an
// unverifiable seam.
describe('an uncheckable seam forces serialization (concurrency-law condition 2)', () => {
  const disjoint = {
    a: { writeGlobs: ['src/a/**'] },
    b: { writeGlobs: ['src/b/**'] },
  };
  // A seam over a checkable kind (interface) vs an uncheckable one (http), with
  // arbitrary producer/consumer. Payloads are valid per kind; only `kind`/endpoints
  // matter to the scheduler.
  function interfaceSeam(producer: string, consumer: string): SeamContract {
    return {
      id: 'seam-0',
      kind: 'interface',
      producer,
      consumer,
      payload: { symbol: 'X' },
      intent: '',
    };
  }
  function httpSeam(producer: string, consumer: string): SeamContract {
    return { id: 'seam-0', kind: 'http', producer, consumer, payload: {}, intent: '' };
  }

  test('a checkable seam between disjoint siblings stays parallel', () => {
    const layer = layerOf(disjoint, [interfaceSeam('a', 'b')]);
    expect(mayRunConcurrently(layer, 'a', 'b')).toBe(true);
    expect(buildSchedule(['a', 'b'], layer)).toEqual({ stages: [['a', 'b']] });
  });

  test('an uncheckable seam serializes disjoint siblings (either seam direction)', () => {
    const layer = layerOf(disjoint, [httpSeam('a', 'b')]);
    expect(mayRunConcurrently(layer, 'a', 'b')).toBe(false);
    expect(mayRunConcurrently(layer, 'b', 'a')).toBe(false);
    expect(buildSchedule(['a', 'b'], layer)).toEqual({ stages: [['a'], ['b']] });
  });

  test('an uncheckable seam to a THIRD sibling does not serialize an unrelated pair', () => {
    // c↔http↔a forces c after a, but b (disjoint, no uncheckable seam) still packs
    // with a. So a,b run together and c serializes — the forcing function is per-pair.
    const layer = layerOf({ ...disjoint, c: { writeGlobs: ['src/c/**'] } }, [httpSeam('a', 'c')]);
    expect(buildSchedule(['a', 'b', 'c'], layer)).toEqual({ stages: [['a', 'b'], ['c']] });
  });
});
