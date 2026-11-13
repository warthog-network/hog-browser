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

# Write the archive listing to a file, then grep it. `grep -q` in a pipeline
# exits early, which SIGPIPEs dpkg-deb/unzip and looks like a miss under pipefail.
check_listing() {
  local desc="$1"
  local file="$2"
  local line=""
  while IFS= read -r row; do
    case "$row" in
      *resources/hog-app/node_modules/ws/*) line="$row"; break ;;
    esac
  done < "$file"
  if [ -z "$line" ]; then
    echo "${desc} is missing resources/hog-app/node_modules/ws" >&2
    exit 1
  fi
  echo "ok ${desc} contains resources/hog-app/node_modules/ws"
  echo "$line"
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
    listing="$(mktemp)"
    dpkg-deb -c "${debs[0]}" > "$listing"
    check_listing "$(basename "${debs[0]}")" "$listing"
    rm -f "$listing"
    ;;
  win)
    check_dir "${DIST}/win-unpacked/resources/hog-app"
    shopt -s nullglob
    zips=("${DIST}"/*.zip)
    if [ ${#zips[@]} -gt 0 ]; then
      listing="$(mktemp)"
      unzip -l "${zips[0]}" > "$listing"
      check_listing "$(basename "${zips[0]}")" "$listing"
      rm -f "$listing"
    fi
    ;;
  *)
    echo "usage: $0 linux|win" >&2
    exit 1
    ;;
esac
