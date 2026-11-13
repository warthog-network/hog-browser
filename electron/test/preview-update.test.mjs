import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const up = require("../lib/preview-update.js");
const { DefaultBrowser, DESKTOP } = require("../lib/default-browser.js");

const rel = (tag, ver, extra = {}) => ({
  tag_name: tag,
  prerelease: true,
  draft: false,
  html_url: `https://github.com/warthog-network/hog-browser/releases/tag/${tag}`,
  assets: [{ name: `hog-chromium-preview_${ver}_amd64.deb` }, { name: `hog-chromium-preview_${ver}_x86_64.AppImage` }],
  ...extra,
});

test("preview versions order previews before the plain release", () => {
  assert.equal(up.compareVersions("0.1.40-preview.3", "0.1.40-preview.2"), 1);
  assert.equal(up.compareVersions("0.1.40-preview.9", "0.1.41-preview.1"), -1);
  assert.equal(up.compareVersions("0.1.40", "0.1.40-preview.9"), 1);
  assert.equal(up.compareVersions("junk", "0.1.40"), 0);
});

test("only newer preview pre-releases count; normal releases and drafts never do", () => {
  const releases = [
    { ...rel("v0.1.41", "0.1.41"), prerelease: false },
    rel("preview-0.1.40-2", "0.1.40-preview.2"),
    rel("preview-0.1.40-5", "0.1.40-preview.5"),
    rel("preview-0.1.40-9", "0.1.40-preview.9", { draft: true }),
    rel("other-0.1.40-8", "0.1.40-preview.8"),
    rel("preview-0.1.40-7", "0.1.40-preview.7", { html_url: "https://evil.example/" }),
  ];
  const best = up.pickUpdate(releases, "0.1.40-preview.3");
  assert.equal(best.version, "0.1.40-preview.5");
  assert.equal(best.tag, "preview-0.1.40-5");
  assert.equal(up.pickUpdate(releases, "0.1.40-preview.5"), null);
  assert.equal(up.pickUpdate(null, "0.1.40-preview.3"), null);
  assert.ok(!up.RELEASES_URL.includes("/latest"));
});

test("default browser: set remembers the previous browser, clear restores it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hogdb-"));
  let current = "hog-browser.desktop";
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "xdg-settings" && args[0] === "get") return { code: 0, stdout: `${current}\n`, stderr: "" };
    if (cmd === "xdg-settings" && args[0] === "set") current = args[2];
    return { code: 0, stdout: "", stderr: "" };
  };
  const db = new DefaultBrowser(dir, { runner, installed: () => true });
  let p = await db.set();
  assert.equal(p.ok, true);
  assert.equal(p.defaultBrowser, true);
  assert.equal(p.defaultBrowserPrevious, "hog-browser.desktop");
  assert.equal(current, DESKTOP);
  p = await db.clear();
  assert.equal(current, "hog-browser.desktop");
  assert.equal(p.defaultBrowser, false);
  const missing = new DefaultBrowser(dir, { runner, installed: () => false });
  assert.equal((await missing.set()).ok, false);
  assert.equal((await missing.status()).defaultBrowserAvailable, false);
});

test("one-click update: SHA256SUMS, package check, pkexec hand-off", async () => {
  const crypto = await import("node:crypto");
  const { EventEmitter } = await import("node:events");
  const deb = Buffer.from("not really a deb but bytes");
  const hex = crypto.createHash("sha256").update(deb).digest("hex");
  const name = "hog-chromium-preview_0.1.40-preview.5_amd64.deb";
  assert.equal(up.hashFor(`${hex}  ${name}\nffff  other`, name), hex);
  assert.equal(up.hashFor(`${hex} *${name}`, name), hex);
  assert.equal(up.hashFor("junk", name), "");
  assert.equal(up.debianVersion("0.1.40-preview.5"), "0.1.40~preview.5");
  assert.equal(up.canInstallDeb({ isPackaged: false, execPath: "/x" }).ok, false);
  assert.equal(up.canInstallDeb({ isPackaged: true, execPath: "/opt/Hog (Chromium preview)/hog-chromium-preview", env: { APPIMAGE: "/a" } }).ok, false);
  assert.equal(up.canInstallDeb({ isPackaged: true, execPath: "/opt/Hog (Chromium preview)/hog-chromium-preview", env: {}, exists: () => true }).ok, true);

  const base = `${up.DOWNLOAD_PREFIX}preview-0.1.40-5/`;
  const found = { version: "0.1.40-preview.5", deb: name, debUrl: base + name, sumsUrl: `${base}SHA256SUMS` };
  const fetchWith = (sums, body) => async (url) => (url.endsWith("SHA256SUMS") ? new Response(sums) : new Response(body, { headers: { "content-length": String(body.length) } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hogup-"));
  let progress = 0;
  const file = await up.downloadVerified(found, path.join(dir, "a"), { fetchImpl: fetchWith(`${hex}  ${name}\n`, deb), onProgress: () => (progress += 1) });
  assert.deepEqual(fs.readFileSync(file), deb);
  assert.ok(progress > 0);
  await assert.rejects(up.downloadVerified(found, path.join(dir, "b"), { fetchImpl: fetchWith(`${"0".repeat(64)}  ${name}\n`, deb) }), /does not match/);
  assert.ok(!fs.existsSync(path.join(dir, "b", name)));
  await assert.rejects(up.downloadVerified({ ...found, sumsUrl: "" }, dir, { fetchImpl: fetchWith("", deb) }), /SHA256SUMS/);
  await assert.rejects(up.downloadVerified({ ...found, debUrl: "https://evil.example/x.deb" }, dir, { fetchImpl: fetchWith("", deb) }), /no preview \.deb/);

  const fields = (out) => async () => ({ code: 0, stdout: out, stderr: "" });
  await up.checkDebFields("/x.deb", "0.1.40-preview.5", fields("Package: hog-chromium-preview\nVersion: 0.1.40~preview.5\n"));
  await assert.rejects(up.checkDebFields("/x.deb", "0.1.40-preview.5", fields("Package: hog-browser\nVersion: 0.1.40~preview.5\n")), /not hog-chromium-preview/);
  await assert.rejects(up.checkDebFields("/x.deb", "0.1.40-preview.5", fields("Package: hog-chromium-preview\nVersion: 0.1.40~preview.4\n")), /expected/);

  const calls = [];
  const fakeSpawn = (code) => (cmd, args) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", code));
    return child;
  };
  assert.deepEqual(await up.installDeb("/tmp/d/x.deb", fakeSpawn(0)), { ok: true });
  assert.deepEqual(calls[0], ["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "--no-install-recommends", "/tmp/d/x.deb"]);
  assert.match((await up.installDeb("/tmp/d/x.deb", fakeSpawn(126))).error, /cancelled/);
  assert.equal((await up.installDeb("x.deb", fakeSpawn(0))).ok, false);
});

test("pickUpdate carries the download and SHA256SUMS links", () => {
  const r = rel("preview-0.1.40-5", "0.1.40-preview.5");
  r.assets = [
    { name: "hog-chromium-preview_0.1.40-preview.5_amd64.deb", browser_download_url: `${up.DOWNLOAD_PREFIX}preview-0.1.40-5/hog-chromium-preview_0.1.40-preview.5_amd64.deb` },
    { name: "SHA256SUMS", browser_download_url: `${up.DOWNLOAD_PREFIX}preview-0.1.40-5/SHA256SUMS` },
  ];
  const best = up.pickUpdate([r], "0.1.40-preview.4");
  assert.ok(up.validDownloadUrl(best.debUrl));
  assert.ok(best.sumsUrl.endsWith("/SHA256SUMS"));
});
