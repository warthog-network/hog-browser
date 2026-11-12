import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { WebSocket } from "ws";
import { HEIGHT_FLOORS, READY_SLACK, createStratumBridge, gateMessage, headHeights, readyGate } from "../stratum.mjs";
import { MINING_NETWORKS, MINING_WS_PATH, createMiningRelay } from "../mining.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/template-defi.json", import.meta.url), "utf8"));
const MAINNET = JSON.parse(readFileSync(new URL("./fixtures/template-mainnet.json", import.meta.url), "utf8"));
const TIP = TEMPLATE.height - 1; // network tip when the template is current
const at = (height, extra = {}) => ({ ...TEMPLATE, height, ...extra });

test("ready gate: a fresh node saying synced at height 1 gets no work", () => {
  // Template height is the next block: 2 means the node's chain is 1 block long.
  const fresh = readyGate({ synced: true, templateHeight: 2, publicTip: TIP });
  assert.equal(fresh.open, false);
  assert.equal(fresh.reason, "behind");
  assert.deepEqual([fresh.nodeHeight, fresh.tipHeight], [1, TIP]);
  // Never a job at height <= 1, whatever the tip sources say.
  assert.equal(readyGate({ synced: true, templateHeight: 1, publicTip: 0, pinHeight: 0 }).reason, "fresh");
  assert.equal(readyGate({ synced: true, templateHeight: 1, publicTip: 1 }).open, false);
  assert.equal(readyGate({ synced: true, templateHeight: undefined, publicTip: TIP }).open, false);
  // And with no tip source at all, the node's own flag is not trusted.
  assert.equal(readyGate({ synced: true, templateHeight: 2 }).reason, "no-tip");
  assert.match(gateMessage(fresh, "DeFi testnet"), /still syncing \(height 1 of ~52,138\)/);
});

test("ready gate: behind the tip stays closed, within the slack opens", () => {
  assert.equal(READY_SLACK, 5);
  const behind = readyGate({ synced: true, templateHeight: TIP - 100, publicTip: TIP });
  assert.deepEqual([behind.open, behind.reason], [false, "behind"]);
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 1 - READY_SLACK - 1, publicTip: TIP }).open, false);
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 1 - READY_SLACK, publicTip: TIP }).open, true);
  // Synced flag still required.
  assert.equal(readyGate({ synced: false, templateHeight: TIP + 1, publicTip: TIP }).reason, "syncing");
  // Below the node's own signed checkpoint is behind even without a public tip.
  assert.equal(readyGate({ synced: true, templateHeight: 100, pinHeight: TIP - 8 }).reason, "behind");
});

test("ready gate: a caught-up node opens (and may be a little ahead of a stale tip)", () => {
  const ok = readyGate({ synced: true, templateHeight: TIP + 1, publicTip: TIP, pinHeight: TIP - 8, highWater: TIP - 1 });
  assert.deepEqual(ok, { open: true, nodeHeight: TIP, tipHeight: TIP, reason: "" });
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 4, publicTip: TIP }).open, true);
});

test("ready gate: tip source unavailable falls back to the peer checkpoint, else stays closed", () => {
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 1, publicTip: 0, pinHeight: 0 }).reason, "no-tip");
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 1, publicTip: 0, pinHeight: TIP - 8 }).open, true);
  // High water alone (no live source) does not open it, but it does close it on a fall-back.
  assert.equal(readyGate({ synced: true, templateHeight: TIP + 1, highWater: TIP }).open, false);
  assert.equal(readyGate({ synced: true, templateHeight: 40, pinHeight: 30, highWater: TIP }).reason, "behind");
  // Mainnet's floor: a "synced" mainnet node far below it is behind.
  const floor = HEIGHT_FLOORS.mainnet;
  assert.equal(readyGate({ synced: true, templateHeight: 1000, pinHeight: 999, floor }).reason, "behind");
  assert.equal(readyGate({ synced: true, templateHeight: MAINNET.height, pinHeight: MAINNET.height - 1, floor }).open, true);
  assert.equal(HEIGHT_FLOORS.defi, 0, "the DeFi testnet can be reset, so no hard floor");
  assert.match(gateMessage({ open: false, nodeHeight: TIP, tipHeight: TIP, reason: "no-tip" }, "DeFi testnet"), /cannot see the network tip/);
});

test("head heights read 0.10.x (chainHead) and 0.9.x (flat) answers", () => {
  assert.deepEqual(headHeights({ code: 0, data: { chainHead: { height: 53256, pinHeight: 53248 }, synced: true } }), { height: 53256, pinHeight: 53248 });
  assert.deepEqual(headHeights({ code: 0, data: { height: 5285952, pinHeight: 5285952, synced: true } }), { height: 5285952, pinHeight: 5285952 });
  assert.deepEqual(headHeights({ code: 56, error: "Not found" }), { height: 0, pinHeight: 0 });
  assert.deepEqual(headHeights(null), { height: 0, pinHeight: 0 });
});

function client(port) {
  const socket = connect(port, "127.0.0.1");
  const lines = [];
  let buf = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  socket.on("close", () => { closed = true; });
  async function next(pred, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out waiting for a stratum message");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return {
    socket, next, lines,
    get closed() { return closed; },
    send: (m) => socket.write(`${JSON.stringify(m)}\n`),
    ready: new Promise((r) => socket.once("connect", r)),
  };
}

async function miner(port) {
  const c = client(port);
  await c.ready;
  c.send({ id: 1, method: "mining.subscribe", params: [] });
  c.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.rig1`, ""] });
  await c.next((m) => m.id === 2);
  return c;
}

/** A node tab whose template, head and the public tip the test controls. */
function fakeNetwork({ template, publicTip, pinHeight = 0 }) {
  const state = { template, publicTip, pinHeight, gets: [] };
  const call = async (method, path) => {
    state.gets.push(path);
    if (method === "GET" && path === "/chain/head") {
      return { ok: true, result: { code: 0, data: { chainHead: { height: state.template.height - 1, pinHeight: state.pinHeight }, synced: state.template.synced } } };
    }
    if (method === "GET") return { ok: true, result: { code: 0, data: state.template } };
    return { ok: true, result: { code: 0, error: "No error" } };
  };
  return { state, call, getPublicTip: async () => state.publicTip };
}

test("stratum: no job for a fresh synced:true node at height 1, then work once it catches up", async () => {
  const net = fakeNetwork({ template: at(2, { synced: true }), publicTip: TIP });
  const bridge = createStratumBridge({ call: net.call, getPublicTip: net.getPublicTip, pollMs: 30, tipRefreshMs: 30 });
  const port = await bridge.start(0);
  const c = await miner(port);
  try {
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(c.lines.filter((m) => m.method === "mining.notify").length, 0, "no height-1 work");
    let state = bridge.status();
    assert.equal(state.synced, false);
    assert.equal(state.gate, "behind");
    assert.deepEqual([state.nodeHeight, state.tipHeight], [1, TIP]);
    assert.match(state.lastError, /height 1 of ~52,138/);
    assert.equal(state.jobs, 0);
    // Still behind by more than the slack.
    net.state.template = at(TIP - 50, { synced: true });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.lines.filter((m) => m.method === "mining.notify").length, 0);
    assert.equal(bridge.status().nodeHeight, TIP - 51);
    // Caught up.
    net.state.template = at(TIP + 1, { synced: true });
    const notify = await c.next((m) => m.method === "mining.notify");
    assert.equal(notify.params[1], TEMPLATE.header.slice(0, 64));
    state = bridge.status();
    assert.equal(state.synced, true);
    assert.equal(state.gate, "open");
    assert.equal(state.lastError, "");
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("stratum: with no tip source the node's own synced flag does not open the gate", async () => {
  const net = fakeNetwork({ template: at(TIP + 1, { synced: true }), publicTip: 0, pinHeight: 0 });
  net.getPublicTip = async () => { throw new Error("offline"); };
  const bridge = createStratumBridge({ call: net.call, getPublicTip: net.getPublicTip, pollMs: 30, tipRefreshMs: 30 });
  const port = await bridge.start(0);
  const c = await miner(port);
  try {
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(c.lines.filter((m) => m.method === "mining.notify").length, 0);
    assert.equal(bridge.status().gate, "no-tip");
    assert.match(bridge.status().lastError, /cannot see the network tip/);
    // The node's signed checkpoint from its peers is enough.
    net.state.pinHeight = TIP - 8;
    await c.next((m) => m.method === "mining.notify");
    assert.equal(bridge.status().synced, true);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("stratum: a fall-back mid-mining stops work, drops the jobs and gives none until caught up", async () => {
  const net = fakeNetwork({ template: at(TIP + 1, { synced: true }), publicTip: TIP });
  const bridge = createStratumBridge({ call: net.call, getPublicTip: net.getPublicTip, pollMs: 30, tipRefreshMs: 30 });
  const port = await bridge.start(0);
  const c = await miner(port);
  let again;
  try {
    const job = await c.next((m) => m.method === "mining.notify");
    // The node falls back to a tiny height but still claims synced, and the public node is now unreachable.
    net.state.publicTip = 0;
    net.state.template = at(2, { synced: true });
    const end = Date.now() + 2000;
    while (!c.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.closed, true, "miners holding work are disconnected so they stop hashing it");
    const state = bridge.status();
    assert.equal(state.synced, false);
    assert.equal(state.nodeHeight, 1);
    assert.match(state.lastResult, /fell behind/);
    // The rig reconnects: no job, and its old work is gone.
    again = await miner(port);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(again.lines.filter((m) => m.method === "mining.notify").length, 0);
    again.send({ id: 9, method: "mining.submit", params: [job.params[0], "000000000001", job.params[5], "00000001"] });
    assert.equal((await again.next((m) => m.id === 9)).error[0], 21);
    assert.equal(again.closed, false, "a waiting rig stays connected");
    // Caught up again: work resumes.
    net.state.template = at(TIP + 1, { synced: true });
    await again.next((m) => m.method === "mining.notify");
  } finally {
    c.socket.destroy();
    again?.socket.destroy();
    await bridge.stop();
  }
});

test("stratum: a brief synced:false blip at the tip keeps miners on their job; a lasting one stops work", async () => {
  const net = fakeNetwork({ template: at(TIP + 1, { synced: true }), publicTip: TIP });
  const bridge = createStratumBridge({ call: net.call, getPublicTip: net.getPublicTip, pollMs: 30, tipRefreshMs: 30, gateGraceMs: 400 });
  const port = await bridge.start(0);
  const c = await miner(port);
  try {
    await c.next((m) => m.method === "mining.notify");
    net.state.template = at(TIP + 1, { synced: false });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.closed, false, "no disconnect for a blip");
    assert.equal(bridge.status().synced, true);
    net.state.template = at(TIP + 1, { synced: true });
    await new Promise((r) => setTimeout(r, 100));
    net.state.template = at(TIP + 1, { synced: false });
    const end = Date.now() + 2000;
    while (!c.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.closed, true, "a lasting loss of sync stops work");
    assert.equal(bridge.status().synced, false);
    assert.match(bridge.status().lastError, /still syncing \(height 52,138 of ~52,138\)/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("HTTP relay withholds a template while the gate is closed", async () => {
  const site = createServer((_req, res) => res.end("site"));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const pageOrigin = `http://localhost:${site.address().port}`;
  const token = "b".repeat(48);
  let blocked = "The DeFi testnet node is still syncing (height 1 of ~52,138); work starts when it has caught up.";
  const relay = createMiningRelay({ token, pageOrigin, timeoutMs: 500, checkTemplate: () => blocked });
  site.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await relay.start(0);
  const ws = new WebSocket(`ws://127.0.0.1:${site.address().port}${MINING_WS_PATH}`, { origin: pageOrigin });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", token }));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.type === "rpc") ws.send(JSON.stringify({ type: "rpc-result", id: m.id, network: "defi", ok: true, result: { code: 0, data: at(2, { synced: true }) } }));
  });
  await new Promise((r) => setTimeout(r, 50));
  const get = () => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/chain/mine/${ADDRESS}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const res = await get();
    assert.equal(res.status, 503);
    assert.match(JSON.parse(res.text).error, /height 1 of ~52,138/);
    blocked = null;
    assert.equal((await get()).status, 200);
  } finally {
    ws.close();
    await relay.close();
    await new Promise((r) => site.close(r));
  }
});

test("server wires the ready gate into stratum and the HTTP relay", () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /getPublicTip: publicTipHeight/);
  assert.match(source, /checkTemplate: \(result\) => STRATUM\.templateBlocked\(result, currentMiningNetwork\(\)\)/);
  assert.ok(MINING_NETWORKS.defi && MINING_NETWORKS.mainnet);
});
