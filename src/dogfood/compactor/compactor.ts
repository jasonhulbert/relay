// The evidence-directory compactor. This is the first real-work outcome the spine
// drives through its own loop: pure core-logic with no external CLI and no UI, verified
// by command/test alone, so the dogfood isolates the loop from provider flakiness.
//
// What it does, scanning ONLY `.relay/evidence/<runId>/`:
//   - LIVE refs are retained: a capture a surviving node's `evidenceRefs` names still
//     resolves after a run (the rehydration contract keeps what live nodes point at);
//   - ORPHANED captures are dropped: a capture no live ref names (a cancelled or
//     superseded attempt left it behind) is removed;
//   - retained captures are COMPRESSED in place (same path, so the live ref keeps
//     resolving) — gzip, recorded only when it actually shrinks the file;
//   - a compaction MANIFEST enumerating kept/dropped/compressed is written.
//
// Two exclusions are structural, not asserted:
//   - the content-addressed BASELINE store is a SIBLING of `.relay/`, so a scan rooted
//     at `.relay/evidence/` can never reach it. The compactor takes no baseline path at
//     all — it is incapable of touching baselines, which is a stronger guarantee than
//     checking that it didn't (baselines do not exist until the visual subsystem lands,
//     but the exclusion holds the moment they do).
//   - per-call usage/cost telemetry is NOT a capture and is NOT orphan-dropped:
//     `evidence/<runId>/<node>/usage/` records and the `cost.md` rollup are governed by
//     their own prune-after-rollup rule, a separate concern. The capture scan skips the
//     `usage/` subtree and the run-level `cost.md`/`compaction.md` files, so a live
//     telemetry record is never mistaken for an orphan. The compactor preserves usage/
//     cost telemetry rather than pruning it — see `GOLDEN`.
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  atomicWriteFile,
  readNode,
  relayPaths,
  serializeFrontmatter,
} from '../../relay-state/index';

// The verifiable record the compactor produces: which captures it kept,
// which it dropped, and which it compressed. Returned to the caller AND written to
// `evidence/<runId>/compaction.md`. All three lists hold evidence-dir-relative paths,
// sorted, so the manifest is byte-deterministic across runs.
export interface CompactionManifest {
  runId: string;
  // Live captures retained (each still resolves after the run).
  kept: string[];
  // Orphaned captures removed (no live ref named them).
  dropped: string[];
  // Retained captures compressed in place (a subset of `kept` — those that shrank).
  compressed: string[];
}

// The evidence-dir-relative path of the manifest the compactor writes. Excluded from
// the capture scan so a second compaction does not see it as an orphan.
const MANIFEST_REL = 'compaction.md';
// The run-level cost rollup; telemetry, never a capture.
const COST_ROLLUP_REL = 'cost.md';

// Collect every LIVE evidence ref for this run from the durable node records — never
// by guessing filenames (sketch note 1). A ref is live iff a node file records it for
// this run; the union of those paths is the retain set.
async function collectLiveRefs(relayDir: string, runId: string): Promise<Set<string>> {
  const { nodesDir } = relayPaths(relayDir);
  const files = (await readdir(nodesDir)).filter((f) => f.endsWith('.md'));
  const live = new Set<string>();
  for (const file of files.sort()) {
    const node = await readNode(relayDir, file.slice(0, -3));
    for (const ref of node.evidenceRefs) {
      if (ref.runId === runId) live.add(ref.path);
    }
  }
  return live;
}

// A path is telemetry/bookkeeping (not a capture) iff it sits in a node's `usage/`
// subtree or is the run-level cost rollup / the compaction manifest itself. These are
// skipped so usage/cost telemetry is preserved and the manifest is not self-orphaned.
function isTelemetryOrManifest(rel: string): boolean {
  const segments = rel.split('/');
  return segments.includes('usage') || rel === COST_ROLLUP_REL || rel === MANIFEST_REL;
}

// Enumerate the capture files actually on disk under the evidence dir, as
// evidence-dir-relative POSIX paths, skipping the `usage/` subtrees (and any
// telemetry/manifest file). Missing evidence dir → no captures.
async function listCaptures(evidenceDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // The usage/ telemetry subtree is governed by prune-after-rollup, not orphan-drop.
        if (entry.name === 'usage') continue;
        await walk(join(dir, entry.name), childRel);
      } else if (entry.isFile() && !isTelemetryOrManifest(childRel)) {
        out.push(childRel);
      }
    }
  }
  await walk(evidenceDir, '');
  return out;
}

function relToAbs(evidenceDir: string, rel: string): string {
  return join(evidenceDir, ...rel.split('/'));
}

// A human rendering of the manifest (the front-matter is the machine record; the body
// is generated and never parsed back — frontmatter.ts convention).
function manifestBody(m: CompactionManifest): string {
  return [
    `# compaction manifest (${m.runId})`,
    '',
    `- kept (live, retained): ${m.kept.length.toString()}`,
    `- dropped (orphaned): ${m.dropped.length.toString()}`,
    `- compressed (retained, shrunk): ${m.compressed.length.toString()}`,
  ].join('\n');
}

// Compact the run's evidence dir. Pure core-logic: it reads the durable node records
// for the live set, partitions the on-disk captures into live/orphan, drops orphans,
// compresses retained captures in place, and writes the manifest. The baseline store is
// never named, so baseline-store exclusion is structural. Returns the manifest
// (also persisted to `evidence/<runId>/compaction.md`).
export async function compactEvidence(
  relayDir: string,
  runId: string,
): Promise<CompactionManifest> {
  const evidenceDir = relayPaths(relayDir).evidenceDir(runId);
  const liveRefs = await collectLiveRefs(relayDir, runId);
  const captures = await listCaptures(evidenceDir);

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const rel of captures) {
    if (liveRefs.has(rel)) kept.push(rel);
    else dropped.push(rel);
  }

  // Drop every orphan (no live ref names it).
  for (const rel of dropped) {
    await rm(relToAbs(evidenceDir, rel));
  }

  // Compress each retained capture in place (same path → the live ref keeps
  // resolving). Recorded only when gzip actually shrinks it, so the manifest reflects
  // real reduction rather than an unconditional claim.
  const compressed: string[] = [];
  for (const rel of kept) {
    const abs = relToAbs(evidenceDir, rel);
    const original = await readFile(abs);
    const gz = gzipSync(original, { level: 9 });
    if (gz.length < original.length) {
      await writeFile(abs, gz);
      compressed.push(rel);
    }
  }

  const manifest: CompactionManifest = {
    runId,
    kept: [...kept].sort(),
    dropped: [...dropped].sort(),
    compressed: [...compressed].sort(),
  };
  await atomicWriteFile(
    join(evidenceDir, MANIFEST_REL),
    serializeFrontmatter(manifest, manifestBody(manifest)),
  );
  return manifest;
}
