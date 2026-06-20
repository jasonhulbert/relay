import { describe, expect, test } from 'vitest';
import {
  FootprintViolation,
  footprintEscapes,
  footprintsDisjoint,
  globsIntersect,
} from './footprint';

// WHY: footprint disjointness is what LICENSES parallelism (A2). If `globsIntersect`
// were wrong, the scheduler would either serialize independent work (slow but safe)
// or — the dangerous direction — run conflicting siblings in parallel. These pin the
// exact glob semantics the scheduling decision rests on, so a change to the matcher
// that would let an overlapping pair read as disjoint fails here.
describe('globsIntersect — two globs share a concrete path', () => {
  test('sibling directory globs are disjoint', () => {
    expect(globsIntersect('part-1/**', 'part-2/**')).toBe(false);
    expect(globsIntersect('src/data/**', 'src/ui/**')).toBe(false);
  });

  test('identical and nested globs intersect', () => {
    expect(globsIntersect('part-1/**', 'part-1/**')).toBe(true);
    // `**` spans segments, so a parent dir overlaps a concrete descendant.
    expect(globsIntersect('src/**', 'src/data/widget.ts')).toBe(true);
    expect(globsIntersect('src/a/**', 'src/*/file.ts')).toBe(true);
  });

  test('intra-segment `*` distinguishes by the fixed parts', () => {
    expect(globsIntersect('a/*.ts', 'a/widget.ts')).toBe(true);
    expect(globsIntersect('a/*.ts', 'a/widget.js')).toBe(false);
    // Same directory, mutually exclusive extensions: no common file.
    expect(globsIntersect('*.ts', '*.js')).toBe(false);
  });

  test('a bare `**` matches any path', () => {
    expect(globsIntersect('**', 'any/deep/path.ts')).toBe(true);
  });
});

describe('footprintsDisjoint — the A2 condition-1 predicate', () => {
  test('disjoint when no glob pair can intersect', () => {
    expect(footprintsDisjoint({ writeGlobs: ['part-1/**'] }, { writeGlobs: ['part-2/**'] })).toBe(
      true,
    );
  });

  test('not disjoint when any glob pair overlaps', () => {
    expect(
      footprintsDisjoint(
        { writeGlobs: ['src/a/**', 'src/b/**'] },
        { writeGlobs: ['src/c/**', 'src/a/x.ts'] },
      ),
    ).toBe(false);
  });

  test('a footprint that writes nothing is disjoint from everything', () => {
    // The empty footprint touches no resource, so it can contend with nothing —
    // the floor case the scheduler must treat as parallelizable, not as a conflict.
    expect(footprintsDisjoint({ writeGlobs: [] }, { writeGlobs: ['anything/**'] })).toBe(true);
  });

  test('a shared named resource is NOT disjoint even when the writes never collide', () => {
    // The tier-A session is a shared resource (§7.3): two leaves that both hold it
    // contend even with disjoint write globs, so the scheduler must serialize them.
    expect(
      footprintsDisjoint(
        { writeGlobs: ['v1/**'], resources: ['tier-a-session'] },
        { writeGlobs: ['v2/**'], resources: ['tier-a-session'] },
      ),
    ).toBe(false);
  });

  test('disjoint when writes AND named resources are both disjoint', () => {
    expect(
      footprintsDisjoint(
        { writeGlobs: ['v1/**'], resources: ['port:3000'] },
        { writeGlobs: ['v2/**'], resources: ['port:3001'] },
      ),
    ).toBe(true);
  });
});

describe('footprintEscapes — the A3 loud-violation detector', () => {
  test('flags writes outside the declared globs, passes those inside', () => {
    const declared = { writeGlobs: ['allowed/**'] };
    expect(footprintEscapes(declared, ['allowed/x.ts', 'allowed/deep/y.ts'])).toEqual([]);
    expect(footprintEscapes(declared, ['allowed/x.ts', 'forbidden/y.ts'])).toEqual([
      'forbidden/y.ts',
    ]);
  });

  test('a write under a footprint that declared nothing escapes', () => {
    // "Declared to write nothing, but wrote something" is itself the loud violation
    // — the footprint is a hint the execution contradicted (A3).
    expect(footprintEscapes({ writeGlobs: [] }, ['CHANGE.txt'])).toEqual(['CHANGE.txt']);
  });
});

describe('FootprintViolation', () => {
  test('names the node and the escaping paths so the reason is never silent', () => {
    const v = new FootprintViolation('leaf-1', ['forbidden/x.ts']);
    expect(v).toBeInstanceOf(Error);
    expect(v.nodeId).toBe('leaf-1');
    expect(v.escapes).toEqual(['forbidden/x.ts']);
    expect(v.message).toContain('leaf-1');
    expect(v.message).toContain('forbidden/x.ts');
    // The recorded narrative says it was absorbed by the ladder (A3), so a reader of
    // the attempt evidence sees both the violation and how it was handled.
    expect(v.report()).toContain('escalation ladder');
  });
});
