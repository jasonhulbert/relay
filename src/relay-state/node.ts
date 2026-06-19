// Node-file reader/writer (design §4). The record's authoritative form is the
// YAML front-matter; the Markdown body is a generated human-readable rendering.
import { readFile } from 'node:fs/promises';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { relayPaths } from './paths';
import type { NodeRecord } from './types';

// Human-readable body — a projection of select fields for eyeball/`git log`
// reading. Never parsed back; the front-matter is the source of truth.
function renderNodeBody(record: NodeRecord): string {
  const lines = [
    `# ${record.kind} node \`${record.id}\``,
    '',
    `- Status: ${record.status}`,
    `- Outcome: ${record.spec.outcome}`,
  ];
  if (record.children.length > 0) {
    lines.push(`- Children: ${record.children.map((c) => `\`${c}\``).join(', ')}`);
  }
  if (record.verdict !== null) {
    lines.push(
      `- Critic verdict: ${record.verdict.pass ? 'pass' : 'fail'} (${record.verdict.provider})`,
    );
  }
  return lines.join('\n');
}

export function serializeNode(record: NodeRecord): string {
  return serializeFrontmatter(record, renderNodeBody(record));
}

// Fail loud (Rule 11) on a malformed record rather than handing the loop a
// half-typed object. We validate the discriminant fields; the round-trip
// property test (node.test.ts) covers full-field fidelity.
function assertNodeShape(data: unknown): asserts data is NodeRecord {
  if (typeof data !== 'object' || data === null) {
    throw new Error('node front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string') {
    throw new Error('node front-matter missing string `id`');
  }
  if (d.kind !== 'leaf' && d.kind !== 'branch') {
    throw new Error('node front-matter missing valid `kind`');
  }
}

export function deserializeNode(text: string): NodeRecord {
  const { data } = parseFrontmatter(text);
  assertNodeShape(data);
  return data;
}

export async function writeNode(relayDir: string, record: NodeRecord): Promise<void> {
  await atomicWriteFile(relayPaths(relayDir).nodeFile(record.id), serializeNode(record));
}

export async function readNode(relayDir: string, id: string): Promise<NodeRecord> {
  const text = await readFile(relayPaths(relayDir).nodeFile(id), 'utf8');
  return deserializeNode(text);
}
