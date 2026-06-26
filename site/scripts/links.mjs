// Repeatable internal-link check for the built site.
//
// Scans dist/ for every <a href> and fails (non-zero exit) on:
//   - a broken internal link (resolves to no file in dist/);
//   - a base-missing absolute link (an absolute `/…` link that does not carry
//     the configured base — e.g. `/docs/x` instead of `/relay/docs/x`);
//   - a dead anchor (an in-page or cross-page `#id` no element carries).
// External links (http, https, protocol-relative //, mailto, tel) are skipped.
//
// `npm run links` builds first, then runs this against dist/ — no runtime deps,
// no browser. It is the docs coherence gate's link half (the a11y half is
// scripts/a11y.mjs); both read the same production build.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(projectRoot, 'dist');

// Base is parsed from astro.config (never hard-coded) so the check and the
// build can never disagree about the deployment prefix.
const cfg = readFileSync(join(projectRoot, 'astro.config.mjs'), 'utf8');
const BASE = (cfg.match(/base:\s*['"]([^'"]+)['"]/)?.[1] ?? '/').replace(/\/?$/, '/');
const BASE_NTS = BASE.replace(/\/+$/, ''); // base without trailing slash, e.g. '/relay'

if (!existsSync(DIST)) {
  console.error(`No dist/ at ${DIST} — run \`astro build\` first.`);
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
// Every physical output file as a posix path relative to dist/, for resolution.
const relFiles = new Set(files.map((f) => relative(DIST, f).split(/[\\/]/).join('/')));

// id="…" set per html file, parsed lazily and cached (anchor-target checks).
const idCache = new Map();
function idsOf(file) {
  let ids = idCache.get(file);
  if (ids) return ids;
  ids = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(/\sid=["']([^"']+)["']/g)) ids.add(m[1]);
  idCache.set(file, ids);
  return ids;
}

// Resolve a base-relative path to the dist .html file it serves, or null —
// covering directory-index (`x/` → `x/index.html`) and extensionless
// (`x` → `x/index.html` or `x.html`) URL shapes.
function resolveHtml(rel) {
  const path = rel.replace(/^\//, '');
  const candidates =
    path === '' || path.endsWith('/')
      ? [path + 'index.html']
      : [path + '/index.html', path + '.html', path];
  for (const c of candidates) if (relFiles.has(c)) return join(DIST, c);
  return null;
}

// Any output file (assets included) — broken-link resolution beyond html.
function resolvesToFile(rel) {
  return resolveHtml(rel) !== null || relFiles.has(rel.replace(/^\//, ''));
}

const errors = [];
const report = (file, href, msg) => errors.push({ file: relative(DIST, file), href, msg });

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const selfIds = idsOf(file);
  for (const m of html.matchAll(/\shref=["']([^"']*)["']/g)) {
    const raw = m[1];
    if (!raw) continue;
    if (/^(https?:)?\/\//i.test(raw)) continue; // external / protocol-relative
    if (/^(mailto:|tel:|data:|javascript:)/i.test(raw)) continue;

    if (raw.startsWith('#')) {
      const id = decodeURIComponent(raw.slice(1));
      if (id && !selfIds.has(id)) report(file, raw, `dead in-page anchor #${id}`);
      continue;
    }

    const [beforeHash, hash] = raw.split('#');
    const cleanPath = beforeHash.split('?')[0];

    if (cleanPath.startsWith('/')) {
      const carriesBase =
        cleanPath === BASE_NTS || cleanPath === BASE || cleanPath.startsWith(BASE_NTS + '/');
      if (!carriesBase) {
        report(file, raw, `base-missing absolute link (expected ${BASE} prefix)`);
        continue;
      }
      const rel = cleanPath.slice(BASE_NTS.length);
      const htmlTarget = resolveHtml(rel);
      if (!htmlTarget && !resolvesToFile(rel)) {
        report(file, raw, 'broken internal link (no matching file in dist)');
        continue;
      }
      if (hash && htmlTarget) {
        const id = decodeURIComponent(hash);
        if (id && !idsOf(htmlTarget).has(id)) report(file, raw, `dead cross-page anchor #${id}`);
      }
    } else {
      // Relative link — resolve against the current page's served directory.
      const dir = dirname(relative(DIST, file)).split(/[\\/]/).join('/');
      const rel = join(dir === '.' ? '' : dir, cleanPath).split(/[\\/]/).join('/');
      const htmlTarget = resolveHtml(rel);
      if (!htmlTarget && !resolvesToFile(rel)) {
        report(file, raw, 'broken relative link');
      } else if (hash && htmlTarget) {
        const id = decodeURIComponent(hash);
        if (id && !idsOf(htmlTarget).has(id)) report(file, raw, `dead anchor #${id}`);
      }
    }
  }
}

if (errors.length) {
  console.log(`\n✗ ${errors.length} link problem(s) across ${htmlFiles.length} page(s):\n`);
  for (const e of errors) console.log(`  [${e.msg}]\n    in ${e.file}\n    href="${e.href}"\n`);
  process.exit(1);
}
console.log(
  `\n✓ links OK — 0 broken, 0 base-missing, 0 dead anchors across ${htmlFiles.length} page(s).\n`,
);
process.exit(0);
