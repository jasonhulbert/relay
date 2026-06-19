import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { arbRootManifest } from './arbitraries';
import { deserializeManifest, readManifest, serializeManifest, writeManifest } from './manifest';

// The root manifest anchors the run (design §4); rehydration reads it to find
// the root node and spec, so it must round-trip as faithfully as a node file.
describe('root manifest round-trip', () => {
  test('survives write-then-read with no field loss', async () => {
    await fc.assert(
      fc.asyncProperty(arbRootManifest, async (manifest) => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-manifest-'));
        try {
          await writeManifest(dir, manifest);
          expect(await readManifest(dir)).toEqual(manifest);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  test('serialize/deserialize is lossless in memory', () => {
    fc.assert(
      fc.property(arbRootManifest, (manifest) => {
        expect(deserializeManifest(serializeManifest(manifest))).toEqual(manifest);
      }),
      { numRuns: 200 },
    );
  });
});
