// The human decision inbox. A human-owned region under
// `.relay/inbox/` that the orchestrator only READS and drains at activation: the
// human writes one Markdown decision file per request, the orchestrator applies
// each pending decision as an atomic transition within its own node region, and
// it never writes the inbox back (sole-writer ownership at both ends). A
// rehydrated orchestrator reads pending decisions from this durable region like
// everything else, so a queued decision survives teardown and is drained by the
// replacement. Same codec as the node/contract files: YAML front-matter is the
// authoritative record, the Markdown body a generated human-readable rendering.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { assertSafeId, relayPaths } from './paths';
import type { DecisionRecord } from './types';

function renderDecisionBody(d: DecisionRecord): string {
  const lines = [
    `# decision \`${d.decisionId}\``,
    '',
    `- Kind: ${d.kind}`,
    `- Target: \`${d.targetNodeId}\``,
  ];
  if (d.note !== null) {
    lines.push(`- Note: ${d.note}`);
  }
  return lines.join('\n');
}

export function serializeDecision(d: DecisionRecord): string {
  return serializeFrontmatter(d, renderDecisionBody(d));
}

// Fail loud (Rule 11) on a malformed decision rather than handing the drain loop a
// half-typed object that could mis-target a cancellation.
function assertDecisionShape(data: unknown): asserts data is DecisionRecord {
  if (typeof data !== 'object' || data === null) {
    throw new Error('decision front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.decisionId !== 'string') {
    throw new Error('decision front-matter missing string `decisionId`');
  }
  if (d.kind !== 'cancel') {
    throw new Error(`decision front-matter has unknown \`kind\`: ${JSON.stringify(d.kind)}`);
  }
  if (typeof d.targetNodeId !== 'string') {
    throw new Error('decision front-matter missing string `targetNodeId`');
  }
}

export function deserializeDecision(text: string): DecisionRecord {
  const { data } = parseFrontmatter(text);
  assertDecisionShape(data);
  return {
    decisionId: data.decisionId,
    kind: data.kind,
    targetNodeId: data.targetNodeId,
    note: data.note ?? null,
  };
}

// The human's write path into the inbox (also used by tests). The decisionId is a
// filesystem path segment, so it is held to the same safe-id rule as node ids.
export async function writeDecision(relayDir: string, d: DecisionRecord): Promise<void> {
  assertSafeId(d.decisionId);
  const path = join(relayPaths(relayDir).inboxDir, `${d.decisionId}.md`);
  await atomicWriteFile(path, serializeDecision(d));
}

// Every decision currently in the inbox, sorted by decisionId so drain order is
// deterministic across rehydrations. An absent inbox directory is the normal
// empty case, not an error.
export async function readInbox(relayDir: string): Promise<DecisionRecord[]> {
  const dir = relayPaths(relayDir).inboxDir;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const decisions: DecisionRecord[] = [];
  for (const name of names.sort()) {
    // Skip a `.tmp-*` sibling left by an interrupted write (before its atomic
    // rename); only fully-renamed `.md` files are decisions.
    if (!name.endsWith('.md') || name.includes('.tmp-')) {
      continue;
    }
    decisions.push(deserializeDecision(await readFile(join(dir, name), 'utf8')));
  }
  return decisions;
}
