"use strict";
// The page preload must carry the Linux shell's page scripts verbatim.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const here = path.join(__dirname, "..");
const root = path.join(here, "..");

test("hog still defines EDGE_GRIP_SCRIPT where stage.mjs extracts it", () => {
  const hog = fs.readFileSync(path.join(root, "hog"), "utf8");
  assert.match(hog, /^EDGE_GRIP_SCRIPT = r"""\n[\s\S]*?window\.__hogEdgeGrips[\s\S]*?\n"""/m);
});

test("chrome preload exposes the hogwin bridge and Windows flags", () => {
  const src = fs.readFileSync(path.join(here, "preload-chrome.cjs"), "utf8");
  for (const s of ['"__hogDesktop"', '"__hogPlatform"', "hogwin", '"webkit"']) assert.ok(src.includes(s), s);
});

test("generated page preload (after stage) has both scripts and the Tailscale block", { skip: !fs.existsSync(path.join(here, "gen", "preload-page.cjs")) }, () => {
  const src = fs.readFileSync(path.join(here, "gen", "preload-page.cjs"), "utf8");
  assert.ok(src.includes("window.__hogEdgeGrips"));
  assert.ok(src.includes("window.__hogDappResolve"));
  assert.ok(src.includes('host.endsWith(".tailscale.com")'));
  assert.ok(!src.includes("/*@EDGE_GRIP_SCRIPT@*/"));
  new Function(src.replace(/^"use strict";/, "")); // parses
});
