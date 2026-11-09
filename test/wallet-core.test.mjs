import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import {
  Account,
  Address,
  Funds,
  Liquidity,
  NonceId,
  Price,
  RoundedFee,
  TokenPrecision,
  TransactionContext,
  Wart,
  encodeLimitPrice,
} from "warthog-js";
import {
  accountFromPrivateKey,
  createAccount,
  signAssetCreation,
  signCancel,
  signLimitSwap,
  signLiquidityDeposit,
  signLiquidityWithdraw,
  signWartTransfer,
  validateAddress,
} from "../src/wallet-core.js";
import {
  assertFetchAllowed,
  assertNodeRequest,
  applyOpfs,
  attachNodeBridge,
  isNodeGlue,
  nodeBridgeTarget,
  nodeSyncedFlag,
  nodeSyncScript,
  opfsRelative,
  parseBrowseUrl,
  preferredSitePort,
  rewriteHtml,
  startServer,
} from "../server.mjs";

const KNOWN = "966a71a98bb5d13e9116c0dffa3f1a7877e45c6f563897b96cfd5c59bf0803e0";

function gateFrom(response) {
  const list = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const match = list.join(";").match(/hog_gate=[^;]+/);
  assert.ok(match, "gate cookie");
  return match[0];
}

async function gateHeaders(base) {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  return { "content-type": "application/json", cookie: gateFrom(home) };
}

test("address matches warthog-js", () => {
  const theirs = Account.fromPrivateKeyHex(KNOWN);
  const ours = accountFromPrivateKey(KNOWN);
  assert.equal(ours.address, theirs.address.hex);
  assert.equal(ours.publicKey, theirs.publicKeyHex);
  assert.equal(validateAddress(ours.address), true);
  assert.equal(validateAddress(`${ours.address.slice(0, 47)}0`), false);
});

test("DeFi transfer signature matches warthog-js", () => {
  const account = Account.fromPrivateKeyHex(KNOWN);
  const ours = accountFromPrivateKey(KNOWN);
  const pinHash = "11e52dc804462490084bd8e414bdb60886aa6696c1995cde86a432049f609722";
  const pinHeight = 27872;
  const nonce = 7;
  const fee = RoundedFee.fromE8(99968n, false);
  const amount = Wart.parse("1.25");
  const to = account.address;
  const legacy = new TransactionContext(
    { pinHash, pinHeight },
    fee,
    NonceId.fromNumber(nonce),
  ).transferWart(account, to, amount);

  const signed = signWartTransfer({
    privateKey: ours.privateKey,
    pinHash,
    pinHeight,
    nonceId: nonce,
    feeE8: fee.E8,
    toAddr: to.hex,
    amountE8: amount.E8,
    network: "defi",
  });

  assert.equal(signed.signature65, legacy.signature65);
  assert.equal(signed.type, "wartTransfer");
  assert.equal(signed.wartE8, Number(amount.E8));
  assert.equal("amountE8" in signed, false);
  assert.equal(Address.validate(signed.toAddr), true);
});

test("mainnet transfer uses amountE8 and omits type", () => {
  const ours = accountFromPrivateKey(KNOWN);
  const signed = signWartTransfer({
    privateKey: ours.privateKey,
    pinHash: "ab".repeat(32),
    pinHeight: 10,
    nonceId: 1,
    feeE8: 1n,
    toAddr: ours.address,
    amountE8: 100000000n,
    network: "mainnet",
  });
  assert.equal(signed.amountE8, 100000000);
  assert.equal("wartE8" in signed, false);
  assert.equal("type" in signed, false);
  assert.equal(signed.signature65.length, 130);
});

test("DeFi market signatures match warthog-js", () => {
  const account = Account.fromPrivateKeyHex(KNOWN);
  const ours = accountFromPrivateKey(KNOWN);
  const pinHash = "22".repeat(32);
  const pinHeight = 100;
  const nonce = 4;
  const fee = RoundedFee.fromE8(100000n, false);
  const asset = "ab".repeat(32);
  const ctx = new TransactionContext({ pinHash, pinHeight }, fee, NonceId.fromNumber(nonce));
  const base = {
    privateKey: ours.privateKey,
    pinHash,
    pinHeight,
    nonceId: nonce,
    feeE8: fee.E8,
    assetHash: asset,
  };
  const limit = Price.fromHex(encodeLimitPrice("1.5", 8, { ceil: true }));
  const buy = signLimitSwap({ ...base, isBuy: true, amount: "2", limitPrice: "1.5", decimals: 8 });
  assert.equal(buy.signature65, ctx.buy(account, asset, Wart.parse("2"), limit).signature65);
  const sellLimit = Price.fromHex(encodeLimitPrice("0.5", 8, { ceil: false }));
  const sell = signLimitSwap({ ...base, isBuy: false, amount: "3", limitPrice: "0.5", decimals: 8 });
  assert.equal(
    sell.signature65,
    ctx.sell(account, asset, Funds.parse("3", new TokenPrecision(8)), sellLimit).signature65,
  );
  const deposit = signLiquidityDeposit({ ...base, assetAmount: "4", wartAmount: "1", decimals: 8 });
  assert.equal(
    deposit.signature65,
    ctx.depositLiquidity(account, asset, Funds.parse("4", new TokenPrecision(8)), Wart.parse("1")).signature65,
  );
  const withdraw = signLiquidityWithdraw({ ...base, shares: "0.5" });
  assert.equal(withdraw.signature65, ctx.withdrawLiquidity(account, asset, Liquidity.parse("0.5")).signature65);
  const created = signAssetCreation({ ...base, name: "HOG", supply: "1000", decimals: 8 });
  assert.equal(
    created.signature65,
    ctx.createAssets(account, Funds.parse("1000", new TokenPrecision(8)), new TokenPrecision(8), "HOG").signature65,
  );
  const cancel = signCancel({ ...base, cancelHeight: 90, cancelNonceId: 2 });
  assert.equal(cancel.signature65, ctx.cancelTransaction(account, 90, 2).signature65);
  assert.equal(cancel.type, "cancelation");
});

test("createAccount returns a checksum address", () => {
  const account = createAccount();
  assert.match(account.privateKey, /^[0-9a-f]{64}$/);
  assert.equal(validateAddress(account.address), true);
  assert.equal(accountFromPrivateKey(account.privateKey).address, account.address);
});

test("browse url and node allowlist", async () => {
  assert.equal(parseBrowseUrl("example.com").href, "https://example.com/");
  assert.throws(() => parseBrowseUrl("file:///etc/passwd"), /http/);
  assert.throws(() => parseBrowseUrl("http://user:pass@example.com"), /password/);
  await assert.rejects(() => assertFetchAllowed("169.254.169.254"), /blocked/i);
  const ok = assertNodeRequest(
    "https://warthog-defitestnet.duckdns.org",
    "chain/head",
    "GET",
  );
  assert.equal(ok.path, "chain/head");
  const search = assertNodeRequest(
    "https://warthog-defitestnet.duckdns.org",
    "asset/complete?namePrefix=HOG",
    "GET",
  );
  assert.equal(search.path, "asset/complete?namePrefix=HOG");
  assert.throws(
    () => assertNodeRequest("https://warthog-defitestnet.duckdns.org", "asset/complete?namePrefix=../x", "GET"),
    /not available/,
  );
  assert.throws(
    () => assertNodeRequest("https://example.com", "chain/head", "GET"),
    /Unknown/,
  );
  assert.throws(
    () =>
      assertNodeRequest(
        "https://warthog-defitestnet.duckdns.org",
        "account/abcd/balance",
        "GET",
      ),
    /not available/,
  );
});

test("node storage keeps bytes and an exclusive lock", async () => {
  assert.equal(preferredSitePort("https://browser-node.netlify.app"), 43100);
  assert.equal(preferredSitePort("https://example.com"), 0);
  assert.equal(isNodeGlue("https://browser-node.netlify.app", "/node/defi/wart-node.js"), true);
  assert.equal(isNodeGlue("https://example.com", "/wart-node.js"), false);
  assert.throws(() => opfsRelative("defi/../../etc/passwd"), /not available/);
  const root = await mkdtemp(join(tmpdir(), "hog-opfs-"));
  try {
    assert.equal((await applyOpfs(root, "mkdir", "defi")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "create", "defi/chain.db3")).body.toString(), "ok");
    const wrote = await applyOpfs(root, "write", "defi/chain.db3", Buffer.from([104, 111, 103, 255]), { at: "0" });
    assert.equal(wrote.body.toString(), "4");
    const read = await applyOpfs(root, "read", "defi/chain.db3", Buffer.alloc(0), { at: "3", len: "1" });
    assert.equal(Buffer.from(read.body.toString(), "base64")[0], 255);
    assert.equal((await applyOpfs(root, "size", "defi/chain.db3")).body.toString(), "4");
    const listed = JSON.parse((await applyOpfs(root, "list", "defi")).body.toString());
    assert.deepEqual(listed, [{ name: "chain.db3", kind: "file" }]);
    const first = await applyOpfs(root, "lock", "defi/chain.db3");
    assert.equal(first.status, 200);
    assert.equal((await applyOpfs(root, "lock", "defi/chain.db3")).status, 409);
    assert.equal((await applyOpfs(root, "unlock", "defi/chain.db3", Buffer.alloc(0), { token: first.body.toString() })).status, 200);
    assert.equal((await applyOpfs(root, "lock", "defi/chain.db3")).status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node storage removes a log directory when recovery asks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hog-opfs-"));
  try {
    assert.equal((await applyOpfs(root, "mkdir", "defi")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "mkdir", "defi/logs")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "create", "defi/logs/timing.log")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "write", "defi/logs/timing.log", Buffer.from("hog"), { at: "0" })).body.toString(), "3");
    const blocked = await applyOpfs(root, "remove", "defi/logs");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.toString(), "not empty");
    assert.equal((await applyOpfs(root, "stat", "defi/logs")).body.toString(), "directory");
    const wiped = await applyOpfs(root, "remove", "defi/logs", Buffer.alloc(0), { recursive: "1" });
    assert.equal(wiped.status, 200);
    assert.equal((await applyOpfs(root, "stat", "defi/logs")).body.toString(), "missing");
    assert.equal((await applyOpfs(root, "stat", "defi")).body.toString(), "directory");
    assert.equal((await applyOpfs(root, "mkdir", "defi/empty")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "remove", "defi/empty")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "create", "defi/chain.db3")).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "remove", "defi/chain.db3", Buffer.alloc(0), { recursive: "1" })).body.toString(), "ok");
    assert.equal((await applyOpfs(root, "stat", "defi/chain.db3")).body.toString(), "missing");
    assert.equal((await applyOpfs(root, "remove", "defi/gone")).status, 404);
    await assert.rejects(() => applyOpfs(root, "remove", "", Buffer.alloc(0), { recursive: "1" }), /not available/);
    const html = rewriteHtml(
      "<!doctype html><html><head></head><body></body></html>",
      "https://browser-node.netlify.app/",
    );
    assert.match(html, /removeEntry\(name, options\)/);
    assert.match(html, /recursive=1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function gruntReply(url, magic, version) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "binary");
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out"));
    }, 8000);
    const fail = (error) => {
      clearTimeout(timer);
      ws.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.on("error", fail);
    ws.on("close", () => fail(new Error("closed")));
    ws.on("open", () => {
      const frame = Buffer.alloc(24);
      frame.write(magic, 0, "ascii");
      frame.writeUInt32BE(version >>> 0, 14);
      ws.send(frame);
    });
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.removeAllListeners("close");
      ws.close();
      resolve(Buffer.from(data));
    });
  });
}

test("node bridge proxies mainnet and defi handshakes", async () => {
  assert.equal(nodeBridgeTarget("/ws-bridge"), "wss://warthognode.duckdns.org/ws");
  assert.equal(nodeBridgeTarget("/ws-defi"), "wss://warthog-defitestnet.duckdns.org/ws");
  assert.equal(nodeBridgeTarget("/ws-bridge-defi"), "wss://warthog-defitestnet.duckdns.org/ws");
  assert.equal(nodeBridgeTarget("/ws"), "");
  const bridge = createServer((_req, res) => res.end("ok"));
  attachNodeBridge(bridge);
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const { port } = bridge.address();
  try {
    const mainnet = await gruntReply(`ws://localhost:${port}/ws-bridge`, "WARTHOG GRUNT?", 0x000906);
    assert.equal(mainnet.subarray(0, 14).toString("ascii"), "WARTHOG GRUNT!");
    const defi = await gruntReply(`ws://localhost:${port}/ws-defi`, "TESTNET GRUNT?", (10 << 8) | 38);
    assert.equal(defi.subarray(0, 14).toString("ascii"), "TESTNET GRUNT!");
    await assert.rejects(gruntReply(`ws://127.0.0.1:${port}/ws-bridge`, "WARTHOG GRUNT?", 0x000906));
  } finally {
    await new Promise((resolve) => bridge.close(resolve));
  }
});

test("node sync is explicit and only injected on the node page", () => {
  assert.equal(nodeSyncedFlag({ synced: true }), true);
  assert.equal(nodeSyncedFlag({ code: 0, data: { synced: false, chainHead: { height: 3 } } }), false);
  assert.equal(nodeSyncedFlag({ data: { chainHead: { synced: "true" } } }), true);
  assert.equal(nodeSyncedFlag({ synced: 0 }), false);
  assert.equal(nodeSyncedFlag("not json"), false);
  assert.equal(nodeSyncedFlag({ height: 10 }), false);
  const script = nodeSyncScript();
  assert.match(script, /virtual_get\("\/chain\/head"\)/);
  assert.match(script, /type: "node-sync"/);
  assert.doesNotMatch(script, /<\/script/i);
  const html = rewriteHtml(
    "<!doctype html><html><head><title>node</title></head><body></body></html>",
    "https://browser-node.netlify.app/",
  );
  assert.match(html, /node-sync/);
  assert.match(html, /hog-opfs-end/);
  const other = rewriteHtml(
    "<!doctype html><html><head><title>other</title></head><body></body></html>",
    "https://example.com/",
  );
  assert.doesNotMatch(other, /node-sync/);
});

test("home uses the regular search site and a wider wallet", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    assert.match(html, /data-url="https:\/\/duckduckgo.com\/"/);
    assert.doesNotMatch(html, /html\.duckduckgo\.com/);
    assert.match(html, /id="isolate-tab"/);
    const css = await (await fetch(`http://127.0.0.1:${port}/app.css`)).text();
    assert.match(css, /--wallet-w: 400px/);
    assert.match(css, /\.node-btn\.is-synced/);
    const app = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    assert.match(app, /https:\/\/duckduckgo\.com\/\?q=/);
    assert.doesNotMatch(app, /html\.duckduckgo\.com\/html\/\?q=/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("node pages install disk storage before the site scripts", () => {
  const html = rewriteHtml(
    "<!doctype html><html><head><title>node</title></head><body></body></html>",
    "https://browser-node.netlify.app/",
  );
  assert.match(html, /hog-opfs-end/);
  assert.match(html, /StorageManager/);
  const other = rewriteHtml(
    "<!doctype html><html><head><title>other</title></head><body></body></html>",
    "https://example.com/",
  );
  assert.doesNotMatch(other, /hog-opfs-end/);
});

test("rewrite keeps same-site urls on the page and strips base", () => {
  const html = rewriteHtml(
    `<!doctype html><html><head><base href="https://example.com/"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><link rel="stylesheet" href="/app.css"><link rel="modulepreload" href="/mod.js"><link rel="preload" href="/font.woff2" as="font"><script type="module" src="/app.js"></script><script>var keep = "/next";</script></head><body style="background:url(/bg.png)"><a href="/next">n</a><img src="//cdn.example/a.png"><form action="/html/" method="post"></form><astro-island component-url="/_astro/app.js" renderer-url="https://example.com/_astro/client.js"></astro-island></body></html>`,
    "https://example.com/dir/page",
  );
  assert.doesNotMatch(html, /<base\b/i);
  assert.doesNotMatch(html, /content-security-policy/i);
  assert.match(html, /parent\.postMessage/);
  assert.match(html, /PAGE_ORIGIN = "https:\/\/example.com"/);
  assert.match(html, /href="\/app.css"/);
  assert.match(html, /href="\/mod.js"/);
  assert.match(html, /href="\/font.woff2"/);
  assert.match(html, /src="\/app.js"/);
  assert.match(html, /href="\/next"/);
  assert.match(html, /src="https:\/\/cdn\.example\/a.png"/);
  assert.match(html, /action="\/html\/"/);
  assert.match(html, /url\(\/bg.png\)/);
  assert.match(html, /var keep = "\/next"/);
  assert.match(html, /component-url="\/_astro\/app.js"/);
  assert.match(html, /renderer-url="\/_astro\/client.js"/);
});

test("fixture page navigates inside Hog", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const headers = await gateHeaders(base);
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="wallet"/);

    const opened = await fetch(`${base}/api/browse`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${base}/fixture/page` }),
    });
    const page = await opened.json();
    assert.equal(page.ok, true);
    assert.equal(page.title, "Hog fixture");
    assert.match(page.html, /id="go"/);
    assert.doesNotMatch(page.html, /content-security-policy/i);

    const head = await fetch(
      `${base}/api/node?base=${encodeURIComponent("https://warthog-defitestnet.duckdns.org")}&path=chain/head`,
      { headers },
    );
    const chain = await head.json();
    assert.equal(chain.code, 0);
    assert.ok(chain.data.chainHead.pinHash);

    const blocked = await fetch(`${base}/api/node`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base: "https://example.com",
        path: "chain/head",
      }),
    });
    assert.equal(blocked.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server rejects a browse of the metadata address", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const headers = await gateHeaders(base);
    const opened = await fetch(`${base}/api/browse`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    });
    const body = await opened.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /blocked/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("posted search is served on a localhost site port", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const headers = await gateHeaders(base);
    const home = await fetch(`${base}/`);
    const homeText = await home.text();
    assert.match(homeText, /id="node-btn"/);
    assert.match(homeText, /id="node-frame"/);
    assert.equal(home.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
    const opened = await fetch(`${base}/api/browse`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: `${base}/fixture/search`,
        method: "POST",
        fields: [{ name: "q", value: "warthog" }],
      }),
    });
    const page = await opened.json();
    assert.equal(page.ok, true);
    assert.match(page.html, /id="q">warthog</);
    assert.match(page.html, /method: "POST"/);
    assert.match(page.frameUrl, /^http:\/\/localhost:\d+\/fixture\/search$/);

    const rich = await fetch(`${base}/api/browse`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${base}/fixture/rich` }),
    });
    const richPage = await rich.json();
    assert.match(richPage.html, /src="\/fixture\/app\.js"/);
    assert.match(richPage.html, /href="\/fixture\/app\.css"/);
    const frame = new URL(richPage.frameUrl);
    assert.equal(frame.hostname, "localhost");
    assert.notEqual(frame.port, String(port));
    const doc = await fetch(richPage.frameUrl, {
      headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
    });
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(doc.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.match(await doc.text(), /id="rich"/);
    const asset = await fetch(`http://localhost:${frame.port}/fixture/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /hogmod/);
    const walletHost = await fetch(`http://127.0.0.1:${frame.port}/fixture/app.js`);
    assert.equal(walletHost.status, 404);
    const opfs = await fetch(`http://localhost:${frame.port}/__hog/opfs?op=stat&path=`, { method: "POST" });
    assert.equal(opfs.status, 404);
    const nogate = await fetch(`${base}/api/browse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture/page` }),
    });
    assert.equal(nogate.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

