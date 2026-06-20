import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runOrchestrator } from './orchestrator';
import { STUB_USAGE, stubCapabilities } from './executor';
import type { Executor } from './executor';
import type { Brain } from './brain';
import { atomicWriteFile, readNode, writeManifest, writeNode } from '../relay-state/index';
import type { Footprint, NodeRecord, RootManifest } from '../relay-state/index';

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
