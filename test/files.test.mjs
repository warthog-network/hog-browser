import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PART_PREFIX,
  TRASH_DIR,
  checkName,
  contentDisposition,
  createFilesService,
  describeError,
  filesRequestProblem,
  handleFilesRequest,
  kindOf,
  parseRange,
  rootProblem,
  servedType,
  splitRelative,
} from "../files.mjs";

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hog-files-test-")));
  const home = join(base, "home");
  const shares = join(home, "hog-shares");
  const dataDir = join(home, ".local", "share", "hog-browser");
  const outside = join(base, "outside");
  mkdirSync(shares, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "wallet-ish secret\n");
  writeFileSync(join(dataDir, "wallet.json"), "{}\n");
  const service = createFilesService({ home, dataDir, sharesDir: shares, configFile: join(dataDir, "files.json") });
  return { base, home, shares, dataDir, outside, service };
}

async function rejects(promise, status, pattern) {
  await assert.rejects(promise, (error) => {
    const seen = describeError(error);
    assert.equal(seen.status, status, `status ${seen.status}: ${seen.message}`);
    if (pattern) assert.match(seen.message, pattern);
    return true;
  });
}

async function* bytes(...chunks) {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

test("relative paths: only plain names, no .., no absolute paths", () => {
  assert.deepEqual(splitRelative(""), []);
  assert.deepEqual(splitRelative("films/2024/a.mkv"), ["films", "2024", "a.mkv"]);
  for (const bad of ["..", "../x", "a/../b", "./a", "a//b", "/etc/passwd", "~/x", "a/", "C:/x", "a\\..\\b", "a\u0000b", `${TRASH_DIR}/x`, `a/${PART_PREFIX}abc`, " lead", "trail "]) {
    assert.throws(() => splitRelative(bad), (error) => error.status === 400, bad);
  }
  assert.throws(() => checkName("x".repeat(256)), /too long/);
  assert.equal(checkName("Film (2024) – ü.mkv"), "Film (2024) – ü.mkv");
});

test("kinds and served types never let a file run as Hog's page", () => {
  assert.equal(kindOf("a.JPG"), "image");
  assert.equal(kindOf("a.mkv"), "video");
  assert.equal(kindOf("a.flac"), "audio");
  assert.equal(kindOf("notes.md"), "text");
  assert.equal(kindOf("x", "dir"), "folder");
  assert.equal(servedType("page.html"), "text/plain; charset=utf-8");
  assert.equal(servedType("feed.xml"), "text/plain; charset=utf-8");
  assert.equal(servedType("app.js"), "text/plain; charset=utf-8");
  assert.equal(servedType("a.mp4"), "video/mp4");
  assert.match(contentDisposition("attachment", "ä \"x\".mkv"), /^attachment; filename="_ _x_.mkv"; filename\*=UTF-8''%C3%A4%20%22x%22.mkv$/);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 100), { invalid: true });
  assert.deepEqual(parseRange("bytes=1-2,4-5", 100), { invalid: true });
});

test("list, mkdir, rename and conflicts stay inside the root", async () => {
  const { shares, service } = sandbox();
  writeFileSync(join(shares, "a.txt"), "hello");
  mkdirSync(join(shares, "films"));
  mkdirSync(join(shares, TRASH_DIR));
  writeFileSync(join(shares, `${PART_PREFIX}0123456789abcdef`), "partial");
  const listing = await service.list({ root: "shares", path: "" });
  assert.deepEqual(listing.entries.map((e) => [e.name, e.type]).sort(), [["a.txt", "file"], ["films", "dir"]]);
  assert.ok(listing.space && listing.space.total > 0);
  await service.mkdir({ root: "shares", path: "films", name: "2024" });
  assert.ok(existsSync(join(shares, "films", "2024")));
  await rejects(service.mkdir({ root: "shares", path: "films", name: "2024" }), 409);
  await rejects(service.mkdir({ root: "shares", path: "..", name: "x" }), 400);
  await service.rename({ root: "shares", path: "a.txt", name: "b.txt" });
  assert.ok(existsSync(join(shares, "b.txt")));
  writeFileSync(join(shares, "c.txt"), "c");
  await rejects(service.rename({ root: "shares", path: "c.txt", name: "b.txt" }), 409);
  await rejects(service.rename({ root: "shares", path: "c.txt", name: "../c.txt" }), 400);
  await rejects(service.list({ root: "nope", path: "" }), 404);
});

test("symlinks that point outside the root are shown but never followed", async () => {
  const { shares, outside, service } = sandbox();
  symlinkSync(join(outside, "secret.txt"), join(shares, "leak.txt"));
  symlinkSync(outside, join(shares, "escape"));
  mkdirSync(join(shares, "real"));
  writeFileSync(join(shares, "real", "ok.txt"), "ok");
  symlinkSync(join(shares, "real"), join(shares, "inside-link"));
  const listing = await service.list({ root: "shares", path: "" });
  const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
  assert.equal(byName["leak.txt"].outside, true);
  assert.equal(byName.escape.outside, true);
  assert.equal(byName["inside-link"].type, "dir");
  await rejects(service.openFile({ root: "shares", path: "leak.txt" }), 403, /outside/);
  await rejects(service.list({ root: "shares", path: "escape" }), 403, /outside/);
  await rejects(service.openFile({ root: "shares", path: "escape/secret.txt" }), 403);
  await rejects(service.mkdir({ root: "shares", path: "escape", name: "x" }), 403);
  await rejects(service.uploadChunk({ root: "shares", dir: "escape", rel: "x.bin", id: "0123456789abcdef", offset: "0", total: "3" }, bytes("abc")), 403);
  await rejects(service.uploadChunk({ root: "shares", dir: "", rel: "escape/x.bin", id: "0123456789abcdef", offset: "0", total: "3" }, bytes("abc")), 403);
  await rejects(service.transfer({ root: "shares", paths: ["real/ok.txt"], dest: { root: "shares", path: "escape" } }), 403);
  await rejects(service.transfer({ root: "shares", paths: ["escape/secret.txt"], dest: { root: "shares", path: "real" } }), 403);
  const search = await service.search({ root: "shares", path: "", q: "secret" });
  assert.equal(search.entries.length, 0, "search does not walk through links");
  // Inside links work.
  assert.equal((await service.list({ root: "shares", path: "inside-link" })).entries[0].name, "ok.txt");
  // Trashing the link moves the link only; the target stays.
  await service.trash({ root: "shares", paths: ["leak.txt"] });
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "wallet-ish secret\n");
  // A root that is swapped for a link to somewhere refused stops working.
});

test("chunked uploads append in order and land with a free name", async () => {
  const { shares, service } = sandbox();
  const id = "aaaabbbbccccdddd";
  const one = await service.uploadChunk({ root: "shares", dir: "", rel: "films/movie.mkv", id, offset: "0", total: "9" }, bytes("abc"));
  assert.deepEqual(one, { ok: true, done: false, size: 3 });
  assert.ok(existsSync(join(shares, "films", `${PART_PREFIX}${id}`)));
  assert.equal((await service.list({ root: "shares", path: "films" })).entries.length, 0, "partial files are hidden");
  await rejects(service.uploadChunk({ root: "shares", dir: "", rel: "films/movie.mkv", id, offset: "5", total: "9" }, bytes("zzz")), 409);
  assert.equal((await service.uploadStatus({ root: "shares", dir: "", rel: "films/movie.mkv", id })).size, 3);
  await service.uploadChunk({ root: "shares", dir: "", rel: "films/movie.mkv", id, offset: "3", total: "9" }, bytes("def"));
  const last = await service.uploadChunk({ root: "shares", dir: "", rel: "films/movie.mkv", id, offset: "6", total: "9" }, bytes("g", "hi"));
  assert.equal(last.done, true);
  assert.equal(last.path, "films/movie.mkv");
  assert.equal(readFileSync(join(shares, "films", "movie.mkv"), "utf8"), "abcdefghi");
  const again = await service.uploadChunk({ root: "shares", dir: "films", rel: "movie.mkv", id: "eeeeffff00001111", offset: "0", total: "2" }, bytes("xy"));
  assert.equal(again.name, "movie (2).mkv");
  await rejects(service.uploadChunk({ root: "shares", dir: "", rel: "big.bin", id: "1111222233334444", offset: "0", total: "2" }, bytes("toolong")), 400, /bigger/);
  await rejects(service.uploadChunk({ root: "shares", dir: "", rel: "../x", id: "1111222233334444", offset: "0", total: "1" }, bytes("x")), 400);
  await rejects(service.uploadChunk({ root: "shares", dir: "", rel: "x", id: "../../etc", offset: "0", total: "1" }, bytes("x")), 400);
  const empty = await service.uploadChunk({ root: "shares", dir: "", rel: "empty.txt", id: "5555666677778888", offset: "0", total: "0" }, bytes());
  assert.equal(empty.done, true);
  await service.uploadChunk({ root: "shares", dir: "", rel: "gone.bin", id: "9999aaaabbbbcccc", offset: "0", total: "10" }, bytes("12"));
  await service.uploadCancel({ root: "shares", dir: "", rel: "gone.bin", id: "9999aaaabbbbcccc" });
  assert.ok(!readdirSync(shares).some((name) => name.startsWith(PART_PREFIX)));
});

test("move, copy and folder-into-itself", async () => {
  const { shares, service } = sandbox();
  mkdirSync(join(shares, "a", "deep"), { recursive: true });
  mkdirSync(join(shares, "b"));
  writeFileSync(join(shares, "x.txt"), "x");
  const moved = await service.transfer({ root: "shares", paths: ["x.txt"], dest: { root: "shares", path: "b" } });
  assert.equal(moved.done[0].path, "b/x.txt");
  assert.ok(!existsSync(join(shares, "x.txt")));
  const copied = await service.transfer({ root: "shares", paths: ["b/x.txt"], dest: { root: "shares", path: "b" }, copy: true });
  assert.equal(copied.done[0].name, "x (2).txt");
  const self = await service.transfer({ root: "shares", paths: ["a"], dest: { root: "shares", path: "a/deep" } });
  assert.equal(self.done.length, 0);
  assert.match(self.skipped[0].reason, /inside itself/);
  const same = await service.transfer({ root: "shares", paths: ["b/x.txt"], dest: { root: "shares", path: "b" } });
  assert.equal(same.skipped.length, 1);
});

test("delete goes to Hog's trash and can be restored", async () => {
  const { shares, service } = sandbox();
  mkdirSync(join(shares, "photos"));
  writeFileSync(join(shares, "photos", "cat.jpg"), "meow");
  const trashed = await service.trash({ root: "shares", paths: ["photos/cat.jpg"] });
  assert.equal(trashed.done.length, 1);
  assert.ok(!existsSync(join(shares, "photos", "cat.jpg")));
  assert.equal((await service.list({ root: "shares", path: "" })).entries.some((e) => e.name === TRASH_DIR), false);
  const bin = await service.trashList({});
  assert.equal(bin.items.length, 1);
  assert.equal(bin.items[0].path, "photos/cat.jpg");
  assert.equal((await service.roots()).roots[0].trash, 1);
  // The folder it came from is gone too; restore makes it again.
  await service.trash({ root: "shares", paths: ["photos"] });
  await service.restore({ root: "shares", ids: [bin.items[0].id] });
  assert.equal(readFileSync(join(shares, "photos", "cat.jpg"), "utf8"), "meow");
  // Restoring onto a taken name keeps both.
  writeFileSync(join(shares, "dup.txt"), "1");
  const t2 = await service.trash({ root: "shares", paths: ["dup.txt"] });
  writeFileSync(join(shares, "dup.txt"), "2");
  const back = await service.restore({ root: "shares", ids: [t2.done[0].id] });
  assert.equal(back.done[0].name, "dup (2).txt");
  const purged = await service.purge({ root: "shares", all: true });
  assert.equal(purged.removed, 1);
  assert.equal((await service.trashList({})).items.length, 0);
  await rejects(service.restore({ root: "shares", ids: ["../../x"] }), 400);
});

test("extra roots: home, hidden, system and wallet folders are refused", async () => {
  const { home, dataDir, base, service } = sandbox();
  mkdirSync(join(home, "Videos"));
  mkdirSync(join(home, ".ssh"));
  const ctx = { home, dataDir };
  assert.match((await rootProblem("~", ctx)).problem, /home folder itself/);
  assert.match((await rootProblem("/", ctx)).problem, /whole disk/);
  assert.match((await rootProblem("~/.ssh", ctx)).problem, /Hidden/);
  assert.match((await rootProblem(join(home, ".local"), ctx)).problem, /Hog's own data/);
  assert.match((await rootProblem(dataDir, ctx)).problem, /Hog's own data/);
  assert.match((await rootProblem("/etc", ctx)).problem, /home folder, or a disk/);
  assert.match((await rootProblem("relative/path", ctx)).problem, /full folder path/);
  assert.match((await rootProblem("~/missing", ctx)).problem, /does not exist/);
  symlinkSync(dataDir, join(home, "sneaky"));
  assert.match((await rootProblem("~/sneaky", ctx)).problem, /Hog's own data/);
  assert.equal((await rootProblem("~/Videos", ctx)).problem, undefined);
  const added = await service.addRoot({ path: "~/Videos" });
  assert.equal(added.roots.length, 2);
  await rejects(service.addRoot({ path: "~/Videos" }), 409);
  const id = added.added;
  writeFileSync(join(home, "Videos", "clip.mp4"), "v");
  assert.equal((await service.list({ root: id, path: "" })).entries[0].name, "clip.mp4");
  // Move across roots.
  await service.transfer({ root: id, paths: ["clip.mp4"], dest: { root: "shares", path: "" } });
  assert.ok(existsSync(join(home, "hog-shares", "clip.mp4")));
  const after = await service.removeRoot({ id });
  assert.equal(after.roots.length, 1);
  await rejects(service.removeRoot({ id: "shares" }), 400);
  assert.ok(base);
});

test("request checks: same origin only, and a header on changes", () => {
  const origin = "http://127.0.0.1:4188";
  const req = (method, headers = {}) => ({ method, headers });
  assert.equal(filesRequestProblem(req("GET"), origin), "");
  assert.equal(filesRequestProblem(req("GET", { "sec-fetch-site": "same-origin" }), origin), "");
  assert.notEqual(filesRequestProblem(req("GET", { "sec-fetch-site": "cross-site" }), origin), "");
  assert.notEqual(filesRequestProblem(req("GET", { "sec-fetch-site": "same-site" }), origin), "");
  assert.notEqual(filesRequestProblem(req("POST", { origin, "x-hog-files": "1", "sec-fetch-site": "cross-site" }), origin), "");
  assert.notEqual(filesRequestProblem(req("POST", { origin: "http://localhost:43110", "x-hog-files": "1" }), origin), "");
  assert.notEqual(filesRequestProblem(req("POST", { origin }), origin), "");
  assert.notEqual(filesRequestProblem(req("PUT", {}), origin), "");
  assert.equal(filesRequestProblem(req("POST", { origin, "x-hog-files": "1" }), origin), "");
});

test("HTTP: range downloads, sandboxed raw files, JSON errors", async () => {
  const { shares, service } = sandbox();
  writeFileSync(join(shares, "clip.mp4"), Buffer.from("0123456789"));
  writeFileSync(join(shares, "page.html"), "<script>alert(1)</script>");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    handleFilesRequest(service, req, res, url, { origin: "http://127.0.0.1:1" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/files`;
  try {
    const full = await fetch(`${base}/raw?root=shares&path=clip.mp4`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.match(full.headers.get("content-security-policy"), /^sandbox/);
    assert.equal(full.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(await full.text(), "0123456789");
    const part = await fetch(`${base}/raw?root=shares&path=clip.mp4`, { headers: { range: "bytes=2-4" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
    assert.equal(await part.text(), "234");
    const bad = await fetch(`${base}/raw?root=shares&path=clip.mp4`, { headers: { range: "bytes=50-" } });
    assert.equal(bad.status, 416);
    const html = await fetch(`${base}/raw?root=shares&path=page.html`);
    assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8");
    const dl = await fetch(`${base}/raw?root=shares&path=clip.mp4&download=1`);
    assert.match(dl.headers.get("content-disposition"), /^attachment;/);
    const escape = await fetch(`${base}/raw?root=shares&path=../../etc/passwd`);
    assert.equal(escape.status, 400);
    assert.equal((await escape.json()).ok, false);
    const noHeader = await fetch(`${base}/mkdir`, { method: "POST", body: JSON.stringify({ root: "shares", path: "", name: "x" }) });
    assert.equal(noHeader.status, 403);
    const made = await fetch(`${base}/mkdir`, { method: "POST", headers: { "x-hog-files": "1", "content-type": "application/json" }, body: JSON.stringify({ root: "shares", path: "", name: "x" }) });
    assert.equal(made.status, 200);
    const up = await fetch(`${base}/upload?root=shares&dir=x&rel=a.bin&id=0123456789abcdef&offset=0&total=4`, { method: "PUT", headers: { "x-hog-files": "1" }, body: "abcd" });
    assert.deepEqual(await up.json(), { ok: true, done: true, size: 4, name: "a.bin", path: "x/a.bin" });
    const listing = await (await fetch(`${base}/list?root=shares&path=x`)).json();
    assert.equal(listing.entries[0].size, 4);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
