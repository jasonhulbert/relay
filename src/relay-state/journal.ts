// Per-region write-ahead intent journal. The filesystem
// gives one atomic primitive — single-file rename (io.ts) — and this journal
// lifts it to all-or-nothing across the several files a structural transition
// touches (promotion, done/blocked transitions, cancellations, draining a human
// decision).
//
// Protocol:
//   1. Write one intent file holding the COMPLETE post-state for every file the
//      transaction touches, and durably commit it (the atomic rename in
//      `writeIntent` is the commit point).
//   2. Apply the named writes.
//   3. Remove the intent file.
//
// A rehydrating orchestrator that finds an intent rolls it forward idempotently
// before doing anything else: because the intent carries full target contents,
// re-applying is safe to repeat. The journal is per-region so an orchestrator
// bound to a node-id finds exactly its region's pending intent under
// `journal/<region>/`. This upholds the rehydration contract: any instant of
// `.relay/` is coherent enough to reconstitute the responsible orchestrator.
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, fsyncDir } from './io';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { relayPaths } from './paths';

const INTENT_SUFFIX = '.intent.md';

// One file the transaction will write. `path` is relative to the `.relay/` root.
export interface IntentWrite {
  path: string;
  content: string;
}

interface IntentDoc {
  intentId: string;
  region: string;
  committedAt: string;
  writes: IntentWrite[];
}

function newIntentId(): string {
  return `intent-${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function intentPath(relayDir: string, region: string, intentId: string): string {
  return join(relayPaths(relayDir).journalDir(region), `${intentId}${INTENT_SUFFIX}`);
}

// Reject a target path that would escape the `.relay/` region (defense in depth;
// our own intents never do this, but a corrupt one must fail loud, not write out
// of bounds).
function assertInRegion(relativePath: string): void {
  const segments = relativePath.split(/[/\\]/);
  if (relativePath === '' || segments.includes('..') || relativePath.startsWith('/')) {
    throw new Error(`intent write path escapes the region: ${JSON.stringify(relativePath)}`);
  }
}

function renderIntentBody(doc: IntentDoc): string {
  const targets = doc.writes.map((w) => `- \`${w.path}\``).join('\n');
  return [`# Intent \`${doc.intentId}\` (region \`${doc.region}\`)`, '', 'Writes:', targets].join(
    '\n',
  );
}

function serializeIntent(doc: IntentDoc): string {
  return serializeFrontmatter(doc, renderIntentBody(doc));
}

function deserializeIntent(text: string): IntentDoc {
  const { data } = parseFrontmatter(text);
  if (typeof data !== 'object' || data === null) {
    throw new Error('intent front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.intentId !== 'string' || typeof d.region !== 'string' || !Array.isArray(d.writes)) {
    throw new Error('intent front-matter missing intentId/region/writes');
  }
  const writes = d.writes as IntentWrite[];
  for (const w of writes) {
    if (typeof w.path !== 'string' || typeof w.content !== 'string') {
      throw new Error('intent write entry missing string path/content');
    }
  }
  return {
    intentId: d.intentId,
    region: d.region,
    committedAt: typeof d.committedAt === 'string' ? d.committedAt : '',
    writes,
  };
}

// Step 1: durably record the transaction's full post-state. The atomic rename
// inside `atomicWriteFile` is the commit point — before it the intent does not
// exist; after it the intent is durably present and will be rolled forward.
export async function writeIntent(
  relayDir: string,
  region: string,
  writes: IntentWrite[],
): Promise<string> {
  for (const w of writes) {
    assertInRegion(w.path);
  }
  const intentId = newIntentId();
  const doc: IntentDoc = {
    intentId,
    region,
    committedAt: new Date().toISOString(),
    writes,
  };
  await atomicWriteFile(intentPath(relayDir, region, intentId), serializeIntent(doc));
  return intentId;
}

async function applyIntentDoc(relayDir: string, doc: IntentDoc): Promise<void> {
  for (const w of doc.writes) {
    assertInRegion(w.path);
    await atomicWriteFile(join(relayDir, w.path), w.content);
  }
}

// Steps 2-3: apply the named writes, then remove the intent. Idempotent — the
// writes carry full post-state, so re-running yields identical bytes.
export async function applyIntent(
  relayDir: string,
  region: string,
  intentId: string,
): Promise<void> {
  const path = intentPath(relayDir, region, intentId);
  const doc = deserializeIntent(await readFile(path, 'utf8'));
  await applyIntentDoc(relayDir, doc);
  await rm(path, { force: true });
  await fsyncDir(relayPaths(relayDir).journalDir(region));
}

// The full transaction: write-ahead, apply, remove. Returns the intent id.
export async function commit(
  relayDir: string,
  region: string,
  writes: IntentWrite[],
): Promise<string> {
  const intentId = await writeIntent(relayDir, region, writes);
  await applyIntent(relayDir, region, intentId);
  return intentId;
}

// The ids of committed-but-not-yet-removed intents in a region. A non-empty
// result at rehydration means a transaction was interrupted after its commit
// point and must be rolled forward.
export async function pendingIntents(relayDir: string, region: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(relayPaths(relayDir).journalDir(region));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  // Only fully-renamed intents end with the suffix; a `.tmp-*` left by an
  // interrupted `writeIntent` (before its commit point) is correctly ignored.
  return names
    .filter((n) => n.endsWith(INTENT_SUFFIX))
    .map((n) => n.slice(0, -INTENT_SUFFIX.length))
    .sort();
}

// Roll every pending intent in a region forward idempotently, removing each.
// Returns the ids rolled forward, in commit order.
export async function rollForwardPending(relayDir: string, region: string): Promise<string[]> {
  const ids = await pendingIntents(relayDir, region);
  for (const id of ids) {
    await applyIntent(relayDir, region, id);
  }
  return ids;
}
