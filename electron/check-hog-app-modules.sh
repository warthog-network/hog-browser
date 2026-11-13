#!/usr/bin/env bash
# Fail the build if the packaged app is missing hog-app/node_modules/ws.
# Usage: check-hog-app-modules.sh linux|win
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="${HERE}/dist"
target="${1:-linux}"

check_dir() {
  local dir="$1"
  if [ ! -d "${dir}/node_modules/ws" ]; then
    echo "missing ${dir}/node_modules/ws" >&2
    exit 1
  fi
  echo "ok ${dir}/node_modules/ws"
}

case "${target}" in
  linux)
    check_dir "${DIST}/linux-unpacked/resources/hog-app"
    shopt -s nullglob
    debs=("${DIST}"/*.deb)
    if [ ${#debs[@]} -eq 0 ]; then
      echo "no .deb in ${DIST}" >&2
      exit 1
    fi
    if ! dpkg-deb -c "${debs[0]}" | grep -q 'resources/hog-app/node_modules/ws/'; then
      echo "${debs[0]} is missing resources/hog-app/node_modules/ws" >&2
      exit 1
    fi
    echo "ok $(basename "${debs[0]}") contains resources/hog-app/node_modules/ws"
    ;;
  win)
    check_dir "${DIST}/win-unpacked/resources/hog-app"
    shopt -s nullglob
    zips=("${DIST}"/*.zip)
    if [ ${#zips[@]} -gt 0 ]; then
      if ! unzip -l "${zips[0]}" | grep -q 'resources/hog-app/node_modules/ws/'; then
        echo "${zips[0]} is missing resources/hog-app/node_modules/ws" >&2
        exit 1
      fi
      echo "ok $(basename "${zips[0]}") contains resources/hog-app/node_modules/ws"
    fi
    ;;
  *)
    echo "usage: $0 linux|win" >&2
    exit 1
    ;;
esac
