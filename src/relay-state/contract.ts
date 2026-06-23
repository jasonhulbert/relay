// Verified-outcome-contract reader/writer. Same codec as
// node/manifest files: YAML front-matter is the authoritative record, the Markdown
// body is a generated human-readable rendering. The contract is the artifact a
// sub-orchestrator hands up to its parent across the process boundary; it is
// written into the child's own region and read by the parent from the ledger.
import { readFile } from 'node:fs/promises';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { relayPaths } from './paths';
import type { OutcomeContract } from './types';

function renderContractBody(c: OutcomeContract): string {
  return [
    `# outcome contract \`${c.nodeId}\``,
    '',
    `- Run: \`${c.runId}\``,
    `- Claimed outcome: ${c.claimedOutcome}`,
    `- Critic-certified: ${c.criticCertified ? 'yes' : 'no'}`,
    `- Verdict refs: ${c.verdictRefs.length.toString()}`,
    `- Seam evidence: ${c.seamEvidence.length.toString()} (placeholder)`,
  ].join('\n');
}

export function serializeContract(c: OutcomeContract): string {
  return serializeFrontmatter(c, renderContractBody(c));
}

// Fail loud (Rule 11) on a malformed contract rather than letting a parent gate
// its done-ness on a half-typed object.
function assertContractShape(data: unknown): asserts data is OutcomeContract {
  if (typeof data !== 'object' || data === null) {
    throw new Error('contract front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.nodeId !== 'string' || typeof d.runId !== 'string') {
    throw new Error('contract front-matter missing string `nodeId`/`runId`');
  }
  if (typeof d.criticCertified !== 'boolean') {
    throw new Error('contract front-matter missing boolean `criticCertified`');
  }
}

export function deserializeContract(text: string): OutcomeContract {
  const { data } = parseFrontmatter(text);
  assertContractShape(data);
  return data;
}

export async function writeContract(relayDir: string, c: OutcomeContract): Promise<void> {
  await atomicWriteFile(relayPaths(relayDir).contractFile(c.nodeId), serializeContract(c));
}

export async function readContract(relayDir: string, id: string): Promise<OutcomeContract> {
  const text = await readFile(relayPaths(relayDir).contractFile(id), 'utf8');
  return deserializeContract(text);
}

// The parent reads a child's contract from the ledger to decide acceptance; an
// absent contract is a normal "not yet published" state, not an error.
export async function tryReadContract(
  relayDir: string,
  id: string,
): Promise<OutcomeContract | null> {
  try {
    return await readContract(relayDir, id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
