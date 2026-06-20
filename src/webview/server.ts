// The local read-only HTTP surface for the operator web view (M5 Phase 2). It
// serves the render of `.relay/` and writes nothing (I3): every request RE-runs
// `projectRun` against the store on disk, so the page always reflects the current
// per-node files — mutate a node file and refresh, and the change shows, because
// the global view is composed at read time, never cached as a shared artifact (A6,
// design §4). There is no write path anywhere in this module.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { projectRun } from './projection';
import { renderErrorPage, renderRunPage } from './render';

export interface WebViewServerOptions {
  // The `.relay/` store directory to render (the per-project global store for a
  // real run; a temp dir in tests). Read-only.
  relayDir: string;
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

    const path = (req.url ?? '/').split('?')[0];
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
