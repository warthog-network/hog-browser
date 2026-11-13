"use strict";
// Update check for the Chromium preview channel only.
//
// It reads GitHub *pre-releases* tagged "preview-*" that carry a
// hog-chromium-preview_<version>_amd64.deb. The WebKit Hog's updater reads
// /releases/latest, which never returns pre-releases, and rejects drafts and
// pre-releases, so publishing preview builds this way cannot reach it. This
// only tells the user and opens the release page; it never installs.
const RELEASES_URL = "https://api.github.com/repos/warthog-network/hog-browser/releases?per_page=30";
const DEB_RE = /^hog-chromium-preview_(\d+\.\d+\.\d+(?:-preview\.\d+)?)_amd64\.deb$/;

/** "0.1.40-preview.3" -> [0, 1, 40, 3]; plain "0.1.41" sorts after its previews. */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(String(text || "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Newest preview pre-release newer than current, or null. */
function pickUpdate(releases, current) {
  let best = null;
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || rel.draft || !rel.prerelease || !/^preview-/.test(String(rel.tag_name || ""))) continue;
    for (const asset of Array.isArray(rel.assets) ? rel.assets : []) {
      const m = DEB_RE.exec(String(asset && asset.name));
      if (!m) continue;
      if (compareVersions(m[1], current) <= 0) continue;
      if (best && compareVersions(m[1], best.version) <= 0) continue;
      const page = String(rel.html_url || "");
      if (!page.startsWith("https://github.com/warthog-network/hog-browser/releases/")) continue;
      best = { version: m[1], tag: rel.tag_name, url: page, deb: asset.name };
    }
  }
  return best;
}

async function checkPreviewUpdate(current, fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hog-chromium-preview" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return pickUpdate(await res.json(), current);
}

module.exports = { RELEASES_URL, parseVersion, compareVersions, pickUpdate, checkPreviewUpdate };
