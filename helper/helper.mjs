#!/usr/bin/env node
// Warthog mining helper: solo mine with BzMiner to a Warthog browser node
// running in an ordinary browser tab (Brave, Chrome, Edge, Firefox).
//
// A web page cannot open a port, and the stock browser node has no
// POST /chain/append. So the helper:
//   1. Serves the official browser node web app (https://browser-node.netlify.app)
//      on http://127.0.0.1:43180, with the node WASM swapped for Hog's patched
//      builds that add only POST /chain/append (node-defi/, node-mainnet/).
//   2. Injects Hog's mining relay script into that page. The page dials back to
//      the helper over a same-origin WebSocket, origin-checked and token-locked,
//      and answers GET /chain/mine/:account and POST /chain/append from the
//      in-tab node (window.wartNode.virtual_get / virtual_post).
//   3. Runs Hog's stratum server on 127.0.0.1:3456 for BzMiner, off until the
//      user turns it on in the control page (http://127.0.0.1:43181).
//
// Everything binds 127.0.0.1. Requests with a non-loopback Host are refused
// (DNS rebinding). Plain Node, no native modules: it runs on Linux, macOS and
// Windows, and bundles into one file (see build.mjs).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { MINING_NETWORKS, bzminerCommand, bzminerForOs, createMiningRelay, pageRelayScript, resolveMiningNetwork } from "../mining.mjs";
import { createStratumBridge, isWarthogAddress } from "../stratum.mjs";
import { controlPage } from "./control-page.mjs";
import { magicDnsName, rigNameSuggestion, tailnetAddresses } from "../tailnet.mjs";

export const VERSION = "0.1.0";
export const NODE_ORIGIN = "https://browser-node.netlify.app";
export const DEFAULT_PAGE_PORT = 43180;
export const DEFAULT_CONTROL_PORT = 43181;
export const DEFAULT_STRATUM_PORT = 3456;
const HOST = "127.0.0.1";
const NETWORK_SETTINGS = new Set(["auto", "defi", "mainnet"]);
const NODE_FILES = new Set(["wart-node.js", "wart-node.wasm"]);
const MAX_ASSET = 64 * 1024 * 1024;
// On a loopback origin the node site dials its peer on the same origin (its dev
// proxy layout). Bridge those paths to the public node sockets, as Hog does.
export const NODE_BRIDGES = new Map([
  ["/ws-bridge-defi", "wss://warthog-defitestnet.duckdns.org/ws"],
  ["/ws-defi", "wss://warthog-defitestnet.duckdns.org/ws"],
  ["/ws-bridge", "wss://warthognode.duckdns.org/ws"],
]);

/** Pipe one browser WebSocket to its public node socket, byte for byte. */
function bridgeSocket(client, target) {
  const upstream = new WebSocket(target, "binary");
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
    for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", stop);
  upstream.on("error", stop);
}
// The node site runs cross-origin isolated (SharedArrayBuffer for the WASM node).
const PAGE_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

/** Folder the helper's files live in (source tree or unpacked bundle). */
function baseDir() {
  if (process.env.WARTHOG_HELPER_HOME) return process.env.WARTHOG_HELPER_HOME;
  return dirname(fileURLToPath(import.meta.url));
}

/** Where the patched node builds are: next to the bundle, or the repo root. */
export function findNodeDirs(base = baseDir()) {
  const pick = (name, env) => {
    if (env !== undefined) return env;
    for (const dir of [join(base, name), join(base, "..", name)]) {
      if (existsSync(join(dir, "wart-node.wasm"))) return dir;
    }
    return "";
  };
  return {
    defi: pick("node-defi", process.env.WARTHOG_HELPER_DEFI_NODE_DIR),
    mainnet: pick("node-mainnet", process.env.WARTHOG_HELPER_MAINNET_NODE_DIR),
  };
}

/** /node/defi/<file> is DeFi testnet, /node/<file> is mainnet (Official1). */
export function localNodeFile(pathname, dirs) {
  let m = /^\/node\/defi\/([^/]+)$/.exec(String(pathname || ""));
  let dir = "";
  let name = "";
  if (m) {
    dir = dirs.defi;
    name = m[1];
  } else if ((m = /^\/node\/([^/]+)$/.exec(String(pathname || "")))) {
    dir = dirs.mainnet;
    name = m[1];
  }
  if (!dir || !NODE_FILES.has(name)) return "";
  const file = join(dir, name);
  return existsSync(file) ? file : "";
}

export function configDir() {
  if (process.env.WARTHOG_HELPER_CONFIG_DIR) return process.env.WARTHOG_HELPER_CONFIG_DIR;
  if (platform() === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "warthog-mining-helper");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "warthog-mining-helper");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "warthog-mining-helper");
}

export function readConfig(dir = configDir()) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return {
      enabled: saved?.enabled === true,
      address: isWarthogAddress(saved?.address) ? String(saved.address).toLowerCase() : "",
      network: NETWORK_SETTINGS.has(saved?.network) ? saved.network : "auto",
      tailnet: saved?.tailnet === true,
    };
  } catch {
    return { enabled: false, address: "", network: "auto", tailnet: false };
  }
}

function writeConfig(state, dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The relay token is kept per install (owner-only file), so restarting the
 * helper does not strand a node tab that is already running with the old one.
 */
export function relayToken(dir = configDir()) {
  const file = join(dir, "relay-token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(saved)) return saved;
  } catch {}
  const token = randomBytes(24).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Loopback Host only: blocks DNS rebinding. */
export function loopbackHost(hostHeader, port) {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    if (raw === `${name}:${port}`) return name;
  }
  return "";
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Put the relay script first in <head> so it runs before the node app. */
export function injectRelay(html, token) {
  const tag = `<script>${pageRelayScript(token).replace(/<\/script/gi, "<\\/script")}</script>`;
  const body = String(html)
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*content-security-policy\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (head) => `${head}${tag}`);
  return `${tag}${body}`;
}

function send(res, status, body, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

function readJson(req, limit = 16_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Bad JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function openInBrowser(url) {
  const os = platform();
  const [cmd, args] = os === "win32" ? ["cmd", ["/c", "start", "", url]] : os === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}

/**
 * @param {{ pagePort?: number, controlPort?: number, stratumPort?: number, configDir?: string,
 *   nodeDirs?: { defi: string, mainnet: string }, origin?: string, fetchImpl?: typeof fetch, log?: (s: string) => void }} [opts]
 */
export function createHelper(opts = {}) {
  const pagePort = opts.pagePort ?? DEFAULT_PAGE_PORT;
  const controlPort = opts.controlPort ?? DEFAULT_CONTROL_PORT;
  const stratumPort = opts.stratumPort ?? DEFAULT_STRATUM_PORT;
  const cfgDir = opts.configDir ?? configDir();
  const nodeDirs = opts.nodeDirs ?? findNodeDirs();
  const upstream = opts.origin ?? NODE_ORIGIN;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((s) => console.log(s));
  const pageOrigin = `http://${HOST}:${pagePort}`;
  const controlOrigin = `http://${HOST}:${controlPort}`;
  const controlToken = randomBytes(24).toString("hex");
  const state = readConfig(cfgDir);
  let error = "";
  const assets = new Map();

  const relay = createMiningRelay({
    token: relayToken(cfgDir),
    pageOrigin,
    network: () => network()?.page || "",
  });
  function network() {
    return resolveMiningNetwork(state.network, relay.getPageNetwork());
  }
  const findTailnet = opts.findTailnet ?? tailnetAddresses;
  const stratum = createStratumBridge({ call: relay.call, getNetwork: network, findTailnet });
  let dnsName = "";
  let dnsFor = "";
  function refreshDnsName() {
    const ip = findTailnet().find((a) => a.family === 4)?.address || "";
    if (!ip || ip === dnsFor) return;
    dnsFor = ip;
    (opts.magicDns ?? magicDnsName)(ip).then((name) => { if (dnsFor === ip) dnsName = name; }, () => {});
  }

  async function fetchAsset(pathAndQuery) {
    const cached = assets.get(pathAndQuery);
    if (cached) return cached;
    const response = await doFetch(new URL(pathAndQuery, upstream), { redirect: "follow", headers: { accept: "*/*" } });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_ASSET) throw new Error("Asset is too large");
    const asset = { status: response.status, body, type: response.headers.get("content-type") || "application/octet-stream" };
    // Astro assets are content-hashed; keep them for the session.
    if (response.ok && pathAndQuery.startsWith("/_astro/")) assets.set(pathAndQuery, asset);
    return asset;
  }

  async function handlePage(req, res) {
    const hostName = loopbackHost(req.headers.host, pagePort);
    if (!hostName) return send(res, 403, "Host not allowed");
    const url = new URL(req.url || "/", pageOrigin);
    // One origin keeps one chain database (OPFS is per origin) and one relay origin.
    if (hostName !== HOST) {
      res.writeHead(308, { location: `${pageOrigin}${url.pathname}${url.search}` });
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    const key = `${url.pathname}${url.search}`;
    const local = localNodeFile(url.pathname, nodeDirs);
    if (local) {
      const body = await readFile(local);
      return send(res, 200, req.method === "HEAD" ? "" : body, local.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8", PAGE_HEADERS);
    }
    const asset = await fetchAsset(key);
    let body = asset.body;
    if (/text\/html/i.test(asset.type)) body = injectRelay(body.toString("utf8"), relay.token);
    return send(res, asset.status, req.method === "HEAD" ? "" : body, asset.type, PAGE_HEADERS);
  }

  function status() {
    const net = network();
    const sport = stratum.status().stratumPort || stratumPort;
    return {
      ...relay.status(),
      ...stratum.status(),
      ok: true,
      version: VERSION,
      enabled: state.enabled,
      address: state.address,
      networkSetting: state.network,
      miningNetwork: net?.key || "",
      miningNetworkLabel: net?.label || "",
      pageUrl: `${pageOrigin}/`,
      pageUrls: { defi: `${pageOrigin}/?network=defi`, mainnet: `${pageOrigin}/?network=mainnet` },
      nodeBuilds: { defi: Boolean(nodeDirs.defi), mainnet: Boolean(nodeDirs.mainnet) },
      configuredStratumPort: stratumPort,
      // BzMiner on this computer: bzminer.exe when the helper runs on Windows.
      command: bzminerForOs(bzminerCommand(sport, state.address || undefined, net ? `brave-${net.key}` : "rig1"), opts.os ?? platform()),
      os: opts.os ?? platform(),
      ...tailnetInfo(sport, net),
      error,
    };
  }

  function tailnetInfo(port, net) {
    const ipv4 = findTailnet().find((a) => a.family === 4)?.address || "";
    const host = dnsName || ipv4;
    const rig = rigNameSuggestion(net?.key || "defi");
    const cmd = (h) => bzminerCommand(port, state.address || undefined, rig).replace("127.0.0.1", h);
    return {
      allowTailnet: state.tailnet,
      tailnetAddress: ipv4,
      tailnetDnsName: dnsName,
      tailnetAvailable: Boolean(ipv4),
      remoteRigName: rig,
      remoteCommand: host ? cmd(host) : "",
      remoteCommandIp: ipv4 && dnsName ? cmd(ipv4) : "",
      remoteCommandWindows: host ? bzminerForOs(cmd(host), "win32") : "",
    };
  }

  async function setEnabled(on) {
    error = "";
    if (!on) {
      await stratum.stop();
      return;
    }
    try {
      await stratum.start(stratumPort, { tailnet: state.tailnet });
    } catch (e) {
      error = e?.code === "EADDRINUSE"
        ? `Port ${stratumPort} is in use (is Hog's solo mining on?). Turn that off, or start the helper with --stratum-port.`
        : e instanceof Error ? e.message : String(e);
      state.enabled = false;
    }
  }

  async function handleControl(req, res) {
    if (loopbackHost(req.headers.host, controlPort) !== HOST) return send(res, 403, "Open http://127.0.0.1:" + controlPort);
    const url = new URL(req.url || "/", controlOrigin);
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, controlPage(controlToken), "text/html; charset=utf-8", {
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
    }
    if (!["/api/status", "/api/settings", "/api/quit"].includes(url.pathname)) return send(res, 404, "Not found");
    // Only the control page may call the API: same origin and the per-launch token.
    if (String(req.headers.origin || controlOrigin) !== controlOrigin) return send(res, 403, "Origin not allowed");
    if (!sameToken(req.headers["x-helper-token"], controlToken)) return send(res, 403, "Bad token");
    if (req.method === "GET" && url.pathname === "/api/status") {
      refreshDnsName();
      return send(res, 200, JSON.stringify(status()), "application/json");
    }
    if (req.method === "POST" && url.pathname === "/api/quit") {
      // The AppImage runs without a terminal; this is how the user stops it.
      send(res, 200, JSON.stringify({ ok: true }), "application/json");
      if (opts.onQuit) setTimeout(opts.onQuit, 100);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (!/application\/json/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, "JSON only");
      const body = await readJson(req);
      if (body.address !== undefined) {
        const address = String(body.address || "").trim().toLowerCase();
        if (address && !isWarthogAddress(address)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "That is not a Warthog address: it needs 48 hex characters with a valid checksum." }), "application/json");
        }
        state.address = address;
      }
      if (body.network !== undefined) {
        if (!NETWORK_SETTINGS.has(body.network)) return send(res, 400, JSON.stringify({ ok: false, error: "network must be auto, defi or mainnet" }), "application/json");
        state.network = body.network;
      }
      if (body.tailnet !== undefined) {
        if (typeof body.tailnet !== "boolean") return send(res, 400, JSON.stringify({ ok: false, error: "tailnet must be true or false" }), "application/json");
        state.tailnet = body.tailnet;
        await stratum.setTailnet(state.tailnet);
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return send(res, 400, JSON.stringify({ ok: false, error: "enabled must be true or false" }), "application/json");
        state.enabled = body.enabled;
        await setEnabled(state.enabled);
      }
      writeConfig(state, cfgDir);
      return send(res, 200, JSON.stringify(status()), "application/json");
    }
    return send(res, 405, "Method not allowed");
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (!res.headersSent) send(res, 502, e instanceof Error ? e.message : "Helper failed");
    else res.end();
  });
  const pageServer = createServer(wrap(handlePage));
  const peerWss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  pageServer.on("upgrade", (req, socket, head) => {
    const refuse = () => {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    };
    if (loopbackHost(req.headers.host, pagePort) !== HOST) return refuse();
    if (relay.handleUpgrade(req, socket, head)) return;
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", pageOrigin).pathname.replace(/\/+$/, "");
    } catch {
      return refuse();
    }
    const target = NODE_BRIDGES.get(pathname);
    // Only the node page may use the peer bridge.
    if (!target || String(req.headers.origin || "") !== pageOrigin) return refuse();
    peerWss.handleUpgrade(req, socket, head, (client) => bridgeSocket(client, target));
  });
  const controlServer = createServer(wrap(handleControl));

  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.removeAllListeners("error");
      resolve(server.address().port);
    });
  });

  async function start() {
    await listen(pageServer, pagePort);
    await listen(controlServer, controlPort);
    if (state.enabled) await setEnabled(true);
    log(`Warthog mining helper ${VERSION}`);
    log(`  Node page (open in Brave): ${pageOrigin}/?network=defi  or  ${pageOrigin}/?network=mainnet`);
    log(`  Control page:              ${controlOrigin}/`);
    log(`  Stratum for BzMiner:       ${state.enabled ? `stratum+tcp://${HOST}:${stratumPort}` : "off (turn it on in the control page)"}`);
    for (const h of stratum.status().tailnetListening) log(`  Stratum for tailnet rigs:  ${h}:${stratumPort}`);
    if (state.enabled && stratum.status().tailnetError) log(`  ${stratum.status().tailnetError}`);
    if (!nodeDirs.defi || !nodeDirs.mainnet) log("  Warning: a patched node build is missing; that network cannot accept mined blocks.");
  }

  async function close() {
    await stratum.stop();
    await relay.close();
    for (const client of peerWss.clients) client.terminate();
    peerWss.close();
    await Promise.all([pageServer, controlServer].map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
  }

  return { start, close, status, setEnabled, state, controlToken, pageOrigin, controlOrigin, relay };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function portArg(name, env, fallback) {
  const raw = argValue(name) ?? process.env[env];
  if (raw == null || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a port number`);
  return port;
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain || process.env.WARTHOG_HELPER_MAIN === "1") {
  if (process.argv.includes("--help")) {
    console.log("warthog-mining-helper [--page-port 43180] [--control-port 43181] [--stratum-port 3456] [--no-open]");
    process.exit(0);
  }
  const controlPort = portArg("--control-port", "WARTHOG_HELPER_CONTROL_PORT", DEFAULT_CONTROL_PORT);
  const noOpen = process.argv.includes("--no-open");
  let quit = () => process.exit(0);
  const helper = createHelper({
    pagePort: portArg("--page-port", "WARTHOG_HELPER_PAGE_PORT", DEFAULT_PAGE_PORT),
    controlPort,
    stratumPort: portArg("--stratum-port", "WARTHOG_HELPER_STRATUM_PORT", DEFAULT_STRATUM_PORT),
    onQuit: () => quit(),
  });
  helper.start().then(() => {
    if (!noOpen) openInBrowser(`${helper.controlOrigin}/`);
  }, async (e) => {
    if (e?.code === "EADDRINUSE") {
      // Launched twice (double-click again): show the running helper's page.
      const running = await fetch(`http://${HOST}:${controlPort}/`).then((r) => r.text()).then((t) => t.includes("<title>Warthog mining helper</title>"), () => false);
      if (running) {
        console.log(`The helper is already running: http://${HOST}:${controlPort}/`);
        if (!noOpen) openInBrowser(`http://${HOST}:${controlPort}/`);
        process.exit(0);
      }
      console.error(`A helper port is already in use (${e.port}). Close what uses it, or pass --page-port / --control-port.`);
    } else console.error(e);
    process.exit(1);
  });
  quit = () => helper.close().finally(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

export { MINING_NETWORKS };
