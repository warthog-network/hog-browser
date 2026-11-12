import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blockHash, createStratumBridge, jobFromTemplate, optimisticNextJob, solvedBlock } from "../stratum.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/template-defi.json", import.meta.url), "utf8"));
const TIP = async () => TEMPLATE.height - 1;
const sha256 = (b) => createHash("sha256").update(b).digest();
// Two consecutive DeFi testnet headers (heights 54300 and 54301) as on the explorer.
const H54300 = "08734351718aaec90b0fee5e58fbfb32353ec08f01993ea1c9ef95f14506783407b6dfd7713e5f5026f43298089b7b110f2e8fa80cab38e932ca528b6d3725abf9c6c78c000000046af642af78a45f3a";
const H54301 = "25e0d1e783b2ff773da9307827b439f43321ce4777d97fc848fc71b3106be6e107b6dfd7471299f90ad2ef4c4a71e06c902f3b5136e2c4fc763e52fb1fc9f420591e34b2000000046af642b2100ea0ac";

test("optimistic next job: parent hash, same target and body, newer time", () => {
  // The job block 54300 was solved on: its header without merkle root and nonce.
  const header = Buffer.from(H54300, "hex");
  header.fill(0, 36, 68);
  header.fill(0, 76, 80);
  const job = jobFromTemplate({ ...TEMPLATE, header: header.toString("hex"), height: 54300 });
  const next = optimisticNextJob(job, H54300, 0x6af642b2);
  assert.ok(next);
  assert.equal(next.height, 54301);
  assert.equal(next.prevHash, H54301.slice(0, 64), "the next header points at the solved block, as on chain");
  assert.equal(next.nbits, H54301.slice(64, 72));
  assert.equal(next.version, "00000004");
  assert.equal(next.ntime, "6af642b2");
  assert.ok(next.body.equals(job.body));
  assert.ok(next.merklePrefix.equals(job.merklePrefix));
  assert.equal(next.optimistic, true);
  assert.notEqual(next.id, job.id);
  // The clock behind the parent's timestamp: never go back in time.
  assert.equal(optimisticNextJob(job, H54300, 1).ntime, "6af642af");
});

test("no optimistic job across a retarget or halving, or with transactions in the block", () => {
  const job = jobFromTemplate(TEMPLATE);
  const solved = solvedBlock(job, Buffer.alloc(4), Buffer.alloc(6), Buffer.from(job.ntime, "hex"), Buffer.alloc(4)).header;
  assert.ok(optimisticNextJob(job, solved), "reward-only template at an ordinary height");
  // Leaf check: the fixture's merklePrefix is sha256 of the reward bytes.
  assert.ok(sha256(job.body.subarray(12, 28)).equals(job.merklePrefix));
  for (const height of [53999, 54000, 6307199, 6307200]) {
    assert.equal(optimisticNextJob({ ...job, height }, solved), null, `next height ${height + 1}`);
  }
  // Transactions: more merkle leaves (64-byte prefix), or a prefix that is not the reward leaf.
  assert.equal(optimisticNextJob({ ...job, merklePrefix: Buffer.concat([job.merklePrefix, job.merklePrefix]) }, solved), null);
  assert.equal(optimisticNextJob({ ...job, merklePrefix: sha256(Buffer.from("other")) }, solved), null);
  assert.equal(optimisticNextJob(job, "00"), null);
});

function client(port) {
  const socket = connect(port, "127.0.0.1");
  const lines = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) { lines.push({ at: Date.now(), ...JSON.parse(buf.slice(0, at)) }); buf = buf.slice(at + 1); }
  });
  async function next(pred, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out waiting for a stratum message");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const send = (m) => socket.write(`${JSON.stringify(m)}\n`);
  return { socket, next, send, ready: new Promise((r) => socket.once("connect", r)) };
}

async function session(port) {
  const c = client(port);
  await c.ready;
  c.send({ id: 1, method: "mining.subscribe", params: [] });
  const sub = await c.next((m) => m.id === 1);
  c.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.rig1`, ""] });
  const notify = await c.next((m) => m.method === "mining.notify");
  return { c, prefix: Buffer.from(sub.result[1], "hex"), notify };
}

/** The node tab: appends take `appendMs`, answers from `answers` in order (default: accepted). */
function fakeNode({ appendMs = 400, answers = [] } = {}) {
  const posts = [];
  let tip = TEMPLATE;
  const call = async (method, path, body) => {
    if (method === "GET") return { ok: true, result: { code: 0, data: tip } };
    const block = JSON.parse(body);
    posts.push({ at: Date.now(), block });
    await new Promise((r) => setTimeout(r, appendMs));
    const answer = answers.shift() || { code: 0, error: "No error" };
    if (answer.code === 0) {
      // The node moves on: its next template is the reward-only block on ours.
      const header = Buffer.from(TEMPLATE.header, "hex");
      Buffer.from(blockHash(block.header), "hex").copy(header, 0);
      tip = { ...TEMPLATE, header: header.toString("hex"), height: block.height + 1 };
    }
    return { ok: true, result: answer };
  };
  return { call, posts, setTip: (t) => { tip = t; } };
}

test("the next job goes out as soon as a block is submitted, not after the node saved it", async () => {
  const node = fakeNode({ appendMs: 400 });
  const bridge = createStratumBridge({ call: node.call, getPublicTip: TIP, pollMs: 60_000 });
  const port = await bridge.start(0);
  const { c, prefix, notify } = await session(port);
  try {
    const job = jobFromTemplate(TEMPLATE);
    const sentAt = Date.now();
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const solved = solvedBlock(job, prefix, Buffer.from("000000000001", "hex"), Buffer.from(notify.params[5], "hex"), Buffer.from("00000001", "hex"));
    const next = await c.next((m) => m.method === "mining.notify");
    assert.ok(next.at - sentAt < 150, `next job after ${next.at - sentAt} ms (the append takes 400)`);
    assert.equal(next.params[1], blockHash(solved.header));
    assert.equal(next.params[6], true, "clean: old work is dead");
    // A second solution for the old height is stale at once, without the node.
    c.send({ id: 4, method: "mining.submit", params: [notify.params[0], "000000000002", notify.params[5], "00000002"] });
    const stale = await c.next((m) => m.id === 4);
    assert.equal(stale.error[0], 21);
    assert.ok(stale.at - sentAt < 300);
    // A block on the new job is sent behind the first; both land.
    c.send({ id: 5, method: "mining.submit", params: [next.params[0], "000000000003", next.params[5], "00000003"] });
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    assert.equal((await c.next((m) => m.id === 5)).result, true);
    assert.deepEqual(node.posts.map((p) => p.block.height), [TEMPLATE.height, TEMPLATE.height + 1]);
    assert.equal(JSON.parse(JSON.stringify(node.posts[1].block)).header.slice(0, 64), blockHash(solved.header));
    const state = bridge.status();
    assert.equal(state.blocks, 2);
    assert.equal(state.optimisticJobs >= 1, true);
    assert.equal(state.optimisticOff, "");
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("a refused block takes its optimistic job back and the old height is work again", async () => {
  const node = fakeNode({ appendMs: 50, answers: [{ code: 300, error: "Bad proof of work" }] });
  const bridge = createStratumBridge({ call: node.call, getPublicTip: TIP, pollMs: 60_000 });
  const port = await bridge.start(0);
  const { c, notify } = await session(port);
  try {
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const optimistic = await c.next((m) => m.method === "mining.notify");
    assert.notEqual(optimistic.params[1], notify.params[1]);
    assert.equal((await c.next((m) => m.id === 3)).error[0], 40);
    const back = await c.next((m) => m.method === "mining.notify");
    assert.equal(back.params[1], notify.params[1], "back on the node's own work at the old height");
    assert.equal(back.params[6], true);
    // The optimistic job is dead.
    c.send({ id: 4, method: "mining.submit", params: [optimistic.params[0], "000000000002", optimistic.params[5], "00000002"] });
    assert.equal((await c.next((m) => m.id === 4)).error[0], 21);
    assert.equal(node.posts.length, 1);
    assert.equal(bridge.status().optimisticOff, "", "a bad block is not the prediction's fault");
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("a block on predicted work that the node refuses turns prediction off", async () => {
  const node = fakeNode({ appendMs: 30, answers: [{ code: 0, error: "No error" }, { code: 301, error: "Bad merkle root" }] });
  const bridge = createStratumBridge({ call: node.call, getPublicTip: TIP, pollMs: 60_000 });
  const port = await bridge.start(0);
  const { c, notify } = await session(port);
  try {
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const optimistic = await c.next((m) => m.method === "mining.notify");
    c.send({ id: 4, method: "mining.submit", params: [optimistic.params[0], "000000000002", optimistic.params[5], "00000002"] });
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    assert.equal((await c.next((m) => m.id === 4)).error[0], 40);
    assert.match(bridge.status().optimisticOff, /Bad merkle root/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("templates with transactions wait for the node, as before", async () => {
  const node = fakeNode({ appendMs: 150 });
  node.setTip({ ...TEMPLATE, merklePrefix: TEMPLATE.merklePrefix + TEMPLATE.merklePrefix });
  const bridge = createStratumBridge({ call: node.call, getPublicTip: TIP, pollMs: 60_000 });
  const port = await bridge.start(0);
  const { c, notify } = await session(port);
  try {
    const sentAt = Date.now();
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    const next = await c.next((m) => m.method === "mining.notify");
    assert.ok(next.at - sentAt >= 140, "no job before the node answered");
    assert.equal(bridge.status().optimisticJobs, 0);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("blocks in a row: a block on optimistic work gets its own next job at once", async () => {
  const node = fakeNode({ appendMs: 300 });
  const bridge = createStratumBridge({ call: node.call, getPublicTip: TIP, pollMs: 60_000 });
  const port = await bridge.start(0);
  const { c, notify } = await session(port);
  try {
    const t0 = Date.now();
    c.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const first = await c.next((m) => m.method === "mining.notify");
    c.send({ id: 4, method: "mining.submit", params: [first.params[0], "000000000002", first.params[5], "00000002"] });
    const second = await c.next((m) => m.method === "mining.notify");
    assert.ok(second.at - t0 < 200, "both next jobs before the first append finished");
    assert.notEqual(second.params[1], first.params[1]);
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    assert.equal((await c.next((m) => m.id === 4)).result, true);
    assert.deepEqual(node.posts.map((p) => p.block.height), [TEMPLATE.height, TEMPLATE.height + 1]);
    assert.equal(bridge.status().optimisticJobs, 2);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});
