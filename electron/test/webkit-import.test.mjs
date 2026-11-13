import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wk = require("../lib/webkit-import.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const bm = await import(path.join(here, "..", "..", "public", "bookmarks-store.js"));

function store(items, folders = []) {
  return JSON.stringify({ version: 2, seq: 50, folders: [{ id: "root", name: "Bookmarks", parent: null }, ...folders], items });
}
const item = (id, url, extra = {}) => ({ id, title: url, url, folder: "root", favorite: false, favOrder: 0, added: 1, ...extra });

test("a fresh preview takes Hog's bookmarks as they are", () => {
  const webkit = { "hog-bookmarks-v2": store([item("b1", "https://a.example/", { favorite: true }), item("b2", "https://b.example/", { folder: "f1" })], [{ id: "f1", name: "Work", parent: "root" }]) };
  const { store: out, added } = wk.mergeBookmarks({}, webkit, bm);
  assert.equal(added, 2);
  assert.equal(out.folders.length, 2);
  assert.equal(out.items.find((i) => i.url === "https://a.example/").favorite, true);
});

test("an used preview keeps its bookmarks and gets Hog's added, folders reused", () => {
  const mine = { "hog-bookmarks-v2": store([item("b9", "https://mine.example/"), item("b8", "https://a.example/")], [{ id: "f7", name: "Work", parent: "root" }]) };
  const webkit = {
    "hog-bookmarks-v2": store(
      [item("b1", "https://a.example/", { favorite: true, favOrder: 0 }), item("b2", "https://b.example/", { folder: "f1" }), item("b3", "https://c.example/", { folder: "f2" })],
      [{ id: "f1", name: "Work", parent: "root" }, { id: "f2", name: "Deep", parent: "f1" }],
    ),
  };
  const { store: out, added } = wk.mergeBookmarks(mine, webkit, bm);
  assert.equal(added, 2);
  assert.deepEqual(out.items.map((i) => i.url).sort(), ["https://a.example/", "https://b.example/", "https://c.example/", "https://mine.example/"]);
  assert.equal(out.folders.filter((f) => f.name === "Work").length, 1);
  const deep = out.folders.find((f) => f.name === "Deep");
  assert.equal(out.items.find((i) => i.url === "https://c.example/").folder, deep.id);
  assert.equal(out.items.find((i) => i.url === "https://a.example/").favorite, true);
});

test("history merges newest first, one per URL, capped", () => {
  const a = JSON.stringify([{ title: "A", url: "https://a.example/", at: 5 }, { title: "x", url: "javascript:1", at: 9 }]);
  const b = JSON.stringify([{ title: "A old", url: "https://a.example/", at: 1 }, { title: "B", url: "https://b.example/", at: 3 }]);
  assert.deepEqual(wk.mergeHistory(a, b).map((i) => i.title), ["A", "B"]);
  const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ url: `https://h${i}.example/`, at: i })));
  assert.equal(wk.mergeHistory("[]", many).length, 40);
  assert.deepEqual(wk.mergeHistory("bad", null), []);
});

test("import plan copies settings but never wallet keys; wallet has its own guarded plan", () => {
  const webkit = { "hog-display": "4", "hog-wallet-v1": "{secret}", "hog-account-name": "jax", "hog-history": "[]" };
  const plan = wk.planImport({}, webkit, bm);
  assert.equal(plan.writes["hog-display"], "4");
  assert.ok(!("hog-wallet-v1" in plan.writes));
  assert.ok(!("hog-account-name" in plan.writes));
  assert.equal(plan.summary.settings, 1);
  for (const key of wk.WALLET_KEYS) assert.ok(!wk.SETTINGS_KEYS.includes(key));
  assert.equal(wk.planWallet({ "hog-wallet-v1": "{mine}" }, webkit).ok, false);
  assert.equal(wk.planWallet({}, {}).ok, false);
  const w = wk.planWallet({}, webkit);
  assert.equal(w.ok, true);
  assert.deepEqual(w.writes, { "hog-wallet-v1": "{secret}", "hog-account-name": "jax" });
});

test("the python helper reads WebKit's localStorage format (UTF-16 values, WAL) without touching it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hogwk-"));
  const file = path.join(dir, "localstorage", "http_127.0.0.1_4188.localstorage");
  fs.mkdirSync(path.dirname(file));
  const py = `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL")
c.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)")
for k, v in [("hog-display", "4"), ("hog-history", '[{"url":"https://a.example/","title":"Ä","at":1}]'), ("hog-wallet-v1", "secret")]:
    c.execute("INSERT INTO ItemTable VALUES (?, ?)", (k, v.encode("utf-16-le")))
c.commit()
`;
  execFileSync("python3", ["-c", py, file]);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(wk.localStorageFile(dir), file);
  const out = JSON.parse(execFileSync("python3", [path.join(here, "..", "webkit-import.py"), file, "hog-display", "hog-history"]).toString());
  assert.equal(out.ok, true);
  assert.equal(out.items["hog-display"], "4");
  assert.equal(JSON.parse(out.items["hog-history"])[0].title, "Ä");
  assert.ok(!("hog-wallet-v1" in out.items));
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(wk.localStorageFile(path.join(dir, "nope")), "");
});
