// Filesystem primitives for `.relay/` writes. The filesystem gives one atomic
// primitive — single-file rename — and the intent journal (journal.ts) lifts it
// to all-or-nothing across the several files a transition touches (design §9.3).
// This module provides that primitive: a crash during `atomicWriteFile` leaves
// the target either fully at its old contents or fully at its new contents,
// never torn — which is what keeps a rehydrating orchestrator from ever reading
// a half-written record (the rehydration contract, §3.2).
import { mkdir, open, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

// Durably persist directory metadata (the rename) by fsync-ing the directory.
// Best-effort: not every platform permits fsync on a directory fd, and logic
// correctness does not depend on it — only crash durability does (§4 caveat).
export async function fsyncDir(dir: string): Promise<void> {
  let dh: FileHandle | undefined;
  try {
    dh = await open(dir, 'r');
    await dh.sync();
  } catch {
    // Directory fsync unsupported here; ignore.
  } finally {
    await dh?.close();
  }
}

// Write `content` to `path` atomically: write a temp sibling, fsync it, then
// rename it over the target (the atomic primitive), then fsync the directory.
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid.toString()}-${Date.now().toString()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh?.close();
  }
  await rename(tmp, path);
  await fsyncDir(dir);
}
