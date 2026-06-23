import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { parse as parseYaml } from 'yaml';
import { describe, expect, test } from 'vitest';
import { arbNodeRecord } from './arbitraries';
import { deserializeNode, readNode, serializeNode, writeNode } from './node';
import type { NodeRecord } from './types';

// WHY this matters: the rehydration contract requires a fresh
// orchestrator reconstituted from `.relay/` to be *indistinguishable* from the
// one it replaces — same subtree, statuses, learnings, history. Any field the
// writer drops or the reader mangles is a silent divergence the loop would build
// on as truth. The round-trip is the falsifiable guard on that contract.
describe('node record round-trip', () => {
  test('survives write-then-read with no field loss, over arbitrary records', async () => {
    await fc.assert(
      fc.asyncProperty(arbNodeRecord, async (record) => {
        const dir = await mkdtemp(join(tmpdir(), 'relay-node-'));
        try {
          await writeNode(dir, record);
          const back = await readNode(dir, record.id);
          expect(back).toEqual(record);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 150 },
    );
  });

  test('serialize/deserialize is lossless without touching the filesystem', () => {
    fc.assert(
      fc.property(arbNodeRecord, (record) => {
        expect(deserializeNode(serializeNode(record))).toEqual(record);
      }),
      { numRuns: 300 },
    );
  });
});

describe('node file shape', () => {
  const sample: NodeRecord = {
    id: 'leaf-1',
    parentId: 'root',
    kind: 'leaf',
    status: 'pending',
    spec: {
      outcome: 'the build passes',
      verifications: [{ kind: 'command', grounding: 'exit code', check: 'true' }],
    },
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
  };

  test('is valid Markdown with parseable front-matter', () => {
    const text = serializeNode(sample);
    // Opens with a front-matter fence.
    expect(text.startsWith('---\n')).toBe(true);
    // Has a closing fence delimiting the block.
    const close = text.indexOf('\n---\n', 4);
    expect(close).toBeGreaterThan(0);
    // The front-matter block parses as YAML and carries the record fields.
    const parsed = parseYaml(text.slice(4, close)) as Record<string, unknown>;
    expect(parsed.id).toBe('leaf-1');
    expect(parsed.kind).toBe('leaf');
    // A human-readable Markdown body follows the front-matter.
    const body = text.slice(close + 5);
    expect(body).toContain('# leaf node');
    expect(body).toContain('the build passes');
  });

  test('a file written to disk is re-readable as the same record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-node-'));
    try {
      await writeNode(dir, sample);
      // The on-disk file lives at the layout's nodes/<id>.md path.
      const raw = await readFile(join(dir, 'nodes', 'leaf-1.md'), 'utf8');
      expect(raw.startsWith('---\n')).toBe(true);
      expect(deserializeNode(raw)).toEqual(sample);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
