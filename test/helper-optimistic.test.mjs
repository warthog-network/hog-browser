// The helper runs Hog's stratum with optimistic work on (as Hog 0.1.38): a
// solved block's next-height job reaches BzMiner before the Brave node tab
// has saved the block. End to end: fake node tab on the relay WebSocket, the
// helper's control API, and a stratum miner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createHelper, publicTipHeight, relayToken } from "../helper/helper.mjs";
import { blockHash, jobFromTemplate, solvedBlock } from "../stratum.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/template-defi.json", import.meta.url), "utf8"));

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The Brave node tab: answers /chain/mine and /chain/head, appends take appendMs. */
async function fakeTab(pagePort, token, { appendMs = 400, answers = [] } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${pagePort}/__hog/mining`, { origin: `http://127.0.0.1:${pagePort}` });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "hello", token }));
  ws.send(JSON.stringify({ type: "status", network: "defi" }));
  let tip = TEMPLATE;
  const posts = [];
  ws.on("message", async (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type !== "rpc") return;
    let result;
    if (msg.method === "GET" && msg.path.startsWith("/chain/head")) {
      result = { code: 0, data: { height: tip.height - 1, pinHeight: tip.height - 3 } };
    } else if (msg.method === "GET") {
      result = { code: 0, data: tip };
    } else {
      const block = JSON.parse(msg.body);
      posts.push({ at: Date.now(), block });
      await new Promise((r) => setTimeout(r, appendMs));
      result = answers.shift() || { code: 0, error: "No error" };
      if (result.code === 0) {
        const header = Buffer.from(TEMPLATE.header, "hex");
        Buffer.from(blockHash(block.header), "hex").copy(header, 0);
        tip = { ...TEMPLATE, header: header.toString("hex"), height: block.height + 1 };
      }
    }
    ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, ok: true, result, network: "defi" }));
  });
  return { ws, posts };
}

function miner(port) {
  const socket = connect(port, "127.0.0.1");
  const lines = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) { lines.push({ at: Date.now(), ...JSON.parse(buf.slice(0, at)) }); buf = buf.slice(at + 1); }
  });
  async function next(pred, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out waiting for a stratum message");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return { socket, next, send: (m) => socket.write(`${JSON.stringify(m)}\n`), ready: new Promise((r) => socket.once("connect", r)) };
}

async function startHelper(extra = {}) {
  const [pagePort, controlPort, stratumPort] = [await freePort(), await freePort(), await freePort()];
  const dir = mkdtempSync(join(tmpdir(), "whelper-"));
  const helper = createHelper({
    pagePort, controlPort, stratumPort, configDir: dir,
    fetchImpl: async () => new Response("missing", { status: 404 }),
    getPublicTip: async () => TEMPLATE.height - 1,
    findTailnet: () => [],
    log: () => {},
    ...extra,
  });
  await helper.start();
  const base = `http://127.0.0.1:${controlPort}`;
  const headers = { "x-helper-token": helper.controlToken, "content-type": "application/json" };
  const api = async (path, body) => (await fetch(`${base}${path}`, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers })).json();
  return { helper, pagePort, stratumPort, token: relayToken(dir), api };
}

async function mineOne(stratumPort) {
  const m = miner(stratumPort);
  await m.ready;
  m.send({ id: 1, method: "mining.subscribe", params: [] });
  const sub = await m.next((x) => x.id === 1);
  m.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.brave-defi`, ""] });
  const notify = await m.next((x) => x.method === "mining.notify");
  return { m, prefix: Buffer.from(sub.result[1], "hex"), notify };
}

test("helper: next job reaches BzMiner before the Brave tab has saved the block", async () => {
  const { helper, pagePort, stratumPort, token, api } = await startHelper();
  const tab = await fakeTab(pagePort, token, { appendMs: 450 });
  try {
    const on = await api("/api/settings", { address: ADDRESS, network: "defi", enabled: true });
    assert.equal(on.stratumListening, true);
    assert.equal(on.optimisticOff, "", "optimistic work is on by default");
    const { m, prefix, notify } = await mineOne(stratumPort);
    const job = jobFromTemplate(TEMPLATE);
    const sentAt = Date.now();
    m.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const solved = solvedBlock(job, prefix, Buffer.from("000000000001", "hex"), Buffer.from(notify.params[5], "hex"), Buffer.from("00000001", "hex"));
    const next = await m.next((x) => x.method === "mining.notify");
    assert.ok(next.at - sentAt < 200, `next job after ${next.at - sentAt} ms (the tab takes 450 to save)`);
    assert.equal(next.params[1], blockHash(solved.header), "points at the block just solved");
    assert.equal(next.params[6], true, "clean job");
    const ack = await m.next((x) => x.id === 3);
    assert.equal(ack.result, true);
    assert.equal(tab.posts.length, 1);
    const s = await api("/api/status");
    assert.equal(s.optimisticJobs, 1);
    assert.equal(s.blocks, 1);
    m.socket.destroy();
  } finally {
    tab.ws.close();
    await helper.close();
  }
});

test("helper: a refused block rolls the early job back to the node's work", async () => {
  const { helper, pagePort, stratumPort, token, api } = await startHelper();
  const tab = await fakeTab(pagePort, token, { appendMs: 200, answers: [{ code: 300, error: "Bad proof of work" }] });
  try {
    await api("/api/settings", { address: ADDRESS, network: "defi", enabled: true });
    const { m, notify } = await mineOne(stratumPort);
    m.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const early = await m.next((x) => x.method === "mining.notify");
    assert.notEqual(early.params[1], notify.params[1]);
    const back = await m.next((x) => x.method === "mining.notify" && x.params[1] === notify.params[1]);
    assert.equal(back.params[6], true, "miner sent back to the node's own work, clean");
    const s = await api("/api/status");
    assert.equal(s.blocks, 0);
    assert.equal(s.optimisticOff, "", "a bad block is not the prediction's fault");
    m.socket.destroy();
  } finally {
    tab.ws.close();
    await helper.close();
  }
});

test("helper: --no-optimistic-work waits for the tab, as before", async () => {
  const { helper, pagePort, stratumPort, token, api } = await startHelper({ optimisticWork: false });
  const tab = await fakeTab(pagePort, token, { appendMs: 300 });
  try {
    const on = await api("/api/settings", { address: ADDRESS, network: "defi", enabled: true });
    assert.equal(on.optimisticOff, "disabled");
    const { m, notify } = await mineOne(stratumPort);
    const sentAt = Date.now();
    m.send({ id: 3, method: "mining.submit", params: [notify.params[0], "000000000001", notify.params[5], "00000001"] });
    const next = await m.next((x) => x.method === "mining.notify");
    assert.ok(next.at - sentAt >= 300, `next job only after the tab saved the block (${next.at - sentAt} ms)`);
    m.socket.destroy();
  } finally {
    tab.ws.close();
    await helper.close();
  }
});

test("public tip for the ready gate: height from /chain/head, 0 on failure", async () => {
  const seen = [];
  const ok = async (url) => { seen.push(url); return new Response(JSON.stringify({ code: 0, data: { chainHead: { height: 5300000, pinHeight: 5299990 } } })); };
  assert.equal(await publicTipHeight("mainnet", ok), 5300000);
  assert.equal(seen[0], "https://warthognode.duckdns.org/chain/head");
  assert.equal(await publicTipHeight("defi", async () => new Response("x", { status: 500 })), 0);
  assert.equal(await publicTipHeight("defi", async () => { throw new Error("offline"); }), 0);
  assert.equal(await publicTipHeight("nope", ok), 0);
});
