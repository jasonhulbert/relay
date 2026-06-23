// The local read-only HTTP surface for the operator web view. It serves the render
// of `.relay/` and writes nothing — the supervisor view writes nothing to `.relay/`:
// every request RE-runs `projectRun` against the store on disk, so the page always
// reflects the current per-node files — mutate a node file and refresh, and the
// change shows, because the global view is composed at read time, never cached as a
// shared artifact. There is no write path anywhere in this module.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { projectRun, projectSupervisorNode } from './projection';
import { renderErrorPage, renderNodePanel, renderRunPage } from './render';
import type { NodeView } from './projection';

export interface WebViewServerOptions {
  // The `.relay/` store directory to render (the per-project global store for a
  // real run; a temp dir in tests). Read-only.
  relayDir: string;
}

// Parse the drill-in panel's `?capture=<n>` index off the request URL. A missing,
// non-numeric, or negative value is capture 0 (the panel's opening capture) — the
// render clamps an over-large index to the last real capture, so navigation is always
// well-defined regardless of the query.
function parseCaptureParam(url: string): number {
  const q = url.indexOf('?');
  if (q === -1) return 0;
  const raw = new URLSearchParams(url.slice(q + 1)).get('capture');
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Look a node up in the composed projection by id — across the reachable tree
// (runLog) and the surfaced orphans — so a panel request resolves the same node the
// run page rendered. Undefined when no such node file exists (the server 404s).
function findNode(
  projection: { runLog: NodeView[]; orphans: NodeView[] },
  nodeId: string,
): NodeView | undefined {
  return (
    projection.runLog.find((n) => n.id === nodeId) ??
    projection.orphans.find((n) => n.id === nodeId)
  );
}

// Build (but do not start) the HTTP server. The caller owns `listen`/`close`, so
// tests can bind an ephemeral port and shut it down deterministically. Only GET
// `/` (and `/index.html`) render the run; anything else is 404, and a write method
// is refused — the surface is read-only.
export function createWebViewServer(opts: WebViewServerOptions): Server {
  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('read-only view: only GET is supported\n');
      return;
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0];

    // The per-node detail (evidence panel + human-supervisor view):
    // `/node/<id>` renders one node's evidence panel, `?capture=<n>` navigates its
    // ordered captures, and below it the human-supervisor detail (self-report, evidence
    // content, verdict, decompose footprints/seams/rationale) — all plain GET, so the
    // read-only contract is unbroken. Like the run page, it recomposes per request
    // and fails loud on an incoherent tree. An unknown node id is a 404 (the same as any
    // unknown path); a node that EXISTS but has a half-written evidence file still renders
    // 200 with an inline "(artifact missing)" notice, never the error page (Rule 11).
    if (path.startsWith('/node/')) {
      const nodeId = decodeURIComponent(path.slice('/node/'.length));
      const capture = parseCaptureParam(url);
      projectRun(opts.relayDir)
        .then((projection) => {
          const node = findNode(projection, nodeId);
          if (node === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found\n');
            return undefined;
          }
          // The node exists, so the supervisor read resolves (a missing evidence FILE is
          // a typed marker the detail renders inline, not a throw).
          return projectSupervisorNode(opts.relayDir, nodeId).then((supervisor) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderNodePanel(projection, node, capture, supervisor));
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderErrorPage(message));
        });
      return;
    }

    if (path !== '/' && path !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }

    // Recompose on every request: the page is a read-time projection, so a refresh
    // always reflects the store's current per-node files. A failed projection
    // (missing root, dangling child, cycle) fails loud as an error page with a 5xx
    // rather than a blank or partial tree (Rule 11).
    projectRun(opts.relayDir).then(
      (projection) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderRunPage(projection));
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderErrorPage(message));
      },
    );
  });
}

export interface StartedWebView {
  server: Server;
  // The base URL the server is listening on (host + bound port).
  url: string;
}

// Start the server and resolve once it is listening, with the resolved URL. Binds
// loopback only (operator-local supervision, not a network service). `port: 0`
// lets the OS pick a free port — the default for tests; the CLI passes a fixed one.
export function startWebView(
  opts: WebViewServerOptions & { port?: number; host?: string },
): Promise<StartedWebView> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const server = createWebViewServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://${host}:${addr.port.toString()}` });
    });
  });
}
