import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import vm from "node:vm";
import { WebSocket } from "ws";
import {
  MINING_WS_PATH,
  bzminerCommand,
  createMiningRelay,
  isMiningAccount,
  miningPort,
  miningRoute,
  pageRelayPageScript,
  pageRelayScript,
} from "../mining.mjs";

const TOKEN = "a".repeat(48);
const ACCOUNT = "0123456789abcdef0123456789abcdef0123456789abcdef";

async function harness() {
  const site = createServer((_req, res) => res.end("site"));
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = site.address().port;
  const pageOrigin = `http://localhost:${sitePort}`;
  const relay = createMiningRelay({ token: TOKEN, pageOrigin, timeoutMs: 500 });
  site.on("upgrade", (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await relay.start(0);
  return {
    relay,
    port,
    sitePort,
    pageOrigin,
    async close() {
      await relay.close();
      await new Promise((resolve) => site.close(resolve));
    },
  };
}

function connectPage(h, { origin = h.pageOrigin, token = TOKEN, handler } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.sitePort}${MINING_WS_PATH}`, { origin });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token }));
      setTimeout(() => resolve(ws), 50);
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on("error", reject);
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "rpc" && handler) {
        Promise.resolve(handler(msg)).then((reply) => ws.send(JSON.stringify({ type: "rpc-result", id: msg.id, network: "defi", ...reply })));
      }
    });
  });
}

function http(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("mining helpers validate accounts, routes, and port", () => {
  assert.equal(isMiningAccount(ACCOUNT), true);
  assert.equal(isMiningAccount(ACCOUNT.slice(0, 40)), false);
  assert.equal(isMiningAccount(`${ACCOUNT}00`), false);
  assert.deepEqual(miningRoute("GET", `/chain/mine/${ACCOUNT}`), { kind: "mine", path: `/chain/mine/${ACCOUNT}` });
  assert.deepEqual(miningRoute("POST", "/chain/append"), { kind: "append", path: "/chain/append" });
  assert.equal(miningRoute("GET", "/chain/append"), null);
  assert.equal(miningRoute("GET", "/debug/fakemine"), null);
  assert.equal(miningRoute("GET", "/chain/mine/../../debug"), null);
  assert.equal(miningPort(undefined), 3100);
  assert.equal(miningPort("3200"), 3200);
  assert.throws(() => miningPort("nope"));
  assert.equal(bzminerCommand(3100), "./bzminer -a warthog -p stratum+tcp://127.0.0.1:3100 -w <48-hex-wallet> -r rig1");
  const script = pageRelayScript(TOKEN);
  assert.match(script, /virtual_post/);
  assert.match(script, new RegExp(TOKEN));
  assert.doesNotMatch(script, /<\/script/i);
  const page = pageRelayPageScript();
  assert.match(page, /__hogMiningRpc/);
  assert.match(page, /virtual_post/);
  assert.doesNotMatch(page, /TOKEN/);
  assert.doesNotMatch(page, /WebSocket/);
  assert.doesNotMatch(page, /<\/script/i);
});

test("mining port answers 503 when no node page is connected", async () => {
  const h = await harness();
  try {
    const res = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`);
    assert.equal(res.status, 503);
    assert.match(JSON.parse(res.text).error, /node tab is not open/);
  } finally {
    await h.close();
  }
});

test("mining relay passes templates and block submits through the node page", async () => {
  const h = await harness();
  const seen = [];
  const page = await connectPage(h, {
    handler(msg) {
      seen.push(msg);
      if (msg.method === "GET") return { ok: true, result: { code: 0, data: { height: 7, header: "ab" } } };
      return { ok: true, result: { code: 0 } };
    },
  });
  try {
    const mine = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`);
    assert.equal(mine.status, 200);
    assert.deepEqual(JSON.parse(mine.text), { code: 0, data: { height: 7, header: "ab" } });
    const block = JSON.stringify({ height: 7, header: "cd", body: "ef" });
    const append = await http(h.port, "POST", "/chain/append", { body: block, headers: { "content-type": "application/json" } });
    assert.equal(append.status, 200);
    assert.deepEqual(JSON.parse(append.text), { code: 0 });
    assert.equal(seen[0].path, `/chain/mine/${ACCOUNT}`);
    assert.equal(seen[0].network, "defi");
    assert.equal(seen[1].method, "POST");
    assert.equal(seen[1].body, block, "block body is passed through verbatim");
    const state = h.relay.status();
    assert.equal(state.templates, 1);
    assert.equal(state.submits, 1);
    assert.equal(state.pageConnected, true);
  } finally {
    page.close();
    await h.close();
  }
});

test("mining relay reports a not-running node and timeouts clearly", async () => {
  const h = await harness();
  let mode = "not-running";
  const page = await connectPage(h, {
    handler() {
      if (mode === "not-running") return { ok: false, code: "not-running" };
      return new Promise(() => {});
    },
  });
  try {
    const res = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`);
    assert.equal(res.status, 503);
    assert.match(JSON.parse(res.text).error, /Press Start/);
    mode = "hang";
    const slow = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`);
    assert.equal(slow.status, 504);
  } finally {
    page.close();
    await h.close();
  }
});

test("mining port refuses other routes, browsers, and foreign hosts", async () => {
  const h = await harness();
  try {
    assert.equal((await http(h.port, "GET", "/debug/fakemine")).status, 404);
    assert.equal((await http(h.port, "GET", `/chain/mine/${ACCOUNT.slice(0, 40)}`)).status, 404);
    assert.equal((await http(h.port, "GET", "/chain/head")).status, 404);
    const browser = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`, { headers: { origin: "https://evil.example" } });
    assert.equal(browser.status, 403);
    const fetchSite = await http(h.port, "POST", "/chain/append", { body: "{}", headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(fetchSite.status, 403);
    const rebind = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`, { headers: { host: `evil.example:${h.port}` } });
    assert.equal(rebind.status, 403);
    const bare = await http(h.port, "GET", "/debug/fakemine", { headers: { host: "127.0.0.1" } });
    assert.equal(bare.status, 404, "a loopback Host without a port (BzMiner) gets past the host check");
    const bareEvil = await http(h.port, "GET", "/debug/fakemine", { headers: { host: "evil.example" } });
    assert.equal(bareEvil.status, 403);
  } finally {
    await h.close();
  }
});

test("relay socket rejects a wrong origin or token", async () => {
  const h = await harness();
  try {
    await assert.rejects(connectPage(h, { origin: "http://localhost:43111" }), /403/);
    const bad = await connectPage(h, { token: "b".repeat(48) });
    if (bad.readyState !== WebSocket.CLOSED) await new Promise((resolve) => bad.once("close", resolve));
    assert.equal(h.relay.status().pageConnected, false);
    const res = await http(h.port, "GET", `/chain/mine/${ACCOUNT}`);
    assert.equal(res.status, 503);
  } finally {
    await h.close();
  }
});

test("mining listener binds loopback only", async () => {
  const h = await harness();
  try {
    assert.ok(h.relay.status().listening);
    const relay = createMiningRelay({ token: TOKEN, pageOrigin: "http://localhost:1" });
    const port = await relay.start(0);
    assert.ok(port > 0);
    await relay.close();
  } finally {
    await h.close();
  }
});

test("server routes local DeFi node files only for the node site", async () => {
  const { localDefiNodeFile } = await import("../server.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hog-defi-"));
  try {
    writeFileSync(join(dir, "wart-node.wasm"), "x");
    writeFileSync(join(dir, "wart-node.js"), "x");
    const node = "https://browser-node.netlify.app";
    assert.equal(localDefiNodeFile(node, "/node/defi/wart-node.wasm", dir), join(dir, "wart-node.wasm"));
    assert.equal(localDefiNodeFile(node, "/node/defi/wart-node.js", dir), join(dir, "wart-node.js"));
    // Files Hog does not have fall through to the live site.
    assert.equal(localDefiNodeFile(node, "/node/defi/wart-node.worker.js", dir), "");
    assert.equal(localDefiNodeFile(node, "/node/wart-node.wasm", dir), "");
    assert.equal(localDefiNodeFile(node, "/node/defi/../secret", dir), "");
    assert.equal(localDefiNodeFile("https://example.com", "/node/defi/wart-node.wasm", dir), "");
    assert.equal(localDefiNodeFile(node, "/node/defi/wart-node.wasm", ""), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hog bundles the DeFi node build that accepts mined blocks", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const root = new URL("../node-defi/", import.meta.url);
  const sums = readFileSync(new URL("SHA256SUMS", root), "utf8");
  for (const name of ["wart-node.js", "wart-node.wasm"]) {
    const body = readFileSync(new URL(name, root));
    const hash = createHash("sha256").update(body).digest("hex");
    assert.match(sums, new RegExp(`^${hash}  node-defi/${name.replace(".", "\\.")}$`, "m"));
  }
  const wasm = readFileSync(new URL("wart-node.wasm", root));
  assert.ok(wasm.includes(Buffer.from("/chain/append")), "bundled wasm registers POST /chain/append");
  assert.ok(wasm.includes(Buffer.from("/chain/mine/")), "bundled wasm serves mining templates");
  const deb = readFileSync(new URL("../packaging/build-deb.sh", import.meta.url), "utf8");
  assert.match(deb, /cp -a "\$\{HB\}\/node-defi" "\$\{APP\}\/"/);
});

test("node page HTML carries the relay script, other sites do not", async () => {
  const { rewriteHtml, applyRelayMode } = await import("../server.mjs");
  const nodeHtml = rewriteHtml("<html><head></head><body></body></html>", "https://browser-node.netlify.app/?network=defi");
  assert.match(nodeHtml, /__hogMiningRelay/);
  assert.match(nodeHtml, /data-hog-relay/);
  const other = rewriteHtml("<html><head></head><body></body></html>", "https://example.com/");
  assert.doesNotMatch(other, /__hogMiningRelay/);
  const stripped = applyRelayMode(nodeHtml, "preload");
  assert.match(stripped, /__hogMiningRpc/);
  assert.doesNotMatch(stripped, /var TOKEN/);
  assert.doesNotMatch(stripped, /type: "hello"/);
});

test("a relay call that times out still hands a late answer to onLate", async () => {
  const h = await harness();
  let answer;
  const page = await connectPage(h, {
    handler() {
      return new Promise((resolve) => { answer = resolve; });
    },
  });
  try {
    const late = [];
    const reply = await h.relay.call("POST", "/chain/append", "{}", "", { timeoutMs: 50, onLate: (msg) => late.push(msg) });
    assert.deepEqual(reply, { ok: false, code: "timeout" });
    answer({ ok: true, result: { code: 0, error: "No error" } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(late.length, 1);
    assert.deepEqual(late[0].result, { code: 0, error: "No error" });
  } finally {
    page.close();
    await h.close();
  }
});

/**
 * The Emscripten glue's request bookkeeping (wart-node.js VIRTUALSTATE) over a
 * node whose async answers carry the id of whatever request was dispatched
 * last, or a stale stack value once other calls reuse that stack slot, as the
 * WASM router's stack-held Response does (router.hpp match_get / match_post).
 */
function brokenWasmNode() {
  const VS = {
    nextId: 1,
    getId() { return VS.nextId++; },
    getPromise(id) { return new Promise((resolve, reject) => { VS[id] = { resolve, reject }; }); },
    resolvePromise(id, json) { if (VS[id]) { VS[id].resolve(json); delete VS[id]; } },
  };
  let stackSlot = 0;
  const mod = { VIRTUALSTATE: VS, requests: 0 };
  function dispatch(id, answer, clobber) {
    stackSlot = id;
    mod.requests += 1;
    if (clobber) queueMicrotask(() => { stackSlot = 70075200; });
    setTimeout(() => VS.resolvePromise(stackSlot, answer), 10);
  }
  mod.virtual_get = function (url) { const id = VS.getId(); dispatch(id, { code: 0, data: url }, url.startsWith("/market/")); return VS.getPromise(id); };
  // Like the real glue, virtual_post calls VIRTUALSTATE.postId, which it never defines.
  mod.virtual_post = function (url, body) { const id = VS.postId(); dispatch(id, { code: 0, data: `${url} ${body}` }); return VS.getPromise(id); };
  return mod;
}

function runPageScript() {
  const sockets = [];
  class FakeSocket {
    constructor() { sockets.push(this); this.sent = []; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() {}
  }
  const sandbox = {
    WebSocket: FakeSocket,
    location: { protocol: "http:", host: "localhost:43100" },
    performance: { getEntriesByType: () => [{ name: "http://localhost:43100/node/defi/wart-node.js" }] },
    setTimeout, clearTimeout, clearInterval,
    // The page's status heartbeat must not keep the test process alive.
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(pageRelayScript(TOKEN), sandbox);
  return { sandbox, sockets };
}

const settleAll = (promises, ms = 300) => Promise.all(promises.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r("never answered"), ms))])));

test("chromium page relay queues node requests without a token", async () => {
  const sandbox = {
    performance: { getEntriesByType: () => [{ name: "http://localhost:43100/node/defi/wart-node.js" }] },
    setTimeout,
    clearTimeout,
    clearInterval,
  };
  sandbox.window = sandbox;
  const replies = [];
  sandbox.__hogMiningReply = (out) => replies.push(out);
  vm.runInNewContext(pageRelayPageScript(), sandbox);
  const node = brokenWasmNode();
  sandbox.wartNode = node;
  const page = node.virtual_get("/chain/head");
  const rpc = sandbox.__hogMiningRpc({ type: "rpc", id: 3, method: "GET", path: "/chain/mine/abc", network: "defi" });
  assert.equal((await page).data, "/chain/head");
  const result = await rpc;
  assert.equal(result.ok, true);
  assert.equal(result.result.data, "/chain/mine/abc");
  assert.equal(replies[0].id, 3);
  assert.equal(typeof result.result === "object" && JSON.stringify(result).includes("a".repeat(16)), false);
});

test("node page queues node requests so answers reach the right caller", async () => {
  // Without the queue the broken node loses all but the last of three answers.
  const raw = brokenWasmNode();
  raw.VIRTUALSTATE.postId = raw.VIRTUALSTATE.getId;
  const unqueued = await settleAll([raw.virtual_get("/chain/head"), raw.virtual_get("/chain/mine/x"), raw.virtual_post("/chain/append", "b")]);
  assert.deepEqual(unqueued.slice(0, 2), ["never answered", "never answered"]);

  const { sandbox, sockets } = runPageScript();
  const node = brokenWasmNode();
  sandbox.wartNode = node; // the page publishes its node; Hog queues it right away
  assert.equal(typeof node.__hogRpc, "function");
  const answers = await settleAll([
    node.virtual_get("/chain/head"),
    node.virtual_get("/market/x"),
    node.virtual_post("/chain/append", "block"),
  ], 1000);
  assert.deepEqual(answers.map((a) => a.data), ["/chain/head", "/market/x", "/chain/append block"]);
  assert.equal(node.__hogRpcStats.rerouted, 1, "the answer that came back under a stack value still reached its caller");

  // Relay requests from Hog go through the same queue and come back to Hog.
  const ws = sockets[0];
  ws.onopen();
  const page = node.virtual_get("/chain/head");
  ws.onmessage({ data: JSON.stringify({ type: "rpc", id: 7, method: "POST", path: "/chain/append", body: "blk", network: "defi" }) });
  ws.onmessage({ data: JSON.stringify({ type: "rpc", id: 8, method: "GET", path: "/chain/mine/abc", network: "defi" }) });
  assert.equal((await page).data, "/chain/head");
  await new Promise((r) => setTimeout(r, 200));
  const results = ws.sent.filter((m) => m.type === "rpc-result");
  assert.deepEqual(results.map((m) => [m.id, m.ok, m.result.data]), [[7, true, "/chain/append blk"], [8, true, "/chain/mine/abc"]]);
});
