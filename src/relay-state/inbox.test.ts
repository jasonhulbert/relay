import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { arbDecisionRecord } from './arbitraries';
import { deserializeDecision, readInbox, serializeDecision, writeDecision } from './inbox';
import type { DecisionRecord } from './types';

// WHY this matters: the decision inbox is durable state a rehydrated orchestrator
// reads to find pending human decisions. A note dropped or mangled
// in the codec would silently change what a cancellation reflection records, and a
// target-id corrupted on round-trip would mis-apply a decision to the wrong node.
// The round-trip is the falsifiable guard, fuzzed with YAML-hostile note text.
describe('decision record round-trip', () => {
  test('serialize/deserialize is lossless over arbitrary decisions', () => {
    fc.assert(
      fc.property(arbDecisionRecord, (d) => {
        expect(deserializeDecision(serializeDecision(d))).toEqual(d);
      }),
      { numRuns: 300 },
    );
  });
});

describe('reading the inbox region', () => {
  // WHY: an absent inbox is the normal state on a fresh run — the human has queued
  // nothing. It must read as empty, not throw, or every clean activation would die
  // before driving any work.
  test('an absent inbox directory reads as empty, not an error', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-inbox-'));
    try {
      expect(await readInbox(join(base, '.relay'))).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: drain order must be deterministic across rehydrations so a kill-and-resume
  // applies the same decisions in the same order; readInbox sorts by decisionId to
  // pin that, independent of filesystem listing order.
  test('written decisions are read back, sorted by decisionId', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-inbox-'));
    const relayDir = join(base, '.relay');
    try {
      const b: DecisionRecord = {
        decisionId: 'dec-b',
        kind: 'cancel',
        targetNodeId: 'leaf-2',
        note: null,
      };
      const a: DecisionRecord = {
        decisionId: 'dec-a',
        kind: 'cancel',
        targetNodeId: 'leaf-1',
        note: 'operator changed scope',
      };
      await writeDecision(relayDir, b);
      await writeDecision(relayDir, a);

      const back = await readInbox(relayDir);
      expect(back.map((d) => d.decisionId)).toEqual(['dec-a', 'dec-b']);
      expect(back[0]).toEqual(a);
      expect(back[1]).toEqual(b);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: a malformed decision must fail loud (Rule 11), not be silently skipped —
  // a dropped cancellation would let a subtree the human killed keep burning credit.
  test('an unknown decision kind fails loud', () => {
    const text = serializeDecision({
      decisionId: 'dec-x',
      kind: 'cancel',
      targetNodeId: 'leaf-1',
      note: null,
    }).replace('kind: cancel', 'kind: frobnicate');
    expect(() => deserializeDecision(text)).toThrow(/unknown `kind`/);
  });
});
