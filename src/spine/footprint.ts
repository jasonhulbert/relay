// Footprint primitives for the concurrency law (design §3.8, A2/A3, M10 Phase 1).
// A child's footprint is its predicted resource use — in v0.1 the repo-relative
// write globs it will touch (`Footprint.writeGlobs`). Two structural facts come
// out of a footprint:
//
//   - DISJOINTNESS schedules concurrency (A2): a layer's siblings may run in
//     parallel only if their footprints are provably disjoint. `footprintsDisjoint`
//     is the predicate; it answers from the declared globs alone (Rule 5 — code
//     decides, not a model).
//   - The footprint is a HINT, not a sandbox (A3): it schedules, it does not
//     guarantee correctness. A child whose ACTUAL writes escape its declared
//     footprint is a *loud* violation — `footprintEscapes` finds the offending
//     paths and the orchestrator throws `FootprintViolation`, which the escalation
//     ladder absorbs as a failed attempt (the loud-violation catch; the silent one
//     is the integration gate, a later phase).
//
// Glob support is segment-wise `**` (zero or more whole path segments) and `*`
// (zero or more non-`/` chars within one segment) plus literals — the subset the
// brain pins in `writeGlobs`. The disjointness test is an exact two-pattern
// intersection: disjoint iff no concrete repo path is matched by a glob on each
// side. The bias on the unknown is serial (A1): a footprint that cannot be proven
// disjoint is treated as overlapping by the scheduler, never optimistically parallel.
import type { Footprint } from '../relay-state/index';

// Split a glob (or a concrete path) into path segments, dropping the noise that
// would otherwise read as a spurious segment: a leading `./`, a leading `/`, and
// empty segments from a trailing or doubled slash. Segments themselves keep their
// intra-segment `*` wildcards for `segmentsIntersect`.
function segments(glob: string): string[] {
  return glob
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

// Do two single-segment patterns (literals with `*` wildcards, no `/`) match a
// common string? Exact two-sided wildcard intersection: `*` matches a run of zero
// or more chars on either side. Memoized over (i, j) to stay linear in practice.
function segmentsIntersect(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const key = (i: number, j: number): number => i * (b.length + 1) + j;
  const rec = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true;
    // One side exhausted: the other matches only if all it has left is `*`s
    // (each absorbing zero chars).
    if (i === a.length) return [...b.slice(j)].every((c) => c === '*');
    if (j === b.length) return [...a.slice(i)].every((c) => c === '*');
    const cached = memo.get(key(i, j));
    if (cached !== undefined) return cached;
    let out: boolean;
    const ca = a[i];
    const cb = b[j];
    if (ca === '*') {
      // `*` absorbs zero chars (advance a) or one the other side accounts for
      // (advance b, keep `*`).
      out = rec(i + 1, j) || rec(i, j + 1);
    } else if (cb === '*') {
      out = rec(i, j + 1) || rec(i + 1, j);
    } else {
      out = ca === cb && rec(i + 1, j + 1);
    }
    memo.set(key(i, j), out);
    return out;
  };
  return rec(0, 0);
}

// Do two globs share a concrete path? Exact intersection over segments, with `**`
// the cross-segment wildcard (zero or more whole segments on either side). A
// concrete path passed as one argument has no wildcards, so this doubles as
// "does this glob match this path" (used by `footprintEscapes`).
export function globsIntersect(g1: string, g2: string): boolean {
  const a = segments(g1);
  const b = segments(g2);
  const memo = new Map<number, boolean>();
  const key = (i: number, j: number): number => i * (b.length + 1) + j;
  const rec = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) return true;
    if (i === a.length) return b.slice(j).every((s) => s === '**');
    if (j === b.length) return a.slice(i).every((s) => s === '**');
    const cached = memo.get(key(i, j));
    if (cached !== undefined) return cached;
    let out: boolean;
    const ha = a[i];
    const hb = b[j];
    if (ha === '**' || hb === '**') {
      // A `**` matches zero segments (advance past it) or one more concrete
      // segment the other side accounts for (advance the other side, keep `**`).
      out = rec(i + 1, j) || rec(i, j + 1);
    } else {
      out = segmentsIntersect(ha, hb) && rec(i + 1, j + 1);
    }
    memo.set(key(i, j), out);
    return out;
  };
  return rec(0, 0);
}

// The shared tier-A session resource (design §7.3): the single logged-in headed
// session a visual leaf drives. A leaf that contends on it names it in its
// footprint's `resources`, so two such leaves are not disjoint and the scheduler
// serializes them (A2) — the visual-kind specialization of "shared resource ⇒
// serial" (§3.8, M10 Phase 4).
export const TIER_A_SESSION = 'tier-a-session';

// Are two footprints disjoint — can no concrete repo path be written by both
// children AND do they contend on no common named resource (A2 condition 1)? A
// footprint that writes nothing (no globs) and names no resource is disjoint from
// everything. Otherwise disjoint iff no write-glob pair can intersect AND the two
// resource sets share no member — a shared resource (e.g. the tier-A session) is
// exactly what A2 forbids running concurrently, even with non-colliding writes.
export function footprintsDisjoint(a: Footprint, b: Footprint): boolean {
  for (const ga of a.writeGlobs) {
    for (const gb of b.writeGlobs) {
      if (globsIntersect(ga, gb)) return false;
    }
  }
  const aResources = new Set(a.resources ?? []);
  for (const rb of b.resources ?? []) {
    if (aResources.has(rb)) return false;
  }
  return true;
}

// The actual write paths that escape a declared footprint (A3): a repo-relative
// path matched by none of the declared globs. A footprint declaring no globs is
// "writes nothing", so any actual write escapes it. This is the loud-violation
// detector the orchestrator runs against a leaf's intent-journal write footprint.
export function footprintEscapes(declared: Footprint, actualWrites: readonly string[]): string[] {
  return actualWrites.filter((w) => !declared.writeGlobs.some((g) => globsIntersect(g, w)));
}

// A loud footprint violation (A3): a child touched a resource outside its declared
// footprint (here, wrote a path outside its globs), or an executor raised a loud
// runtime clash (a bound port, an unavailable tool). It is THROWN at the dispatch
// seam and ABSORBED by the escalation ladder as a failed attempt — correctness is
// held by structure, not by the footprint being right. Self-sufficient so the
// reason survives into the attempt's recorded evidence (never silently swallowed).
export class FootprintViolation extends Error {
  constructor(
    readonly nodeId: string,
    readonly escapes: readonly string[],
  ) {
    super(
      `node \`${nodeId}\` wrote outside its declared footprint: ${escapes.join(', ') || '(unknown)'}`,
    );
    this.name = 'FootprintViolation';
  }

  // The narrative recorded as the failed attempt's self-report (orchestrator-only),
  // so a reader sees what the loud violation was even after the ladder absorbs it.
  report(): string {
    return `Loud footprint violation: ${this.message}. Absorbed by the escalation ladder as a failed attempt (A3).`;
  }
}
