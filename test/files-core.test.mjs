import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHUNK_SIZE,
  baseName,
  chunkPlan,
  crumbs,
  entryKind,
  filterEntries,
  formatBytes,
  formatDate,
  iconSvg,
  joinPath,
  keyAction,
  kindLabel,
  moveFocus,
  nameProblem,
  parentPath,
  query,
  rangeSelect,
  rawUrl,
  selectionSummary,
  smbLinks,
  sortEntries,
  spaceSummary,
  uploadId,
} from "../public/files-core.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const view = readFileSync(new URL("../public/files-view.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/retro.css", import.meta.url), "utf8");

test("sizes, dates and names", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.00 GB");
  assert.equal(formatBytes(-1), "");
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  assert.equal(formatDate(new Date(2026, 10, 12, 9, 5).getTime(), now), "Today 09:05");
  assert.equal(formatDate(new Date(2025, 0, 2, 3, 4).getTime(), now), "2025-01-02 03:04");
  assert.equal(formatDate(0), "");
  assert.equal(nameProblem("film.mkv"), "");
  for (const bad of ["", ".", "..", "a/b", "a\\b", " lead", "trail ", ".hog-trash", ".hog-upload-x", "x".repeat(256), "bad\u0001"]) {
    assert.ok(nameProblem(bad), `${JSON.stringify(bad)} is refused`);
  }
});

test("paths and crumbs", () => {
  assert.equal(joinPath("", "a"), "a");
  assert.equal(joinPath("a/b", "c"), "a/b/c");
  assert.equal(parentPath("a/b/c"), "a/b");
  assert.equal(parentPath("a"), "");
  assert.equal(baseName("a/b/c.txt"), "c.txt");
  assert.deepEqual(crumbs("hog-shares", "films/2024"), [
    { label: "hog-shares", path: "" },
    { label: "films", path: "films" },
    { label: "2024", path: "films/2024" },
  ]);
  assert.equal(query({ root: "shares", path: "a b/c&d", skip: undefined }), "root=shares&path=a+b%2Fc%26d");
  assert.equal(rawUrl("shares", "x.png"), "/api/files/raw?root=shares&path=x.png");
  assert.equal(rawUrl("shares", "x.png", { download: true }), "/api/files/raw?root=shares&path=x.png&download=1");
});

test("sorting keeps folders first and sorts numbers naturally", () => {
  const entries = [
    { name: "b10.txt", type: "file", size: 5, mtime: 3, kind: "text" },
    { name: "b2.txt", type: "file", size: 50, mtime: 1, kind: "text" },
    { name: "zeta", type: "dir", size: 0, mtime: 2 },
    { name: "alpha", type: "dir", size: 0, mtime: 9 },
    { name: "a.png", type: "file", size: 1, mtime: 2, kind: "image" },
  ];
  assert.deepEqual(sortEntries(entries).map((e) => e.name), ["alpha", "zeta", "a.png", "b2.txt", "b10.txt"]);
  assert.deepEqual(sortEntries(entries, "size", "desc").map((e) => e.name), ["zeta", "alpha", "b2.txt", "b10.txt", "a.png"]);
  assert.deepEqual(sortEntries(entries, "mtime").map((e) => e.name), ["zeta", "alpha", "b2.txt", "a.png", "b10.txt"]);
  assert.deepEqual(sortEntries(entries, "kind").map((e) => e.name), ["alpha", "zeta", "a.png", "b2.txt", "b10.txt"]);
  assert.deepEqual(filterEntries(entries, " B1 ").map((e) => e.name), ["b10.txt"]);
  assert.equal(filterEntries(entries, "").length, 5);
});

test("selection and keyboard focus", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeSelect(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeSelect(order, "d", "a"), ["a", "b", "c", "d"]);
  assert.deepEqual(rangeSelect(order, "zz", "c"), ["c"]);
  assert.deepEqual(rangeSelect(order, "a", "zz"), []);
  assert.equal(moveFocus(-1, "ArrowDown", 5), 0);
  assert.equal(moveFocus(0, "ArrowDown", 5), 1);
  assert.equal(moveFocus(4, "ArrowDown", 5), 4);
  assert.equal(moveFocus(1, "ArrowDown", 10, 4), 5);
  assert.equal(moveFocus(1, "ArrowRight", 10, 4), 2);
  assert.equal(moveFocus(1, "ArrowRight", 10, 1), 1);
  assert.equal(moveFocus(3, "Home", 10), 0);
  assert.equal(moveFocus(3, "End", 10), 9);
  assert.equal(moveFocus(0, "ArrowUp", 0), -1);
  const key = (k, extra = {}) => keyAction({ key: k, ...extra });
  assert.equal(key("a", { ctrlKey: true }), "select-all");
  assert.equal(key("C", { ctrlKey: true }), "copy");
  assert.equal(key("x", { metaKey: true }), "cut");
  assert.equal(key("v", { ctrlKey: true }), "paste");
  assert.equal(key("N", { ctrlKey: true, shiftKey: true }), "new-folder");
  assert.equal(key("n", { ctrlKey: true }), "");
  assert.equal(key("1", { ctrlKey: true }), "view-list");
  assert.equal(key("2", { ctrlKey: true }), "view-grid");
  assert.equal(key("ArrowUp", { altKey: true }), "up");
  assert.equal(key("ArrowLeft", { altKey: true }), "back");
  assert.equal(key("Enter"), "open");
  assert.equal(key("Delete"), "trash");
  assert.equal(key("F2"), "rename");
  assert.equal(key(" "), "preview");
  assert.equal(key("Backspace"), "up");
  assert.equal(key("ArrowDown", { shiftKey: true }), "extend");
  assert.equal(key("ArrowDown"), "move");
  assert.equal(key("Escape"), "escape");
  // Typing in a box keeps its own keys, apart from Escape.
  assert.equal(keyAction({ key: "a", ctrlKey: true }, { editing: true }), "");
  assert.equal(keyAction({ key: "Delete" }, { editing: true }), "");
  assert.equal(keyAction({ key: "Escape" }, { editing: true }), "escape");
});

test("chunked upload plan and ids", () => {
  assert.equal(CHUNK_SIZE, 8 * 1024 * 1024);
  assert.deepEqual(chunkPlan(0), [{ start: 0, end: 0 }]);
  assert.deepEqual(chunkPlan(10, 4), [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 }]);
  assert.deepEqual(chunkPlan(10, 4, 8), [{ start: 8, end: 10 }]);
  const id = uploadId();
  assert.match(id, /^[a-f0-9]{24}$/);
  assert.notEqual(uploadId(), id);
});

test("kinds, labels and summaries", () => {
  assert.equal(entryKind({ type: "dir" }), "folder");
  assert.equal(entryKind({ type: "file", kind: "video" }), "video");
  assert.equal(entryKind({ type: "link" }), "link");
  assert.equal(kindLabel({ type: "file", kind: "image" }), "Image");
  assert.equal(kindLabel({ type: "link", outside: true }), "Link outside this folder");
  assert.equal(selectionSummary([]), "");
  assert.equal(selectionSummary([{ type: "file", size: 2048 }, { type: "dir" }]), "2 items, 2.00 KB");
  assert.deepEqual(spaceSummary({ total: 1000, used: 250, free: 750 }), { percent: 25, text: "750 B free of 1000 B" });
  assert.equal(spaceSummary(null), null);
  for (const kind of ["folder", "image", "video", "audio", "text", "archive", "doc", "link", "other", "trash", "drive", "home"]) {
    assert.match(iconSvg(kind), /^<svg viewBox="0 0 24 24" aria-hidden="true"/);
  }
  assert.match(iconSvg("<script>"), /fx-svg-other/);
});

test("Samba connection strings", () => {
  assert.deepEqual(smbLinks({ dns: "hog.tail314642.ts.net.", ip: "100.119.132.89", share: "hog-shares" }), [
    { label: "Phone, Mac, Linux", value: "smb://hog.tail314642.ts.net/hog-shares" },
    { label: "Windows", value: "\\\\hog\\hog-shares" },
    { label: "By IP", value: "smb://100.119.132.89/hog-shares" },
    { label: "Windows by IP", value: "\\\\100.119.132.89\\hog-shares" },
  ]);
  assert.deepEqual(smbLinks({}), []);
});

test("hog://files markup has every control the view uses", () => {
  const section = html.slice(html.indexOf('id="files-view"'), html.indexOf('id="browser-settings"'));
  assert.ok(section.length > 1000, "files-view section is in index.html");
  const used = new Set([...view.matchAll(/\$\("(fx-[a-z-]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.size > 40);
  for (const id of used) assert.match(section, new RegExp(`id="${id}"`), `#${id} is in the Files markup`);
  assert.match(html, /<section class="home fx-page" id="files-view" aria-label="Files" hidden>/);
  assert.match(section, /role="listbox" aria-multiselectable="true"/);
  assert.match(section, /webkitdirectory/);
  for (const act of ["open", "download", "cut", "copy", "rename", "trash", "restore", "purge", "clear"]) {
    assert.match(section, new RegExp(`data-fx-act="${act}"`));
  }
  assert.match(html, /data-settings="explorer"/);
  assert.match(html, /id="samba-card"/);
  assert.match(html, /id="samba-pass" type="password" autocomplete="new-password"/);
  assert.match(html, /id="files-roots-card"/);
});

test("app wires hog://files, Samba and the solid page background", () => {
  assert.match(app, /import \{ createFilesView \} from "\.\/files-view\.js";/);
  assert.match(app, /hog:\\\/\\\/files/);
  assert.match(app, /if \(page === "explorer"\) \{\s*showFilesView\(\);/);
  assert.match(app, /window\.__hogSamba = /);
  assert.match(app, /window\.__hogFilesRoot = /);
  assert.match(app, /containers:samba-save:/);
  assert.match(app, /bookmarksViewOpen\(\) \|\| filesViewOpen\(\)/);
  assert.match(app, /\(!filesPage \|\| filesPage\.hidden\)/);
  // The password is sent once and the box is cleared; it is never painted back.
  assert.match(app, /\$\("samba-pass"\)\.value = "";/);
  assert.doesNotMatch(app, /samba-pass"\)\.value = (?!"")/);
  assert.match(css, /#files-view/);
  assert.match(css, /\.fx-pane\.is-grid \.fx-items/);
  // Files-view never builds markup from file names.
  assert.deepEqual([...view.matchAll(/innerHTML\s*=\s*([A-Za-z]+)/g)].map((m) => m[1]), ["iconSvg"]);
  assert.match(view, /"x-hog-files", "1"|\["x-hog-files"\] = "1"/);
});
