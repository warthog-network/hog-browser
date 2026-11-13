"use strict";
// Import from the WebKit Hog: bookmarks + favorites, history, settings, and
// (only on its own explicit request) the encrypted wallet record.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BOOKMARK_KEYS = ["hog-bookmarks-v2", "hog-bookmarks"];
const HISTORY_KEY = "hog-history";
const SETTINGS_KEYS = [
  "hog-display",
  "hog-autolock",
  "hog-settings-accordions",
  "hog-files-prefs",
  "hog-tabs-spot-top",
  "hog-wallet-spot-top",
  "hog-wallet-open",
  "hog-tabs-open",
  "hog-wart-net",
];
const WALLET_KEYS = ["hog-wallet-v1", "hog-account-name", "hog-wallet-chain", "hog-dapp-sites"];
const HISTORY_CAP = 40; // app.js HISTORY_CAP

/** The WebKit Hog's localStorage file for its UI (http://127.0.0.1:<port>). */
function localStorageFile(hogData, port = 4188) {
  const dir = path.join(hogData, "localstorage");
  const preferred = path.join(dir, `http_127.0.0.1_${port}.localstorage`);
  if (fs.existsSync(preferred)) return preferred;
  try {
    const found = fs
      .readdirSync(dir)
      .filter((name) => /^http_127\.0\.0\.1_\d+\.localstorage$/.test(name))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return found[0] || "";
  } catch {
    return "";
  }
}

function readWebKit({ python = "python3", helper, file, keys }) {
  return new Promise((resolve) => {
    execFile(python, [helper, file, ...keys], { timeout: 20000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }, (error, stdout) => {
      let out = null;
      try {
        out = JSON.parse(String(stdout || "").trim().split("\n").pop());
      } catch {
        out = null;
      }
      if (out && typeof out === "object") return resolve(out);
      resolve({ ok: false, error: error ? `Could not read Hog's saved data (${error.message.split("\n")[0]}).` : "Could not read Hog's saved data." });
    });
  });
}

function parseList(raw) {
  try {
    const list = JSON.parse(raw || "null");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Newest first, one entry per URL, capped like the Hog UI. */
function mergeHistory(previewRaw, webkitRaw, cap = HISTORY_CAP) {
  const all = [...parseList(previewRaw), ...parseList(webkitRaw)]
    .filter((item) => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url))
    .map((item) => ({ title: String(item.title || "").slice(0, 300), url: item.url.slice(0, 4096), at: Number(item.at) || 0 }))
    .sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const item of all) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

function onlySeed(store, bm) {
  const seed = new Set(bm.SEED.map((s) => bm.urlKey(s.url)));
  return store.items.every((item) => seed.has(bm.urlKey(item.url))) && store.folders.length <= 1;
}

/** Merge the WebKit Hog's bookmark store into the preview's.
 *  bm is public/bookmarks-store.js. A fresh preview (nothing but the seed
 *  bookmarks) simply takes the WebKit store as it is. */
function mergeBookmarks(previewItems, webkitItems, bm, now = Date.now()) {
  const fromWebKit = bm.loadStore(mapStorage(webkitItems), now).store;
  const mine = bm.loadStore(mapStorage(previewItems), now).store;
  if (onlySeed(mine, bm)) return { store: fromWebKit, added: fromWebKit.items.length };
  let store = mine;
  const folderMap = new Map([[bm.ROOT_ID, bm.ROOT_ID]]);
  const pending = fromWebKit.folders.filter((f) => f.id !== bm.ROOT_ID);
  // Parents before children; folders with the same name and parent are reused.
  for (let guard = 0; pending.length && guard < 10000; guard += 1) {
    const folder = pending.shift();
    if (!folderMap.has(folder.parent)) {
      pending.push(folder);
      continue;
    }
    const parent = folderMap.get(folder.parent);
    const existing = store.folders.find((f) => f.parent === parent && f.name === folder.name);
    if (existing) {
      folderMap.set(folder.id, existing.id);
      continue;
    }
    const made = bm.addFolder(store, folder.name, parent);
    store = made.store;
    folderMap.set(folder.id, made.folder.id);
  }
  let added = 0;
  // addBookmark puts new items first, so walk backwards to keep Hog's order.
  for (const item of [...fromWebKit.items].reverse()) {
    if (bm.findByUrl(store, item.url)) continue;
    try {
      store = bm.addBookmark(store, { title: item.title, url: item.url, folder: folderMap.get(item.folder) || bm.ROOT_ID }, now).store;
      added += 1;
    } catch {
      /* not an http(s) bookmark */
    }
  }
  for (const item of bm.favorites(fromWebKit)) {
    const have = bm.findByUrl(store, item.url);
    if (have && !have.favorite) store = bm.updateBookmark(store, have.id, { favorite: true });
  }
  return { store, added };
}

function mapStorage(items) {
  const data = { ...(items || {}) };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) && typeof data[key] === "string" ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
  };
}

/** What to write into the preview's localStorage, and a summary for the dialog. */
function planImport(previewItems, webkitItems, bm, now = Date.now()) {
  const writes = {};
  const { store, added } = mergeBookmarks(previewItems, webkitItems, bm, now);
  writes[bm.STORE_KEY] = JSON.stringify(store);
  const history = mergeHistory(previewItems[HISTORY_KEY], webkitItems[HISTORY_KEY]);
  writes[HISTORY_KEY] = JSON.stringify(history);
  let settings = 0;
  for (const key of SETTINGS_KEYS) {
    if (typeof webkitItems[key] === "string") {
      writes[key] = webkitItems[key];
      settings += 1;
    }
  }
  const favorites = store.items.filter((i) => i.favorite).length;
  return {
    writes,
    summary: {
      bookmarks: store.items.length,
      added,
      favorites,
      history: parseList(webkitItems[HISTORY_KEY]).length,
      settings,
    },
  };
}

/** Wallet: never replaces a wallet the preview already has. */
function planWallet(previewItems, webkitItems) {
  if (!webkitItems["hog-wallet-v1"]) return { ok: false, error: "The WebKit Hog has no wallet saved." };
  if (previewItems["hog-wallet-v1"]) return { ok: false, error: "The preview already has a wallet. Remove it first (Wallet → settings) if you want to copy Hog's." };
  const writes = {};
  for (const key of WALLET_KEYS) if (typeof webkitItems[key] === "string") writes[key] = webkitItems[key];
  return { ok: true, writes };
}

module.exports = {
  BOOKMARK_KEYS,
  HISTORY_KEY,
  SETTINGS_KEYS,
  WALLET_KEYS,
  localStorageFile,
  readWebKit,
  mergeHistory,
  mergeBookmarks,
  planImport,
  planWallet,
};
