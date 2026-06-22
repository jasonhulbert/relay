import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { atomicWriteFile, relayPaths, writeManifest, writeNode } from '../relay-state/index';
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
    sketch: { notes: [] },
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
        sketch: { notes: [] },
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

  // A run whose leaf carries ordered evidence captures — the shape the drill-in panel
  // route renders. Kept local to the server test so it exercises the real HTTP path
  // (projectRun → renderNodePanel) end to end over a seeded store.
  async function seedWithEvidence(relayDir: string): Promise<void> {
    await writeManifest(relayDir, {
      runId: 'run-1',
      rootId: 'root',
      spec: spec('a run whose leaf carries evidence'),
      sketch: { notes: [] },
      createdAt: '2026-06-18T00:00:00.000Z',
    });
    await writeNode(
      relayDir,
      node({ id: 'root', kind: 'branch', status: 'done', children: ['leaf'] }),
    );
    await writeNode(
      relayDir,
      node({
        id: 'leaf',
        parentId: 'root',
        kind: 'leaf',
        status: 'done',
        evidenceRefs: [
          { runId: 'run-1', path: 'leaf/diff.md', kind: 'diff', summary: 'the diff' },
          {
            runId: 'run-1',
            path: 'leaf/self-report.md',
            kind: 'self-report',
            summary: 'the report',
          },
        ],
      }),
    );
  }

  // WHY (Validation: the panel renders a node's evidence over a plain GET, I3): the
  // `/node/<id>` route with `?capture=<n>` must serve the requested capture's panel —
  // navigation is GET, so this is the whole drive path the dogfood replays.
  test('serves the drill-in panel for a node, navigating captures by GET', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedWithEvidence(relayDir);
      const url = await serve(relayDir);

      const first = await fetch(`${url}/node/leaf`);
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toMatch(/text\/html/);
      const firstHtml = await first.text();
      expect(firstHtml).toContain('data-testid="evidence-panel"');
      expect(firstHtml).toContain('the diff');
      expect(firstHtml).toContain('capture 1 of 2');

      const second = await fetch(`${url}/node/leaf?capture=1`);
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain('the report');
      expect(secondHtml).toContain('capture 2 of 2');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY: a node id with no file is a 404, the same as any unknown path — the route
  // must not 500 or render a blank panel for a node that does not exist.
  test('returns 404 for an unknown node id', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedWithEvidence(relayDir);
      const url = await serve(relayDir);
      const res = await fetch(`${url}/node/ghost`);
      expect(res.status).toBe(404);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Materialize an evidence file under the run's evidence dir, the way the orchestrator
  // persists artifacts (evidence/<runId>/<nodeId>/<file>).
  async function writeEvidence(
    relayDir: string,
    nodeId: string,
    file: string,
    content: string,
  ): Promise<void> {
    await atomicWriteFile(join(relayPaths(relayDir).evidenceDir('run-1'), nodeId, file), content);
  }

  // A done leaf whose evidence files (self-report, diff, verdict) are materialized on
  // disk — the shape the human-supervisor detail reads CONTENT from (Sol 1, Phase 3).
  async function seedWithEvidenceFiles(relayDir: string): Promise<void> {
    await writeManifest(relayDir, {
      runId: 'run-1',
      rootId: 'root',
      spec: spec('a run whose leaf carries on-disk evidence'),
      sketch: { notes: [] },
      createdAt: '2026-06-18T00:00:00.000Z',
    });
    await writeNode(
      relayDir,
      node({ id: 'root', kind: 'branch', status: 'done', children: ['leaf'] }),
    );
    await writeNode(
      relayDir,
      node({
        id: 'leaf',
        parentId: 'root',
        kind: 'leaf',
        status: 'done',
        selfReport: 'wrote the data module',
        verdict: {
          pass: true,
          provider: 'codex',
          rationale: 'the data layer satisfies the spec',
          evidenceRefs: [],
        },
        evidenceRefs: [
          { runId: 'run-1', path: 'leaf/self-report.md', kind: 'self-report', summary: 'report' },
          { runId: 'run-1', path: 'leaf/diff.patch', kind: 'diff', summary: 'the diff' },
          { runId: 'run-1', path: 'leaf/verdict.md', kind: 'verdict', summary: 'the verdict' },
        ],
      }),
    );
    await writeEvidence(relayDir, 'leaf', 'self-report.md', 'wrote the data module in full');
    await writeEvidence(relayDir, 'leaf', 'diff.patch', 'A src/data/widget.ts\n+export const W = 1;');
    await writeEvidence(relayDir, 'leaf', 'verdict.md', '# critic verdict\n\n- Result: PASS\n');
  }

  // WHY (Validation: the per-node route surfaces the self-report, diff, verdict, and
  // rationale): the `/node/<id>` page is the human supervisor's window into a node. This
  // drives the REAL HTTP path (projectRun + projectSupervisorNode → renderNodePanel) and
  // pins that the orchestrator-visible narrative AND the on-disk evidence content reach
  // the served page — the OTHER side of the C7 split the run page deliberately withholds.
  test('the per-node route serves the human-supervisor detail from disk', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await seedWithEvidenceFiles(relayDir);
      const url = await serve(relayDir);

      const res = await fetch(`${url}/node/leaf`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // The evidence panel (M9) is still present — the detail is appended, not replacing.
      expect(html).toContain('data-testid="evidence-panel"');
      expect(html).toContain('data-testid="supervisor-detail"');
      // Narrative (record) and evidence-file CONTENT (disk) both surface.
      expect(html).toContain('wrote the data module'); // self-report narrative
      expect(html).toContain('export const W = 1;'); // diff content read off disk
      expect(html).toContain('the data layer satisfies the spec'); // verdict rationale
      expect(html).toContain('Result: PASS'); // verdict.md content
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // WHY (Rule 11, the Phase 3 headline): a node that EXISTS but whose verdict.md was
  // never written (a blocked node has a self-report but no verdict) must still serve 200
  // with an inline "(artifact missing)" notice — NOT the 500 error page. A route that
  // read evidence files eagerly without the typed marker would 500 the whole page on one
  // half-written file, hiding everything else.
  test('a node missing an evidence file still returns 200 with an inline missing notice', async () => {
    const base = await mkdtemp(join(tmpdir(), 'relay-webview-srv-'));
    const relayDir = join(base, '.relay');
    try {
      await writeManifest(relayDir, {
        runId: 'run-1',
        rootId: 'root',
        spec: spec('a run with a blocked leaf'),
        sketch: { notes: [] },
        createdAt: '2026-06-18T00:00:00.000Z',
      });
      await writeNode(
        relayDir,
        node({ id: 'root', kind: 'branch', status: 'active', children: ['leaf'] }),
      );
      await writeNode(
        relayDir,
        node({
          id: 'leaf',
          parentId: 'root',
          kind: 'leaf',
          status: 'blocked',
          selfReport: 'attempted the change',
          evidenceRefs: [
            { runId: 'run-1', path: 'leaf/self-report.md', kind: 'self-report', summary: 'r' },
            { runId: 'run-1', path: 'leaf/verdict.md', kind: 'verdict', summary: 'v' }, // never written
          ],
        }),
      );
      await writeEvidence(relayDir, 'leaf', 'self-report.md', 'attempted the change in full');
      const url = await serve(relayDir);

      const res = await fetch(`${url}/node/leaf`);
      expect(res.status).toBe(200); // NOT 500 — the missing file degrades, not the route
      const html = await res.text();
      expect(html).toContain('attempted the change in full'); // the present file still renders
      expect(html).toContain('(artifact missing)'); // the absent verdict.md is surfaced
      expect(html).not.toContain('Cannot render this run'); // never the error page
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
