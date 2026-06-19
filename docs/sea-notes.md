# Node SEA viability notes (M0 smoke test)

Status: **viable** on this machine. A single self-contained binary built from a
CJS entry runs and prints `hello` with `node` absent from `PATH`.

This is a viability smoke test only. Real single-binary packaging of the Relay
spine is a deferred effort; nothing in M0 depends on the binary.

## Environment that worked

- Node `v22.22.3`
- macOS `26.5.1`, `arm64`
- `postject` `1.0.0-alpha.6`
- `codesign` from Xcode command-line tools

## Caveats (load-bearing)

- **Experimental.** Node SEA is an experimental feature; the API and flags can
  change between Node versions. Pin the Node version when this is relied on.
- **CommonJS-only.** The SEA entry must be CJS. `sea/hello.js` is plain CJS
  (no `import`/`export`); an ESM entry will not build. The real spine is bundled
  to CJS by esbuild (`scripts/build.mjs`, `format: 'cjs'`) for this reason.
- **macOS requires signature surgery.** You must remove the carrier binary's
  signature before injecting the segment, and re-sign it afterward, or macOS
  refuses to execute the mutated binary.
- **`fsync` vs `F_FULLFSYNC`** is unrelated to SEA but noted across the design;
  see `docs/relay-state-layout.md`.

## Exact steps that worked

Run `scripts/hello-sea.sh`, which performs:

1. **Build the blob** from the CJS entry and config:

   ```bash
   node --experimental-sea-config sea/sea-config.json
   ```

   `sea/sea-config.json`:

   ```json
   {
     "main": "sea/hello.js",
     "output": "build/hello.blob",
     "disableExperimentalSEAWarning": true
   }
   ```

2. **Copy the running node binary** as the carrier:

   ```bash
   cp "$(command -v node)" build/hello-sea
   ```

3. **Remove the existing signature** (required before mutating the mach-o on
   macOS):

   ```bash
   codesign --remove-signature build/hello-sea
   ```

4. **Inject the blob as a `NODE_SEA` mach-o segment.** On macOS the segment name
   must be `NODE_SEA` (via `--macho-segment-name`), and the sentinel fuse is the
   standard Node value:

   ```bash
   npx --no-install postject build/hello-sea NODE_SEA_BLOB build/hello.blob \
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
     --macho-segment-name NODE_SEA
   ```

5. **Re-sign ad-hoc** so macOS will execute the mutated binary:

   ```bash
   codesign --sign - build/hello-sea
   ```

## Verification that passed

```bash
# node absent from PATH, binary invoked by absolute path:
PATH=/usr/bin:/bin /Users/jasonhulbert/Projects/relay/build/hello-sea
# -> prints: hello   (exit 0)
```

This confirms the binary is self-contained: it carries its own Node runtime and
the embedded blob, with no dependency on a `node` on `PATH`.
