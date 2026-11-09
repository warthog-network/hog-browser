#!/usr/bin/env bash
# Build a .deb that installs Hog Browser under /opt/hog-browser.
# Does not need root. Leaves the source tree's node_modules alone by building
# in a temporary copy. warthog-js comes from npm (GitHub pin in package.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v dpkg-deb >/dev/null; then
  echo "dpkg-deb is required (apt install dpkg-dev)" >&2
  exit 1
fi
if ! command -v npm >/dev/null; then
  echo "npm is required" >&2
  exit 1
fi
if ! command -v rsync >/dev/null; then
  echo "rsync is required" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(dpkg --print-architecture)"
PKG_NAME="hog-browser_${VERSION}_${ARCH}"
OUT_DIR="${ROOT}/dist"
DEB_PATH="${OUT_DIR}/${PKG_NAME}.deb"

WORK="$(mktemp -d)"
STAGE="${WORK}/stage"
trap 'rm -rf "${WORK}"' EXIT

HB="${WORK}/hog-browser"

echo "==> Copying hog-browser into a clean build tree"
mkdir -p "${HB}"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.github/' \
  --exclude 'packaging/' \
  "${ROOT}/" "${HB}/"

echo "==> npm ci + build (bundles) + prune production deps"
(
  cd "${HB}"
  npm ci
  npm run build
  test -f public/wallet-bundle.js
  npm prune --omit=dev
  # npm prune can leave optional @esbuild/* platform stubs; drop them.
  rm -rf node_modules/esbuild node_modules/@esbuild
)

echo "==> Staging package tree"
APP="${STAGE}/opt/hog-browser"
mkdir -p \
  "${APP}" \
  "${APP}/libexec" \
  "${STAGE}/usr/bin" \
  "${STAGE}/usr/share/applications" \
  "${STAGE}/usr/share/polkit-1/actions" \
  "${STAGE}/usr/share/icons/hicolor/48x48/apps" \
  "${STAGE}/usr/share/icons/hicolor/128x128/apps" \
  "${STAGE}/usr/share/icons/hicolor/256x256/apps" \
  "${STAGE}/usr/share/icons/hicolor/scalable/apps" \
  "${STAGE}/etc/sysctl.d" \
  "${STAGE}/DEBIAN"

install -m 644 "${ROOT}/packaging/99-hog-tailscale.conf" \
  "${STAGE}/etc/sysctl.d/99-hog-tailscale.conf"
install -m 755 "${ROOT}/packaging/hog-nvidia-toolkit-install" \
  "${APP}/libexec/hog-nvidia-toolkit-install"
install -m 644 "${ROOT}/packaging/org.hog.Browser.nvidia-toolkit-install.policy" \
  "${STAGE}/usr/share/polkit-1/actions/org.hog.Browser.nvidia-toolkit-install.policy"

# Runtime only. Bundles are already in public/ from the build step.
# warthog-js is compiled into the wallet bundle (and kept in node_modules).
cp -a \
  "${HB}/hog" \
  "${HB}/guard.py" \
  "${HB}/shell.py" \
  "${HB}/share_page.py" \
  "${HB}/server.mjs" \
  "${HB}/opfs-polyfill.js" \
  "${HB}/package.json" \
  "${HB}/package-lock.json" \
  "${APP}/"

cp -a "${HB}/public" "${APP}/"
cp -a "${HB}/node_modules" "${APP}/"

find "${APP}" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "${APP}" -type f -name '*.pyc' -delete

chmod 755 "${APP}/hog"

# Launcher on PATH. exec keeps argv; Path(__file__).resolve() stays under /opt.
cat > "${STAGE}/usr/bin/hog-browser" << 'LAUNCH'
#!/bin/sh
exec /opt/hog-browser/hog "$@"
LAUNCH
chmod 755 "${STAGE}/usr/bin/hog-browser"

cat > "${STAGE}/usr/share/applications/org.hog.Browser.desktop" << 'DESKTOP'
[Desktop Entry]
Type=Application
Name=Hog Browser
Comment=A small local browser with a Warthog wallet in the sidebar
Exec=hog-browser %U
Icon=org.hog.Browser
Terminal=false
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;
StartupWMClass=hog
DESKTOP

install -m 644 "${HB}/public/hog-icon-48.png" \
  "${STAGE}/usr/share/icons/hicolor/48x48/apps/org.hog.Browser.png"
install -m 644 "${HB}/public/hog-icon-128.png" \
  "${STAGE}/usr/share/icons/hicolor/128x128/apps/org.hog.Browser.png"
install -m 644 "${HB}/public/hog-icon.png" \
  "${STAGE}/usr/share/icons/hicolor/256x256/apps/org.hog.Browser.png"
install -m 644 "${HB}/public/hog-icon.svg" \
  "${STAGE}/usr/share/icons/hicolor/scalable/apps/org.hog.Browser.svg"

INSTALLED_SIZE="$(du -sk "${STAGE}" | awk '{print $1}')"

cat > "${STAGE}/DEBIAN/control" << CONTROL
Package: hog-browser
Version: ${VERSION}
Section: web
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Depends: python3, python3-gi, python3-gi-cairo, python3-cairo, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, gir1.2-pango-1.0, nodejs (>= 18)
Recommends: pkexec
Maintainer: jax <jaxwhitefang@proton.me>
Description: Hog Browser
 A small local Ubuntu browser with a Warthog wallet in the sidebar.
 Ships a GTK3 + WebKitGTK shell and a local Node server under
 /opt/hog-browser. User data lives in ~/.local/share/hog-browser.
 Installs /etc/sysctl.d/99-hog-tailscale.conf so a Tailscale exit
 node can forward IPv4 and IPv6; apply with sudo sysctl --system.
 Ships a root helper that pkexec can run to install the NVIDIA
 Container Toolkit for Docker Engine.
CONTROL

mkdir -p "${OUT_DIR}"
echo "==> Building ${DEB_PATH}"
dpkg-deb --root-owner-group --build "${STAGE}" "${DEB_PATH}"
ls -lh "${DEB_PATH}"
echo "OK ${DEB_PATH}"
