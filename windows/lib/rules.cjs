// Hog for Windows: the navigation, message and file rules of the Linux shell
// (hog, guard.py, bookmark_files.py), ported 1:1 so the same checks apply.
// No Electron here, so node --test can load it on any OS.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const HOG_PORT = 4188;
const NODE_PORT = 43100;
const BOOKMARK_FILE_MAX = 20_000_000;
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "169.254.169.254"]);

function parse(uri) {
  try {
    return new URL(String(uri || ""));
  } catch {
    return null;
  }
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function portOf(url) {
  return url.port ? Number(url.port) : null;
}

/** A page view may load http(s) sites, never Hog's own wallet or node ports. */
function allowedPage(uri, ports = { hog: HOG_PORT, node: NODE_PORT }) {
  const url = parse(uri);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  if (url.username || url.password) return false;
  const host = hostOf(url);
  if (BLOCKED_HOSTS.has(host)) return false;
  if ((host === "127.0.0.1" || host === "localhost") && [ports.hog, ports.node].includes(portOf(url))) return false;
  return true;
}

/** Schemes a page uses for its own frames and scripts, not a new site. */
function inPageNavigation(uri) {
  const url = parse(uri);
  if (!url) return false;
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (["blob", "data", "javascript"].includes(scheme)) return true;
  return scheme === "about" && ["blank", "srcdoc"].includes(url.pathname.toLowerCase());
}

/** http(s) origin of a page view. Hog's own ports are not a site. */
function pageOrigin(uri, ports = { hog: HOG_PORT, node: NODE_PORT }) {
  const url = parse(uri);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
  const host = hostOf(url);
  if (!host) return "";
  if ((host === "127.0.0.1" || host === "localhost") && [ports.hog, ports.node].includes(portOf(url))) return "";
  return url.origin;
}

function allowedBrowserOpenUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length < 8 || text.length >= 2000 || /\s/.test(text)) return "";
  const url = parse(text);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
  const host = hostOf(url);
  if (!host || url.username || url.password || BLOCKED_HOSTS.has(host)) return "";
  return text;
}

function allowedTailscaleOpenUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length < 30 || text.length >= 300 || /\s/.test(text)) return "";
  const url = parse(text);
  if (!url || url.protocol !== "https:" || hostOf(url) !== "login.tailscale.com") return "";
  if (url.username || url.password || url.hash || (url.port && url.port !== "443")) return "";
  return text;
}

/** view:<left>:<top>:<right>:<bottom>:<show>[:<tab>] from the chrome. */
function parseViewCommand(command) {
  const parts = String(command).split(":");
  if (parts[0] !== "view" || parts.length < 6) return null;
  const nums = parts.slice(1, 6).map((p) => (/^-?\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some(Number.isNaN)) return null;
  const [left, top, right, bottom, show] = nums;
  return { left: Math.max(0, left), top: Math.max(0, top), right: Math.max(0, right), bottom: Math.max(0, bottom), show: show === 1, tab: parts.length > 6 ? parts[6] : "" };
}

/** Page rectangle inside the window's content area, from the chrome's margins. */
function pageBounds(content, margins) {
  return {
    x: margins.left,
    y: margins.top,
    width: Math.max(0, content.width - margins.left - margins.right),
    height: Math.max(0, content.height - margins.top - margins.bottom),
  };
}

/** Browser shortcuts Hog catches even while a web page has focus. */
function shortcutFor(input) {
  if (!input || input.type !== "keyDown") return "";
  const key = String(input.key || "").toLowerCase();
  const ctrl = Boolean(input.control);
  const shift = Boolean(input.shift);
  const alt = Boolean(input.alt);
  if (ctrl && !shift && !alt && key === "d") return "bookmark";
  if (ctrl && shift && !alt && key === "o") return "bookmarks";
  return "";
}

function jsonObject(raw, max = 200_000) {
  if (typeof raw !== "string" || raw.length > max) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** A dapp request from a page (window.ethereum), checked like the Linux shell. */
function dappRequest(raw) {
  const data = jsonObject(raw);
  if (!data) return null;
  const { id, method } = data;
  const params = data.params === undefined ? [] : data.params;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 1e15) return null;
  if (typeof method !== "string" || !method || method.length > 80) return null;
  if (!Array.isArray(params)) return null;
  return { id, method, params };
}

function dappEmit(raw) {
  const data = jsonObject(raw);
  if (!data) return null;
  const { origin, event, payload } = data;
  if (typeof origin !== "string" || !/^https?:\/\//.test(origin)) return null;
  if (event === "accountsChanged") {
    if (!Array.isArray(payload) || payload.length > 4) return null;
    if (payload.some((item) => typeof item !== "string" || !item.startsWith("0x") || item.length !== 42)) return null;
  } else if (event === "chainChanged") {
    if (typeof payload !== "string" || !payload.startsWith("0x") || payload.length > 12) return null;
  } else return null;
  return { origin, event, payload };
}

/** edges:<16 numbers> -> what the page draws for the tab and wallet grips. */
function gripPaint(command, pageTop) {
  const parts = String(command).split(":");
  if (parts.length !== 17 || parts[0] !== "edges") return null;
  const nums = parts.slice(1).map((p) => (/^-?\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some(Number.isNaN)) return null;
  return { tabs: nums[10] > 0, tabsTop: nums[9] - pageTop, wallet: nums[14] > 0, walletTop: nums[13] - pageTop };
}

function bookmarkBackupPath(dataDir) {
  return path.join(dataDir, "bookmarks-v1-backup.json");
}

/** Keeps the pre-0.1.21 favorites list on disk once. Never overwrites. */
function writeBookmarkBackup(file, raw) {
  if (!raw || raw.length > BOOKMARK_FILE_MAX || fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readBookmarkFile(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    return { kind: "import", ok: false, error: `Could not open that file: ${e.message}` };
  }
  if (size > BOOKMARK_FILE_MAX) return { kind: "import", ok: false, error: "That file is too large for a bookmarks file." };
  try {
    return { kind: "import", ok: true, text: fs.readFileSync(file).toString("utf8"), name: path.basename(file) };
  } catch (e) {
    return { kind: "import", ok: false, error: `Could not read that file: ${e.message}` };
  }
}

function writeBookmarkFile(file, html) {
  let out = file;
  if (![".html", ".htm"].includes(path.extname(out).toLowerCase())) out += ".html";
  try {
    fs.writeFileSync(out, String(html), "utf8");
  } catch (e) {
    return { kind: "export", ok: false, error: `Could not save: ${e.message}` };
  }
  return { kind: "export", ok: true, path: out };
}

function versionParts(v) {
  return String(v || "").replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function newerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/**
 * Update status for the General page from a GitHub "latest release" reply.
 * Only a release that carries a Windows installer counts as an update here.
 */
function updatePayload(current, release) {
  const base = { ok: true, currentVersion: current, latestVersion: "", updateAvailable: false, updateCanInstall: false, updateHelperReady: false, updateRestart: false, manualCommand: "", releaseUrl: "https://github.com/warthog-network/hog-browser/releases/latest" };
  if (!release || typeof release !== "object") return { ...base, ok: false, error: "Could not reach GitHub to check for updates." };
  const latest = String(release.tag_name || "").replace(/^v/i, "");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((a) => /\.exe$/i.test(String(a?.name || "")) && /setup|hog/i.test(String(a?.name || "")));
  const url = typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : base.releaseUrl;
  return { ...base, latestVersion: latest, releaseUrl: url, updateAvailable: Boolean(installer) && newerVersion(latest, current) };
}

module.exports = {
  HOG_PORT, NODE_PORT, allowedPage, inPageNavigation, pageOrigin, allowedBrowserOpenUrl, allowedTailscaleOpenUrl,
  parseViewCommand, pageBounds, shortcutFor, dappRequest, dappEmit, gripPaint,
  bookmarkBackupPath, writeBookmarkBackup, readBookmarkFile, writeBookmarkFile, newerVersion, updatePayload,
};
