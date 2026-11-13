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
<div class="row" style="justify-content:space-between"><h1>Warthog mining helper</h1><button class="danger" id="quit" title="Stop the helper and its ports">Quit helper</button></div>
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
  <div class="row"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="tailnet" style="min-width:0;flex:none"> <b style="color:#bba36a">Allow rigs on my tailnet</b></label><span id="tailnet-pill" class="pill-idle">off</span></div>
  <div class="msg" id="tailnet-note" style="color:#8d887f">Off: only BzMiner on this computer can connect. On: other computers on your Tailscale network can mine here too. The helper listens on its Tailscale address only (never your LAN or the internet) and refuses anyone outside the tailnet.</div>
  <div id="remote" hidden>
    <div class="row" style="margin-top:6px"><span class="label">Other rig (Linux)</span><button class="ghost" id="copy-remote">Copy</button></div>
    <div class="mono" id="remote-cmd" style="margin-top:4px"></div>
    <div class="row" style="margin-top:6px"><span class="label">Windows</span></div>
    <div class="mono" id="remote-cmd-win" style="margin-top:4px"></div>
    <div class="msg" id="remote-ip" style="color:#8d887f"></div>
    <div class="msg" style="color:#8d887f">Give each rig its own <code>-r</code> name so it shows up separately below.</div>
  </div>
</div>

<div class="card">
  <div class="stats">
    <div>Network <b id="s-net">-</b></div><div>Height <b id="s-height">-</b></div>
    <div>Miners <b id="s-miners">0</b></div><div>Jobs <b id="s-jobs">0</b></div>
    <div>Blocks found <b id="s-blocks">0</b></div><div>Rejected <b id="s-rejected">0</b></div>
    <div>Stale (already found) <b id="s-stale">0</b></div><div>Early next jobs <b id="s-early">0</b></div>
  </div>
  <div class="msg" id="last"></div>
  <table id="workers" hidden style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px">
    <thead><tr style="color:#bba36a;text-align:left"><th>Rig (-r)</th><th>From</th><th>Online</th><th>Shares</th><th>Blocks</th><th>Rejected</th></tr></thead><tbody></tbody>
  </table>
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
    $("s-stale").textContent = s.stale || 0;
    $("s-early").textContent = s.optimisticOff ? "off" : (s.optimisticJobs || 0);
    $("s-early").title = s.optimisticOff ? "Early next jobs are off: " + s.optimisticOff : "Next jobs sent as soon as a block was submitted, before the node tab saved it";
    $("last").textContent = s.lastResult || "";
    $("tailnet").checked = !!s.allowTailnet;
    var tl = s.tailnetListening || [];
    pill($("tailnet-pill"), tl.length ? "pill-ok" : (s.allowTailnet && (s.tailnetError || !s.tailnetAvailable) ? "pill-bad" : "pill-idle"),
      tl.length ? "on " + tl[0] + ":" + s.stratumPort : (s.allowTailnet ? (s.tailnetAvailable ? (s.stratumListening ? "error" : "waits for stratum") : "no Tailscale") : "off"));
    if (s.allowTailnet && s.tailnetError) { $("tailnet-note").textContent = s.tailnetError; }
    else if (s.allowTailnet && !s.tailnetAvailable) { $("tailnet-note").textContent = "This computer has no Tailscale address. Start Tailscale, then turn this off and on."; }
    else if (s.allowTailnet) { $("tailnet-note").textContent = "Rigs on your tailnet can connect" + (s.refused ? ". Refused " + s.refused + " connection(s) from outside the tailnet." : "."); }
    $("remote").hidden = !(s.allowTailnet && s.remoteCommand);
    $("remote-cmd").textContent = s.remoteCommand || "";
    $("remote-cmd-win").textContent = s.remoteCommandWindows || "";
    $("remote-ip").textContent = s.remoteCommandIp ? "If that rig does not use MagicDNS, use the IP: " + s.remoteCommandIp : "";
    var rows = s.workers || [];
    $("workers").hidden = !rows.length;
    var tb = $("workers").querySelector("tbody");
    while (tb.firstChild) tb.removeChild(tb.firstChild);
    rows.forEach(function (w) {
      var tr = document.createElement("tr");
      [w.worker || "(no -r name)", w.remote ? w.source : "this computer", w.connected ? "yes" : "no", w.shares, w.blocks, w.rejected].forEach(function (v) {
        var td = document.createElement("td"); td.textContent = String(v); td.style.padding = "2px 6px"; tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
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
  $("quit").onclick = function () {
    if (!confirm("Stop the mining helper? Miners connected to it will disconnect.")) return;
    api("/api/quit", {}).then(function () { document.body.innerHTML = '<div class="frame"><h1>Warthog mining helper</h1><p class="sub">Stopped. Start it again from your app menu.</p></div>'; });
  };
  $("tailnet").onchange = function () {
    api("/api/settings", { tailnet: $("tailnet").checked }).then(render, function (e) { $("msg").className = "msg err"; $("msg").textContent = e.message; });
  };
  $("copy-remote").onclick = function () { navigator.clipboard.writeText($("remote-cmd").textContent).then(function () { $("copy-remote").textContent = "Copied"; setTimeout(function () { $("copy-remote").textContent = "Copy"; }, 1200); }); };
  $("copy").onclick = function () { navigator.clipboard.writeText($("command").textContent).then(function () { $("copy").textContent = "Copied"; setTimeout(function () { $("copy").textContent = "Copy"; }, 1200); }); };
  refresh(); setInterval(refresh, 2000);
})();
</script>
</body></html>`;
}
