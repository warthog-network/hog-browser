import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PreviewSettings, SitePermissions } = require("../lib/preview-settings.js");
const cookies = require("../lib/cookies.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hogprev-"));

test("preview settings default to WebKit Hog's behaviour and persist", () => {
  const dir = tmp();
  const s = new PreviewSettings(dir);
  assert.equal(s.get("blockThirdPartyCookies"), true);
  assert.equal(s.get("previewUpdateChecks"), false);
  assert.equal(s.get("terminalPanel"), false);
  assert.equal(s.get("terminalHeight"), 240);
  assert.equal(s.set("blockThirdPartyCookies", false), true);
  assert.equal(s.set("terminalPanel", true), true);
  assert.equal(s.set("terminalHeight", 320), true);
  assert.equal(s.set("blockThirdPartyCookies", "no"), false);
  assert.equal(s.set("bogus", true), false);
  assert.equal(new PreviewSettings(dir).get("blockThirdPartyCookies"), false);
  assert.equal(new PreviewSettings(dir).get("terminalPanel"), true);
  assert.equal(new PreviewSettings(dir).get("terminalHeight"), 320);
  assert.equal(fs.statSync(path.join(dir, "preview-settings.json")).mode & 0o777, 0o600);
});

test("site permissions remember only when asked to", () => {
  const dir = tmp();
  const p = new SitePermissions(dir);
  const n = SitePermissions.key("https://a.example", "notifications");
  assert.equal(p.lookup(n), undefined);
  p.answer(n, true, false);
  assert.equal(p.lookup(n), true);
  assert.equal(new SitePermissions(dir).lookup(n), undefined);
  p.answer(n, false, true);
  assert.equal(new SitePermissions(dir).lookup(n), false);
  const cam = SitePermissions.key("https://a.example", "media", ["video"]);
  p.answer(cam, true, true);
  assert.equal(p.allows("https://a.example", "media", ["video"]), true);
  assert.equal(p.allows("https://a.example", "media", ["audio", "video"]), false);
  p.answer("javascript:x notifications", true, true);
  assert.equal(p.count(), 2);
  p.forgetAll();
  assert.equal(new SitePermissions(dir).count(), 0);
});

test("third-party requests are spotted by registrable domain", () => {
  assert.equal(cookies.site("https://www.youtube.com/watch"), "youtube.com");
  assert.equal(cookies.site("https://a.b.co.uk/"), "b.co.uk");
  assert.equal(cookies.site("https://me.github.io/"), "me.github.io");
  assert.equal(cookies.isThirdParty("https://i.ytimg.com/x.jpg", "https://www.youtube.com/", "image"), true);
  assert.equal(cookies.isThirdParty("https://m.youtube.com/x", "https://www.youtube.com/", "xhr"), false);
  assert.equal(cookies.isThirdParty("https://accounts.google.com/", "https://www.youtube.com/", "mainFrame"), false);
  assert.equal(cookies.isThirdParty("https://x.com/", "about:blank", "script"), false);
  const { headers, removed } = cookies.stripHeader({ Cookie: "a=1", Accept: "*/*" }, "cookie");
  assert.deepEqual(headers, { Accept: "*/*" });
  assert.equal(removed, true);
});
