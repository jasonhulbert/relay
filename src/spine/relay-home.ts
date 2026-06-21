// The user-global relay store resolver (design §4; the global-root constraint in
// the M4 plan). A real run's `.relay/` root is NOT a temp dir — it lives at a
// stable, per-project, `git init`'d path under `~/.relay/` so the operator can
// inspect and `git log` it across runs. Tests still use throwaway temp dirs and
// pass `home` to retarget this resolver.
//
// Layout under the home root (`~/.relay/` by default):
//   <project-key>/            <- the `.relay/` store for one project (git repo)
//   index.json               <- key -> {projectPath, createdAt, lastRunAt}
// where project-key = `<sanitized-basename>-<short-hash-of-absolute-path>`. The
// hash makes the key collision-free across same-named projects at different
// paths; the basename keeps it human-recognizable. Worktrees (executor sandboxes)
// live OUTSIDE the store — never inside the git-tracked `.relay/` record.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { atomicWriteFile } from '../relay-state/index';

export interface RelayHomeOptions {
  // Override the `~/.relay` root. Tests pass a temp dir; real runs omit it.
  home?: string;
}

// The home root holding every project store and the index.
export function relayHome(opts: RelayHomeOptions = {}): string {
  return opts.home ?? join(homedir(), '.relay');
}

// `<basename>-<short-hash>`: stable across invocations from any cwd (the absolute
// path is the hash input), filesystem-safe (basename sanitized to the same
// conservative set node ids use), and collision-free (the hash disambiguates two
// projects that share a basename).
export function projectKey(projectPath: string): string {
  const abs = resolve(projectPath);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  const safeBase = basename(abs).replace(/[^A-Za-z0-9._-]+/g, '-') || 'project';
  return `${safeBase}-${hash}`;
}

// The on-disk index mapping each project key to its provenance. JSON, not the
// Markdown `.relay/` records: this is code-owned registry metadata living above
// any single project's store, the seed for an eventual cross-project view and the
// way to relink a moved project's orphaned store.
export interface ProjectIndexEntry {
  projectPath: string;
  createdAt: string;
  lastRunAt: string;
}

export interface ProjectIndex {
  version: 1;
  projects: Record<string, ProjectIndexEntry>;
}

function indexPath(home: string): string {
  return join(home, 'index.json');
}

export async function readProjectIndex(home: string): Promise<ProjectIndex> {
  try {
    const raw = await readFile(indexPath(home), 'utf8');
    const parsed = JSON.parse(raw) as ProjectIndex;
    // Defend against a hand-edited or partial file: a missing map is an empty map,
    // never a crash that would orphan an otherwise-resolvable store.
    return { version: 1, projects: parsed.projects ?? {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

async function writeProjectIndex(home: string, index: ProjectIndex): Promise<void> {
  await atomicWriteFile(indexPath(home), `${JSON.stringify(index, null, 2)}\n`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runGit(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export interface ProjectStore {
  key: string;
  // The `.relay/` root for this project — the dir passed to `runOrchestrator`. It
  // IS the git repo root (design §4 git-trackability).
  storeDir: string;
  // Executor sandbox root, OUTSIDE the store so worktrees never enter the git
  // record. Project-scoped so two projects' same-named leaves do not collide.
  workRoot: string;
  // The operator's resolved absolute project path — the source the executor
  // sandbox is seeded from and the repo a verified result is landed back into as a
  // `relay/<runId>` branch. Already the hash input for `key`; surfaced here so the
  // run never has to re-derive it.
  projectPath: string;
  // True only on the run that first created (and git-init'd) this store.
  created: boolean;
}

export interface EnsureStoreOptions extends RelayHomeOptions {
  // Injected clock for deterministic tests; defaults to the wall clock.
  now?: () => string;
  // Skip `git init` (tests that do not exercise git-trackability). Real runs leave
  // it on so the store is `git log`-able.
  gitInit?: boolean;
}

// Resolve (and on first use create + `git init`) the project's global store, and
// record its provenance in the index. Idempotent: re-resolving the same project
// returns the SAME key and storeDir, refreshes `lastRunAt`, and never re-inits an
// existing git repo.
export async function ensureProjectStore(
  projectPath: string,
  opts: EnsureStoreOptions = {},
): Promise<ProjectStore> {
  const home = relayHome(opts);
  const now = opts.now ?? ((): string => new Date().toISOString());
  const abs = resolve(projectPath);
  const key = projectKey(abs);
  const storeDir = join(home, key);
  const workRoot = join(home, 'worktrees', key);

  const created = !(await exists(storeDir));
  await mkdir(storeDir, { recursive: true });

  // git init only when the store is not already a repo (preserves design §4
  // git-trackability without clobbering an existing history).
  if (opts.gitInit !== false && !(await exists(join(storeDir, '.git')))) {
    const code = await runGit(['init', '--quiet'], storeDir);
    if (code !== 0) {
      throw new Error(`git init failed (${code.toString()}) for store ${storeDir}`);
    }
  }

  const index = await readProjectIndex(home);
  const ts = now();
  const existing = index.projects[key];
  index.projects[key] = {
    projectPath: abs,
    createdAt: existing?.createdAt ?? ts,
    lastRunAt: ts,
  };
  await writeProjectIndex(home, index);

  return { key, storeDir, workRoot, projectPath: abs, created };
}

// Commit the current `.relay/` state so the store is `git log`-able (design §4).
// Stages everything and commits; a no-op commit (nothing changed) is tolerated so
// a re-run over an unchanged store does not fail the harness. Returns true if a
// commit was actually recorded.
export async function commitStore(storeDir: string, message: string): Promise<boolean> {
  await runGit(['add', '-A'], storeDir);
  // `git commit` exits non-zero when there is nothing staged; that is not an error
  // for our purposes, so we check first via `diff --cached --quiet` (exit 1 = has
  // staged changes).
  const hasStaged = (await runGit(['diff', '--cached', '--quiet'], storeDir)) !== 0;
  if (!hasStaged) {
    return false;
  }
  const code = await runGit(['commit', '--quiet', '-m', message], storeDir);
  if (code !== 0) {
    throw new Error(`git commit failed (${code.toString()}) for store ${storeDir}`);
  }
  return true;
}
