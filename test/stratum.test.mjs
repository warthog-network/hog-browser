import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  appendOutcome,
  blockHash,
  createStratumBridge,
  isWarthogAddress,
  jobFromTemplate,
  parseStratumUser,
  solvedBlock,
  stratumPort,
} from "../stratum.mjs";
import { bzminerCommand } from "../mining.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
// A real DeFi testnet /chain/mine template (height 52139) from the in-tab node.
const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/template-defi.json", import.meta.url), "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest();

test("Warthog addresses need 48 hex characters and a valid checksum", () => {
  assert.equal(isWarthogAddress(ADDRESS), true);
  assert.equal(isWarthogAddress(ADDRESS.toUpperCase()), true);
  assert.equal(isWarthogAddress(`${ADDRESS.slice(0, 47)}0`), false);
  assert.equal(isWarthogAddress(ADDRESS.slice(0, 46)), false);
  assert.equal(isWarthogAddress(`${ADDRESS.slice(0, 47)}g`), false);
  assert.deepEqual(parseStratumUser(`${ADDRESS}.rig1`), { address: ADDRESS, worker: "rig1" });
  assert.deepEqual(parseStratumUser(ADDRESS), { address: ADDRESS, worker: "" });
  assert.equal(parseStratumUser("rig1"), null);
});

test("stratum port defaults to 3456 and BzMiner gets a stratum command", () => {
  assert.equal(stratumPort(undefined), 3456);
  assert.equal(stratumPort("3466"), 3466);
  assert.throws(() => stratumPort("nope"), /HOG_STRATUM_PORT/);
  assert.equal(bzminerCommand(3456, ADDRESS), `./bzminer -a warthog -p stratum+tcp://127.0.0.1:3456 -w ${ADDRESS} -r rig1`);
});

test("jobs carry the same fields as the Warthog node's mining.notify", () => {
  const job = jobFromTemplate(TEMPLATE);
  assert.equal(job.prevHash, TEMPLATE.header.slice(0, 64));
  assert.equal(job.nbits, "0762d2ef");
  assert.equal(job.version, "00000004");
  assert.equal(job.ntime, TEMPLATE.header.slice(144, 152));
  // The template's own merkle root is sha256(merklePrefix || body[0..10]).
  const h = Buffer.from(TEMPLATE.header, "hex");
  const b = Buffer.from(TEMPLATE.body, "hex");
  assert.ok(sha256(Buffer.concat([Buffer.from(TEMPLATE.merklePrefix, "hex"), b.subarray(0, 10)])).equals(h.subarray(36, 68)));
  assert.throws(() => jobFromTemplate({ ...TEMPLATE, header: "00" }), /Bad mining template/);
});

test("a solution lands in the block the way the node's stratum applies it", () => {
  const job = jobFromTemplate(TEMPLATE);
  const prefix = Buffer.from("01020304", "hex");
  const en2 = Buffer.from("a1a2a3a4a5a6", "hex");
  const ntime = Buffer.from("6af5b3b0", "hex");
  const nonce = Buffer.from("deadbeef", "hex");
  const out = solvedBlock(job, prefix, en2, ntime, nonce);
  const header = Buffer.from(out.header, "hex");
  const blob = Buffer.from(out.body, "hex");
  assert.equal(out.height, 52139);
  assert.equal(blob.readUInt32BE(0), blob.length - 4, "body is length-prefixed for POST /chain/append");
  const body = blob.subarray(4);
  assert.equal(body.subarray(0, 10).toString("hex"), "01020304a1a2a3a4a5a6");
  assert.equal(body.subarray(10).toString("hex"), TEMPLATE.body.slice(20));
  assert.ok(header.subarray(36, 68).equals(sha256(Buffer.concat([job.merklePrefix, body.subarray(0, 10)]))));
  assert.equal(header.subarray(72, 76).toString("hex"), "6af5b3b0");
  assert.equal(header.subarray(76, 80).toString("hex"), "deadbeef");
  assert.equal(header.subarray(0, 36).toString("hex"), TEMPLATE.header.slice(0, 72));
  assert.equal(header.subarray(68, 72).toString("hex"), "00000004");
});

function client(port) {
  const socket = connect(port, "127.0.0.1");
  const lines = [];
  const waiters = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      lines.push(msg);
      for (const w of waiters.splice(0)) w();
    }
  });
  async function next(pred, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out waiting for a stratum message");
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  }
  const send = (m) => socket.write(`${JSON.stringify(m)}\n`);
  return { socket, next, send, ready: new Promise((r) => socket.once("connect", r)) };
}

test("BzMiner-style session: subscribe, authorize, notify, submit a block", async () => {
  const calls = [];
  let tip = TEMPLATE;
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { ok: true, result: { code: 0, data: tip } };
    return { ok: true, result: { code: 0 } };
  };
  const bridge = createStratumBridge({ call, pollMs: 50 });
  const port = await bridge.start(0);
  const c = client(port);
  try {
    await c.ready;
    c.send({ id: 1, method: "mining.subscribe", params: ["BzMiner"] });
    const sub = await c.next((m) => m.id === 1);
    assert.equal(sub.result[0][0], "mining.notify");
    assert.match(sub.result[1], /^[0-9a-f]{8}$/);
    assert.equal(sub.result[2], 6);
    c.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.rig1`, "x"] });
    assert.equal((await c.next((m) => m.id === 2)).result, true);
    const diff = await c.next((m) => m.method === "mining.set_difficulty");
    assert.equal(diff.params[0], TEMPLATE.difficulty);
    const notify = await c.next((m) => m.method === "mining.notify");
    const [jobId, prev, merkle, version, nbits, ntime, clean] = notify.params;
    assert.equal(prev, TEMPLATE.header.slice(0, 64));
    assert.equal(merkle, TEMPLATE.merklePrefix);
    assert.equal(version, "00000004");
    assert.equal(nbits, "0762d2ef");
    assert.equal(clean, true);
    assert.ok(calls.some((x) => x.method === "GET" && x.path === `/chain/mine/${ADDRESS}`));
    // Same work with a newer timestamp is not re-sent every poll.
    tip = { ...TEMPLATE, header: TEMPLATE.header.slice(0, 144) + "6af5b3ff" + TEMPLATE.header.slice(152) };
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(c.next((m) => m.method === "mining.notify", 100));

    c.send({ id: 3, method: "mining.submit", params: [jobId, "000000000001", ntime, "00c0ffee"] });
    const res = await c.next((m) => m.id === 3);
    assert.equal(res.result, true);
    const post = calls.find((x) => x.method === "POST");
    assert.equal(post.path, "/chain/append");
    const sent = JSON.parse(post.body);
    assert.equal(sent.height, TEMPLATE.height);
    assert.equal(sent.worker, "rig1");
    assert.equal(sent.header.slice(152), "00c0ffee");
    assert.equal(sent.body.slice(8 + 8, 8 + 20), "000000000001");
    assert.equal(sent.body.slice(8, 16), sub.result[1]);
    assert.equal(bridge.status().blocks, 1);

    c.send({ id: 4, method: "mining.submit", params: ["nope", "000000000001", ntime, "00c0ffee"] });
    assert.deepEqual((await c.next((m) => m.id === 4)).error.slice(0, 2), [21, "Job not found"]);
    // A new tip is a clean job.
    tip = { ...TEMPLATE, header: "11".repeat(32) + TEMPLATE.header.slice(64), height: TEMPLATE.height + 1 };
    const fresh = await c.next((m) => m.method === "mining.notify" && m.params[1] === "11".repeat(32));
    assert.equal(fresh.params[6], true);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("stratum rejects bad addresses, unauthorized submits, and node errors", async () => {
  let appendReply = { ok: true, result: { code: 300, error: "Cannot parse hexadecimal input" } };
  const call = async (method) => (method === "GET"
    ? { ok: true, result: { code: 0, data: TEMPLATE } }
    : appendReply);
  const bridge = createStratumBridge({ call, pollMs: 50 });
  const port = await bridge.start(0);
  try {
    const bad = client(port);
    await bad.ready;
    bad.send({ id: 1, method: "mining.authorize", params: ["not-an-address.rig", ""] });
    assert.equal((await bad.next((m) => m.id === 1)).error[0], 30);
    bad.socket.destroy();

    const anon = client(port);
    await anon.ready;
    anon.send({ id: 1, method: "mining.submit", params: ["x", "000000000000", "00000000", "00000000"] });
    assert.equal((await anon.next((m) => m.id === 1)).error[0], 24);
    anon.socket.destroy();

    const c = client(port);
    await c.ready;
    c.send({ id: 1, method: "mining.subscribe", params: [] });
    c.send({ id: 2, method: "mining.authorize", params: [ADDRESS, ""] });
    const notify = await c.next((m) => m.method === "mining.notify");
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "0000000000ff", notify.params[5], "00000001"] });
    const res = await c.next((m) => m.id === 3);
    assert.deepEqual(res.error.slice(0, 2), [40, "Cannot parse hexadecimal input"]);
    appendReply = { ok: false, code: "no-page" };
    c.send({ id: 4, method: "mining.submit", params: [notify.params[0], "0000000000fe", notify.params[5], "00000002"] });
    assert.match((await c.next((m) => m.id === 4)).error[1], /no-page/);
    c.send({ id: 5, method: "mining.submit", params: [notify.params[0], "zz", notify.params[5], "00000002"] });
    assert.equal((await c.next((m) => m.id === 5)).error[0], 20);
    assert.equal(bridge.status().rejected, 2);
    assert.equal(bridge.status().pending, 0);
    c.socket.destroy();
  } finally {
    await bridge.stop();
  }
});

test("stratum waits for a synced node and listens on loopback only", async () => {
  const call = async () => ({ ok: true, result: { code: 0, data: { ...TEMPLATE, synced: false } } });
  const bridge = createStratumBridge({ call, pollMs: 50 });
  const port = await bridge.start(0);
  const c = client(port);
  try {
    await c.ready;
    assert.equal(c.socket.remoteAddress, "127.0.0.1");
    c.send({ id: 1, method: "mining.authorize", params: [ADDRESS, ""] });
    await c.next((m) => m.id === 1);
    await assert.rejects(c.next((m) => m.method === "mining.notify", 300));
    assert.match(bridge.status().lastError, /syncing/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("append answers: accepted, stale, rejected, or unknown until the chain says", () => {
  assert.equal(appendOutcome({ ok: true, result: { code: 0, error: "No error" } }).kind, "won");
  assert.deepEqual(appendOutcome({ ok: true, result: { code: 76, error: "Submitted deprecated block" } }), { kind: "rejected", message: "Submitted deprecated block", stale: true });
  assert.equal(appendOutcome({ ok: true, result: { code: 300, error: "bad" } }).stale, false);
  for (const code of ["timeout", "page-closed", "node-error"]) assert.equal(appendOutcome({ ok: false, code }).kind, "unknown");
  assert.equal(appendOutcome({ ok: false, code: "no-page" }).kind, "rejected");
  // Some other request's answer (it carries data) proves nothing about the block.
  assert.equal(appendOutcome({ ok: true, result: { code: 0, data: { chainHead: {} } } }).kind, "unknown");
  // Block hash is sha256d of the header, as on the explorer.
  const header = TEMPLATE.header;
  assert.equal(blockHash(header), sha256(sha256(Buffer.from(header, "hex"))).toString("hex"));
});

/** A stratum session up to the first job; returns the client, job and a submit helper. */
async function session(port) {
  const c = client(port);
  await c.ready;
  c.send({ id: 1, method: "mining.subscribe", params: [] });
  const sub = await c.next((m) => m.id === 1);
  c.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.rig1`, ""] });
  const notify = await c.next((m) => m.method === "mining.notify");
  const job = jobFromTemplate(TEMPLATE);
  const prefix = Buffer.from(sub.result[1], "hex");
  return {
    c,
    submit(id, en2, nonce) {
      c.send({ id, method: "mining.submit", params: [notify.params[0], en2, notify.params[5], nonce] });
      const block = solvedBlock(job, prefix, Buffer.from(en2, "hex"), Buffer.from(notify.params[5], "hex"), Buffer.from(nonce, "hex"));
      return blockHash(block.header);
    },
  };
}

test("a block the node tab never answers for is pending, then counted from the chain", async () => {
  const onChain = new Map(); // height -> hash the node's chain has there
  const asked = [];
  const call = async (method, path, _body, _net, options = {}) => {
    if (method === "GET" && path.startsWith("/chain/mine/")) return { ok: true, result: { code: 0, data: TEMPLATE } };
    if (method === "GET") {
      asked.push({ path, timeoutMs: options.timeoutMs });
      const height = Number(path.split("/")[3]);
      return onChain.has(height) ? { ok: true, result: { code: 0, data: onChain.get(height) } } : { ok: true, result: { code: 56, error: "Not found" } };
    }
    // The append reaches the node but its answer never comes back.
    asked.push({ path, timeoutMs: options.timeoutMs });
    return { ok: false, code: "timeout" };
  };
  const bridge = createStratumBridge({ call, pollMs: 50, reconcileMs: 30, appendTimeoutMs: 1234 });
  const port = await bridge.start(0);
  const { c, submit } = await session(port);
  try {
    const ours = submit(3, "000000000001", "00000001");
    const lost = submit(4, "000000000002", "00000002");
    await new Promise((r) => setTimeout(r, 100));
    let state = bridge.status();
    assert.equal(state.pending, 2, "a silent node tab is not a rejection");
    assert.equal(state.rejected, 0);
    assert.equal(state.blocks, 0);
    assert.equal(state.pendingBlocks[0].height, TEMPLATE.height);
    assert.equal(asked.find((a) => a.path === "/chain/append").timeoutMs, 1234);
    await assert.rejects(c.next((m) => m.id === 3, 100), "BzMiner hears nothing until the chain settles it");
    // The chain now has our first block at that height, so the second one is stale.
    onChain.set(TEMPLATE.height, ours);
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    assert.match((await c.next((m) => m.id === 4)).error[1], /Another block took that height/);
    assert.notEqual(ours, lost);
    state = bridge.status();
    assert.equal(state.blocks, 1);
    assert.equal(state.rejected, 1);
    assert.equal(state.stale, 1);
    assert.equal(state.pending, 0);
    assert.equal(state.workers[0].blocks, 1);
    assert.equal(state.workers[0].pending, 0);
    assert.match(state.lastResult, /stale|confirmed on chain/);
    assert.ok(asked.some((a) => a.path === `/chain/block/${TEMPLATE.height}/hash`));
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("a late append answer settles a pending block; unsettled ones give up in time", async () => {
  const lateCallbacks = [];
  const call = async (method, path, _body, _net, options = {}) => {
    if (method === "GET" && path.startsWith("/chain/mine/")) return { ok: true, result: { code: 0, data: TEMPLATE } };
    if (method === "GET") return { ok: false, code: "timeout" };
    lateCallbacks.push(options.onLate);
    return { ok: false, code: "timeout" };
  };
  const bridge = createStratumBridge({ call, pollMs: 50, reconcileMs: 30, reconcileGiveUpMs: 400, minerReplyMs: 150 });
  const port = await bridge.start(0);
  const { c, submit } = await session(port);
  try {
    submit(3, "000000000001", "00000001");
    submit(4, "000000000002", "00000002");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(bridge.status().pending, 2);
    lateCallbacks[0]({ type: "rpc-result", ok: true, result: { code: 0, error: "No error" } });
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    assert.equal(bridge.status().blocks, 1);
    // The other never gets an answer: BzMiner hears "still checking", then Hog gives up.
    assert.match((await c.next((m) => m.id === 4, 1000)).error[1], /still checking/);
    await new Promise((r) => setTimeout(r, 500));
    const state = bridge.status();
    assert.equal(state.pending, 0);
    assert.equal(state.rejected, 1);
    assert.equal(state.stale, 0);
    // A late answer after it was settled changes nothing.
    lateCallbacks[1]({ ok: true, result: { code: 0 } });
    assert.equal(bridge.status().blocks, 1);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});
