import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const policy = require("../lib/policy.js");
const PORTS = [4188, 43100];

test("pages open http(s) only and never Hog's own ports", () => {
  assert.equal(policy.pageAllowed("https://example.com/", PORTS), true);
  assert.equal(policy.pageAllowed("http://127.0.0.1:8096/", PORTS), true);
  assert.equal(policy.pageAllowed("http://127.0.0.1:4188/api/wallet", PORTS), false);
  assert.equal(policy.pageAllowed("http://localhost:43100/", PORTS), false);
  assert.equal(policy.pageAllowed("file:///etc/passwd", PORTS), false);
  assert.equal(policy.pageAllowed("javascript:alert(1)", PORTS), false);
  assert.equal(policy.pageAllowed("https://user:pw@example.com/", PORTS), false);
  assert.equal(policy.pageAllowed("http://169.254.169.254/latest", PORTS), false);
});

test("in-page schemes and origins", () => {
  assert.equal(policy.inPageNavigation("about:blank"), true);
  assert.equal(policy.inPageNavigation("about:srcdoc"), true);
  assert.equal(policy.inPageNavigation("blob:https://x/1"), true);
  assert.equal(policy.inPageNavigation("mailto:a@b"), false);
  assert.equal(policy.pageOrigin("https://app.uniswap.org/swap", PORTS), "https://app.uniswap.org");
  assert.equal(policy.pageOrigin("http://127.0.0.1:4188/", PORTS), "");
});

test("argv and tailscale URLs", () => {
  assert.equal(policy.allowedBrowserOpenUrl("https://example.com"), "https://example.com");
  assert.equal(policy.allowedBrowserOpenUrl("file:///tmp/x.html"), "");
  assert.equal(policy.allowedTailscaleOpenUrl("https://login.tailscale.com/a/abcdef0123456"), "https://login.tailscale.com/a/abcdef0123456");
  assert.equal(policy.allowedTailscaleOpenUrl("https://evil.example/a/abcdef0123456789012"), "");
});

test("download names never escape the folder or replace a file", () => {
  assert.equal(policy.downloadName("../../.bashrc"), "bashrc");
  assert.equal(policy.downloadName("", "https://x.org/files/app%20v1.deb"), "app v1.deb");
  assert.equal(policy.downloadName(""), "download");
  const existing = new Set(["/d/a.tar.gz", "/d/a (1).tar.gz"]);
  assert.equal(policy.uniqueDownloadPath("/d", "a.tar.gz", new Set(), (p) => existing.has(p)), "/d/a (2).tar.gz");
  assert.equal(policy.uniqueDownloadPath("/d", "b.apk", new Set(["/d/b.apk"]), () => false), "/d/b (1).apk");
});

test("hog://files download links", () => {
  assert.equal(policy.filesDownloadUri("http://127.0.0.1:4188/api/files/raw?root=shares&path=a&download=1", 4188), true);
  assert.equal(policy.filesDownloadUri("http://127.0.0.1:4188/api/files/raw?root=shares&path=a", 4188), false);
  assert.equal(policy.filesDownloadUri("http://127.0.0.1:9999/api/files/raw?root=s&download=1", 4188), false);
});

test("view and edge commands", () => {
  assert.deepEqual(policy.parseView("view:10:50:0:0:1:7"), { left: 10, top: 50, right: 0, bottom: 0, show: true, tabId: "7" });
  assert.equal(policy.parseView("view:x"), null);
  assert.deepEqual(policy.viewBounds({ left: 10, top: 50, right: 20, bottom: 0 }, 1000, 700), { x: 10, y: 50, width: 970, height: 650 });
  const edges = "edges:0:0:0:0:0:0:0:0:0:200:16:36:0:0:0:0";
  assert.deepEqual(policy.parseEdges(edges, 50), { tabs: true, tabsTop: 150, wallet: false, walletTop: -50 });
});

test("the grip script is reused from the GTK shell, minus WebKit's handler", () => {
  const source = readFileSync(new URL("../../hog", import.meta.url), "utf8");
  const script = policy.extractEdgeGripScript(source);
  assert.ok(script.includes("__hogEdgeGrips"));
  assert.ok(script.includes("window.__hogEdgePost("));
  assert.ok(!script.includes("messageHandlers"));
  const dapp = policy.rewriteMessageHandler(readFileSync(new URL("../../public/dapp-provider.js", import.meta.url), "utf8"));
  assert.ok(!dapp.includes("messageHandlers.hogedge"));
});

test("Chrome user agent hides Electron", () => {
  const ua = policy.chromeUserAgent("156.0.7000.1", "linux");
  assert.match(ua, /Chrome\/156\.0\.0\.0 Safari\/537\.36$/);
  assert.ok(!/Electron/.test(ua));
});

test("dapp provider stays off Tailscale pages", () => {
  assert.equal(policy.dappProviderAllowed("https://login.tailscale.com/admin"), false);
  assert.equal(policy.dappProviderAllowed("https://app.uniswap.org/"), true);
});
