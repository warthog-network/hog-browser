import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import {
  applyOpfs,
  logOpfs,
  nodeRecoveryScript,
  nodeHeadHeight,
  nodeSyncedFlag,
  NODE_STALL_MS,
  opfsErrorStatus,
  opfsLogInternals,
  rewriteHtml,
  siteHttpServer,
} from "../server.mjs";

const POLYFILL = readFileSync(new URL("../opfs-polyfill.js", import.meta.url), "utf8");
const FIXTURE = new URL("./fixtures/opfs-fault-server.mjs", import.meta.url);

test("a retried lock with the same token is granted again; another tab is still refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "hog-opfs-lock-"));
  try {
    await applyOpfs(root, "create", "chain.db3");
    const mine = "a".repeat(24);
    const other = "b".repeat(24);
    assert.equal((await applyOpfs(root, "lock", "chain.db3", undefined, { token: mine })).body.toString(), mine);
    assert.equal((await applyOpfs(root, "lock", "chain.db3", undefined, { token: mine })).status, 200, "retry of our own lock");
    assert.equal((await applyOpfs(root, "lock", "chain.db3", undefined, { token: other })).status, 409);
    assert.equal((await applyOpfs(root, "lock", "chain.db3")).status, 409, "server-made token still refused");
    await assert.rejects(() => applyOpfs(root, "lock", "chain.db3", undefined, { token: "nope" }), /Bad lock token/);
    assert.equal((await applyOpfs(root, "touch", "chain.db3", undefined, { token: other })).status, 409);
    assert.equal((await applyOpfs(root, "unlock", "chain.db3", undefined, { token: other })).status, 409);
    assert.equal((await applyOpfs(root, "unlock", "chain.db3", undefined, { token: mine })).status, 200);
    assert.equal((await applyOpfs(root, "unlock", "chain.db3", undefined, { token: mine })).status, 200, "retried unlock");
    // A touch re-takes a lock the server lost (restart), so the holder keeps it.
    assert.equal((await applyOpfs(root, "touch", "chain.db3", undefined, { token: mine })).status, 200);
    assert.equal((await applyOpfs(root, "lock", "chain.db3", undefined, { token: other })).status, 409);
    assert.equal((await applyOpfs(root, "unlock", "chain.db3", undefined, { token: mine })).status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage errors map to retryable 5xx only when a retry can help", () => {
  assert.equal(opfsErrorStatus(Object.assign(new Error("x"), { status: 413 })), 413);
  assert.equal(opfsErrorStatus(Object.assign(new Error("x"), { code: "EMFILE" })), 503);
  assert.equal(opfsErrorStatus(Object.assign(new Error("x"), { code: "EAGAIN" })), 503);
  assert.equal(opfsErrorStatus(Object.assign(new Error("x"), { code: "ENOENT" })), 400);
  assert.equal(opfsErrorStatus(Object.assign(new Error("x"), { code: "EIO" })), 500);
  assert.equal(opfsErrorStatus(new Error("Request body is too large")), 400);
});

test("failed storage calls are logged at most 20 lines a minute, then summarised", () => {
  const lines = [];
  const saved = { ...opfsLogInternals };
  opfsLogInternals.write = (line) => lines.push(line);
  opfsLogInternals.windowStart = 0;
  opfsLogInternals.lines = 0;
  opfsLogInternals.suppressed = 0;
  try {
    const t0 = 10_000_000;
    for (let i = 0; i < 50; i += 1) logOpfs(`opfs: line ${i}`, t0 + i);
    assert.equal(lines.length, 20);
    logOpfs("opfs: next minute", t0 + 60_001);
    assert.match(lines[20], /30 more storage messages/);
    assert.equal(lines[21], "opfs: next minute");
  } finally {
    Object.assign(opfsLogInternals, saved);
  }
});

test("site servers keep idle keep-alive connections open past the browser's reuse", () => {
  const server = siteHttpServer(() => {});
  assert.ok(server.keepAliveTimeout >= 60_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

test("the node page gets Hog's recovery script; other sites do not", () => {
  const node = rewriteHtml("<html><head></head><body></body></html>", "https://browser-node.netlify.app/");
  assert.match(node, /__hogNodeRecovery/);
  const other = rewriteHtml("<html><head></head><body></body></html>", "https://example.com/");
  assert.doesNotMatch(other, /__hogNodeRecovery/);
});

/** The recovery script against a fake node page. */
function recoveryPage({ text = "", channel = true, stallMs = 3 * 60_000, head = null, running = false } = {}) {
  const store = new Map();
  const listeners = [];
  const posted = [];
  let now = 1_000_000;
  let reloads = 0;
  let clicks = 0;
  const tickers = [];
  const button = { textContent: running ? "Stop node" : "Start node", disabled: false, click() { clicks += 1; } };
  let headValue = head;
  const body = { innerText: text, appendChild() {} };
  const context = {
    Date: { now: () => now },
    JSON,
    Math,
    String,
    Promise,
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    document: {
      body,
      querySelectorAll: () => [button],
      createElement: () => ({ setAttribute() {}, style: {} }),
    },
    location: { reload() { reloads += 1; } },
    parent: { postMessage: (m) => posted.push(m) },
    setInterval: (fn) => tickers.push(fn),
    wartNode: {
      virtual_get: (path) => {
        if (path !== "/chain/head") return Promise.reject(new Error("unexpected path"));
        return Promise.resolve(headValue);
      },
    },
  };
  if (channel) {
    context.BroadcastChannel = class {
      constructor() { listeners.push(this); }
    };
  }
  context.window = context;
  vm.createContext(context);
  vm.runInContext(nodeRecoveryScript({ waitMs: 65_000, quietMs: 30 * 60_000, stallMs }), context);
  return {
    body,
    button,
    setHead(next) { headValue = next; },
    tick(ms = 2000) { now += ms; for (const fn of tickers) fn(); },
    fail() { for (const l of listeners) l.onmessage?.({ data: { type: "storage-failure" } }); },
    reloadPage() {
      // A reload runs the script again in a fresh page with the same sessionStorage.
      tickers.length = 0;
      listeners.length = 0;
      context.window.__hogNodeRecovery = false;
      vm.runInContext(nodeRecoveryScript({ waitMs: 65_000, quietMs: 30 * 60_000, stallMs }), context);
    },
    get reloads() { return reloads; },
    get clicks() { return clicks; },
    posted,
  };
}

test("after a Hog storage failure the node page reloads once and presses Start after the lock lapses", () => {
  const page = recoveryPage();
  page.tick();
  assert.equal(page.reloads, 0, "nothing to do while the node runs");
  page.fail();
  page.body.innerText = "SQLite disk I/O error opening chain.db3. Common causes: ...";
  page.tick();
  assert.equal(page.reloads, 1);
  page.reloadPage();
  page.body.innerText = "Start node";
  page.tick(30_000);
  assert.equal(page.clicks, 0, "waits for the old storage lock to lapse");
  page.tick(36_000);
  assert.equal(page.clicks, 1);
  assert.ok(page.posted.some((m) => m.type === "node-autorestart"));
  // A second failure within 30 minutes is left for the user.
  page.fail();
  page.body.innerText = "SQLite disk I/O error opening chain.db3.";
  page.tick(60_000);
  assert.equal(page.reloads, 1);
  // Much later, one more automatic restart is allowed.
  page.tick(31 * 60_000);
  page.fail();
  page.tick();
  assert.equal(page.reloads, 2);
});

test("the node page is not restarted for corruption or for errors Hog's storage did not cause", () => {
  const corrupt = recoveryPage();
  corrupt.fail();
  corrupt.body.innerText = "SQLite disk I/O error opening chain.db3 ... database disk image is malformed";
  corrupt.tick();
  assert.equal(corrupt.reloads, 0);
  const notOurs = recoveryPage();
  notOurs.body.innerText = "SQLite disk I/O error opening chain.db3.";
  notOurs.tick();
  assert.equal(notOurs.reloads, 0, "no storage failure was reported by Hog's polyfill");
});


test("nodeHeadHeight reads the same payload shapes as the in-page node", () => {
  assert.equal(nodeHeadHeight({ data: { height: 2778390, synced: false } }), 2778390);
  assert.equal(nodeHeadHeight({ chainHead: { height: 12, synced: true } }), 12);
  assert.equal(nodeHeadHeight('{"data":{"height":"100","synced":false}}'), 100);
  assert.equal(nodeHeadHeight({ synced: true }), 0);
  assert.equal(nodeSyncedFlag({ data: { height: 2778390, synced: false } }), false);
  assert.equal(NODE_STALL_MS, 3 * 60_000);
});

test("a running unsynced node whose height is stuck is reloaded and Start is pressed", async () => {
  const page = recoveryPage({
    running: true,
    stallMs: 180_000,
    head: { data: { height: 2778390, synced: false } },
  });
  page.tick();
  await Promise.resolve();
  assert.equal(page.reloads, 0, "needs a few minutes with no progress first");
  page.tick(120_000);
  await Promise.resolve();
  assert.equal(page.reloads, 0);
  page.tick(60_000);
  await Promise.resolve();
  assert.equal(page.reloads, 1);
  assert.ok(page.posted.some((m) => m.type === "node-stall-restart"));
  page.reloadPage();
  page.button.textContent = "Start node";
  page.tick(30_000);
  assert.equal(page.clicks, 0, "waits for the old storage lock to lapse");
  page.tick(36_000);
  assert.equal(page.clicks, 1);
  // A second stall within the quiet window is left for the user.
  page.button.textContent = "Stop node";
  page.tick(180_000);
  await Promise.resolve();
  assert.equal(page.reloads, 1);
});

test("the stall watchdog does not restart a node that is still advancing, synced, or stopped", async () => {
  const advancing = recoveryPage({
    running: true,
    stallMs: 180_000,
    head: { data: { height: 100, synced: false } },
  });
  advancing.tick();
  await Promise.resolve();
  advancing.setHead({ data: { height: 200, synced: false } });
  advancing.tick(180_000);
  await Promise.resolve();
  assert.equal(advancing.reloads, 0);

  const synced = recoveryPage({
    running: true,
    stallMs: 60_000,
    head: { data: { height: 2778390, synced: true } },
  });
  synced.tick();
  await Promise.resolve();
  synced.tick(120_000);
  await Promise.resolve();
  assert.equal(synced.reloads, 0);

  const stopped = recoveryPage({
    running: false,
    stallMs: 60_000,
    head: { data: { height: 2778390, synced: false } },
  });
  stopped.tick();
  await Promise.resolve();
  stopped.tick(180_000);
  await Promise.resolve();
  assert.equal(stopped.reloads, 0);
});

// ---------------------------------------------------------------------------
// The polyfill over real HTTP to Hog's site server, with injected faults.

async function startFaultServer(env) {
  const dir = await mkdtemp(join(tmpdir(), "hog-opfs-fault-"));
  const child = spawn(process.execPath, [FIXTURE.pathname], {
    env: {
      ...process.env,
      HOG_NODE_PORT: "0",
      HOG_OPFS_ROOT: join(dir, "opfs"),
      HOG_DATA: join(dir, "data"),
      HOG_MOBILE_NO_TAILNET: "1",
      HOG_JELLYFIN_LAN_NO_LAN: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  lines.on("line", (line) => {
    if (!line.startsWith("{")) return; // fault-injection notes from the server
    const value = JSON.parse(line);
    if (waiters.length) waiters.shift()(value);
    else queue.push(value);
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)));
  const ready = await next();
  return {
    ...ready,
    dir,
    store: join(dir, "opfs", "https_browser-node.netlify.app"),
    async stats() {
      child.stdin.write("stats\n");
      return next();
    },
    async stop() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Synchronous HTTP for the sandboxed polyfill: a worker does the request while this thread waits. */
function syncHttpClient() {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
     const http = require("node:http");
     const agent = new http.Agent({ keepAlive: true });
     const { flag, port } = workerData;
     port.on("message", ({ method, url, body }) => {
       const done = (out) => { port.postMessage(out); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };
       const req = http.request(url, { method, agent, headers: { host: new URL(url).host } }, (res) => {
         const chunks = [];
         res.on("data", (c) => chunks.push(c));
         res.on("end", () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString("latin1") }));
         res.on("error", () => done({ status: 0, text: "" }));
       });
       req.on("error", () => done({ status: 0, text: "" }));
       req.end(body ? Buffer.from(body) : undefined);
     });`,
    { eval: true, workerData: { flag, port: port2 }, transferList: [port2] },
  );
  return {
    send(method, url, body) {
      Atomics.store(flag, 0, 0);
      port1.postMessage({ method, url, body: body ? new Uint8Array(body) : null });
      Atomics.wait(flag, 0, 0, 30_000);
      const reply = receiveMessageOnPort(port1);
      return reply ? reply.message : { status: 0, text: "" };
    },
    close() { return worker.terminate(); },
  };
}

function polyfillOverHttp(port, client, { delays } = {}) {
  const failures = [];
  const methods = {};
  class XMLHttpRequest {
    open(method, url) { this.method = method; this.url = url; }
    send(body) {
      const op = new URL(this.url).searchParams.get("op");
      methods[op] = this.method;
      const out = client.send(this.method, this.url, body);
      this.status = out.status;
      this.responseText = out.text;
    }
  }
  class StorageManager {}
  const context = {
    XMLHttpRequest,
    StorageManager,
    DOMException: class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } },
    atob: (text) => Buffer.from(text, "base64").toString("latin1"),
    setInterval: () => 1,
    clearInterval: () => {},
    location: { origin: `http://localhost:${port}` },
    crypto: globalThis.crypto,
    BroadcastChannel: class { postMessage(m) { failures.push(m); } close() {} },
    __hogOpfsRetryDelays: delays,
  };
  context.self = context;
  context.navigator = { storage: new StorageManager() };
  vm.createContext(context);
  vm.runInContext(POLYFILL, context);
  return { context, failures, methods, stats: context.__hogOpfsStats };
}

function byteModel() {
  let ref = Buffer.alloc(0);
  return {
    write(at, data) {
      if (ref.length < at + data.length) ref = Buffer.concat([ref, Buffer.alloc(at + data.length - ref.length)]);
      data.copy(ref, at);
    },
    truncate(size) {
      ref = size <= ref.length ? Buffer.from(ref.subarray(0, size)) : Buffer.concat([ref, Buffer.alloc(size - ref.length)]);
    },
    get bytes() { return ref; },
  };
}

test("the node keeps working through 20% injected storage faults with no lost or corrupted data", { timeout: 120_000 }, async () => {
  const server = await startFaultServer({ HOG_OPFS_FAULTS: "0.2" });
  const client = syncHttpClient();
  try {
    assert.ok(server.hosts.includes("::1"), "the page port also listens on ::1");
    const { context, failures, methods, stats } = polyfillOverHttp(server.port, client);
    const root = await context.navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("mainnet", { create: true });
    const fh = await dir.getFileHandle("chain.db3", { create: true });
    let h = await fh.createSyncAccessHandle();
    const model = byteModel();
    let seed = 99;
    const rand = (n) => {
      // mulberry32: every branch below gets exercised
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const kinds = {};
    for (let step = 0; step < 4000; step += 1) {
      const kind = rand(40);
      kinds[kind < 16 ? "read" : kind < 34 ? "write" : kind < 36 ? "truncate" : kind < 39 ? "flush" : "reopen"] = true;
      if (kind < 16) {
        const at = rand(3_000_000);
        const out = new Uint8Array(1 + rand(40_000));
        const n = h.read(out, { at });
        const want = model.bytes.subarray(Math.min(at, model.bytes.length), Math.min(at + out.length, model.bytes.length));
        assert.equal(n, want.length);
        assert.ok(Buffer.from(out.subarray(0, n)).equals(want), `read at ${at} step ${step}`);
      } else if (kind < 34) {
        const data = Buffer.alloc(1 + rand(30_000), rand(256));
        data[0] = step & 255;
        const at = rand(2_800_000);
        h.write(new Uint8Array(data), { at });
        model.write(at, data);
      } else if (kind < 36) {
        const size = rand(3_000_000);
        await h.truncate(size);
        model.truncate(size);
      } else if (kind < 39) {
        await h.flush();
      } else {
        // Close and reopen, as SQLite does with its journal.
        await h.close();
        h = await fh.createSyncAccessHandle();
      }
      assert.equal(await h.getSize(), model.bytes.length);
    }
    await h.close();
    const disk = await readFile(join(server.store, "mainnet", "chain.db3"));
    assert.ok(disk.equals(model.bytes), "the file on disk matches every write in order");

    // Directory operations under faults: create, move, remove.
    for (let i = 0; i < 40; i += 1) {
      const f = await dir.getFileHandle(`journal-${i}`, { create: true });
      const a = await f.createSyncAccessHandle();
      a.write(new Uint8Array([i]), { at: 0 });
      await a.close();
      if (i % 2) await f.move(dir, `moved-${i}`);
      await dir.removeEntry(i % 2 ? `moved-${i}` : `journal-${i}`);
    }
    const left = [];
    for await (const [name] of dir.entries()) left.push(name);
    assert.deepEqual(left, ["chain.db3"]);

    const injected = await server.stats();
    assert.ok(injected.injected > 30, `faults were injected (${injected.injected} of ${injected.calls})`);
    assert.ok(stats.retries >= injected.injected * 0.9, `retries ${stats.retries}`);
    assert.equal(stats.failures, 0, "no call gave up");
    assert.equal(failures.length, 0);
    assert.deepEqual(Object.keys(kinds).sort(), ["flush", "read", "reopen", "truncate", "write"]);
    assert.equal(methods.read, "GET");
    assert.equal(methods.writev, "PUT");
    assert.equal(methods.truncate, "PUT");
    assert.equal(methods.remove, "POST");
  } finally {
    await client.close();
    await server.stop();
  }
});

test("a flush that fails keeps its writes held and reports the error; they land once storage is back", { timeout: 60_000 }, async () => {
  // Calls 1-4 open the file (stat, create, lock, size); the outage hits the flush.
  const server = await startFaultServer({ HOG_OPFS_OUTAGE: "5:800" });
  const client = syncHttpClient();
  try {
    const { context, failures, stats } = polyfillOverHttp(server.port, client, { delays: [5, 5, 5] });
    const root = await context.navigator.storage.getDirectory();
    const fh = await root.getFileHandle("chain.db3", { create: true });
    const h = await fh.createSyncAccessHandle();
    const data = Buffer.alloc(100_000, 7);
    h.write(new Uint8Array(data), { at: 4096 });
    await assert.rejects(async () => h.flush(), (error) => error.name === "NotReadableError");
    assert.equal(stats.failures, 1);
    assert.equal(failures[0].type, "storage-failure");
    await assert.rejects(async () => h.close(), (error) => error.name === "NotReadableError", "close reports it too");
    const check = new Uint8Array(10);
    assert.equal(h.read(check, { at: 4096 }), 10, "held writes stay readable");
    assert.deepEqual([...check], Array(10).fill(7));
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Reopening finishes the failed close first: the held writes reach the disk.
    const again = await fh.createSyncAccessHandle();
    const disk = await readFile(join(server.store, "chain.db3"));
    assert.equal(disk.length, 4096 + data.length);
    assert.ok(disk.subarray(4096).equals(data));
    await again.close();
  } finally {
    await client.close();
    await server.stop();
  }
});

test("the node page's storage endpoint refuses other sites and unsafe GETs", { timeout: 30_000 }, async () => {
  const server = await startFaultServer({});
  const call = (method, query, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method, path: `/__hog/opfs?${query}`, headers: { host: `localhost:${server.port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal(await call("GET", "op=stat&path=x"), 200);
    assert.equal(await call("GET", "op=remove&path=x"), 405);
    assert.equal(await call("PUT", "op=mkdir&path=d", { origin: `http://localhost:${server.port}`, "sec-fetch-site": "same-origin" }), 200);
    assert.equal(await call("POST", "op=remove&path=d&recursive=1", { origin: "https://evil.example" }), 403);
    assert.equal(await call("POST", "op=remove&path=d&recursive=1", { "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await call("POST", "op=remove&path=d&recursive=1", { origin: `http://localhost:${server.port}` }), 200);
  } finally {
    await server.stop();
  }
});
