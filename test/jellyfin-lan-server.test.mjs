import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const base = realpathSync(mkdtempSync(join(tmpdir(), "hog-lan-srv-")));
mkdirSync(join(base, "hog-shares"), { recursive: true });
mkdirSync(join(base, "data"), { recursive: true });
process.env.HOG_SHARES_DIR = join(base, "hog-shares");
process.env.HOG_FILES_CONFIG = join(base, "data", "files.json");
process.env.HOG_DATA = join(base, "data");
process.env.HOG_MOBILE_CONFIG = join(base, "data", "mobile.json");
process.env.HOG_MOBILE_NO_TAILNET = "1";
process.env.HOG_JELLYFIN_LAN_CONFIG = join(base, "data", "jellyfin-lan.json");
process.env.HOG_JELLYFIN_LAN_NO_LAN = "1";
process.env.HOG_JELLYFIN_PORT = "1";
process.env.HOG_UFW_CONF = join(base, "no-ufw.conf");
const { startServer, jellyfinLanInternals } = await import("../server.mjs");

function gateFrom(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  const match = list.join(";").match(/hog_gate=[^;]+/);
  assert.ok(match, "gate cookie");
  return match[0];
}

test("Containers → Jellyfin → Home network access: gated, off by default, persists", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/api/jellyfin-lan`)).status, 403, "needs Hog's gate cookie");
    const cookie = gateFrom(await fetch(`${origin}/`));
    const off = await (await fetch(`${origin}/api/jellyfin-lan`, { headers: { cookie } })).json();
    assert.equal(off.enabled, false);
    assert.deepEqual(off.listening, []);
    assert.equal(off.jellyfinUp, false);
    const post = (body, extra = {}) => fetch(`${origin}/api/jellyfin-lan`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-hog-lan": "1", ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${origin}/api/jellyfin-lan`, { method: "POST", headers: { cookie }, body: JSON.stringify({ enabled: true }) })).status, 403, "changes need x-hog-lan");
    assert.equal((await post({ enabled: "yes" })).status, 400);
    const on = await (await post({ enabled: true })).json();
    assert.equal(on.enabled, true);
    assert.deepEqual(on.urls, []);
    assert.match(on.error, /no home-network address/);
    assert.deepEqual(JSON.parse(readFileSync(process.env.HOG_JELLYFIN_LAN_CONFIG, "utf8")), { enabled: true });
    assert.equal(jellyfinLanInternals.forwarder.status().wanted, true);
    const back = await (await post({ enabled: false })).json();
    assert.equal(back.enabled, false);
    assert.equal(back.error, "");
    assert.equal(jellyfinLanInternals.forwarder.status().wanted, false);
    assert.deepEqual(JSON.parse(readFileSync(process.env.HOG_JELLYFIN_LAN_CONFIG, "utf8")), { enabled: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the Jellyfin card is in Settings → Containers", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const containers = html.indexOf('id="jellyfin-gpu-card"');
  const lan = html.indexOf('id="jellyfin-lan-card"');
  assert.ok(containers > 0 && lan > containers, "Home network access sits under the GPU card");
  assert.match(html, /not the internet/);
  assert.match(html, /Reserve this computer's IP in your router/);
});

test("firewall actions go through the swappable runner and report cancel", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const fw = jellyfinLanInternals.firewall;
  const saved = { ...fw };
  const calls = [];
  try {
    const cookie = gateFrom(await fetch(`${origin}/`));
    const post = (body) => fetch(`${origin}/api/jellyfin-lan`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-hog-lan": "1" }, body: JSON.stringify(body) }).then((r) => r.json());
    const off = await post({ action: "firewall-allow" });
    assert.equal(off.ok, false);
    assert.match(off.error, /ufw firewall is off/);
    fw.enabled = () => true;
    fw.prompt = () => false;
    assert.match((await post({ action: "firewall-allow" })).error, /pkexec is missing/);
    fw.prompt = () => true;
    fw.findLan = () => [{ name: "wlp4s0", address: "192.168.1.223", subnet: "192.168.1.0/24" }];
    fw.run = async (rule, opts) => { calls.push({ rule, opts }); return { ok: false, cancelled: true, error: "The password prompt was cancelled or not authorised. Nothing changed." }; };
    const cancelled = await post({ action: "firewall-allow" });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.ufw.needed, true);
    assert.match(cancelled.ufw.commands[0], /^sudo ufw allow in on wlp4s0 from 192\.168\.1\.0\/24 to any port 8096/);
    fw.run = async (rule, opts) => { calls.push({ rule, opts }); return { ok: true }; };
    const allowed = await post({ action: "firewall-allow" });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ufw.needed, false);
    assert.deepEqual(allowed.ufw.added, [{ iface: "wlp4s0", subnet: "192.168.1.0/24", port: 8096 }]);
    const removed = await post({ action: "firewall-remove" });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.ufw.added, []);
    assert.equal(calls.at(-1).opts.remove, true);
    assert.equal((await fetch(`${origin}/api/jellyfin-lan`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-hog-lan": "1" }, body: JSON.stringify({ action: "sudo" }) })).status, 400);
  } finally {
    Object.assign(fw, saved);
    await new Promise((resolve) => server.close(resolve));
  }
});
