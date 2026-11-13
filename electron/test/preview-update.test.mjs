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
