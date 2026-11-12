// Local stratum for solo mining: BzMiner (stratum+tcp) -> Hog -> in-tab node.
//
// BzMiner's solo mode for Warthog is stratum (the node's --stratum server); its
// HTTP mode does not speak the node's REST API. Hog speaks the same stratum
// dialect as the Warthog node (src/node/api/stratum in the core repo) and turns
// it into the two node calls the mining relay already carries over the page
// WebSocket: GET /chain/mine/:account for work and POST /chain/append for a
// solved block. The share difficulty is the network difficulty, so every
// accepted share is a block.
//
// Binds 127.0.0.1. With "Allow rigs on my tailnet" it also binds this
// computer's Tailscale addresses (never 0.0.0.0), and only accepts peers from
// loopback or the tailnet ranges. It is started and stopped with the mining relay.
import { createServer } from "node:net";
import { stratumPeerAllowed, tailnetAddresses, normalizeIp, isLoopback } from "./tailnet.mjs";
import { createHash, randomBytes } from "node:crypto";
import { MINING_NETWORKS } from "./mining.mjs";

export const DEFAULT_STRATUM_PORT = 3456;
const POLL_MS = 1000;
const MAX_LINE = 16_384;
const MAX_JOBS = 32;
// The template's timestamp moves every second; only re-send the same work this often.
const REFRESH_MS = 30_000;

/** @param {string|undefined} raw */
export function stratumPort(raw = process.env.HOG_STRATUM_PORT) {
  if (raw == null || raw === "") return DEFAULT_STRATUM_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HOG_STRATUM_PORT must be a port number (got ${raw})`);
  }
  return port;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest();

/** A Warthog address: 20 bytes then the first 4 bytes of their SHA-256. */
export function isWarthogAddress(value) {
  const text = String(value || "");
  if (!/^[0-9a-fA-F]{48}$/.test(text)) return false;
  const bytes = Buffer.from(text, "hex");
  return sha256(bytes.subarray(0, 20)).subarray(0, 4).equals(bytes.subarray(20));
}

/** "<address>[.<worker>]" as the Warthog node's stratum reads it. */
export function parseStratumUser(user) {
  const text = String(user || "");
  const dot = text.indexOf(".");
  const address = (dot < 0 ? text : text.slice(0, dot)).toLowerCase();
  const worker = dot < 0 ? "" : text.slice(dot + 1).slice(0, 64);
  return isWarthogAddress(address) ? { address, worker } : null;
}

function hexBytes(value, size) {
  const text = String(value || "");
  if (text.length !== size * 2 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

/**
 * Turn a /chain/mine template into a stratum job for one network.
 * @param {{ header: string, body: string, merklePrefix: string, height: number, difficulty: number }} t
 * @param {{ key: string, page: string, lengthPrefixedBody: boolean }} [network]
 */
export function jobFromTemplate(t, network = MINING_NETWORKS.defi) {
  const header = Buffer.from(String(t.header || ""), "hex");
  const body = Buffer.from(String(t.body || ""), "hex");
  const merklePrefix = Buffer.from(String(t.merklePrefix || ""), "hex");
  if (header.length !== 80 || body.length < 10 || !merklePrefix.length || !Number.isInteger(t.height)) {
    throw new Error("Bad mining template");
  }
  return {
    id: sha256(header).toString("hex"),
    network: network.key,
    page: network.page,
    lengthPrefixedBody: Boolean(network.lengthPrefixedBody),
    height: t.height,
    difficulty: Number(t.difficulty) || 1,
    header,
    body,
    merklePrefix,
    prevHash: header.subarray(0, 32).toString("hex"),
    nbits: header.subarray(32, 36).toString("hex"),
    version: header.subarray(68, 72).toString("hex"),
    ntime: header.subarray(72, 76).toString("hex"),
    // Same work, ignoring the timestamp: new tip, new transactions or new target change it.
    workKey: `${network.key}:${header.subarray(0, 36).toString("hex")}:${merklePrefix.toString("hex")}:${body.toString("hex")}`,
  };
}

/**
 * Apply a solution the way the node's stratum does: extranonce into the body,
 * merkle root = sha256(merklePrefix || body[0..10]) (testnet/new root), then
 * ntime and nonce into the header.
 */
export function solvedBlock(job, extra2prefix, extranonce2, ntime, nonce) {
  const body = Buffer.from(job.body);
  extra2prefix.copy(body, 0);
  extranonce2.copy(body, 4);
  const header = Buffer.from(job.header);
  sha256(Buffer.concat([job.merklePrefix, body.subarray(0, 10)])).copy(header, 36);
  ntime.copy(header, 72);
  nonce.copy(header, 76);
  // Node 0.10.x (DeFi testnet) reads the body as a length-prefixed blob (uint32,
  // big-endian); node 0.9.x (mainnet) reads raw hex.
  let out = body;
  if (job.lengthPrefixedBody) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    out = Buffer.concat([length, body]);
  }
  return { height: job.height, header: header.toString("hex"), body: out.toString("hex") };
}

/**
 * @param {{
 *   call: (method: string, path: string, body?: string, network?: string) => Promise<any>,
 *   getNetwork?: () => ({ key: string, page: string, label: string, lengthPrefixedBody: boolean } | null),
 *   host?: string,
 *   pollMs?: number,
 * }} options
 */
export function createStratumBridge({ call, getNetwork = () => MINING_NETWORKS.defi, host = "127.0.0.1", pollMs = POLL_MS, findTailnet = tailnetAddresses }) {
  let server = null;
  let listenPort = 0;
  let allowTailnet = false;
  /** @type {Map<string, any>} tailnet address -> net.Server */
  const tailnetServers = new Map();
  let tailnetError = "";
  let refused = 0;
  /** @type {Map<string, any>} per-rig stats, keyed by worker name and source address */
  const workers = new Map();
  let prefixCounter = randomBytes(4).readUInt32LE(0);
  /** @type {Map<string, { sockets: Set<any>, jobs: Map<string, any>, last: any, polling: boolean, timer: any }>} */
  const accounts = new Map();
  const sockets = new Set();
  const stats = { jobs: 0, shares: 0, blocks: 0, rejected: 0, height: 0, lastResult: "", lastError: "", synced: false, miningNetwork: "" };

  function workerFor(socket) {
    const name = socket.account?.worker || "";
    const key = `${name}|${socket.peer}`;
    let w = workers.get(key);
    if (!w) {
      w = { worker: name, address: socket.account?.address || "", source: socket.peer, remote: !isLoopback(socket.peer), connected: 0, shares: 0, blocks: 0, rejected: 0, lastShareAt: 0, lastResult: "" };
      workers.set(key, w);
      // Keep the list bounded: drop the oldest disconnected entries.
      if (workers.size > 64) {
        for (const [k, v] of workers) {
          if (!v.connected) { workers.delete(k); break; }
        }
      }
    }
    return w;
  }

  function send(socket, message) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }
  function notify(socket, job, clean) {
    send(socket, { id: null, method: "mining.set_difficulty", params: [job.difficulty] });
    send(socket, { id: null, method: "mining.notify", params: [job.id, job.prevHash, job.merklePrefix.toString("hex"), job.version, job.nbits, job.ntime, clean] });
  }

  async function poll(address) {
    const entry = accounts.get(address);
    if (!entry || entry.polling) return;
    entry.polling = true;
    try {
      const net = getNetwork();
      if (!net) {
        stats.lastError = "Start the node tab (Mainnet or DeFi testnet) so Hog knows which network to mine.";
        stats.synced = false;
        stats.miningNetwork = "";
        return;
      }
      if (stats.miningNetwork !== net.key) {
        stats.miningNetwork = net.key;
        stats.height = 0;
        stats.synced = false;
      }
      const reply = await call("GET", `/chain/mine/${address}`, undefined, net.page);
      const data = reply?.ok ? reply.result?.data : null;
      if (!reply?.ok) {
        stats.lastError = reply?.code === "no-page"
          ? "Open the DeFi testnet node tab and press Start node."
          : reply?.code === "not-running" ? "Press Start node in the node tab."
            : reply?.code === "wrong-network" ? `The node tab is not running ${net.label}. Switch it, or pick its network here.`
              : `Node tab: ${reply?.code || "no answer"}`;
        stats.synced = false;
        return;
      }
      if (!data) {
        stats.lastError = reply.result?.error || "The node has no mining work yet";
        stats.synced = false;
        return;
      }
      stats.synced = data.synced === true;
      if (!stats.synced) {
        stats.lastError = `The ${net.label} node is still syncing; work starts when it is synced.`;
        return;
      }
      stats.lastError = "";
      const job = jobFromTemplate(data, net);
      stats.height = job.height;
      if (entry.jobs.has(job.id)) return;
      if (entry.last && entry.last.workKey === job.workKey && Date.now() - entry.sentAt < REFRESH_MS) return;
      const clean = !entry.last || entry.last.prevHash !== job.prevHash || entry.last.network !== job.network;
      if (clean) entry.jobs.clear();
      entry.jobs.set(job.id, job);
      while (entry.jobs.size > MAX_JOBS) entry.jobs.delete(entry.jobs.keys().next().value);
      entry.last = job;
      entry.sentAt = Date.now();
      stats.jobs += 1;
      for (const socket of entry.sockets) notify(socket, job, clean || socket.fresh);
      for (const socket of entry.sockets) socket.fresh = false;
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      entry.polling = false;
    }
  }

  function link(socket, address) {
    let entry = accounts.get(address);
    if (!entry) {
      entry = { sockets: new Set(), jobs: new Map(), last: null, sentAt: 0, polling: false, timer: null };
      entry.timer = setInterval(() => poll(address), pollMs);
      accounts.set(address, entry);
    }
    entry.sockets.add(socket);
    if (entry.last) {
      notify(socket, entry.last, true);
      socket.fresh = false;
    }
    poll(address);
  }
  function unlink(socket) {
    const address = socket.account?.address;
    const entry = address ? accounts.get(address) : null;
    if (!entry) return;
    entry.sockets.delete(socket);
    if (!entry.sockets.size) {
      clearInterval(entry.timer);
      accounts.delete(address);
    }
  }

  async function submit(socket, id, params) {
    // The node reads [jobId, extranonce2, ntime, nonce]; pools put the worker first.
    const args = params.length >= 5 ? params.slice(1) : params;
    const [jobId, en2Hex, ntimeHex, nonceHex] = args.map((v) => String(v ?? ""));
    const entry = accounts.get(socket.account.address);
    const job = entry?.jobs.get(jobId);
    if (!job) return send(socket, { id, result: null, error: [21, "Job not found", null] });
    const en2 = hexBytes(en2Hex, 6);
    const ntime = hexBytes(ntimeHex, 4);
    const nonce = hexBytes(nonceHex, 4);
    if (!en2 || !ntime || !nonce) return send(socket, { id, result: null, error: [20, "Bad share format", null] });
    stats.shares += 1;
    const rig = workerFor(socket);
    rig.shares += 1;
    rig.lastShareAt = Date.now();
    const block = solvedBlock(job, socket.extra2prefix, en2, ntime, nonce);
    const reply = await call("POST", "/chain/append", JSON.stringify({ ...block, worker: socket.account.worker }), job.page);
    const result = reply?.ok ? reply.result : null;
    if (result && result.code === 0) {
      stats.blocks += 1;
      rig.blocks += 1;
      stats.lastResult = `${MINING_NETWORKS[job.network]?.label || job.network} block ${job.height} accepted${socket.account.worker ? ` (${socket.account.worker})` : ""}`;
      rig.lastResult = `block ${job.height} accepted`;
      send(socket, { id, result: true, error: null });
      poll(socket.account.address);
      return;
    }
    stats.rejected += 1;
    rig.rejected += 1;
    const message = result?.error || (reply?.ok ? "Rejected" : `Node tab: ${reply?.code || "no answer"}`);
    stats.lastResult = /deprecated/i.test(String(message))
      ? `Block ${job.height} was stale (that height was already taken)`
      : `Block ${job.height} rejected: ${message}`;
    rig.lastResult = stats.lastResult;
    send(socket, { id, result: null, error: [40, String(message), null] });
  }

  function onLine(socket, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    const id = Number.isInteger(msg?.id) ? msg.id : null;
    const params = Array.isArray(msg?.params) ? msg.params : [];
    if (msg?.method === "mining.subscribe") {
      return send(socket, { id, result: [["mining.notify", ""], socket.extra2prefix.toString("hex"), 6], error: null });
    }
    if (msg?.method === "mining.authorize") {
      const account = parseStratumUser(params[0]);
      if (!account) {
        send(socket, { id, result: null, error: [30, "User format must be <Address>[.<Workername>]", null] });
        socket.end();
        return;
      }
      if (socket.account) {
        unlink(socket);
        workerFor(socket).connected -= 1;
      }
      socket.account = account;
      workerFor(socket).connected += 1;
      send(socket, { id, result: true, error: null });
      link(socket, account.address);
      return;
    }
    if (msg?.method === "mining.submit") {
      if (!socket.account) {
        send(socket, { id, result: null, error: [24, "Unauthorized worker.", null] });
        socket.end();
        return;
      }
      submit(socket, id, params).catch((error) => {
        send(socket, { id, result: null, error: [40, error instanceof Error ? error.message : String(error), null] });
      });
      return;
    }
    // mining.extranonce.subscribe and friends: answer so miners do not stall.
    if (id != null) send(socket, { id, result: false, error: null });
  }

  function onConnection(socket) {
    socket.peer = normalizeIp(socket.remoteAddress);
    if (!stratumPeerAllowed(socket.peer, allowTailnet)) {
      refused += 1;
      socket.destroy();
      return;
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(prefixCounter >>> 0, 0);
    prefixCounter = (prefixCounter + 1) >>> 0;
    socket.extra2prefix = prefix;
    socket.fresh = true;
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) return socket.destroy();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) onLine(socket, line);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (socket.account) workerFor(socket).connected -= 1;
      unlink(socket);
    });
  }

  function listenOn(port, address) {
    const next = createServer(onConnection);
    return new Promise((resolve, reject) => {
      next.once("error", reject);
      next.listen({ port, host: address, ipv6Only: address.includes(":") }, () => {
        next.removeAllListeners("error");
        next.on("error", () => {});
        resolve(next);
      });
    });
  }

  /** Bind or unbind the tailnet addresses to match allowTailnet. */
  async function syncTailnet() {
    tailnetError = "";
    if (!server || !allowTailnet) {
      for (const srv of tailnetServers.values()) srv.close();
      tailnetServers.clear();
      return;
    }
    const want = findTailnet().map((a) => a.address);
    for (const [address, srv] of tailnetServers) {
      if (!want.includes(address)) {
        srv.close();
        tailnetServers.delete(address);
      }
    }
    if (!want.length) {
      tailnetError = "No Tailscale address on this computer. Start Tailscale (Hog: Tailscale page), then turn this on again.";
      return;
    }
    const problems = [];
    for (const address of want) {
      if (tailnetServers.has(address)) continue;
      try {
        tailnetServers.set(address, await listenOn(listenPort, address));
      } catch (error) {
        problems.push(`${address}: ${error?.code === "EADDRINUSE" ? `port ${listenPort} is in use` : error?.code || error?.message || error}`);
      }
    }
    if (problems.length) tailnetError = `Could not listen on the tailnet (${problems.join("; ")})`;
  }

  async function start(port = DEFAULT_STRATUM_PORT, options = {}) {
    if (options.tailnet !== undefined) allowTailnet = Boolean(options.tailnet);
    if (server) {
      await syncTailnet();
      return listenPort;
    }
    const next = await listenOn(port, host);
    server = next;
    const address = next.address();
    listenPort = typeof address === "object" && address ? address.port : port;
    await syncTailnet();
    return listenPort;
  }

  /** Turn "Allow rigs on my tailnet" on or off; takes effect now if running. */
  async function setTailnet(on) {
    allowTailnet = Boolean(on);
    if (!allowTailnet) {
      for (const socket of sockets) if (!isLoopback(socket.peer)) socket.destroy();
    }
    await syncTailnet();
  }

  function stop() {
    for (const entry of accounts.values()) clearInterval(entry.timer);
    accounts.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const srv of tailnetServers.values()) srv.close();
    tailnetServers.clear();
    if (!server) return Promise.resolve();
    const current = server;
    server = null;
    listenPort = 0;
    return new Promise((resolve) => current.close(() => resolve()));
  }

  function status() {
    let miners = 0;
    for (const entry of accounts.values()) miners += entry.sockets.size;
    return {
      stratumListening: Boolean(server),
      stratumPort: listenPort,
      stratumHosts: server ? [host, ...tailnetServers.keys()] : [],
      allowTailnet,
      tailnetListening: [...tailnetServers.keys()],
      tailnetError,
      refused,
      miners,
      accounts: [...accounts.keys()],
      workers: [...workers.values()].map((w) => ({ ...w, connected: Math.max(0, w.connected) })),
      ...stats,
    };
  }

  return { start, stop, status, setTailnet };
}
