// On-disk `.relay/` layout (docs/relay-state-layout.md, design §4). All path
// construction goes through here so the layout has a single source of truth.
import { join } from 'node:path';

// Ids become path segments (node files, journal regions), so they must be
// filesystem-safe. Reject anything outside a conservative set — no slashes, no
// dots-only traversal — and fail loud (Rule 11) rather than write a stray file.
const ID_RE = /^[A-Za-z0-9._-]+$/;

export function assertSafeId(id: string): void {
  if (id === '' || id === '.' || id === '..' || !ID_RE.test(id)) {
    throw new Error(`unsafe id for a filesystem path: ${JSON.stringify(id)}`);
  }
}

export function relayPaths(relayDir: string) {
  const nodesDir = join(relayDir, 'nodes');
  const contractsDir = join(relayDir, 'contracts');
  const layersDir = join(relayDir, 'layers');
  return {
    relayDir,
    manifest: join(relayDir, 'manifest.md'),
    nodesDir,
    nodeFile: (id: string): string => {
      assertSafeId(id);
      return join(nodesDir, `${id}.md`);
    },
    contractsDir,
    contractFile: (id: string): string => {
      assertSafeId(id);
      return join(contractsDir, `${id}.md`);
    },
    layersDir,
    // The child-manifest of the layer a branch decomposed, keyed by the branch id.
    layerFile: (parentId: string): string => {
      assertSafeId(parentId);
      return join(layersDir, `${parentId}.md`);
    },
    evidenceDir: (runId: string): string => {
      assertSafeId(runId);
      return join(relayDir, 'evidence', runId);
    },
    inboxDir: join(relayDir, 'inbox'),
    journalDir: (region: string): string => {
      assertSafeId(region);
      return join(relayDir, 'journal', region);
    },
  };
}

export type RelayPaths = ReturnType<typeof relayPaths>;

// Paths relative to the `.relay/` root, for the intent journal's `IntentWrite`
// entries (which name targets relative to the region root, not absolutely).
export const relativeManifestPath = 'manifest.md';

export function relativeNodePath(id: string): string {
  assertSafeId(id);
  return `nodes/${id}.md`;
}

export function relativeContractPath(id: string): string {
  assertSafeId(id);
  return `contracts/${id}.md`;
}

export function relativeLayerPath(parentId: string): string {
  assertSafeId(parentId);
  return `layers/${parentId}.md`;
}
