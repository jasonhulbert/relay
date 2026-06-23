import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { arbLayerManifest } from './arbitraries';
import { deserializeLayer, readLayer, serializeLayer, tryReadLayer, writeLayer } from './layer';

// The layer manifest is the child-manifest of the one layer a branch decomposed:
// the footprints + seam graph the scheduler and the failure rule read back. If it
// cannot round-trip faithfully, the structural facts a rehydrated orchestrator
// depends on are corrupted — so it must survive write/read as faithfully as a node
// file.
describe('layer manifest round-trip', () => {
  test('survives write-then-read with no field loss', async () => {
    await fc.assert(
      fc.asyncProperty(arbLayerManifest, async (manifest) => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-layer-'));
        try {
          await writeLayer(dir, manifest);
          expect(await readLayer(dir, manifest.parentId)).toEqual(manifest);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  test('serialize/deserialize is lossless in memory', () => {
    fc.assert(
      fc.property(arbLayerManifest, (manifest) => {
        expect(deserializeLayer(serializeLayer(manifest))).toEqual(manifest);
      }),
      { numRuns: 200 },
    );
  });
});

// A branch that was never decomposed (hand-seeded, or not yet activated) has no
// layer manifest; reading it is a normal absence, not an error.
describe('tryReadLayer', () => {
  test('returns null for an undecomposed branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-layer-'));
    try {
      expect(await tryReadLayer(dir, 'never-decomposed')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
