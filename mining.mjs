// Solo mining relay: BzMiner (HTTP solo mode) -> Hog -> in-page WASM node.
//
// BzMiner speaks the native Warthog node API: GET /chain/mine/:account for a
// block template and POST /chain/append to submit a solved block. A web page
// cannot open a port, so Hog opens one on 127.0.0.1 and relays exactly those
// two calls over a WebSocket to the browser-node page, which answers through
// window.wartNode.virtual_get / virtual_post.
//
// Security:
// - The listener binds 127.0.0.1 only and is off until the user turns it on.
// - Only the two mining routes exist. Requests that carry a browser Origin or
//   Sec-Fetch-Site header, or a Host other than 127.0.0.1/localhost, are
//   refused, so web pages (and DNS rebinding) cannot drive it.
// - The relay WebSocket accepts only the node page origin and a random token
//   minted at start and injected only into that page.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export const MINING_WS_PATH = "/__hog/mining";
export const DEFAULT_MINING_PORT = 3100;
export const MINING_NETWORK = "defi";
const MAX_APPEND_BODY = 256_000;
const HELLO_MS = 5000;

const ACCOUNT_RE = /^[0-9a-fA-F]{48}$/;

/** @param {string} value */
export function isMiningAccount(value) {
  return ACCOUNT_RE.test(String(value || ""));
}

/** @param {string|undefined} raw */
export function miningPort(raw = process.env.HOG_MINING_PORT) {
  if (raw == null || raw === "") return DEFAULT_MINING_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HOG_MINING_PORT must be a port number (got ${raw})`);
  }
  return port;
}

/**
 * @param {string} method
 * @param {string} rawUrl
 * @returns {{ kind: "mine", path: string } | { kind: "append", path: string } | null}
 */
export function miningRoute(method, rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl || "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (method === "GET") {
    const match = /^\/chain\/mine\/([^/]+)$/.exec(clean);
    if (match && isMiningAccount(match[1])) return { kind: "mine", path: `/chain/mine/${match[1]}` };
    return null;
  }
  if (method === "POST" && clean === "/chain/append") return { kind: "append", path: "/chain/append" };
  return null;
}

/** BzMiner command shown in Settings: stratum to Hog's local stratum port. */
export function bzminerCommand(port = 3456, wallet = "<48-hex-wallet>", worker = "rig1") {
  return `./bzminer -a warthog -p stratum+tcp://127.0.0.1:${port} -w ${wallet} --worker ${worker}`;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// Loopback Host only (blocks DNS rebinding). Miners vary: BzMiner sends the
// host without a port, some send none at all; browsers always send one.
function hostOk(hostHeader, port) {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (!raw) return true;
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    if (raw === name || raw === `${name}:${port}`) return true;
  }
  return false;
}

function json(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

/**
 * Script injected into the browser-node page only. It dials back to Hog on
 * the page's own origin and answers relay requests with virtual_get/post.
 * @param {string} token
 */
export function pageRelayScript(token) {
  return `(function () {
  if (window.__hogMiningRelay) return;
  window.__hogMiningRelay = true;
  var TOKEN = ${JSON.stringify(String(token))};
  var PATH = ${JSON.stringify(MINING_WS_PATH)};
  function network() {
    try {
      var names = performance.getEntriesByType("resource").map(function (e) { return e.name; });
      for (var i = names.length - 1; i >= 0; i--) {
        if (/\\/node\\/defi\\/wart-node\\.js(\\?|$)/.test(names[i])) return "defi";
        if (/\\/node\\/wart-node\\.js(\\?|$)/.test(names[i])) return "official1";
      }
    } catch (e) {}
    return "";
  }
  function connect() {
    var ws;
    try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + PATH); }
    catch (e) { setTimeout(connect, 3000); return; }
    ws.onopen = function () { ws.send(JSON.stringify({ type: "hello", token: TOKEN })); };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg || msg.type !== "rpc") return;
      function reply(out) { out.type = "rpc-result"; out.id = msg.id; out.network = network(); try { ws.send(JSON.stringify(out)); } catch (e) {} }
      var mod = window.wartNode || window.Module;
      var net = network();
      if (msg.network && net && net !== msg.network) { reply({ ok: false, code: "wrong-network" }); return; }
      if (!mod || typeof mod.virtual_get !== "function" || typeof mod.virtual_post !== "function") { reply({ ok: false, code: "not-running" }); return; }
      if (msg.network && !net) { reply({ ok: false, code: "not-running" }); return; }
      // The node glue's virtual_post calls VIRTUALSTATE.postId, which the glue never
      // defines (virtual_get uses getId). Alias it so POST /chain/append can run.
      var vs = mod.VIRTUALSTATE;
      if (vs && typeof vs.postId !== "function" && typeof vs.getId === "function") vs.postId = vs.getId;
      var p;
      try {
        p = msg.method === "POST" ? mod.virtual_post(msg.path, String(msg.body || "")) : mod.virtual_get(msg.path);
      } catch (e) { reply({ ok: false, code: "node-error", error: String(e && e.message || e) }); return; }
      Promise.resolve(p).then(function (result) {
        reply({ ok: true, result: result });
      }, function (e) { reply({ ok: false, code: "node-error", error: String(e && e.message || e) }); });
    };
    ws.onclose = function () { setTimeout(connect, 3000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  connect();
})();`;
}

/**
 * @param {{ token: string, pageOrigin: string, network?: string, timeoutMs?: number, host?: string }} options
 */
export function createMiningRelay({ token, pageOrigin, network = MINING_NETWORK, timeoutMs = 15000, host = "127.0.0.1" }) {
  if (!token || String(token).length < 16) throw new Error("Mining relay needs a random token");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  let page = null;
  let pageNetwork = "";
  let seq = 0;
  const pending = new Map();
  let listener = null;
  let listenPort = 0;
  let lastError = "";
  const counters = { templates: 0, submits: 0 };

  function dropPage(socket) {
    if (page !== socket) return;
    page = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "page-closed" });
      pending.delete(id);
    }
  }

  /**
   * Handle an HTTP upgrade on the node page's server. Returns true if it was ours.
   */
  function handleUpgrade(req, socket, head) {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== MINING_WS_PATH) return false;
    if (String(req.headers.origin || "") !== pageOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      let trusted = false;
      const helloTimer = setTimeout(() => {
        if (!trusted) client.close(4401, "hello timeout");
      }, HELLO_MS);
      client.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!trusted) {
          if (msg?.type === "hello" && sameToken(msg.token, token)) {
            trusted = true;
            clearTimeout(helloTimer);
            if (page && page !== client) page.close(4000, "replaced");
            page = client;
          } else {
            clearTimeout(helloTimer);
            client.close(4401, "bad token");
          }
          return;
        }
        if (msg?.type !== "rpc-result") return;
        if (typeof msg.network === "string") pageNetwork = msg.network;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      });
      client.on("close", () => {
        clearTimeout(helloTimer);
        dropPage(client);
      });
      client.on("error", () => dropPage(client));
    });
    return true;
  }

  /** @returns {Promise<any>} reply from the page (or a synthetic not-ready reply) */
  function call(method, path, body) {
    if (!page || page.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, code: "no-page" });
    }
    const id = ++seq;
    return new Promise((resolve) => {
      // Appending a block makes the in-tab node verify and store it; give it longer.
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, code: "timeout" });
      }, method === "POST" ? timeoutMs * 3 : timeoutMs);
      pending.set(id, { resolve, timer });
      page.send(JSON.stringify({ type: "rpc", id, method, path, body, network }));
    });
  }

  const NOT_READY = {
    "no-page": "Hog's Warthog node tab is not open. Open the node tab, pick DeFi testnet, and start the node.",
    "not-running": "The Warthog node tab is open but the node is not running yet. Press Start in the node tab.",
    "wrong-network": `The node tab is running a different network. Switch it to ${network === "defi" ? "DeFi testnet" : network}.`,
    "page-closed": "The Warthog node tab closed while answering.",
    timeout: "The in-tab node did not answer within the time limit.",
    "node-error": "The in-tab node failed to answer.",
  };

  async function handleHttp(req, res) {
    const port = listenPort;
    if (!hostOk(req.headers.host, port)) return json(res, 403, { code: 403, error: "Host not allowed" });
    if (req.headers.origin || req.headers["sec-fetch-site"]) {
      return json(res, 403, { code: 403, error: "Browser requests are not allowed; this port is for a local miner" });
    }
    const route = miningRoute(req.method, req.url);
    if (!route) {
      req.resume();
      return json(res, 404, { code: 404, error: "Only GET /chain/mine/:account and POST /chain/append are served here" });
    }
    let body = "";
    if (route.kind === "append") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_APPEND_BODY) return json(res, 413, { code: 413, error: "Block body is too large" });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const reply = await call(route.kind === "append" ? "POST" : "GET", route.path, body);
    if (!reply.ok) {
      const status = reply.code === "timeout" ? 504 : reply.code === "node-error" ? 502 : 503;
      lastError = NOT_READY[reply.code] || "The node did not answer";
      return json(res, status, { code: status, error: lastError, ...(reply.error ? { detail: reply.error } : {}) });
    }
    lastError = "";
    if (route.kind === "append") counters.submits += 1;
    else counters.templates += 1;
    const text = typeof reply.result === "string" ? reply.result : JSON.stringify(reply.result ?? null);
    return json(res, 200, text);
  }

  async function start(port = DEFAULT_MINING_PORT) {
    if (listener) return listenPort;
    const server = createServer((req, res) => {
      handleHttp(req, res).catch((error) => {
        if (!res.headersSent) json(res, 500, { code: 500, error: error instanceof Error ? error.message : "Mining relay failed" });
        else res.end();
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeAllListeners("error");
        server.on("error", (error) => console.error(error instanceof Error ? error.message : error));
        resolve();
      });
    });
    listener = server;
    const address = server.address();
    listenPort = typeof address === "object" && address ? address.port : port;
    return listenPort;
  }

  function stop() {
    if (!listener) return Promise.resolve();
    const server = listener;
    listener = null;
    listenPort = 0;
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  function status() {
    return {
      listening: Boolean(listener),
      port: listenPort,
      pageConnected: Boolean(page && page.readyState === WebSocket.OPEN),
      pageNetwork,
      network,
      lastError,
      ...counters,
    };
  }

  async function close() {
    await stop();
    if (page) page.close(1001);
    wss.close();
  }

  return { token, handleUpgrade, call, start, stop, status, close };
}
