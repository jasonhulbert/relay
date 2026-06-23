import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { arbOutcomeContract } from './arbitraries';
import {
  deserializeContract,
  readContract,
  serializeContract,
  tryReadContract,
  writeContract,
} from './contract';

// WHY this matters: the parent gates its own done-ness on the child's contract
// read back from the ledger (the verified outcome contract). If any field the
// writer emits is dropped or
// mangled on read — especially `criticCertified` — the parent would decide
// acceptance on a corrupted fact. The round-trip is the falsifiable guard.
describe('outcome contract round-trip', () => {
  test('survives write-then-read with no field loss, over arbitrary contracts', async () => {
    await fc.assert(
      fc.asyncProperty(arbOutcomeContract, async (contract) => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-contract-'));
        try {
          await writeContract(dir, contract);
          expect(await readContract(dir, contract.nodeId)).toEqual(contract);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 150 },
    );
  });

  test('serialize/deserialize is lossless without touching the filesystem', () => {
    fc.assert(
      fc.property(arbOutcomeContract, (contract) => {
        expect(deserializeContract(serializeContract(contract))).toEqual(contract);
      }),
      { numRuns: 300 },
    );
  });

  test('a missing contract reads back as null, not an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-contract-'));
    try {
      expect(await tryReadContract(dir, 'never-written')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('is written at the layout contracts/<id>.md path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-contract-'));
    try {
      await writeContract(dir, {
        nodeId: 'mid',
        runId: 'run-1',
        claimedOutcome: 'the subtree is done',
        criticCertified: true,
        verdictRefs: [{ runId: 'run-1', path: 'leaf-1/verdict.md', kind: 'verdict', summary: 'v' }],
        seamEvidence: [],
      });
      const raw = await readFile(join(dir, 'contracts', 'mid.md'), 'utf8');
      expect(raw.startsWith('---\n')).toBe(true);
      expect(raw).toContain('outcome contract');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
