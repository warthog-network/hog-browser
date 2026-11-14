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
    tabsLine: nums[2] > 0 ? { x: nums[0], w: nums[2] } : null,
    walletLine: nums[6] > 0 ? { x: nums[4], w: nums[6] } : null,
  };
}

/** Leave the gold rail lines of closed drawers visible: the Hog UI draws
 *  them at the stage edge, so keep the page view off those pixels. */
function edgeInset(bounds, paint) {
  if (!paint) return bounds;
  const clamp = (n) => Math.max(0, Math.min(8, Math.round(n)));
  const left = paint.tabsLine ? clamp(paint.tabsLine.x + paint.tabsLine.w - bounds.x) : 0;
  const right = paint.walletLine ? clamp(bounds.x + bounds.width - paint.walletLine.x) : 0;
  return { x: bounds.x + left, y: bounds.y, width: Math.max(0, bounds.width - left - right), height: bounds.height };
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

function bareHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4Parts(host) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function ipv6Hextet(host) {
  const head = host.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return Number.parseInt(head, 16);
}

/** Link-local: 169.254.0.0/16 and fe80::/10, including IPv4-mapped forms. */
function isLinkLocalAddress(ip) {
  const host = bareHost(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const v4 = mapped ? mapped[1] : host;
  const parts = ipv4Parts(v4);
  if (parts) return parts[0] === 169 && parts[1] === 254;
  const hextet = ipv6Hextet(host);
  return hextet != null && hextet >= 0xfe80 && hextet <= 0xfebf;
}

/** Loopback, RFC1918, link-local, CGNAT/Tailscale, and IPv6 ULA. */
function isNonPublicAddress(ip) {
  const host = bareHost(ip);
  if (!host) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const v4 = mapped ? mapped[1] : host;
  const parts = ipv4Parts(v4);
  if (parts) {
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 255) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const hextet = ipv6Hextet(host);
    if (hextet == null) return false;
    if (hextet >= 0xfe80 && hextet <= 0xfebf) return true;
    if (hextet >= 0xfc00 && hextet <= 0xfdff) return true;
    return false;
  }
  return false;
}

function isLocalName(hostname) {
  const host = bareHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

function isMetadataHost(hostname) {
  const host = bareHost(hostname);
  return host === "metadata.google.internal" || host === "metadata.google.internal." || host === "169.254.169.254";
}

function isNonPublicHost(hostname) {
  const host = bareHost(hostname);
  if (!host) return false;
  if (isLocalName(host) || isMetadataHost(host)) return true;
  return isNonPublicAddress(host);
}

function isNonPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  return isNonPublicHost(url.hostname);
}

function isMetadataUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  return isMetadataHost(url.hostname);
}

/**
 * A public page must not reach a private or link-local target.
 * A top-level load the user typed (no initiator) stays open, and a private
 * page may load its own private subresources. Cloud metadata is always blocked.
 * @param {{ url?: string, resourceType?: string, initiator?: string, topUrl?: string, ip?: string }} details
 */
function shouldBlockPrivateRequest(details) {
  const d = details || {};
  const url = String(d.url || "");
  if (isMetadataUrl(url)) return true;
  const urlPrivate = isNonPublicUrl(url);
  const ipPrivate = d.ip ? isNonPublicAddress(d.ip) : false;
  if (!urlPrivate && !ipPrivate) return false;
  const type = String(d.resourceType || "");
  const top = String(d.topUrl || "");
  const initiator = String(d.initiator || "");
  if (type === "mainFrame") {
    if (!initiator) return false;
    let initUrl;
    try {
      initUrl = new URL(initiator);
    } catch {
      return false;
    }
    if (initUrl.protocol !== "http:" && initUrl.protocol !== "https:") return false;
    if (isNonPublicUrl(initiator)) return false;
    return true;
  }
  if (top && isNonPublicUrl(top)) return false;
  return true;
}

function loopbackHost(hostname) {
  const host = bareHost(hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** The wallet provider is for https sites and loopback dapps, never Tailscale or plain http. */
function dappProviderAllowed(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  const host = bareHost(url.hostname);
  if (host === "tailscale.com" || host.endsWith(".tailscale.com")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return loopbackHost(host);
  return false;
}

/** window.open / target=_blank from a page.
 *  details: Electron's HandlerDetails (url, disposition, features).
 *  -> { kind: "deny" } | { kind: "tab" } | { kind: "window", width, height }
 *  Only after a click (gesture). A popup with a size or popup=1 (sign-in
 *  windows, "new-window" disposition) gets a real window that keeps
 *  window.opener; everything else opens as a Hog tab. */
function popupDecision(details, { allowed, gesture }) {
  const d = details || {};
  if (!allowed || !gesture || !d.url) return { kind: "deny" };
  const features = String(d.features || "");
  const asked = {};
  for (const part of features.split(",")) {
    const [k, v] = part.split("=").map((x) => String(x || "").trim().toLowerCase());
    if (k) asked[k] = v === undefined ? "1" : v;
  }
  const popupish = d.disposition === "new-window" || "width" in asked || "height" in asked || (asked.popup && asked.popup !== "0" && asked.popup !== "no");
  if (!popupish) return { kind: "tab" };
  const clamp = (n, lo, hi, dflt) => {
    const v = Number.parseInt(n, 10);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
  };
  return { kind: "window", width: clamp(asked.width, 320, 1400, 520), height: clamp(asked.height, 240, 1000, 680) };
}

module.exports = {
  popupDecision,
  allowedBrowserOpenUrl,
  allowedTailscaleOpenUrl,
  chromeUserAgent,
  dappProviderAllowed,
  downloadName,
  isLinkLocalAddress,
  isNonPublicAddress,
  isNonPublicUrl,
  shouldBlockPrivateRequest,
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
  edgeInset,
};
