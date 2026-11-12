import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const base = realpathSync(mkdtempSync(join(tmpdir(), "hog-mobile-srv-")));
mkdirSync(join(base, "hog-shares"), { recursive: true });
mkdirSync(join(base, "data"), { recursive: true });
process.env.HOG_SHARES_DIR = join(base, "hog-shares");
process.env.HOG_FILES_CONFIG = join(base, "data", "files.json");
process.env.HOG_DATA = join(base, "data");
process.env.HOG_MOBILE_CONFIG = join(base, "data", "mobile.json");
process.env.HOG_MOBILE_PORT = "0";
process.env.HOG_MOBILE_NO_TAILNET = "1";
const { startServer, mobileInternals } = await import("../server.mjs");

function gateFrom(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  const match = list.join(";").match(/hog_gate=[^;]+/);
  assert.ok(match, "gate cookie");
  return match[0];
}

test("Settings → Phone app: gated, off by default, pairs and revokes", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/api/mobile`)).status, 403, "needs Hog's gate cookie");
    const cookie = gateFrom(await fetch(`${origin}/`));
    const off = await (await fetch(`${origin}/api/mobile`, { headers: { cookie } })).json();
    assert.equal(off.enabled, false);
    assert.equal(off.listening, false);
    const post = (body, extra = {}) => fetch(`${origin}/api/mobile`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-hog-mobile": "1", ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${origin}/api/mobile`, { method: "POST", headers: { cookie }, body: JSON.stringify({ enabled: true }) })).status, 403, "changes need x-hog-mobile");
    const on = await (await post({ enabled: true })).json();
    assert.equal(on.enabled, true);
    assert.equal(on.listening, true);
    assert.deepEqual(on.tailnetListening, []);
    const paired = await (await post({ action: "pair" })).json();
    assert.match(paired.pairing.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.match(paired.pairing.qr, /^<svg /);
    assert.match(paired.pairing.uri, /^hogpair:\/\/pair\?/);
    // The phone side, on the mobile listener.
    const mport = mobileInternals.listener.status().port;
    assert.ok(mport > 0 && mport !== port);
    const pair = await fetch(`http://127.0.0.1:${mport}/m/v1/pair`, { method: "POST", body: JSON.stringify({ code: paired.pairing.code, name: "S21" }) });
    assert.equal(pair.status, 200);
    const { token } = await pair.json();
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`http://127.0.0.1:${mport}/m/v1/session`, { headers: auth })).status, 200);
    const mining = await (await fetch(`http://127.0.0.1:${mport}/m/v1/mining`, { headers: auth })).json();
    assert.equal(mining.ok, true);
    assert.ok(!("command" in mining));
    // The main server's other APIs are not on the phone port.
    assert.equal((await fetch(`http://127.0.0.1:${mport}/api/mining`, { headers: auth })).status, 404);
    const listed = await (await fetch(`${origin}/api/mobile`, { headers: { cookie } })).json();
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.pairing, null, "code is single use");
    const text = JSON.stringify(listed) + readFileSync(process.env.HOG_MOBILE_CONFIG, "utf8");
    assert.ok(!text.includes(token), "token never shown or saved");
    assert.ok(!JSON.stringify(listed).includes('"hash"'));
    const revoked = await (await post({ action: "revoke", id: listed.devices[0].id })).json();
    assert.equal(revoked.devices.length, 0);
    assert.equal((await fetch(`http://127.0.0.1:${mport}/m/v1/session`, { headers: auth })).status, 401);
    const offAgain = await (await post({ enabled: false })).json();
    assert.equal(offAgain.listening, false);
    await assert.rejects(fetch(`http://127.0.0.1:${mport}/m/v1/ping`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
