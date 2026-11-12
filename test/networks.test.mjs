import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  MINING_NETWORKS,
  MINING_WS_PATH,
  bzminerCommand,
  createMiningRelay,
  networkFromPage,
  resolveMiningNetwork,
} from "../mining.mjs";
import { createStratumBridge, jobFromTemplate, solvedBlock } from "../stratum.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const TOKEN = "b".repeat(48);
const sha256 = (b) => createHash("sha256").update(b).digest();
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const DEFI = fixture("template-defi.json");
const MAINNET = fixture("template-mainnet.json");

test("network names: the node tab's Official1 is mainnet", () => {
  assert.equal(networkFromPage("official1"), MINING_NETWORKS.mainnet);
  assert.equal(networkFromPage("defi"), MINING_NETWORKS.defi);
  assert.equal(networkFromPage(""), null);
  assert.equal(MINING_NETWORKS.mainnet.label, "Mainnet");
  assert.equal(MINING_NETWORKS.defi.label, "DeFi testnet");
});

test("auto follows the node tab; a pinned network ignores it", () => {
  assert.equal(resolveMiningNetwork("auto", "official1").key, "mainnet");
  assert.equal(resolveMiningNetwork("auto", "defi").key, "defi");
  assert.equal(resolveMiningNetwork("auto", ""), null);
  assert.equal(resolveMiningNetwork("mainnet", "defi").key, "mainnet");
  assert.equal(resolveMiningNetwork("defi", "official1").key, "defi");
  assert.equal(resolveMiningNetwork("bogus", ""), null);
});

test("BzMiner command names the network in the worker", () => {
  assert.equal(
    bzminerCommand(3456, ADDRESS, "hog-mainnet"),
    `./bzminer -a warthog -p stratum+tcp://127.0.0.1:3456 -w ${ADDRESS} -r hog-mainnet`,
  );
});

test("mainnet templates make mainnet jobs; mainnet bodies are raw hex, DeFi bodies length-prefixed", () => {
  for (const [tpl, net] of [[MAINNET, MINING_NETWORKS.mainnet], [DEFI, MINING_NETWORKS.defi]]) {
    const job = jobFromTemplate(tpl, net);
    assert.equal(job.network, net.key);
    assert.equal(job.page, net.page);
    const h = Buffer.from(tpl.header, "hex");
    const b = Buffer.from(tpl.body, "hex");
    // Both networks: merkle root = sha256(merklePrefix || body[0..10]).
    assert.ok(sha256(Buffer.concat([Buffer.from(tpl.merklePrefix, "hex"), b.subarray(0, 10)])).equals(h.subarray(36, 68)));
    const out = solvedBlock(job, Buffer.from("01020304", "hex"), Buffer.from("0a0b0c0d0e0f", "hex"), h.subarray(72, 76), Buffer.from("00000001", "hex"));
    const blob = Buffer.from(out.body, "hex");
    const body = net.lengthPrefixedBody ? blob.subarray(4) : blob;
    if (net.lengthPrefixedBody) assert.equal(blob.readUInt32BE(0), body.length);
    else assert.equal(blob.length, b.length, "mainnet body is not length-prefixed");
    assert.equal(body.subarray(0, 10).toString("hex"), "010203040a0b0c0d0e0f");
    assert.ok(Buffer.from(out.header, "hex").subarray(36, 68).equals(sha256(Buffer.concat([job.merklePrefix, body.subarray(0, 10)]))));
  }
  assert.notEqual(jobFromTemplate(MAINNET, MINING_NETWORKS.mainnet).workKey, jobFromTemplate(MAINNET, MINING_NETWORKS.defi).workKey);
});

function client(port) {
  const socket = connect(port, "127.0.0.1");
  const lines = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, at)));
      buf = buf.slice(at + 1);
    }
  });
  async function next(pred, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out waiting for a stratum message");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const send = (m) => socket.write(`${JSON.stringify(m)}\n`);
  return { socket, next, send, ready: new Promise((r) => socket.once("connect", r)) };
}

test("stratum follows a network switch with a clean job and submits to the job's network", async () => {
  let net = MINING_NETWORKS.defi;
  const calls = [];
  const call = async (method, path, body, page) => {
    calls.push({ method, path, body, page });
    if (method === "GET") return { ok: true, result: { code: 0, data: page === "official1" ? MAINNET : DEFI } };
    return { ok: true, result: { code: 0 } };
  };
  const bridge = createStratumBridge({ call, getNetwork: () => net, pollMs: 40 });
  const port = await bridge.start(0);
  const c = client(port);
  try {
    await c.ready;
    c.send({ id: 1, method: "mining.subscribe", params: [] });
    c.send({ id: 2, method: "mining.authorize", params: [`${ADDRESS}.hog-defi`, ""] });
    const first = await c.next((m) => m.method === "mining.notify");
    assert.equal(first.params[1], DEFI.header.slice(0, 64));
    assert.equal(bridge.status().miningNetwork, "defi");
    net = MINING_NETWORKS.mainnet;
    const second = await c.next((m) => m.method === "mining.notify" && m.params[1] === MAINNET.header.slice(0, 64));
    assert.equal(second.params[6], true, "switching networks is a clean job");
    assert.equal(second.params[2], MAINNET.merklePrefix);
    assert.equal(bridge.status().miningNetwork, "mainnet");
    assert.equal(bridge.status().height, MAINNET.height);
    c.send({ id: 3, method: "mining.submit", params: [second.params[0], "000000000001", second.params[5], "00000009"] });
    assert.equal((await c.next((m) => m.id === 3)).result, true);
    const post = calls.find((x) => x.method === "POST");
    assert.equal(post.page, "official1", "a mainnet job is submitted to the mainnet node only");
    const sent = JSON.parse(post.body);
    assert.equal(sent.height, MAINNET.height);
    assert.equal(sent.body.length, MAINNET.body.length, "mainnet body goes as raw hex");
    // The old DeFi job is gone after the switch.
    c.send({ id: 4, method: "mining.submit", params: [first.params[0], "000000000001", first.params[5], "00000009"] });
    assert.equal((await c.next((m) => m.id === 4)).error[0], 21);
    assert.match(bridge.status().lastResult, /^Mainnet block/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("no network known (auto, node tab not started) means no work", async () => {
  let gets = 0;
  const bridge = createStratumBridge({ call: async () => { gets += 1; return { ok: true, result: { code: 0, data: MAINNET } }; }, getNetwork: () => null, pollMs: 40 });
  const port = await bridge.start(0);
  const c = client(port);
  try {
    await c.ready;
    c.send({ id: 1, method: "mining.authorize", params: [ADDRESS, ""] });
    await c.next((m) => m.id === 1);
    await assert.rejects(c.next((m) => m.method === "mining.notify", 250));
    assert.equal(gets, 0);
    assert.match(bridge.status().lastError, /Start the node tab/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("an unsynced mainnet node hands out no work", async () => {
  const bridge = createStratumBridge({
    call: async () => ({ ok: true, result: { code: 0, data: { ...MAINNET, synced: false } } }),
    getNetwork: () => MINING_NETWORKS.mainnet,
    pollMs: 40,
  });
  const port = await bridge.start(0);
  const c = client(port);
  try {
    await c.ready;
    c.send({ id: 1, method: "mining.authorize", params: [ADDRESS, ""] });
    await c.next((m) => m.id === 1);
    await assert.rejects(c.next((m) => m.method === "mining.notify", 250));
    assert.match(bridge.status().lastError, /Mainnet node is still syncing/);
  } finally {
    c.socket.destroy();
    await bridge.stop();
  }
});

test("node page reports its network unprompted, and each call carries the wanted network", async () => {
  const site = createServer((_req, res) => res.end("site"));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;
  let want = "official1";
  const relay = createMiningRelay({ token: TOKEN, pageOrigin: `http://localhost:${sitePort}`, network: () => want, timeoutMs: 500 });
  site.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  const ws = new WebSocket(`ws://127.0.0.1:${sitePort}${MINING_WS_PATH}`, { origin: `http://localhost:${sitePort}` });
  const seen = [];
  try {
    await new Promise((r) => ws.on("open", r));
    ws.on("message", (d) => {
      const msg = JSON.parse(String(d));
      seen.push(msg.network);
      ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, network: "official1", ok: true, result: { code: 0 } }));
    });
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    ws.send(JSON.stringify({ type: "status", network: "official1" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(relay.getPageNetwork(), "official1");
    await relay.call("GET", `/chain/mine/${ADDRESS}`);
    await relay.call("GET", `/chain/mine/${ADDRESS}`, undefined, "defi");
    want = "";
    await relay.call("GET", `/chain/mine/${ADDRESS}`);
    assert.deepEqual(seen, ["official1", "defi", ""]);
    ws.send(JSON.stringify({ type: "status", network: "defi" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(relay.getPageNetwork(), "defi");
  } finally {
    ws.close();
    await relay.close();
    await new Promise((r) => site.close(r));
  }
});

test("page relay script reports status and keeps the network check", async () => {
  const { pageRelayScript } = await import("../mining.mjs");
  const script = pageRelayScript(TOKEN);
  assert.match(script, /type: "status"/);
  assert.match(script, /wrong-network/);
  assert.match(script, /\\\/node\\\/wart-node\\\.js/);
});

test("server serves bundled node files per network, and nothing else", async () => {
  const { localNodeFile } = await import("../server.mjs");
  const root = mkdtempSync(join(tmpdir(), "hog-nodes-"));
  try {
    const defi = join(root, "defi");
    const mainnet = join(root, "mainnet");
    mkdirSync(defi);
    mkdirSync(mainnet);
    for (const d of [defi, mainnet]) for (const f of ["wart-node.js", "wart-node.wasm"]) writeFileSync(join(d, f), "x");
    const node = "https://browser-node.netlify.app";
    const dirs = { defi, mainnet };
    assert.equal(localNodeFile(node, "/node/defi/wart-node.wasm", dirs), join(defi, "wart-node.wasm"));
    assert.equal(localNodeFile(node, "/node/wart-node.wasm", dirs), join(mainnet, "wart-node.wasm"));
    assert.equal(localNodeFile(node, "/node/wart-node.js", dirs), join(mainnet, "wart-node.js"));
    assert.equal(localNodeFile(node, "/node/wart-node.worker.js", dirs), "");
    assert.equal(localNodeFile(node, "/node/backup-v0.9.15/wart-node.wasm", dirs), "");
    assert.equal(localNodeFile(node, "/wart-node.wasm", dirs), "");
    assert.equal(localNodeFile("https://example.com", "/node/wart-node.wasm", dirs), "");
    assert.equal(localNodeFile(node, "/node/wart-node.wasm", { defi, mainnet: "" }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hog bundles a mainnet node build that accepts mined blocks", () => {
  const root = new URL("../node-mainnet/", import.meta.url);
  const sums = readFileSync(new URL("SHA256SUMS", root), "utf8");
  for (const name of ["wart-node.js", "wart-node.wasm"]) {
    const hash = sha256(readFileSync(new URL(name, root))).toString("hex");
    assert.match(sums, new RegExp(`^${hash}  node-mainnet/${name.replace(".", "\\.")}$`, "m"));
  }
  const wasm = readFileSync(new URL("wart-node.wasm", root));
  assert.ok(wasm.includes(Buffer.from("/chain/append")));
  assert.ok(wasm.includes(Buffer.from("/chain/mine/:account")));
  const glue = readFileSync(new URL("wart-node.js", root), "utf8");
  assert.doesNotMatch(glue, /VIRTUALSTATE\.postId\(\)/, "glue uses getId for POST");
  const deb = readFileSync(new URL("../packaging/build-deb.sh", import.meta.url), "utf8");
  assert.match(deb, /cp -a "\$\{HB\}\/node-mainnet" "\$\{APP\}\/"/);
});
