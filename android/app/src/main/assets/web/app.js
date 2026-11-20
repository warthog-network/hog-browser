// Hog phone app UI. Runs in the app's WebView from bundled assets.
// GET requests go to /hog/<route>; the app intercepts them and forwards them
// to hog's phone API with the device token, which this page never sees.
// Changes (POST), pairing, QR scan, uploads, downloads and sharing go through
// the HogNative bridge. Without the bridge (a desktop browser), a demo API
// with sample data runs instead so the UI can be previewed.
"use strict";

const $ = (id) => document.getElementById(id);
const native = window.HogNative || null;
const pending = new Map();
let seq = 0;
let current = "home";
let timers = {};
let files = { roots: [], root: "shares", path: "", entries: [], q: "" };
let uploads = new Map();
let cfgCache = { paired: false, hogs: [] };
let scannedIp = "";
let lastMining = null;
let lastFetch = 0;

// ---------- bridge ----------
window.hogNative = {
  done(id, ok, status, text) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    let body = null;
    try { body = JSON.parse(text); } catch { body = { ok: false, error: text || "No answer from hog." }; }
    entry({ ok: Boolean(ok) && status >= 200 && status < 300, status, body });
  },
  event(raw) {
    const ev = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (ev.type === "upload") onUpload(ev);
    else if (ev.type === "download") toast(ev.error ? ev.error : ev.done ? `Saved to Downloads/Hog: ${ev.name}` : `Downloading ${ev.name}…`, Boolean(ev.error));
    else if (ev.type === "toast") toast(ev.text, Boolean(ev.error));
  },
  scanned(text) { applyScan(text); },
  resume() { config(); refresh(current); },
};

function call(fn, ...args) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    fn(id, ...args);
  });
}

async function apiGet(route) {
  if (!native) return demo.get(route);
  const res = await fetch(`/hog/${route}`, { cache: "no-store" });
  let body;
  try { body = await res.json(); } catch { body = { ok: false, error: `hog answered ${res.status}` }; }
  if (res.status === 401) return unpaired(body.error);
  setConn(res.status < 500 && res.status !== 0);
  if (!res.ok) throw new Error(body.error || `hog answered ${res.status}`);
  return body;
}

async function apiPost(route, payload) {
  const res = native ? await call((id, p, b) => native.post(id, p, b), route, JSON.stringify(payload)) : await demo.post(route, payload);
  if (res.status === 401) return unpaired(res.body.error);
  setConn(res.status > 0);
  if (!res.ok) throw new Error(res.body.error || "That did not work.");
  return res.body;
}

function rawUrl(root, path, extra = "") {
  const q = new URLSearchParams({ root, path });
  if (!native) return demo.raw(path);
  return `/hog/files/raw?${q}${extra}`;
}

function setConn(ok) {
  const dot = $("conn-dot");
  dot.classList.toggle("ok", ok);
  dot.classList.toggle("bad", !ok);
}

function toast(text, error = false) {
  const box = $("toast");
  box.textContent = text;
  box.classList.toggle("err", error);
  box.hidden = false;
  clearTimeout(timers.toast);
  timers.toast = setTimeout(() => { box.hidden = true; }, error ? 5000 : 2600);
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

function size(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function when(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ago(ms) {
  if (!ms) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function fetchedNote() {
  return lastFetch ? `updated ${ago(lastFetch)}` : "updated —";
}

function noteFetch() {
  lastFetch = Date.now();
  paintChip();
}

function shown(value) {
  return value == null || value === "" ? "—" : String(value);
}

/** BzMiner reports hashes per second. A missing reading stays a dash. */
function formatHashrate(hps) {
  if (hps == null || !Number.isFinite(Number(hps))) return "—";
  const n = Number(hps);
  const steps = [[1e12, "TH/s"], [1e9, "GH/s"], [1e6, "MH/s"], [1e3, "kH/s"]];
  for (const [div, unit] of steps) {
    if (n >= div) {
      const v = n / div;
      return `${v >= 1000 ? String(Math.round(v)) : v.toFixed(1)} ${unit}`;
    }
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} H/s`;
}

function rigHashrate(m, w) {
  if (!m || m.hashrate == null || !Number.isFinite(Number(m.hashrate))) return null;
  if (m.bzWorker) return w.worker === m.bzWorker ? Number(m.hashrate) : null;
  if (!w.remote) return Number(m.hashrate);
  return null;
}

function stat(label, value, cls = "") {
  return el("div", { class: `stat ${cls}` }, el("b", { text: shown(value) }), el("span", { text: label }));
}

// ---------- pairing ----------
function config() {
  if (!native) cfgCache = demo.config();
  else {
    try { cfgCache = JSON.parse(native.state()); } catch { cfgCache = { paired: false, hogs: [] }; }
  }
  return cfgCache;
}

function hogLabel(cfg) {
  const c = cfg || cfgCache;
  if (c && (c.label || c.host || c.ip)) return c.label || c.host || c.ip;
  const fresh = config();
  return fresh.label || fresh.host || fresh.ip || "this hog";
}

function unpaired(message) {
  const cfg = config();
  const others = (cfg.hogs || []).filter((hog) => hog.id !== cfg.id);
  if (others.length) {
    toast(message || `${hogLabel(cfg)} removed this phone. Pick another hog.`, true);
    hogSheet();
    return new Promise(() => {});
  }
  showPair(message || "This phone is no longer paired. Pair it again.");
  return new Promise(() => {});
}

function showPair(message = "", adding = false) {
  Object.values(timers).forEach((t) => clearTimeout(t));
  $("app-view").hidden = true;
  $("pair-view").hidden = false;
  const cfg = config();
  const has = (cfg.hogs || []).length > 0;
  if (adding) {
    $("pair-host").value = "";
    $("pair-code").value = "";
    $("pair-port").value = "4189";
    scannedIp = "";
  } else if ((cfg.host || cfg.ip) && !$("pair-host").value) {
    $("pair-host").value = cfg.host || cfg.ip;
  }
  $("pair-back").hidden = !(adding || has);
  $("pair-submit").textContent = has || adding ? "Pair this hog" : "Pair";
  $("pair-error").textContent = message;
  $("app-version").textContent = cfg.version ? `Hog phone app ${cfg.version}` : "";
}

function backToHogs() {
  const cfg = config();
  if (!cfg.paired) return;
  $("pair-code").value = "";
  startApp();
}

function applyScan(text) {
  try {
    const url = new URL(String(text).trim());
    if (url.protocol !== "hogpair:") throw new Error();
    const adding = Boolean(config().paired);
    showPair(adding ? "Adding this hog. Your other computers stay paired." : "", false);
    $("pair-host").value = url.searchParams.get("host") || url.searchParams.get("ip") || "";
    scannedIp = url.searchParams.get("ip") || "";
    $("pair-port").value = url.searchParams.get("port") || "4189";
    $("pair-code").value = url.searchParams.get("code") || "";
    submitPair();
  } catch {
    showPair("That QR code is not a hog pairing code.");
  }
}

async function submitPair() {
  const host = $("pair-host").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const port = Number($("pair-port").value || 4189);
  const code = $("pair-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  $("pair-error").textContent = "";
  if (!host) return ($("pair-error").textContent = "Type hog's address, like hog.tailxxxx.ts.net or 100.x.y.z.");
  if (code.length !== 8) return ($("pair-error").textContent = "The code has 8 letters and numbers.");
  $("pair-submit").disabled = true;
  $("pair-submit").textContent = "Pairing…";
  try {
    const res = native ? await call((id, h, i, p, c) => native.pair(id, h, i, p, c), host, scannedIp, port, code) : await demo.pair(host, scannedIp, port);
    if (!res.ok) throw new Error(res.body.error || `Pairing failed (${res.status || "no answer"}).`);
    $("pair-code").value = "";
    scannedIp = "";
    startApp();
    toast(`Paired with ${hogLabel()}.`);
  } catch (error) {
    $("pair-error").textContent = error.message;
  } finally {
    $("pair-submit").disabled = false;
    $("pair-submit").textContent = "Pair";
  }
}

// ---------- tabs ----------
function go(tab) {
  current = tab;
  document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.dataset.tab !== tab; });
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("is-on", b.dataset.go === tab));
  refresh(tab);
}

function refresh(tab) {
  clearTimeout(timers.poll);
  const job = { home: loadHome, mining: loadMining, services: loadServices, files: loadFiles }[tab];
  if (!job) return;
  job().catch((error) => {
    setConn(false);
    toast(error.message || "Could not reach hog.", true);
  }).finally(() => {
    const every = { home: 8000, services: 10000, mining: 5000 }[tab];
    if (every && current === tab && !$("app-view").hidden) timers.poll = setTimeout(() => refresh(tab), every);
  });
}

// ---------- containers ----------
let lastContainers = null;
async function loadContainers() {
  const data = await apiGet("containers");
  lastContainers = data;
  paintContainers(data);
}

function paintContainers(data) {
  const list = $("containers-list");
  list.replaceChildren();
  $("containers-note").textContent = data.error ? data.error : !data.items.length ? "No containers in hog yet. Add them in hog → Containers." : "";
  for (const item of data.items) {
    if (item.name === "jellyfin") continue;
    const running = item.state === "running";
    const links = (item.links || []).filter((l) => l.kind === "tailnet" || l.kind === "lan");
    const act = (action) => async (event) => {
      event.target.disabled = true;
      try {
        const next = await apiPost("containers", { action, name: item.name });
        paintContainers(next);
        toast(next.ok ? `${item.name}: ${action} done` : next.error || "Docker refused.", !next.ok);
      } catch (error) {
        toast(error.message, true);
        event.target.disabled = false;
      }
    };
    list.append(el("article", { class: "card" },
      el("div", { class: "ct-head" },
        el("span", { class: "ct-name", text: item.name }),
        el("span", { class: `badge ${item.state}`, text: item.state })),
      el("div", { class: "ct-meta", text: `${item.image || "?"} · ${item.runtime === "engine" ? "Docker Engine" : item.runtime === "desktop" ? "Docker Desktop" : item.runtime || ""}` }),
      item.blocked ? el("p", { class: "note", text: item.reason || "Hog does not run this container." }) : el("div", { class: "ct-actions" },
        running ? null : el("button", { class: "primary", type: "button", text: "Start", onclick: act("start") }),
        running ? el("button", { class: "ghost", type: "button", text: "Restart", onclick: act("restart") }) : null,
        running && item.name !== "tailscale" ? el("button", { class: "danger", type: "button", text: "Stop", onclick: (e) => confirmSheet(`Stop ${item.name} on ${hogLabel()}?`, "Stop", () => act("stop")(e)) }) : null),
      links.length ? el("div", { class: "ct-links" }, links.map((l) => el("button", { class: "chip", type: "button", text: `${l.label} :${l.port}`, onclick: () => openUrl(l.url) }))) : null));
  }
}

// ---------- jellyfin ----------
let jellyUrl = "";
async function loadServices() {
  const data = await apiGet("containers");
  lastContainers = data;
  noteFetch();
  paintJellyfin(data);
  paintContainers(data);
}

function paintJellyfin(data) {
  const jf = data.items.find((i) => i.name === "jellyfin");
  const dns = jf && (jf.links || []).find((l) => l.kind === "tailnet" && /\.ts\.net/.test(l.url));
  jellyUrl = (dns && dns.url) || data.jellyfinUrl || "";
  const state = jf ? jf.state : "not set up";
  $("jelly-state").textContent = jf ? (state === "running" ? "Jellyfin is running" : `Jellyfin is ${state}`) : "Jellyfin is not set up in hog";
  $("jelly-url").textContent = jellyUrl || (jf && state !== "running" ? "Start it in Services." : "");
  $("jelly-app").disabled = !jellyUrl;
  $("jelly-browser").disabled = !jellyUrl;
}

// ---------- mining ----------
let nodePending = "";
let nodePendingUntil = 0;

function nodeReport(m) {
  return Boolean(m) && (m.nodeRunning != null || m.nodeSynced != null);
}

function currentNodePending(m) {
  if (nodePending && Date.now() > nodePendingUntil) nodePending = "";
  if (nodePending === "start" && m && m.nodeRunning) nodePending = "";
  if (nodePending === "stop" && m && nodeReport(m) && !m.nodeRunning) nodePending = "";
  return nodePending;
}

function syncLine(m) {
  if (!m) return "Waiting for this hog.";
  const pending = currentNodePending(m);
  if (pending === "start") return "Starting the node.";
  if (pending === "stop") return "Stopping the node.";
  if (!nodeReport(m)) {
    if (!m.enabled) return "Solo mining is off.";
    if (!m.nodeTabConnected) return "Waiting for the node tab.";
    if (m.synced) return `Synced at ${m.nodeHeight || m.height || "—"}`;
    return `Syncing ${m.nodeHeight || 0} / ${m.tipHeight || "?"}`;
  }
  if (!m.nodeTabConnected) return "Open the Node tab in Hog.";
  if (!m.nodeRunning) return "Node is stopped.";
  if (m.nodeSynced) return `Synced at ${m.nodeHead || m.nodeHeight || m.height || "—"}`;
  const height = m.nodeHead || m.nodeHeight || 0;
  return height ? `Syncing at ${height}` : "Node is running.";
}

function nodeActions(m) {
  if (!nodeReport(m) || !m.nodeTabConnected) return null;
  const pending = currentNodePending(m);
  if (pending === "start") {
    return el("div", { class: "ct-actions", id: "node-actions" },
      el("button", { class: "primary", type: "button", text: "Starting…", disabled: true }));
  }
  if (pending === "stop") {
    return el("div", { class: "ct-actions", id: "node-actions" },
      el("button", { class: "danger", type: "button", text: "Stopping…", disabled: true }));
  }
  if (m.nodeRunning) {
    return el("div", { class: "ct-actions", id: "node-actions" },
      el("button", { class: "danger", type: "button", text: "Stop node", onclick: () => confirmSheet(`Stop the node on ${hogLabel()}? The chain data stays on that computer.`, "Stop node", () => nodeAct("stop")) }));
  }
  return el("div", { class: "ct-actions", id: "node-actions" },
    el("button", { class: "primary", type: "button", text: "Start node", onclick: () => nodeAct("start") }));
}

async function nodeAct(which) {
  nodePending = which === "stop" ? "stop" : "start";
  nodePendingUntil = Date.now() + 20000;
  if (lastMining) {
    paintHome();
    paintMining(lastMining);
  }
  try {
    const next = await apiPost("mining", { action: which === "stop" ? "node-stop" : "node-start" });
    lastMining = next;
    noteFetch();
    paintHome();
    paintMining(next);
    const where = hogLabel();
    toast(next.ok ? (which === "stop" ? `Stopping the node on ${where}.` : `Starting the node on ${where}.`) : (next.error || "That did not work."), !next.ok);
    if (next.ok) setTimeout(() => { if (!$("app-view").hidden) refresh(current); }, 2000);
  } catch (error) {
    nodePending = "";
    toast(error.message, true);
    loadMining().catch(() => {});
  }
}

function paintMining(m) {
  paintChip();
  paintNode();
  const earn = $("mining-earn");
  if (earn) earn.textContent = `Shares ${shown(m.shares)} · Jobs ${shown(m.jobs)} · ${formatHashrate(m.hashrate)} · ${fetchedNote()}`;
  paintLaunchers(m);
  const where = hogLabel();
  const rows = Array.isArray(m.workers) ? m.workers.map((worker) => ({ ...worker })) : [];
  if (!rows.some((worker) => !worker.remote) && m.localMiner) {
    rows.unshift({
      worker: "This PC",
      remote: false,
      connected: m.localMiner === "running" ? 1 : 0,
      blocks: null,
      rejected: null,
      stale: null,
      lastShareAt: 0,
    });
  }
  rows.sort((a, b) => {
    const ar = rigHashrate(m, a);
    const br = rigHashrate(m, b);
    if (ar == null && br != null) return 1;
    if (ar != null && br == null) return -1;
    if (ar != null && br != null && br !== ar) return br - ar;
    return Number(Boolean(b.connected)) - Number(Boolean(a.connected)) || String(a.worker || "").localeCompare(String(b.worker || ""));
  });
  const workers = $("mining-workers");
  workers.replaceChildren();
  if (m.lastError) workers.append(el("p", { class: "error", text: m.lastError }));
  if (m.localMinerError && m.localMiner !== "missing") workers.append(el("p", { class: "error", text: m.localMinerError }));
  if (!rows.length) workers.append(el("p", { class: "note", text: `No rigs connected to ${where} yet.` }));
  for (const w of rows) {
    const online = Boolean(w.connected);
    workers.append(el("button", { class: "card", type: "button", onclick: () => minerDetail(w) },
      el("div", { class: "ct-head" },
        el("span", { class: "ct-name", text: w.worker || "(no name)" }),
        el("span", { class: `badge ${online ? "running" : ""}`, text: online ? "online" : "offline" })),
      el("div", { class: "ct-meta", text: `${formatHashrate(rigHashrate(m, w))} · ${shown(w.shares)} shares · ${shown(w.blocks)} blocks · ${shown(w.rejected)} rejected · ${shown(w.stale)} stale${w.lastShareAt ? ` · ${ago(w.lastShareAt)}` : ""}` })));
  }
}

function minerDetail(w) {
  const where = hogLabel();
  const local = !w.remote;
  const running = Boolean(lastMining && lastMining.localMiner === "running");
  const rate = rigHashrate(lastMining, w);
  const devices = rate != null && lastMining && Array.isArray(lastMining.devices) ? lastMining.devices : [];
  const rows = [
    ["Hashrate", formatHashrate(rate)],
    ["Shares", shown(w.shares)],
    ["Blocks", shown(w.blocks)],
    ["Rejected", shown(w.rejected)],
    ["Stale", shown(w.stale)],
    ["Status", w.connected ? "online" : "offline"],
    ["Last share", w.lastShareAt ? ago(w.lastShareAt) : "—"],
  ];
  for (const device of devices) {
    const temp = device.tempC == null ? "—" : `${device.tempC}°C`;
    const power = device.powerW == null ? "—" : `${device.powerW} W`;
    rows.push([device.name || "Device", `${formatHashrate(device.hashrate)} · ${temp} · ${power}`]);
  }
  const actions = [];
  if (local && lastMining && lastMining.localMiner === "missing") {
    actions.push(el("p", { class: "note", text: lastMining.localMinerError || `Hog could not find BzMiner on ${where}.` }));
  } else if (local && running) {
    actions.push(el("button", { class: "danger", type: "button", text: "Stop", onclick: () => confirmSheet(`Stop BzMiner on ${where}?`, "Stop", () => miningAct("stop")) }));
  } else if (local) {
    actions.push(el("button", { class: "primary", type: "button", text: "Start", onclick: () => confirmSheet(`Start BzMiner on ${where}?`, "Start", () => miningAct("start")) }));
  }
  sheet(
    el("p", { class: "sheet-title", text: w.worker || "Miner" }),
    el("p", { class: "sheet-sub", text: local ? (rate != null ? `${where}. Hashrate is from BzMiner on this computer.` : `${where}. Hashrate shows once BzMiner is running here.`) : `${w.worker || "This rig"} is mining through ${where}. Its hashrate stays on that computer.` }),
    el("dl", { class: "kv" }, rows.flatMap(([key, value]) => [el("dt", { text: key }), el("dd", { text: value })])),
    actions.length ? el("div", { class: "sheet-actions" }, actions) : null);
}

function stratumLiteral(host) {
  const text = String(host || "").trim();
  if (!text) return "";
  return text.includes(":") ? `[${text}]` : text;
}

function nodeChoice() {
  const cfg = config();
  const node = (cfg.hogs || []).find((hog) => hog.id === cfg.nodeId) || null;
  const host = cfg.nodeHost || (node ? (node.ip || node.host) : "");
  const port = Number(cfg.nodePort) || 3456;
  const pool = host ? `stratum+tcp://${stratumLiteral(host)}:${port}` : "";
  return { cfg, node, host, port, pool, here: Boolean(node && cfg.id && node.id === cfg.id) };
}

function paintLaunchers(m) {
  const box = $("mining-launchers");
  if (!box) return;
  const items = Array.isArray(m.launchers) ? m.launchers : [];
  box.replaceChildren();
  if (m.launcherNote) box.append(el("p", { class: "note", text: m.launcherNote }));
  if (!items.length) box.append(el("p", { class: "note", text: "No start file saved yet." }));
  for (const item of items) {
    const actions = [];
    if (item.id !== "pinned" && !item.active && !item.problem) {
      actions.push(el("button", { class: "primary", type: "button", text: "Use this", onclick: () => launcherAct("select", item) }));
    }
    if (item.id !== "default" && item.id !== "pinned") {
      actions.push(el("button", { class: "danger", type: "button", text: "Remove", onclick: () => confirmSheet(`Remove ${item.name} on ${hogLabel()}?`, "Remove", () => launcherAct("remove", item)) }));
    }
    box.append(el("div", { class: `card launcher${item.active ? " is-on" : ""}` },
      el("div", { class: "ct-head" },
        el("span", { class: "ct-name", text: item.name || "Start file" }),
        item.active ? el("span", { class: "badge running", text: "In use" }) : null),
      el("p", { class: "note", text: item.path || "" }),
      item.problem ? el("p", { class: "error", text: item.problem }) : null,
      actions.length ? el("div", { class: "ct-actions" }, actions) : null));
  }
}

async function launcherAct(op, item) {
  const payload = { action: "launcher", op };
  if (op === "add") {
    payload.name = $("mining-launcher-name").value;
    payload.script = $("mining-launcher-path").value;
  } else {
    payload.id = item.id;
  }
  try {
    const next = await apiPost("mining", payload);
    if (op === "add" && next.ok) {
      $("mining-launcher-name").value = "";
      $("mining-launcher-path").value = "";
    }
    paintMining(next);
    const where = hogLabel();
    toast(next.ok ? (op === "select" ? `${item.name} is the start file on ${where}.` : op === "remove" ? `Removed ${item.name}.` : "Start file saved.") : (next.error || "That did not work."), !next.ok);
  } catch (error) {
    toast(error.message, true);
    loadMining().catch(() => {});
  }
}

function paintNode() {
  const box = $("mining-node");
  if (!box) return;
  const choice = nodeChoice();
  const change = el("button", { class: "ghost", type: "button", text: "Change", onclick: chooseNode });
  const head = (title) => el("div", { class: "ct-head" }, el("span", { class: "ct-name", text: title }), change);
  if (!choice.node || !choice.pool) {
    box.replaceChildren(
      head("No mining node yet"),
      el("p", { class: "note", text: "Pick the computer that runs the Warthog node. The other computers mine to it. Changing this does not move a miner that is already running." }));
    return;
  }
  if (choice.here) {
    box.replaceChildren(
      head("This hog is the mining node"),
      el("p", { class: "mono", text: choice.pool }),
      el("p", { class: "note", text: `${syncLine(lastMining)} Start on this computer mines to 127.0.0.1. The other computers mine to the address above.` }),
      nodeActions(lastMining));
    return;
  }
  box.replaceChildren(
    head(`Mines to ${choice.node.label || choice.host}`),
    el("p", { class: "mono", text: choice.pool }),
    el("p", { class: "note", text: `Start on ${hogLabel()} writes that address into its start file. Stop the miner there first when it is already running.` }));
}

function chooseNode() {
  const cfg = config();
  const port = Number(lastMining && (lastMining.stratumPort || lastMining.configuredStratumPort)) || 3456;
  const rows = (cfg.hogs || []).map((hog) => {
    const name = hog.label || hog.host || hog.ip || "Hog";
    const on = hog.id === cfg.nodeId;
    return el("button", {
      class: `hog-row${on ? " is-on" : ""}`,
      type: "button",
      onclick: () => confirmSheet(`Use ${name} as the mining node? A miner that is already running stays where it is.`, "Use this hog", () => {
        const host = (hog.id === cfg.id && lastMining && lastMining.tailnetAddress) ? String(lastMining.tailnetAddress) : (hog.ip || hog.host || "");
        if (native) native.setNode(hog.id, port, host);
        else demo.setNode(hog.id, port, host);
        closeSheet();
        if (lastMining) paintMining(lastMining);
        else paintNode();
        toast(`${name} is the mining node.`);
      }),
    },
      el("span", { class: "hog-name", text: name }),
      el("span", { class: "hog-sub", text: on ? "mining node" : (hog.host || hog.ip || "") }));
  });
  sheet(
    el("p", { class: "sheet-title", text: "Mining node" }),
    el("p", { class: "sheet-sub", text: "This is where rigs mine. The hog in the header is only what this phone is showing." }),
    rows.length ? el("div", { class: "hog-list" }, rows) : el("p", { class: "note", text: "Pair a hog first." }));
}

function setAsNode() {
  const where = hogLabel();
  confirmSheet(`Use ${where} as the mining node? The other computers mine to it.`, "Use this hog", () => {
    const cfg = config();
    const port = Number(lastMining && (lastMining.stratumPort || lastMining.configuredStratumPort)) || 3456;
    const live = lastMining && lastMining.tailnetAddress ? String(lastMining.tailnetAddress) : "";
    const host = live || cfg.ip || cfg.host || "";
    if (native) native.setNode(cfg.id, port, host);
    else demo.setNode(cfg.id, port, host);
    if (lastMining) paintMining(lastMining);
    else paintNode();
    toast(`${hogLabel()} is the mining node.`);
  });
}

async function loadMining() {
  lastMining = await apiGet("mining");
  noteFetch();
  paintMining(lastMining);
  if (current === "home") paintHome();
}

async function loadHome() {
  const [mining, containers] = await Promise.all([apiGet("mining"), apiGet("containers")]);
  lastMining = mining;
  lastContainers = containers;
  noteFetch();
  paintHome();
  paintJellyfin(containers);
  paintContainers(containers);
}

function paintHome() {
  const where = hogLabel();
  const mining = lastMining;
  $("home-sync").replaceChildren(
    el("p", { class: "sheet-title", text: where }),
    el("p", { text: syncLine(mining) }),
    nodeActions(mining),
    el("p", { class: "note", text: fetchedNote() }));
  const state = !mining ? "Waiting for this hog." : mining.localMiner === "running" ? `BzMiner is running on ${where}.` : mining.localMiner === "missing" ? (mining.localMinerError || `Hog could not find BzMiner on ${where}.`) : `BzMiner is off on ${where}.`;
  $("home-mining").replaceChildren(
    el("p", { class: "sheet-title", text: "Mining" }),
    el("p", { text: state }),
    mining ? el("div", { class: "stats" },
      stat("Hashrate", formatHashrate(mining.hashrate), "gold"),
      stat("Shares", mining.shares),
      stat("Jobs", mining.jobs),
      stat("Blocks", mining.blocks, "gold"),
      stat("Rejected", mining.rejected),
      stat("Stale", mining.stale),
      stat("Miners", mining.miners, "blue"),
      stat("Luck", "—")) : null);
  $("home-earn").replaceChildren(
    el("p", { class: "sheet-title", text: "Earnings" }),
    el("p", { class: "note", text: "Today — · This week —. Hog does not keep a block log on the phone yet." }));
  const services = $("home-services");
  services.replaceChildren();
  const items = lastContainers && Array.isArray(lastContainers.items) ? lastContainers.items : null;
  if (!items) {
    services.append(el("p", { class: "note", text: "Services —" }));
    return;
  }
  const jellyfin = items.find((item) => item.name === "jellyfin");
  const running = items.filter((item) => item.state === "running").length;
  services.append(el("button", { class: "card", type: "button", onclick: () => go("services") },
    el("p", { class: "sheet-title", text: "Services" }),
    el("p", { class: "note", text: `Jellyfin ${jellyfin ? jellyfin.state : "not set up"} · ${running} running · ${fetchedNote()}` })));
}

async function miningAct(action) {
  const box = $("mining-actions");
  if (box) for (const button of box.querySelectorAll("button")) button.disabled = true;
  const choice = nodeChoice();
  const payload = { action };
  if (action === "start" && choice.pool) {
    payload.pool = choice.here ? `stratum+tcp://127.0.0.1:${choice.port}` : choice.pool;
  }
  try {
    const next = await apiPost("mining", payload);
    paintMining(next);
    const started = action === "start" && next.localMiner === "running";
    const where = hogLabel();
    const aimed = action === "start" && payload.pool && !String(payload.pool).includes("127.0.0.1");
    toast(next.ok ? (started ? (aimed ? `BzMiner on ${where} is mining to ${payload.pool}.` : `BzMiner is running on ${where}.`) : action === "stop" ? `BzMiner is stopping on ${where}.` : "Done.") : (next.error || "That did not work."), !next.ok);
  } catch (error) {
    toast(error.message, true);
    loadMining().catch(() => {});
  }
}

// ---------- files ----------
function fileQuery(extra = {}) {
  return new URLSearchParams({ root: files.root, path: files.path, ...extra }).toString();
}

async function loadFiles() {
  if (!files.roots.length) {
    const r = await apiGet("files/roots");
    files.roots = r.roots.filter((x) => x.ok);
    if (!files.roots.find((x) => x.id === files.root) && files.roots[0]) files.root = files.roots[0].id;
  }
  const data = files.q ? await apiGet(`files/search?${fileQuery({ q: files.q })}`) : await apiGet(`files/list?${fileQuery()}`);
  files.entries = data.entries || data.results || [];
  paintFiles(data);
}

function paintFiles(data) {
  const chips = $("files-roots");
  chips.replaceChildren(...files.roots.map((r) => el("button", {
    class: `chip${r.id === files.root ? " is-on" : ""}`, type: "button", text: r.name,
    onclick: () => { files.root = r.id; files.path = ""; files.q = ""; $("files-search").value = ""; loadFiles().catch((e) => toast(e.message, true)); },
  })));
  const crumbs = $("files-crumbs");
  const rootName = (files.roots.find((r) => r.id === files.root) || {}).name || files.root;
  const parts = files.path ? files.path.split("/") : [];
  crumbs.replaceChildren(el("button", { type: "button", text: rootName, onclick: () => openDir("") }));
  parts.forEach((p, i) => crumbs.append(el("span", { text: "/" }), el("button", { type: "button", text: p, onclick: () => openDir(parts.slice(0, i + 1).join("/")) })));
  const list = $("files-list");
  list.replaceChildren();
  const entries = [...files.entries].sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
  if (!entries.length) list.append(el("li", { class: "empty", text: files.q ? "Nothing matches." : "This folder is empty. Tap Upload to add files." }));
  for (const e of entries) {
    const rel = typeof e.dir === "string" ? (e.dir ? `${e.dir}/${e.name}` : e.name) : files.path ? `${files.path}/${e.name}` : e.name;
    const ext = (e.name.split(".").pop() || "").slice(0, 4);
    const ico = el("span", { class: `f-ico ${e.type === "dir" ? "dir" : e.kind || ""}`, text: e.type === "dir" ? "DIR" : ext });
    if (e.kind === "image" && e.size < 15_000_000) {
      const img = el("img", { alt: "", loading: "lazy", src: rawUrl(files.root, rel) });
      img.onerror = () => img.remove();
      ico.textContent = "";
      ico.append(img);
    }
    list.append(el("li", { onclick: () => (e.type === "dir" ? openDir(rel) : e.kind === "video" && native ? native.play(files.root, rel, e.name) : fileSheet(e, rel)) },
      ico,
      el("div", { class: "f-main" },
        el("span", { class: "f-name", text: e.name }),
        el("span", { class: "f-sub", text: e.type === "dir" ? (files.q ? rel : "Folder") : `${size(e.size)} · ${when(e.mtime)}` })),
      el("button", { class: "f-more", type: "button", "aria-label": "More", text: "⋯", onclick: (ev) => { ev.stopPropagation(); fileSheet(e, rel); } })));
  }
  $("files-note").textContent = data.space ? `${size(data.space.free)} free of ${size(data.space.total)}` : "";
}

function openDir(path) {
  files.path = path;
  files.q = "";
  $("files-search").value = "";
  loadFiles().catch((e) => toast(e.message, true));
}

function parkLaunchers() {
  const park = $("launcher-park");
  if (!park) return;
  for (const id of ["mining-launchers", "mining-launcher-add"]) {
    const node = $(id);
    if (node && node.parentElement !== park) park.append(node);
  }
}

function sheet(...content) {
  const nodes = content.flat().filter((node) => node !== null && node !== undefined && node !== false);
  parkLaunchers();
  $("sheet-content").replaceChildren(...nodes);
  $("sheet").hidden = false;
}
function closeSheet() {
  parkLaunchers();
  $("sheet").hidden = true;
  $("sheet-content").replaceChildren();
}

function confirmSheet(title, label, run) {
  sheet(el("p", { class: "sheet-title", text: title }),
    el("div", { class: "sheet-actions" },
      el("button", { class: "ghost", type: "button", text: "Cancel", onclick: closeSheet }),
      el("button", { class: "danger", type: "button", text: label, onclick: () => { closeSheet(); run(); } })));
}

function promptSheet(title, value, label, run) {
  const input = el("input", { value, autocapitalize: "none", spellcheck: "false" });
  const form = el("form", { onsubmit: (ev) => { ev.preventDefault(); const v = input.value.trim(); if (v) { closeSheet(); run(v); } } },
    el("p", { class: "sheet-title", text: title }), input,
    el("div", { class: "sheet-actions" },
      el("button", { class: "ghost", type: "button", text: "Cancel", onclick: closeSheet }),
      el("button", { class: "primary", type: "submit", text: label })));
  sheet(form);
  setTimeout(() => { input.focus(); const dot = value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 50);
}

async function fileChange(route, body, done) {
  try {
    await apiPost(`files/${route}`, body);
    if (done) toast(done);
    await loadFiles();
  } catch (error) {
    toast(error.message, true);
  }
}

function fileSheet(e, rel) {
  const preview = el("div", { class: "preview" });
  if (e.type !== "dir") {
    const src = rawUrl(files.root, rel);
    if (e.kind === "image") preview.append(el("img", { src, alt: e.name }));
    else if (e.kind === "video" && native) preview.append(el("button", { class: "play-big", type: "button", "aria-label": `Play ${e.name}`, onclick: () => { closeSheet(); native.play(files.root, rel, e.name); } }, el("span", { class: "play-tri" }), el("span", { text: "Play" })));
    else if (e.kind === "video") preview.append(el("button", { class: "play-big", type: "button" }, el("span", { class: "play-tri" }), el("span", { text: "Play" })));
    else if (e.kind === "audio") preview.append(el("audio", { src, controls: true }));
    else if (e.kind === "text" && native) {
      const pre = el("pre", { text: "Loading…" });
      preview.append(pre);
      fetch(src, { headers: { range: "bytes=0-199999" } }).then((r) => r.text()).then((t) => { pre.textContent = t; }).catch(() => { pre.textContent = "Could not load a preview."; });
    } else if (e.kind === "text") preview.append(el("pre", { text: demo.text }));
    else {
      preview.append(el("p", { class: "note", text: "No preview for this kind of file. Download or share it." }));
      if (native && e.kind !== "archive") preview.append(el("button", { class: "ghost", type: "button", text: "Try in video player", onclick: () => { closeSheet(); native.play(files.root, rel, e.name); } }));
    }
  }
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  sheet(
    el("p", { class: "sheet-title", text: e.name }),
    el("p", { class: "sheet-sub", text: e.type === "dir" ? "Folder" : `${size(e.size)} · ${when(e.mtime)}` }),
    e.type === "dir" ? null : preview,
    el("div", { class: "sheet-actions" },
      e.type === "dir" ? el("button", { class: "primary", type: "button", text: "Open", onclick: () => { closeSheet(); openDir(rel); } }) : el("button", { class: "primary", type: "button", text: "Download", onclick: () => { closeSheet(); download(rel, e.name); } }),
      e.type === "dir" ? null : el("button", { class: "ghost", type: "button", text: "Share", onclick: () => { closeSheet(); share(rel, e.name); } }),
      el("button", { class: "ghost", type: "button", text: "Rename", onclick: () => promptSheet("Rename", e.name, "Rename", (name) => fileChange("rename", { root: files.root, path: rel, name }, "Renamed.")) }),
      el("button", { class: "danger", type: "button", text: "Delete", onclick: () => confirmSheet(`Move ${e.name} to hog's Trash?`, "Delete", () => fileChange("trash", { root: files.root, paths: [rel] }, "Moved to Trash. Restore it from hog's Files on the computer.")) }),
      el("button", { class: "ghost", type: "button", text: "Close", onclick: closeSheet })),
    dir !== files.path && files.q ? el("p", { class: "note", text: `In ${dir || "/"}` }) : null);
}

function download(rel, name) {
  if (!native) return toast(`Saved to Downloads/Hog: ${name}`);
  native.download(files.root, rel, name);
}
function share(rel, name) {
  if (!native) return toast("Share opens Android's share sheet.");
  native.share(files.root, rel, name);
}
function openUrl(url) {
  if (native) native.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

function onUpload(ev) {
  uploads.set(ev.key, ev);
  const box = $("files-uploads");
  box.replaceChildren();
  for (const u of uploads.values()) {
    const pct = u.total ? Math.round((u.sent / u.total) * 100) : 0;
    const bar = el("div", { class: "bar" }, el("i"));
    bar.firstChild.style.width = `${pct}%`;
    box.append(el("div", { class: "up" }, el("span", { text: `${u.error ? "Failed" : u.done ? "Uploaded" : `${pct}%`} · ${u.name}${u.error ? ` · ${u.error}` : ""}` }), bar));
  }
  box.hidden = uploads.size === 0;
  if (ev.done || ev.error) {
    if (ev.done && current === "files") loadFiles().catch(() => {});
    setTimeout(() => {
      const u = uploads.get(ev.key);
      if (u && (u.done || u.error)) uploads.delete(ev.key);
      if (!uploads.size) box.hidden = true;
      onUploadPaint();
    }, ev.error ? 8000 : 3000);
  }
}
function onUploadPaint() {
  if (!uploads.size) $("files-uploads").replaceChildren();
}

// ---------- hogs ----------
function switchHog(id) {
  const cfg = config();
  if (!id || id === cfg.id) { closeSheet(); return; }
  if (native) native.select(id);
  else demo.select(id);
  files.path = "";
  files.q = "";
  files.entries = [];
  uploads.clear();
  const search = $("files-search");
  if (search) search.value = "";
  closeSheet();
  startApp();
  toast(`Using ${hogLabel()}.`);
}

function forgetCurrent() {
  const name = hogLabel();
  confirmSheet(`Forget ${name} on this phone?`, "Forget", () => {
    if (native) native.forget();
    else demo.forget();
    const cfg = config();
    if (cfg.paired) {
      files.path = "";
      files.q = "";
      files.entries = [];
      startApp();
    } else {
      showPair("");
    }
    toast(`Forgot ${name}.`);
  });
}

function hogSheet() {
  const cfg = config();
  const rows = (cfg.hogs || []).map((hog) => {
    const name = hog.label || hog.host || hog.ip || "Hog";
    const here = hog.id === cfg.id;
    let sub = "latency — · sync — · miners —";
    if (here && lastMining) {
      const synced = nodeReport(lastMining) ? lastMining.nodeSynced : lastMining.synced;
      const height = synced ? (lastMining.nodeHead || lastMining.nodeHeight || lastMining.height || "—") : (lastMining.nodeRunning && lastMining.nodeHead ? lastMining.nodeHead : "—");
      const miners = Array.isArray(lastMining.workers) ? String(lastMining.workers.length) : "—";
      sub = `latency — · sync ${height} · ${miners} miners`;
    }
    if (hog.id === cfg.nodeId) sub = `mining node · ${sub}`;
    const where = hog.host || hog.ip || "";
    return el("button", {
      class: `hog-row machine${here ? " is-on" : ""}`,
      type: "button",
      onclick: () => switchHog(hog.id),
    },
      el("span", { class: "hog-name", text: name }),
      here ? el("span", { class: "badge running", text: "Showing" }) : null,
      el("span", { class: "hog-sub", text: where ? `${where} · ${sub}` : sub }));
  });
  sheet(
    el("p", { class: "sheet-title", text: "Machines" }),
    el("p", { class: "sheet-sub", text: "Tap a computer to show it on this phone. That does not change where miners mine." }),
    rows.length ? el("div", { class: "hog-list" }, rows) : el("p", { class: "note", text: "No computers paired yet." }),
    el("div", { class: "sheet-actions" },
      el("button", { class: "primary wide", type: "button", text: "Add a machine", onclick: () => { closeSheet(); showPair("", true); } }),
      el("button", { class: "ghost", type: "button", text: "This computer", onclick: hogDetail }),
      el("button", { class: "ghost", type: "button", text: "Settings", onclick: settingsSheet })));
}

function hogDetail() {
  const where = hogLabel();
  sheet(
    el("p", { class: "sheet-title", text: where }),
    el("p", { class: "sheet-sub", text: "Start files on this computer. The line under the name is the path. The file has to be executable and stay in the home folder." }),
    $("mining-launchers"),
    $("mining-launcher-add"),
    el("div", { class: "sheet-actions" },
      el("button", { class: "ghost", type: "button", text: "Machines", onclick: hogSheet })),
    el("button", { class: "danger", type: "button", text: "Forget this hog", onclick: forgetCurrent }));
  if (lastMining) paintLaunchers(lastMining);
}

function settingsSheet() {
  const cfg = config();
  sheet(
    el("p", { class: "sheet-title", text: "This phone" }),
    el("dl", { class: "kv" },
      el("dt", { text: "Hog" }), el("dd", { text: `${cfg.host || cfg.ip || "?"}:${cfg.port || 4189}` }),
      cfg.ip && cfg.host ? el("dt", { text: "IP" }) : null, cfg.ip && cfg.host ? el("dd", { text: `${cfg.ip}${cfg.via === cfg.ip ? " (in use: the phone cannot look up the name)" : ""}` }) : null,
      el("dt", { text: "Phone" }), el("dd", { text: cfg.device || "" }),
      el("dt", { text: "App" }), el("dd", { text: cfg.version || "" }),
      el("dt", { text: "Paired" }), el("dd", { text: String((cfg.hogs || []).length) })),
    el("p", { class: "note", text: "To cut this phone off a computer, remove it there in Settings → Tailscale → Phone app. Forget only clears it on the phone." }),
    el("div", { class: "sheet-actions" },
      el("button", { class: "ghost", type: "button", text: "Machines", onclick: hogSheet })));
}

// ---------- start ----------
function startApp() {
  const cfg = config();
  $("pair-view").hidden = true;
  $("app-view").hidden = false;
  paintChip();
  clearInterval(timers.chip);
  timers.chip = setInterval(() => { if (!$("app-view").hidden) paintChip(); }, 1000);
  go(current);
}

function paintChip() {
  const chip = $("hog-chip");
  const nameEl = $("hog-chip-name");
  const metaEl = $("hog-chip-meta");
  if (!chip || !nameEl || !metaEl) return;
  const cfg = config();
  const name = cfg.paired ? hogLabel(cfg) : "Choose a hog";
  const rigs = lastMining && Array.isArray(lastMining.workers) ? lastMining.workers.length : null;
  const rigText = rigs == null ? "— rigs" : `${rigs} ${rigs === 1 ? "rig" : "rigs"}`;
  const age = fetchedNote();
  const count = (cfg.hogs || []).length;
  nameEl.textContent = name;
  const rate = lastMining ? formatHashrate(lastMining.hashrate) : "—";
  metaEl.textContent = cfg.paired ? `${rigText} · ${rate} · ${age}` : "Tap to pair a computer";
  chip.setAttribute("aria-label", count > 1
    ? `${name}. Switch machine. ${count} computers. ${rigText}. Hashrate ${rate}. ${age}.`
    : `${name}. Machines. ${rigText}. Hashrate ${rate}. ${age}.`);
}

function wire() {
  $("scan-btn").addEventListener("click", () => (native ? native.scan() : applyScan("hogpair://pair?host=hog.tail314642.ts.net&port=4189&code=7KQ3XW9M")));
  $("pair-form").addEventListener("submit", (ev) => { ev.preventDefault(); submitPair(); });
  $("pair-host").addEventListener("input", () => { scannedIp = ""; });
  $("pair-code").addEventListener("input", (ev) => {
    const v = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    ev.target.value = v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
  });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  document.querySelectorAll("[data-refresh]").forEach((b) => b.addEventListener("click", () => refresh(b.dataset.refresh)));
  $("hog-chip").addEventListener("click", hogSheet);
  $("pair-back").addEventListener("click", backToHogs);
  $("sheet").addEventListener("click", (ev) => { if (ev.target.matches("[data-close]")) closeSheet(); });
  $("jelly-app").addEventListener("click", () => { if (native) native.openJellyfin(jellyUrl); else openUrl(jellyUrl); });
  $("jelly-browser").addEventListener("click", () => openUrl(jellyUrl));
  $("files-upload").addEventListener("click", () => (native ? native.upload(files.root, files.path) : onUpload({ key: "demo", name: "IMG_2041.jpg", sent: 6_291_456, total: 9_437_184 })));
  $("files-mkdir").addEventListener("click", () => promptSheet("New folder", "New folder", "Create", (name) => fileChange("mkdir", { root: files.root, path: files.path, name }, "Folder made.")));
  $("files-search-form").addEventListener("submit", (ev) => { ev.preventDefault(); files.q = $("files-search").value.trim(); loadFiles().catch((e) => toast(e.message, true)); });
  $("mining-launcher-add").addEventListener("submit", (ev) => { ev.preventDefault(); launcherAct("add"); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("app-view").hidden) refresh(current); });
}

// ---------- demo (no native bridge: desktop preview only) ----------
const demo = (() => {
  const params = new URLSearchParams(location.search);
  const miners = {};
  const nodes = {
    a: { running: true, synced: true, head: 5320405 },
    b: { running: false, synced: false, head: 0 },
  };
  let hogs = params.get("demo") === "pair" ? [] : [
    { id: "a", host: "hog.tail314642.ts.net", ip: "100.119.132.89", port: 4189, label: "Gaming-PC" },
    { id: "b", host: "hog-1.tail314642.ts.net", ip: "100.72.197.80", port: 4189, label: "hog-1" },
  ];
  let currentId = hogs[0] ? hogs[0].id : "";
  let paired = hogs.length > 0;
  let nodeId = "";
  let nodeHost = "";
  let nodePort = 3456;
  let demoLaunchers = [
    { id: "default", name: "Downloads", path: "~/Downloads/bzminer_v100.02b6_linux/start_warthog.sh", active: false, problem: "" },
    { id: "aaaaaaaaaaaaaaaa", name: "OC lock", path: "~/mining/oc/start_warthog.sh", active: true, problem: "" },
  ];
  miners.a = "running";
  miners.b = "stopped";
  const now = Date.now();
  const entries = {
    "": [
      { name: "Movies", type: "dir", mtime: now - 864e5 * 3 },
      { name: "Music", type: "dir", mtime: now - 864e5 * 9 },
      { name: "Photos", type: "dir", mtime: now - 36e5 * 5 },
      { name: "warthog-notes.md", type: "file", kind: "text", size: 4821, mtime: now - 36e5 * 30 },
      { name: "sunset-rig.jpg", type: "file", kind: "image", size: 2_811_904, mtime: now - 36e5 * 2 },
      { name: "hog-0.1.31.deb", type: "file", kind: "archive", size: 48_211_002, mtime: now - 36e5 * 6 },
      { name: "clip.mp4", type: "file", kind: "video", size: 182_002_211, mtime: now - 864e5 },
    ],
  };
  return {
    text: "# Warthog notes\n\n- solo mining on mainnet via hog\n- Jellyfin over tailnet\n",
    config: () => {
      const cur = hogs.find((hog) => hog.id === currentId) || null;
      return {
        paired: paired && Boolean(cur),
        id: cur ? cur.id : "",
        host: cur ? cur.host : "",
        ip: cur ? cur.ip : "",
        port: cur ? cur.port : 4189,
        via: cur ? (cur.host || cur.ip) : "",
        label: cur ? cur.label : "",
        device: "SM-G991U",
        version: "0.1.0 (demo)",
        nodeId,
        nodeHost,
        nodePort,
        hogs: hogs.map((hog) => ({ ...hog, current: hog.id === currentId })),
      };
    },
    setNode(id, port, host) {
      const row = hogs.find((hog) => hog.id === id);
      if (!row) return;
      nodeId = id;
      nodePort = Number(port) || 3456;
      nodeHost = String(host || row.ip || row.host || "");
    },
    select(id) {
      if (hogs.some((hog) => hog.id === id)) currentId = id;
    },
    forget() {
      if (nodeId === currentId) { nodeId = ""; nodeHost = ""; }
      hogs = hogs.filter((hog) => hog.id !== currentId);
      currentId = hogs[0] ? hogs[0].id : "";
      paired = hogs.length > 0;
    },
    pair: async (host, ip, port) => {
      const h = String(host || "").trim().toLowerCase();
      const i = String(ip || "").trim().toLowerCase();
      const p = Number(port) || 4189;
      let row = hogs.find((hog) => hog.port === p && ((i && hog.ip === i) || (h && hog.host === h)));
      if (!row) {
        if (hogs.length >= 8) return { ok: false, status: 0, body: { ok: false, error: "This phone can pair 8 hogs. Forget one first." } };
        row = { id: Math.random().toString(16).slice(2, 10), host: h, ip: i, port: p, label: h || i };
        hogs.push(row);
        miners[row.id] = "stopped";
      } else {
        if (h) row.host = h;
        if (i) row.ip = i;
        row.label = row.host || row.ip;
      }
      currentId = row.id;
      paired = true;
      return { ok: true, status: 200, body: { ok: true } };
    },
    raw: () => "hog-logo.svg",
    async get(route) {
      await new Promise((r) => setTimeout(r, 30));
      setConn(true);
      if (route === "containers") {
        return { ok: true, docker: true, jellyfinUrl: "http://100.119.132.89:8096", items: [
          { name: "jellyfin", state: "running", image: "jellyfin/jellyfin:latest", runtime: "engine", links: [{ kind: "tailnet", label: "Tailnet", url: "http://hog.tail314642.ts.net:8096", port: 8096 }, { kind: "tailnet", label: "Tailnet IP", url: "http://100.119.132.89:8096", port: 8096 }] },
          { name: "tailscale", state: "running", image: "tailscale/tailscale:latest", runtime: "engine", links: [] },
          { name: "hog-samba", state: "running", image: "dockurr/samba", runtime: "engine", links: [] },
          { name: "ubuntu-lab", state: "exited", image: "ubuntu:24.04", runtime: "desktop", links: [] },
        ] };
      }
      if (route === "mining") {
        const demoMiner = miners[currentId] || "stopped";
        const demoNode = nodes[currentId] || { running: false, synced: false, head: 0 };
        const demoIp = currentId === "b" ? "100.72.197.80" : "100.119.132.89";
        return { ok: true, enabled: true, network: "mainnet", networkLabel: "Mainnet", nodeTabConnected: true, nodeRunning: demoNode.running, nodeSynced: demoNode.synced, nodeHead: demoNode.head, stratumListening: true, synced: demoNode.synced, height: demoNode.head, nodeHeight: demoNode.head, tipHeight: demoNode.head, jobs: 1822, shares: 92, blocks: 61, rejected: 7, stale: 24, pending: 0, miners: 2, hashrate: 431645550, bzWorker: "hog-mainnet", bzPowerW: 192.6, devices: [{ name: "GPU", hashrate: 407285361, tempC: 62, powerW: 82.5 }, { name: "CPU", hashrate: 24360189, tempC: 90.2, powerW: 110.1 }], lastError: "", localMiner: demoMiner, localMinerError: "", tailnetAddress: demoIp, stratumPort: 3456, launcherPinned: false, launcherNote: "", launchers: demoLaunchers.map((item) => ({ ...item })), workers: [
          { worker: "hog-mainnet", remote: false, connected: 1, shares: 80, blocks: 55, rejected: 6, stale: 2, lastShareAt: now - 42e3 },
          { worker: "rig2-mainnet", remote: true, connected: 1, shares: 12, blocks: 6, rejected: 1, stale: 1, lastShareAt: now - 6e5 },
        ] };
      }
      if (route === "files/roots") return { ok: true, roots: [{ id: "shares", name: "hog-shares", ok: true }, { id: "a1b2c3d4", name: "Media drive", ok: true }] };
      if (route.startsWith("files/")) return { ok: true, entries: entries[files.path] || [], space: { free: 812e9, total: 1.8e12 } };
      return { ok: true };
    },
    async post(route, body) {
      if (route === "containers") {
        const data = await this.get("containers");
        return { ok: true, status: 200, body: { ...data, ok: true } };
      }
      if (route === "mining") {
        if (body.action === "start") miners[currentId] = "running";
        if (body.action === "stop") miners[currentId] = "stopped";
        if (body.action === "node-start") nodes[currentId] = { running: true, synced: true, head: 5320405 };
        if (body.action === "node-stop") nodes[currentId] = { running: false, synced: false, head: 0 };
        if (body.action === "launcher" && body.op === "select") {
          demoLaunchers = demoLaunchers.map((item) => ({ ...item, active: item.id === body.id }));
        }
        if (body.action === "launcher" && body.op === "remove") {
          demoLaunchers = demoLaunchers.filter((item) => item.id === "default" || item.id !== body.id);
          if (!demoLaunchers.some((item) => item.active) && demoLaunchers[0]) demoLaunchers[0] = { ...demoLaunchers[0], active: true };
        }
        if (body.action === "launcher" && body.op === "add") {
          const name = String(body.name || "").trim();
          const path = String(body.script || "").trim();
          if (!name || !path) return { ok: false, status: 200, body: { ...(await this.get("mining")), ok: false, error: "Enter a name and a path." } };
          if (demoLaunchers.filter((item) => item.id !== "default").length >= 6) {
            return { ok: false, status: 200, body: { ...(await this.get("mining")), ok: false, error: "Hog keeps 6 start files. Remove one to add another." } };
          }
          demoLaunchers = demoLaunchers.map((item) => ({ ...item, active: false }));
          demoLaunchers.push({ id: Math.random().toString(16).slice(2, 18).padEnd(16, "a"), name, path, active: true, problem: "" });
        }
        return { ok: true, status: 200, body: await this.get("mining") };
      }
      return { ok: true, status: 200, body: { ok: true } };
    },
  };
})();

// Android back button: close a sheet, go up a folder, then back to Home.
window.hogBack = () => {
  if (!$("sheet").hidden) { closeSheet(); return true; }
  if ($("app-view").hidden) return false;
  if (current === "files" && files.path) { openDir(files.path.includes("/") ? files.path.slice(0, files.path.lastIndexOf("/")) : ""); return true; }
  if (current !== "home") { go("home"); return true; }
  return false;
};

wire();
if (config().paired) startApp();
else showPair();
const startTab = new URLSearchParams(location.search).get("tab");
if (startTab && !native) go(startTab);
