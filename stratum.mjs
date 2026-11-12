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
// /chain/mine answers in well under a second; a poll that hangs longer keeps
// miners on stale work, so give up quickly and poll again.
const TEMPLATE_TIMEOUT_MS = 5_000;
// POST /chain/append normally answers in under half a second. If the node tab
// has not answered by then, the block may still have landed: it is "pending"
// and gets checked against the node's chain instead of being called rejected.
const APPEND_TIMEOUT_MS = 20_000;
const RECONCILE_MS = 3_000;
// Stop checking a pending block after this long and count it as rejected.
const RECONCILE_GIVE_UP_MS = 10 * 60_000;
// Answer BzMiner by then even if the chain has not settled a pending block yet.
const MINER_REPLY_MS = 60_000;

// ---------- Ready gate: no work until the node has really caught up ----------
// A node's own "synced" flag is not enough: a fresh node can say synced:true
// at height 1 before it has heard of any peer. Work starts only when the node
// says synced AND its height is close to the network tip seen elsewhere.
//
// READY_SLACK: how many blocks behind the best known tip still counts as caught
// up. Both networks average ~20 s blocks (last 500 blocks, Nov 2026: mainnet
// 21.4 s, DeFi testnet 20.0 s), with bursts of a few seconds. The public tip is
// re-read every TIP_REFRESH_MS (15 s) and can be a block or two ahead of what
// has reached the node tab over its one WebSocket peer, and short reorgs move
// the tip by a block or two. 5 blocks (~100 s) absorbs that, while a fresh or
// fallen-back node (thousands of blocks behind) stays gated. The node's own
// synced flag is still required, so a node inside the slack is following the
// tip, not syncing toward it.
export const READY_SLACK = 5;
// Hard floors: mainnet is past 5,285,000 (Nov 2026), so a mainnet node below
// 5,000,000 is not synced whatever it says. The DeFi testnet can be reset, so
// it gets no floor beyond "never at height 1".
export const HEIGHT_FLOORS = { mainnet: 5_000_000, defi: 0 };
const TIP_REFRESH_MS = 15_000;
// A public tip older than this (its node unreachable since) no longer counts.
const TIP_MAX_AGE_MS = 120_000;
// A caught-up node's own synced flag can flip to false for a poll or two as a
// new block arrives (seen in DeFi smoke). Within this grace Hog sends no new
// work but keeps miners on their current job; a fall-back (far behind the tip,
// or height 1) stops work at once.
const GATE_GRACE_MS = 10_000;

/**
 * Decide whether to hand out work for a /chain/mine template.
 * Tip sources, best first:
 *  - publicTip: the network's public node (Hog's own wallet backend for that
 *    network), read over HTTPS by Hog;
 *  - pinHeight: the signed checkpoint the in-tab node got from its peers (lags
 *    the tip by a few blocks, never ahead of it; 0 on a fresh node);
 *  - highWater: the highest height this node reached while mining here, so a
 *    fall-back or a reorg to a tiny height closes the gate even if every other
 *    source is unavailable;
 *  - floor: HEIGHT_FLOORS for the network.
 * With neither a public tip nor a peer checkpoint there is nothing to compare
 * against, so the gate stays closed rather than trust the node's own flag.
 * @param {{ synced: boolean, templateHeight: number, publicTip?: number, pinHeight?: number, highWater?: number, floor?: number, slack?: number }} input
 * @returns {{ open: boolean, nodeHeight: number, tipHeight: number, reason: string }}
 */
export function readyGate({ synced, templateHeight, publicTip = 0, pinHeight = 0, highWater = 0, floor = 0, slack = READY_SLACK }) {
  const nodeHeight = Number.isInteger(templateHeight) ? Math.max(0, templateHeight - 1) : 0;
  const tipHeight = Math.max(publicTip || 0, pinHeight || 0, highWater || 0, floor || 0);
  const closed = (reason) => ({ open: false, nodeHeight, tipHeight, reason });
  if (!Number.isInteger(templateHeight) || templateHeight <= 1) return closed("fresh");
  if (synced !== true) return closed("syncing");
  if (!(publicTip > 0) && !(pinHeight > 0)) return closed("no-tip");
  if (floor > 0 && nodeHeight < floor) return closed("behind");
  if (pinHeight > 0 && nodeHeight < pinHeight) return closed("behind");
  if (nodeHeight < tipHeight - slack) return closed("behind");
  return { open: true, nodeHeight, tipHeight, reason: "" };
}

/** Height from a /chain/head answer (0.10.x nests it under chainHead, 0.9.x does not). */
export function headHeights(result) {
  const data = result && typeof result === "object" && result.data && typeof result.data === "object" ? result.data : null;
  if (!data) return { height: 0, pinHeight: 0 };
  const head = data.chainHead && typeof data.chainHead === "object" ? data.chainHead : data;
  const num = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  return { height: num(head.height), pinHeight: num(head.pinHeight) };
}

/** What Settings and the miner-facing error say while the gate is closed. */
export function gateMessage(gate, label) {
  const of = gate.tipHeight ? ` (height ${gate.nodeHeight.toLocaleString("en-US")} of ~${gate.tipHeight.toLocaleString("en-US")})` : gate.nodeHeight ? ` (height ${gate.nodeHeight.toLocaleString("en-US")})` : "";
  if (gate.reason === "no-tip") return `The ${label} node says it is synced${of}, but Hog cannot see the network tip yet to check; work starts once it can.`;
  return `The ${label} node is still syncing${of}; work starts when it has caught up.`;
}

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

/** A Warthog block hash: SHA-256 twice over the 80-byte header (core HeaderView::hash). */
export function blockHash(headerHex) {
  return sha256(sha256(Buffer.from(String(headerHex || ""), "hex"))).toString("hex");
}

/**
 * What a POST /chain/append reply says about the block.
 * "unknown" means the node tab never answered (or lost the answer), so the
 * block may or may not be on chain; it is settled against the chain later.
 * @returns {{ kind: "won" | "rejected" | "unknown", message: string, stale?: boolean }}
 */
export function appendOutcome(reply) {
  if (reply?.ok) {
    const result = reply.result;
    // POST /chain/append answers {"code":0,"error":"No error"}. A code-0 answer
    // that carries data is some other request's answer: check the chain instead.
    if (result && result.code === 0 && result.data != null) return { kind: "unknown", message: "Node tab: unexpected answer" };
    if (result && result.code === 0) return { kind: "won", message: "" };
    const message = String(result?.error || "Rejected");
    return { kind: "rejected", message, stale: /deprecated/i.test(message) };
  }
  const code = reply?.code || "no answer";
  // The block reached the node tab but its answer did not come back.
  if (code === "timeout" || code === "page-closed" || code === "node-error") {
    return { kind: "unknown", message: `Node tab: ${code}${reply?.error ? ` (${reply.error})` : ""}` };
  }
  return { kind: "rejected", message: `Node tab: ${code}` };
}

/**
 * @param {{
 *   call: (method: string, path: string, body?: string, network?: string, options?: { timeoutMs?: number, onLate?: (reply: any) => void }) => Promise<any>,
 *   getNetwork?: () => ({ key: string, page: string, label: string, lengthPrefixedBody: boolean } | null),
 *   host?: string,
 *   pollMs?: number,
 * }} options
 */
export function createStratumBridge({
  call,
  getNetwork = () => MINING_NETWORKS.defi,
  host = "127.0.0.1",
  pollMs = POLL_MS,
  findTailnet = tailnetAddresses,
  templateTimeoutMs = TEMPLATE_TIMEOUT_MS,
  appendTimeoutMs = APPEND_TIMEOUT_MS,
  reconcileMs = RECONCILE_MS,
  reconcileGiveUpMs = RECONCILE_GIVE_UP_MS,
  minerReplyMs = MINER_REPLY_MS,
  getPublicTip = async () => 0,
  tipRefreshMs = TIP_REFRESH_MS,
  slack = READY_SLACK,
  gateGraceMs = GATE_GRACE_MS,
}) {
  let server = null;
  /** network key -> { publicTip, publicAt, pinHeight, pinAt, highWater, refreshing, refreshedAt } */
  const tips = new Map();
  let gateOpen = false;
  let closedSince = 0;
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
  // blocks: on chain (the node accepted it, or the chain shows it). rejected:
  // not on chain, of which stale: that height was already taken. pending:
  // the node tab has not answered yet; checked against the chain.
  // synced: the ready gate is open (node synced and caught up with the tip).
  // nodeHeight / tipHeight: what the gate last compared ("height X of ~Y").
  const stats = { jobs: 0, shares: 0, blocks: 0, rejected: 0, stale: 0, pending: 0, height: 0, lastResult: "", lastError: "", synced: false, miningNetwork: "", nodeHeight: 0, tipHeight: 0, gate: "" };
  /** @type {Set<any>} submitted blocks whose fate is not known yet */
  const pendingShares = new Set();
  let reconcileTimer = null;

  function workerFor(socket) {
    const name = socket.account?.worker || "";
    const key = `${name}|${socket.peer}`;
    let w = workers.get(key);
    if (!w) {
      w = { worker: name, address: socket.account?.address || "", source: socket.peer, remote: !isLoopback(socket.peer), connected: 0, shares: 0, blocks: 0, rejected: 0, pending: 0, lastShareAt: 0, lastResult: "" };
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

  function tipState(key) {
    let t = tips.get(key);
    if (!t) {
      t = { publicTip: 0, publicAt: 0, pinHeight: 0, highWater: 0, refreshing: false, refreshedAt: 0 };
      tips.set(key, t);
    }
    return t;
  }

  /** Re-read the public tip and the node's signed checkpoint (rate limited). */
  async function refreshTips(net) {
    const t = tipState(net.key);
    if (t.refreshing || Date.now() - t.refreshedAt < tipRefreshMs) return;
    t.refreshing = true;
    try {
      const [pub, head] = await Promise.all([
        Promise.resolve().then(() => getPublicTip(net.key)).catch(() => 0),
        call("GET", "/chain/head", undefined, net.page, { timeoutMs: templateTimeoutMs }).catch(() => null),
      ]);
      if (Number.isInteger(pub) && pub > 0) {
        t.publicTip = pub;
        t.publicAt = Date.now();
      }
      if (head?.ok) t.pinHeight = headHeights(head.result).pinHeight;
      t.refreshedAt = Date.now();
    } finally {
      t.refreshing = false;
    }
  }

  /** Gate a template for a network, from what Hog knows about the tip. */
  function gateFor(data, net) {
    const t = tipState(net.key);
    const fresh = t.publicAt && Date.now() - t.publicAt < TIP_MAX_AGE_MS;
    return readyGate({
      synced: data?.synced === true,
      templateHeight: data?.height,
      publicTip: fresh ? t.publicTip : 0,
      pinHeight: t.pinHeight,
      highWater: t.highWater,
      floor: HEIGHT_FLOORS[net.key] || 0,
      slack,
    });
  }

  /**
   * The node is not (or no longer) caught up: drop every job and, if miners
   * had work, disconnect them so they stop hashing it. They reconnect at once
   * and get no job until the gate opens again.
   */
  function closeGate(entry, gate, net) {
    const hadWork = Boolean(entry.last || entry.jobs.size);
    entry.jobs.clear();
    entry.last = null;
    entry.sentAt = 0;
    if (gateOpen || hadWork) {
      stats.lastResult = `Stopped work: the ${net.label} node fell behind${gate.tipHeight ? ` (height ${gate.nodeHeight} of ~${gate.tipHeight})` : ""}. Miners wait until it catches up.`;
    }
    gateOpen = false;
    if (hadWork) for (const socket of entry.sockets) socket.end();
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
        gateOpen = false;
      }
      const t = tipState(net.key);
      // The first check waits for the tip; later ones refresh in the background.
      if (!t.refreshedAt) await refreshTips(net);
      else refreshTips(net).catch(() => {});
      const reply = await call("GET", `/chain/mine/${address}`, undefined, net.page, { timeoutMs: templateTimeoutMs });
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
      const gate = gateFor(data, net);
      stats.nodeHeight = gate.nodeHeight;
      stats.tipHeight = gate.tipHeight;
      stats.gate = gate.open ? "open" : gate.reason;
      if (!gate.open) {
        if (!closedSince) closedSince = Date.now();
        const fellBack = gate.reason === "behind" || gate.reason === "fresh";
        if (gateOpen && !fellBack && Date.now() - closedSince < gateGraceMs) {
          // A blip at the tip: no new work this poll, miners keep their job.
          return;
        }
        stats.synced = false;
        stats.lastError = gateMessage(gate, net.label);
        closeGate(entry, gate, net);
        return;
      }
      closedSince = 0;
      stats.synced = true;
      gateOpen = true;
      if (gate.nodeHeight > t.highWater) t.highWater = gate.nodeHeight;
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

  /**
   * For the HTTP relay (GET /chain/mine passthrough): null if the template may
   * go to a miner, else the reason it may not.
   * @param {any} result /chain/mine answer
   * @param {{ key: string, label: string, page: string } | null} net
   */
  function templateBlocked(result, net) {
    if (!net || !result?.data) return null;
    const gate = gateFor(result.data, net);
    if (gate.open) return null;
    refreshTips(net).catch(() => {});
    return gateMessage(gate, net.label);
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
    const share = {
      socket, id, rig, job,
      worker: socket.account.worker,
      address: socket.account.address,
      hash: blockHash(block.header),
      at: Date.now(),
      pending: false, done: false, replied: false, checking: false, replyTimer: null,
    };
    const reply = await call("POST", "/chain/append", JSON.stringify({ ...block, worker: share.worker }), job.page, {
      timeoutMs: appendTimeoutMs,
      // A late answer settles a pending block at once (if the chain has not already).
      onLate: (late) => {
        const outcome = appendOutcome(late);
        if (outcome.kind !== "unknown") settle(share, outcome);
      },
    });
    const outcome = appendOutcome(reply);
    if (outcome.kind === "unknown") return hold(share, outcome.message);
    settle(share, outcome);
  }

  function label(job) {
    return MINING_NETWORKS[job.network]?.label || job.network;
  }

  function replyMiner(share, ok, message) {
    if (share.replied) return;
    share.replied = true;
    clearTimeout(share.replyTimer);
    send(share.socket, ok ? { id: share.id, result: true, error: null } : { id: share.id, result: null, error: [40, String(message), null] });
  }

  /** The node tab did not answer: keep the block pending and check the chain for it. */
  function hold(share, message) {
    share.pending = true;
    stats.pending += 1;
    share.rig.pending += 1;
    pendingShares.add(share);
    stats.lastResult = `Block ${share.job.height}: the node tab has not answered yet; checking the chain for it`;
    share.rig.lastResult = stats.lastResult;
    share.replyTimer = setTimeout(() => replyMiner(share, false, `${message}; still checking the chain`), minerReplyMs);
    share.replyTimer.unref?.();
    // A new tip may be waiting behind the slow answer.
    if (accounts.has(share.address)) poll(share.address);
  }

  /** @param {{ kind: "won" | "rejected", message: string, stale?: boolean, confirmed?: boolean }} outcome */
  function settle(share, outcome) {
    if (share.done) return;
    share.done = true;
    if (share.pending) {
      share.pending = false;
      stats.pending -= 1;
      share.rig.pending -= 1;
      pendingShares.delete(share);
    }
    const { job, rig } = share;
    const who = share.worker ? ` (${share.worker})` : "";
    if (outcome.kind === "won") {
      stats.blocks += 1;
      rig.blocks += 1;
      stats.lastResult = `${label(job)} block ${job.height} accepted${who}${outcome.confirmed ? ", confirmed on chain" : ""}`;
      rig.lastResult = `block ${job.height} accepted`;
      replyMiner(share, true);
      if (accounts.has(share.address)) poll(share.address);
      return;
    }
    stats.rejected += 1;
    rig.rejected += 1;
    if (outcome.stale) stats.stale += 1;
    stats.lastResult = outcome.stale
      ? `Block ${job.height} was stale (that height was already taken)`
      : `Block ${job.height} rejected: ${outcome.message}`;
    rig.lastResult = stats.lastResult;
    replyMiner(share, false, outcome.message);
  }

  /** Settle pending blocks by the hash the node's chain has at their height. */
  async function check(share) {
    if (share.done || share.checking) return;
    if (Date.now() - share.at > reconcileGiveUpMs) {
      settle(share, { kind: "rejected", message: "The node tab never answered and the chain does not show the block" });
      return;
    }
    share.checking = true;
    try {
      const reply = await call("GET", `/chain/block/${share.job.height}/hash`, undefined, share.job.page, { timeoutMs: templateTimeoutMs });
      const result = reply?.ok ? reply.result : null;
      const onChain = result && result.code === 0 && typeof result.data === "string" ? result.data.toLowerCase() : "";
      // No block at that height yet (or no answer): ask again next round.
      if (!onChain) return;
      if (onChain === share.hash) settle(share, { kind: "won", message: "", confirmed: true });
      else settle(share, { kind: "rejected", message: "Another block took that height", stale: true });
    } finally {
      share.checking = false;
    }
  }

  function reconcile() {
    for (const share of pendingShares) check(share).catch(() => {});
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
    reconcileTimer = setInterval(reconcile, reconcileMs);
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
    clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const share of pendingShares) clearTimeout(share.replyTimer);
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
      pendingBlocks: [...pendingShares].map((s) => ({ height: s.job.height, worker: s.worker, since: s.at })),
    };
  }

  return { start, stop, status, setTailnet, reconcile, templateBlocked };
}
