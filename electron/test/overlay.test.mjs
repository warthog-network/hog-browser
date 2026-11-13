import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const geo = require("../lib/overlay-geometry.js");
const page = { x: 100, y: 80, width: 800, height: 600 };

test("grips sit on the page edges and stay inside it", () => {
  assert.deepEqual(geo.gripBounds("tabs", page, 50, false), { x: 100, y: 130, width: 16, height: 36, top: 50 });
  const wallet = geo.gripBounds("wallet", page, 50, true);
  assert.equal(wallet.x + wallet.width, 900);
  assert.equal(wallet.width, geo.GRIP_HOT_W);
  assert.equal(geo.gripBounds("tabs", page, -40, false).top, 8);
  assert.equal(geo.gripBounds("tabs", page, 9999, false).top, 600 - 36 - 8);
});

test("menu bounds cover only the menus, clamped to the window", () => {
  const b = geo.menuBounds([{ x: 700, y: 40, w: 260, h: 300 }, { x: 650, y: 60, w: 20, h: 20 }], 920, 700);
  assert.deepEqual(b, { x: 650, y: 40, width: 270, height: 300 });
  assert.deepEqual(geo.menuBounds([], 10, 10), { x: 0, y: 0, width: 0, height: 0 });
});

test("surface reports are cleaned", () => {
  const s = geo.cleanSurface({
    cover: 1,
    css: ["http://127.0.0.1:4188/app.css", "https://evil.example/x.css", "javascript:alert(1)"],
    menus: [
      { kind: "settings", html: "<div></div>", rect: { x: 1, y: 2, w: 30, h: 40 }, scroll: 5 },
      { kind: "bogus", html: "<div></div>", rect: { x: 1, y: 2, w: 30, h: 40 } },
      { kind: "history", html: "<div></div>", rect: { x: "a", y: 2, w: 30, h: 40 } },
    ],
  });
  assert.equal(s.cover, true);
  assert.deepEqual(s.css, ["http://127.0.0.1:4188/app.css"]);
  assert.equal(s.menus.length, 1);
  assert.equal(s.menus[0].kind, "settings");
  assert.deepEqual(geo.cleanSurface(null), { menus: [], toasts: [], cover: false, css: [] });
  const t = geo.cleanSurface({ toasts: [{ kind: "toasts", html: "<div></div>", rect: { x: 900, y: 600, w: 300, h: 60 } }, { kind: "toasts", html: "<b></b>", rect: { x: 1, y: 1, w: 9, h: 9 } }] });
  assert.equal(t.toasts.length, 1);
  assert.equal(t.menus.length, 0);
});

test("the floating Tabs / Wallet label is parsed like the GTK shell does", () => {
  assert.deepEqual(geo.parsePill("pill:2:120:112:36:tabs:Tabs ›"), { x: 2, y: 120, w: 112, h: 36, side: "tabs", label: "Tabs ›" });
  assert.equal(geo.parsePill("pill:2:120:112:36:wallet:a:b").label, "a:b");
  assert.equal(geo.parsePill("pill:2:120:12:36:tabs:x"), null);
  assert.equal(geo.parsePill("pill:2:120:112:36:evil:x"), null);
  assert.equal(geo.parsePill("pill:hide"), null);
});
