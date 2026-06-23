// The trivial fixture page the visual subsystem is built and tested against before
// the real panel exercises it. It is deliberately tiny but
// covers the surface's whole contract: a stable heading and a labelled button for
// the a11y snapshot (semantic read), a click that mutates visible text (so an
// interaction has an observable, queryable effect), and enough structure to take a
// screenshot of. No build step, no framework — a single self-contained HTML string
// served over loopback, the same shape the WebSurface drives a real app over.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The fixture markup. The heading and button text are the semantic anchors the
// snapshot assertions key on; clicking the button sets `#status` to a known string,
// which `queryState` reads back to prove an interaction took effect.
//
// Two regions support the visual critic path: a stable target component
// (`#panel`, the heading + status + button) the critic scopes its element-scoped
// check to, and an UNRELATED self-updating region (`#clock`, a tick counter on a
// timer) that changes every frame. A component-scoped check must ignore the ticking
// clock — that is the element-scope isolation the scoped snapshot/screenshot proves.
export const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Relay Surface Fixture</title>
  </head>
  <body>
    <!-- Unrelated changing region: ticks on a timer, must not affect a scoped check. -->
    <aside id="clock" aria-label="clock" data-testid="clock">tick 0</aside>
    <main id="panel" aria-label="panel">
      <h1>Relay Surface Fixture</h1>
      <p id="status" data-testid="status">idle</p>
      <button id="go" type="button">Run check</button>
    </main>
    <script>
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'ran';
      });
      let ticks = 0;
      setInterval(() => {
        ticks += 1;
        document.getElementById('clock').textContent = 'tick ' + ticks;
      }, 50);
    </script>
  </body>
</html>
`;

export interface StartedFixture {
  server: Server;
  // The loopback base URL the fixture is served on.
  url: string;
}

// Serve the fixture over loopback on an OS-picked port. The WebSurface navigates a
// real browser to a URL (not a `file://` path, which has a11y/security quirks), so
// the fixture is a real, if minimal, HTTP origin — the same way the app is reached.
// The caller owns `close()`.
export function startFixture(opts: { host?: string; port?: number } = {}): Promise<StartedFixture> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://${host}:${addr.port.toString()}` });
    });
  });
}
