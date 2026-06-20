import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { writeManifest, writeNode } from '../relay-state/index';
import type { NodeRecord, OutcomeSpec, RootManifest } from '../relay-state/index';
import { projectRun } from './projection';
import { renderRunPage } from './render';
import { createWebViewServer, startWebView } from './server';

function spec(outcome: string): OutcomeSpec {
  return {
    outcome,
    verifications: [{ kind: 'command', grounding: 'the check exits 0', check: 'true' }],
  };
}

function node(over: Partial<NodeRecord> & Pick<NodeRecord, 'id'>): NodeRecord {
  return {
    parentId: null,
    kind: 'leaf',
    status: 'pending',
    spec: spec(`outcome for ${over.id}`),
    children: [],
    selfReport: null,
    learnings: [],
    verdict: null,
    evidenceRefs: [],
    blocked: null,
    ...over,
  };
}

// The same two-level fixture the projection test uses: a root branch over a
// sub-branch (one done leaf) and a directly-owned blocked leaf. Exercises every
// status the head renders.
async function seedFixture(relayDir: string): Promise<void> {
  const manifest: RootManifest = {
    runId: 'run-1',
    rootId: 'root',
    spec: spec('ship the widget end-to-end'),
    createdAt: '2026-06-18T00:00:00.000Z',
  };
  await writeManifest(relayDir, manifest);
  await writeNode(
    relayDir,
    node({ id: 'root', kind: 'branch', status: 'active', children: ['mid', 'leaf-2'] }),
  );
  await writeNode(
    relayDir,
    node({ id: 'mid', parentId: 'root', kind: 'branch', status: 'active', children: ['leaf-1'] }),
  );
  await writeNode(
    relayDir,
    node({
      id: 'leaf-1',
      parentId: 'mid',
      kind: 'leaf',
      status: 'done',
      spec: spec('produce the change'),
      selfReport: 'I did the thing', // narrative — must NOT surface in the served page
      verdict: { pass: true, provider: 'codex', rationale: 'satisfies the spec', evidenceRefs: [] },
    }),
  );
  await writeNode(
    relayDir,
    node({
      id: 'leaf-2',
      parentId: 'root',
      kind: 'leaf',
      status: 'blocked',
      blocked: {
        reason: 'ladder exhausted',
        rungsSpent: ['retry x2'],
        criticReason: 'spec never satisfied',
        humanFacing: 'needs a human decision',
      },
    }),
  );
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(relayDir: string): Promise<string> {
  const started = await startWebView({ relayDir });
  servers.push(started.server);
  return started.url;
}

// The status badge + node-id are rendered adjacent in one `.node-head`, so this
// substring binds a status to a specific node (not just "this status appears
// somewhere on the page").
function headFor(status: string, kind: string, id: string): string {
  return `status-${status}">${status}</span> <span class="kind">${kind}</span> <span class="node-id">${id}</span>`;
}

describe('webview HTTP server', () => {
  // WHY: the deliverable is a server that serves the tree with correct per-node
  // statuses. This pins that each node's status renders bound to that node, that
  // the served page is exactly the projection's render (so the server adds no
  // divergence), and — the C7 line — that the orchestrator-only self-report never
  // reaches the page even though it is on disk.
  test('renders a fixture run with correct per-node statuses', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);
      const url = await serve(relayDir);

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const html = await res.text();

      expect(html).toContain(headFor('active', 'branch', 'root'));
      expect(html).toContain(headFor('active', 'branch', 'mid'));
      expect(html).toContain(headFor('done', 'leaf', 'leaf-1'));
      expect(html).toContain(headFor('blocked', 'leaf', 'leaf-2'));

      // The page is exactly the projection's render — the server is a thin read-time
      // surface, not a second composition.
      expect(html).toBe(renderRunPage(await projectRun(relayDir)));

      // C7: the orchestrator-visible narrative is on disk but not in the view.
      expect(html).not.toContain('I did the thing');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: the view is composed at read time from the per-node files, never cached
  // (A6, design §4). Mutating a node file on disk and re-fetching must reflect the
  // change with no restart — proving the page is recomposed per request, not served
  // from a snapshot taken at startup.
  test('reflects a mutated node file on refresh (read-time recomposition)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);
      const url = await serve(relayDir);

      const before = await (await fetch(url)).text();
      expect(before).toContain(headFor('blocked', 'leaf', 'leaf-2'));
      expect(before).not.toContain(headFor('done', 'leaf', 'leaf-2'));

      // Flip leaf-2 blocked -> done on disk, then refresh the same server.
      await writeNode(
        relayDir,
        node({ id: 'leaf-2', parentId: 'root', kind: 'leaf', status: 'done' }),
      );

      const after = await (await fetch(url)).text();
      expect(after).toContain(headFor('done', 'leaf', 'leaf-2'));
      expect(after).not.toContain(headFor('blocked', 'leaf', 'leaf-2'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: I3 — the view writes nothing. Serving several requests against the store
  // must leave every file's content and mtime untouched; an open-for-write would
  // change them via the atomic-write rename.
  test('serving writes nothing to the store', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);
      const url = await serve(relayDir);

      const snap = async (): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        const walk = async (cur: string, prefix: string): Promise<void> => {
          for (const e of await readdir(cur, { withFileTypes: true })) {
            const full = join(cur, e.name);
            const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
            if (e.isDirectory()) await walk(full, rel);
            else {
              const [content, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
              out[rel] = `${st.mtimeMs.toString()}:${content}`;
            }
          }
        };
        await walk(relayDir, '');
        return out;
      };

      const before = await snap();
      await fetch(url);
      await fetch(url);
      const after = await snap();
      expect(after).toEqual(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: `projectRun` fails loud on an incoherent tree (here, a dangling child
  // ref). The server must surface that as an explicit error page with a 5xx, not a
  // blank or partial tree (Rule 11, Phase 1 notes).
  test('serves an error page (500) when the projection fails loud', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await writeManifest(relayDir, {
        runId: 'run-1',
        rootId: 'root',
        spec: spec('root'),
        createdAt: '2026-06-18T00:00:00.000Z',
      });
      await writeNode(relayDir, node({ id: 'root', kind: 'branch', children: ['ghost'] }));
      const url = await serve(relayDir);

      const res = await fetch(url);
      expect(res.status).toBe(500);
      const html = await res.text();
      expect(html).toContain('Cannot render this run');
      expect(html).toContain('ghost');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: I3 — the surface is read-only. A write method is refused outright rather
  // than silently ignored, so the read-only contract is observable, not just
  // implicit in there being no write code.
  test('refuses non-GET methods', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);
      const server = createWebViewServer({ relayDir });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port.toString()}/`, { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('GET');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('returns 404 for an unknown path', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedFixture(relayDir);
      const url = await serve(relayDir);
      const res = await fetch(`${url}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
