#!/usr/bin/env bash
# Throwaway Node SEA viability smoke test (M0).
#
# Proves the single-binary path works on macOS before any milestone relies on
# it. This is NOT the real packaging of the spine; real single-binary packaging
# is a deferred effort. Node SEA is experimental and CommonJS-only.
#
# Steps mirror the macOS SEA recipe: build a blob from a CJS entry, copy the
# running `node` as the carrier, strip its signature, inject the blob as a
# NODE_SEA mach-o segment, then re-sign ad-hoc so macOS will execute it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="build"
BIN="$OUT_DIR/hello-sea"
BLOB="$OUT_DIR/hello.blob"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

mkdir -p "$OUT_DIR"

# 1. Generate the SEA blob from the CJS entry + config.
node --experimental-sea-config sea/sea-config.json

# 2. Copy the running node binary as the carrier.
cp "$(command -v node)" "$BIN"

# 3. Remove the existing signature (required before mutating the mach-o).
codesign --remove-signature "$BIN"

# 4. Inject the blob as a NODE_SEA mach-o segment.
npx --no-install postject "$BIN" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse "$FUSE" \
  --macho-segment-name NODE_SEA

# 5. Re-sign ad-hoc so macOS Gatekeeper will execute the mutated binary.
codesign --sign - "$BIN"

echo "built: $ROOT/$BIN"
