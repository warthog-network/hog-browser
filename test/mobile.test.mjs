import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesService } from "../files.mjs";
import {
  createMobileApi,
  createMobileListener,
  createMobileState,
  formatCode,
  hashToken,
  mobileHostAllowed,
  mobileMiningView,
  mobilePeerAllowed,
  mobileRequestProblem,
  newPairCode,
  normalizeCode,
  pairUri,
  qrSvg,
} from "../mobile.mjs";

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Raw HTTP so tests control Host and Origin exactly. */
function call(port, { method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

test("peer and host filters allow only loopback and the tailnet", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.119.132.89", "100.127.255.254", "fd7a:115c:a1e0::352c:845a"]) {
    assert.equal(mobilePeerAllowed(ip), true, ip);
  }
  for (const ip of ["192.168.1.20", "10.0.0.5", "100.63.255.255", "100.128.0.1", "8.8.8.8", "fd7a:115c:a1e1::1", "fe80::1", "", undefined]) {
    assert.equal(mobilePeerAllowed(ip), false, String(ip));
  }
  for (const host of ["100.119.132.89:4189", "hog.tail314642.ts.net:4189", "hog.tail314642.ts.net", "127.0.0.1:4189", "localhost:4189", "[fd7a:115c:a1e0::1]:4189"]) {
    assert.equal(mobileHostAllowed(host), true, host);
  }
  for (const host of ["evil.example:4189", "192.168.1.20:4189", "ts.net.evil.com", "", "[fe80::1]:4189"]) {
    assert.equal(mobileHostAllowed(host), false, host);
  }
  const ok = { socket: { remoteAddress: "100.100.1.2" }, headers: { host: "hog.tail1.ts.net:4189" } };
  assert.equal(mobileRequestProblem(ok), "");
  assert.equal(mobileRequestProblem({ ...ok, socket: { remoteAddress: "192.168.0.9" } }), "peer");
  assert.equal(mobileRequestProblem({ ...ok, headers: { ...ok.headers, origin: "http://100.100.1.2:8080" } }), "origin");
  assert.equal(mobileRequestProblem({ ...ok, headers: { host: "attacker.example" } }), "host");
});

test("pairing codes are 8 unambiguous characters and the QR has the pairing URI", () => {
  const code = newPairCode();
  assert.match(code, /^[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(normalizeCode(` ${formatCode(code).toLowerCase()} `), code);
  const uri = pairUri({ host: "hog.tail1.ts.net", ip: "100.64.0.9", port: 4189, code: "abcd-efgh" });
  assert.equal(uri, "hogpair://pair?host=hog.tail1.ts.net&ip=100.64.0.9&port=4189&code=ABCDEFGH");
  const svg = qrSvg(uri);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
});

test("state: one code pairs once, stores only a token hash, and revoke cuts the phone off", () => {
  const dir = tempDir("hog-mobile-state-");
  const file = join(dir, "mobile.json");
  const state = createMobileState({ file });
  assert.equal(state.enabled, false);
  assert.throws(() => state.startPairing(), /Turn on/);
  assert.throws(() => state.pair({ code: "x", ip: "100.64.0.2" }), (e) => e.status === 403);
  state.setEnabled(true);
  const { plain } = state.startPairing();
  const { token, device } = state.pair({ code: formatCode(plain), name: "Galaxy S21\n", ip: "100.64.0.2" });
  assert.equal(device.name, "Galaxy S21");
  assert.ok(token.length >= 40);
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes(token), "token is never saved");
  assert.ok(saved.includes(hashToken(token)));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The code is spent.
  assert.throws(() => state.pair({ code: plain, ip: "100.64.0.2" }), /No pairing code/);
  assert.equal(state.authenticate(token, "100.64.0.2").device.id, device.id);
  assert.equal(state.authenticate(`${token}x`, "100.64.0.2").device, null);
  // A fresh state from the same file still knows the phone.
  const again = createMobileState({ file });
  assert.equal(again.authenticate(token, "100.64.0.2").device.id, device.id);
  assert.deepEqual(Object.keys(again.devices()[0]).sort(), ["createdAt", "id", "lastSeenAt", "name"]);
  again.revoke(device.id);
  assert.equal(again.authenticate(token, "100.64.0.2").device, null);
  assert.throws(() => again.revoke(device.id), /not paired/);
});

test("state: wrong codes burn the code and rate-limit the IP and everyone", () => {
  let clock = 1_000_000;
  const state = createMobileState({ file: join(tempDir("hog-mobile-rl-"), "m.json"), now: () => clock });
  state.setEnabled(true);
  const first = state.startPairing();
  for (let i = 0; i < 5; i++) assert.throws(() => state.pair({ code: "ZZZZZZZZ", ip: `100.64.1.${i}` }), (e) => e.status === 403);
  assert.equal(state.pairingInfo(), null, "five misses burn the code");
  assert.throws(() => state.pair({ code: first.plain, ip: "100.64.2.1" }), /No pairing code/);
  // Per IP: five misses lock that IP for 10 minutes, even with a right code.
  const second = state.startPairing();
  const rl = createMobileState({ file: join(tempDir("hog-mobile-rl2-"), "m.json"), now: () => clock });
  rl.setEnabled(true);
  for (let i = 0; i < 4; i++) {
    rl.startPairing();
    assert.throws(() => rl.pair({ code: "ZZZZZZZZ", ip: "100.64.9.9" }), (e) => e.status === 403);
  }
  const fresh = rl.startPairing();
  assert.throws(() => rl.pair({ code: "ZZZZZZZZ", ip: "100.64.9.9" }), (e) => e.status === 403);
  assert.throws(() => rl.pair({ code: fresh.plain, ip: "100.64.9.9" }), (e) => e.status === 429);
  clock += 11 * 60_000;
  const later = rl.startPairing();
  assert.ok(rl.pair({ code: later.plain, ip: "100.64.9.9" }).token);
  // Codes expire after 10 minutes.
  clock += 11 * 60_000;
  assert.throws(() => state.pair({ code: second.plain, ip: "100.64.3.3" }), /No pairing code/);
  // Globally: 20 misses in 10 minutes stop all pairing for a while.
  const g = createMobileState({ file: join(tempDir("hog-mobile-rl3-"), "m.json"), now: () => clock });
  g.setEnabled(true);
  for (let i = 0; i < 20; i++) {
    g.startPairing();
    assert.throws(() => g.pair({ code: "ZZZZZZZZ", ip: `100.70.0.${i}` }), (e) => e.status === 403);
  }
  const blocked = g.startPairing();
  assert.throws(() => g.pair({ code: blocked.plain, ip: "100.70.1.1" }), (e) => e.status === 429);
});

async function withApi(fn) {
  const dir = tempDir("hog-mobile-api-");
  const shares = join(dir, "hog-shares");
  mkdirSync(shares);
  writeFileSync(join(shares, "hello.txt"), "hi phone");
  const files = createFilesService({ dataDir: join(dir, "data"), sharesDir: shares, configFile: join(dir, "data", "files.json") });
  const state = createMobileState({ file: join(dir, "data", "mobile.json") });
  state.setEnabled(true);
  const calls = [];
  const containers = async (action, name) => {
    calls.push([action, name]);
    return { ok: true, error: "", docker: true, items: [{ name: "jellyfin", state: action === "stop" ? "exited" : "running", image: "jellyfin/jellyfin", runtime: "engine", links: [] }], jellyfinUrl: "http://100.64.0.1:8096" };
  };
  const mining = () => ({ enabled: true, miningNetwork: "defi", blocks: 3, rejected: 1, command: "./bzminer -a warthog", remoteCommand: "secret-ish", workers: [{ worker: "rig1", connected: 1, shares: 9, address: "aa", source: "100.64.0.4" }] });
  const api = createMobileApi({ state, files, mining, containers, info: () => ({ name: "hog", version: "test" }) });
  const listener = createMobileListener({ handler: api, findTailnet: () => [] });
  const port = await listener.start(0);
  try {
    await fn({ port, state, calls, shares, listener });
  } finally {
    await listener.stop();
  }
}

async function pairPhone(port, state) {
  const { plain } = state.startPairing();
  const res = await call(port, { method: "POST", path: "/m/v1/pair", body: { code: plain, name: "S21" } });
  assert.equal(res.status, 200, res.text);
  return res.json.token;
}

test("mobile API: every call but ping and pair needs the token", async () => {
  await withApi(async ({ port, state, listener }) => {
    assert.deepEqual(listener.status().hosts, ["127.0.0.1"], "no tailnet address means loopback only");
    const ping = await call(port, { path: "/m/v1/ping" });
    assert.equal(ping.status, 200);
    assert.equal(ping.json.app, "hog");
    for (const path of ["/m/v1/session", "/m/v1/containers", "/m/v1/mining", "/m/v1/files/roots", "/m/v1/files/raw?root=shares&path=hello.txt"]) {
      const bare = await call(port, { path });
      assert.equal(bare.status, 401, path);
      const wrong = await call(port, { path, headers: { authorization: "Bearer not-a-real-token-at-all-000000" } });
      assert.equal(wrong.status, 401, path);
    }
    const token = await pairPhone(port, state);
    const auth = { authorization: `Bearer ${token}` };
    const session = await call(port, { path: "/m/v1/session", headers: auth });
    assert.equal(session.status, 200);
    assert.equal(session.json.device.name, "S21");
    // Browsers (Origin) and foreign Host names are refused even with a token.
    assert.equal((await call(port, { path: "/m/v1/session", headers: { ...auth, origin: "http://100.64.0.7:3000" } })).status, 403);
    assert.equal((await call(port, { path: "/m/v1/session", headers: { ...auth, host: "rebind.example.com" } })).status, 403);
    // Nothing else in hog is reachable.
    for (const path of ["/api/mining", "/api/node", "/api/files/list?root=shares", "/m/v1/wallet", "/index.html", "/m/v1/../api/browse"]) {
      assert.equal((await call(port, { path, headers: auth })).status, 404, path);
    }
    // Revoked: the same token stops working at once.
    const id = session.json.device.id;
    state.revoke(id);
    assert.equal((await call(port, { path: "/m/v1/session", headers: auth })).status, 401);
    // Turned off: even ping and pair say no.
    state.setEnabled(false);
    assert.equal((await call(port, { path: "/m/v1/ping" })).status, 403);
  });
});

test("mobile API: bad tokens from one IP get rate-limited", async () => {
  await withApi(async ({ port }) => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(port, { path: "/m/v1/session", headers: { authorization: `Bearer wrong-token-number-${i}-padding` } })).status;
    assert.equal(last, 429);
  });
});

test("mobile API: containers and mining show only what the phone needs", async () => {
  await withApi(async ({ port, state, calls }) => {
    const token = await pairPhone(port, state);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const list = await call(port, { path: "/m/v1/containers", headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.json.jellyfinUrl, "http://100.64.0.1:8096");
    const stop = await call(port, { method: "POST", path: "/m/v1/containers", headers: auth, body: { action: "stop", name: "jellyfin" } });
    assert.equal(stop.json.items[0].state, "exited");
    assert.equal((await call(port, { method: "POST", path: "/m/v1/containers", headers: auth, body: { action: "remove", name: "jellyfin" } })).status, 400);
    assert.equal((await call(port, { method: "POST", path: "/m/v1/containers", headers: auth, body: { action: "start", name: "../x; rm -rf" } })).status, 400);
    assert.deepEqual(calls, [["list", undefined], ["stop", "jellyfin"]]);
    const mining = await call(port, { path: "/m/v1/mining", headers: auth });
    assert.equal(mining.json.blocks, 3);
    assert.equal(mining.json.workers[0].worker, "rig1");
    assert.ok(!("command" in mining.json) && !("remoteCommand" in mining.json));
    assert.ok(!("source" in mining.json.workers[0]));
    assert.deepEqual(mobileMiningView(null).workers, []);
  });
});

test("mobile API: Files through the phone listener keep hog://files rules", async () => {
  await withApi(async ({ port, state, shares }) => {
    const token = await pairPhone(port, state);
    const auth = { authorization: `Bearer ${token}` };
    const roots = await call(port, { path: "/m/v1/files/roots", headers: auth });
    assert.equal(roots.json.roots[0].id, "shares");
    const list = await call(port, { path: "/m/v1/files/list?root=shares&path=", headers: auth });
    assert.deepEqual(list.json.entries.map((e) => e.name), ["hello.txt"]);
    const raw = await call(port, { path: "/m/v1/files/raw?root=shares&path=hello.txt", headers: { ...auth, range: "bytes=3-" } });
    assert.equal(raw.status, 206);
    assert.equal(raw.text, "phone");
    // Escapes stay blocked.
    assert.notEqual((await call(port, { path: "/m/v1/files/raw?root=shares&path=../data/mobile.json", headers: auth })).status, 200);
    // Changes need x-hog-files: 1, like the desktop Files page.
    const json = { ...auth, "content-type": "application/json" };
    assert.equal((await call(port, { method: "POST", path: "/m/v1/files/mkdir", headers: json, body: { root: "shares", path: "", name: "Photos" } })).status, 403);
    const change = { ...json, "x-hog-files": "1" };
    assert.equal((await call(port, { method: "POST", path: "/m/v1/files/mkdir", headers: change, body: { root: "shares", path: "", name: "Photos" } })).status, 200);
    // Chunked upload, two chunks.
    const id = "a1b2c3d4e5f60718";
    const q = `root=shares&dir=Photos&rel=pic.txt&id=${id}&total=10`;
    const one = await call(port, { method: "PUT", path: `/m/v1/files/upload?${q}&offset=0`, headers: { ...auth, "x-hog-files": "1" }, body: "01234" });
    assert.equal(one.json.done, false);
    const status = await call(port, { path: `/m/v1/files/upload?root=shares&dir=Photos&rel=pic.txt&id=${id}`, headers: auth });
    assert.equal(status.json.size, 5);
    const two = await call(port, { method: "PUT", path: `/m/v1/files/upload?${q}&offset=5`, headers: { ...auth, "x-hog-files": "1" }, body: "56789" });
    assert.equal(two.json.done, true);
    assert.equal(readFileSync(join(shares, "Photos", "pic.txt"), "utf8"), "0123456789");
    assert.equal((await call(port, { method: "POST", path: "/m/v1/files/rename", headers: change, body: { root: "shares", path: "Photos/pic.txt", name: "pic2.txt" } })).status, 200);
    const trashed = await call(port, { method: "POST", path: "/m/v1/files/trash", headers: change, body: { root: "shares", paths: ["Photos/pic2.txt"] } });
    assert.equal(trashed.status, 200);
    // Desktop-only actions are not on the phone API.
    for (const route of ["roots", "move", "copy", "restore", "purge"]) {
      assert.equal((await call(port, { method: "POST", path: `/m/v1/files/${route}`, headers: change, body: { action: "add", path: "/", root: "shares", all: true } })).status, 404, route);
    }
    assert.equal((await call(port, { path: "/m/v1/files/trash?root=shares", headers: auth })).status, 404);
  });
});

test("listener binds the tailnet addresses it finds and follows changes", async () => {
  let found = [{ address: "127.0.0.2", family: 4 }];
  const listener = createMobileListener({ handler: (req, res) => res.end("ok"), findTailnet: () => found });
  const port = await listener.start(0);
  try {
    assert.deepEqual(listener.status().hosts.sort(), ["127.0.0.1", "127.0.0.2"]);
    found = [];
    await listener.sync();
    assert.deepEqual(listener.status().hosts, ["127.0.0.1"]);
    assert.match(listener.status().error, /No Tailscale address/);
    assert.ok(port > 0);
  } finally {
    await listener.stop();
  }
  assert.equal(listener.status().listening, false);
});
