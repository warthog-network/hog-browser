#!/bin/sh
# Pack the Warthog mining helper into one AppImage with Node inside, so it runs
# on a double-click with no system Node. Modeled on browser-wallet's
# scripts/build-forwarder-appimage.sh: it fetches appimagetool the same way.
#
# Downloads go to a cache (not installed anywhere):
#   - Node (official linux-x64 tarball), checked against nodejs.org SHASUMS256.txt
#   - appimagetool (AppImage/appimagetool continuous)
# Build-time needs: node + npm deps (esbuild) for helper/build.mjs, curl, tar, sha256sum.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/dist"}
NODE_VERSION=${NODE_VERSION:-v22.23.1}
CACHE=${HELPER_BUILD_CACHE:-"${XDG_CACHE_HOME:-$HOME/.cache}/warthog-mining-helper-build"}
NODE_TAR="node-${NODE_VERSION}-linux-x64.tar.xz"
APPDIR=$(mktemp -d)
trap 'rm -rf "$APPDIR"' EXIT
mkdir -p "$CACHE" "$OUT"

# 1. Bundle the helper (one .mjs + node builds + README) into dist/warthog-mining-helper/.
node "$ROOT/helper/build.mjs" >/dev/null
BUNDLE="$ROOT/dist/warthog-mining-helper"

# 2. Node, verified against the official checksums.
if [ ! -f "$CACHE/$NODE_TAR" ]; then
  curl -fsSL -o "$CACHE/$NODE_TAR.part" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"
  mv "$CACHE/$NODE_TAR.part" "$CACHE/$NODE_TAR"
fi
curl -fsSL -o "$CACHE/SHASUMS256-${NODE_VERSION}.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
EXPECTED=$(grep "  ${NODE_TAR}\$" "$CACHE/SHASUMS256-${NODE_VERSION}.txt" | cut -d' ' -f1)
ACTUAL=$(sha256sum "$CACHE/$NODE_TAR" | cut -d' ' -f1)
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Node tarball checksum mismatch (expected ${EXPECTED:-none}, got $ACTUAL)" >&2
  rm -f "$CACHE/$NODE_TAR"
  exit 1
fi
echo "node ${NODE_VERSION} sha256 OK: $ACTUAL" >&2

# 3. AppDir: Node binary + the bundled helper.
mkdir -p "$APPDIR/usr/bin" "$APPDIR/app"
tar -xJf "$CACHE/$NODE_TAR" -C "$APPDIR" --strip-components=2 "node-${NODE_VERSION}-linux-x64/bin/node"
mv "$APPDIR/node" "$APPDIR/usr/bin/node"
tar -xJf "$CACHE/$NODE_TAR" -C "$APPDIR/usr" --strip-components=1 "node-${NODE_VERSION}-linux-x64/LICENSE"
mv "$APPDIR/usr/LICENSE" "$APPDIR/usr/NODE-LICENSE"
cp -a "$BUNDLE/." "$APPDIR/app/"
rm -f "$APPDIR/app/warthog-mining-helper.sh" "$APPDIR/app/Warthog-Mining-Helper.cmd" "$APPDIR/app/warthog-mining-helper.desktop" "$APPDIR/app/icon.png"
cp "$ROOT/helper/icon-256.png" "$APPDIR/warthog-mining-helper.png"
cp "$ROOT/helper/icon-256.png" "$APPDIR/.DirIcon"

cat > "$APPDIR/warthog-mining-helper.desktop" << 'DESK'
[Desktop Entry]
Type=Application
Name=Warthog mining helper
Comment=Solo mine with BzMiner to a Warthog browser node in Brave
Exec=warthog-mining-helper
Icon=warthog-mining-helper
StartupWMClass=warthog-mining-helper
Categories=Network;
Terminal=false
DESK

cat > "$APPDIR/AppRun" << 'RUN'
#!/bin/sh
# Bundled Node runs the bundled helper; it opens the control page in the default browser.
HERE=$(dirname "$(readlink -f "$0")")
exec "$HERE/usr/bin/node" "$HERE/app/warthog-mining-helper.mjs" "$@"
RUN
chmod +x "$APPDIR/AppRun"
# mktemp is private to this user. Current appimagetool rejects that.
chmod -R a+rX "$APPDIR"

# 4. appimagetool, fetched like the forwarder build does.
TOOL=${APPIMAGETOOL:-"$CACHE/appimagetool-x86_64.AppImage"}
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
echo "appimagetool sha256: $(sha256sum "$TOOL" | cut -d' ' -f1)" >&2

IMAGE="$OUT/Warthog_Mining_Helper-x86_64.AppImage"
rm -f "$IMAGE"
env -u VERSION ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$IMAGE" >&2
(cd "$OUT" && sha256sum "$(basename "$IMAGE")" > "$(basename "$IMAGE").sha256")
echo "$IMAGE"
