// Per-call usage record reader/writer (F5, design §8, §4). Same codec as the other
// `.relay/` records: YAML front-matter is the authoritative machine record, the
// Markdown body is a generated human-readable rendering. A usage record is a RAW
// per-call cost record in the run's evidence store, attributed to the node the call
// served; the orchestrator is its sole writer (C2). The per-run rollup is composed
// from these records at read time (renderCostRollup, spine/cost.ts) — the records
// are the ground truth, the rollup a projection.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { relayPaths } from './paths';
import type { CallUsage } from './types';

function renderUsageBody(u: CallUsage): string {
  const cost =
    u.costUsd === null
      ? `unpriced (${u.costSource})`
      : `$${u.costUsd.toFixed(6)} (${u.costSource})`;
  return [
    `# usage \`${u.nodeId}\` ${u.role} #${u.seq.toString()}`,
    '',
    `- Run: \`${u.runId}\``,
    `- Provider: ${u.provider}${u.model === null ? '' : ` (${u.model})`}`,
    `- Tokens: in=${u.inputTokens.toString()} cached=${u.cachedInputTokens.toString()} out=${u.outputTokens.toString()}`,
    `- Wall-clock: ${u.wallClockMs.toString()}ms`,
    `- Cost: ${cost}`,
  ].join('\n');
}

export function serializeUsage(u: CallUsage): string {
  return serializeFrontmatter(u, renderUsageBody(u));
}

// Fail loud (Rule 11) on a malformed record rather than feeding the rollup a
// half-typed call. The round-trip property test covers full-field fidelity.
function assertUsageShape(data: unknown): asserts data is CallUsage {
  if (typeof data !== 'object' || data === null) {
    throw new Error('usage front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== 'string' || typeof d.nodeId !== 'string') {
    throw new Error('usage front-matter missing string `runId`/`nodeId`');
  }
  if (d.role !== 'executor' && d.role !== 'critic' && d.role !== 'brain') {
    throw new Error('usage front-matter missing valid `role`');
  }
  if (typeof d.provider !== 'string' || typeof d.seq !== 'number') {
    throw new Error('usage front-matter missing string `provider` / number `seq`');
  }
}

export function deserializeUsage(text: string): CallUsage {
  const { data } = parseFrontmatter(text);
  assertUsageShape(data);
  return data;
}

export async function writeUsage(relayDir: string, u: CallUsage): Promise<void> {
  await atomicWriteFile(
    relayPaths(relayDir).usageFile(u.runId, u.nodeId, u.role, u.seq),
    serializeUsage(u),
  );
}

// Read every per-call usage record for a run, across all nodes (each
// sub-orchestrator wrote its own nodes' records into the shared evidence store, so
// the top-level run reads them all here). Sorted deterministically by node-id, then
// role, then sequence so the rollup and recap render identically across runs. An
// absent evidence dir (a run that spent no real model call) yields an empty list.
export async function readRunUsage(relayDir: string, runId: string): Promise<CallUsage[]> {
  const paths = relayPaths(relayDir);
  let nodeDirs: string[];
  try {
    nodeDirs = (await readdir(paths.evidenceDir(runId), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: CallUsage[] = [];
  for (const nodeId of nodeDirs) {
    let files: string[];
    try {
      files = (await readdir(paths.usageDir(runId, nodeId))).filter((f) => f.endsWith('.md'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const f of files) {
      records.push(
        deserializeUsage(await readFile(join(paths.usageDir(runId, nodeId), f), 'utf8')),
      );
    }
  }
  records.sort(
    (a, b) => a.nodeId.localeCompare(b.nodeId) || a.role.localeCompare(b.role) || a.seq - b.seq,
  );
  return records;
}
