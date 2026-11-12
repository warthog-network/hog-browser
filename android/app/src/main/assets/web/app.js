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
let current = "containers";
let timers = {};
let files = { roots: [], root: "shares", path: "", entries: [], q: "" };
let uploads = new Map();

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
  resume() { refresh(current); },
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

// ---------- pairing ----------
function config() {
  if (!native) return demo.config();
  try { return JSON.parse(native.state()); } catch { return { paired: false }; }
}

function unpaired(message) {
  showPair(message || "This phone is no longer paired. Pair it again.");
  return new Promise(() => {});
}

function showPair(message = "") {
  Object.values(timers).forEach((t) => clearTimeout(t));
  $("app-view").hidden = true;
  $("pair-view").hidden = false;
  const cfg = config();
  if (cfg.host && !$("pair-host").value) $("pair-host").value = cfg.host;
  $("pair-error").textContent = message;
}

let scannedIp = "";
function applyScan(text) {
  try {
    const url = new URL(String(text).trim());
    if (url.protocol !== "hogpair:") throw new Error();
    $("pair-host").value = url.searchParams.get("host") || url.searchParams.get("ip") || "";
    scannedIp = url.searchParams.get("ip") || "";
    $("pair-port").value = url.searchParams.get("port") || "4189";
    $("pair-code").value = url.searchParams.get("code") || "";
    submitPair();
  } catch {
    $("pair-error").textContent = "That QR code is not a hog pairing code.";
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
    const res = native ? await call((id, h, i, p, c) => native.pair(id, h, i, p, c), host, scannedIp, port, code) : await demo.pair();
    if (!res.ok) throw new Error(res.body.error || `Pairing failed (${res.status || "no answer"}).`);
    $("pair-code").value = "";
    startApp();
    toast("Paired with hog.");
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
  const job = { containers: loadContainers, jellyfin: loadJellyfin, mining: loadMining, files: loadFiles }[tab];
  if (!job) return;
  job().catch((error) => {
    setConn(false);
    toast(error.message || "Could not reach hog.", true);
  }).finally(() => {
    const every = { containers: 10000, jellyfin: 15000, mining: 5000 }[tab];
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
        running && item.name !== "tailscale" ? el("button", { class: "danger", type: "button", text: "Stop", onclick: (e) => confirmSheet(`Stop ${item.name}?`, "Stop", () => act("stop")(e)) }) : null),
      links.length ? el("div", { class: "ct-links" }, links.map((l) => el("button", { class: "chip", type: "button", text: `${l.label} :${l.port}`, onclick: () => openUrl(l.url) }))) : null));
  }
}

// ---------- jellyfin ----------
let jellyUrl = "";
async function loadJellyfin() {
  const data = await apiGet("containers");
  const jf = data.items.find((i) => i.name === "jellyfin");
  const dns = jf && (jf.links || []).find((l) => l.kind === "tailnet" && /\.ts\.net/.test(l.url));
  jellyUrl = (dns && dns.url) || data.jellyfinUrl || "";
  const state = jf ? jf.state : "not set up";
  $("jelly-state").textContent = jf ? (state === "running" ? "Jellyfin is running" : `Jellyfin is ${state}`) : "Jellyfin is not set up in hog";
  $("jelly-url").textContent = jellyUrl || (jf && state !== "running" ? "Start it in Containers." : "");
  $("jelly-app").disabled = !jellyUrl;
  $("jelly-browser").disabled = !jellyUrl;
}

// ---------- mining ----------
async function loadMining() {
  const m = await apiGet("mining");
  const on = m.enabled && m.stratumListening;
  const sync = !m.enabled ? "Turn on Solo mining in hog." : !m.nodeTabConnected ? "Waiting for hog's node tab." : m.synced ? `Synced at ${m.nodeHeight || m.height}` : `Syncing ${m.nodeHeight || 0} / ${m.tipHeight || "?"}`;
  $("mining-status").replaceChildren(
    el("span", { class: `status-dot${on ? " on" : ""}` }),
    el("div", { class: "status-text" },
      el("b", { text: on ? `Mining · ${m.networkLabel || m.network || "?"}` : m.enabled ? "Starting…" : "Mining is off" }),
      el("span", { text: sync }),
      m.lastError ? el("span", { class: "error", text: m.lastError }) : null));
  const stat = (label, value, cls = "") => el("div", { class: `stat ${cls}` }, el("b", { text: String(value) }), el("span", { text: label }));
  $("mining-stats").replaceChildren(
    stat("Blocks", m.blocks, "gold"), stat("Shares", m.shares), stat("Miners", m.miners, "blue"),
    stat("Rejected", m.rejected), stat("Stale", m.stale), stat("Pending", m.pending),
    stat("Height", m.height || m.nodeHeight || 0), stat("Tip", m.tipHeight || 0), stat("Jobs", m.jobs));
  const workers = $("mining-workers");
  workers.replaceChildren();
  if (!m.workers.length) workers.append(el("p", { class: "note", text: "No rigs connected yet." }));
  for (const w of m.workers) {
    workers.append(el("div", { class: "card" },
      el("div", { class: "ct-head" }, el("span", { class: "ct-name", text: w.worker || "(no name)" }), el("span", { class: `badge ${w.connected ? "running" : ""}`, text: w.connected ? (w.remote ? "tailnet" : "this PC") : "offline" })),
      el("div", { class: "ct-meta", text: `${w.blocks} blocks · ${w.shares} shares · ${w.rejected} rejected${w.lastShareAt ? ` · last ${when(w.lastShareAt)}` : ""}` })));
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
    list.append(el("li", { onclick: () => (e.type === "dir" ? openDir(rel) : fileSheet(e, rel)) },
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

function sheet(...content) {
  $("sheet-content").replaceChildren(...content);
  $("sheet").hidden = false;
}
function closeSheet() {
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
    else if (e.kind === "video") preview.append(el("video", { src, controls: true, playsinline: true, preload: "metadata" }));
    else if (e.kind === "audio") preview.append(el("audio", { src, controls: true }));
    else if (e.kind === "text" && native) {
      const pre = el("pre", { text: "Loading…" });
      preview.append(pre);
      fetch(src, { headers: { range: "bytes=0-199999" } }).then((r) => r.text()).then((t) => { pre.textContent = t; }).catch(() => { pre.textContent = "Could not load a preview."; });
    } else if (e.kind === "text") preview.append(el("pre", { text: demo.text }));
    else preview.append(el("p", { class: "note", text: "No preview for this kind of file. Download or share it." }));
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

// ---------- menu ----------
function menu() {
  const cfg = config();
  sheet(
    el("p", { class: "sheet-title", text: "This phone" }),
    el("dl", { class: "kv" },
      el("dt", { text: "Hog" }), el("dd", { text: `${cfg.host || cfg.ip || "?"}:${cfg.port || 4189}` }),
      cfg.ip && cfg.host ? el("dt", { text: "IP" }) : null, cfg.ip && cfg.host ? el("dd", { text: `${cfg.ip}${cfg.via === cfg.ip ? " (in use: the phone cannot look up the name)" : ""}` }) : null,
      el("dt", { text: "Phone" }), el("dd", { text: cfg.device || "" }),
      el("dt", { text: "App" }), el("dd", { text: cfg.version || "" })),
    el("p", { class: "note", text: "To cut this phone off, remove it in hog → Settings → Tailscale → Phone app. Forget only clears it here." }),
    el("div", { class: "sheet-actions" },
      el("button", { class: "danger", type: "button", text: "Forget hog", onclick: () => confirmSheet("Forget this hog on the phone?", "Forget", () => { if (native) native.forget(); showPair(""); }) }),
      el("button", { class: "ghost", type: "button", text: "Close", onclick: closeSheet })));
}

// ---------- start ----------
function startApp() {
  const cfg = config();
  $("pair-view").hidden = true;
  $("app-view").hidden = false;
  const via = cfg.via || cfg.host || cfg.ip;
  $("top-host").textContent = via ? `${via}:${cfg.port}` : "";
  go(current);
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
  $("menu-btn").addEventListener("click", menu);
  $("sheet").addEventListener("click", (ev) => { if (ev.target.matches("[data-close]")) closeSheet(); });
  $("jelly-app").addEventListener("click", () => { if (native) native.openJellyfin(jellyUrl); else openUrl(jellyUrl); });
  $("jelly-browser").addEventListener("click", () => openUrl(jellyUrl));
  $("files-upload").addEventListener("click", () => (native ? native.upload(files.root, files.path) : onUpload({ key: "demo", name: "IMG_2041.jpg", sent: 6_291_456, total: 9_437_184 })));
  $("files-mkdir").addEventListener("click", () => promptSheet("New folder", "New folder", "Create", (name) => fileChange("mkdir", { root: files.root, path: files.path, name }, "Folder made.")));
  $("files-search-form").addEventListener("submit", (ev) => { ev.preventDefault(); files.q = $("files-search").value.trim(); loadFiles().catch((e) => toast(e.message, true)); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("app-view").hidden) refresh(current); });
}

// ---------- demo (no native bridge: desktop preview only) ----------
const demo = (() => {
  const params = new URLSearchParams(location.search);
  let paired = params.get("demo") !== "pair";
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
    config: () => ({ paired, host: "hog.tail314642.ts.net", port: 4189, device: "SM-G991U", version: "0.1.0 (demo)" }),
    pair: async () => { paired = true; return { ok: true, status: 200, body: { ok: true } }; },
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
        return { ok: true, enabled: true, network: "mainnet", networkLabel: "Mainnet", nodeTabConnected: true, stratumListening: true, synced: true, height: 4211873, nodeHeight: 4211873, tipHeight: 4211873, jobs: 1822, shares: 92, blocks: 61, rejected: 7, stale: 24, pending: 0, miners: 2, lastError: "", workers: [
          { worker: "hog-mainnet", remote: false, connected: 1, shares: 80, blocks: 55, rejected: 6, lastShareAt: now - 42e3 },
          { worker: "rig2-mainnet", remote: true, connected: 1, shares: 12, blocks: 6, rejected: 1, lastShareAt: now - 6e5 },
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
      return { ok: true, status: 200, body: { ok: true } };
    },
  };
})();

// Android back button: close a sheet, go up a folder, then back to Containers.
window.hogBack = () => {
  if (!$("sheet").hidden) { closeSheet(); return true; }
  if ($("app-view").hidden) return false;
  if (current === "files" && files.path) { openDir(files.path.includes("/") ? files.path.slice(0, files.path.lastIndexOf("/")) : ""); return true; }
  if (current !== "containers") { go("containers"); return true; }
  return false;
};

wire();
if (config().paired) startApp();
else showPair();
const startTab = new URLSearchParams(location.search).get("tab");
if (startTab && !native) go(startTab);
