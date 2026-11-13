import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const geo = require("../lib/geolocation.js");
const policy = require("../lib/policy.js");
const contextMenu = require("../lib/context-menu.js");

test("fixes are validated and filled in", () => {
  assert.equal(geo.cleanFix({ latitude: 91, longitude: 0 }), null);
  assert.equal(geo.cleanFix({ latitude: "x", longitude: 0 }), null);
  const fix = geo.cleanFix({ latitude: 52.5, longitude: 13.4, accuracy: 0, altitude: -1.8e308, heading: -1, speed: 2 }, 1000);
  assert.deepEqual(fix, { latitude: 52.5, longitude: 13.4, accuracy: 5000, altitude: null, altitudeAccuracy: null, heading: null, speed: 2, timestamp: 1000 });
  assert.equal(geo.parseBeaconDb({ location: { lat: 1, lng: 2 }, accuracy: 25000 }, 5).accuracy, 25000);
  assert.equal(geo.parseBeaconDb({ error: {} }), null);
});

test("locator: off, GeoClue helper, BeaconDB, cache", async () => {
  let runs = 0;
  const loc = new geo.Locator({
    helper: "/x.py",
    runner: async (args) => {
      runs += 1;
      assert.deepEqual(args, ["/x.py", "--high"]);
      return { ok: true, latitude: 1, longitude: 2, accuracy: 10 };
    },
    fetchImpl: async (url, opts) => {
      assert.equal(url, geo.BEACONDB_URL);
      assert.equal(opts.method, "POST");
      return { ok: true, json: async () => ({ location: { lat: 3, lng: 4 }, accuracy: 9000 }) };
    },
  });
  assert.equal((await loc.locate("off")).ok, false);
  assert.equal((await loc.locate("nonsense")).ok, false);
  assert.equal((await loc.locate("system", { high: true })).fix.latitude, 1);
  await loc.locate("system", { high: true });
  assert.equal(runs, 1);
  assert.equal((await loc.locate("beacondb")).fix.longitude, 4);
  const failing = new geo.Locator({ runner: async () => ({ ok: false, error: "GeoClue: denied" }) });
  assert.deepEqual(await failing.locate("system"), { ok: false, error: "GeoClue: denied" });
});

test("the geolocation shim parses and needs the bridge", () => {
  assert.doesNotThrow(() => new Function(geo.GEO_SHIM));
  assert.ok(geo.GEO_SHIM.includes("__hogGeo"));
});

test("popups: tabs after a click, windows for sign-in popups, nothing unasked", () => {
  const ok = { allowed: true, gesture: true };
  assert.equal(policy.popupDecision({ url: "https://a.example/", disposition: "foreground-tab", features: "" }, { allowed: true, gesture: false }).kind, "deny");
  assert.equal(policy.popupDecision({ url: "https://a.example/", disposition: "foreground-tab", features: "" }, { allowed: false, gesture: true }).kind, "deny");
  assert.equal(policy.popupDecision({ url: "https://a.example/", disposition: "foreground-tab", features: "" }, ok).kind, "tab");
  assert.equal(policy.popupDecision({ url: "https://a.example/", disposition: "background-tab", features: "noopener" }, ok).kind, "tab");
  const w = policy.popupDecision({ url: "https://accounts.google.com/o/oauth2", disposition: "new-window", features: "width=500,height=9999,left=10" }, ok);
  assert.deepEqual(w, { kind: "window", width: 500, height: 1000 });
  assert.equal(policy.popupDecision({ url: "https://github.com/login", disposition: "foreground-tab", features: "popup" }, ok).kind, "window");
  assert.equal(policy.popupDecision({ url: "https://github.com/login", disposition: "foreground-tab", features: "popup=0" }, ok).kind, "tab");
});

test("page context menu has Save page as", () => {
  let saved = 0;
  const t = contextMenu.buildTemplate({}, { savePage: () => (saved += 1), canBack: false, canForward: false }, { page: true });
  const item = t.find((i) => i.label === "Save page as…");
  assert.ok(item);
  item.click();
  assert.equal(saved, 1);
  assert.ok(!contextMenu.buildTemplate({}, {}, { page: false }).some((i) => i.label === "Save page as…"));
});
