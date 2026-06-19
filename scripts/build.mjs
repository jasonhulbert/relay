import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// The version is baked in at build time so the bundled CLI (and the later SEA
// single-binary, which cannot read package.json at runtime) reports it without
// any filesystem lookup.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  // CommonJS output keeps the entrypoint on the same module format Node SEA
  // requires, so the packaging milestone reuses this bundle shape.
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  define: {
    __RELAY_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
});
