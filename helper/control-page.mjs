// Control page for the Warthog mining helper. Same look as the Warthog IPv4
// forwarder window: black, gold (#bba36a) accents, dark cards, small pills.
// The per-launch token is embedded here; the API refuses calls without it.

/** @param {string} token */
export function controlPage(token) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warthog mining helper</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #000; color: #f4f4f5; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif; }
.frame { max-width: 640px; margin: 18px auto; border: 1px solid #8f7848; border-radius: 12px; padding: 16px 18px; }
h1 { font-size: 17px; margin: 0 0 2px; color: #bba36a; letter-spacing: .02em; }
.sub { color: #8d887f; margin: 0 0 14px; font-size: 12.5px; }
.card, .route { background: #141414; border-radius: 12px; padding: 10px 12px; margin: 10px 0; }
.card { border: 1px solid rgba(255,255,255,.08); }
.route { border: 1px solid rgba(187,163,106,.45); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.label { color: #8d887f; font-size: 12px; min-width: 110px; }
.pill-ok, .pill-bad, .pill-idle { border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.pill-ok { background: #bba36a; color: #1a160e; }
.pill-bad { background: #a56a6a; color: #1a1212; }
.pill-idle { background: #2a2a2a; color: #8d887f; }
input, select { background: #0b0b0b; color: #e6e1d6; border: 1px solid rgba(187,163,106,.45); border-radius: 6px; padding: 5px 8px; font: 12.5px ui-monospace, Menlo, Consolas, monospace; }
input { flex: 1; min-width: 260px; }
button { cursor: pointer; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
.primary { background: #bba36a; color: #1a160e; border: none; font-weight: 600; }
.primary:hover { background: #c9b27a; }
.ghost { background: transparent; color: #bba36a; border: 1px solid rgba(187,163,106,.45); }
.ghost:hover { background: rgba(187,163,106,.12); }
.danger { background: transparent; color: #a56a6a; border: 1px solid rgba(165,106,106,.55); }
a { color: #bba36a; }
a.ghost { padding: 3px 9px; border-radius: 6px; text-decoration: none; font-size: 12px; }
code, .mono { font: 12px ui-monospace, Menlo, Consolas, monospace; color: #e6e1d6; word-break: break-all; }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px 12px; margin-top: 6px; }
.stats div { font-size: 12.5px; } .stats b { color: #e6e1d6; font-weight: 600; }
.msg { color: #d9b56a; font-size: 12.5px; margin-top: 6px; min-height: 1em; }
.err { color: #d08a8a; }
ol { margin: 6px 0 0 18px; padding: 0; color: #c8c3b8; font-size: 12.5px; }
</style></head>
<body><div class="frame">
<h1>Warthog mining helper</h1>
<p class="sub">Solo mine with BzMiner to a Warthog browser node running in Brave. Everything stays on 127.0.0.1.</p>

<div class="route">
  <div class="row"><span class="label">1. Node tab</span>
    <a id="open-defi" class="ghost" target="_blank" rel="noopener">Open DeFi testnet node</a>
    <a id="open-mainnet" class="ghost" target="_blank" rel="noopener">Open mainnet node</a></div>
  <div class="row" style="margin-top:6px"><span class="label">Status</span><span id="page-pill" class="pill-idle">not open</span><span id="sync-pill" class="pill-idle">-</span></div>
  <ol><li>Open one node link in Brave and press <b>Start</b> there. Keep that tab open.</li>
  <li>The first start syncs the chain into that tab; wait until it is synced.</li></ol>
</div>

<div class="card">
  <div class="row"><span class="label">2. Payout address</span><input id="address" placeholder="48 hex characters" spellcheck="false" autocomplete="off"></div>
  <div class="row" style="margin-top:6px"><span class="label">Network</span>
    <select id="network"><option value="auto">Follow the node tab</option><option value="mainnet">Mainnet</option><option value="defi">DeFi testnet</option></select>
    <button class="ghost" id="save">Save</button></div>
  <div class="row" style="margin-top:8px"><span class="label">3. Stratum</span><span id="stratum-pill" class="pill-idle">off</span>
    <button class="primary" id="toggle">Turn on</button></div>
  <div class="msg" id="msg"></div>
</div>

<div class="card">
  <div class="row"><span class="label">4. BzMiner command</span><button class="ghost" id="copy">Copy</button></div>
  <div class="mono" id="command" style="margin-top:6px"></div>
  <ol><li>Run it from your BzMiner v24.0.1 folder. Do not use <code>--nvidia</code> alone: Warthog needs the CPU half too.</li>
  <li>Hashrate: BzMiner's own dashboard at <a href="http://127.0.0.1:4014" target="_blank" rel="noopener">127.0.0.1:4014</a>.</li></ol>
</div>

<div class="card">
  <div class="stats">
    <div>Network <b id="s-net">-</b></div><div>Height <b id="s-height">-</b></div>
    <div>Miners <b id="s-miners">0</b></div><div>Jobs <b id="s-jobs">0</b></div>
    <div>Blocks found <b id="s-blocks">0</b></div><div>Rejected <b id="s-rejected">0</b></div>
  </div>
  <div class="msg" id="last"></div>
</div>
</div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(String(token))};
  var $ = function (id) { return document.getElementById(id); };
  var current = null;
  var dirty = false;
  function api(path, body) {
    var init = { headers: { "x-helper-token": TOKEN }, cache: "no-store" };
    if (body) { init.method = "POST"; init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function pill(el, cls, text) { el.className = cls; el.textContent = text; }
  function render(s) {
    current = s;
    $("open-defi").href = s.pageUrls.defi; $("open-mainnet").href = s.pageUrls.mainnet;
    if (!dirty) { $("address").value = s.address || ""; $("network").value = s.networkSetting; }
    pill($("page-pill"), s.pageConnected ? "pill-ok" : "pill-idle", s.pageConnected ? (s.pageNetwork ? "node running: " + (s.pageNetwork === "defi" ? "DeFi testnet" : "mainnet") : "tab open, node not started") : "not open");
    pill($("sync-pill"), s.synced ? "pill-ok" : "pill-idle", s.synced ? "synced" : (s.stratumListening && s.miners ? "not synced" : "-"));
    pill($("stratum-pill"), s.stratumListening ? "pill-ok" : (s.error ? "pill-bad" : "pill-idle"), s.stratumListening ? "on 127.0.0.1:" + s.stratumPort : "off");
    $("toggle").textContent = s.enabled ? "Turn off" : "Turn on";
    $("toggle").className = s.enabled ? "danger" : "primary";
    $("command").textContent = s.command;
    $("s-net").textContent = s.miningNetworkLabel || "-";
    $("s-height").textContent = s.height || "-";
    $("s-miners").textContent = s.miners; $("s-jobs").textContent = s.jobs;
    $("s-blocks").textContent = s.blocks; $("s-rejected").textContent = s.rejected;
    $("last").textContent = s.lastResult || "";
    var m = $("msg"); m.className = "msg" + (s.error || s.lastError ? " err" : "");
    m.textContent = s.error || (s.stratumListening && s.miners ? s.lastError : "") || "";
  }
  function refresh() { api("/api/status").then(render, function (e) { $("msg").className = "msg err"; $("msg").textContent = "Helper not answering: " + e.message; }); }
  $("address").addEventListener("input", function () { dirty = true; });
  $("network").addEventListener("change", function () { dirty = true; });
  $("save").onclick = function () {
    api("/api/settings", { address: $("address").value.trim(), network: $("network").value }).then(function (s) { dirty = false; render(s); $("msg").className = "msg"; $("msg").textContent = "Saved."; }, function (e) { $("msg").className = "msg err"; $("msg").textContent = e.message; });
  };
  $("toggle").onclick = function () {
    api("/api/settings", { enabled: !(current && current.enabled) }).then(render, function (e) { $("msg").className = "msg err"; $("msg").textContent = e.message; });
  };
  $("copy").onclick = function () { navigator.clipboard.writeText($("command").textContent).then(function () { $("copy").textContent = "Copied"; setTimeout(function () { $("copy").textContent = "Copy"; }, 1200); }); };
  refresh(); setInterval(refresh, 2000);
})();
</script>
</body></html>`;
}
