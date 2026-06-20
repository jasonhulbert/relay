import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import { STUB_USAGE, stubCapabilities } from './executor';
import { TIER_A_SESSION } from './footprint';
import type { Executor } from './executor';
import type { Brain } from './brain';
import { atomicWriteFile, readNode, writeManifest, writeNode } from '../relay-state/index';
import type {
  CriticSpawn,
  CriticVerdict,
  Footprint,
  NodeRecord,
  RootManifest,
} from '../relay-state/index';

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-conc-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

// A childless branch root so branch-activation decomposition fires and the brain's
// footprints land in a layer manifest the scheduler then reads.
async function seedChildlessBranch(relayDir: string): Promise<void> {
  const spec = {
    outcome: 'compose the layer',
    verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
  };
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

// A brain that decomposes into N leaf siblings with the given footprints, so a test
// fixes the exact footprints the scheduling decision rests on.
function leavesWithFootprints(footprints: Footprint[]): Brain {
  return {
    decompose: () =>
      Promise.resolve({
        children: footprints.map((footprint, i) => ({
          spec: {
            outcome: `part ${(i + 1).toString()}`,
            verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
          },
          kind: 'leaf' as const,
          footprint,
        })),
        seams: [],
      }),
  };
}

// A brain that decomposes into two disjoint-footprint leaves WITH an uncheckable
// (http, no v0.1 predicate) seam between them — so the scheduler's footprint check
// says "parallel" but the F3 forcing function must override it to serial.
function twoLeavesWithUncheckableSeam(): Brain {
  return {
    decompose: () =>
      Promise.resolve({
        children: [0, 1].map((i) => ({
          spec: {
            outcome: `part ${(i + 1).toString()}`,
            verifications: [{ kind: 'command' as const, grounding: 'exit 0', check: 'true' }],
          },
          kind: 'leaf' as const,
          footprint: { writeGlobs: [`part-${(i + 1).toString()}/**`] },
        })),
        seams: [
          {
            id: 'seam-0',
            kind: 'http' as const,
            producer: 0,
            consumer: 1,
            payload: {},
            intent: 'part 1 serves part 2 over http (no v0.1 predicate)',
          },
        ],
      }),
  };
}

// An executor that records the peak number of concurrently-running dispatches. It
// holds each attempt "open" across several event-loop turns; siblings dispatched in
// one parallel stage overlap that window (peak 2), while siblings split into serial
// stages never do (peak 1).
function concurrencyProbe(): { executor: Executor; peak: () => number } {
  let active = 0;
  let peak = 0;
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  const executor: Executor = {
    capabilities: () => stubCapabilities,
    async run({ worktree }) {
      active += 1;
      peak = Math.max(peak, active);
      for (let k = 0; k < 5; k += 1) await tick();
      await mkdir(worktree, { recursive: true });
      await atomicWriteFile(join(worktree, 'CHANGE.txt'), 'change\n');
      active -= 1;
      return {
        diff: 'A CHANGE.txt\n+change',
        selfReport: 'probe attempt',
        usage: STUB_USAGE,
        exitStatus: 0,
      };
    },
  };
  return { executor, peak: () => peak };
}

// An executor whose reported write footprint is scripted per attempt: a `loud`
// attempt reports a write OUTSIDE the leaf's declared footprint (the A3 loud
// violation), an `ok` attempt reports an in-footprint write. The final entry repeats.
function footprintScriptedExecutor(script: ('loud' | 'ok')[]): Executor {
  let call = 0;
  return {
    capabilities: () => stubCapabilities,
    async run({ worktree }) {
      const kind = script[Math.min(call, script.length - 1)];
      call += 1;
      await mkdir(worktree, { recursive: true });
      await atomicWriteFile(join(worktree, 'CHANGE.txt'), 'change\n');
      return {
        diff: 'A CHANGE.txt\n+change',
        selfReport: 'scripted attempt',
        usage: STUB_USAGE,
        exitStatus: 0,
        writes: kind === 'loud' ? ['forbidden/x.ts'] : ['allowed/x.ts'],
      };
    },
  };
}

describe('the scheduler runs disjoint siblings in parallel, serializes a shared resource (A2)', () => {
  // WHY (validation 1): the whole point of the phase. Two siblings the parent
  // declared to write disjoint paths must actually run at the same time — proven by
  // observing both dispatches open concurrently, not by inspecting the schedule.
  test('two disjoint-footprint siblings run in parallel', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const { executor, peak } = concurrencyProbe();
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['part-1/**'] }, { writeGlobs: ['part-2/**'] }]),
        executor,
        workRoot,
      });

      expect(peak()).toBe(2); // the two leaves overlapped — real concurrency
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (validation 3): A2's second condition. Two siblings with DISJOINT footprints
  // — which the footprint check alone would parallelize — must still serialize when
  // the seam between them is a kind with no v0.1 predicate (F3 forcing function). The
  // probe must observe NO overlap, proving the uncheckable seam, not the footprints,
  // drove the decision. Without the forcing function this would read peak 2.
  test('an uncheckable seam between disjoint siblings forces serialization', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const { executor, peak } = concurrencyProbe();
      const res = await runOrchestrator(relayDir, 'root', {
        brain: twoLeavesWithUncheckableSeam(),
        executor,
        workRoot,
      });

      expect(peak()).toBe(1); // disjoint footprints, but the http seam serialized them
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (validation 1, falsifiable half): a shared resource is exactly what A2
  // forbids running concurrently. The same probe must observe NO overlap — the
  // siblings serialized — while both still complete.
  test('a shared-resource pair serializes', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const { executor, peak } = concurrencyProbe();
      const res = await runOrchestrator(relayDir, 'root', {
        // Both leaves declare the same resource → not disjoint → serialize.
        brain: leavesWithFootprints([{ writeGlobs: ['shared/**'] }, { writeGlobs: ['shared/**'] }]),
        executor,
        workRoot,
      });

      expect(peak()).toBe(1); // never overlapped — they serialized
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (validation 3): the tier-A session is a shared resource (design §7.3) — there
  // is one logged-in headed session, so two visual leaves that both drive it cannot
  // run concurrently even though they write disjoint repo paths. The contention is a
  // NAMED resource in the footprint, not a write-glob collision, so this proves the
  // scheduler serializes on resource contention, not just on overlapping writes: the
  // probe must observe NO overlap while both leaves still complete. Without resource-
  // aware disjointness this would read peak 2 and two leaves would fight over the session.
  test('two visual leaves contending on the tier-A session serialize', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const { executor, peak } = concurrencyProbe();
      const res = await runOrchestrator(relayDir, 'root', {
        // Disjoint write globs, but both hold the shared tier-A session → not disjoint
        // → serialize.
        brain: leavesWithFootprints([
          { writeGlobs: ['v1/**'], resources: [TIER_A_SESSION] },
          { writeGlobs: ['v2/**'], resources: [TIER_A_SESSION] },
        ]),
        executor,
        workRoot,
      });

      expect(peak()).toBe(1); // the shared session serialized them despite disjoint writes
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Two leaves, each writing one repo-relative file with scripted content, branching on
// the child's spec outcome (`part 1` → `a/v.txt`, `part 2` → `b/v.txt`). Each reports
// its single in-footprint write, so the merged tree composes the two files and the gate
// has a real WAL footprint to verify.
function twoFileExecutor(c0Content: string, c1Content: string): Executor {
  return {
    capabilities: () => stubCapabilities,
    async run({ worktree, spec }) {
      const isFirst = spec.outcome.includes('part 1');
      const rel = isFirst ? 'a/v.txt' : 'b/v.txt';
      const content = isFirst ? c0Content : c1Content;
      await mkdir(join(worktree, dirname(rel)), { recursive: true });
      await atomicWriteFile(join(worktree, rel), content);
      return {
        diff: `A ${rel}\n+${content}`,
        selfReport: `wrote ${rel}`,
        usage: STUB_USAGE,
        exitStatus: 0,
        writes: [rel],
      };
    },
  };
}

// A critic that grades the COMPOSITION of the two leaves' outputs. Handed a child's own
// worktree (only one of the two files present) it passes — each child's diff is fine in
// isolation, exactly the per-child judgment the gate cannot rely on. Handed the merged
// tree (both files present) it grades their agreement: the silent semantic conflict is
// the two outputs disagreeing even though they merged cleanly onto disjoint paths.
function compositionCritic(): CriticSpawn {
  const read = async (worktree: string, rel: string): Promise<string | null> => {
    try {
      return await readFile(join(worktree, rel), 'utf8');
    } catch {
      return null;
    }
  };
  return async (_view, ctx): Promise<CriticVerdict> => {
    const a = await read(ctx.worktree, 'a/v.txt');
    const b = await read(ctx.worktree, 'b/v.txt');
    if (a === null || b === null) {
      return {
        pass: true,
        provider: 'composition-critic',
        rationale: 'child output graded in isolation',
        evidenceRefs: [],
      };
    }
    const pass = a === b;
    return {
      pass,
      provider: 'composition-critic',
      rationale: pass
        ? 'merged outputs agree'
        : `merged outputs are semantically incompatible: ${a.trim()} vs ${b.trim()}`,
      evidenceRefs: [],
    };
  };
}

describe('the integration gate verifies a concurrent layer before it may be done (A4)', () => {
  // WHY (validation 1): the silent-conflict catch — the entire reason concurrency must
  // pay for a gate. Two leaves run in parallel, each forking from the same base, each
  // critic-passing its own diff in isolation; their writes merge cleanly onto disjoint
  // paths, yet their COMBINATION is semantically incompatible. No per-child critic saw
  // it. The branch must NOT be `done`: the parent's own critic on the merged whole
  // catches it and the branch halts-and-surfaces blocked. Without the gate this reads
  // `done` — the exact silent hole the system forbids.
  test('two diffs that merge cleanly but are semantically incompatible are caught by the critic layer', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['a/**'] }, { writeGlobs: ['b/**'] }]),
        executor: twoFileExecutor('one', 'two'), // disagree → incompatible composition
        critic: compositionCritic(),
        workRoot,
      });

      // The two leaves each reached done (their isolated critics passed)...
      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      // ...but the merged layer failed the parent's critic, so the branch is blocked,
      // not done, with the gate's reason surfaced.
      expect(res.rootStatus).toBe('blocked');
      const root = await readNode(relayDir, 'root');
      expect(root.blocked?.reason).toContain('integration gate');
      expect(root.blocked?.reason).toContain('critic');
      expect(root.blocked?.criticReason).toContain('incompatible');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (validation 2): the falsifiable half — a compatible concurrent layer must pass
  // the gate cleanly and reach `done`. Same two parallel leaves, but their outputs now
  // agree, so the merged whole satisfies the parent's critic. Proves the gate is not
  // simply a blanket block on concurrency: it certifies a real composition.
  test('a compatible concurrent pair passes the gate and the branch is done', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['a/**'] }, { writeGlobs: ['b/**'] }]),
        executor: twoFileExecutor('same', 'same'), // agree → compatible composition
        critic: compositionCritic(),
        workRoot,
      });

      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.leafStatuses['root.c1']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (validation 1, falsifiable third half): a SERIAL layer must not run the gate —
  // its single child's critic already saw the only state that existed. The same
  // composition critic that would block a disagreeing merged pair must leave a serial
  // branch `done`, because there is no merged whole to re-grade. (Two children sharing a
  // footprint serialize, so the gate's concurrency precondition is never met.)
  test('a serial layer is not gated — its child critic already certified the only state', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        // Overlapping footprints → not disjoint → serial; the two `**` writes stay
        // in-footprint, so neither leaf is a loud violation, yet they never co-grade.
        brain: leavesWithFootprints([{ writeGlobs: ['**'] }, { writeGlobs: ['**'] }]),
        executor: twoFileExecutor('one', 'two'),
        critic: compositionCritic(),
        workRoot,
      });

      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('a loud footprint violation is thrown and absorbed by the ladder (A3)', () => {
  // WHY (validation 2): the footprint is a hint, not a sandbox. A child that writes
  // outside its declared footprint must NOT crash the orchestrator and must NOT be
  // silently accepted — the violation is thrown, the ladder absorbs it as a failed
  // attempt, and (caps exhausted) the leaf is terminally blocked with the reason
  // surfaced to root. If the throw escaped unhandled, `runOrchestrator` would reject
  // here instead of returning a blocked result.
  test('a persistent violation is absorbed and ends blocked, with the reason surfaced', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['allowed/**'] }]),
        executor: footprintScriptedExecutor(['loud']),
        workRoot,
        caps: {
          maxAttempts: 1,
          maxTokens: Number.MAX_SAFE_INTEGER,
          maxWallClockMs: Number.MAX_SAFE_INTEGER,
        },
      });

      expect(res.leafStatuses['root.c0']).toBe('blocked');
      expect(res.rootStatus).toBe('blocked');

      // The violation is surfaced, not swallowed: the blocked record carries it, and
      // the attempt's self-report evidence records what the loud violation was.
      const leaf = await readNode(relayDir, 'root.c0');
      expect(leaf.blocked?.criticReason).toContain('footprint');
      const selfReport = await readFile(
        join(relayDir, 'evidence', 'run-1', 'root.c0', 'self-report.md'),
        'utf8',
      );
      expect(selfReport).toContain('forbidden/x.ts');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: "absorbed by the ladder" means the ladder's own escalation handles it. A
  // violation on the first attempt that the executor then corrects must be recovered
  // by the retry rung — the leaf reaches `done`, proving the loud violation is
  // correctable by execution exactly like leaf-sizing, not a hard failure.
  test('a violation the next attempt corrects is recovered via the retry rung', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedChildlessBranch(relayDir);
      const res = await runOrchestrator(relayDir, 'root', {
        brain: leavesWithFootprints([{ writeGlobs: ['allowed/**'] }]),
        executor: footprintScriptedExecutor(['loud', 'ok']),
        workRoot,
      });

      expect(res.leafStatuses['root.c0']).toBe('done');
      expect(res.rootStatus).toBe('done');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
