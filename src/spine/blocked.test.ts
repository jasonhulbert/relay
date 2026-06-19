import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readNode } from '../relay-state/index';
import type { Executor, ExecutorResult, RailCaps } from './index';
import {
  runOrchestrator,
  scriptedCritic,
  scriptedExecutor,
  seedFixture,
  stubCapabilities,
} from './index';

const ROOT_ID = 'root';
const LEAF_ID = 'leaf-1';

// A cap tight enough that persistent failure exhausts the ladder mid-walk instead
// of reaching the `promote` rung: three attempts walk retry + swap-provider, then
// the attempt cap halts before raise-tier/promote. (Default caps are generous so
// the same failure would promote, not block — design §3.7/§3.9.)
const TIGHT_CAPS: RailCaps = {
  maxAttempts: 3,
  maxTokens: Number.MAX_SAFE_INTEGER,
  maxWallClockMs: Number.MAX_SAFE_INTEGER,
};

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-blocked-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

// An executor that fails the test if it ever runs — used to prove a fresh
// orchestrator does NOT re-dispatch an already-blocked leaf.
const refusingExecutor: Executor = {
  capabilities: () => stubCapabilities,
  run(): Promise<ExecutorResult> {
    throw new Error('a blocked leaf must not be re-dispatched');
  },
};

// Every durable `.relay/` record as text, keyed by path. The journal is excluded
// (transient ids); pending intents are checked separately.
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

// WHY: this is the phase's reason to exist — when the ladder runs out, the loop
// must answer FAIL with a record a fresh orchestrator (and a human) can act on in
// one read, not throw or silently stop. A record that omitted the rungs spent or
// the standing critic reason would not be self-sufficient; one written under a
// non-atomic write could be torn by a crash. Each is a real failure this forces.
describe('ladder exhaustion writes a self-sufficient blocked record', () => {
  test('a tight attempt cap blocks the leaf, recording rungs spent and the standing reason', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      // Count dispatches to prove the ladder actually walked the lower rungs before
      // the cap halted it, rather than blocking on the first failure.
      let dispatches = 0;
      const counting: Executor = {
        capabilities: () => stubCapabilities,
        async run(input): Promise<ExecutorResult> {
          dispatches += 1;
          return scriptedExecutor({ signals: ['ok'] }).run(input);
        },
      };
      const critic = scriptedCritic({ results: ['fail'] });

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: counting,
        critic,
        caps: TIGHT_CAPS,
        workRoot,
      });

      expect(res.leafStatuses[LEAF_ID]).toBe('blocked');
      // Three attempts: initial + retry + swap-provider, then the attempt cap halts
      // before raise-tier/promote (so this blocks rather than promotes).
      expect(dispatches).toBe(3);

      const node = await readNode(relayDir, LEAF_ID);
      expect(node.status).toBe('blocked');
      expect(node.blocked).not.toBeNull();
      const record = node.blocked;
      if (!record) throw new Error('expected a blocked record');
      // The standing reason names the cap that halted the ladder...
      expect(record.reason).toContain('attempt');
      // ...the rungs actually spent are recorded as the audit trail...
      expect(record.rungsSpent).toEqual(['retry', 'swap-provider']);
      // ...the critic's standing reason is carried, not a generic placeholder...
      expect(record.criticReason).toContain('scripted critic returned fail');
      // ...and the human-facing summary is self-sufficient (names the node + reason).
      expect(record.humanFacing).toContain(LEAF_ID);
      expect(record.humanFacing).toContain('attempt');

      // The transition was atomic: no intent left dangling for roll-forward.
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: the record only earns "self-sufficient" if a fresh orchestrator reads it
  // in one pass and stops — re-running the ladder would burn the same metered spend
  // the cap was there to bound, and could never produce a different answer on the
  // same stubs. A wiring that re-dispatched a blocked leaf fails here loudly.
  test('a fresh orchestrator reads the blocked leaf in one pass without re-running the ladder', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      await runOrchestrator(relayDir, ROOT_ID, {
        executor: scriptedExecutor({ signals: ['ok'] }),
        critic: scriptedCritic({ results: ['fail'] }),
        caps: TIGHT_CAPS,
        workRoot,
      });
      const afterFirst = await collectRelay(relayDir);

      // Rehydrate with an executor that throws if invoked: reaching it would mean
      // the blocked leaf was wrongly re-dispatched.
      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: refusingExecutor,
        critic: scriptedCritic({ results: ['fail'] }),
        caps: TIGHT_CAPS,
        workRoot,
      });

      expect(res.leafStatuses[LEAF_ID]).toBe('blocked');
      expect(res.rootStatus).toBe('blocked');
      // Byte-identical terminal state: rehydration changed nothing.
      expect(await collectRelay(relayDir)).toEqual(afterFirst);
      expect(await pendingIntents(relayDir, ROOT_ID)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// WHY: doneness-failure must reach root with no route-around (design §3.7). If a
// branch could go `done` (or just sit `pending`) above a blocked child, the
// failure would be silently swallowed and a parent could integrate a subtree that
// never succeeded. The branch must instead HALT and surface the blocked fact
// upward. A propagation gate that let the parent reach `done` — or failed to mark
// it blocked — fails this test.
describe('doneness-failure propagates to root with no route-around', () => {
  test('a parent whose only child blocks becomes blocked itself, never done', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      await seedFixture(relayDir);

      const res = await runOrchestrator(relayDir, ROOT_ID, {
        executor: scriptedExecutor({ signals: ['ok'] }),
        critic: scriptedCritic({ results: ['fail'] }),
        caps: TIGHT_CAPS,
        workRoot,
      });

      expect(res.leafStatuses[LEAF_ID]).toBe('blocked');
      // The parent never reaches done, and surfaces the failure as its own status.
      expect(res.rootStatus).not.toBe('done');
      expect(res.rootStatus).toBe('blocked');

      const root = await readNode(relayDir, ROOT_ID);
      expect(root.status).toBe('blocked');
      expect(root.blocked).not.toBeNull();
      const record = root.blocked;
      if (!record) throw new Error('expected a blocked record on the parent');
      // The surfaced record names the blocked descendant and inherits its standing
      // reason, so a reader up the chain sees what is wrong without descending.
      expect(record.reason).toContain(LEAF_ID);
      expect(record.criticReason).toContain('scripted critic returned fail');
      expect(record.humanFacing).toContain(LEAF_ID);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
