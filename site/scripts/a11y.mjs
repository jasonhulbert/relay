// Repeatable accessibility audit for the built site.
//
// Runs the project's own axe-core against the production build over the Chrome
// DevTools Protocol — no browser interaction, no extra runtime deps. It builds
// nothing itself; `npm run a11y` builds first, then this previews `dist/` and
// scans it. Every page is checked in BOTH themes. prefers-reduced-motion:reduce
// is emulated so the entrance-reveal gate skips itself and all content is
// painted (axe skips elements it computes as hidden).
//
// Exit code: non-zero if any SERIOUS or CRITICAL violation is found, so this
// doubles as a CI gate. moderate/minor and axe "incomplete" (needs-review)
// items are reported but do not fail the run.
//
// Env overrides:
//   A11Y_PAGES  comma-separated page paths relative to the site base
//               (default: the landing page + the seed docs page)
//   A11Y_URL    scan an already-running server at this base URL instead of
//               spawning `astro preview` (e.g. a running dev server)
//   CHROME_PATH path to a Chrome/Chromium binary (auto-detected otherwise)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// axe-core dist, resolved from the installed dev dependency (never hard-coded).
const axeDir = dirname(require.resolve('axe-core/package.json'));
const AXE = readFileSync(join(axeDir, 'axe.min.js'), 'utf8');
const axeVersion = require('axe-core/package.json').version;

const PAGES = (process.env.A11Y_PAGES || ',docs/what-is-relay/').split(',');
const THEMES = ['dark', 'light'];
// The WCAG 2.0/2.1 A + AA rule set, plus axe best-practice checks.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH to a browser binary.');
}

// Spawn `astro preview` and resolve once it prints its Local URL (which already
// includes the configured base path, e.g. http://localhost:4321/relay/).
function startPreview() {
  return new Promise((resolve, reject) => {
    const bin = join(projectRoot, 'node_modules', '.bin', 'astro');
    const proc = spawn(bin, ['preview'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/Local\s+(https?:\/\/\S+)/);
      if (m) {
        proc.stdout.off('data', onData);
        resolve({ proc, baseUrl: m[1].trim() });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => (buf += d.toString()));
    proc.on('exit', (code) => reject(new Error(`astro preview exited (${code}):\n${buf}`)));
    setTimeout(() => reject(new Error(`timed out waiting for astro preview:\n${buf}`)), 20000);
  });
}

async function main() {
  const CHROME = resolveChrome();
  let preview = null;
  let baseUrl = process.env.A11Y_URL;
  if (!baseUrl) {
    preview = await startPreview();
    baseUrl = preview.baseUrl;
  }
  const urls = PAGES.map((p) => new URL(p.trim(), baseUrl).href);

  const profile = mkdtempSync(join(tmpdir(), 'relay-a11y-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const cleanup = () => {
    try {
      chrome.kill();
    } catch {}
    try {
      preview?.proc.kill();
    } catch {}
  };

  try {
    const portFile = join(profile, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 150 && !port; i++) {
      if (existsSync(portFile)) {
        const f = readFileSync(portFile, 'utf8').split('\n')[0].trim();
        if (f) port = f;
      }
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('Chrome DevTools port never appeared');

    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const _id = ++id;
        pending.set(_id, { res, rej });
        ws.send(JSON.stringify({ id: _id, method, params, sessionId }));
      });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    const waitReady = async () => {
      for (let i = 0; i < 100; i++) {
        const { result } = await send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId,
        );
        if (result.value === 'complete') return;
        await sleep(100);
      }
    };

    const runs = [];
    for (const theme of THEMES) {
      for (const url of urls) {
        await send(
          'Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        await send(
          'Emulation.setEmulatedMedia',
          {
            media: 'screen',
            features: [
              { name: 'prefers-color-scheme', value: theme },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          },
          sessionId,
        );
        await send('Page.navigate', { url }, sessionId);
        await waitReady();
        await sleep(400);
        await send('Runtime.evaluate', { expression: AXE }, sessionId);
        const { result } = await send(
          'Runtime.evaluate',
          {
            expression: `axe.run(document, {
            runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} },
            resultTypes: ['violations', 'incomplete']
          }).then(r => JSON.stringify({
            violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.map(n => n.target).flat().slice(0, 6) })),
            incomplete: r.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length }))
          }))`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId,
        );
        runs.push({ theme, url, ...JSON.parse(result.value) });
      }
    }
    ws.close();

    // Report.
    const all = runs.flatMap((r) =>
      r.violations.map((v) => ({ ...v, theme: r.theme, url: r.url })),
    );
    const blocking = all.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    console.log(`\naxe-core ${axeVersion} — tags: ${TAGS.join(', ')}\n`);
    for (const r of runs) {
      const path = new URL(r.url).pathname;
      console.log(
        `  ${r.theme.padEnd(5)} ${path}  →  ${r.violations.length} violation(s), ${r.incomplete.reduce((n, i) => n + 1, 0)} needs-review`,
      );
    }
    if (blocking.length) {
      console.log(`\n✗ ${blocking.length} serious/critical violation(s):\n`);
      for (const v of blocking) {
        console.log(`  [${v.impact}] ${v.id} — ${v.help}`);
        console.log(`    ${v.theme} ${new URL(v.url).pathname} · ${v.nodes} node(s)`);
        for (const t of v.targets) console.log(`      ${Array.isArray(t) ? t.join(' ') : t}`);
      }
    }
    const moderateMinor = all.length - blocking.length;
    console.log(
      `\n${blocking.length ? '✗ FAIL' : '✓ PASS'} — ${blocking.length} serious/critical` +
        `, ${moderateMinor} moderate/minor, across ${runs.length} page×theme scans.\n`,
    );
    cleanup();
    process.exit(blocking.length ? 1 : 0);
  } catch (err) {
    cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(2);
});
