"use strict";
// Pure helpers shared by main.js and the tests. No Electron imports here.
const path = require("node:path");
const fs = require("node:fs");

const DOWNLOAD_NAME_MAX = 255;

/** Same rules as hog's PageHost.allowed(): http(s) only, no credentials,
 *  no cloud metadata host, and never Hog's own server or node ports. */
function pageAllowed(raw, ports) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "metadata.google.internal" || host === "169.254.169.254") return false;
  if (isHogLocal(url, ports)) return false;
  return true;
}

/** True for http://127.0.0.1:<hog port> or localhost on Hog's ports. */
function isHogLocal(url, ports) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return (ports || []).includes(port);
}

/** blob:, data:, javascript:, about:blank / about:srcdoc stay in the page. */
function inPageNavigation(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (["blob:", "data:", "javascript:"].includes(url.protocol)) return true;
  if (url.protocol !== "about:") return false;
  return ["blank", "srcdoc"].includes(url.pathname.toLowerCase());
}

/** The site origin for the wallet provider ("" for Hog's own pages). */
function pageOrigin(raw, ports) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (!url.hostname) return "";
  if (isHogLocal(url, ports)) return "";
  return url.origin;
}

/** hog's allowed_browser_open_url: http(s) from argv / another instance. */
function allowedBrowserOpenUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length < 8 || text.length >= 2000 || /\s/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || url.username || url.password) return "";
  if (host === "metadata.google.internal" || host === "169.254.169.254") return "";
  return text;
}

/** hog's allowed_tailscale_open_url. */
function allowedTailscaleOpenUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length < 30 || text.length >= 300 || /\s/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "login.tailscale.com") return "";
  if (url.username || url.password || url.hash || (url.port && url.port !== "443")) return "";
  return text;
}

/** A safe file name: no folders, not hidden, no control characters. */
function downloadName(suggested, uri) {
  let raw = String(suggested || "").trim();
  if (!raw) {
    try {
      raw = decodeURIComponent(new URL(String(uri || "")).pathname.split("/").pop() || "");
    } catch {
      raw = "";
    }
  }
  let name = path.basename(raw.replace(/\\/g, "/")).replace(/[\x00-\x1f]/g, "").trim();
  name = name.replace(/^[. ]+/, "").trim();
  if (!name || name === "." || name === "..") return "download";
  return name.slice(0, DOWNLOAD_NAME_MAX);
}

/** folder/name, or "name (1).ext" ... Never an existing file or one in flight. */
function uniqueDownloadPath(folder, name, taken = new Set(), exists = fs.existsSync) {
  let ext = path.extname(name);
  let base = name.slice(0, name.length - ext.length);
  if (base.toLowerCase().endsWith(".tar")) {
    ext = base.slice(-4) + ext;
    base = base.slice(0, -4);
  }
  if (!base) {
    base = name;
    ext = "";
  }
  for (let i = 0; i < 10000; i += 1) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    const full = path.join(folder, candidate);
    if (!taken.has(full) && !exists(full)) return full;
  }
  throw new Error("No free download name");
}

/** hog://files "download" links from Hog's own server. */
function filesDownloadUri(raw, port) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== Number(port)) return false;
  if (url.pathname !== "/api/files/raw" || url.username || url.password) return false;
  return url.searchParams.getAll("download").join(",") === "1" && Boolean(url.searchParams.get("root"));
}

/** Parse "view:l:t:r:b:show[:tab]" into numbers. */
function parseView(command) {
  const parts = String(command).split(":");
  if (parts.length < 6) return null;
  const nums = parts.slice(1, 6).map((part) => Number.parseInt(part, 10));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [left, top, right, bottom, show] = nums.map((n, i) => (i < 4 ? Math.max(0, n) : n));
  return { left, top, right, bottom, show: show === 1, tabId: parts.length > 6 ? parts[6] : "" };
}

/** Bounds for a page view inside a content area of width x height. */
function viewBounds(place, width, height) {
  return {
    x: place.left,
    y: place.top,
    width: Math.max(0, width - place.left - place.right),
    height: Math.max(0, height - place.top - place.bottom),
  };
}

/** "edges:" + 16 numbers -> grip paint state for the shown page. */
function parseEdges(command, pageTop) {
  const parts = String(command).split(":");
  if (parts.length !== 17) return null;
  const nums = parts.slice(1).map((part) => Number.parseInt(part, 10));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    tabs: nums[10] > 0,
    tabsTop: nums[9] - pageTop,
    wallet: nums[14] > 0,
    walletTop: nums[13] - pageTop,
  };
}

/** The Chrome user agent without "Electron/" or the app name, so sites
 *  treat Hog as Chrome (Google sign-in refuses Electron's default string). */
function chromeUserAgent(chromeVersion, platform = process.platform) {
  const major = String(chromeVersion || "0").split(".")[0];
  const os = platform === "win32" ? "Windows NT 10.0; Win64; x64" : platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The hog script holds the page grip script as a Python raw string. Reuse it
 *  instead of keeping a second copy. WebKit's message handler becomes a
 *  function the page preload exposes. */
function extractEdgeGripScript(hogSource) {
  const match = /EDGE_GRIP_SCRIPT = r"""\n?([\s\S]*?)"""/.exec(String(hogSource || ""));
  if (!match) return "";
  return rewriteMessageHandler(match[1]);
}

function rewriteMessageHandler(source) {
  return String(source || "").replace(/window\.webkit\.messageHandlers\.hogedge\.postMessage\(/g, "window.__hogEdgePost(");
}

/** dapp-provider.js stays off Tailscale login/admin pages, like hog. */
function dappProviderAllowed(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:" && (host === "tailscale.com" || host.endsWith(".tailscale.com"))) return false;
  return true;
}

module.exports = {
  allowedBrowserOpenUrl,
  allowedTailscaleOpenUrl,
  chromeUserAgent,
  dappProviderAllowed,
  downloadName,
  extractEdgeGripScript,
  filesDownloadUri,
  inPageNavigation,
  isHogLocal,
  pageAllowed,
  pageOrigin,
  parseEdges,
  parseView,
  rewriteMessageHandler,
  uniqueDownloadPath,
  viewBounds,
};
