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
