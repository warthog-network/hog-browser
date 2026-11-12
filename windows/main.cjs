// Hog for Windows: Electron shell around Hog's local server and web UI.
// Port of the Linux GTK/WebKitGTK shell (hog). The chrome window loads
// http://127.0.0.1:4188/ (wallet, tabs, node tab, solo mining, bookmarks);
// each web tab is a WebContentsView placed where the chrome says. Docker,
// Tailscale, Jellyfin and library control are Linux only for now.
"use strict";
const { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell, net } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const netMod = require("node:net");
const path = require("node:path");
const rules = require("./lib/rules.cjs");

const PORT = Number(process.env.HOG_PORT || rules.HOG_PORT);
const NODE_PORT = Number(process.env.HOG_NODE_PORT || rules.NODE_PORT);
const PORTS = { hog: PORT, node: NODE_PORT };
const URL_HOME = `http://127.0.0.1:${PORT}/`;
const HOG_DIR = app.isPackaged ? path.join(process.resourcesPath, "hog") : path.join(__dirname, "stage", "hog");
const DATA = process.env.HOG_DATA || path.join(app.getPath("appData"), "hog-browser");
const SMOKE = process.env.HOG_SMOKE === "1" || process.argv.includes("--smoke");

// The in-tab Warthog node (WASM with threads) needs SharedArrayBuffer inside
// the node iframe; WebKitGTK allows it there, Chromium only when asked.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.setPath("userData", path.join(DATA, "electron"));
app.setAppUserModelId("org.hog.Browser");

let server = null;
let win = null;
let chromeReady = false;
const pendingUrls = [];
let updateChecked = false;

function log(...args) {
  if (SMOKE || !app.isPackaged) console.log("[hog]", ...args);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = netMod.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(300);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

/** Start server.mjs with Electron's own Node (ELECTRON_RUN_AS_NODE). */
async function ensureServer() {
  if (await portOpen(PORT)) return;
  fs.mkdirSync(DATA, { recursive: true });
  const script = path.join(HOG_DIR, "server.mjs");
  server = spawn(process.execPath, [script], {
    cwd: HOG_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOG_SERVER_MAIN: "1", HOG_PORT: String(PORT), HOG_SERVER_DATA: DATA },
    stdio: SMOKE || !app.isPackaged ? "inherit" : "ignore",
    windowsHide: true,
  });
  let exited = null;
  server.once("exit", (code) => { exited = code ?? -1; });
  for (let i = 0; i < 100; i++) {
    if (await portOpen(PORT)) return;
    if (exited !== null) throw new Error(`Hog's local server stopped before the window opened (exit ${exited}).`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Hog's local server did not start.");
}

function stopServer() {
  if (server && server.exitCode === null) {
    try { server.kill(); } catch {}
  }
}

function runInChrome(script) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(script, false).catch(() => {});
}

// ---------- Pages: one WebContentsView per tab (PageHost in hog) ----------
const pages = {
  views: new Map(), // tab id -> { view, isolated }
  shown: null,
  margins: { left: 0, top: 0, right: 0, bottom: 0 },
  gripPaint: null,
  menuPaint: null,
  lastInput: new Map(),

  tell(payload) {
    runInChrome(`window.__hogPage && window.__hogPage(${JSON.stringify(payload)});`);
  },

  emitState(tabId, event, extra = {}) {
    const entry = this.views.get(String(tabId));
    const wc = entry?.view.webContents;
    const nav = wc?.navigationHistory;
    this.tell({
      id: String(tabId),
      event,
      url: wc ? wc.getURL() : "",
      title: wc ? wc.getTitle() || "" : "",
      back: Boolean(nav && nav.canGoBack()),
      forward: Boolean(nav && nav.canGoForward()),
      loading: Boolean(wc && wc.isLoading()),
      ...extra,
    });
  },

  ensure(tabId, isolated) {
    tabId = String(tabId);
    const existing = this.views.get(tabId);
    if (existing) return existing.view;
    const partition = isolated ? `hog-iso-${crypto.randomBytes(8).toString("hex")}` : "persist:hog-pages";
    hardenSession(session.fromPartition(partition));
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, "gen", "preload-page.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    const wc = view.webContents;
    wc.on("did-start-loading", () => this.emitState(tabId, "start", { loading: true }));
    wc.on("did-navigate", () => { this.emitState(tabId, "commit", { loading: true }); if (this.shown === tabId) { this.repaintGrips(); this.repaintMenu(); } });
    wc.on("did-navigate-in-page", (_e, _url, isMain) => { if (isMain) this.emitState(tabId, "commit", { loading: wc.isLoading() }); });
    wc.on("did-stop-loading", () => { this.emitState(tabId, "finish", { loading: false }); if (this.shown === tabId) { this.repaintGrips(); this.repaintMenu(); } });
    wc.on("did-fail-load", (_e, code, description, url, isMain) => {
      if (!isMain) return;
      // -3 ABORTED: a new load replaced this one, or a download started.
      if (code === -3 || !/^https?:/i.test(url || "")) return this.emitState(tabId, "stop", { loading: false });
      const tls = code <= -200 && code > -300;
      this.emitState(tabId, "fail", { url: url || "", error: tls ? "The site certificate was not accepted" : description || "Could not open that page", loading: false });
    });
    wc.on("page-title-updated", () => this.emitState(tabId, "title"));
    wc.on("input-event", (_e, input) => {
      if (["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "char", "touchStart", "gestureTap"].includes(input.type)) this.lastInput.set(tabId, Date.now());
    });
    wc.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" || input.type === "rawKeyDown") this.lastInput.set(tabId, Date.now());
      const name = rules.shortcutFor({ ...input, type: "keyDown" });
      if (name && (input.type === "keyDown" || input.type === "rawKeyDown")) {
        event.preventDefault();
        runInChrome(`window.__hogKey && window.__hogKey(${JSON.stringify(name)})`);
      }
    });
    const guardNav = (event, url) => {
      if (rules.allowedPage(url, PORTS) || rules.inPageNavigation(url)) return;
      // Sites probe mailto:, intent: and other schemes; drop those quietly.
      event.preventDefault();
    };
    wc.on("will-navigate", (event) => guardNav(event, event.url));
    wc.on("will-redirect", (event) => guardNav(event, event.url));
    wc.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && !rules.allowedPage(event.url, PORTS) && !rules.inPageNavigation(event.url)) event.preventDefault();
    });
    // A click may open a new tab. A page may not open one by itself.
    wc.setWindowOpenHandler(({ url }) => {
      const recent = Date.now() - (this.lastInput.get(tabId) || 0) < 1500;
      if (url && recent && rules.allowedPage(url, PORTS)) {
        this.tell({ event: "popup", url, isolated: Boolean(this.views.get(tabId)?.isolated) });
      }
      return { action: "deny" };
    });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    win.contentView.addChildView(view);
    this.views.set(tabId, { view, isolated: Boolean(isolated) });
    return view;
  },

  load(tabId, isolated, url) {
    if (!rules.allowedPage(url, PORTS)) {
      this.tell({ id: String(tabId), event: "fail", url, error: "Only http and https pages can be opened", loading: false });
      return;
    }
    const view = this.ensure(tabId, isolated);
    view.webContents.loadURL(url).catch(() => {});
  },

  place(margins, show, tabId) {
    this.margins = margins;
    tabId = String(tabId || "");
    if (!show || !this.views.has(tabId)) {
      for (const { view } of this.views.values()) view.setVisible(false);
      this.shown = null;
      return;
    }
    const [width, height] = win.getContentSize();
    const bounds = rules.pageBounds({ width, height }, margins);
    for (const [id, { view }] of this.views) {
      if (id === tabId) {
        view.setBounds(bounds);
        view.setVisible(true);
      } else view.setVisible(false);
    }
    if (this.shown !== tabId) {
      this.views.get(tabId).view.webContents.focus();
      this.shown = tabId;
    }
    this.repaintGrips();
    this.repaintMenu();
  },

  relayout() {
    if (!this.shown) return;
    const entry = this.views.get(this.shown);
    if (!entry) return;
    const [width, height] = win.getContentSize();
    entry.view.setBounds(rules.pageBounds({ width, height }, this.margins));
  },

  drop(tabId) {
    tabId = String(tabId);
    const entry = this.views.get(tabId);
    if (!entry) return;
    this.views.delete(tabId);
    this.lastInput.delete(tabId);
    if (this.shown === tabId) this.shown = null;
    try { win.contentView.removeChildView(entry.view); } catch {}
    entry.view.webContents.close();
  },

  shownContents() {
    return this.shown ? this.views.get(this.shown)?.view.webContents : null;
  },

  runOnShown(script) {
    const wc = this.shownContents();
    if (wc && !wc.isDestroyed()) wc.executeJavaScript(script, false).catch(() => {});
  },

  repaintGrips() {
    if (this.gripPaint) this.runOnShown(`window.__hogEdgeGrips && window.__hogEdgeGrips(${JSON.stringify(this.gripPaint)})`);
  },

  repaintMenu() {
    if (!this.shown) return;
    this.runOnShown(`window.__hogMenu && window.__hogMenu(${this.menuPaint === null ? "null" : JSON.stringify(this.menuPaint)})`);
  },

  paintMenu(raw) {
    if (raw === null) this.menuPaint = null;
    else {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      this.menuPaint = data;
    }
    this.repaintMenu();
  },

  command(command) {
    const viewCmd = rules.parseViewCommand(command);
    if (command.startsWith("view:")) {
      if (viewCmd) this.place({ left: viewCmd.left, top: viewCmd.top, right: viewCmd.right, bottom: viewCmd.bottom }, viewCmd.show, viewCmd.tab);
      return true;
    }
    if (command.startsWith("page:")) {
      const m = /^page:([^:]*):([^:]*):([\s\S]*)$/.exec(command);
      if (m) this.load(m[1], m[2] === "1", m[3]);
      return true;
    }
    const simple = /^(drop|back|fwd|reload|stop):([\s\S]*)$/.exec(command);
    if (simple) {
      const [, verb, id] = simple;
      if (verb === "drop") { this.drop(id); return true; }
      const wc = this.views.get(id)?.view.webContents;
      if (!wc) return true;
      const nav = wc.navigationHistory;
      if (verb === "back" && nav.canGoBack()) nav.goBack();
      if (verb === "fwd" && nav.canGoForward()) nav.goForward();
      if (verb === "reload") wc.reload();
      if (verb === "stop") wc.stop();
      return true;
    }
    if (command.startsWith("zoom:")) {
      const bits = command.split(":");
      if (bits.length !== 3) return true;
      const level = Number(bits[2]);
      const wc = this.views.get(bits[1])?.view.webContents;
      if (wc && Number.isFinite(level) && level >= 0.25 && level <= 5) wc.setZoomFactor(level);
      return true;
    }
    return false;
  },

  // Messages from page scripts (EDGE_GRIP_SCRIPT, dapp-provider.js).
  onEdgeMessage(sender, command) {
    const wc = this.shownContents();
    if (!wc || wc !== sender) return;
    if (command.startsWith("dapp:")) return this.onDappRequest(wc, command.slice(5));
    const parts = command.split(":");
    if (parts[0] === "menu" && parts.length >= 2) return this.onMenuMessage(parts);
    if (parts.length < 2 || !["tabs", "wallet"].includes(parts[1])) return;
    const [kind, side] = parts;
    if (kind === "click" && parts.length === 2) return runInChrome(`window.__hogEdgeClick && window.__hogEdgeClick('${side}')`);
    if (kind === "end" && parts.length === 2) return runInChrome(`window.__hogEdgeEnd && window.__hogEdgeEnd('${side}')`);
    if (kind !== "move" || parts.length !== 3 || !/^-?\d+$/.test(parts[2])) return;
    const top = Number(parts[2]);
    if (top < -200 || top > 10000) return;
    runInChrome(`window.__hogEdgeMove && window.__hogEdgeMove('${side}', ${top})`);
  },

  onMenuMessage(parts) {
    const kind = parts[1];
    if (kind === "dismiss" && parts.length === 2) return runInChrome("window.__hogMenuDismiss && window.__hogMenuDismiss()");
    if (kind === "clear" && parts.length === 2) return runInChrome("window.__hogMenuClear && window.__hogMenuClear()");
    if (!["suggestions", "history", "settings"].includes(kind) || parts.length !== 3 || !/^\d+$/.test(parts[2])) return;
    const index = Number(parts[2]);
    if (index > 40) return;
    runInChrome(`window.__hogMenuActivate && window.__hogMenuActivate('${kind}', ${index})`);
  },

  onDappRequest(wc, raw) {
    const req = rules.dappRequest(raw);
    if (!req) return;
    const origin = rules.pageOrigin(wc.getURL(), PORTS);
    if (!origin) {
      wc.executeJavaScript(dappResolveScript(req.id, false, { code: 4001, message: "This page cannot connect." }), false).catch(() => {});
      return;
    }
    const payload = { id: req.id, tab: this.shown || "", origin, method: req.method, params: req.params };
    runInChrome(`window.__hogDappAsk && window.__hogDappAsk(${JSON.stringify(payload)})`);
  },

  deliverDappReply(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== "object" || raw.length > 200_000) return;
    if (typeof data.id !== "number" || !Number.isInteger(data.id) || typeof data.tab !== "string" || !data.tab) return;
    const wc = this.views.get(data.tab)?.view.webContents;
    if (wc) wc.executeJavaScript(dappResolveScript(data.id, Boolean(data.ok), data.payload), false).catch(() => {});
  },

  deliverDappEmit(raw) {
    const data = rules.dappEmit(raw);
    if (!data) return;
    const script = `window.__hogDappEmit && window.__hogDappEmit(${JSON.stringify(data.event)}, ${JSON.stringify(data.payload)})`;
    for (const { view } of this.views.values()) {
      if (rules.pageOrigin(view.webContents.getURL(), PORTS) === data.origin) view.webContents.executeJavaScript(script, false).catch(() => {});
    }
  },
};

function dappResolveScript(id, ok, payload) {
  return `window.__hogDappResolve && window.__hogDappResolve(${Math.trunc(id)}, ${ok ? "true" : "false"}, ${JSON.stringify(payload ?? null)})`;
}

const hardened = new WeakSet();
/** Page sessions: no permissions beyond fullscreen and clipboard writes. */
function hardenSession(ses) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  const ok = new Set(["fullscreen", "clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ok.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ok.has(permission));
}

// ---------- Messages from the chrome (on_window_message in hog) ----------
function tellBookmarks(payload) {
  runInChrome(`window.__hogBookmarks && window.__hogBookmarks(${JSON.stringify(payload)})`);
}

let dialogOpen = false;
async function onBookmarks(command) {
  const rest = command.slice("bookmarks:".length);
  const i = rest.indexOf(":");
  const action = i < 0 ? rest : rest.slice(0, i);
  const body = i < 0 ? "" : rest.slice(i + 1);
  if (action === "backup") return void rules.writeBookmarkBackup(rules.bookmarkBackupPath(DATA), body);
  if (dialogOpen || !win) return;
  dialogOpen = true;
  try {
    if (action === "import") {
      const r = await dialog.showOpenDialog(win, {
        title: "Import bookmarks (an HTML file from Brave, Chrome, Edge or Firefox)",
        defaultPath: app.getPath("downloads"),
        properties: ["openFile"],
        filters: [{ name: "Bookmark files", extensions: ["html", "htm"] }, { name: "All files", extensions: ["*"] }],
      });
      if (!r.canceled && r.filePaths[0]) tellBookmarks(rules.readBookmarkFile(r.filePaths[0]));
    } else if (action === "export") {
      const day = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog(win, {
        title: "Export bookmarks",
        defaultPath: path.join(app.getPath("downloads"), `hog-bookmarks-${day}.html`),
        filters: [{ name: "Bookmark files", extensions: ["html"] }],
      });
      if (!r.canceled && r.filePath) tellBookmarks(rules.writeBookmarkFile(r.filePath, body));
    }
  } finally {
    dialogOpen = false;
  }
}

async function checkUpdates() {
  const current = app.getVersion();
  let release = null;
  try {
    const res = await net.fetch("https://api.github.com/repos/warthog-network/hog-browser/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": `hog-browser-windows/${current}` },
    });
    if (res.ok) release = await res.json();
  } catch {}
  runInChrome(`window.__hogUpdate && window.__hogUpdate(${JSON.stringify(rules.updatePayload(current, release))})`);
}

function onContainers(command) {
  const action = command.split(":", 3)[1] || "";
  // Docker, Tailscale, Jellyfin, shares and the library are Linux only; the
  // Windows UI hides them. Updates: check GitHub; install by hand for now.
  if (["update-status", "update-check", "update-check-now"].includes(action)) checkUpdates();
}

function openExternalUrl(raw) {
  const text = rules.allowedBrowserOpenUrl(raw);
  if (!text) return;
  if (chromeReady) pages.tell({ event: "popup", url: text, isolated: false });
  else if (!pendingUrls.includes(text) && pendingUrls.length < 20) pendingUrls.push(text);
}

function onWindowMessage(command) {
  if (pages.command(command)) return;
  if (command.startsWith("edges:")) {
    const paint = rules.gripPaint(command, pages.margins.top);
    if (paint) {
      pages.gripPaint = paint;
      pages.repaintGrips();
    }
    return;
  }
  if (command.startsWith("open:")) {
    const url = rules.allowedTailscaleOpenUrl(command.slice(5));
    if (url) pages.tell({ event: "popup", url, isolated: false });
    return;
  }
  if (command.startsWith("containers:")) return onContainers(command);
  if (command.startsWith("bookmarks:")) return void onBookmarks(command);
  if (command.startsWith("dapp-reply:")) return pages.deliverDappReply(command.slice("dapp-reply:".length));
  if (command.startsWith("dapp-emit:")) return pages.deliverDappEmit(command.slice("dapp-emit:".length));
  if (command === "menu:hide") return pages.paintMenu(null);
  if (command.startsWith("menu:")) return pages.paintMenu(command.slice(5));
  if (command === "close") return win.close();
  if (command === "min") return win.minimize();
  if (command === "max") return win.isMaximized() ? win.unmaximize() : win.maximize();
  // pill:, grip:, drop-box: draw GTK overlays on Linux; Windows uses CSS drag regions.
}

ipcMain.on("hogwin", (event, command) => {
  if (!win || event.sender !== win.webContents || typeof command !== "string" || command.length > 400_000) return;
  try {
    onWindowMessage(command);
  } catch (e) {
    log("command failed", e);
  }
});
ipcMain.on("hogedge", (event, command) => {
  if (typeof command !== "string" || command.length > 210_000) return;
  pages.onEdgeMessage(event.sender, command);
});

// Window chrome for a frameless window: drag by Hog's grip, never by buttons.
const CHROME_CSS = `
#win-drag { -webkit-app-region: drag; }
#winctl, #winctl * { -webkit-app-region: no-drag; }
#resize-frame { display: none !important; }
`;

function createWindow() {
  const icon = path.join(HOG_DIR, "public", "hog-icon.png");
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    frame: false,
    backgroundColor: "#0b0b0d",
    title: "Hog",
    icon: fs.existsSync(icon) ? icon : undefined,
    show: !SMOKE || process.env.HOG_SMOKE_SHOW === "1",
    webPreferences: {
      preload: path.join(__dirname, "preload-chrome.cjs"),
      partition: "persist:hog-chrome",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      // The node tab lives in this window: keep it syncing and serving
      // BzMiner while Hog is minimized or behind other windows.
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  // The chrome may load only Hog's own server; links leave through tabs.
  wc.on("will-navigate", (event) => { if (!String(event.url).startsWith(URL_HOME)) event.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\/warthog-network\//.test(url)) shell.openExternal(url);
    else if (rules.allowedPage(url, PORTS)) pages.tell({ event: "popup", url, isolated: false });
    return { action: "deny" };
  });
  wc.on("before-input-event", (event, input) => {
    const name = rules.shortcutFor({ ...input, type: input.type === "rawKeyDown" ? "keyDown" : input.type });
    if (name) {
      event.preventDefault();
      runInChrome(`window.__hogKey && window.__hogKey(${JSON.stringify(name)})`);
    }
  });
  wc.on("did-finish-load", () => {
    wc.insertCSS(CHROME_CSS).catch(() => {});
    chromeReady = true;
    log(`Hog is open at ${URL_HOME}`);
    for (const url of pendingUrls.splice(0)) pages.tell({ event: "popup", url, isolated: false });
    if (!updateChecked) {
      updateChecked = true;
      if (!SMOKE) checkUpdates();
    }
  });
  win.on("resize", () => pages.relayout());
  win.on("closed", () => { win = null; });
  win.loadURL(URL_HOME);
}

function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => /^https?:\/\//i.test(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    for (const url of urlsFromArgv(argv)) openExternalUrl(url);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    hardenSession(session.fromPartition("persist:hog-chrome"));
    // The chrome needs clipboard access for Copy buttons (wallet address, miner command).
    session.fromPartition("persist:hog-chrome").setPermissionRequestHandler((wc, permission, cb) => cb(["clipboard-sanitized-write", "clipboard-read"].includes(permission) && wc === win?.webContents));
    session.fromPartition("persist:hog-chrome").setPermissionCheckHandler((wc, permission) => ["clipboard-sanitized-write", "clipboard-read"].includes(permission) && (!wc || wc === win?.webContents));
    try {
      await ensureServer();
    } catch (e) {
      dialog.showErrorBox("Hog", String(e.message || e));
      app.exit(1);
      return;
    }
    for (const url of urlsFromArgv(process.argv)) openExternalUrl(url);
    createWindow();
    if (SMOKE) require("./smoke.cjs").run({ app, win: () => win, pages, URL_HOME, PORT, NODE_PORT, stopServer });
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopServer);
  app.on("quit", stopServer);
  process.on("exit", stopServer);
}
