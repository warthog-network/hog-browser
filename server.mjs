import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { BlockList, isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { MINING_NETWORKS, bzminerCommand, createMiningRelay, miningPort, pageRelayScript, resolveMiningNetwork } from "./mining.mjs";
import { createStratumBridge, isWarthogAddress, stratumPort } from "./stratum.mjs";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.HOG_PORT || 4188);
const MAX_PAGE = 1_500_000;
const MAX_ASSET = 32_000_000;
const MAX_REDIRECTS = 5;
const WALLET_HOST = "127.0.0.1";
const PAGE_HOST = "localhost";
const SITE_PORT_MIN = 43110;
const SITE_PORT_MAX = 44109;
const NODE_ORIGIN = "https://browser-node.netlify.app";
// HOG_NODE_PORT is for headless/dev runs next to an installed Hog; the hog window expects 43100.
const NODE_PORT = Number(process.env.HOG_NODE_PORT || 43100);
const SITE_PORT_FILE = join(homedir(), ".local/share/hog-browser/site-ports.json");
const GLUE_PREFIX = readFileSync(fileURLToPath(new URL("./opfs-polyfill.js", import.meta.url)));
const OPFS_LOCK_MS = 60_000;
const opfsLocks = new Map();
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GATE = randomBytes(24).toString("hex");
const WALLET_ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};
const SITE_HEADERS = {
  ...WALLET_ISOLATION,
  "cross-origin-resource-policy": "cross-origin",
};
let siteCursor = SITE_PORT_MIN;

// ---------- Solo mining (BzMiner -> 127.0.0.1:HOG_MINING_PORT -> node tab) ----------
const MINING_STATE_FILE = join(homedir(), ".local/share/hog-browser/mining.json");
// "auto" follows the network the node tab is running; "defi" / "mainnet" pin it.
let miningNetworkSetting = "auto";
const MINING_NETWORK_SETTINGS = new Set(["auto", "defi", "mainnet"]);
const MINING = createMiningRelay({
  token: randomBytes(24).toString("hex"),
  pageOrigin: `http://${PAGE_HOST}:${NODE_PORT}`,
  network: () => currentMiningNetwork()?.page || "",
});
function currentMiningNetwork() {
  return resolveMiningNetwork(miningNetworkSetting, MINING.getPageNetwork());
}
const STRATUM = createStratumBridge({ call: MINING.call, getNetwork: currentMiningNetwork });
let miningError = "";
// WASM node files Hog serves itself instead of the live site's. The bundled builds
// (node-defi/ and node-mainnet/, see their READMEs) add only POST /chain/append so
// solved blocks from a local miner reach the in-tab node. HOG_DEFI_NODE_DIR and
// HOG_MAINNET_NODE_DIR override them; set one to an empty string to load the live
// site's files for that network.
const BUNDLED_DEFI_NODE_DIR = fileURLToPath(new URL("./node-defi/", import.meta.url));
const BUNDLED_MAINNET_NODE_DIR = fileURLToPath(new URL("./node-mainnet/", import.meta.url));
function nodeDir(envValue, bundled) {
  return envValue ?? (existsSync(join(bundled, "wart-node.wasm")) ? bundled : "");
}
const DEFI_NODE_DIR = nodeDir(process.env.HOG_DEFI_NODE_DIR, BUNDLED_DEFI_NODE_DIR);
const MAINNET_NODE_DIR = nodeDir(process.env.HOG_MAINNET_NODE_DIR, BUNDLED_MAINNET_NODE_DIR);
const NODE_FILES = new Set(["wart-node.js", "wart-node.wasm"]);

/**
 * Map the node site's WASM files to a local file, if Hog has one:
 * /node/defi/<file> is DeFi testnet, /node/<file> is mainnet (Official1).
 * @param {string} origin
 * @param {string} pathname
 * @param {{ defi?: string, mainnet?: string }} dirs
 */
export function localNodeFile(origin, pathname, dirs = { defi: DEFI_NODE_DIR, mainnet: MAINNET_NODE_DIR }) {
  if (origin !== NODE_ORIGIN) return "";
  const path = String(pathname || "");
  let dir = "";
  let name = "";
  let match = /^\/node\/defi\/([^/]+)$/.exec(path);
  if (match) {
    dir = dirs.defi || "";
    name = match[1];
  } else if ((match = /^\/node\/([^/]+)$/.exec(path))) {
    dir = dirs.mainnet || "";
    name = match[1];
  }
  if (!dir || !NODE_FILES.has(name)) return "";
  const file = join(dir, name);
  return existsSync(file) ? file : "";
}

/** Back-compat for the DeFi-only helper. */
export function localDefiNodeFile(origin, pathname, dir = DEFI_NODE_DIR) {
  if (!/^\/node\/defi\//.test(String(pathname || ""))) return "";
  return localNodeFile(origin, pathname, { defi: dir, mainnet: "" });
}

function nodeSource(dir, bundled, livePath) {
  if (!dir) return `live site: ${NODE_ORIGIN}${livePath} (cannot accept mined blocks)`;
  return dir === bundled ? "bundled with Hog (accepts mined blocks)" : `local: ${dir}`;
}

function readMiningState() {
  try {
    const saved = JSON.parse(readFileSync(MINING_STATE_FILE, "utf8"));
    return {
      network: MINING_NETWORK_SETTINGS.has(saved?.network) ? saved.network : "auto",
      enabled: saved?.enabled === true,
      address: isWarthogAddress(saved?.address) ? String(saved.address).toLowerCase() : "",
    };
  } catch {
    return { enabled: false, address: "", network: "auto" };
  }
}

function saveMiningState(state) {
  mkdirSync(join(homedir(), ".local/share/hog-browser"), { recursive: true });
  writeFileSync(MINING_STATE_FILE, `${JSON.stringify({ enabled: Boolean(state.enabled), address: state.address || "", network: state.network || "auto" })}\n`);
}

function miningStatus(enabled) {
  let port = 0;
  let sport = 0;
  try {
    port = miningPort();
    sport = stratumPort();
  } catch (error) {
    miningError = error instanceof Error ? error.message : String(error);
  }
  const status = MINING.status();
  const net = currentMiningNetwork();
  return {
    ok: true,
    enabled: Boolean(enabled),
    ...status,
    ...STRATUM.status(),
    configuredPort: port,
    configuredStratumPort: sport,
    address: miningAddress,
    networkSetting: miningNetworkSetting,
    miningNetwork: net?.key || "",
    miningNetworkLabel: net?.label || "",
    networks: Object.values(MINING_NETWORKS).map(({ key, label }) => ({ key, label })),
    command: bzminerCommand(sport || 3456, miningAddress || undefined, net ? `hog-${net.key}` : "rig1"),
    defiNodeSource: nodeSource(DEFI_NODE_DIR, BUNDLED_DEFI_NODE_DIR, "/node/defi/"),
    mainnetNodeSource: nodeSource(MAINNET_NODE_DIR, BUNDLED_MAINNET_NODE_DIR, "/node/"),
    error: miningError,
  };
}

async function setMining(enabled) {
  miningError = "";
  if (!enabled) {
    await STRATUM.stop();
    await MINING.stop();
    return;
  }
  const problems = [];
  try {
    await STRATUM.start(stratumPort());
  } catch (error) {
    problems.push(error?.code === "EADDRINUSE"
      ? `Stratum port ${stratumPort()} is already in use (a local Warthog node with --stratum?). Set HOG_STRATUM_PORT to another port.`
      : (error instanceof Error ? error.message : String(error)));
  }
  try {
    await MINING.start(miningPort());
  } catch (error) {
    problems.push(error?.code === "EADDRINUSE"
      ? `HTTP port ${miningPort()} is already in use (a local Warthog node?). Set HOG_MINING_PORT to another port.`
      : (error instanceof Error ? error.message : String(error)));
  }
  miningError = problems.join(" ");
}
let miningEnabled = false;
let miningAddress = "";

const NETWORKS = {
  defi: "https://warthog-defitestnet.duckdns.org",
  mainnet: "https://warthognode.duckdns.org",
};
// Same-origin paths the browser node dials on localhost. Vite proxies these
// in dev; Hog does the same so the page never opens a public socket itself.
const NODE_BRIDGES = [
  ["/ws-bridge-defi", "wss://warthog-defitestnet.duckdns.org/ws"],
  ["/ws-defi", "wss://warthog-defitestnet.duckdns.org/ws"],
  ["/ws-bridge", "wss://warthognode.duckdns.org/ws"],
];

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The in-page node reports chain head through virtual_get.
 * Green means that payload says synced, not merely that the tab is open.
 * @param {unknown} body
 */
export function nodeSyncedFlag(body) {
  let data = body;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return false;
    }
  }
  if (!data || typeof data !== "object") return false;
  if (data.data && typeof data.data === "object") data = data.data;
  const head = data.chainHead && typeof data.chainHead === "object" ? data.chainHead : data;
  const flag = data.synced != null ? data.synced : head.synced;
  return flag === true || flag === 1 || flag === "1" || flag === "true";
}

export function nodeSyncScript() {
  return `(function () {
  if (window.__hogNodeSync) return;
  window.__hogNodeSync = true;
  var readSynced = ${nodeSyncedFlag.toString()};
  var last = null;
  function on(synced) {
    if (last === synced) return;
    last = synced;
    try { parent.postMessage({ source: "hog", type: "node-sync", synced: synced }, "*"); } catch (e) {}
  }
  function tick() {
    var mod = window.wartNode || window.Module;
    if (!mod || typeof mod.virtual_get !== "function") {
      on(false);
      return;
    }
    Promise.resolve(mod.virtual_get("/chain/head")).then(function (raw) {
      on(readSynced(raw));
    }).catch(function () { on(false); });
  }
  setInterval(tick, 2000);
  tick();
})();`;
}

function navScript(pageOrigin) {
  return `<script>
(function () {
  var PAGE_ORIGIN = ${JSON.stringify(pageOrigin)};
  function toReal(url) {
    try {
      var parsed = new URL(url, location.href);
      if (parsed.origin === location.origin) {
        return PAGE_ORIGIN + parsed.pathname + parsed.search + parsed.hash;
      }
      return parsed.href;
    } catch (e) {
      return String(url);
    }
  }
  function send(url, extra) {
    var message = { source: "hog", type: "navigate", url: String(url) };
    if (extra) {
      message.method = extra.method;
      message.fields = extra.fields;
    }
    try { parent.postMessage(message, "*"); } catch (e) {}
  }
  document.addEventListener("click", function (event) {
    var node = event.target;
    var link = node && node.closest ? node.closest("a[href]") : null;
    if (!link) return;
    var raw = link.getAttribute("href") || "";
    if (!raw || raw.charAt(0) === "#") return;
    if (/^(javascript|data|blob):/i.test(raw)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    send(toReal(link.href));
  }, true);
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || String(form.tagName).toUpperCase() !== "FORM") return;
    event.preventDefault();
    event.stopPropagation();
    var method = (form.getAttribute("method") || "get").toLowerCase();
    var submitter = event.submitter || null;
    var actionAttr = (submitter && submitter.getAttribute("formaction")) || form.getAttribute("action") || "";
    var action;
    try { action = new URL(actionAttr || ".", document.baseURI).href; }
    catch (e) { action = form.action || document.baseURI; }
    if ((method !== "get" && method !== "post") || (form.querySelector && form.querySelector('input[type="file"]'))) {
      send("hog-post:" + action);
      return;
    }
    var data;
    try { data = submitter ? new FormData(form, submitter) : new FormData(form); }
    catch (e) { data = new FormData(form); }
    if (method === "get") {
      var url;
      try { url = new URL(action); } catch (err) { return; }
      data.forEach(function (value, key) {
        if (typeof value === "string") url.searchParams.append(key, value);
      });
      send(toReal(url.href));
      return;
    }
    var fields = [];
    data.forEach(function (value, key) {
      if (typeof value !== "string" || fields.length >= 40) return;
      fields.push({ name: String(key).slice(0, 200), value: value.slice(0, 4000) });
    });
    send(toReal(action), { method: "POST", fields: fields });
  }, true);
})();
</script>`;
}

/**
 * @param {string} value
 */
export function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function hostName(req) {
  return String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
}

function hasGate(req) {
  const raw = String(req.headers.cookie || "");
  return raw.split(";").some((part) => part.trim() === `hog_gate=${GATE}`);
}

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "poster",
  "formaction",
  "component-url",
  "renderer-url",
  "before-hydration-url",
]);

function shouldSkipUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("#")) return true;
  return /^(?:javascript|data|blob|mailto|tel|about):/i.test(text);
}

function decodeAttr(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function absUrl(raw, base) {
  const decoded = decodeAttr(raw).trim();
  if (shouldSkipUrl(decoded)) return "";
  try {
    return new URL(decoded, base).href;
  } catch {
    return "";
  }
}

function sameOriginPath(abs, base) {
  try {
    const url = new URL(abs);
    if (url.origin !== new URL(base).origin) return abs;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return abs;
  }
}

function rewriteCssUrls(css, base) {
  return String(css).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, quote, raw) => {
    const abs = absUrl(raw, base);
    if (!abs) return full;
    return `url(${quote}${sameOriginPath(abs, base)}${quote})`;
  });
}

function startsTag(html, index, name) {
  return new RegExp(`^<${name}(?:\\s|/|>)`, "i").test(html.slice(index, index + name.length + 2));
}

function findClose(html, from, name) {
  const match = new RegExp(`</${name}\\s*>`, "ig");
  match.lastIndex = from;
  const found = match.exec(html);
  if (!found) return { start: html.length, end: html.length };
  return { start: found.index, end: found.index + found[0].length };
}

function rewriteTag(tag, base) {
  return tag.replace(
    /\s([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    (full, attr, eq, dq, sq, bare) => {
      const key = String(attr).toLowerCase();
      const raw = dq ?? sq ?? bare ?? "";
      if (key === "style") {
        const next = rewriteCssUrls(raw, base);
        return next === raw ? full : ` ${attr}="${escapeAttr(next)}"`;
      }
      if (key === "srcset") {
        const next = raw.split(",").map((part) => {
          const bits = part.trim().split(/\s+/);
          const abs = absUrl(bits[0] || "", base);
          if (!abs) return part.trim();
          bits[0] = sameOriginPath(abs, base);
          return bits.join(" ");
        }).join(", ");
        return ` ${attr}="${escapeAttr(next)}"`;
      }
      if (!URL_ATTRS.has(key)) return full;
      const abs = absUrl(raw, base);
      if (!abs) return full;
      return ` ${attr}="${escapeAttr(sameOriginPath(abs, base))}"`;
    },
  );
}

function rewriteRegions(html, base) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end < 0 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    if (startsTag(html, lt, "script")) {
      const endTag = html.indexOf(">", lt);
      if (endTag < 0) {
        out += html.slice(lt);
        break;
      }
      out += rewriteTag(html.slice(lt, endTag + 1), base);
      const closeAt = findClose(html, endTag + 1, "script");
      out += html.slice(endTag + 1, closeAt.end);
      i = closeAt.end;
      continue;
    }
    if (startsTag(html, lt, "style")) {
      const endTag = html.indexOf(">", lt);
      if (endTag < 0) {
        out += html.slice(lt);
        break;
      }
      out += html.slice(lt, endTag + 1);
      const closeAt = findClose(html, endTag + 1, "style");
      out += rewriteCssUrls(html.slice(endTag + 1, closeAt.start), base);
      out += html.slice(closeAt.start, closeAt.end);
      i = closeAt.end;
      continue;
    }
    const endTag = html.indexOf(">", lt);
    if (endTag < 0) {
      out += html.slice(lt);
      break;
    }
    out += rewriteTag(html.slice(lt, endTag + 1), base);
    i = endTag + 1;
  }
  return out;
}

/**
 * Keep same-site URLs path-absolute so they load from this site's localhost port.
 * A foreign <base> would send /_astro and /node back to the real host, where
 * Cross-Origin-Resource-Policy: same-origin blocks them.
 * @param {string} html
 * @param {string} finalUrl
 */
export function rewriteHtml(html, finalUrl) {
  let body = String(html);
  if (body.length > MAX_PAGE) {
    body = `${body.slice(0, MAX_PAGE)}\n<!-- hog: page truncated -->`;
  }
  body = body.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(content-security-policy|refresh)\b[^>]*>/gi,
    "",
  );
  body = body.replace(/<base\b[^>]*>/gi, "");
  body = rewriteRegions(body, finalUrl);
  let origin = "";
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    origin = "";
  }
  const storage = origin === NODE_ORIGIN
    ? `<script>${GLUE_PREFIX.toString("utf8").replace(/<\/script/gi, "<\\/script")}</script><script>${nodeSyncScript()}</script><script>${pageRelayScript(MINING.token)}</script>`
    : "";
  const inject = storage + navScript(origin);
  if (/<head[^>]*>/i.test(body)) {
    return body.replace(/<head[^>]*>/i, (head) => `${head}${inject}`);
  }
  return `<!doctype html><html><head>${inject}</head><body>${body}</body></html>`;
}

/**
 * @param {string} hostname
 */
export async function assertFetchAllowed(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("Missing host");
  if (BLOCKED_HOSTS.has(host)) throw new Error("That host is blocked");
  if (isIP(host)) {
    if (LINK_LOCAL.check(host)) throw new Error("Link-local addresses are blocked");
    return;
  }
  const records = await lookup(host, { all: true });
  for (const record of records) {
    if (LINK_LOCAL.check(record.address)) {
      throw new Error("That host resolves to a blocked address");
    }
  }
}

/**
 * @param {string} raw
 */
export function parseBrowseUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Enter a URL or a search");
  if (/^hog-post:/i.test(text)) {
    throw new Error("This browser opens links. It does not submit forms.");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That address is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https pages can be opened");
  }
  if (url.username || url.password) {
    throw new Error("URLs with a username or password are blocked");
  }
  return url;
}

/**
 * @param {string} base
 * @param {string} path
 * @param {string} method
 */
export function assertNodeRequest(base, path, method) {
  const allowed = Object.values(NETWORKS);
  if (!allowed.includes(base)) throw new Error("Unknown Warthog node");
  const raw = String(path || "").replace(/^\//, "");
  const splitAt = raw.indexOf("?");
  const clean = splitAt === -1 ? raw : raw.slice(0, splitAt);
  const query = splitAt === -1 ? "" : raw.slice(splitAt + 1);
  if (query && !/^namePrefix=[A-Za-z0-9]{0,5}(?:&hashPrefix=[0-9a-fA-F]{0,64})?$/.test(query)) {
    throw new Error("That node path is not available from the wallet");
  }
  const asset = "[0-9a-fA-F]{64}";
  const account = "[0-9a-fA-F]{48}";
  const ok =
    clean === "chain/head" ||
    clean === "transaction/minfee" ||
    clean === "transaction/add" ||
    (clean === "asset/complete" && splitAt !== -1) ||
    new RegExp(`^asset/lookup/${asset}$`).test(clean) ||
    new RegExp(`^dex/market/${asset}$`).test(clean) ||
    new RegExp(`^account/${account}/(?:wart_balance|balance|mempool|open_orders)$`).test(clean) ||
    new RegExp(`^account/${account}/balance/${asset}$`).test(clean) ||
    new RegExp(`^account/${account}/history/\\d+$`).test(clean) ||
    new RegExp(`^transaction/lookup/${asset}$`).test(clean) ||
    /^tools\/encode16bit\/from_string\/[0-9]+(?:\.[0-9]+)?$/.test(clean);
  if (!ok) throw new Error("That node path is not available from the wallet");
  const verb = method.toUpperCase();
  if (verb === "POST" && clean !== "transaction/add") {
    throw new Error("Only transaction submit can be posted");
  }
  if (verb !== "GET" && verb !== "POST") throw new Error("Method not allowed");
  return { base, path: query ? `${clean}?${query}` : clean, method: verb };
}

/**
 * @param {Array<{name?: string, value?: string}> | undefined} fields
 */
export function formBody(fields) {
  const params = new URLSearchParams();
  const list = Array.isArray(fields) ? fields.slice(0, 40) : [];
  for (const field of list) {
    if (!field || typeof field !== "object") continue;
    const name = String(field.name ?? "").slice(0, 200);
    const value = String(field.value ?? "").slice(0, 4000);
    if (!name) continue;
    params.append(name, value);
  }
  return params.toString();
}

async function publish(runtime, finalUrl, html, title, contentType) {
  const url = new URL(finalUrl);
  const site = await runtime.ensureSite(url.origin);
  const key = `${url.pathname}${url.search}`;
  site.pages.set(key, html);
  while (site.pages.size > 30) site.pages.delete(site.pages.keys().next().value);
  if (runtime.persistSites) runtime.savePorts();
  return {
    finalUrl: url.href,
    title,
    html,
    contentType,
    frameUrl: `http://${PAGE_HOST}:${site.port}${key}`,
  };
}

async function fetchPage(start, options = {}, runtime) {
  let current = start;
  let verb = String(options.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchAllowed(current.hostname);
    const posting = verb === "POST";
    const response = await fetch(current, {
      method: verb,
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": BROWSER_UA,
        ...(posting ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: posting ? formBody(options.fields) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect had no location");
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error("Redirect left http");
      }
      if (response.status !== 307 && response.status !== 308) verb = "GET";
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new Error(`The site returned ${response.status}`);
    }
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || current.href;
    if (type.startsWith("image/")) {
      const shown = new URL(finalUrl);
      const html = `<!doctype html><title>${escapeAttr(finalUrl)}</title><body style="margin:0;background:#111"><img alt="" src="${escapeAttr(shown.pathname + shown.search)}" style="max-width:100%"></body>`;
      return publish(runtime, finalUrl, html, finalUrl, type);
    }
    const text = await response.text();
    const htmlLike = type.includes("html") || type.includes("xml") || /^\s*</.test(text);
    if (!htmlLike) {
      const shown = escapeText(text.slice(0, 20000));
      const html = `<!doctype html><title>${escapeAttr(finalUrl)}</title><body><pre>${shown}</pre></body>`;
      return publish(runtime, finalUrl, html, finalUrl, type || "text/plain");
    }
    const html = rewriteHtml(text, finalUrl);
    const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || finalUrl;
    return publish(runtime, finalUrl, html, decodeBasic(title).trim() || finalUrl, type || "text/html");
  }
  throw new Error("Too many redirects");
}

function safeType(type) {
  const raw = String(type || "").trim();
  const match = raw.match(/^([\w.+-]+\/[\w.+-]+)(\s*;\s*charset=[\w.-]+)?/i);
  if (!match) return "application/octet-stream";
  if (!match[2]) return match[1];
  return `${match[1]}; charset=${match[2].split("=").pop()}`;
}

async function fetchAsset(start) {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchAllowed(current.hostname);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { accept: "*/*", "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(60000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect had no location");
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error("Redirect left http");
      }
      continue;
    }
    if (!response.ok) throw new Error(`The site returned ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ASSET) throw new Error("That file is too large");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_ASSET) throw new Error("That file is too large");
    return { body, type: safeType(response.headers.get("content-type")) };
  }
  throw new Error("Too many redirects");
}

// ---------- Favicons for bookmark tiles ----------
// The Hog page runs cross-origin isolated, so it cannot show a site's icon
// directly. Hog fetches the icon here (same guards as browsing) and serves it
// same-origin. Results are cached in memory, misses too.
const FAVICON_MAX = 200_000;
const FAVICON_CACHE_CAP = 400;
const FAVICON_TTL = 6 * 60 * 60 * 1000;
const faviconCache = new Map();

/** The origin whose icon a bookmark URL should show. */
export function faviconOrigin(raw) {
  const url = parseBrowseUrl(raw);
  return url.origin;
}

/** Recognises icon bytes by content, never by the site's say-so. */
export function sniffIcon(body) {
  if (!body || body.length < 4) return "";
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
  if (body[0] === 0x00 && body[1] === 0x00 && (body[2] === 0x01 || body[2] === 0x02) && body[3] === 0x00) return "image/x-icon";
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "image/gif";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length > 12 && body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  const head = body.toString("utf8", 0, Math.min(body.length, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

/** Finds the first <link rel="icon"> style href in a page. */
export function iconHrefFromHtml(html, base) {
  const re = /<link\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const tag = match[0];
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || "";
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(rel.trim())) continue;
    const href = (tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || []);
    const value = href[2] ?? href[3] ?? href[4];
    if (!value) continue;
    try {
      const url = new URL(value.trim(), base);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // try the next link
    }
  }
  return "";
}

async function fetchSmall(start, limit, accept) {
  let current = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchAllowed(current.hostname);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { accept, "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") return null;
      continue;
    }
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > limit) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > limit) return null;
    return { body, url: current };
  }
  return null;
}

async function loadFavicon(origin) {
  const direct = await fetchSmall(`${origin}/favicon.ico`, FAVICON_MAX, "image/*").catch(() => null);
  const directType = direct && sniffIcon(direct.body);
  if (directType) return { body: direct.body, type: directType };
  const page = await fetchSmall(`${origin}/`, 512_000, "text/html").catch(() => null);
  if (!page) return null;
  const href = iconHrefFromHtml(page.body.toString("utf8"), page.url);
  if (!href) return null;
  const icon = await fetchSmall(href, FAVICON_MAX, "image/*").catch(() => null);
  const type = icon && sniffIcon(icon.body);
  return type ? { body: icon.body, type } : null;
}

async function cachedFavicon(origin) {
  const hit = faviconCache.get(origin);
  if (hit && Date.now() - hit.at < FAVICON_TTL) return hit.pending ? hit.pending : hit.value;
  const pending = loadFavicon(origin).catch(() => null);
  faviconCache.set(origin, { at: Date.now(), pending });
  const value = await pending;
  faviconCache.set(origin, { at: Date.now(), value });
  while (faviconCache.size > FAVICON_CACHE_CAP) faviconCache.delete(faviconCache.keys().next().value);
  return value;
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeBasic(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function proxyNode(base, path, method, body) {
  const target = `${base}/${path}`;
  const response = await fetch(target, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, text };
}

function sendMedia(res, data, type, range) {
  const size = data.length;
  const headers = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (!range) {
    res.writeHead(200, { ...headers, "content-length": size });
    res.end(data);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (match[1] === "" && match[2] === "")) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  const slice = data.subarray(start, end + 1);
  res.writeHead(206, {
    ...headers,
    "content-length": slice.length,
    "content-range": `bytes ${start}-${end}/${size}`,
  });
  res.end(slice);
}

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  const payload = Buffer.isBuffer(body) || body instanceof Uint8Array
    ? body
    : typeof body === "string"
      ? body
      : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(payload);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 64_000) {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}

function loadSavedPorts() {
  try {
    const data = JSON.parse(readFileSync(SITE_PORT_FILE, "utf8"));
    const saved = {};
    if (!data || typeof data !== "object") return saved;
    for (const [key, value] of Object.entries(data)) {
      const port = Number(value);
      if (/^https?:\/\//.test(key) && Number.isInteger(port) && port >= SITE_PORT_MIN && port <= SITE_PORT_MAX) {
        saved[key] = port;
      }
    }
    return saved;
  } catch {
    return {};
  }
}

function takeSitePort() {
  const port = siteCursor;
  siteCursor = port >= SITE_PORT_MAX ? SITE_PORT_MIN : port + 1;
  return port;
}

function createRuntime({ persistSites = false } = {}) {
  const sites = new Map();
  const siteServers = [];
  const saved = persistSites ? loadSavedPorts() : {};
  const opening = new Map();
  const runtime = {
    persistSites,
    siteServers,
    savePorts() {
      if (!persistSites) return;
      const data = {};
      for (const [origin, site] of sites) data[origin] = site.port;
      mkdirSync(join(homedir(), ".local/share/hog-browser"), { recursive: true });
      writeFileSync(SITE_PORT_FILE, `${JSON.stringify(data)}\n`);
    },
    ensureSite(origin) {
      const existing = sites.get(origin);
      if (existing) return Promise.resolve(existing);
      const pending = opening.get(origin);
      if (pending) return pending;
      const job = openSite(origin).finally(() => opening.delete(origin));
      opening.set(origin, job);
      return job;
    },
  };

  async function listenSite(site) {
    const server = createServer((req, res) => {
      handleSite(runtime, site, req, res).catch((error) => {
        const message = error instanceof Error ? error.message : "Request failed";
        if (!res.headersSent) send(res, 502, message, "text/plain; charset=utf-8");
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(site.port, "127.0.0.1", () => {
          server.removeAllListeners("error");
          server.on("error", (error) => {
            console.error(error instanceof Error ? error.message : error);
          });
          resolve();
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }
    site.server = server;
    site.pages = new Map();
    siteServers.push(server);
    sites.set(site.origin, site);
    if (site.origin === NODE_ORIGIN) attachNodeBridge(server);
    else server.on("upgrade", (_req, socket) => socket.destroy());
    return site;
  }

  async function openSite(origin) {
    if (origin === NODE_ORIGIN) {
      try {
        return await listenSite({ origin, port: NODE_PORT });
      } catch (error) {
        if (error?.code === "EADDRINUSE") {
          throw new Error("The Warthog node tab is already using its local port");
        }
        throw error;
      }
    }
    const preferred = saved[origin];
    let last = new Error("No local port for that site");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const port = attempt === 0 && preferred ? preferred : takeSitePort();
      if (attempt > 0 && port === preferred) continue;
      try {
        return await listenSite({ origin, port });
      } catch (error) {
        last = error;
        if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
      }
    }
    throw last;
  }

  return runtime;
}

export function preferredSitePort(origin) {
  return origin === NODE_ORIGIN ? NODE_PORT : 0;
}

export function nodeBridgeTarget(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  const found = NODE_BRIDGES.find(([prefix]) => path === prefix);
  return found ? found[1] : "";
}

export function attachNodeBridge(server, mining = MINING) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      if (protocols.has("binary")) return "binary";
      return false;
    },
  });
  server.on("upgrade", (req, socket, head) => {
    const host = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (host === PAGE_HOST && mining && mining.handleUpgrade(req, socket, head)) return;
    const target = host === PAGE_HOST ? nodeBridgeTarget(pathname) : "";
    if (!target) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(target, "binary", {
        headers: { "X-Forwarded-For": req.socket?.remoteAddress || "127.0.0.1" },
      });
      const pending = [];
      let opened = false;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (client.readyState === WebSocket.OPEN) client.close(1000);
        if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      client.on("message", (data, isBinary) => {
        if (!opened) {
          if (pending.length < 32) pending.push([data, isBinary]);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      client.on("close", stop);
      client.on("error", stop);
      upstream.on("open", () => {
        opened = true;
        for (const [data, isBinary] of pending) {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        }
        pending.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on("close", stop);
      upstream.on("error", stop);
    });
  });
  server.on("close", () => wss.close());
}

export function isNodeGlue(origin, pathname) {
  return origin === NODE_ORIGIN && /\/wart-node\.js$/.test(String(pathname || ""));
}

export function opfsRelative(input) {
  const parts = [];
  for (const part of String(input || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || part.includes("\0") || part.includes("\\")) {
      throw opfsFail(400, "That file path is not available");
    }
    parts.push(part);
  }
  return parts.join("/");
}

function opfsFail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function opfsRootFor(origin) {
  const base = process.env.HOG_OPFS_ROOT || join(homedir(), ".local/share/hog-browser/opfs");
  const safe = String(origin || "site").replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 120);
  return join(base, safe);
}

function opfsFull(root, rel) {
  const relative = opfsRelative(rel);
  const full = relative ? join(root, relative) : root;
  const base = normalize(root + "/");
  const resolved = normalize(full);
  if (resolved !== normalize(root) && !resolved.startsWith(base)) {
    throw opfsFail(400, "That file path is not available");
  }
  return { relative, full: resolved };
}

async function opfsKind(full) {
  try {
    const info = await stat(full);
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function opfsResult(status, body, type = "text/plain; charset=utf-8") {
  return {
    status,
    type,
    body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)),
  };
}

function dropOpfsLocks(full) {
  const prefix = `${full}/`;
  for (const key of opfsLocks.keys()) {
    if (key === full || key.startsWith(prefix)) opfsLocks.delete(key);
  }
}

/**
 * Disk files behind the in-browser node. WebKitGTK's sync file handle
 * returns NotSupportedError, so the node tab stores chain data here.
 */
export async function applyOpfs(root, op, rel, body = Buffer.alloc(0), params = {}) {
  await mkdir(root, { recursive: true });
  const { relative, full } = opfsFull(root, rel);
  const at = () => {
    const value = Number(params.at ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw opfsFail(400, "Bad offset");
    }
    return Math.floor(value);
  };
  if (op === "stat") return opfsResult(200, await opfsKind(full));
  if (op === "list") {
    if (await opfsKind(full) !== "directory") return opfsResult(404, "missing");
    const entries = await readdir(full, { withFileTypes: true });
    const listed = entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
    return opfsResult(200, JSON.stringify(listed), "application/json; charset=utf-8");
  }
  if (op === "mkdir") {
    const kind = await opfsKind(full);
    if (kind === "file") return opfsResult(409, "mismatch");
    if (kind === "missing") await mkdir(full);
    return opfsResult(200, "ok");
  }
  if (op === "create") {
    const kind = await opfsKind(full);
    if (kind === "directory") return opfsResult(409, "mismatch");
    if (kind === "missing") {
      const handle = await open(full, "wx");
      await handle.close();
    }
    return opfsResult(200, "ok");
  }
  if (op === "size") {
    const info = await stat(full);
    if (info.isDirectory()) return opfsResult(409, "mismatch");
    return opfsResult(200, String(info.size));
  }
  if (op === "read") {
    const info = await stat(full);
    if (info.isDirectory()) return opfsResult(409, "mismatch");
    const offset = at();
    const len = Number(params.len ?? 0);
    if (!Number.isInteger(len) || len < 0 || len > 32_000_000) throw opfsFail(400, "Bad length");
    if (len === 0 || offset >= info.size) return opfsResult(200, "");
    const take = Math.min(len, info.size - offset);
    const handle = await open(full, "r");
    try {
      const buf = Buffer.alloc(take);
      const { bytesRead } = await handle.read(buf, 0, take, offset);
      return opfsResult(200, buf.subarray(0, bytesRead).toString("base64"));
    } finally {
      await handle.close();
    }
  }
  if (op === "write") {
    const offset = at();
    if (offset + body.length > 16 * 1024 * 1024 * 1024) throw opfsFail(413, "That file is too large");
    const handle = await open(full, "r+");
    try {
      const { bytesWritten } = await handle.write(body, 0, body.length, offset);
      return opfsResult(200, String(bytesWritten));
    } finally {
      await handle.close();
    }
  }
  if (op === "truncate" || op === "flush") {
    const handle = await open(full, "r+");
    try {
      if (op === "truncate") {
        const size = Number(params.size ?? 0);
        if (!Number.isFinite(size) || size < 0) throw opfsFail(400, "Bad size");
        await handle.truncate(Math.floor(size));
      } else {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    return opfsResult(200, "ok");
  }
  if (op === "remove") {
    // Node rm without recursive throws EISDIR for every directory, including
    // an empty one. The node page wipes defi/logs with removeEntry(recursive).
    if (!relative) throw opfsFail(400, "That file path is not available");
    const kind = await opfsKind(full);
    if (kind === "missing") return opfsResult(404, "missing");
    if (kind === "directory") {
      const recursive = params.recursive === "1" || params.recursive === "true";
      if (!recursive && (await readdir(full)).length) return opfsResult(409, "not empty");
      await rm(full, { recursive: true });
    } else {
      await rm(full);
    }
    dropOpfsLocks(full);
    return opfsResult(200, "ok");
  }
  if (op === "move") {
    const dest = opfsFull(root, params.to || "");
    await rename(full, dest.full);
    opfsLocks.delete(full);
    return opfsResult(200, "ok");
  }
  if (op === "lock") {
    const current = opfsLocks.get(full);
    if (current && Date.now() - current.at < OPFS_LOCK_MS) return opfsResult(409, "locked");
    const token = randomBytes(8).toString("hex");
    opfsLocks.set(full, { token, at: Date.now() });
    return opfsResult(200, token);
  }
  if (op === "touch" || op === "unlock") {
    const current = opfsLocks.get(full);
    if (!current || current.token !== String(params.token || "")) return opfsResult(409, "locked");
    if (op === "unlock") opfsLocks.delete(full);
    else current.at = Date.now();
    return opfsResult(200, "ok");
  }
  throw opfsFail(400, "Unknown storage request");
}

function withGluePolyfill(asset) {
  if (asset.body.includes(Buffer.from("hog-opfs-end"))) return asset;
  return {
    body: Buffer.concat([GLUE_PREFIX, Buffer.from("\n"), asset.body]),
    type: "text/javascript",
  };
}

async function handleOpfs(site, req, res, url) {
  if (site.origin !== NODE_ORIGIN) {
    send(res, 404, "That page is not available", "text/plain; charset=utf-8");
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }
  const op = url.searchParams.get("op") || "";
  try {
    const raw = await readBody(req, op === "write" ? 32_000_000 : 1_000_000);
    const params = Object.fromEntries(url.searchParams.entries());
    const result = await applyOpfs(opfsRootFor(site.origin), op, params.path || "", raw, params);
    send(res, result.status, result.body, result.type, SITE_HEADERS);
  } catch (error) {
    const status = Number(error?.status) || 400;
    send(res, status, error instanceof Error ? error.message : "Storage failed", "text/plain; charset=utf-8", SITE_HEADERS);
  }
}

async function handleSite(runtime, site, req, res) {
  if (hostName(req) !== PAGE_HOST) {
    send(res, 404, "That page is not available", "text/plain; charset=utf-8");
    return;
  }
  const url = new URL(req.url || "/", `http://${PAGE_HOST}:${site.port}`);
  if (url.pathname === "/__hog/opfs") {
    await handleOpfs(site, req, res, url);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }
  const key = `${url.pathname}${url.search}`;
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  const accept = String(req.headers.accept || "");
  const navigation = dest === "document" || dest === "iframe" || (dest === "" && /text\/html/i.test(accept));
  if (navigation) {
    let html = site.pages.get(key);
    if (!html) {
      const page = await fetchPage(new URL(key, site.origin), {}, runtime);
      html = page.html;
    }
    send(res, 200, req.method === "HEAD" ? "" : html, "text/html; charset=utf-8", SITE_HEADERS);
    return;
  }
  const localFile = localNodeFile(site.origin, url.pathname);
  let asset = localFile
    ? { body: await readFile(localFile), type: localFile.endsWith(".wasm") ? "application/wasm" : "text/javascript" }
    : await fetchAsset(new URL(key, site.origin));
  if (isNodeGlue(site.origin, url.pathname)) asset = withGluePolyfill(asset);
  send(res, 200, req.method === "HEAD" ? "" : asset.body, asset.type, SITE_HEADERS);
}

function fixtureHtml(which) {
  if (which === "next") {
    return `<!doctype html><html><head><title>Hog fixture next</title></head><body><p id="landed">second page</p></body></html>`;
  }
  return `<!doctype html><html><head><title>Hog fixture</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><p id="marker">first page</p><a id="go" href="/fixture/next">Next page</a></body></html>`;
}

async function handle(req, res, runtime) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/fixture/page" || url.pathname === "/fixture/next")) {
      const which = url.pathname.endsWith("next") ? "next" : "page";
      send(res, 200, fixtureHtml(which), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/fixture/form") {
      send(res, 200, `<!doctype html><html><head><title>Hog form</title></head><body><form id="find" action="/fixture/search" method="post"><input name="q" value="wart"><button type="submit">Go</button></form></body></html>`, "text/html; charset=utf-8");
      return;
    }
    if (req.method === "POST" && url.pathname === "/fixture/search") {
      const raw = await readBody(req, 64_000);
      const q = new URLSearchParams(raw.toString("utf8")).get("q") || "";
      send(res, 200, `<!doctype html><html><head><title>Hog search</title></head><body><p id="q">${escapeText(q)}</p></body></html>`, "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/fixture/app.js") {
      send(res, 200, `document.documentElement.dataset.hogmod="ran";\n`, "text/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/fixture/app.css") {
      send(res, 200, `body{background:#010203}\n`, "text/css; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/fixture/rich") {
      send(res, 200, `<!doctype html><html><head><title>Hog rich</title><link rel="stylesheet" href="/fixture/app.css"><script type="module" src="/fixture/app.js"></script></head><body><p id="rich">rich</p></body></html>`, "text/html; charset=utf-8");
      return;
    }

    const walletRequest = hasGate(req) && hostName(req) === WALLET_HOST;
    if ((url.pathname === "/api/browse" || url.pathname === "/api/node" || url.pathname === "/api/favicon" || url.pathname === "/api/mining") && !walletRequest) {
      send(res, 403, { ok: false, error: "Open Hog to browse" });
      return;
    }

    if (url.pathname === "/api/mining" && req.method === "GET") {
      send(res, 200, miningStatus(miningEnabled));
      return;
    }
    if (url.pathname === "/api/mining" && req.method === "POST") {
      const payload = await readJson(req);
      if (payload.address !== undefined) {
        const address = String(payload.address || "").trim().toLowerCase();
        if (address && !isWarthogAddress(address)) {
          send(res, 400, { ok: false, error: "That is not a Warthog address: it needs 48 hex characters with a valid checksum." });
          return;
        }
        miningAddress = address;
      }
      if (payload.network !== undefined) {
        if (!MINING_NETWORK_SETTINGS.has(payload.network)) {
          send(res, 400, { ok: false, error: "network must be auto, defi or mainnet" });
          return;
        }
        miningNetworkSetting = payload.network;
      }
      if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") throw new Error("enabled must be true or false");
      if (typeof payload.enabled === "boolean" && payload.enabled !== miningEnabled) {
        miningEnabled = payload.enabled;
        await setMining(miningEnabled);
      }
      if (runtime.persistSites) saveMiningState({ enabled: miningEnabled, address: miningAddress, network: miningNetworkSetting });
      send(res, 200, miningStatus(miningEnabled));
      return;
    }

    if (url.pathname === "/api/favicon" && req.method === "GET") {
      let origin;
      try {
        origin = faviconOrigin(url.searchParams.get("url"));
      } catch {
        send(res, 400, "", "text/plain; charset=utf-8");
        return;
      }
      const icon = await cachedFavicon(origin);
      if (!icon) {
        send(res, 404, "", "text/plain; charset=utf-8", { "cache-control": "private, max-age=3600" });
        return;
      }
      send(res, 200, icon.body, icon.type, {
        "cache-control": "private, max-age=86400",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "cross-origin-resource-policy": "same-origin",
      });
      return;
    }

    if (url.pathname === "/api/browse" && req.method === "POST") {
      const payload = await readJson(req, 256_000);
      const method = String(payload.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") throw new Error("Method not allowed");
      const target = parseBrowseUrl(payload.url);
      const page = await fetchPage(target, {
        method,
        fields: payload.fields,
      }, runtime);
      send(res, 200, { ok: true, ...page });
      return;
    }

    if (url.pathname === "/api/node" && (req.method === "GET" || req.method === "POST")) {
      const payload = req.method === "POST" ? await readJson(req) : {};
      const base = req.method === "GET" ? url.searchParams.get("base") : payload.base;
      const path = req.method === "GET" ? url.searchParams.get("path") : payload.path;
      const spec = assertNodeRequest(base, path, req.method);
      const upstream = await proxyNode(spec.base, spec.path, spec.method, payload.body);
      res.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(upstream.text);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(ROOT, requested));
    if (!filePath.startsWith(ROOT)) {
      send(res, 403, { ok: false, error: "Forbidden" });
      return;
    }
    const data = await readFile(filePath);
    const type = TYPES[extname(filePath)] || "application/octet-stream";
    if (type.startsWith("video/") && req.method === "GET") {
      sendMedia(res, data, type, req.headers.range);
      return;
    }
    const extra = {};
    if (requested === "/index.html") {
      Object.assign(extra, WALLET_ISOLATION);
      if (hostName(req) === WALLET_HOST) {
        extra["set-cookie"] = `hog_gate=${GATE}; HttpOnly; SameSite=Strict; Path=/`;
        extra["x-frame-options"] = "DENY";
        extra["content-security-policy"] = "frame-ancestors 'none'";
      }
    }
    send(res, 200, data, type, extra);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    const status = /not found|ENOENT/i.test(message) ? 404 : 400;
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      send(res, status === 404 ? 404 : 400, message, "text/plain; charset=utf-8");
      return;
    }
    send(res, status === 404 ? 404 : 400, { ok: false, error: message });
  }
}

export function startServer(port = PORT, { persistSites = false } = {}) {
  const runtime = createRuntime({ persistSites });
  const server = createServer((req, res) => {
    handle(req, res, runtime).catch((error) => {
      const message = error instanceof Error ? error.message : "Request failed";
      if (!res.headersSent) send(res, 500, { ok: false, error: message });
      else res.end();
    });
  });
  const closeMain = server.close.bind(server);
  server.close = (callback) => {
    for (const child of runtime.siteServers) child.close();
    STRATUM.stop();
    MINING.stop();
    return closeMain(callback);
  };
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = await startServer(PORT, { persistSites: true });
  ({ enabled: miningEnabled, address: miningAddress, network: miningNetworkSetting } = readMiningState());
  if (miningEnabled) await setMining(true);
  if (process.env.HOG_MINING === "1" && !miningEnabled) {
    miningEnabled = true;
    await setMining(true);
  }
  if (miningEnabled) {
    const state = MINING.status();
    const strat = STRATUM.status();
    console.log(state.listening ? `Hog solo mining relay on http://127.0.0.1:${state.port}` : `Hog solo mining relay is off: ${miningError}`);
    if (strat.stratumListening) console.log(`Hog solo mining stratum on stratum+tcp://127.0.0.1:${strat.stratumPort}`);
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`Hog is ready at http://127.0.0.1:${port}`);
}
