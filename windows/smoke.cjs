// HOG_SMOKE=1 self-test, run by CI on windows-latest against the installed or
// unpacked app: chrome loads, Linux-only pages are hidden, hog://bookmarks
// opens, a web tab gets Hog's page scripts, the node tab frame has
// SharedArrayBuffer, solo mining stratum listens on 127.0.0.1:3456 with a
// bzminer.exe command. Writes HOG_SMOKE_OUT/smoke.json and screenshots.
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (what, promise, ms = 15_000) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`timed out: ${what}`); })]);
const step = (name) => console.log(`... ${name}`);

async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out: ${what} (${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

function stratumSubscribe(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
    sock.setEncoding("utf8");
    sock.once("data", (d) => { resolve(JSON.parse(String(d).split("\n")[0])); sock.destroy(); });
    sock.once("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("no stratum reply")); }, 8000);
  });
}

async function run({ app, win, pages, PORT, NODE_PORT, stopServer }) {
  let stratumPort = 3456;
  const PORT_STRATUM = () => stratumPort;
  const out = process.env.HOG_SMOKE_OUT || path.join(app.getPath("temp"), "hog-smoke");
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const ok = (name, detail = "") => { results.push({ name, ok: true, detail }); console.log(`ok - ${name}${detail ? `: ${detail}` : ""}`); };
  const chrome = (js) => within(`chrome: ${js.slice(0, 60)}`, win().webContents.executeJavaScript(js, true));
  const shot = async (name) => {
    try {
      const img = await win().webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    } catch {}
  };
  let code = 0;
  const site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'none'" });
    res.end("<!doctype html><title>smoke page</title><body style=\"background:#fff\"><h1>Hog smoke page</h1><a id=\"l\" href=\"mailto:x@example.com\">mail</a></body>");
  });
  try {
    await until("chrome loaded", () => chrome("document.readyState === 'complete' && !!document.getElementById('tabstrip')"));
    ok(`chrome window loads http://127.0.0.1:${PORT}/`);
    await sleep(1500);
    await chrome("document.getElementById('boot-flash')?.click(), true"); // skip the intro video
    const env = await chrome("({ desktop: window.__hogDesktop === true, platform: window.__hogPlatform, bridge: typeof window.webkit?.messageHandlers?.hogwin?.postMessage, windows: document.documentElement.classList.contains('hog-windows') })");
    if (!env.desktop || env.bridge !== "function") throw new Error(`desktop bridge missing: ${JSON.stringify(env)}`);
    if (process.platform === "win32" && !env.windows) throw new Error("hog-windows class missing");
    ok("desktop bridge (window.webkit.messageHandlers.hogwin)", JSON.stringify(env));
    await shot("01-home");

    const hidden = await chrome("[...document.querySelectorAll('#settings-menu [data-settings]')].filter((b) => b.offsetParent !== null || getComputedStyle(b.closest('li') || b).display !== 'none').map((b) => b.dataset.settings)");
    if (process.platform === "win32" && hidden.some((s) => ["containers", "networks", "tailscale", "files"].includes(s))) throw new Error(`Linux-only settings visible: ${hidden}`);
    ok("settings menu on this OS", hidden.join(","));

    await chrome("window.__hogKey('bookmarks'), true");
    await until("hog://bookmarks", () => chrome("!document.getElementById('bookmarks-view').hidden && document.getElementById('address').value === 'hog://bookmarks'"), 8000)
      .catch(async () => until("hog://bookmarks", () => chrome("!document.getElementById('bookmarks-view').hidden"), 4000));
    ok("hog://bookmarks opens (Ctrl+Shift+O)");
    await shot("02-bookmarks");

    // A web tab: the page preload must inject Hog's scripts despite the page CSP.
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${site.address().port}/`;
    pages.load("smoke-tab", false, url);
    pages.place({ left: 0, top: 80, right: 0, bottom: 0 }, true, "smoke-tab");
    const wc = pages.views.get("smoke-tab").view.webContents;
    step(`web tab ${url}`);
    await until("smoke page", () => wc.getTitle() === "smoke page" && !wc.isLoading());
    step("probe page scripts");
    const injected = await within("page probe", wc.executeJavaScript("({ eth: !!(window.ethereum && window.ethereum.isHog), grips: typeof window.__hogEdgeGrips, menu: typeof window.__hogMenu, node: typeof require })"));
    if (!injected.eth || injected.grips !== "function" || injected.menu !== "function" || injected.node !== "undefined") throw new Error(`page scripts: ${JSON.stringify(injected)}`);
    ok("web tab: window.ethereum (Hog) and edge/menu scripts injected, no Node in page", JSON.stringify(injected));
    await within("mailto click", wc.executeJavaScript("document.getElementById('l').click(), true"));
    await sleep(500);
    if (wc.getURL() !== url) throw new Error(`mailto navigation not dropped: ${wc.getURL()}`);
    ok("non-http navigation dropped quietly");
    const blocked = await within("wallet nav", wc.executeJavaScript(`location.href = 'http://127.0.0.1:${PORT}/'; true`)).then(() => sleep(800)).then(() => wc.getURL());
    if (blocked.startsWith(`http://127.0.0.1:${PORT}`)) throw new Error("page reached Hog's wallet origin");
    ok("page cannot open Hog's wallet origin");
    await shot("03-page");
    pages.drop("smoke-tab");

    // Solo mining through the server, as the Settings page does.
    const on = await chrome(`fetch('/api/mining', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '${ADDRESS}', network: 'defi', enabled: true }) }).then((r) => r.json())`);
    if (!on.stratumListening) throw new Error(`mining on: ${JSON.stringify(on)}`);
    if (process.platform === "win32" && !/^bzminer\.exe -a warthog -p stratum\+tcp:\/\/127\.0\.0\.1:\d+ /.test(on.command)) throw new Error(`command: ${on.command}`);
    ok("solo mining on: stratum listening", on.command);
    stratumPort = on.stratumPort || 3456;
    const reply = await stratumSubscribe(stratumPort);
    if (reply.id !== 1) throw new Error(`stratum: ${JSON.stringify(reply)}`);
    ok(`stratum 127.0.0.1:${stratumPort} answers mining.subscribe`);
    await chrome("window.__hogKey && true");
    await chrome("document.querySelector('[data-settings=\"mining\"]').click(), true");
    await sleep(800);
    await shot("04-mining");
    const off = await chrome("fetch('/api/mining', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then((r) => r.json())");
    if (off.stratumListening) throw new Error("mining did not turn off");
    ok("solo mining off");

    // Node tab: the in-tab WASM node page loads with SharedArrayBuffer.
    await chrome("document.getElementById('node-btn').click(), true");
    const isNodeFrame = (f) => {
      try {
        const u = new URL(f.url);
        return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && Number(u.port) === NODE_PORT;
      } catch {
        return false;
      }
    };
    const frame = await until("node frame", () => win().webContents.mainFrame.framesInSubtree.find(isNodeFrame), 30_000)
      .catch((e) => { console.error(win().webContents.mainFrame.framesInSubtree.map((f) => f.url)); throw e; });
    const probe = await until("node page", async () => {
      const r = await within("node frame probe", frame.executeJavaScript("({ sab: typeof SharedArrayBuffer, ready: document.readyState, url: location.href, start: [...document.querySelectorAll('button')].some((b) => /start node|stop node/i.test(b.textContent)) })"), 5000);
      return r.ready === "complete" && r.start ? r : null;
    }, 60_000);
    if (probe.sab !== "function") throw new Error(`node frame has no SharedArrayBuffer: ${JSON.stringify(probe)}`);
    ok("node tab frame loads with SharedArrayBuffer and a Start node button", JSON.stringify(probe));
    await shot("05-node");

    if (process.env.HOG_SMOKE_NODE !== "0") {
      // End to end without hashing: DeFi testnet node in the tab syncs, and
      // BzMiner's side (a stratum client) gets a real job from it. No shares
      // or blocks are submitted.
      const minutes = Number(process.env.HOG_SMOKE_NODE_MINUTES || 8);
      // A fresh node calls itself synced at genesis before it meets peers;
      // the DeFi testnet tip is past 53,000, so wait for a real height.
      const minHeight = Number(process.env.HOG_SMOKE_MIN_HEIGHT || 50_000);
      await chrome(`fetch('/api/mining', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '${ADDRESS}', network: 'defi', enabled: true }) }).then((r) => r.json())`);
      const click = (re) => within("node click", frame.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.textContent.trim())); if (b) b.click(); return !!b; })()`), 5000);
      if (!(await click("/^DeFi testnet$/i"))) throw new Error("no DeFi testnet button in the node page");
      await sleep(1500);
      // A node that ran before starts again by itself (then there is no Start button).
      const clicked = await click("/^Start node$/i");
      const running = clicked || (await within("node running", frame.executeJavaScript("[...document.querySelectorAll('button')].some((b) => /stop node/i.test(b.textContent))"), 5000));
      if (!running) throw new Error("node page has neither Start node nor Stop node");
      ok(`node page: DeFi testnet, ${clicked ? "Start node clicked" : "node already running"}`);
      // A connected miner makes the stratum bridge poll the node for work.
      const keeper = net.connect(PORT_STRATUM(), "127.0.0.1", () => {
        keeper.write('{"id":1,"method":"mining.subscribe","params":["smoke/1.0"]}\n');
        keeper.write(`{"id":2,"method":"mining.authorize","params":["${ADDRESS}.winsmoke",""]}\n`);
      });
      keeper.on("data", () => {});
      keeper.on("error", () => {});
      const started = Date.now();
      let lastLog = 0;
      let status = {};
      while (Date.now() - started < minutes * 60_000) {
        await sleep(2000);
        status = await chrome("fetch('/api/mining', { credentials: 'same-origin' }).then((r) => r.json())").catch(() => status);
        if (status.synced === true && Number(status.height) >= minHeight) break;
        if (Date.now() - lastLog > 20_000) {
          lastLog = Date.now();
          console.log(`... node: page ${status.pageConnected ? "connected" : "not connected"}, network ${status.pageNetwork || "-"}, synced ${status.synced}, height ${status.height}, ${status.lastError || ""}`);
          await shot("06-node-sync");
        }
      }
      keeper.destroy();
      await shot("06-node-sync");
      if (!(status.synced === true && Number(status.height) >= minHeight)) {
        throw new Error(`node not synced past ${minHeight} within ${minutes} min: ${JSON.stringify({ pageConnected: status.pageConnected, synced: status.synced, height: status.height, lastError: status.lastError })}`);
      }
      ok("DeFi testnet node in the tab synced", `height ${status.height} after ${Math.round((Date.now() - started) / 1000)}s`);
      // BzMiner's side: subscribe + authorize, expect a job from the synced node.
      const job = await new Promise((resolve, reject) => {
        const sock = net.connect(PORT_STRATUM(), "127.0.0.1");
        let buf = "";
        const timer = setTimeout(() => { sock.destroy(); reject(new Error("no mining.notify within 60s")); }, 60_000);
        sock.setEncoding("utf8");
        sock.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.method === "mining.notify") {
              clearTimeout(timer);
              sock.destroy();
              resolve(msg);
            }
          }
        });
        sock.on("error", (e) => { clearTimeout(timer); reject(e); });
        sock.on("connect", () => {
          sock.write('{"id":1,"method":"mining.subscribe","params":["smoke/1.0"]}\n');
          sock.write(`{"id":2,"method":"mining.authorize","params":["${ADDRESS}.winsmoke",""]}\n`);
        });
      });
      status = await chrome("fetch('/api/mining', { credentials: 'same-origin' }).then((r) => r.json())").catch(() => status);
      ok("stratum served BzMiner a job from the tab's node", `height ${status.height}, job ${String(job.params?.[0]).slice(0, 16)}…`);
      await chrome("fetch('/api/mining', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then((r) => r.json())");
    }
  } catch (e) {
    code = 1;
    results.push({ name: "failure", ok: false, detail: String(e?.stack || e) });
    console.error(`not ok - ${e?.stack || e}`);
    await shot("99-failure");
  }
  site.close();
  fs.writeFileSync(path.join(out, "smoke.json"), JSON.stringify({ platform: process.platform, version: app.getVersion(), results, ok: code === 0 }, null, 2));
  console.log(code === 0 ? "SMOKE PASS" : "SMOKE FAIL");
  if (stopServer) stopServer();
  app.exit(code);
}

module.exports = { run };
