import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { MINING_NETWORKS, bzminerCommand, createMiningRelay, miningPort, pageRelayPageScript, pageRelayScript, resolveMiningNetwork } from "./mining.mjs";
import { createStratumBridge, headHeights, isWarthogAddress, stratumPort } from "./stratum.mjs";
import { magicDnsName, rigNameSuggestion, tailnetAddresses } from "./tailnet.mjs";
import { createFilesService, handleFilesRequest } from "./files.mjs";
import { execFile } from "node:child_process";
import { createMobileApi, createMobileListener, createMobileState, mobilePort, pairUri, qrSvg } from "./mobile.mjs";
import { canPrompt, changeFirewall, createLanForwarder, createLanState, lanAddresses, lanStatus, runUfw, ufwEnabled } from "./jellyfin-lan.mjs";

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
const OPFS_TOKEN = /^[0-9a-f]{16,64}$/;
// fs errors worth a retry from the node tab; others are reported as they are.
const OPFS_TRANSIENT_CODES = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EINTR", "ETIMEDOUT", "ENOMEM", "ECONNRESET"]);
const OPFS_CLIENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EINVAL", "ENAMETOOLONG"]);
// Only these node-tab storage calls may arrive as GET (they change nothing).
const OPFS_READ_OPS = new Set(["stat", "list", "size", "read"]);
const OPFS_SLOW_MS = 5_000;
// The node tab makes thousands of these calls a second while syncing; keep
// the queue per file so a retried call can never land before the call it
// repeats, and keep the log readable when something keeps failing.
const opfsQueues = new Map();
const opfsLog = { windowStart: 0, lines: 0, suppressed: 0, limit: 20, windowMs: 60_000, write: (line) => console.log(line) };
// Fault injection for resilience tests only; off unless these are set.
// HOG_OPFS_FAULTS=0.02 fails ~2% of storage calls in one of four ways (refused,
// connection dropped before or after the call ran, or 503 after it ran).
// HOG_OPFS_OUTAGE=N:MS fails every call for MS milliseconds after call N.
const opfsFaults = {
  rate: Math.min(0.5, Math.max(0, Number(process.env.HOG_OPFS_FAULTS || 0) || 0)),
  outageAfter: Number(String(process.env.HOG_OPFS_OUTAGE || "").split(":")[0]) || 0,
  outageMs: Number(String(process.env.HOG_OPFS_OUTAGE || "").split(":")[1]) || 0,
  outageUntil: 0,
  calls: 0,
  injected: 0,
  random: Math.random,
};
export const opfsFaultInternals = opfsFaults;

function pickOpfsFault() {
  const f = opfsFaults;
  if (!f.rate && !f.outageMs) return "";
  f.calls += 1;
  const now = Date.now();
  if (f.outageMs && f.outageAfter && f.calls === f.outageAfter) {
    f.outageUntil = now + f.outageMs;
    console.log(`opfs: test outage for ${f.outageMs} ms starts now`);
  }
  if (now < f.outageUntil) {
    f.injected += 1;
    return f.calls % 2 ? "refuse" : "drop";
  }
  if (!f.rate || f.random() >= f.rate) return "";
  f.injected += 1;
  return ["refuse", "drop", "lose-reply", "fail-after"][Math.floor(f.random() * 4)];
}
// HOG_OPFS_STATS=1 logs node-tab storage requests per second (sync profiling).
const OPFS_STATS = process.env.HOG_OPFS_STATS === "1" ? { ops: {} } : null;
if (OPFS_STATS) {
  setInterval(() => {
    if (!Object.keys(OPFS_STATS.ops).length) return;
    console.log(`opfs ops/5s ${JSON.stringify(OPFS_STATS.ops)}`);
    OPFS_STATS.ops = {};
  }, 5000).unref();
}
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
// The hog window asks this on launch. A server left over from before an update
// reports its old version, and the window replaces it instead of attaching.
const SERVER_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")).version || "");
  } catch {
    return "";
  }
})();
export function serverVersionInfo() {
  return { app: "hog-browser", version: SERVER_VERSION, pid: process.pid };
}

// ---------- hog://files (confined to ~/hog-shares and folders the user adds) ----------
const FILES = createFilesService({
  dataDir: process.env.HOG_DATA || join(homedir(), ".local/share/hog-browser"),
  sharesDir: process.env.HOG_SHARES_DIR || join(homedir(), "hog-shares"),
  configFile: process.env.HOG_FILES_CONFIG || join(homedir(), ".local/share/hog-browser/files.json"),
});

// ---------- Phone app (tailnet): opt-in API for the Android companion ----------
const APP_ROOT = fileURLToPath(new URL("./", import.meta.url));
const HOG_DATA_DIR = process.env.HOG_DATA || join(homedir(), ".local/share/hog-browser");
const MOBILE_STATE = createMobileState({ file: process.env.HOG_MOBILE_CONFIG || join(HOG_DATA_DIR, "mobile.json") });
let mobileError = "";

/** Container list and start/stop/restart through mobile_guard.py (Guard rules). */
export function mobileContainers(action, name = "", { python = process.env.HOG_PYTHON || "python3", timeoutMs = 90_000 } = {}) {
  const args = [join(APP_ROOT, "mobile_guard.py"), action];
  if (name) args.push(name);
  return new Promise((resolve) => {
    execFile(python, args, { cwd: APP_ROOT, timeout: timeoutMs, maxBuffer: 2_000_000, env: { ...process.env, HOG_DATA: HOG_DATA_DIR } }, (error, stdout) => {
      try {
        const payload = JSON.parse(String(stdout || "").trim().split("\n").pop() || "{}");
        if (payload && typeof payload === "object" && Array.isArray(payload.items)) {
          resolve(payload);
          return;
        }
      } catch {
        // fall through
      }
      resolve({ ok: false, error: error?.killed ? "Docker took too long." : "Containers are not available right now.", docker: false, items: [], jellyfinUrl: "" });
    });
  });
}

function mobileHogInfo() {
  const ipv4 = tailnetAddresses().find((a) => a.family === 4)?.address || "";
  if (ipv4) refreshTailnetName(ipv4);
  return { name: "hog", version: SERVER_VERSION, dnsName: tailnetDnsName, ip: ipv4, port: MOBILE_LISTENER.status().port || mobilePort() };
}

const MOBILE_API = createMobileApi({
  state: MOBILE_STATE,
  files: FILES,
  mining: () => miningStatus(miningEnabled),
  containers: (action, name) => mobileContainers(action, name),
  info: mobileHogInfo,
});
const MOBILE_LISTENER = createMobileListener({ handler: MOBILE_API, findTailnet: process.env.HOG_MOBILE_NO_TAILNET === "1" ? () => [] : tailnetAddresses });

async function setMobile(enabled) {
  mobileError = "";
  if (!enabled) {
    await MOBILE_LISTENER.stop();
    return;
  }
  try {
    await MOBILE_LISTENER.start(mobilePort());
  } catch (error) {
    mobileError = error?.code === "EADDRINUSE"
      ? `Port ${mobilePort()} is already in use. Set HOG_MOBILE_PORT to another port.`
      : (error instanceof Error ? error.message : String(error));
  }
}

// ---------- Jellyfin on the home network (opt-in, LAN IPv4 only, never 0.0.0.0) ----------
const JELLYFIN_LAN_STATE = createLanState({ file: process.env.HOG_JELLYFIN_LAN_CONFIG || join(HOG_DATA_DIR, "jellyfin-lan.json") });
const JELLYFIN_LAN = createLanForwarder({
  port: Number(process.env.HOG_JELLYFIN_LAN_PORT || 8096),
  targetPort: Number(process.env.HOG_JELLYFIN_PORT || 8096),
  ...(process.env.HOG_JELLYFIN_LAN_NO_LAN === "1" ? { findLan: () => [] } : {}),
});

async function setJellyfinLan(enabled) {
  if (enabled) await JELLYFIN_LAN.start();
  else await JELLYFIN_LAN.stop();
}

// Swappable in tests; the real one runs pkexec ufw with a fixed argv.
const JELLYFIN_FIREWALL = {
  run: runUfw,
  enabled: () => ufwEnabled(process.env.HOG_UFW_CONF || "/etc/ufw/ufw.conf"),
  prompt: () => canPrompt(),
  findLan: process.env.HOG_JELLYFIN_LAN_NO_LAN === "1" ? () => [] : lanAddresses,
};

/** What Settings → Containers → Jellyfin → Home network access shows. */
export function jellyfinLanStatus() {
  return lanStatus(JELLYFIN_LAN_STATE, JELLYFIN_LAN, {
    targetPort: Number(process.env.HOG_JELLYFIN_PORT || 8096),
    findLan: () => JELLYFIN_FIREWALL.findLan(),
    firewall: () => JELLYFIN_FIREWALL.enabled(),
    prompt: () => JELLYFIN_FIREWALL.prompt(),
  });
}

/** "Allow through firewall" / "Remove firewall rule": polkit asks for the password, never Hog. */
async function jellyfinFirewall(remove) {
  if (!JELLYFIN_FIREWALL.enabled()) return { ok: false, error: "The ufw firewall is off, so there is nothing to change." };
  if (!JELLYFIN_FIREWALL.prompt()) return { ok: false, error: "This computer cannot show a password prompt (pkexec is missing). Run the command shown in a terminal." };
  return changeFirewall(JELLYFIN_LAN_STATE, {
    remove,
    addresses: JELLYFIN_FIREWALL.findLan(),
    port: JELLYFIN_LAN.status().port || Number(process.env.HOG_JELLYFIN_LAN_PORT || 8096),
    run: (rule, opts) => JELLYFIN_FIREWALL.run(rule, opts),
  });
}

/** What Settings → Tailscale → Phone app shows. Never includes tokens or hashes. */
export function mobileStatus() {
  const listener = MOBILE_LISTENER.status();
  const hog = mobileHogInfo();
  const pairing = MOBILE_STATE.pairingInfo();
  const port = listener.port || mobilePort();
  let pair = null;
  if (pairing) {
    const uri = pairUri({ host: hog.dnsName, ip: hog.ip, port, code: pairing.plain });
    pair = { code: pairing.code, expiresAt: pairing.expiresAt, triesLeft: pairing.tries, uri, qr: qrSvg(uri) };
  }
  return {
    ok: true,
    enabled: MOBILE_STATE.enabled,
    listening: listener.listening,
    tailnetListening: listener.tailnetHosts,
    port,
    dnsName: hog.dnsName,
    ip: hog.ip,
    address: hog.dnsName || hog.ip,
    error: mobileError || listener.error,
    devices: MOBILE_STATE.devices(),
    pairing: pair,
  };
}

const MINING_STATE_FILE = join(homedir(), ".local/share/hog-browser/mining.json");
// "auto" follows the network the node tab is running; "defi" / "mainnet" pin it.
let miningNetworkSetting = "auto";
const MINING_NETWORK_SETTINGS = new Set(["auto", "defi", "mainnet"]);
const MINING = createMiningRelay({
  token: randomBytes(24).toString("hex"),
  pageOrigin: `http://${PAGE_HOST}:${NODE_PORT}`,
  network: () => currentMiningNetwork()?.page || "",
  // Same ready gate as stratum: no template until the node has caught up.
  checkTemplate: (result) => STRATUM.templateBlocked(result, currentMiningNetwork()),
});
function currentMiningNetwork() {
  return resolveMiningNetwork(miningNetworkSetting, MINING.getPageNetwork());
}
const STRATUM = createStratumBridge({ call: MINING.call, getNetwork: currentMiningNetwork, getPublicTip: publicTipHeight });
/**
 * The network tip from its public node (the same node Hog's wallet uses), for
 * the mining ready gate. 0 if it cannot be read.
 * @param {string} key "defi" or "mainnet"
 */
async function publicTipHeight(key) {
  const base = NETWORKS[key];
  if (!base) return 0;
  try {
    const response = await fetch(`${base}/chain/head`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return 0;
    return headHeights(await response.json()).height;
  } catch {
    return 0;
  }
}
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
      tailnet: saved?.tailnet === true,
    };
  } catch {
    return { enabled: false, address: "", network: "auto", tailnet: false };
  }
}

function saveMiningState(state) {
  mkdirSync(join(homedir(), ".local/share/hog-browser"), { recursive: true });
  writeFileSync(MINING_STATE_FILE, `${JSON.stringify({ enabled: Boolean(state.enabled), address: state.address || "", network: state.network || "auto", tailnet: Boolean(state.tailnet) })}\n`);
}

// "Allow rigs on my tailnet": off by default. MagicDNS name is looked up in the
// background and cached, so status stays synchronous.
let miningTailnet = false;
let tailnetDnsName = "";
let tailnetDnsFor = "";
function refreshTailnetName(ip) {
  if (!ip || tailnetDnsFor === ip) return;
  tailnetDnsFor = ip;
  magicDnsName(ip).then((name) => {
    if (tailnetDnsFor === ip) tailnetDnsName = name;
  }, () => {});
}

/** Tailnet part of the mining status: addresses, MagicDNS name and the remote rig command. */
export function tailnetMiningInfo({ allow, listening, port, wallet, network, dnsName, addresses = tailnetAddresses() }) {
  const ipv4 = addresses.find((a) => a.family === 4)?.address || "";
  const host = dnsName || ipv4;
  const rig = rigNameSuggestion(network);
  return {
    allowTailnet: Boolean(allow),
    tailnetAddress: ipv4,
    tailnetDnsName: dnsName || "",
    tailnetAvailable: Boolean(ipv4),
    tailnetListening: listening,
    remoteRigName: rig,
    remoteCommand: host ? bzminerCommand(port, wallet, rig).replace("127.0.0.1", host) : "",
    remoteCommandIp: ipv4 && dnsName ? bzminerCommand(port, wallet, rig).replace("127.0.0.1", ipv4) : "",
    remoteCommandWindows: host ? bzminerCommand(port, wallet, rig).replace("127.0.0.1", host).replace(/^\.\/bzminer/, "bzminer.exe") : "",
  };
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
    ...tailnetMiningInfo({
      allow: miningTailnet,
      listening: STRATUM.status().tailnetListening,
      port: sport || 3456,
      wallet: miningAddress || undefined,
      network: net?.key || "defi",
      dnsName: tailnetDnsName,
    }),
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
    await STRATUM.start(stratumPort(), { tailnet: miningTailnet });
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

/** Local chain height from the same /chain/head payload, or 0 if unknown. */
export function nodeHeadHeight(body) {
  let data = body;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return 0;
    }
  }
  if (!data || typeof data !== "object") return 0;
  if (data.data && typeof data.data === "object") data = data.data;
  const head = data.chainHead && typeof data.chainHead === "object" ? data.chainHead : data;
  const n = Number(head.height ?? data.height);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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

/**
 * The browser-node page stops the node on any SQLite "disk I/O error" and
 * tells the user to clear their chain. When Hog's own storage calls were what
 * failed (the polyfill reports that on the "hog-opfs" channel), the chain on
 * disk is intact, so Hog reloads the page and presses Start once by itself,
 * after the old threads' storage lock has lapsed. A second failure within
 * NODE_RESTART_QUIET_MS is left for the user.
 *
 * The same restart is used if the node stays running and unsynced but its
 * height does not move for NODE_STALL_MS (a stuck block request or stale
 * peer descriptor that never times out). That is the same action as Stop
 * then Start in the node UI, after the storage lock lapses.
 */
export const NODE_RESTART_WAIT_MS = 65_000;
export const NODE_RESTART_QUIET_MS = 30 * 60_000;
export const NODE_STALL_MS = 3 * 60_000;

export function nodeRecoveryScript(options = {}) {
  const waitMs = Number(options.waitMs ?? NODE_RESTART_WAIT_MS);
  const quietMs = Number(options.quietMs ?? NODE_RESTART_QUIET_MS);
  const stallMs = Number(options.stallMs ?? NODE_STALL_MS);
  const tickMs = Number(options.tickMs ?? 2000);
  return `(function () {
  if (window.__hogNodeRecovery) return;
  window.__hogNodeRecovery = true;
  var KEY = "hogNodeAutoRestart";
  var WAIT_MS = ${waitMs};
  var QUIET_MS = ${quietMs};
  var STALL_MS = ${stallMs};
  var GIVE_UP_MS = 120000;
  var readSynced = ${nodeSyncedFlag.toString()};
  var readHeight = ${nodeHeadHeight.toString()};
  var lastFailure = 0;
  var stall = { height: 0, since: 0 };
  var channel = null;
  try {
    channel = new BroadcastChannel("hog-opfs");
    channel.onmessage = function (event) {
      var data = event && event.data;
      if (data && data.type === "storage-failure") lastFailure = Date.now();
    };
  } catch (e) { channel = null; }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null") || {}; } catch (e) { return {}; } }
  function save(state) { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function tell(type) { try { parent.postMessage({ source: "hog", type: type }, "*"); } catch (e) {} }
  var banner = null;
  function note(text) {
    if (!document.body) return;
    if (!banner) {
      banner = document.createElement("div");
      banner.setAttribute("data-hog-node-recovery", "");
      banner.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#222;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)";
      document.body.appendChild(banner);
    }
    banner.textContent = text;
    banner.style.display = text ? "block" : "none";
  }
  function startButton() {
    var list = document.querySelectorAll("button");
    for (var i = 0; i < list.length; i += 1) {
      var b = list[i];
      if (String(b.textContent || "").trim() === "Start node" && !b.disabled) return b;
    }
    return null;
  }
  function tick() {
    var state = load();
    var now = Date.now();
    if (state.startAt) {
      var left = state.startAt - now;
      if (left > 0) {
        var wait = Math.ceil(left / 1000);
        note(state.reason === "node-stall-restart"
          ? "Hog: the node has not advanced for " + Math.round(STALL_MS / 60000) + " minutes while still syncing. Your chain data is fine; restarting the node in " + wait + " s."
          : "Hog: a storage request failed. Your chain data is fine; restarting the node in " + wait + " s.");
        return;
      }
      var button = startButton();
      if (button) {
        save({ last: state.last });
        note("");
        button.click();
        tell("node-autorestart");
      } else if (now - state.startAt > GIVE_UP_MS) {
        save({ last: state.last });
        note("");
      }
      return;
    }
    var text = document.body ? String(document.body.innerText || "") : "";
    if (/SQLite disk I\\/O error/i.test(text)) {
      if (/malformed|not a database|SQLITE_CORRUPT/i.test(text)) return;
      if (channel && now - lastFailure > GIVE_UP_MS) return;
      beginRestart("node-storage-restart");
      return;
    }
    checkStall();
  }
  function beginRestart(type) {
    var state = load();
    var now = Date.now();
    if (state.startAt) return;
    if (state.last && now - state.last < QUIET_MS) return;
    save({ last: now, startAt: now + WAIT_MS, reason: type });
    tell(type);
    location.reload();
  }
  function checkStall() {
    if (startButton()) {
      stall = { height: 0, since: 0 };
      return;
    }
    var state = load();
    if (state.last && Date.now() - state.last < QUIET_MS) return;
    var mod = window.wartNode || window.Module;
    if (!mod || typeof mod.virtual_get !== "function") return;
    Promise.resolve(mod.virtual_get("/chain/head")).then(function (raw) {
      var synced = readSynced(raw);
      var height = readHeight(raw);
      var now = Date.now();
      if (synced || !height) {
        stall = { height: height || 0, since: now };
        return;
      }
      if (stall.height !== height || !stall.since) {
        stall = { height: height, since: now };
        return;
      }
      if (now - stall.since < STALL_MS) return;
      beginRestart("node-stall-restart");
    }).catch(function () {});
  }
  setInterval(tick, ${tickMs});
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
    ? `<script>${GLUE_PREFIX.toString("utf8").replace(/<\/script/gi, "<\\/script")}</script><script>${nodeSyncScript()}</script><script>${nodeRecoveryScript()}</script><script data-hog-relay>${pageRelayScript(MINING.token).replace(/<\/script/gi, "<\\/script")}</script>`
    : "";
  const inject = storage + navScript(origin);
  if (/<head[^>]*>/i.test(body)) {
    return body.replace(/<head[^>]*>/i, (head) => `${head}${inject}`);
  }
  return `<!doctype html><html><head>${inject}</head><body>${body}</body></html>`;
}

function normalizeHost(hostname) {
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

/** Same ranges as electron/lib/policy.js. Link-local is always refused. */
function isLinkLocalAddress(ip) {
  const host = normalizeHost(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const v4 = mapped ? mapped[1] : host;
  const parts = ipv4Parts(v4);
  if (parts) return parts[0] === 169 && parts[1] === 254;
  const hextet = ipv6Hextet(host);
  return hextet != null && hextet >= 0xfe80 && hextet <= 0xfebf;
}

function isNonPublicAddress(ip) {
  const host = normalizeHost(ip);
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
  }
  return false;
}

function isExplicitPrivateName(host) {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

function pinRecord(address, family) {
  const ip = normalizeHost(address);
  const parsed = isIP(ip);
  return { address: ip, family: family === 6 || parsed === 6 ? 6 : 4 };
}

/**
 * Decide whether a browse, asset, or favicon fetch may run, and which
 * addresses it may connect to. A public name that resolves to a loopback,
 * private, or link-local address is rejected. An address the user typed
 * (including LAN and loopback) is allowed, except link-local metadata space.
 * @param {string} hostname
 * @param {Array<{ address?: string, family?: number }>} records
 */
export function classifyFetchHost(hostname, records) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, error: "Missing host" };
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "That host is blocked" };
  const list = (Array.isArray(records) ? records : [])
    .map((record) => pinRecord(record && record.address, record && record.family))
    .filter((record) => record.address);
  if (!list.length) return { ok: false, error: "That host did not resolve" };
  const explicit = isIP(host) !== 0 || isExplicitPrivateName(host);
  if (explicit) {
    if (list.some((record) => isLinkLocalAddress(record.address))) {
      return { ok: false, error: "Link-local addresses are blocked" };
    }
    return { ok: true, addresses: list };
  }
  if (list.some((record) => isLinkLocalAddress(record.address) || isNonPublicAddress(record.address))) {
    return { ok: false, error: "That host resolves to a blocked address" };
  }
  return { ok: true, addresses: list };
}

/**
 * @param {string} hostname
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
export async function assertFetchAllowed(hostname) {
  const host = normalizeHost(hostname);
  if (!host) throw new Error("Missing host");
  if (BLOCKED_HOSTS.has(host)) throw new Error("That host is blocked");
  let records;
  if (isIP(host)) {
    records = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    records = [{ address: "127.0.0.1", family: 4 }];
  } else {
    records = await lookup(host, { all: true });
  }
  const decision = classifyFetchHost(host, records);
  if (!decision.ok) throw new Error(decision.error);
  return decision.addresses;
}

/**
 * Fetch `target` but connect only to `pin`, the address already checked.
 * A later DNS answer cannot move the connection onto a private host.
 * @param {URL} target
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal, pin: { address: string, family: number } }} options
 */
export function pinnedFetch(target, options) {
  const pin = options.pin;
  const address = pin.address;
  const family = pin.family === 6 ? 6 : 4;
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 0;
  return new Promise((resolve, reject) => {
    const req = request({
      host: address,
      servername: target.hostname,
      port,
      method: options.method || "GET",
      path: `${target.pathname}${target.search}`,
      headers: { ...(options.headers || {}), host: target.host },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      signal: options.signal,
    }, (res) => {
      const headerMap = res.headers || {};
      let reading = null;
      const take = () => {
        if (reading) return reading;
        reading = new Promise((done, failRead) => {
          const declared = Number(headerMap["content-length"] || 0);
          if (maxBytes && declared > maxBytes) {
            res.on("error", () => {});
            res.destroy();
            failRead(new Error("That file is too large"));
            return;
          }
          const chunks = [];
          let received = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            if (maxBytes && received > maxBytes) {
              res.destroy();
              failRead(new Error("That file is too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => done(Buffer.concat(chunks)));
          res.on("error", (error) => failRead(error instanceof Error ? error : new Error("The site did not answer")));
        });
        return reading;
      };
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode || 0,
        url: target.href,
        headers: {
          get(name) {
            const value = headerMap[String(name || "").toLowerCase()];
            if (Array.isArray(value)) return value.join(", ");
            return value == null ? null : String(value);
          },
        },
        text: async () => (await take()).toString("utf8"),
        arrayBuffer: async () => {
          const buf = await take();
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        body: {
          cancel: async () => {
            if (reading) return;
            reading = Promise.resolve(Buffer.alloc(0));
            res.on("error", () => {});
            res.destroy();
          },
        },
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function checkedFetch(target, options = {}) {
  const addresses = await assertFetchAllowed(target.hostname);
  return pinnedFetch(target, { ...options, pin: addresses[0] });
}

/**
 * Chromium asks for the node page with ?hog_relay=preload. That copy has the
 * queue only. The token stays out of the page and is fetched by the preload.
 * WebKit omits the marker and keeps the connecting script.
 * @param {string} html
 * @param {string} mode
 */
export function applyRelayMode(html, mode) {
  if (mode !== "preload") return String(html);
  const safe = pageRelayPageScript().replace(/<\/script/gi, "<\\/script");
  const next = String(html).replace(/<script data-hog-relay>[\s\S]*?<\/script>/i, `<script data-hog-relay>${safe}</script>`);
  if (next.includes(MINING.token) || next.includes('type: "hello"') || next.includes("var TOKEN")) {
    throw new Error("Mining token stayed in the page");
  }
  return next;
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

const DOWNLOAD_TYPES = new Set([
  "application/octet-stream",
  "application/vnd.android.package-archive",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-gtar",
  "application/x-xz",
  "application/x-bzip2",
  "application/zstd",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-debian-package",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
  "application/x-msdownload",
  "application/x-msi",
  "application/x-ms-installer",
  "application/x-apple-diskimage",
  "application/x-iso9660-image",
  "application/java-archive",
  "application/x-executable",
  "application/x-elf",
  "application/x-sharedlib",
  "application/x-appimage",
  "application/pdf",
]);

export function isDownloadResponse(contentType, disposition) {
  if (String(disposition || "").split(";")[0].trim().toLowerCase() === "attachment") return true;
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  return DOWNLOAD_TYPES.has(type);
}

export function downloadPageHtml(linkUrl, finalUrl) {
  let name = "";
  try {
    name = decodeURIComponent(new URL(linkUrl).pathname.split("/").pop() || "");
  } catch {}
  if (!name) {
    try { name = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || ""); } catch {}
  }
  name = name || "this file";
  return `<!doctype html><title>File download</title><body style="margin:0;padding:32px;background:#0b0b0d;color:#f4f4f5;font:15px/1.5 system-ui,sans-serif"><p>${escapeText(name)} is a file, not a page.</p><p><a style="color:#fdb913" href="${escapeAttr(linkUrl)}" target="_blank" rel="noopener noreferrer" download>Download it in a new window</a></p></body>`;
}

async function fetchPage(start, options = {}, runtime) {
  let current = start;
  let verb = String(options.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const posting = verb === "POST";
    const response = await checkedFetch(current, {
      method: verb,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": BROWSER_UA,
        ...(posting ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: posting ? formBody(options.fields) : undefined,
      signal: AbortSignal.timeout(12000),
      maxBytes: 8_000_000,
    });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch {}
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
      try { await response.body?.cancel(); } catch {}
      throw new Error(`The site returned ${response.status}`);
    }
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || current.href;
    if (isDownloadResponse(type, response.headers.get("content-disposition"))) {
      // A file (APK, archive, attachment). Never read it as text; that drew
      // its raw bytes in the tab. Offer the original link instead.
      try { await response.body?.cancel(); } catch {}
      const html = downloadPageHtml(start.href, finalUrl);
      return publish(runtime, current.href, html, "File download", "text/html");
    }
    if (type.startsWith("image/")) {
      try { await response.body?.cancel(); } catch {}
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
    const response = await checkedFetch(current, {
      headers: { accept: "*/*", "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(60000),
      maxBytes: MAX_ASSET,
    });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch {}
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect had no location");
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error("Redirect left http");
      }
      continue;
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(`The site returned ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ASSET) {
      try { await response.body?.cancel(); } catch {}
      throw new Error("That file is too large");
    }
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
    const response = await checkedFetch(current, {
      headers: { accept, "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(6000),
      maxBytes: limit,
    });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch {}
      const location = response.headers.get("location");
      if (!location) return null;
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") return null;
      continue;
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > limit) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    let raw;
    try {
      raw = await response.arrayBuffer();
    } catch (error) {
      if (error instanceof Error && /too large/i.test(error.message)) return null;
      throw error;
    }
    const body = Buffer.from(raw);
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

export function createRuntime({ persistSites = false } = {}) {
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
    const handler = (req, res) => {
      handleSite(runtime, site, req, res).catch((error) => {
        const message = error instanceof Error ? error.message : "Request failed";
        if (!res.headersSent) send(res, 502, message, "text/plain; charset=utf-8");
      });
    };
    const server = siteHttpServer(handler);
    try {
      await listenOn(server, site.port, "127.0.0.1");
    } catch (error) {
      server.close();
      throw error;
    }
    // WebKit resolves "localhost" to ::1 first. Without a listener there,
    // every new connection to the page's port is refused once before it
    // falls back to 127.0.0.1.
    if (!site.port) site.port = server.address().port; // tests listen on port 0
    const servers = [server];
    const v6 = siteHttpServer(handler);
    try {
      await listenOn(v6, site.port, "::1");
      servers.push(v6);
    } catch (error) {
      v6.close();
      if (!["EADDRNOTAVAIL", "EAFNOSUPPORT", "EADDRINUSE", "EINVAL"].includes(error?.code)) throw error;
    }
    site.server = server;
    site.servers = servers;
    site.pages = new Map();
    siteServers.push(...servers);
    sites.set(site.origin, site);
    for (const each of servers) {
      if (site.origin === NODE_ORIGIN) attachNodeBridge(each);
      else each.on("upgrade", (_req, socket) => socket.destroy());
    }
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

/**
 * HTTP server for a site page. The node tab's storage calls reuse keep-alive
 * connections, so idle ones stay open well past Node's 5 s default instead of
 * racing the browser's next request on a socket the server is closing.
 */
export function siteHttpServer(handler) {
  const server = createServer(handler);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  return server;
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeAllListeners("error");
      server.on("error", (error) => {
        console.error(error instanceof Error ? error.message : error);
      });
      resolve();
    });
  });
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
  if (op === "writev") {
    // Batched writes from the node tab's sync handle: [f64 offset][u32 length][bytes]...
    const writes = [];
    let pos = 0;
    while (pos < body.length) {
      if (pos + 12 > body.length) throw opfsFail(400, "Bad write batch");
      const offset = body.readDoubleLE(pos);
      const length = body.readUInt32LE(pos + 8);
      if (!Number.isInteger(offset) || offset < 0 || pos + 12 + length > body.length) throw opfsFail(400, "Bad write batch");
      if (offset + length > 16 * 1024 * 1024 * 1024) throw opfsFail(413, "That file is too large");
      writes.push({ offset, bytes: body.subarray(pos + 12, pos + 12 + length) });
      pos += 12 + length;
    }
    const handle = await open(full, "r+");
    let total = 0;
    try {
      for (const { offset, bytes } of writes) {
        let done = 0;
        while (done < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, offset + done);
          if (!bytesWritten) throw opfsFail(500, "Storage failed");
          done += bytesWritten;
        }
        total += done;
      }
      if (params.sync === "1") await handle.sync();
    } finally {
      await handle.close();
    }
    return opfsResult(200, String(total));
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
    // The node tab sends its own token so a retried lock (first reply lost)
    // is granted again instead of looking like a second tab.
    const asked = String(params.token || "");
    if (asked && !OPFS_TOKEN.test(asked)) throw opfsFail(400, "Bad lock token");
    const current = opfsLocks.get(full);
    if (current && asked && current.token === asked) {
      current.at = Date.now();
      return opfsResult(200, asked);
    }
    if (current && Date.now() - current.at < OPFS_LOCK_MS) return opfsResult(409, "locked");
    const token = asked || randomBytes(8).toString("hex");
    opfsLocks.set(full, { token, at: Date.now() });
    return opfsResult(200, token);
  }
  if (op === "touch") {
    // A touch also re-takes a lock this server no longer has (it restarted,
    // or the holder's timers were starved past the lock's lifetime), unless
    // another live holder has it.
    const token = String(params.token || "");
    if (!OPFS_TOKEN.test(token)) return opfsResult(409, "locked");
    const current = opfsLocks.get(full);
    if (current && current.token !== token && Date.now() - current.at < OPFS_LOCK_MS) return opfsResult(409, "locked");
    opfsLocks.set(full, { token, at: Date.now() });
    return opfsResult(200, "ok");
  }
  if (op === "unlock") {
    const current = opfsLocks.get(full);
    if (!current) return opfsResult(200, "ok"); // already released (a retried unlock)
    if (current.token !== String(params.token || "")) return opfsResult(409, "locked");
    opfsLocks.delete(full);
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

/** Print a storage problem, at most opfsLog.limit lines a minute. */
export function logOpfs(line, now = Date.now()) {
  if (now - opfsLog.windowStart >= opfsLog.windowMs) {
    if (opfsLog.suppressed) {
      opfsLog.write(`opfs: ${opfsLog.suppressed} more storage messages in the last minute were not shown`);
    }
    opfsLog.windowStart = now;
    opfsLog.lines = 0;
    opfsLog.suppressed = 0;
  }
  if (opfsLog.lines >= opfsLog.limit) {
    opfsLog.suppressed += 1;
    return false;
  }
  opfsLog.lines += 1;
  opfsLog.write(line);
  return true;
}

export const opfsLogInternals = opfsLog;

/** HTTP status for a failed storage call: 5xx only for failures worth a retry. */
export function opfsErrorStatus(error) {
  const explicit = Number(error?.status);
  if (explicit) return explicit;
  const code = String(error?.code || "");
  if (OPFS_TRANSIENT_CODES.has(code)) return 503;
  if (!code || OPFS_CLIENT_CODES.has(code)) return 400;
  return 500;
}

/** Run storage calls for one file in arrival order. */
function inOpfsQueue(key, job) {
  const prior = opfsQueues.get(key) || Promise.resolve();
  const run = prior.then(job, job);
  const tail = run.catch(() => {});
  opfsQueues.set(key, tail);
  tail.then(() => {
    if (opfsQueues.get(key) === tail) opfsQueues.delete(key);
  });
  return run;
}

/** Only the node page itself may use its storage endpoint. */
function opfsRequestAllowed(req, site) {
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return origin === `http://${PAGE_HOST}:${site.port}`;
}

async function handleOpfs(site, req, res, url) {
  if (site.origin !== NODE_ORIGIN) {
    send(res, 404, "That page is not available", "text/plain; charset=utf-8");
    return;
  }
  const op = url.searchParams.get("op") || "";
  const method = String(req.method || "");
  const allowed = method === "POST" || method === "PUT" || (method === "GET" && OPFS_READ_OPS.has(op));
  if (!allowed) {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }
  if (!opfsRequestAllowed(req, site)) {
    send(res, 403, "That page is not available", "text/plain; charset=utf-8");
    return;
  }
  if (OPFS_STATS) OPFS_STATS.ops[op] = (OPFS_STATS.ops[op] || 0) + 1;
  const params = Object.fromEntries(url.searchParams.entries());
  const path = String(params.path || "");
  const retry = Number(params.retry || 0);
  if (retry > 0) logOpfs(`opfs: retry ${retry} of ${op} ${path || "/"} (the earlier try failed or lost its reply)`);
  const started = Date.now();
  const root = opfsRootFor(site.origin);
  let key = root;
  try {
    key = opfsFull(root, path).full;
  } catch {
    // applyOpfs reports the bad path below.
  }
  const fault = pickOpfsFault();
  if (fault === "refuse") {
    send(res, 503, "Test fault", "text/plain; charset=utf-8", SITE_HEADERS);
    return;
  }
  if (fault === "drop") {
    req.socket.destroy();
    return;
  }
  try {
    const result = await inOpfsQueue(key, async () => {
      const raw = method === "GET" ? Buffer.alloc(0) : await readBody(req, op === "write" || op === "writev" ? 32_000_000 : 1_000_000);
      return applyOpfs(root, op, path, raw, params);
    });
    if (fault === "lose-reply") {
      req.socket.destroy();
      return;
    }
    if (fault === "fail-after") {
      send(res, 503, "Test fault", "text/plain; charset=utf-8", SITE_HEADERS);
      return;
    }
    const took = Date.now() - started;
    if (result.status === 409 && op !== "mkdir" && op !== "create") {
      logOpfs(`opfs: ${op} ${path || "/"} refused (${result.body.toString().slice(0, 40)})`);
    } else if (took >= OPFS_SLOW_MS) {
      logOpfs(`opfs: ${op} ${path || "/"} took ${took} ms`);
    }
    send(res, result.status, result.body, result.type, SITE_HEADERS);
  } catch (error) {
    const status = opfsErrorStatus(error);
    const message = error instanceof Error ? error.message : "Storage failed";
    logOpfs(`opfs: ${method} ${op} ${path || "/"} failed with ${status}${error?.code ? ` ${error.code}` : ""}: ${String(message).slice(0, 160)} (${Date.now() - started} ms)`);
    if (res.headersSent || res.destroyed) return;
    send(res, status, message, "text/plain; charset=utf-8", SITE_HEADERS);
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
  const preloadRelay = site.origin === NODE_ORIGIN && url.searchParams.get("hog_relay") === "preload";
  const lookupUrl = new URL(url);
  lookupUrl.searchParams.delete("hog_relay");
  const key = `${lookupUrl.pathname}${lookupUrl.search}`;
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  const accept = String(req.headers.accept || "");
  const navigation = dest === "document" || dest === "iframe" || (dest === "" && /text\/html/i.test(accept));
  if (navigation) {
    let html = site.pages.get(key);
    if (!html) {
      const page = await fetchPage(new URL(key, site.origin), {}, runtime);
      html = page.html;
    }
    if (preloadRelay) {
      try {
        html = applyRelayMode(html, "preload");
      } catch {
        send(res, 500, "The node page is not available", "text/plain; charset=utf-8");
        return;
      }
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

    if (req.method === "GET" && url.pathname === "/__hog/version" && hostName(req) === WALLET_HOST) {
      send(res, 200, serverVersionInfo());
      return;
    }
    // The Chromium mining preload asks the main process for this. Browsers
    // always send Origin or Sec-Fetch-Site; Node's http.get does not.
    if (req.method === "GET" && url.pathname === "/api/mining/token") {
      const host = hostName(req);
      const browserShaped = req.headers.origin || req.headers["sec-fetch-site"];
      if (browserShaped || (host !== "127.0.0.1" && host !== "localhost")) {
        send(res, 403, { ok: false, error: "Not available" });
        return;
      }
      send(res, 200, { ok: true, token: MINING.token });
      return;
    }
    const walletRequest = hasGate(req) && hostName(req) === WALLET_HOST;
    if ((url.pathname === "/api/browse" || url.pathname === "/api/node" || url.pathname === "/api/favicon" || url.pathname === "/api/mining" || url.pathname === "/api/mobile" || url.pathname === "/api/jellyfin-lan") && !walletRequest) {
      send(res, 403, { ok: false, error: "Open Hog to browse" });
      return;
    }

    if (url.pathname === "/api/files" || url.pathname.startsWith("/api/files/")) {
      if (!walletRequest) {
        send(res, 403, { ok: false, error: "Open Hog to use Files" });
        return;
      }
      const address = req.socket.localPort || PORT;
      await handleFilesRequest(FILES, req, res, url, { origin: `http://${WALLET_HOST}:${address}` });
      return;
    }

    if (url.pathname === "/api/mobile" && req.method === "GET") {
      send(res, 200, mobileStatus());
      return;
    }
    if (url.pathname === "/api/mobile" && req.method === "POST") {
      if (req.headers["x-hog-mobile"] !== "1") {
        send(res, 403, { ok: false, error: "Open Hog to change this" });
        return;
      }
      const payload = await readJson(req);
      try {
        if (payload.enabled !== undefined) {
          if (typeof payload.enabled !== "boolean") throw new Error("enabled must be true or false");
          if (payload.enabled !== MOBILE_STATE.enabled) {
            MOBILE_STATE.setEnabled(payload.enabled);
            await setMobile(payload.enabled);
          }
        }
        if (payload.action === "pair") MOBILE_STATE.startPairing();
        else if (payload.action === "cancel-pair") MOBILE_STATE.cancelPairing();
        else if (payload.action === "revoke") MOBILE_STATE.revoke(payload.id);
        else if (payload.action !== undefined) throw new Error("action must be pair, cancel-pair or revoke");
      } catch (error) {
        send(res, 400, { ...mobileStatus(), ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      send(res, 200, mobileStatus());
      return;
    }

    if (url.pathname === "/api/jellyfin-lan" && req.method === "GET") {
      send(res, 200, await jellyfinLanStatus());
      return;
    }
    if (url.pathname === "/api/jellyfin-lan" && req.method === "POST") {
      if (req.headers["x-hog-lan"] !== "1") {
        send(res, 403, { ok: false, error: "Open Hog to change this" });
        return;
      }
      const payload = await readJson(req);
      if (payload.action === "firewall-allow" || payload.action === "firewall-remove") {
        const result = await jellyfinFirewall(payload.action === "firewall-remove");
        send(res, 200, { ...(await jellyfinLanStatus()), ok: result.ok, error: result.error || "", notice: result.notice || "", cancelled: Boolean(result.cancelled) });
        return;
      }
      if (payload.action !== undefined) {
        send(res, 400, { ...(await jellyfinLanStatus()), ok: false, error: "action must be firewall-allow or firewall-remove" });
        return;
      }
      if (typeof payload.enabled !== "boolean") {
        send(res, 400, { ...(await jellyfinLanStatus()), ok: false, error: "enabled must be true or false" });
        return;
      }
      JELLYFIN_LAN_STATE.setEnabled(payload.enabled);
      await setJellyfinLan(payload.enabled);
      send(res, 200, await jellyfinLanStatus());
      return;
    }

    if (url.pathname === "/api/mining" && req.method === "GET") {
      refreshTailnetName(tailnetAddresses().find((a) => a.family === 4)?.address || "");
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
      if (payload.tailnet !== undefined) {
        if (typeof payload.tailnet !== "boolean") throw new Error("tailnet must be true or false");
        if (payload.tailnet !== miningTailnet) {
          miningTailnet = payload.tailnet;
          await STRATUM.setTailnet(miningTailnet);
        }
      }
      if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") throw new Error("enabled must be true or false");
      if (typeof payload.enabled === "boolean" && payload.enabled !== miningEnabled) {
        miningEnabled = payload.enabled;
        await setMining(miningEnabled);
      }
      if (runtime.persistSites) saveMiningState({ enabled: miningEnabled, address: miningAddress, network: miningNetworkSetting, tailnet: miningTailnet });
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
    MOBILE_LISTENER.stop();
    JELLYFIN_LAN.stop();
    return closeMain(callback);
  };
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Test hooks for the phone app API. */
export const mobileInternals = { state: MOBILE_STATE, listener: MOBILE_LISTENER, api: MOBILE_API, setMobile };
/** Test hooks for Jellyfin home network access. */
export const jellyfinLanInternals = { state: JELLYFIN_LAN_STATE, forwarder: JELLYFIN_LAN, setJellyfinLan, firewall: JELLYFIN_FIREWALL };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = await startServer(PORT, { persistSites: true });
  ({ enabled: miningEnabled, address: miningAddress, network: miningNetworkSetting, tailnet: miningTailnet } = readMiningState());
  if (miningEnabled) await setMining(true);
  if (MOBILE_STATE.enabled) {
    await setMobile(true);
    const phone = MOBILE_LISTENER.status();
    console.log(phone.listening ? `Hog phone app API on ${phone.hosts.join(", ")} port ${phone.port}` : `Hog phone app API is off: ${mobileError}`);
  }
  if (JELLYFIN_LAN_STATE.enabled) {
    await setJellyfinLan(true);
    const lan = JELLYFIN_LAN.status();
    console.log(lan.hosts.length ? `Jellyfin on the home network at ${lan.hosts.map((h) => `http://${h}:${lan.port}`).join(", ")}` : `Jellyfin home network access is waiting: ${lan.error}`);
  }
  if (process.env.HOG_MINING === "1" && !miningEnabled) {
    miningEnabled = true;
    await setMining(true);
  }
  if (miningEnabled) {
    const state = MINING.status();
    const strat = STRATUM.status();
    console.log(state.listening ? `Hog solo mining relay on http://127.0.0.1:${state.port}` : `Hog solo mining relay is off: ${miningError}`);
    if (strat.stratumListening) console.log(`Hog solo mining stratum on stratum+tcp://127.0.0.1:${strat.stratumPort}`);
    for (const host of strat.tailnetListening) console.log(`Hog solo mining stratum for tailnet rigs on ${host}:${strat.stratumPort}`);
    if (strat.tailnetError) console.log(strat.tailnetError);
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`Hog is ready at http://127.0.0.1:${port}`);
}
