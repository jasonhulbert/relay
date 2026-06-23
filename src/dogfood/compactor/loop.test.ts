// Phase 2 validation criterion 3: "The full loop completes from intake to `done` for
// this outcome." This is the dogfood headline — the FIRST real-work outcome driven
// through the spine's own loop (design §12 / D2): the committed compactor seed is
// compiled by the REAL intake compiler, committed by the REAL `commitRoot`, decomposed,
// executed, and gated by the REAL cross-provider critic running the committed
// `test`-kind checks. The loop reaches `done` ONLY because the compactor those checks
// exercise is actually correct — break the compactor and the critic's deterministic
// stage fails, the leaf blocks, and the root never reaches `done`. That coupling is the
// dogfood's whole point.
//
// What is hermetic vs. real here: the intake compile + commit, the orchestrator state
// machine, the brain decomposition, and the critic's DETERMINISTIC verification stage
// (the five `vitest run dogfood/compactor -t "…"` checks) are all real. Only the
// critic's cross-provider MODEL stage is stubbed (an injected `invoke` returning a PASS
// verdict), because shelling to a live provider would make the test non-hermetic and
// cost money — exactly how the other spine tests inject the model boundary.
//
// The one stand-in worth naming: in a real run a leaf's worktree IS a git checkout of
// the project, so `vitest run dogfood/compactor` resolves the suite naturally. Here the
// executor writes a root-redirect vitest config into its sandbox to emulate that
// checkout hermetically, so the committed checks run against the repo's real compactor.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readNode } from '../../relay-state/index';
import { commitRoot, compileSeed } from '../../intake/index';
import { agentCritic, runOrchestrator, STUB_USAGE } from '../../spine/index';
import type { Executor, ExecutorInput, ExecutorResult } from '../../spine/index';
import type { Brain, DecomposeRequest, DecomposeResult } from '../../spine/index';
import { COMPACTOR_SEED_MESSAGE } from './seed';

// The repo root, derived from this file's location (independent of cwd): the leaf
// worktree's redirect config points vitest's `root` here so the committed checks
// resolve the real compactor suite.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A one-leaf brain: decompose the childless committed root into a SINGLE leaf carrying
// the root's exact verifications (the five compactor `test` checks), so the critic
// grades that leaf against the committed spec. Deterministic, like `stubBrain`.
const oneLeafBrain: Brain = {
  decompose(req: DecomposeRequest): Promise<DecomposeResult> {
    return Promise.resolve({
      decomposition: {
        children: [{ spec: req.spec, kind: 'leaf', footprint: { writeGlobs: ['**'] } }],
        seams: [],
      },
      rationale: 'single leaf carrying the root verifications (compactor dogfood)',
    });
  },
};

// The executor stand-in: it "produces the compactor" by making its sandbox resolve the
// project's compactor suite (the root-redirect config), so the critic's committed
// `vitest run dogfood/compactor` checks run against the real compactor and its manifest.
function checkoutEmulatingExecutor(repoRoot: string): Executor {
  return {
    capabilities: () => ({
      provider: 'dogfood',
      json: false,
      resume: false,
      sandbox: true,
      mcp: false,
    }),
    async run({ worktree }: ExecutorInput): Promise<ExecutorResult> {
      await mkdir(worktree, { recursive: true });
      // A plain-object config (no package import) so it resolves from a worktree
      // anywhere; `root` redirects vitest to the repo, where the compactor lives.
      const config = `export default {\n  root: ${JSON.stringify(repoRoot)},\n  test: { testTimeout: 20000 },\n};\n`;
      await writeFile(join(worktree, 'vitest.config.ts'), config, 'utf8');
      return {
        diff: 'A src/dogfood/compactor/compactor.ts\n+the evidence-directory compactor and its manifest',
        selfReport: 'Produced the evidence compactor; its golden and property suite is green.',
        usage: STUB_USAGE,
        exitStatus: 0,
      };
    },
  };
}

// The cross-provider critic's MODEL stage, stubbed to PASS. The DETERMINISTIC stage
// (the five committed checks) runs for real first; this only stands in for the live
// Codex review the harness would otherwise shell out to.
function codexPassInvoke(): Promise<{ stdout: string; code: number }> {
  return Promise.resolve({
    stdout: [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'all deterministic checks passed\nVERDICT: PASS' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }),
    ].join('\n'),
    code: 0,
  });
}

describe('the compactor dogfood runs through the real loop from intake to done', () => {
  test('the committed seed decomposes, executes, and passes the critic on the test checks', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-loop-'));
    const relayDir = join(base, '.relay');
    const workRoot = join(base, 'worktrees');
    // Ensure the committed `vitest …` checks resolve the binary when the critic shells
    // out, regardless of how this outer suite was invoked.
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(REPO_ROOT, 'node_modules', '.bin')}:${prevPath ?? ''}`;
    try {
      // Intake: compile the seed through the REAL compiler and commit the root.
      const seed = compileSeed(COMPACTOR_SEED_MESSAGE);
      await commitRoot(relayDir, seed, { createdAt: '2026-06-19T00:00:00.000Z' });

      // The full loop: decompose → execute → critic (deterministic checks + model) →
      // done. The cross-provider critic runs the committed `test` checks for real.
      const result = await runOrchestrator(relayDir, 'root', {
        executor: checkoutEmulatingExecutor(REPO_ROOT),
        critic: agentCritic({ provider: 'codex', invoke: codexPassInvoke }),
        brain: oneLeafBrain,
        workRoot,
      });

      // The loop reached done from intake's committed root.
      expect(result.rootStatus).toBe('done');
      const leafId = 'root.c0';
      expect(result.leafStatuses[leafId]).toBe('done');

      // The leaf was certified by the independent critic on the test verifications —
      // not the executor's say-so — and that gate is what carried it (and the root) to
      // done.
      const leaf = await readNode(relayDir, leafId);
      expect(leaf.status).toBe('done');
      expect(leaf.verdict?.pass).toBe(true);
      expect(leaf.verdict?.provider).toBe('codex');
      expect(leaf.spec.verifications.every((v) => v.kind === 'test')).toBe(true);

      const root = await readNode(relayDir, 'root');
      expect(root.status).toBe('done');
    } finally {
      process.env.PATH = prevPath;
      await rm(base, { recursive: true, force: true });
    }
  });
});
