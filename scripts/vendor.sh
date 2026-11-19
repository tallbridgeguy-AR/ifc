#!/usr/bin/env bash
# Download pinned copies of three.js and web-ifc into ./vendor so the viewer
# loads nothing from third-party CDNs at runtime. npm verifies each package
# tarball against the registry's published integrity hash.
#
# Usage: scripts/vendor.sh          (needs node/npm and tar)
set -euo pipefail

THREE_VERSION="${THREE_VERSION:-0.160.0}"
WEBIFC_VERSION="${WEBIFC_VERSION:-0.0.66}"

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Fetching three@${THREE_VERSION} and web-ifc@${WEBIFC_VERSION}…"
( cd "$tmp" && npm pack --silent "three@${THREE_VERSION}" "web-ifc@${WEBIFC_VERSION}" >/dev/null )
mkdir -p "$tmp/three" "$tmp/webifc"
tar -xzf "$tmp/three-${THREE_VERSION}.tgz" -C "$tmp/three"
tar -xzf "$tmp/web-ifc-${WEBIFC_VERSION}.tgz" -C "$tmp/webifc"

dest="$root/vendor"
rm -rf "$dest"
mkdir -p "$dest/three/addons/controls" "$dest/three/addons/renderers" "$dest/web-ifc"

cp "$tmp/three/package/build/three.module.js" "$dest/three/"
cp "$tmp/three/package/examples/jsm/controls/OrbitControls.js" "$dest/three/addons/controls/"
cp "$tmp/three/package/examples/jsm/renderers/CSS2DRenderer.js" "$dest/three/addons/renderers/"
cp "$tmp/three/package/LICENSE" "$dest/three/LICENSE"

cp "$tmp/webifc/package/web-ifc-api.js" "$dest/web-ifc/"
cp "$tmp/webifc/package/"web-ifc*.wasm "$dest/web-ifc/"
cp "$tmp/webifc/package/LICENSE"* "$dest/web-ifc/" 2>/dev/null || true

# Record exactly what was vendored.
( cd "$dest" && find . -type f ! -name CHECKSUMS.txt -print0 | sort -z | xargs -0 sha256sum > CHECKSUMS.txt )
printf 'three %s\nweb-ifc %s\n' "$THREE_VERSION" "$WEBIFC_VERSION" > "$dest/VERSIONS.txt"
echo "Vendored into $dest:"
cat "$dest/VERSIONS.txt"
