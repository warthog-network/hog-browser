// Hog bookmarks: one store for bookmarks, folders, and favorites.
// Favorites are bookmarks with `favorite: true`, ordered by `favOrder`.
// Pure functions only, so the same code runs in the page and in node tests.

export const STORE_KEY = "hog-bookmarks-v2";
export const LEGACY_KEY = "hog-bookmarks";
export const BACKUP_KEY = "hog-bookmarks-v1-backup";
export const ROOT_ID = "root";
export const STORE_VERSION = 2;
const MAX_TITLE = 300;
const MAX_URL = 4096;
const MAX_FOLDER = 120;
const DDG_HOME = "https://duckduckgo.com/";

export const SEED = [
  { title: "DuckDuckGo", url: DDG_HOME },
  { title: "warthog-network", url: "https://github.com/warthog-network" },
  { title: "Warthog node", url: "https://browser-node.netlify.app/" },
];

export function emptyStore() {
  return {
    version: STORE_VERSION,
    seq: 1,
    folders: [{ id: ROOT_ID, name: "Bookmarks", parent: null }],
    items: [],
  };
}

function clone(store) {
  return JSON.parse(JSON.stringify(store));
}

function nextId(store, prefix) {
  const id = `${prefix}${store.seq.toString(36)}`;
  store.seq += 1;
  return id;
}

function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Only http and https bookmarks are kept. Returns "" for anything else. */
export function safeUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > MAX_URL) return "";
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  if (!url.hostname) return "";
  if (url.hostname === "html.duckduckgo.com" && /^\/html(?:\/|$)/.test(url.pathname)) {
    const query = url.searchParams.get("q");
    return query ? `https://duckduckgo.com/?q=${encodeURIComponent(query)}` : DDG_HOME;
  }
  return url.href;
}

/** Key used to find duplicates: same page, ignoring case of host, default ports, a bare trailing slash, and an empty hash. */
export function urlKey(raw) {
  const href = safeUrl(raw);
  if (!href) return "";
  const url = new URL(href);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const host = url.hostname.replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const scheme = url.protocol === "http:" ? "http" : "https";
  return `${scheme}://${host}${port}${path}${url.search}${url.hash && url.hash !== "#" ? url.hash : ""}`;
}

export function hostLabel(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return String(raw || "");
  }
}

function folderExists(store, id) {
  return store.folders.some((folder) => folder.id === id);
}

/** Repairs anything malformed so the UI never trips over saved data. */
export function sanitizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object") return store;
  const seq = Number(raw.seq);
  store.seq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
  const ids = new Set([ROOT_ID]);
  const folders = Array.isArray(raw.folders) ? raw.folders : [];
  for (const folder of folders) {
    const id = cleanText(folder?.id, 40);
    if (!id || ids.has(id)) {
      if (id === ROOT_ID && folder?.name) store.folders[0].name = cleanText(folder.name, MAX_FOLDER) || "Bookmarks";
      continue;
    }
    ids.add(id);
    store.folders.push({ id, name: cleanText(folder.name, MAX_FOLDER) || "Folder", parent: cleanText(folder.parent, 40) || ROOT_ID });
  }
  for (const folder of store.folders) {
    if (folder.id === ROOT_ID) continue;
    if (!ids.has(folder.parent) || folder.parent === folder.id) folder.parent = ROOT_ID;
  }
  // Break any parent cycles by hanging the folder off the root.
  for (const folder of store.folders) {
    const seen = new Set();
    let cursor = folder;
    while (cursor && cursor.id !== ROOT_ID) {
      if (seen.has(cursor.id)) {
        folder.parent = ROOT_ID;
        break;
      }
      seen.add(cursor.id);
      cursor = store.folders.find((item) => item.id === cursor.parent);
    }
  }
  const itemIds = new Set();
  const keys = new Set();
  const items = Array.isArray(raw.items) ? raw.items : [];
  for (const item of items) {
    const url = safeUrl(item?.url);
    const key = urlKey(url);
    if (!url || keys.has(key)) continue;
    keys.add(key);
    let id = cleanText(item.id, 40);
    if (!id || itemIds.has(id)) id = nextId(store, "b");
    itemIds.add(id);
    const added = Number(item.added);
    const favOrder = Number(item.favOrder);
    store.items.push({
      id,
      title: cleanText(item.title, MAX_TITLE) || hostLabel(url),
      url,
      folder: ids.has(item.folder) ? item.folder : ROOT_ID,
      favorite: item.favorite === true,
      favOrder: Number.isFinite(favOrder) ? favOrder : 0,
      added: Number.isFinite(added) && added > 0 ? added : 0,
    });
  }
  renumberFavorites(store);
  return store;
}

function renumberFavorites(store) {
  const favs = store.items.filter((item) => item.favorite).sort((a, b) => a.favOrder - b.favOrder);
  favs.forEach((item, index) => { item.favOrder = index; });
  for (const item of store.items) if (!item.favorite) item.favOrder = 0;
}

/** Turns the old flat `hog-bookmarks` list into the new store. Every old entry becomes a favorite, in the same order. */
export function migrateLegacy(list, now = Date.now()) {
  const store = emptyStore();
  const source = Array.isArray(list) ? list : [];
  const keys = new Set();
  let order = 0;
  for (const entry of source) {
    const url = safeUrl(entry?.url);
    const key = urlKey(url);
    if (!url || keys.has(key)) continue;
    keys.add(key);
    store.items.push({
      id: nextId(store, "b"),
      title: cleanText(entry.title, MAX_TITLE) || hostLabel(url),
      url,
      folder: ROOT_ID,
      favorite: true,
      favOrder: order++,
      added: now,
    });
  }
  return store;
}

/**
 * Reads the store from a Storage-like object (getItem/setItem).
 * The first run on 0.1.21 copies the old list to BACKUP_KEY untouched and
 * leaves the old key in place, so nothing is lost.
 * Returns { store, migrated, backup } where backup is the raw old text when a migration happened.
 */
export function loadStore(storage, now = Date.now()) {
  const raw = storage.getItem(STORE_KEY);
  if (raw) {
    try {
      return { store: sanitizeStore(JSON.parse(raw)), migrated: false, backup: null };
    } catch {
      // Fall through and rebuild from the old list rather than lose bookmarks.
      if (!storage.getItem(`${STORE_KEY}-corrupt`)) storage.setItem(`${STORE_KEY}-corrupt`, raw);
    }
  }
  const legacyRaw = storage.getItem(LEGACY_KEY);
  let legacy = null;
  if (legacyRaw) {
    try {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) legacy = parsed;
    } catch {
      legacy = null;
    }
  }
  const store = legacy ? migrateLegacy(legacy, now) : migrateLegacy(SEED, now);
  if (legacyRaw && !storage.getItem(BACKUP_KEY)) storage.setItem(BACKUP_KEY, legacyRaw);
  storage.setItem(STORE_KEY, JSON.stringify(store));
  return { store, migrated: Boolean(legacyRaw), backup: legacyRaw || null };
}

export function saveStore(storage, store) {
  storage.setItem(STORE_KEY, JSON.stringify(store));
}

export function findByUrl(store, url) {
  const key = urlKey(url);
  if (!key) return null;
  return store.items.find((item) => urlKey(item.url) === key) || null;
}

export function favorites(store) {
  return store.items.filter((item) => item.favorite).sort((a, b) => a.favOrder - b.favOrder);
}

/** Adds a bookmark, or updates the existing one for the same page. Returns { store, item, created }. */
export function addBookmark(store, { title, url, folder = ROOT_ID, favorite = false } = {}, now = Date.now()) {
  const next = clone(store);
  const href = safeUrl(url);
  if (!href) throw new Error("Only http and https addresses can be bookmarked");
  const existing = findByUrl(next, href);
  if (existing) {
    if (title) existing.title = cleanText(title, MAX_TITLE) || existing.title;
    if (folder && folderExists(next, folder) && folder !== ROOT_ID) existing.folder = folder;
    if (favorite && !existing.favorite) {
      existing.favorite = true;
      existing.favOrder = favorites(next).length;
    }
    renumberFavorites(next);
    return { store: next, item: existing, created: false };
  }
  const item = {
    id: nextId(next, "b"),
    title: cleanText(title, MAX_TITLE) || hostLabel(href),
    url: href,
    folder: folderExists(next, folder) ? folder : ROOT_ID,
    favorite: Boolean(favorite),
    favOrder: favorite ? favorites(next).length : 0,
    added: now,
  };
  next.items.unshift(item);
  renumberFavorites(next);
  return { store: next, item, created: true };
}

export function updateBookmark(store, id, patch = {}) {
  const next = clone(store);
  const item = next.items.find((entry) => entry.id === id);
  if (!item) throw new Error("That bookmark is gone");
  if (patch.url !== undefined) {
    const href = safeUrl(patch.url);
    if (!href) throw new Error("Only http and https addresses can be bookmarked");
    const clash = findByUrl(next, href);
    if (clash && clash.id !== id) throw new Error("That address is already bookmarked");
    item.url = href;
  }
  if (patch.title !== undefined) item.title = cleanText(patch.title, MAX_TITLE) || hostLabel(item.url);
  if (patch.folder !== undefined && folderExists(next, patch.folder)) item.folder = patch.folder;
  if (patch.favorite !== undefined && Boolean(patch.favorite) !== item.favorite) {
    item.favorite = Boolean(patch.favorite);
    item.favOrder = item.favorite ? favorites(next).length : 0;
  }
  renumberFavorites(next);
  return next;
}

export function removeBookmark(store, id) {
  const next = clone(store);
  next.items = next.items.filter((item) => item.id !== id);
  renumberFavorites(next);
  return next;
}

export function toggleFavorite(store, id) {
  const item = store.items.find((entry) => entry.id === id);
  if (!item) return store;
  return updateBookmark(store, id, { favorite: !item.favorite });
}

/** Moves a favorite to a new position in the favorites order. */
export function moveFavorite(store, id, toIndex) {
  const next = clone(store);
  const favs = favorites(next);
  const from = favs.findIndex((item) => item.id === id);
  if (from < 0) return next;
  const target = Math.max(0, Math.min(favs.length - 1, Math.floor(Number(toIndex) || 0)));
  const [moved] = favs.splice(from, 1);
  favs.splice(target, 0, moved);
  favs.forEach((item, index) => { item.favOrder = index; });
  return next;
}

/** Moves a bookmark up or down among its folder's bookmarks (manual order). */
export function nudgeBookmark(store, id, delta) {
  const next = clone(store);
  const item = next.items.find((entry) => entry.id === id);
  if (!item) return next;
  const peers = next.items.filter((entry) => entry.folder === item.folder);
  const from = peers.indexOf(item);
  const to = Math.max(0, Math.min(peers.length - 1, from + Math.sign(delta)));
  if (from === to) return next;
  const swap = peers[to];
  const a = next.items.indexOf(item);
  const b = next.items.indexOf(swap);
  next.items[a] = swap;
  next.items[b] = item;
  return next;
}

export function addFolder(store, name, parent = ROOT_ID) {
  const next = clone(store);
  const clean = cleanText(name, MAX_FOLDER);
  if (!clean) throw new Error("Name the folder");
  const folder = { id: nextId(next, "f"), name: clean, parent: folderExists(next, parent) ? parent : ROOT_ID };
  next.folders.push(folder);
  return { store: next, folder };
}

export function renameFolder(store, id, name) {
  const next = clone(store);
  const folder = next.folders.find((entry) => entry.id === id);
  if (!folder) throw new Error("That folder is gone");
  const clean = cleanText(name, MAX_FOLDER);
  if (!clean) throw new Error("Name the folder");
  folder.name = clean;
  return next;
}

/** Deletes a folder. Its bookmarks and subfolders move up to its parent, so nothing is lost. */
export function removeFolder(store, id) {
  if (id === ROOT_ID) throw new Error("The main Bookmarks folder stays");
  const next = clone(store);
  const folder = next.folders.find((entry) => entry.id === id);
  if (!folder) return next;
  const parent = folder.parent || ROOT_ID;
  for (const item of next.items) if (item.folder === id) item.folder = parent;
  for (const child of next.folders) if (child.parent === id) child.parent = parent;
  next.folders = next.folders.filter((entry) => entry.id !== id);
  return next;
}

export function folderPath(store, id) {
  const names = [];
  let cursor = store.folders.find((entry) => entry.id === id);
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    names.unshift(cursor.name);
    cursor = cursor.parent ? store.folders.find((entry) => entry.id === cursor.parent) : null;
  }
  return names.join(" / ");
}

/** Folders as a depth-first list with depth, for sidebars and pickers. */
export function folderTree(store) {
  const out = [];
  const walk = (parent, depth) => {
    for (const folder of store.folders) {
      if (folder.id === ROOT_ID || folder.parent !== parent) continue;
      out.push({ ...folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  const root = store.folders.find((entry) => entry.id === ROOT_ID);
  out.push({ ...root, depth: 0 });
  walk(ROOT_ID, 1);
  return out;
}

export function descendantFolders(store, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of store.folders) {
      if (folder.parent && out.has(folder.parent) && !out.has(folder.id)) {
        out.add(folder.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * view: "all" | "favorites" | a folder id (folder views include subfolders when `deep`).
 * sort: "manual" | "title" | "added" | "host"
 */
export function listBookmarks(store, { view = "all", query = "", sort = "manual", deep = false } = {}) {
  let items;
  if (view === "favorites") items = favorites(store);
  else if (view === "all") items = store.items.slice();
  else {
    const scope = deep ? descendantFolders(store, view) : new Set([view]);
    items = store.items.filter((item) => scope.has(item.folder));
  }
  const needle = String(query || "").trim().toLowerCase();
  if (needle) {
    const words = needle.split(/\s+/);
    items = items.filter((item) => {
      const blob = `${item.title} ${item.url}`.toLowerCase();
      return words.every((word) => blob.includes(word));
    });
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  if (sort === "title") items.sort((a, b) => collator.compare(a.title, b.title));
  else if (sort === "added") items.sort((a, b) => b.added - a.added);
  else if (sort === "host") items.sort((a, b) => collator.compare(hostLabel(a.url), hostLabel(b.url)) || collator.compare(a.title, b.title));
  return items;
}

// ---------- Netscape bookmark files (what Brave, Chrome, and Firefox export) ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };

export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readAttrs(tag) {
  const attrs = {};
  const re = /([a-z_:-][a-z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}

/**
 * Parses a Netscape bookmark file into a tree:
 * { name, folders: [tree...], links: [{ title, url, added, favorite }] }.
 * Unsafe links (javascript:, place:, file:) are dropped and counted in `skipped`.
 */
export function parseNetscape(html) {
  const text = String(html || "");
  const root = { name: "", folders: [], links: [], toolbar: false };
  const stack = [root];
  let pendingFolder = null;
  let skipped = 0;
  const re = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(text))) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const top = stack[stack.length - 1];
    if (tag === "h3" && !closing) {
      const end = text.toLowerCase().indexOf("</h3>", re.lastIndex);
      const name = cleanText(decodeEntities(text.slice(re.lastIndex, end < 0 ? undefined : end).replace(/<[^>]*>/g, "")), MAX_FOLDER) || "Folder";
      const attrs = readAttrs(match[3]);
      pendingFolder = { name, folders: [], links: [], toolbar: Boolean(attrs.personal_toolbar_folder) };
      top.folders.push(pendingFolder);
      if (end >= 0) re.lastIndex = end + 5;
    } else if (tag === "dl" && !closing) {
      if (pendingFolder) {
        stack.push(pendingFolder);
        pendingFolder = null;
      }
    } else if (tag === "dl" && closing) {
      if (stack.length > 1) stack.pop();
    } else if (tag === "a" && !closing) {
      pendingFolder = null;
      const attrs = readAttrs(match[3]);
      const end = text.toLowerCase().indexOf("</a>", re.lastIndex);
      const title = cleanText(decodeEntities(text.slice(re.lastIndex, end < 0 ? undefined : end).replace(/<[^>]*>/g, "")), MAX_TITLE);
      if (end >= 0) re.lastIndex = end + 4;
      const url = safeUrl(attrs.href);
      if (!url || !/^https?:/i.test(String(attrs.href || "").trim())) {
        skipped += 1;
        continue;
      }
      const added = Number(attrs.add_date);
      top.links.push({
        title: title || hostLabel(url),
        url,
        added: Number.isFinite(added) && added > 0 ? added * 1000 : 0,
        favorite: attrs.hog_favorite === "1" || attrs.hog_favorite === "true",
        favOrder: Number.isFinite(Number(attrs.hog_favorite_order)) ? Number(attrs.hog_favorite_order) : Infinity,
      });
    }
  }
  return { tree: root, skipped };
}

/**
 * Merges a parsed Netscape tree into the store under a new folder (default "Imported").
 * Pages already bookmarked are skipped. Returns { store, added, duplicates, skipped, folder }.
 */
export function importNetscape(store, html, { folderName = "Imported", now = Date.now() } = {}) {
  const { tree, skipped } = parseNetscape(html);
  let next = clone(store);
  const made = addFolder(next, folderName, ROOT_ID);
  next = made.store;
  const keys = new Set(next.items.map((item) => urlKey(item.url)));
  let added = 0;
  let duplicates = 0;
  const favQueue = [];
  const put = (node, folderId) => {
    for (const link of node.links) {
      const key = urlKey(link.url);
      if (!key || keys.has(key)) {
        duplicates += 1;
        continue;
      }
      keys.add(key);
      const item = {
        id: nextId(next, "b"),
        title: link.title,
        url: link.url,
        folder: folderId,
        favorite: false,
        favOrder: 0,
        added: link.added || now,
      };
      next.items.push(item);
      if (link.favorite) {
        item.importOrder = link.favOrder;
        favQueue.push(item);
      }
      added += 1;
    }
    for (const child of node.folders) {
      const sub = { id: nextId(next, "f"), name: child.name, parent: folderId };
      next.folders.push(sub);
      put(child, sub.id);
    }
  };
  put(tree, made.folder.id);
  let order = favorites(next).length;
  favQueue.sort((a, b) => a.importOrder - b.importOrder);
  for (const item of favQueue) {
    delete item.importOrder;
    item.favorite = true;
    item.favOrder = order++;
  }
  renumberFavorites(next);
  return { store: next, added, duplicates, skipped, folder: made.folder };
}

/** Writes the whole store as a Netscape bookmark file. Favorites carry HOG_FAVORITE="1" so a round trip keeps them. */
export function exportNetscape(store) {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">",
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const favOrder = new Map(favorites(store).map((item, index) => [item.id, index]));
  const write = (folderId, indent) => {
    const pad = "    ".repeat(indent);
    for (const item of store.items) {
      if (item.folder !== folderId) continue;
      const added = item.added ? ` ADD_DATE="${Math.floor(item.added / 1000)}"` : "";
      const fav = favOrder.has(item.id) ? ` HOG_FAVORITE="1" HOG_FAVORITE_ORDER="${favOrder.get(item.id)}"` : "";
      lines.push(`${pad}<DT><A HREF="${escapeHtml(item.url)}"${added}${fav}>${escapeHtml(item.title)}</A>`);
    }
    for (const folder of store.folders) {
      if (folder.id === ROOT_ID || folder.parent !== folderId) continue;
      lines.push(`${pad}<DT><H3>${escapeHtml(folder.name)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      write(folder.id, indent + 1);
      lines.push(`${pad}</DL><p>`);
    }
  };
  write(ROOT_ID, 1);
  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}
