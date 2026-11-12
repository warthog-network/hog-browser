"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const r = require("../lib/rules.cjs");

test("pages: http(s) only, never Hog's own ports, metadata or credentials", () => {
  assert.equal(r.allowedPage("https://example.com/x"), true);
  assert.equal(r.allowedPage("http://127.0.0.1:8096/"), true);
  assert.equal(r.allowedPage("http://127.0.0.1:4188/"), false);
  assert.equal(r.allowedPage("http://localhost:43100/"), false);
  assert.equal(r.allowedPage("http://169.254.169.254/latest"), false);
  assert.equal(r.allowedPage("http://metadata.google.internal/"), false);
  assert.equal(r.allowedPage("https://user:pw@example.com/"), false);
  assert.equal(r.allowedPage("file:///C:/Windows/win.ini"), false);
  assert.equal(r.allowedPage("javascript:alert(1)"), false);
  assert.equal(r.allowedPage("mailto:a@b.c"), false);
  assert.equal(r.allowedPage("not a url"), false);
});

test("in-page navigations: blob, data, javascript, about:blank/srcdoc", () => {
  for (const u of ["blob:https://a.b/1", "data:text/html,x", "javascript:void(0)", "about:blank", "about:srcdoc"]) assert.equal(r.inPageNavigation(u), true, u);
  for (const u of ["about:config", "mailto:x@y.z", "https://a.b/"]) assert.equal(r.inPageNavigation(u), false, u);
});

test("page origins drop default ports and refuse Hog's own", () => {
  assert.equal(r.pageOrigin("https://app.uniswap.org:443/swap"), "https://app.uniswap.org");
  assert.equal(r.pageOrigin("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080");
  assert.equal(r.pageOrigin("http://127.0.0.1:4188/"), "");
  assert.equal(r.pageOrigin("file:///x"), "");
});

test("URLs from the command line / default browser and Tailscale login", () => {
  assert.equal(r.allowedBrowserOpenUrl("https://warthog.network/"), "https://warthog.network/");
  assert.equal(r.allowedBrowserOpenUrl("file:///C:/x"), "");
  assert.equal(r.allowedBrowserOpenUrl("https://a b.com/"), "");
  assert.equal(r.allowedTailscaleOpenUrl("https://login.tailscale.com/a/0123456789abcdef"), "https://login.tailscale.com/a/0123456789abcdef");
  assert.equal(r.allowedTailscaleOpenUrl("https://evil.example/a/0123456789abcdef0123"), "");
  assert.equal(r.allowedTailscaleOpenUrl("https://login.tailscale.com/a/0123456789abcdef#x"), "");
});

test("view commands and page bounds", () => {
  assert.deepEqual(r.parseViewCommand("view:200:84:340:0:1:t3"), { left: 200, top: 84, right: 340, bottom: 0, show: true, tab: "t3" });
  assert.deepEqual(r.parseViewCommand("view:-5:84:0:0:0"), { left: 0, top: 84, right: 0, bottom: 0, show: false, tab: "" });
  assert.equal(r.parseViewCommand("view:a:1:2:3:1:t"), null);
  assert.equal(r.parseViewCommand("view:1:2"), null);
  assert.deepEqual(r.pageBounds({ width: 1180, height: 760 }, { left: 200, top: 84, right: 340, bottom: 0 }), { x: 200, y: 84, width: 640, height: 676 });
  assert.deepEqual(r.pageBounds({ width: 100, height: 100 }, { left: 80, top: 0, right: 80, bottom: 0 }).width, 0);
});

test("shortcuts: Ctrl+D bookmark, Ctrl+Shift+O bookmarks page", () => {
  assert.equal(r.shortcutFor({ type: "keyDown", key: "d", control: true }), "bookmark");
  assert.equal(r.shortcutFor({ type: "keyDown", key: "O", control: true, shift: true }), "bookmarks");
  assert.equal(r.shortcutFor({ type: "keyDown", key: "d", control: true, shift: true }), "");
  assert.equal(r.shortcutFor({ type: "keyUp", key: "d", control: true }), "");
  assert.equal(r.shortcutFor({ type: "keyDown", key: "d" }), "");
});

test("dapp requests and events are checked like the Linux shell", () => {
  assert.deepEqual(r.dappRequest('{"id":3,"method":"eth_requestAccounts"}'), { id: 3, method: "eth_requestAccounts", params: [] });
  assert.equal(r.dappRequest('{"id":0,"method":"x"}'), null);
  assert.equal(r.dappRequest('{"id":true,"method":"x"}'), null);
  assert.equal(r.dappRequest('{"id":1,"method":"","params":[]}'), null);
  assert.equal(r.dappRequest('{"id":1,"method":"x","params":{}}'), null);
  assert.equal(r.dappRequest("x".repeat(200_001)), null);
  const acct = `0x${"a".repeat(40)}`;
  assert.deepEqual(r.dappEmit(JSON.stringify({ origin: "https://a.b", event: "accountsChanged", payload: [acct] })), { origin: "https://a.b", event: "accountsChanged", payload: [acct] });
  assert.equal(r.dappEmit(JSON.stringify({ origin: "https://a.b", event: "accountsChanged", payload: ["0x1"] })), null);
  assert.equal(r.dappEmit(JSON.stringify({ origin: "https://a.b", event: "chainChanged", payload: "0x1" })).payload, "0x1");
  assert.equal(r.dappEmit(JSON.stringify({ origin: "file:///", event: "chainChanged", payload: "0x1" })), null);
  assert.equal(r.dappEmit(JSON.stringify({ origin: "https://a.b", event: "message", payload: "0x1" })), null);
});

test("edge grips follow the chrome's edges command", () => {
  const nums = [0, 0, 0, 0, 0, 0, 0, 0, 10, 300, 20, 40, 900, 320, 20, 40];
  assert.deepEqual(r.gripPaint(`edges:${nums.join(":")}`, 84), { tabs: true, tabsTop: 216, wallet: true, walletTop: 236 });
  assert.equal(r.gripPaint("edges:1:2", 0), null);
});

test("bookmark files: import, export (.html added), one-time backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hogwin-"));
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://warthog.network/">Warthog</A></DL>';
  const out = r.writeBookmarkFile(path.join(dir, "marks"), html);
  assert.equal(out.ok, true);
  assert.equal(path.extname(out.path), ".html");
  const back = r.readBookmarkFile(out.path);
  assert.equal(back.ok, true);
  assert.equal(back.text, html);
  assert.equal(r.readBookmarkFile(path.join(dir, "missing.html")).ok, false);
  const backup = r.bookmarkBackupPath(dir);
  assert.equal(r.writeBookmarkBackup(backup, "[1]"), true);
  assert.equal(r.writeBookmarkBackup(backup, "[2]"), false);
  assert.equal(fs.readFileSync(backup, "utf8"), "[1]");
});

test("updates: only a newer release with a Windows installer counts", () => {
  assert.equal(r.newerVersion("0.1.27", "0.1.26"), true);
  assert.equal(r.newerVersion("0.1.26", "0.1.26"), false);
  assert.equal(r.newerVersion("0.2.0", "0.10.0"), false);
  const linuxOnly = { tag_name: "0.1.27", html_url: "https://github.com/warthog-network/hog-browser/releases/tag/0.1.27", assets: [{ name: "hog-browser_0.1.27_amd64.deb" }] };
  assert.equal(r.updatePayload("0.1.26", linuxOnly).updateAvailable, false);
  const withExe = { ...linuxOnly, assets: [...linuxOnly.assets, { name: "Hog-Setup-0.1.27-x64.exe" }] };
  const p = r.updatePayload("0.1.26", withExe);
  assert.equal(p.updateAvailable, true);
  assert.equal(p.latestVersion, "0.1.27");
  assert.equal(p.updateCanInstall, false);
  assert.equal(r.updatePayload("0.1.26", null).ok, false);
});
