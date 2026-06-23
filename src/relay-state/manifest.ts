// Root-manifest reader/writer. Same codec as node files: YAML
// front-matter is authoritative, the Markdown body is a human-readable render.
import { readFile } from 'node:fs/promises';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { relayPaths } from './paths';
import type { RootManifest } from './types';

function renderManifestBody(m: RootManifest): string {
  return [
    `# Relay run \`${m.runId}\``,
    '',
    `- Root node: \`${m.rootId}\``,
    `- Outcome: ${m.spec.outcome}`,
    `- Created: ${m.createdAt}`,
  ].join('\n');
}

export function serializeManifest(m: RootManifest): string {
  return serializeFrontmatter(m, renderManifestBody(m));
}

function assertManifestShape(data: unknown): asserts data is RootManifest {
  if (typeof data !== 'object' || data === null) {
    throw new Error('manifest front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== 'string' || typeof d.rootId !== 'string') {
    throw new Error('manifest front-matter missing string `runId`/`rootId`');
  }
}

export function deserializeManifest(text: string): RootManifest {
  const { data } = parseFrontmatter(text);
  assertManifestShape(data);
  return data;
}

export async function writeManifest(relayDir: string, m: RootManifest): Promise<void> {
  await atomicWriteFile(relayPaths(relayDir).manifest, serializeManifest(m));
}

export async function readManifest(relayDir: string): Promise<RootManifest> {
  const text = await readFile(relayPaths(relayDir).manifest, 'utf8');
  return deserializeManifest(text);
}
