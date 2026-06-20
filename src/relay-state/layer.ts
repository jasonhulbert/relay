// Layer-manifest reader/writer (design §4, §3.8). Same codec as node/contract/
// manifest files: YAML front-matter is the authoritative record, the Markdown body
// is a generated human-readable rendering. The manifest is the child-manifest of
// the one layer a branch decomposed — each child's resource footprint and the seam
// graph between the children — and the orchestrator is its sole writer (C2). It is
// committed in the same atomic transaction as the children it describes.
import { readFile } from 'node:fs/promises';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { atomicWriteFile } from './io';
import { relayPaths } from './paths';
import type { LayerManifest } from './types';

function renderLayerBody(m: LayerManifest): string {
  const lines = [
    `# layer manifest \`${m.parentId}\``,
    '',
    `- Run: \`${m.runId}\``,
    `- Children: ${Object.keys(m.footprints).length.toString()}`,
    `- Seams: ${m.seams.length.toString()}`,
  ];
  for (const [childId, fp] of Object.entries(m.footprints)) {
    lines.push(`- \`${childId}\` footprint: ${fp.writeGlobs.join(', ') || '(none)'}`);
  }
  for (const s of m.seams) {
    lines.push(`- seam \`${s.id}\` [${s.kind}]: \`${s.producer}\` → \`${s.consumer}\``);
  }
  return lines.join('\n');
}

export function serializeLayer(m: LayerManifest): string {
  return serializeFrontmatter(m, renderLayerBody(m));
}

// Fail loud (Rule 11) on a malformed manifest rather than handing the scheduler or
// the failure rule a half-typed seam graph.
function assertLayerShape(data: unknown): asserts data is LayerManifest {
  if (typeof data !== 'object' || data === null) {
    throw new Error('layer front-matter is not a mapping');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.parentId !== 'string' || typeof d.runId !== 'string') {
    throw new Error('layer front-matter missing string `parentId`/`runId`');
  }
  if (typeof d.footprints !== 'object' || d.footprints === null) {
    throw new Error('layer front-matter missing `footprints` mapping');
  }
  if (!Array.isArray(d.seams)) {
    throw new Error('layer front-matter missing `seams` array');
  }
}

export function deserializeLayer(text: string): LayerManifest {
  const { data } = parseFrontmatter(text);
  assertLayerShape(data);
  return data;
}

export async function writeLayer(relayDir: string, m: LayerManifest): Promise<void> {
  await atomicWriteFile(relayPaths(relayDir).layerFile(m.parentId), serializeLayer(m));
}

export async function readLayer(relayDir: string, parentId: string): Promise<LayerManifest> {
  const text = await readFile(relayPaths(relayDir).layerFile(parentId), 'utf8');
  return deserializeLayer(text);
}

// A layer manifest is published only when a branch is decomposed; an absent one is
// a normal "this branch was hand-seeded / not yet decomposed" state, not an error.
export async function tryReadLayer(
  relayDir: string,
  parentId: string,
): Promise<LayerManifest | null> {
  try {
    return await readLayer(relayDir, parentId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
