// Hog phone app (tailnet): an opt-in API for the Android companion app.
//
// Off by default. When on, a separate HTTP listener answers only on hog's
// Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) and 127.0.0.1,
// and drops every peer outside those ranges. It never listens on 0.0.0.0 or
// a LAN address. A phone pairs once with a short code that hog shows (and a
// QR code), and gets a long-lived device token. Hog keeps only the token's
// SHA-256, lists paired phones in Settings, and can revoke each one.
//
// The API exposes only: hog-managed containers (status, start/stop/restart),
// the Jellyfin link, mining stats (read-only) and Files (browse, preview,
// download, chunked upload, new folder, rename, delete to Trash) through the
// same Files service and rules as hog://files. Nothing else in hog (wallet,
// node, browse proxy, keys) is reachable from it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { handleFilesRequest } from "./files.mjs";
import { isLoopback, isTailnetIpv4, isTailnetIpv6, normalizeIp, tailnetAddresses } from "./tailnet.mjs";

export const DEFAULT_MOBILE_PORT = 4189;
export const API_PREFIX = "/m/v1/";
export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_TRIES = 5;
export const MAX_DEVICES = 12;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
const FAIL_WINDOW_MS = 10 * 60_000;
const IP_FAIL_LIMIT = 5;
const GLOBAL_FAIL_LIMIT = 20;
const AUTH_FAIL_LIMIT = 30;
const SEEN_SAVE_MS = 60_000;
const RECONCILE_MS = 30_000;

// Files routes the phone may use. Adding/removing folders, move/copy,
// restore and purge stay on the desktop.
const FILE_GET = new Set(["roots", "list", "search", "info", "raw", "upload"]);
const FILE_POST = new Set(["mkdir", "rename", "trash", "upload/cancel"]);
const CONTAINER_ACTIONS = new Set(["start", "stop", "restart"]);

export function mobilePort(env = process.env) {
  const raw = env.HOG_MOBILE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_MOBILE_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("HOG_MOBILE_PORT must be a port number");
  return port;
}

/** Loopback and tailnet peers only. */
export function mobilePeerAllowed(raw) {
  return isLoopback(raw) || isTailnetIpv4(raw) || isTailnetIpv6(raw);
}

/** Host header the phone may use: a tailnet IP, a *.ts.net name, or loopback. */
export function mobileHostAllowed(raw) {
  let host = String(raw || "").trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    host = host.slice(1, end);
  } else if (isIP(host) !== 6) {
    host = host.replace(/:\d+$/, "");
  }
  if (host === "localhost") return true;
  if (isIP(host)) return mobilePeerAllowed(host);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function normalizeCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 8 characters from a 32-letter alphabet (40 bits), shown as XXXX-XXXX. */
export function newPairCode(rand = randomBytes) {
  const bytes = rand(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] & 31];
  return out;
}

export function formatCode(code) {
  const plain = normalizeCode(code);
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

function sameHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function cleanDeviceName(raw) {
  const name = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 48);
  return name || "Phone";
}

/** QR text the app scans: hogpair://pair?host=..&ip=..&port=..&code=.. */
export function pairUri({ host, ip, port, code }) {
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (ip) params.set("ip", ip);
  params.set("port", String(port));
  params.set("code", normalizeCode(code));
  return `hogpair://pair?${params}`;
}

let qrFactory = null;
/** The QR code as an SVG string (dark modules on a light square). */
export function qrSvg(text, { scale = 6, margin = 4 } = {}) {
  if (!qrFactory) qrFactory = createRequire(import.meta.url)("./vendor/qrcode-generator.cjs");
  const qr = qrFactory(0, "M");
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  let path = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#f4f4f5"/><path d="${path}" fill="#050505"/></svg>`;
}

/**
 * Settings, paired devices and the pairing code. Saved to file (mode 0600)
 * with token hashes only; the pairing code is kept in memory.
 */
export function createMobileState({ file, now = () => Date.now(), rand = randomBytes } = {}) {
  let data = { enabled: false, devices: [] };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    data = {
      enabled: saved?.enabled === true,
      devices: Array.isArray(saved?.devices)
        ? saved.devices.filter((d) => d && /^[a-f0-9]{16}$/.test(d.id) && /^[a-f0-9]{64}$/.test(d.hash)).map((d) => ({
          id: d.id,
          name: cleanDeviceName(d.name),
          hash: d.hash,
          createdAt: Number(d.createdAt) || 0,
          lastSeenAt: Number(d.lastSeenAt) || 0,
        }))
        : [],
    };
  } catch {
    // first run or unreadable: start off
  }
  let pairing = null; // { hash, display, expiresAt, tries }
  const ipFails = new Map();
  let globalFails = [];
  const authFails = new Map();
  let lastSeenSave = 0;

  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  function prune(list) {
    const cutoff = now() - FAIL_WINDOW_MS;
    return list.filter((t) => t > cutoff);
  }

  function failCount(map, ip) {
    const list = prune(map.get(ip) || []);
    if (list.length) map.set(ip, list);
    else map.delete(ip);
    return list.length;
  }

  function noteFail(map, ip) {
    const list = prune(map.get(ip) || []);
    list.push(now());
    map.set(ip, list);
    if (map.size > 512) map.delete(map.keys().next().value);
  }

  function activePairing() {
    if (pairing && pairing.expiresAt <= now()) pairing = null;
    return pairing;
  }

  const state = {
    get enabled() {
      return data.enabled;
    },
    setEnabled(on) {
      data.enabled = Boolean(on);
      if (!data.enabled) pairing = null;
      save();
    },
    devices() {
      return data.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }));
    },
    /** A fresh code for one phone; replaces any earlier code. */
    startPairing() {
      if (!data.enabled) throw new Error("Turn on Phone app first.");
      if (data.devices.length >= MAX_DEVICES) throw new Error(`Hog can pair ${MAX_DEVICES} phones at most. Remove one first.`);
      const code = newPairCode(rand);
      pairing = { hash: hashToken(code), display: formatCode(code), code, expiresAt: now() + PAIR_TTL_MS, tries: PAIR_TRIES };
      return { code: pairing.display, plain: code, expiresAt: pairing.expiresAt };
    },
    cancelPairing() {
      pairing = null;
    },
    pairingInfo() {
      const p = activePairing();
      return p ? { code: p.display, plain: p.code, expiresAt: p.expiresAt, tries: p.tries } : null;
    },
    /**
     * Trade a code for a device token. Errors carry .status (400/403/429).
     * Rate limits: 5 misses per IP and 20 overall per 10 minutes, and each
     * code dies after 5 misses.
     */
    pair({ code, name, ip }) {
      const peer = normalizeIp(ip);
      const err = (status, message) => Object.assign(new Error(message), { status });
      if (!data.enabled) throw err(403, "Phone app is off in hog.");
      globalFails = prune(globalFails);
      if (failCount(ipFails, peer) >= IP_FAIL_LIMIT || globalFails.length >= GLOBAL_FAIL_LIMIT) {
        throw err(429, "Too many wrong codes. Wait 10 minutes and make a new code in hog.");
      }
      const p = activePairing();
      const given = normalizeCode(code);
      const ok = p && given.length === 8 && sameHex(hashToken(given), p.hash);
      if (!ok) {
        noteFail(ipFails, peer);
        globalFails.push(now());
        if (p) {
          p.tries -= 1;
          if (p.tries <= 0) pairing = null;
        }
        throw err(403, p ? "That code is not right." : "No pairing code is active. Press Pair a phone in hog.");
      }
      pairing = null;
      if (data.devices.length >= MAX_DEVICES) throw err(400, `Hog can pair ${MAX_DEVICES} phones at most.`);
      const token = rand(32).toString("base64url");
      const device = { id: rand(8).toString("hex"), name: cleanDeviceName(name), hash: hashToken(token), createdAt: now(), lastSeenAt: now() };
      data.devices.push(device);
      save();
      return { token, device: { id: device.id, name: device.name } };
    },
    /** The device for a bearer token, or null. Repeated bad tokens from one IP get 429. */
    authenticate(token, ip) {
      const peer = normalizeIp(ip);
      if (failCount(authFails, peer) >= AUTH_FAIL_LIMIT) return { limited: true, device: null };
      const raw = String(token || "");
      if (raw.length < 20 || raw.length > 200) {
        noteFail(authFails, peer);
        return { limited: false, device: null };
      }
      const hash = hashToken(raw);
      const device = data.devices.find((d) => sameHex(d.hash, hash)) || null;
      if (!device) {
        noteFail(authFails, peer);
        return { limited: false, device: null };
      }
      device.lastSeenAt = now();
      if (now() - lastSeenSave > SEEN_SAVE_MS) {
        lastSeenSave = now();
        try { save(); } catch { /* lastSeen is best effort */ }
      }
      return { limited: false, device: { id: device.id, name: device.name } };
    },
    revoke(id) {
      const before = data.devices.length;
      data.devices = data.devices.filter((d) => d.id !== String(id));
      if (data.devices.length === before) throw new Error("That phone is not paired.");
      save();
    },
  };
  return state;
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    throw Object.assign(new Error("That request was not JSON."), { status: 400 });
  }
}

/** Why a request to the mobile listener is refused before routing, or "". */
export function mobileRequestProblem(req) {
  if (!mobilePeerAllowed(req.socket?.remoteAddress)) return "peer";
  // The phone app never sends Origin. A web page (even one on the tailnet)
  // always does on cross-origin requests, so refuse those outright.
  if (req.headers.origin !== undefined) return "origin";
  if (!mobileHostAllowed(req.headers.host)) return "host";
  return "";
}

/** Only the fields the phone shows; no keys, no command lines. */
export function mobileMiningView(status) {
  const s = status && typeof status === "object" ? status : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    ok: true,
    enabled: Boolean(s.enabled),
    network: String(s.miningNetwork || ""),
    networkLabel: String(s.miningNetworkLabel || ""),
    nodeTabConnected: Boolean(s.pageConnected),
    stratumListening: Boolean(s.stratumListening),
    synced: Boolean(s.synced),
    gate: String(s.gate || ""),
    height: num(s.height),
    nodeHeight: num(s.nodeHeight),
    tipHeight: num(s.tipHeight),
    jobs: num(s.jobs),
    shares: num(s.shares),
    blocks: num(s.blocks),
    rejected: num(s.rejected),
    stale: num(s.stale),
    pending: num(s.pending),
    miners: num(s.miners),
    address: String(s.address || ""),
    lastResult: String(s.lastResult || "").slice(0, 200),
    lastError: String(s.lastError || s.error || "").slice(0, 300),
    allowTailnet: Boolean(s.allowTailnet),
    workers: Array.isArray(s.workers)
      ? s.workers.slice(0, 64).map((w) => ({
        worker: String(w.worker || ""),
        remote: Boolean(w.remote),
        connected: num(w.connected),
        shares: num(w.shares),
        blocks: num(w.blocks),
        rejected: num(w.rejected),
        lastShareAt: num(w.lastShareAt),
        lastResult: String(w.lastResult || "").slice(0, 120),
      }))
      : [],
  };
}

/**
 * The mobile API request handler.
 * @param {{ state: ReturnType<typeof createMobileState>, files: any, mining: () => any,
 *   containers: (action: string, name?: string) => Promise<any>, info?: () => any }} deps
 */
export function createMobileApi({ state, files, mining, containers, info = () => ({}) }) {
  return async function handle(req, res) {
    const problem = mobileRequestProblem(req);
    if (problem === "peer") {
      req.socket.destroy();
      return;
    }
    if (problem) return sendJson(res, 403, { ok: false, error: "Only the Hog phone app can use this." });
    let url;
    try {
      url = new URL(req.url || "/", "http://hog.invalid");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Bad request" });
    }
    if (!url.pathname.startsWith(API_PREFIX)) return sendJson(res, 404, { ok: false, error: "Not found" });
    const route = url.pathname.slice(API_PREFIX.length);
    const method = String(req.method || "GET").toUpperCase();
    const peer = req.socket.remoteAddress;
    try {
      if (!state.enabled) return sendJson(res, 403, { ok: false, error: "Phone app is off in hog." });
      if (route === "ping" && method === "GET") return sendJson(res, 200, { ok: true, app: "hog", api: 1 });
      if (route === "pair" && method === "POST") {
        const body = await readJson(req);
        const result = state.pair({ code: body.code, name: body.name, ip: peer });
        return sendJson(res, 200, { ok: true, ...result, hog: info() });
      }
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const auth = state.authenticate(token, peer);
      if (auth.limited) return sendJson(res, 429, { ok: false, error: "Too many bad sign-ins. Wait 10 minutes." });
      if (!auth.device) return sendJson(res, 401, { ok: false, error: "This phone is not paired with hog (or was removed). Pair it again." });

      if (route === "session" && method === "GET") return sendJson(res, 200, { ok: true, device: auth.device, hog: info() });
      if (route === "mining" && method === "GET") return sendJson(res, 200, mobileMiningView(mining()));
      if (route === "containers" && method === "GET") return sendJson(res, 200, await containers("list"));
      if (route === "containers" && method === "POST") {
        const body = await readJson(req);
        const action = String(body.action || "");
        if (!CONTAINER_ACTIONS.has(action)) return sendJson(res, 400, { ok: false, error: "action must be start, stop or restart" });
        const name = String(body.name || "");
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) return sendJson(res, 400, { ok: false, error: "Use a plain container name." });
        return sendJson(res, 200, await containers(action, name));
      }
      if (route.startsWith("files/")) {
        const sub = route.slice("files/".length);
        const allowed = method === "GET" || method === "HEAD" ? FILE_GET.has(sub) : method === "PUT" ? sub === "upload" : method === "POST" ? FILE_POST.has(sub) : false;
        if (!allowed) return sendJson(res, 404, { ok: false, error: "Not found" });
        const inner = new URL(`/api/files/${sub}${url.search}`, "http://127.0.0.1");
        // No Origin header reaches here (refused above), so the Files rules
        // reduce to: no cross-site fetch metadata, and x-hog-files: 1 on changes.
        await handleFilesRequest(files, req, res, inner, { origin: "hog-mobile" });
        return;
      }
      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const status = Number(error?.status) || 400;
      return sendJson(res, status >= 400 && status < 600 ? status : 400, { ok: false, error: error instanceof Error ? error.message : "Request failed" });
    }
  };
}

/**
 * The listener: 127.0.0.1 plus each tailnet address, re-checked every 30 s
 * so it follows Tailscale coming up later. Peers outside loopback and the
 * tailnet ranges are dropped at connect.
 */
export function createMobileListener({ handler, findTailnet = tailnetAddresses, loopback = "127.0.0.1", reconcileMs = RECONCILE_MS } = {}) {
  const servers = new Map();
  let port = 0;
  let wanted = 0;
  let timer = null;
  let error = "";
  let refused = 0;

  function make() {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Request failed" });
        else res.destroy();
      });
    });
    server.on("connection", (socket) => {
      if (!mobilePeerAllowed(socket.remoteAddress)) {
        refused += 1;
        socket.destroy();
      }
    });
    server.requestTimeout = 0; // uploads can be slow over mobile data
    server.headersTimeout = 30_000;
    return server;
  }

  function listenOn(host, listenPort) {
    const server = make();
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: listenPort, host, ipv6Only: host.includes(":") }, () => {
        server.removeAllListeners("error");
        server.on("error", () => {});
        resolve(server);
      });
    });
  }

  async function sync() {
    if (!wanted && !servers.size) return;
    const want = findTailnet().map((a) => a.address);
    for (const [host, srv] of servers) {
      if (host !== loopback && !want.includes(host)) {
        srv.close();
        servers.delete(host);
      }
    }
    const problems = [];
    for (const host of want) {
      if (servers.has(host)) continue;
      try {
        servers.set(host, await listenOn(host, port));
      } catch (e) {
        problems.push(`${host}: ${e?.code === "EADDRINUSE" ? `port ${port} is in use` : e?.code || e?.message || e}`);
      }
    }
    error = problems.length ? `Could not listen on the tailnet (${problems.join("; ")})` : want.length ? "" : "No Tailscale address on this computer yet. Start the tailscale container and sign in.";
  }

  return {
    async start(listenPort = DEFAULT_MOBILE_PORT) {
      if (servers.has(loopback)) {
        await sync();
        return port;
      }
      wanted = 1;
      const first = await listenOn(loopback, listenPort);
      servers.set(loopback, first);
      const address = first.address();
      port = typeof address === "object" && address ? address.port : listenPort;
      await sync();
      timer = setInterval(() => sync().catch(() => {}), reconcileMs);
      timer.unref?.();
      return port;
    },
    async stop() {
      wanted = 0;
      clearInterval(timer);
      timer = null;
      const all = [...servers.values()];
      servers.clear();
      port = 0;
      error = "";
      await Promise.all(all.map((srv) => new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      })));
    },
    sync,
    status() {
      return { listening: servers.size > 0, port, hosts: [...servers.keys()], tailnetHosts: [...servers.keys()].filter((h) => h !== loopback), error, refused };
    },
  };
}
