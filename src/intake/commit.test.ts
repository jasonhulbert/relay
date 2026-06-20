import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readManifest, readNode, tryReadLayer } from '../relay-state/index';
import { runOrchestrator } from '../spine/orchestrator';
import { commitRoot } from './commit';
import { runIntake } from './session';
import type { Interviewer, AskHuman } from './session';
import type { IntakeSeed } from './seed';

// The seed a bounded interview distills (cf. `seed.test.ts`): a verifiable outcome,
// one grounded command verification, and a short non-binding sketch. Its `check` is
// the always-pass `true` so the stub executor/critic loop drives the committed run to
// done hermetically.
const SEED: IntakeSeed = {
  spec: {
    outcome: 'the CLI exits 0 and prints the parsed config as JSON',
    verifications: [{ kind: 'command', grounding: 'the smoke command exits 0', check: 'true' }],
  },
  sketch: { notes: ['reuse the existing yaml loader', 'keep the flag surface tiny'] },
};

// A scripted interviewer that grills once, then approves with the seed — exercising
// the Phase 1 → Phase 2 handoff: `runIntake` returns the seed at the `done` turn
// (approval) having run nothing, and Phase 2 commits what it returns.
function scriptedIntake(): { interviewer: Interviewer; ask: AskHuman } {
  let turn = 0;
  const interviewer: Interviewer = {
    next() {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({ done: false, question: 'what does done mean for this run?' });
      }
      return Promise.resolve({ done: true, seed: SEED });
    },
  };
  const ask: AskHuman = () => Promise.resolve('the CLI prints the parsed config and exits 0');
  return { interviewer, ask };
}

async function freshRelay(): Promise<{ base: string; relayDir: string; workRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'relay-intake-commit-'));
  return { base, relayDir: join(base, '.relay'), workRoot: join(base, 'worktrees') };
}

// Validation 1: after approval the committed root is activatable by the M2
// orchestrator and a run begins from it. Drives the interview to a seed, commits it,
// then activates the orchestrator on the committed root — which decomposes it (the
// brain owns the first layer at activation, NOT intake) and drives it to done. This
// is the falsifiable "the seed becomes a runnable root" claim, end-to-end and
// hermetic (stub brain/executor/critic).
describe('the committed root is activatable by the orchestrator', () => {
  test('a run begins from the committed root and reaches done', async () => {
    const { base, relayDir, workRoot } = await freshRelay();
    try {
      const { seed } = await runIntake(scriptedIntake());
      const { rootId } = await commitRoot(relayDir, seed, {
        createdAt: '2026-06-19T00:00:00.000Z',
      });

      // The orchestrator activates on the committed root with the default stubs.
      const res = await runOrchestrator(relayDir, rootId, { workRoot });

      expect(res.rootStatus).toBe('done');
      // Decomposition happened at ACTIVATION, not at intake: the root now points at
      // the children the brain produced when the run began.
      expect((await readNode(relayDir, rootId)).children.length).toBeGreaterThan(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Validation 2: no binding decomposition beyond the non-binding sketch is written at
// intake. Inspects the committed root BEFORE any orchestrator activation: the root is
// a childless branch with no layer manifest, while the spec and the sketch are
// durably present in the manifest. The only orientation intake commits is the
// `Sketch` — structurally incapable of carrying children/footprints/seams.
describe('intake commits no binding decomposition beyond the sketch', () => {
  test('the committed root is a childless branch carrying the spec and sketch', async () => {
    const { base, relayDir } = await freshRelay();
    try {
      const { rootId } = await commitRoot(relayDir, SEED, {
        createdAt: '2026-06-19T00:00:00.000Z',
      });

      // The non-binding sketch and the outcome spec are folded into the durable root.
      const manifest = await readManifest(relayDir);
      expect(manifest.sketch.notes).toEqual(SEED.sketch.notes);
      expect(manifest.spec).toEqual(SEED.spec);

      // The root is a pending branch the orchestrator can bind to and decompose...
      const root = await readNode(relayDir, rootId);
      expect(root.kind).toBe('branch');
      expect(root.status).toBe('pending');
      // ...with NO children and NO layer manifest: there is simply no decomposition
      // on disk to be binding (the brain authors the first layer at activation).
      expect(root.children).toEqual([]);
      expect(await tryReadLayer(relayDir, rootId)).toBeNull();

      // The root commit is one atomic intent-journal transaction (C8): a clean commit
      // leaves no pending intent in the root's region.
      expect(await pendingIntents(relayDir, rootId)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
