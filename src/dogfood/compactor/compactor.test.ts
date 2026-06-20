import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingIntents, readManifest, readNode, tryReadLayer } from '../../relay-state/index';
import { commitRoot } from '../../intake/index';
import { compactorSeed } from './seed';
import { GOLDEN, buildCompactorFixture } from './fixture';

// Phase 1 validation criterion 1: "The outcome spec and grounding are committed via
// intake." The compactor seed is compiled through the REAL intake compiler and
// committed by the REAL `commitRoot` — the same path a live conversation takes — so
// this is the falsifiable "spec+grounding commit via intake" claim, hermetic and
// deterministic (no live model).
describe('the compactor outcome spec and grounding commit via intake', () => {
  test('the seed compiles and commits as a childless root carrying every grounded check', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-seed-'));
    const relayDir = join(base, '.relay');
    try {
      // The seed parses through intake's own validation (which rejects an ungrounded
      // check, §6) — so a successful compile already proves every check is grounded.
      const seed = compactorSeed();
      expect(seed.spec.outcome).toMatch(/compactor/i);
      // Five grounded facets: live-ref retention, orphan drop, retained compression,
      // manifest write, baseline-store exclusion (D2 / F2).
      expect(seed.spec.verifications).toHaveLength(5);
      expect(seed.spec.verifications.every((v) => v.grounding.trim() !== '')).toBe(true);
      expect(seed.spec.verifications.every((v) => v.kind === 'test')).toBe(true);
      // The baseline-store exclusion facet is present and grounded (F2) — the one the
      // compactor must honor even though baselines do not exist until M8.
      expect(seed.spec.verifications.some((v) => /baseline[- ]store/i.test(v.grounding))).toBe(
        true,
      );

      const { rootId } = await commitRoot(relayDir, seed, {
        createdAt: '2026-06-19T00:00:00.000Z',
      });

      // The committed root carries the outcome spec and grounded verifications verbatim.
      const manifest = await readManifest(relayDir);
      expect(manifest.spec).toEqual(seed.spec);

      // Intake commits NO binding decomposition: the root is a childless pending branch
      // with no layer manifest (the brain owns the first layer at activation), and the
      // commit is one clean atomic transaction (C8) — no pending intent left behind.
      const root = await readNode(relayDir, rootId);
      expect(root.kind).toBe('branch');
      expect(root.status).toBe('pending');
      expect(root.children).toEqual([]);
      expect(await tryReadLayer(relayDir, rootId)).toBeNull();
      expect(await pendingIntents(relayDir, rootId)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// Phase 1 validation criterion 2: "The fixture enumerates which refs are live, which
// are orphaned, and which baseline-store paths must be untouched." These assert that
// GOLDEN is internally consistent AND that it matches what the fixture actually
// materializes — so Phase 2 can trust GOLDEN as the graded contract.
describe('the compactor fixture enumerates live refs, orphans, and untouched baselines', () => {
  test('GOLDEN is internally consistent: live and orphans disjoint, retained == live', () => {
    expect(GOLDEN.liveRefs.length).toBeGreaterThan(0);
    expect(GOLDEN.orphanedCaptures.length).toBeGreaterThan(0);
    expect(GOLDEN.untouchedBaselinePaths.length).toBeGreaterThan(0);

    // A capture cannot be both live and orphaned.
    const live = new Set(GOLDEN.liveRefs);
    expect(GOLDEN.orphanedCaptures.some((p) => live.has(p))).toBe(false);

    // Retained-for-compression is exactly the live set (a live capture is retained).
    expect([...GOLDEN.retainedForCompression].sort()).toEqual([...GOLDEN.liveRefs].sort());
  });

  test('the built fixture matches GOLDEN: live refs come from node files, orphans are unreferenced, baselines sit outside .relay/', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-compactor-fixture-'));
    try {
      const fx = await buildCompactorFixture(base);

      // "Which refs are live" — collect every evidence ref recorded across the node
      // files and assert it equals GOLDEN.liveRefs. The enumeration is grounded in the
      // actual `.relay/` records, not asserted alongside them.
      const refPaths: string[] = [];
      for (const id of ['root', 'leaf-a', 'leaf-b']) {
        const n = await readNode(fx.relayDir, id);
        for (const r of n.evidenceRefs) refPaths.push(r.path);
      }
      expect([...refPaths].sort()).toEqual([...GOLDEN.liveRefs].sort());

      // Every live capture exists on disk under the evidence dir and is reachable.
      for (const p of GOLDEN.liveRefs) {
        expect((await stat(join(fx.evidenceDir, p))).isFile()).toBe(true);
      }

      // "Which are orphaned" — each orphan exists on disk but is named by NO live ref.
      const liveSet = new Set(refPaths);
      for (const p of GOLDEN.orphanedCaptures) {
        expect((await stat(join(fx.evidenceDir, p))).isFile()).toBe(true);
        expect(liveSet.has(p)).toBe(false);
      }

      // "Which baseline-store paths must be untouched" — each exists in the baseline
      // store, and the store is a SIBLING of `.relay/` (a scan of `.relay/` cannot
      // reach it), so excluding baselines from compaction is structural (F2).
      const rel = relative(fx.relayDir, fx.baselineStoreDir);
      expect(rel.startsWith('..')).toBe(true);
      for (const p of GOLDEN.untouchedBaselinePaths) {
        const abs = join(fx.baselineStoreDir, p);
        expect((await stat(abs)).isFile()).toBe(true);
        // Content-addressed: the path's hash segment is the sha256 of the content.
        const body = await readFile(abs, 'utf8');
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256').update(body).digest('hex');
        expect(p).toContain(hash);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
