import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createHelper, injectRelay, localNodeFile, loopbackHost, readConfig, findNodeDirs } from "../helper/helper.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const fakeSite = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/") {
    return new Response('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>node</title></head><body>hi</body></html>', { headers: { "content-type": "text/html" } });
  }
  if (path === "/_astro/app.js") return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } });
  return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
};

async function startHelper(extra = {}) {
  const [pagePort, controlPort, stratumPort] = [await freePort(), await freePort(), await freePort()];
  const helper = createHelper({
    pagePort, controlPort, stratumPort,
    configDir: mkdtempSync(join(tmpdir(), "whelper-")),
    fetchImpl: fakeSite,
    log: () => {},
    ...extra,
  });
  await helper.start();
  return { helper, pagePort, controlPort, stratumPort };
}

test("loopback Host only, with the exact port", () => {
  assert.equal(loopbackHost("127.0.0.1:43180", 43180), "127.0.0.1");
  assert.equal(loopbackHost("localhost:43180", 43180), "localhost");
  assert.equal(loopbackHost("evil.example:43180", 43180), "");
  assert.equal(loopbackHost("127.0.0.1:1", 43180), "");
  assert.equal(loopbackHost("", 43180), "");
});

test("the relay script goes first in <head> and page CSP metas are dropped", () => {
  const out = injectRelay('<html><head><meta http-equiv="content-security-policy" content="x"><base href="https://x/"></head></html>', "t".repeat(32));
  assert.match(out, /<head><script>\(function \(\) \{\s+if \(window.__hogMiningRelay\)/);
  assert.doesNotMatch(out, /content-security-policy/i);
  assert.doesNotMatch(out, /<base/i);
});

test("node files map to the patched builds per network", () => {
  const dirs = findNodeDirs();
  assert.ok(dirs.defi.endsWith("node-defi"));
  assert.ok(dirs.mainnet.endsWith("node-mainnet"));
  assert.ok(localNodeFile("/node/defi/wart-node.wasm", dirs).endsWith("node-defi/wart-node.wasm"));
  assert.ok(localNodeFile("/node/wart-node.js", dirs).endsWith("node-mainnet/wart-node.js"));
  assert.equal(localNodeFile("/node/defi/other.js", dirs), "");
  assert.equal(localNodeFile("/node/../../etc/passwd", dirs), "");
});

test("config starts off with no address", () => {
  assert.deepEqual(readConfig(mkdtempSync(join(tmpdir(), "whelper-"))), { enabled: false, address: "", network: "auto", tailnet: false });
});

test("page server: injected node page, patched WASM, isolation headers, loopback only", async () => {
  const { helper, pagePort } = await startHelper();
  try {
    const base = `http://127.0.0.1:${pagePort}`;
    const page = await fetch(`${base}/?network=defi`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
    const html = await page.text();
    assert.match(html, /__hogMiningRelay/);
    assert.match(html, new RegExp(helper.relay.token));
    const wasm = Buffer.from(await (await fetch(`${base}/node/defi/wart-node.wasm`)).arrayBuffer());
    assert.ok(wasm.equals(readFileSync(new URL("../node-defi/wart-node.wasm", import.meta.url))));
    const redirect = await fetch(`http://localhost:${pagePort}/x?y=1`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), `${base}/x?y=1`);
    const post = await fetch(`${base}/`, { method: "POST", body: "x" });
    assert.equal(post.status, 405);
    // Stratum is off until the user turns it on.
    assert.equal(helper.status().stratumListening, false);
  } finally {
    await helper.close();
  }
});

test("page server refuses a foreign Host (DNS rebinding)", async () => {
  const { helper, pagePort } = await startHelper();
  try {
    const status = await new Promise((resolve) => {
      const sock = connect(pagePort, "127.0.0.1", () => sock.write(`GET / HTTP/1.1\r\nHost: evil.example:${pagePort}\r\nConnection: close\r\n\r\n`));
      let data = "";
      sock.on("data", (d) => { data += d; });
      sock.on("end", () => resolve(data.split(" ")[1]));
    });
    assert.equal(status, "403");
  } finally {
    await helper.close();
  }
});

test("relay and peer sockets need the node page origin; relay needs the token", async () => {
  const { helper, pagePort } = await startHelper();
  const base = `ws://127.0.0.1:${pagePort}`;
  const outcome = (url, opts) => new Promise((resolve) => {
    const ws = new WebSocket(url, opts?.protocol, { headers: opts?.headers || {} });
    ws.on("open", () => {
      if (opts?.hello) ws.send(JSON.stringify({ type: "hello", token: opts.hello }));
      else resolve("open");
    });
    ws.on("close", (code) => resolve(`close ${code}`));
    ws.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on("error", () => {});
  });
  try {
    assert.equal(await outcome(`${base}/__hog/mining`, { headers: { origin: "https://evil.example" } }), "http 403");
    assert.equal(await outcome(`${base}/ws-defi`, { protocol: "binary", headers: { origin: "https://evil.example" } }), "http 403");
    assert.equal(await outcome(`${base}/nope`, { headers: { origin: `http://127.0.0.1:${pagePort}` } }), "http 403");
    assert.equal(await outcome(`${base}/__hog/mining`, { headers: { origin: `http://127.0.0.1:${pagePort}` }, hello: "wrong-token-wrong-token" }), "close 4401");
  } finally {
    await helper.close();
  }
});

test("control API: token and origin locked; turning on starts stratum on 127.0.0.1", async () => {
  const { helper, controlPort, stratumPort } = await startHelper();
  const base = `http://127.0.0.1:${controlPort}`;
  const headers = { "x-helper-token": helper.controlToken, "content-type": "application/json" };
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, new RegExp(helper.controlToken));
    assert.equal((await fetch(`${base}/api/status`)).status, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers })).status, 200);
    const bad = await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ address: "00".repeat(24) }) });
    assert.equal(bad.status, 400);
    const on = await (await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ address: ADDRESS, network: "defi", enabled: true }) })).json();
    assert.equal(on.stratumListening, true);
    assert.equal(on.stratumPort, stratumPort);
    assert.equal(on.command, `./bzminer -a warthog -p stratum+tcp://127.0.0.1:${stratumPort} -w ${ADDRESS} -r brave-defi`);
    const reply = await new Promise((resolve) => {
      const sock = connect(stratumPort, "127.0.0.1", () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
      sock.setEncoding("utf8");
      sock.once("data", (d) => { resolve(JSON.parse(d.split("\n")[0])); sock.destroy(); });
    });
    assert.equal(reply.id, 1);
    assert.equal(reply.result[2], 6);
    const off = await (await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ enabled: false }) })).json();
    assert.equal(off.stratumListening, false);
  } finally {
    await helper.close();
  }
});

test("helper tailnet toggle: off by default, listens on the tailnet address when on, remote commands shown", async () => {
  // 127.0.0.3 stands in for this computer's Tailscale address.
  const { helper, controlPort, stratumPort } = await startHelper({
    findTailnet: () => [{ name: "tailscale0", address: "127.0.0.3", family: 4 }],
    magicDns: async () => "hog.tail314642.ts.net",
  });
  const base = `http://127.0.0.1:${controlPort}`;
  const headers = { "x-helper-token": helper.controlToken, "content-type": "application/json" };
  const post = async (body) => (await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify(body) })).json();
  try {
    let s = await post({ address: ADDRESS, network: "defi", enabled: true });
    assert.equal(s.allowTailnet, false);
    assert.deepEqual(s.tailnetListening, []);
    assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ tailnet: "yes" }) })).status, 400);
    s = await post({ tailnet: true });
    assert.deepEqual(s.tailnetListening, ["127.0.0.3"]);
    await fetch(`${base}/api/status`, { headers });
    await new Promise((r) => setTimeout(r, 20));
    s = await (await fetch(`${base}/api/status`, { headers })).json();
    assert.equal(s.remoteCommand, `./bzminer -a warthog -p stratum+tcp://hog.tail314642.ts.net:${stratumPort} -w ${ADDRESS} -r rig2-defi`);
    assert.equal(s.remoteCommandIp, `./bzminer -a warthog -p stratum+tcp://127.0.0.3:${stratumPort} -w ${ADDRESS} -r rig2-defi`);
    assert.match(s.remoteCommandWindows, /^bzminer\.exe /);
    const served = await new Promise((resolve) => {
      const sock = connect(stratumPort, "127.0.0.3", () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
      sock.on("data", () => { resolve(true); sock.destroy(); });
      sock.on("error", () => resolve(false));
    });
    assert.equal(served, true);
    s = await post({ tailnet: false });
    assert.deepEqual(s.tailnetListening, []);
  } finally {
    await helper.close();
  }
});
