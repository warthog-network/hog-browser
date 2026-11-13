#!/usr/bin/env bash
# Copy the parts of Hog the Chromium shell reuses (server.mjs and friends,
# public/ UI, node builds, guard.py for Settings -> Containers) into
# electron/hog-app. electron-builder ships that folder as a plain directory
# (not inside app.asar) so `node server.mjs` and `python3` can read it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${HERE}/hog-app"

if [ ! -f "${ROOT}/public/wallet-bundle.js" ]; then
  echo "public/*-bundle.js missing: run 'npm ci && npm run build' in the repo root first" >&2
  exit 1
fi
if [ ! -d "${ROOT}/node_modules/ws" ]; then
  echo "node_modules/ws missing: run 'npm ci' in the repo root first" >&2
  exit 1
fi

rm -rf "${OUT}"
mkdir -p "${OUT}/node_modules"
cp -a \
  "${ROOT}/hog" \
  "${ROOT}/guard.py" \
  "${ROOT}/shell.py" \
  "${ROOT}/share_page.py" \
  "${ROOT}/bookmark_files.py" \
  "${ROOT}/server_guard.py" \
  "${ROOT}/mobile_guard.py" \
  "${ROOT}/server.mjs" \
  "${ROOT}/mining.mjs" \
  "${ROOT}/stratum.mjs" \
  "${ROOT}/tailnet.mjs" \
  "${ROOT}/files.mjs" \
  "${ROOT}/mobile.mjs" \
  "${ROOT}/jellyfin-lan.mjs" \
  "${ROOT}/opfs-polyfill.js" \
  "${ROOT}/package.json" \
  "${OUT}/"
cp -a "${ROOT}/public" "${ROOT}/vendor" "${ROOT}/node-defi" "${ROOT}/node-mainnet" "${OUT}/"
# server.mjs only imports "ws" from npm; the wallet and xterm are prebuilt bundles in public/.
cp -a "${ROOT}/node_modules/ws" "${OUT}/node_modules/"
cp -a "${HERE}/guard-bridge.py" "${HERE}/webkit-import.py" "${HERE}/geoclue-locate.py" "${OUT}/"
find "${OUT}" -type d -name '__pycache__' -prune -exec rm -rf {} +
echo "staged $(du -sh "${OUT}" | cut -f1) into ${OUT}"
