import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_KEY,
  LEGACY_KEY,
  ROOT_ID,
  STORE_KEY,
  addBookmark,
  addFolder,
  exportNetscape,
  favorites,
  findByUrl,
  folderTree,
  importNetscape,
  listBookmarks,
  loadStore,
  migrateLegacy,
  moveFavorite,
  nudgeBookmark,
  parseNetscape,
  removeBookmark,
  removeFolder,
  safeUrl,
  sanitizeStore,
  toggleFavorite,
  updateBookmark,
  urlKey,
} from "../public/bookmarks-store.js";

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test("safeUrl keeps http(s) and refuses everything else", () => {
  assert.equal(safeUrl("example.com"), "https://example.com/");
  assert.equal(safeUrl("http://127.0.0.1:8096"), "http://127.0.0.1:8096/");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "place:sort=8", "data:text/html,hi", "https://user:pw@example.com/", ""]) {
    assert.equal(safeUrl(bad), "", bad);
  }
  assert.equal(safeUrl("https://html.duckduckgo.com/html/"), "https://duckduckgo.com/");
});

test("urlKey treats trivial variants of a page as the same bookmark", () => {
  assert.equal(urlKey("https://www.Example.com/"), urlKey("https://example.com"));
  assert.equal(urlKey("https://example.com/docs/"), urlKey("https://example.com/docs"));
  assert.notEqual(urlKey("https://example.com/a"), urlKey("https://example.com/b"));
  assert.notEqual(urlKey("http://example.com/"), urlKey("https://example.com/"));
});

test("migration keeps every old favorite in order, drops only exact duplicates, and backs up the old list", () => {
  const legacy = [
    { title: "DuckDuckGo", url: "https://html.duckduckgo.com/html/" },
    { title: "Jellyfin", url: "http://127.0.0.1:8096/" },
    { title: "GitHub", url: "https://github.com/warthog-network" },
    { title: "Jellyfin again", url: "http://127.0.0.1:8096" },
    { title: "bad", url: "javascript:alert(1)" },
  ];
  const raw = JSON.stringify(legacy);
  const storage = memoryStorage({ [LEGACY_KEY]: raw });
  const { store, migrated, backup } = loadStore(storage, 1000);
  assert.equal(migrated, true);
  assert.equal(backup, raw);
  assert.equal(storage.getItem(BACKUP_KEY), raw, "old list copied to the backup key");
  assert.equal(storage.getItem(LEGACY_KEY), raw, "old key left untouched");
  assert.ok(storage.getItem(STORE_KEY));
  const favs = favorites(store);
  assert.deepEqual(favs.map((item) => item.title), ["DuckDuckGo", "Jellyfin", "GitHub"]);
  assert.equal(favs[0].url, "https://duckduckgo.com/");
  assert.ok(favs.every((item) => item.folder === ROOT_ID && item.favorite));

  // Second load reads the new store and does not migrate again.
  const again = loadStore(storage, 2000);
  assert.equal(again.migrated, false);
  assert.deepEqual(favorites(again.store).map((item) => item.id), favs.map((item) => item.id));
});

test("a fresh profile gets the seed favorites", () => {
  const storage = memoryStorage();
  const { store, migrated } = loadStore(storage);
  assert.equal(migrated, false);
  assert.equal(favorites(store).length, 3);
  assert.equal(storage.getItem(BACKUP_KEY), null);
});

test("a corrupt new store falls back to the old list instead of losing bookmarks", () => {
  const storage = memoryStorage({
    [STORE_KEY]: "{not json",
    [LEGACY_KEY]: JSON.stringify([{ title: "A", url: "https://a.example/" }]),
  });
  const { store } = loadStore(storage);
  assert.equal(store.items[0].url, "https://a.example/");
  assert.equal(storage.getItem(`${STORE_KEY}-corrupt`), "{not json");
});

test("add dedupes, edit, favorite toggle, and remove", () => {
  let store = migrateLegacy([]);
  let result = addBookmark(store, { title: "Example", url: "https://example.com/" });
  store = result.store;
  assert.equal(result.created, true);
  result = addBookmark(store, { title: "Example 2", url: "https://www.example.com", favorite: true });
  store = result.store;
  assert.equal(result.created, false);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].title, "Example 2");
  assert.equal(favorites(store).length, 1);
  store = toggleFavorite(store, store.items[0].id);
  assert.equal(favorites(store).length, 0);
  store = addBookmark(store, { url: "https://other.example/" }).store;
  assert.throws(() => updateBookmark(store, store.items[0].id, { url: "https://example.com" }), /already bookmarked/);
  assert.throws(() => updateBookmark(store, store.items[0].id, { url: "javascript:alert(1)" }), /http and https/);
  store = updateBookmark(store, store.items[0].id, { title: "  Other   site " });
  assert.equal(store.items[0].title, "Other site");
  store = removeBookmark(store, store.items[0].id);
  assert.equal(store.items.length, 1);
  assert.equal(findByUrl(store, "https://other.example/"), null);
});

test("favorites reorder and folder nudge", () => {
  let store = migrateLegacy([
    { title: "A", url: "https://a.example/" },
    { title: "B", url: "https://b.example/" },
    { title: "C", url: "https://c.example/" },
  ]);
  const [a, , c] = favorites(store);
  store = moveFavorite(store, c.id, 0);
  assert.deepEqual(favorites(store).map((item) => item.title), ["C", "A", "B"]);
  store = moveFavorite(store, c.id, 99);
  assert.deepEqual(favorites(store).map((item) => item.title), ["A", "B", "C"]);
  store = nudgeBookmark(store, a.id, 1);
  assert.deepEqual(listBookmarks(store, { view: ROOT_ID }).map((item) => item.title), ["B", "A", "C"]);
});

test("folders: add, move, delete keeps bookmarks, search and sort", () => {
  let store = migrateLegacy([
    { title: "zeta docs", url: "https://zeta.example/docs" },
    { title: "Alpha", url: "https://alpha.example/" },
  ]);
  const { store: s1, folder: work } = addFolder(store, "Work");
  const { store: s2, folder: sub } = addFolder(s1, "Sub", work.id);
  store = updateBookmark(s2, store.items[0].id, { folder: sub.id });
  assert.equal(listBookmarks(store, { view: work.id }).length, 0);
  assert.equal(listBookmarks(store, { view: work.id, deep: true }).length, 1);
  assert.deepEqual(folderTree(store).map((f) => [f.name, f.depth]), [["Bookmarks", 0], ["Work", 1], ["Sub", 2]]);
  assert.deepEqual(listBookmarks(store, { query: "ZETA docs" }).map((item) => item.title), ["zeta docs"]);
  assert.deepEqual(listBookmarks(store, { sort: "title" }).map((item) => item.title), ["Alpha", "zeta docs"]);
  store = removeFolder(store, work.id);
  assert.equal(store.folders.find((f) => f.id === sub.id).parent, ROOT_ID);
  store = removeFolder(store, sub.id);
  assert.equal(store.items.length, 2);
  assert.ok(store.items.every((item) => item.folder === ROOT_ID));
  assert.throws(() => removeFolder(store, ROOT_ID));
});

test("sanitizeStore repairs bad data, duplicates, and folder cycles", () => {
  const store = sanitizeStore({
    seq: "x",
    folders: [{ id: "f1", name: "One", parent: "f2" }, { id: "f2", name: "Two", parent: "f1" }, { id: "f1", name: "dup" }],
    items: [
      { id: "b1", title: "A", url: "https://a.example/", folder: "f1", favorite: true },
      { id: "b1", title: "A copy", url: "https://a.example", folder: "nope" },
      { id: "b2", title: "Bad", url: "javascript:1" },
      { title: "", url: "https://b.example/", folder: "missing", favorite: true, favOrder: 9 },
    ],
  });
  assert.equal(store.items.length, 2);
  assert.equal(store.items[1].folder, ROOT_ID);
  assert.equal(store.items[1].title, "b.example");
  assert.deepEqual(favorites(store).map((item) => item.favOrder), [0, 1]);
  assert.equal(store.folders.length, 3);
  assert.ok(folderTree(store).length === 3, "cycle broken so every folder is reachable");
});

const BRAVE_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://wartscan.io/" ADD_DATE="1700000001" ICON="data:image/png;base64,AAAA">Wartscan &amp; explorer</A>
        <DT><H3 ADD_DATE="1700000002">Crypto &lt;tools&gt;</H3>
        <DL><p>
            <DT><A HREF="https://www.coingecko.com/">CoinGecko</A>
            <DT><A HREF="javascript:void(0)">Bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://github.com/warthog-network">already here</A>
    </DL><p>
    <DT><A HREF="place:sort=8">Recent</A>
    <DT><A HREF='http://127.0.0.1:8096/web/'>Jellyfin</A>
</DL><p>
`;

test("parseNetscape reads nested folders, entities, and drops unsafe links", () => {
  const { tree, skipped } = parseNetscape(BRAVE_EXPORT);
  assert.equal(skipped, 2);
  assert.equal(tree.links.length, 1);
  assert.equal(tree.links[0].url, "http://127.0.0.1:8096/web/");
  const bar = tree.folders[0];
  assert.equal(bar.name, "Bookmarks bar");
  assert.equal(bar.toolbar, true);
  assert.equal(bar.links[0].title, "Wartscan & explorer");
  assert.equal(bar.links[0].added, 1700000001000);
  assert.equal(bar.folders[0].name, "Crypto <tools>");
  assert.equal(bar.folders[0].links[0].url, "https://www.coingecko.com/");
});

test("importNetscape merges into an Imported folder and skips pages already saved", () => {
  const base = migrateLegacy([{ title: "warthog-network", url: "https://github.com/warthog-network" }]);
  const { store, added, duplicates, skipped, folder } = importNetscape(base, BRAVE_EXPORT, { folderName: "Brave" });
  assert.equal(added, 3);
  assert.equal(duplicates, 1);
  assert.equal(skipped, 2);
  assert.equal(folder.name, "Brave");
  assert.deepEqual(folderTree(store).map((f) => f.name), ["Bookmarks", "Brave", "Bookmarks bar", "Crypto <tools>"]);
  assert.equal(favorites(store).length, 1, "imports do not flood favorites");
  assert.equal(listBookmarks(store, { view: folder.id, deep: true }).length, 3);
});

test("export then import round-trips titles, folders, and favorites", () => {
  let store = migrateLegacy([
    { title: "B \"quoted\" <b>", url: "https://b.example/?a=1&b=2" },
    { title: "A", url: "https://a.example/" },
  ]);
  store = moveFavorite(store, favorites(store)[1].id, 0);
  const { store: withFolder, folder } = addFolder(store, "Media & co");
  store = addBookmark(withFolder, { title: "Jellyfin", url: "http://127.0.0.1:8096/", folder: folder.id }).store;
  const html = exportNetscape(store);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<H3>Media &amp; co<\/H3>/);
  assert.match(html, /HREF="https:\/\/b\.example\/\?a=1&amp;b=2"/);
  const back = importNetscape(migrateLegacy([]), html, { folderName: "Restored" });
  assert.equal(back.added, 3);
  assert.deepEqual(favorites(back.store).map((item) => item.title), ["A", "B \"quoted\" <b>"]);
  const media = back.store.folders.find((f) => f.name === "Media & co");
  assert.ok(media);
  assert.equal(listBookmarks(back.store, { view: media.id })[0].url, "http://127.0.0.1:8096/");
});

test("favicon helpers: origin, sniffing, and <link rel=icon>", async () => {
  const { faviconOrigin, sniffIcon, iconHrefFromHtml } = await import("../server.mjs");
  assert.equal(faviconOrigin("https://github.com/warthog-network"), "https://github.com");
  assert.equal(faviconOrigin("http://127.0.0.1:8096/web/"), "http://127.0.0.1:8096");
  assert.throws(() => faviconOrigin("javascript:alert(1)"));
  assert.throws(() => faviconOrigin("file:///etc/passwd"));
  assert.equal(sniffIcon(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), "image/png");
  assert.equal(sniffIcon(Buffer.from([0, 0, 1, 0, 1, 0])), "image/x-icon");
  assert.equal(sniffIcon(Buffer.from("<?xml version=\"1.0\"?><svg xmlns='x'></svg>")), "image/svg+xml");
  assert.equal(sniffIcon(Buffer.from("<!doctype html><html>")), "", "an HTML error page is not an icon");
  assert.equal(iconHrefFromHtml('<link rel="stylesheet" href="a.css"><link rel="icon" type="image/png" href="/static/fav.png">', "https://a.example/x/"), "https://a.example/static/fav.png");
  assert.equal(iconHrefFromHtml("<link rel='shortcut icon' href='//cdn.example/i.ico'>", "https://a.example/"), "https://cdn.example/i.ico");
  assert.equal(iconHrefFromHtml('<link rel="icon" href="javascript:alert(1)">', "https://a.example/"), "");
});
