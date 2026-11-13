"use strict";
// Update check for the Chromium preview channel only.
//
// It reads GitHub *pre-releases* tagged "preview-*" that carry a
// hog-chromium-preview_<version>_amd64.deb. The WebKit Hog's updater reads
// /releases/latest, which never returns pre-releases, and rejects drafts and
// pre-releases, so publishing preview builds this way cannot reach it.
// "Install update" (only on the user's click) downloads the .deb and the
// release's SHA256SUMS, checks the hash and the package name/version, then
// hands the file to `pkexec apt-get install` (the system password prompt).
const RELEASES_URL = "https://api.github.com/repos/warthog-network/hog-browser/releases?per_page=30";
const DEB_RE = /^hog-chromium-preview_(\d+\.\d+\.\d+(?:-preview\.\d+)?)_amd64\.deb$/;
const DOWNLOAD_PREFIX = "https://github.com/warthog-network/hog-browser/releases/download/";
const MAX_DEB = 400 * 1024 * 1024;
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

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
      const sums = rel.assets.find((a) => a && a.name === "SHA256SUMS");
      best = {
        version: m[1],
        tag: rel.tag_name,
        url: page,
        deb: asset.name,
        debUrl: String(asset.browser_download_url || ""),
        sumsUrl: sums ? String(sums.browser_download_url || "") : "",
      };
    }
  }
  return best;
}

async function checkPreviewUpdate(current, fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hog-chromium-preview" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return pickUpdate(await res.json(), current);
}

/** "abc..  name" lines -> hash for name (lower-case hex) or "". */
function hashFor(sumsText, name) {
  for (const line of String(sumsText || "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return "";
}

/** electron-builder writes "0.1.40-preview.3" as Debian "0.1.40~preview.3". */
function debianVersion(version) {
  return String(version).replace("-preview.", "~preview.");
}

function canInstallDeb({ isPackaged, execPath, env = process.env, exists = fs.existsSync } = {}) {
  if (!isPackaged || env.APPIMAGE) return { ok: false, why: "Only the installed .deb can update itself. Download the new build from the release page." };
  if (!String(execPath || "").startsWith("/opt/Hog (Chromium preview)/")) return { ok: false, why: "This copy was not installed from the .deb." };
  if (!exists("/usr/bin/pkexec") || !exists("/usr/bin/apt-get")) return { ok: false, why: "pkexec and apt-get are needed to install updates." };
  return { ok: true, why: "" };
}

function validDownloadUrl(url) {
  return typeof url === "string" && url.startsWith(DOWNLOAD_PREFIX) && !/[\s"'\\]/.test(url);
}

/** Downloads found.deb into dir and checks it against the release's SHA256SUMS.
 *  -> path of the verified .deb. Throws with a readable message. */
async function downloadVerified(found, dir, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  if (!found || !validDownloadUrl(found.debUrl)) throw new Error("The release has no preview .deb to download.");
  if (!validDownloadUrl(found.sumsUrl)) throw new Error("The release has no SHA256SUMS, so the download cannot be checked.");
  const headers = { "User-Agent": "hog-chromium-preview" };
  const sumsRes = await fetchImpl(found.sumsUrl, { headers, redirect: "follow" });
  if (!sumsRes.ok) throw new Error(`SHA256SUMS: GitHub answered ${sumsRes.status}`);
  const sums = (await sumsRes.text()).slice(0, 65536);
  const want = hashFor(sums, found.deb);
  if (!want) throw new Error(`SHA256SUMS has no line for ${found.deb}.`);
  const res = await fetchImpl(found.debUrl, { headers, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download: GitHub answered ${res.status}`);
  const total = Number(res.headers && res.headers.get && res.headers.get("content-length")) || 0;
  if (total > MAX_DEB) throw new Error("The download is larger than expected.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, found.deb);
  const out = fs.createWriteStream(file, { flags: "wx", mode: 0o644 });
  const hash = crypto.createHash("sha256");
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_DEB) throw new Error("The download is larger than expected.");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      onProgress(got, total);
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw error;
  }
  const have = hash.digest("hex");
  if (have !== want) {
    fs.rmSync(file, { force: true });
    throw new Error("The download does not match SHA256SUMS; it was deleted.");
  }
  return file;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (error, stdout, stderr) => resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

/** Package and Version fields of the .deb must be the preview at that version. */
async function checkDebFields(file, version, runner = run) {
  const r = await runner("dpkg-deb", ["-f", file, "Package", "Version"]);
  if (r.code !== 0) throw new Error("The download is not a valid .deb.");
  const fields = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  if (fields.Package !== "hog-chromium-preview") throw new Error(`The .deb is ${fields.Package || "an unknown package"}, not hog-chromium-preview.`);
  if (fields.Version !== debianVersion(version)) throw new Error(`The .deb is version ${fields.Version}, expected ${debianVersion(version)}.`);
}

/** pkexec shows the system password prompt; apt-get installs the local file. */
function installDeb(file, spawnImpl = spawn) {
  return new Promise((resolve) => {
    if (!path.isAbsolute(file) || !file.endsWith(".deb")) return resolve({ ok: false, error: "Bad package path." });
    let err = "";
    const child = spawnImpl("/usr/bin/pkexec", ["/usr/bin/apt-get", "install", "-y", "--no-install-recommends", file], { stdio: ["ignore", "ignore", "pipe"] });
    if (child.stderr) child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) return resolve({ ok: true });
      if (code === 126 || code === 127) return resolve({ ok: false, error: "The password prompt was cancelled." });
      const last = err.trim().split("\n").filter((l) => !/^W:/.test(l)).pop() || `apt-get exited with ${code}`;
      resolve({ ok: false, error: last.slice(0, 200) });
    });
  });
}

module.exports = {
  RELEASES_URL,
  DOWNLOAD_PREFIX,
  parseVersion,
  compareVersions,
  pickUpdate,
  checkPreviewUpdate,
  hashFor,
  debianVersion,
  canInstallDeb,
  validDownloadUrl,
  downloadVerified,
  checkDebFields,
  installDeb,
};
