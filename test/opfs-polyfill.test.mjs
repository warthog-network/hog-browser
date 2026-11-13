import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { applyOpfs } from "../server.mjs";

const POLYFILL = readFileSync(new URL("../opfs-polyfill.js", import.meta.url), "utf8");

function batch(list) {
  const parts = [];
  for (const { at, bytes } of list) {
    const head = Buffer.alloc(12);
    head.writeDoubleLE(at, 0);
    head.writeUInt32LE(bytes.length, 8);
    parts.push(head, Buffer.from(bytes));
  }
  return Buffer.concat(parts);
}

test("node storage applies a write batch in order and can fsync it", async () => {
  const root = await mkdtemp(join(tmpdir(), "hog-opfs-"));
  try {
    await applyOpfs(root, "create", "chain.db3");
    const body = batch([
      { at: 0, bytes: [1, 2, 3, 4] },
      { at: 10, bytes: [9, 9] },
      { at: 2, bytes: [7] },
    ]);
    const res = await applyOpfs(root, "writev", "chain.db3", body, { sync: "1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "7");
    const disk = await readFile(join(root, "chain.db3"));
    assert.deepEqual([...disk], [1, 2, 7, 4, 0, 0, 0, 0, 0, 0, 9, 9]);
    await assert.rejects(() => applyOpfs(root, "writev", "chain.db3", Buffer.from([1, 2, 3])), /Bad write batch/);
    const short = batch([{ at: 0, bytes: [1, 2, 3] }]).subarray(0, 14);
    await assert.rejects(() => applyOpfs(root, "writev", "chain.db3", short), /Bad write batch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The polyfill in a sandbox, backed by an in-memory copy of Hog's storage endpoint. */
function sandbox() {
  const files = new Map([["", null]]);
  const locks = new Map();
  const calls = [];
  const reply = (status, text) => ({ status, text: String(text) });
  function serve(op, params, body) {
    const path = params.get("path") || "";
    calls.push(op);
    const file = files.get(path);
    if (op === "stat") return reply(200, !files.has(path) ? "missing" : file === null ? "directory" : "file");
    if (op === "create") { if (!files.has(path)) files.set(path, Buffer.alloc(0)); return reply(200, "ok"); }
    if (op === "mkdir") { files.set(path, null); return reply(200, "ok"); }
    if (op === "lock") { if (locks.has(path)) return reply(409, "locked"); locks.set(path, "t"); return reply(200, "t"); }
    if (op === "unlock") { locks.delete(path); return reply(200, "ok"); }
    if (op === "touch" || op === "flush") return reply(200, "ok");
    if (op === "size") return reply(200, file.length);
    if (op === "read") {
      const at = Number(params.get("at"));
      const len = Number(params.get("len"));
      return reply(200, file.subarray(Math.min(at, file.length), Math.min(at + len, file.length)).toString("base64"));
    }
    const put = (at, bytes) => {
      let next = files.get(path);
      if (next.length < at + bytes.length) next = Buffer.concat([next, Buffer.alloc(at + bytes.length - next.length)]);
      Buffer.from(bytes).copy(next, at);
      files.set(path, next);
    };
    if (op === "write") { put(Number(params.get("at")), body); return reply(200, body.length); }
    if (op === "writev") {
      for (let pos = 0; pos < body.length;) {
        const at = body.readDoubleLE(pos);
        const len = body.readUInt32LE(pos + 8);
        put(at, body.subarray(pos + 12, pos + 12 + len));
        pos += 12 + len;
      }
      return reply(200, "ok");
    }
    if (op === "truncate") {
      const size = Number(params.get("size"));
      const cur = files.get(path);
      files.set(path, size <= cur.length ? Buffer.from(cur.subarray(0, size)) : Buffer.concat([cur, Buffer.alloc(size - cur.length)]));
      return reply(200, "ok");
    }
    return reply(400, "unknown");
  }
  class XMLHttpRequest {
    open(method, url) { this.url = new URL(url); }
    send(body) {
      const out = serve(this.url.searchParams.get("op"), this.url.searchParams, body ? Buffer.from(body) : Buffer.alloc(0));
      this.status = out.status;
      this.responseText = out.text;
    }
  }
  class StorageManager {}
  const timers = [];
  const context = {
    XMLHttpRequest,
    StorageManager,
    DOMException: class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } },
    atob: (text) => Buffer.from(text, "base64").toString("latin1"),
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    location: { origin: "http://localhost:43100" },
  };
  context.self = context;
  context.navigator = { storage: new StorageManager() };
  vm.createContext(context);
  vm.runInContext(POLYFILL, context);
  return { context, files, calls };
}

test("node storage handle caches reads and holds writes until flush", async () => {
  const { context, files, calls } = sandbox();
  const root = await context.navigator.storage.getDirectory();
  const fh = await root.getFileHandle("chain.db3", { create: true });
  const h = await fh.createSyncAccessHandle();
  const model = Buffer.alloc(0);
  let ref = model;
  const write = (bytes, at) => {
    const data = Buffer.from(bytes);
    if (ref.length < at + data.length) ref = Buffer.concat([ref, Buffer.alloc(at + data.length - ref.length)]);
    data.copy(ref, at);
    assert.equal(h.write(new Uint8Array(data), { at }), data.length);
  };
  const check = (at, len) => {
    const out = new Uint8Array(len);
    const n = h.read(out, { at });
    const want = ref.subarray(Math.min(at, ref.length), Math.min(at + len, ref.length));
    assert.equal(n, want.length);
    assert.deepEqual(Buffer.from(out.subarray(0, n)), Buffer.from(want));
  };

  calls.length = 0;
  for (let i = 0; i < 200; i += 1) write(Buffer.alloc(4096, i & 255), i * 4096);
  assert.equal(calls.length, 0, "writes wait for flush");
  check(0, 4096);
  check(4096 * 50 + 100, 9000);
  check(4096 * 199, 8192); // runs past the end
  assert.equal(calls.length, 0, "reads of held writes need no round trip");
  assert.equal(await h.getSize(), 200 * 4096);
  await h.flush();
  assert.deepEqual(calls, ["writev"]);
  assert.deepEqual(files.get("chain.db3"), ref);

  // Random reads, writes and truncates match a plain byte model.
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let step = 0; step < 3000; step += 1) {
    const kind = rand(20);
    if (kind < 9) check(rand(1_200_000), 1 + rand(70_000));
    else if (kind < 18) write(Buffer.alloc(1 + rand(20_000), rand(256)), rand(1_000_000));
    else if (kind === 18) {
      const size = rand(1_100_000);
      await h.truncate(size);
      ref = size <= ref.length ? Buffer.from(ref.subarray(0, size)) : Buffer.concat([ref, Buffer.alloc(size - ref.length)]);
    } else {
      await h.flush();
      assert.deepEqual(files.get("chain.db3"), ref);
    }
    assert.equal(await h.getSize(), ref.length);
  }
  const reads = calls.filter((op) => op === "read").length;
  const writes = calls.filter((op) => op === "write" || op === "writev").length;
  assert.ok(reads < 600, `read cache: ${reads} reads for ~1350 read calls`);
  assert.ok(writes < 400, `write batching: ${writes} writes for ~1350 write calls`);

  write([5, 5, 5], 3);
  await h.close();
  assert.deepEqual(files.get("chain.db3"), ref, "close writes what flush has not");
  const again = await fh.createSyncAccessHandle();
  const out = new Uint8Array(3);
  again.read(out, { at: 3 });
  assert.deepEqual([...out], [5, 5, 5]);
  await again.close();
});

test("reading a file outside its sync handle sees held writes", async () => {
  const { context, files } = sandbox();
  const root = await context.navigator.storage.getDirectory();
  const fh = await root.getFileHandle("rxtx.db3", { create: true });
  const h = await fh.createSyncAccessHandle();
  h.write(new Uint8Array([1, 2, 3]), { at: 0 });
  assert.equal(files.get("rxtx.db3").length, 0);
  const file = await fh.getFile();
  assert.equal(file.size, 3);
  const bytes = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3]);
  await h.close();
});
