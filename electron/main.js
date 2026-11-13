"use strict";
// Hog (Chromium preview): the Hog shell on Electron/Chromium.
//
// Same split as the WebKitGTK shell (../hog): the Hog UI ("chrome": tab strip,
// address bar, wallet, settings, hog:// pages, node tab) is public/index.html
// served by server.mjs. Real web pages are separate Chromium views laid over
// the content area, and the two talk through the same string commands the
// GTK shell understands (window.webkit.messageHandlers.hogwin / hogedge).
// server.mjs and public/ are used unchanged.
const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const policy = require("./lib/policy");
const { HogServer } = require("./lib/server");
const { GuardBridge } = require("./lib/guard");

const APP_NAME = "Hog (Chromium preview)";
const HOG_DATA = process.env.HOG_DATA || path.join(os.homedir(), ".local", "share", "hog-browser");
// The preview's own browser profile (cookies, wallet localStorage, node chain,
// history). Never the WebKit Hog's ~/.local/share/hog-browser/pages.
const PREVIEW_DATA = process.env.HOG_PREVIEW_DATA || path.join(os.homedir(), ".local", "share", "hog-chromium-preview");
const CHROME_PARTITION = "persist:hog";
const PAGES_PARTITION = "persist:pages";

app.setName(APP_NAME);
app.setPath("userData", PREVIEW_DATA);
app.setPath("sessionData", PREVIEW_DATA);
app.setDesktopName("hog-chromium-preview.desktop");
app.userAgentFallback = policy.chromeUserAgent(process.versions.chrome);
// X11 WM_CLASS / Wayland app_id, so the dock matches hog-chromium-preview.desktop
// and never groups this window with the WebKit Hog ("hog").
app.commandLine.appendSwitch("class", "hog-chromium-preview");

function hogRoot() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "hog-app")]
    : [path.join(__dirname, "hog-app"), path.join(__dirname, "..")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "server.mjs"))) return dir;
  }
  return candidates[0];
}
const ROOT = hogRoot();

function iconPath() {
  for (const candidate of [
    path.join(ROOT, "public", "hog-icon.png"),
    path.join(__dirname, "build", "icons", "256x256.png"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function log(text) {
  process.stderr.write(`${text}\n`);
}

const server = new HogServer({ root: ROOT, log });
let guard = null;
let win = null;
let pages = null;
let chromeReady = false;
const pendingUrls = [];

function ports() {
  return [server.port, server.nodePort];
}

function tellChrome(script) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(script, false).catch(() => {});
}

function hook(name, payload) {
  tellChrome(`window.${name} && window.${name}(${JSON.stringify(payload)})`);
}

// ---------------------------------------------------------------- downloads

function downloadsFolder() {
  const override = (process.env.HOG_DOWNLOADS || "").trim();
  if (override) return override.replace(/^~(?=\/|$)/, os.homedir());
  // Like hog: the XDG Downloads folder, else ~/Downloads (never bare $HOME).
  let folder = "";
  try {
    folder = app.getPath("downloads");
  } catch {
    folder = "";
  }
  if (!folder || path.resolve(folder) === path.resolve(os.homedir())) folder = path.join(os.homedir(), "Downloads");
  return folder;
}

class PageDownloads {
  constructor() {
    this.items = new Map();
    this.nextId = 1;
  }

  takenPaths() {
    return new Set([...this.items.values()].filter((item) => !item.done && item.path).map((item) => item.path));
  }

  emit(id, state, extra = {}) {
    const item = this.items.get(id);
    if (!item) return;
    hook("__hogDownload", { id, state, name: item.name || "download", ...extra });
  }

  start(item) {
    const id = String(this.nextId++);
    const entry = { item, name: "", path: "", done: false, shown: -1 };
    this.items.set(id, entry);
    const name = policy.downloadName(item.getFilename(), item.getURL());
    const folder = downloadsFolder();
    let full;
    try {
      fs.mkdirSync(folder, { recursive: true });
      full = policy.uniqueDownloadPath(folder, name, this.takenPaths());
    } catch {
      entry.name = name;
      entry.done = true;
      this.emit(id, "failed", { error: "Hog could not use your Downloads folder." });
      item.cancel();
      return;
    }
    entry.path = full;
    entry.name = path.basename(full);
    item.setSavePath(full);
    this.emit(id, "started", { progress: 0 });
    item.on("updated", (_event, state) => {
      if (entry.done || state !== "progressing") return;
      const total = item.getTotalBytes();
      const received = item.getReceivedBytes();
      const progress = total > 0 ? received / total : 0;
      if (progress === entry.shown || (progress < 1 && progress - entry.shown < 0.02)) return;
      entry.shown = progress;
      this.emit(id, "progress", { progress: Math.round(progress * 1000) / 1000, received });
    });
    item.once("done", (_event, state) => {
      if (entry.done) return;
      entry.done = true;
      if (state === "completed") {
        let size = 0;
        try {
          size = fs.statSync(entry.path).size;
        } catch {
          size = item.getReceivedBytes();
        }
        this.emit(id, "done", { progress: 1, received: size });
      } else if (state === "cancelled") {
        this.emit(id, "cancelled");
      } else {
        this.emit(id, "failed", { error: "The download failed." });
      }
    });
  }

  command(command) {
    const parts = command.split(":");
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) return;
    const entry = this.items.get(parts[2]);
    if (!entry) return;
    if (parts[1] === "cancel" && !entry.done) entry.item.cancel();
    else if (parts[1] === "show" && entry.done && entry.path && fs.existsSync(entry.path)) shell.showItemInFolder(entry.path);
  }
}

// ---------------------------------------------------------------- sessions

let blocker = null;
let blockerReady = null;
const preparedSessions = new WeakSet();

function loadBlocker() {
  if (process.env.HOG_NO_ADBLOCK === "1") return Promise.resolve(null);
  if (blockerReady) return blockerReady;
  blockerReady = (async () => {
    try {
      const { ElectronBlocker } = require("@ghostery/adblocker-electron");
      const cache = path.join(PREVIEW_DATA, "adblock-engine.bin");
      blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cache,
        read: fsp.readFile,
        write: fsp.writeFile,
      });
      ipcMain.handle("@ghostery/adblocker/inject-cosmetic-filters", blocker.onInjectCosmeticFilters);
      ipcMain.handle("@ghostery/adblocker/is-mutation-observer-enabled", blocker.onIsMutationObserverEnabled);
      log("Hog preview: ad and tracker blocking is on.");
      return blocker;
    } catch (error) {
      log(`Hog preview: ad blocking is off (${error.message}).`);
      blocker = null;
      return null;
    }
  })();
  return blockerReady;
}

function preparePageSession(ses) {
  if (preparedSessions.has(ses)) return;
  preparedSessions.add(ses);
  ses.setUserAgent(app.userAgentFallback);
  ses.setSpellCheckerEnabled(true);
  // Web pages may never reach Hog's own server or node ports (wallet API,
  // mining, files). The wallet UI is a different partition anyway.
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let url;
    try {
      url = new URL(details.url);
    } catch {
      return callback({});
    }
    if (policy.isHogLocal(url, ports())) return callback({ cancel: true });
    if (blocker) return blocker.onBeforeRequest(details, callback);
    return callback({});
  });
  // Global Privacy Control, like Brave (page-preload.js sets navigator.globalPrivacyControl).
  ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, "Sec-GPC": "1" } });
  });
  ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    if (blocker) return blocker.onHeadersReceived(details, callback);
    return callback({});
  });
  loadBlocker().then((ready) => {
    if (!ready) return;
    try {
      const { PRELOAD_PATH } = require("@ghostery/adblocker-electron/dist/commonjs/preload_path.js");
      ses.registerPreloadScript({ type: "frame", filePath: PRELOAD_PATH });
    } catch {
      try {
        ses.registerPreloadScript({ type: "frame", filePath: require.resolve("@ghostery/adblocker-electron-preload") });
      } catch (error) {
        log(`Hog preview: cosmetic filtering is off (${error.message}).`);
      }
    }
  });
  const granted = new Map();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const always = ["fullscreen", "clipboard-sanitized-write", "pointerLock", "window-management"];
    if (always.includes(permission)) return callback(true);
    if (permission !== "media") return callback(false);
    const origin = policy.pageOrigin(details.requestingUrl || wc.getURL(), ports());
    if (!origin) return callback(false);
    const kinds = (details.mediaTypes || []).join(" and ") || "camera or microphone";
    const key = `${origin} ${kinds}`;
    if (granted.has(key)) return callback(granted.get(key));
    dialog
      .showMessageBox(win, {
        type: "question",
        buttons: ["Block", "Allow"],
        defaultId: 0,
        cancelId: 0,
        title: "Camera and microphone",
        message: `${origin} wants to use your ${kinds}.`,
        detail: "Hog remembers your answer until it closes.",
      })
      .then(({ response }) => {
        granted.set(key, response === 1);
        callback(response === 1);
      })
      .catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (["fullscreen", "clipboard-sanitized-write", "pointerLock"].includes(permission)) return true;
    if (permission === "media") {
      for (const [key, value] of granted) if (value && key.startsWith(`${requestingOrigin} `)) return true;
    }
    return false;
  });
  ses.on("will-download", (_event, item) => {
    if (pages) pages.downloads.start(item);
  });
}

function prepareChromeSession(ses) {
  ses.setUserAgent(app.userAgentFallback);
  ses.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    callback(isOwnUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, _permission, requestingOrigin) => isOwnUrl(requestingOrigin));
  ses.on("will-download", (_event, item) => {
    if (!policy.filesDownloadUri(item.getURL(), server.port)) return;
    // hog://files downloads ask where to save, like the GTK shell.
    item.setSaveDialogOptions({
      title: "Save file",
      defaultPath: path.join(downloadsFolder(), policy.downloadName(item.getFilename())),
    });
    item.once("done", (_e, state) => {
      if (state === "completed") hook("__hogFilesSaved", path.basename(item.getSavePath()));
    });
  });
}

function isOwnUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    return policy.isHogLocal(url, ports());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- pages

const HOG_SOURCE = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, "hog"), "utf8");
  } catch {
    return "";
  }
})();
const EDGE_GRIP_SCRIPT = policy.extractEdgeGripScript(HOG_SOURCE);
const DAPP_PROVIDER_SCRIPT = (() => {
  try {
    return policy.rewriteMessageHandler(fs.readFileSync(path.join(ROOT, "public", "dapp-provider.js"), "utf8"));
  } catch {
    return "";
  }
})();

function crashMessage(reason) {
  if (reason === "oom") return "This page used too much memory and was stopped. Reload to try again.";
  return "This page stopped working. Reload to try again.";
}

function friendlyError(code, description) {
  if (code <= -200 && code > -300) return "The site certificate was not accepted";
  if (code === -105) return "Could not find that site";
  if (code === -106) return "You are offline";
  if (code === -102 || code === -118) return "The site did not answer";
  return description ? `Could not open that page (${description})` : "Could not open that page";
}

class PageHost {
  constructor() {
    this.views = new Map(); // tabId -> { view, isolated, failed }
    this.byContents = new Map(); // webContents.id -> tabId
    this.shown = null;
    this.place = { left: 0, top: 0, right: 0, bottom: 0 };
    this.gripPaint = null;
    this.menuPaint = null;
    this.gestures = new Map();
    this.downloads = new PageDownloads();
  }

  tell(payload) {
    hook("__hogPage", payload);
  }

  emitState(tabId, event, extra = {}) {
    const entry = this.views.get(String(tabId));
    const wc = entry && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null;
    const payload = {
      id: String(tabId),
      event,
      url: wc ? wc.getURL() : "",
      title: wc ? wc.getTitle() || "" : "",
      back: Boolean(wc && wc.navigationHistory.canGoBack()),
      forward: Boolean(wc && wc.navigationHistory.canGoForward()),
      loading: wc ? wc.isLoading() : false,
      ...extra,
    };
    // Chromium reports the URL as the title until the page sets one.
    if (wc && payload.title === payload.url) payload.title = "";
    this.tell(payload);
  }

  tabFor(wc) {
    return this.byContents.get(wc.id);
  }

  ensure(tabId, isolated) {
    tabId = String(tabId);
    const existing = this.views.get(tabId);
    if (existing) return existing.view;
    const partition = isolated ? `hog-iso-${tabId}-${Date.now()}` : PAGES_PARTITION;
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, "page-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    const wc = view.webContents;
    preparePageSession(wc.session);
    const entry = { view, isolated: Boolean(isolated), failed: false };
    this.views.set(tabId, entry);
    this.byContents.set(wc.id, tabId);
    win.contentView.addChildView(view);

    wc.setWindowOpenHandler(({ url }) => {
      if (process.env.HOG_PREVIEW_DEBUG) log(`popup ${url} gesture=${this.recentGesture(wc.id)}`);
      // A click may open a new tab. A page may not open one by itself.
      if (url && policy.pageAllowed(url, ports()) && this.recentGesture(wc.id)) {
        this.tell({ event: "popup", url, isolated: entry.isolated });
      }
      return { action: "deny" };
    });
    const guardNav = (event, url) => {
      if (policy.pageAllowed(url, ports()) || policy.inPageNavigation(url)) return;
      event.preventDefault();
    };
    wc.on("will-navigate", (event) => guardNav(event, event.url));
    wc.on("will-redirect", (event) => {
      if (event.isMainFrame) guardNav(event, event.url);
    });
    wc.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) entry.failed = false;
    });
    wc.on("did-start-loading", () => this.emitState(tabId, "start", { loading: true }));
    wc.on("did-navigate", () => {
      this.emitState(tabId, "commit", { loading: true });
      if (this.shown === tabId) this.repaint();
    });
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) this.emitState(tabId, "title");
    });
    wc.on("did-stop-loading", () => {
      if (entry.failed) {
        this.emitState(tabId, "stop", { loading: false });
        return;
      }
      this.emitState(tabId, "finish", { loading: false });
      if (this.shown === tabId) this.repaint();
    });
    wc.on("dom-ready", () => {
      if (this.shown === tabId) this.repaint();
    });
    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) {
        // ERR_ABORTED: a stop, a download, or a new navigation. Keep the page.
        this.emitState(tabId, "stop", { loading: false });
        return;
      }
      entry.failed = true;
      this.emitState(tabId, "fail", { url: url || "", error: friendlyError(code, description), loading: false });
    });
    wc.on("page-title-updated", () => this.emitState(tabId, "title"));
    wc.on("render-process-gone", (_event, details) => {
      log(`Hog preview: the page process for tab ${tabId} stopped (${details.reason}).`);
      if (details.reason === "clean-exit") return;
      entry.failed = true;
      this.emitState(tabId, "fail", { url: wc.getURL(), error: crashMessage(details.reason), loading: false });
    });
    wc.on("before-input-event", (event, input) => onShortcutInput(event, input, wc));
    wc.on("enter-html-full-screen", () => this.fullscreen(tabId, true));
    wc.on("leave-html-full-screen", () => this.fullscreen(tabId, false));
    return view;
  }

  fullscreen(tabId, on) {
    const entry = this.views.get(tabId);
    if (!entry || !win) return;
    this.fullTab = on ? tabId : null;
    if (on) {
      const [width, height] = win.getContentSize();
      entry.view.setBounds({ x: 0, y: 0, width, height });
    } else {
      this.layout();
    }
  }

  recentGesture(id) {
    const at = this.gestures.get(id) || 0;
    return Date.now() - at < 1500;
  }

  load(tabId, isolated, url) {
    if (!policy.pageAllowed(url, ports())) {
      this.tell({ id: String(tabId), event: "fail", url, error: "Only http and https pages can be opened", loading: false });
      return;
    }
    const view = this.ensure(tabId, isolated);
    view.webContents.loadURL(url).catch(() => {});
  }

  layout() {
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const bounds = policy.viewBounds(this.place, width, height);
    for (const [tabId, entry] of this.views) {
      if (this.fullTab === tabId) {
        entry.view.setBounds({ x: 0, y: 0, width, height });
      } else {
        entry.view.setBounds(bounds);
      }
    }
  }

  placeView(place) {
    this.place = place;
    this.layout();
    const tabId = String(place.tabId || "");
    if (!place.show || !this.views.has(tabId)) {
      for (const entry of this.views.values()) entry.view.setVisible(false);
      this.shown = null;
      return;
    }
    for (const [id, entry] of this.views) entry.view.setVisible(id === tabId);
    if (this.shown !== tabId) {
      this.shown = tabId;
      const wc = this.views.get(tabId).view.webContents;
      wc.focus();
    }
    this.repaint();
  }

  drop(tabId) {
    tabId = String(tabId);
    const entry = this.views.get(tabId);
    if (!entry) return;
    this.views.delete(tabId);
    this.byContents.delete(entry.view.webContents.id);
    if (this.shown === tabId) this.shown = null;
    try {
      win.contentView.removeChildView(entry.view);
    } catch {
      /* window closing */
    }
    const ses = entry.view.webContents.session;
    entry.view.webContents.close();
    if (entry.isolated) ses.clearStorageData().catch(() => {});
  }

  run(tabId, script) {
    const entry = this.views.get(String(tabId));
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.executeJavaScript(script, false).catch(() => {});
  }

  repaint() {
    if (!this.shown) return;
    if (this.gripPaint) this.run(this.shown, `window.__hogEdgeGrips && window.__hogEdgeGrips(${JSON.stringify(this.gripPaint)})`);
    const arg = this.menuPaint == null ? "null" : JSON.stringify(this.menuPaint);
    this.run(this.shown, `window.__hogMenu && window.__hogMenu(${arg})`);
  }

  paintMenu(raw) {
    if (raw == null) {
      this.menuPaint = null;
    } else {
      try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        this.menuPaint = data;
      } catch {
        return;
      }
    }
    this.repaint();
  }

  onEdgeMessage(wc, command) {
    const tabId = this.tabFor(wc);
    if (!tabId || tabId !== this.shown || typeof command !== "string") return;
    if (command.startsWith("dapp:")) return this.onDappRequest(wc, tabId, command.slice(5));
    const parts = command.split(":");
    if (parts.length >= 2 && parts[0] === "menu") return this.onMenuMessage(parts);
    if (parts.length < 2 || !["tabs", "wallet"].includes(parts[1])) return;
    const [kind, side] = parts;
    if (kind === "click" && parts.length === 2) return tellChrome(`window.__hogEdgeClick && window.__hogEdgeClick('${side}')`);
    if (kind === "end" && parts.length === 2) return tellChrome(`window.__hogEdgeEnd && window.__hogEdgeEnd('${side}')`);
    if (kind !== "move" || parts.length !== 3) return;
    const top = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(top) || top < -200 || top > 10000) return;
    tellChrome(`window.__hogEdgeMove && window.__hogEdgeMove('${side}', ${top})`);
  }

  onMenuMessage(parts) {
    const kind = parts[1];
    if (kind === "dismiss" && parts.length === 2) return tellChrome("window.__hogMenuDismiss && window.__hogMenuDismiss()");
    if (kind === "clear" && parts.length === 2) return tellChrome("window.__hogMenuClear && window.__hogMenuClear()");
    if (!["suggestions", "history", "settings"].includes(kind) || parts.length !== 3) return;
    const index = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(index) || index < 0 || index > 40) return;
    tellChrome(`window.__hogMenuActivate && window.__hogMenuActivate('${kind}', ${index})`);
  }

  onDappRequest(wc, tabId, raw) {
    if (raw.length > 200000) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const { id, method } = data;
    const params = data.params ?? [];
    if (!Number.isInteger(id) || id < 1 || id > 1e15) return;
    if (typeof method !== "string" || !method || method.length > 80) return;
    if (!Array.isArray(params)) return;
    const origin = policy.pageOrigin(wc.getURL(), ports());
    if (!origin) {
      this.run(tabId, this.resolveScript(id, false, { code: 4001, message: "This page cannot connect." }));
      return;
    }
    hook("__hogDappAsk", { id, tab: tabId, origin, method, params });
  }

  resolveScript(id, ok, payload) {
    return `window.__hogDappResolve && window.__hogDappResolve(${Number(id)}, ${ok ? "true" : "false"}, ${JSON.stringify(payload ?? null)})`;
  }

  deliverDappReply(raw) {
    const data = parseObject(raw);
    if (!data || !Number.isInteger(data.id) || typeof data.tab !== "string" || !data.tab) return;
    this.run(data.tab, this.resolveScript(data.id, Boolean(data.ok), data.payload));
  }

  deliverDappEmit(raw) {
    const data = parseObject(raw);
    if (!data) return;
    const { origin, event, payload } = data;
    if (typeof origin !== "string" || !/^https?:\/\//.test(origin)) return;
    if (event !== "accountsChanged" && event !== "chainChanged") return;
    if (event === "accountsChanged") {
      if (!Array.isArray(payload) || payload.length > 4) return;
      if (payload.some((item) => typeof item !== "string" || !item.startsWith("0x") || item.length !== 42)) return;
    } else if (typeof payload !== "string" || !payload.startsWith("0x") || payload.length > 12) {
      return;
    }
    const script = `window.__hogDappEmit && window.__hogDappEmit(${JSON.stringify(event)}, ${JSON.stringify(payload)})`;
    for (const [tabId, entry] of this.views) {
      if (policy.pageOrigin(entry.view.webContents.getURL(), ports()) === origin) this.run(tabId, script);
    }
  }

  command(command) {
    if (command.startsWith("download:")) {
      this.downloads.command(command);
      return true;
    }
    if (command.startsWith("view:")) {
      const place = policy.parseView(command);
      if (place) this.placeView(place);
      return true;
    }
    if (command.startsWith("page:")) {
      const match = /^page:([^:]*):([^:]*):([\s\S]*)$/.exec(command);
      if (match) this.load(match[1], match[2] === "1", match[3]);
      return true;
    }
    if (command.startsWith("drop:")) {
      this.drop(command.slice(5));
      return true;
    }
    const nav = /^(back|fwd|reload|stop):(.*)$/.exec(command);
    if (nav) {
      const entry = this.views.get(nav[2]);
      if (entry) {
        const wc = entry.view.webContents;
        if (nav[1] === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        else if (nav[1] === "fwd" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        else if (nav[1] === "reload") wc.reload();
        else if (nav[1] === "stop") wc.stop();
      }
      return true;
    }
    if (command.startsWith("zoom:")) {
      const bits = command.split(":");
      const level = Number.parseFloat(bits[2]);
      const entry = this.views.get(bits[1]);
      if (bits.length === 3 && entry && Number.isFinite(level) && level > 0.2 && level < 5) {
        entry.view.webContents.setZoomFactor(level);
      }
      return true;
    }
    return false;
  }

  activeContents() {
    const entry = this.shown ? this.views.get(this.shown) : null;
    return entry ? entry.view.webContents : null;
  }
}

function parseObject(raw) {
  if (typeof raw !== "string" || raw.length > 200000) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- shortcuts

// Shortcuts the Hog UI handles itself (onShortcut in app.js). While a web page
// has focus the UI never sees the key, so forward it.
const FORWARD_KEYS = new Set(["t", "w", "l", "d", "o", "h", "tab", "+", "=", "-", "_", "0"]);
const FOCUS_CHROME_KEYS = new Set(["t", "l", "o", "h"]);

function onShortcutInput(event, input, wc) {
  if (input.type !== "keyDown") return;
  const key = String(input.key || "").toLowerCase();
  const ctrl = input.control || input.meta;
  if (key === "f12" || (ctrl && input.shift && key === "i")) {
    event.preventDefault();
    wc.toggleDevTools();
    return;
  }
  if (!pages || wc === win.webContents) {
    // The Hog UI gets its own keys; only add reload of the page view.
    if (wc === win.webContents && (key === "f5" || (ctrl && !input.shift && key === "r"))) {
      const page = pages && pages.activeContents();
      if (page) {
        event.preventDefault();
        page.reload();
      } else {
        event.preventDefault();
      }
    }
    return;
  }
  if (key === "f5" || (ctrl && key === "r")) {
    event.preventDefault();
    if (input.shift) wc.reloadIgnoringCache();
    else wc.reload();
    return;
  }
  if (input.alt && !ctrl && (key === "arrowleft" || key === "arrowright")) {
    event.preventDefault();
    if (key === "arrowleft" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (key === "arrowright" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    return;
  }
  if (!ctrl || input.alt || !FORWARD_KEYS.has(key)) return;
  if (key === "o" && !input.shift) return;
  event.preventDefault();
  if (FOCUS_CHROME_KEYS.has(key)) win.webContents.focus();
  const init = { key: input.key, ctrlKey: true, shiftKey: Boolean(input.shift), bubbles: true, cancelable: true };
  tellChrome(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))`);
}

// ---------------------------------------------------------------- dialogs

let dialogOpen = false;

async function pickOne(options) {
  if (dialogOpen || !win) return null;
  dialogOpen = true;
  try {
    const result = await dialog.showOpenDialog(win, options);
    return result.canceled ? null : result.filePaths;
  } finally {
    dialogOpen = false;
  }
}

function safePath(p) {
  return typeof p === "string" && p && !/[\n\r\0]/.test(p);
}

async function pickFilesRoot() {
  const picked = await pickOne({ title: "Add a folder to Files", defaultPath: os.homedir(), properties: ["openDirectory"] });
  if (picked && safePath(picked[0])) hook("__hogFilesRoot", picked[0]);
}

async function pickShareFolder() {
  const picked = await pickOne({ title: "Choose a folder to share with the phone", defaultPath: os.homedir(), properties: ["openDirectory"] });
  if (picked && safePath(picked[0])) onContainers(`containers:share-network:${picked[0]}`);
}

async function pickLibrary(kind) {
  const folders = kind === "folder";
  const picked = await pickOne({
    title: folders ? "Add a folder to the library" : "Add files to the library",
    defaultPath: os.homedir(),
    properties: folders ? ["openDirectory"] : ["openFile", "multiSelections"],
  });
  if (picked) receiveShareDrop(picked.map((p) => require("node:url").pathToFileURL(p).href));
}

function dropCopyNote(lines) {
  const names = lines
    .map((line) => {
      try {
        return decodeURIComponent(new URL(line).pathname).replace(/\/+$/, "").split("/").pop();
      } catch {
        return "";
      }
    })
    .filter((name) => name && name !== "." && name !== "..");
  if (names.length === 1) return `Adding ${names[0]}…`;
  if (names.length > 1) return `Adding ${names.length} files…`;
  return "Adding…";
}

function receiveShareDrop(uris) {
  const lines = [];
  for (const uri of uris) {
    const text = String(uri || "").trim();
    if (text.startsWith("file://") && text.length < 500 && !/[\n\r]/.test(text)) lines.push(text);
    if (lines.length >= 200) break;
  }
  if (!lines.length) {
    hook("__hogMediaNote", "Nothing was added. Choose files on this computer.");
    return;
  }
  hook("__hogMediaNote", dropCopyNote(lines).slice(0, 240));
  onContainers(`containers:share-drop:${lines.join("\n")}`);
}

const BOOKMARK_FILE_MAX = 20000000;

async function bookmarksImport() {
  const picked = await pickOne({
    title: "Import bookmarks (an HTML file from Brave, Chrome, or Firefox)",
    defaultPath: fs.existsSync(downloadsFolder()) ? downloadsFolder() : os.homedir(),
    properties: ["openFile"],
    filters: [{ name: "Bookmark files (*.html)", extensions: ["html", "htm", "HTML"] }, { name: "All files", extensions: ["*"] }],
  });
  if (!picked) return;
  const file = picked[0];
  try {
    const size = fs.statSync(file).size;
    if (size > BOOKMARK_FILE_MAX) return hook("__hogBookmarks", { kind: "import", ok: false, error: "That file is too large for a bookmarks file." });
    const text = fs.readFileSync(file, "utf8");
    hook("__hogBookmarks", { kind: "import", ok: true, text, name: path.basename(file) });
  } catch (error) {
    hook("__hogBookmarks", { kind: "import", ok: false, error: `Could not read that file: ${error.message}` });
  }
}

async function bookmarksExport(html) {
  if (dialogOpen || !win) return;
  dialogOpen = true;
  let result;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    result = await dialog.showSaveDialog(win, {
      title: "Export bookmarks",
      defaultPath: path.join(fs.existsSync(downloadsFolder()) ? downloadsFolder() : os.homedir(), `hog-bookmarks-${stamp}.html`),
    });
  } finally {
    dialogOpen = false;
  }
  if (!result || result.canceled || !result.filePath) return;
  let file = result.filePath;
  if (![".html", ".htm"].includes(path.extname(file).toLowerCase())) file += ".html";
  try {
    fs.writeFileSync(file, html, "utf8");
    hook("__hogBookmarks", { kind: "export", ok: true, path: file });
  } catch (error) {
    hook("__hogBookmarks", { kind: "export", ok: false, error: `Could not save: ${error.message}` });
  }
}

function onBookmarks(command) {
  const rest = command.slice("bookmarks:".length);
  const at = rest.indexOf(":");
  const action = at < 0 ? rest : rest.slice(0, at);
  const body = at < 0 ? "" : rest.slice(at + 1);
  if (action === "backup") {
    const file = path.join(PREVIEW_DATA, "bookmarks-v1-backup.json");
    if (!body || body.length > BOOKMARK_FILE_MAX || fs.existsSync(file)) return;
    try {
      fs.mkdirSync(PREVIEW_DATA, { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
    } catch {
      /* keep going */
    }
  } else if (action === "import") {
    bookmarksImport();
  } else if (action === "export") {
    bookmarksExport(body);
  }
}

// ---------------------------------------------------------------- containers (guard.py)

const CONTAINER_ACTIONS = new Set("list add remove start stop restart logs launch create run recreate engine engine-start shell shell-close commit modprobe endpoint tailscale-up share-list share-status share-computer share-network share-remove share-publish share-pick share-drop media-open media-mkdir media-remove media-pick media-pick-folder browser-default browser-default-set browser-default-clear jellyfin-gpu jellyfin-gpu-set jellyfin-gpu-clear jellyfin-gpu-install runtime-set network-list network-create network-remove network-connect network-disconnect update-status update-check update-check-now update-install update-restart samba-status samba-save samba-on samba-off".split(" "));

// The preview never installs the WebKit Hog's .deb or changes the default browser.
const PREVIEW_BLOCKED = {
  "update-install": "Update the installed Hog from Hog itself. The Chromium preview does not install packages.",
  "update-restart": "Restart the Chromium preview from your app menu.",
  "browser-default-set": "The Chromium preview does not change your default browser.",
  "browser-default-clear": "The Chromium preview does not change your default browser.",
};

function onContainers(command) {
  const first = command.indexOf(":");
  const second = command.indexOf(":", first + 1);
  const action = second < 0 ? command.slice(first + 1) : command.slice(first + 1, second);
  const rest = second < 0 ? "" : command.slice(second + 1);
  if (!CONTAINER_ACTIONS.has(action)) return;
  if (action === "share-pick") return void pickShareFolder();
  if (action === "media-pick") return void pickLibrary("files");
  if (action === "media-pick-folder") return void pickLibrary("folder");
  const hookName = action.startsWith("update-") ? "__hogUpdate" : action.startsWith("samba-") ? "__hogSamba" : "__hogContainers";
  if (PREVIEW_BLOCKED[action]) {
    hook(hookName, { ok: false, error: PREVIEW_BLOCKED[action], items: [] });
    return;
  }
  if (!guard) return;
  if (action === "media-open") guard.useLibrary(rest);
  let name = rest;
  let image = "";
  if (action === "create" || action === "runtime-set") {
    const at = rest.indexOf(":");
    name = at < 0 ? rest : rest.slice(0, at);
    image = at < 0 ? "" : rest.slice(at + 1);
  } else if (action === "run" || action === "recreate") {
    const at = rest.indexOf(":");
    const maybe = at < 0 ? rest : rest.slice(0, at);
    const cmd = at < 0 ? "" : rest.slice(at + 1);
    if ((maybe === "engine" || maybe === "desktop") && cmd.startsWith("docker ")) {
      name = cmd;
      image = maybe;
    }
  }
  const emit = (payload) => hook(hookName, payload);
  guard.handle(action, name, image, emit, emit);
}

// ---------------------------------------------------------------- window

function onWindowMessage(command) {
  if (typeof command !== "string" || command.length > 2_000_000) return;
  if (pages && pages.command(command)) return;
  if (command === "pill:hide" || command.startsWith("pill:")) return; // labels are drawn in the page grips
  if (command.startsWith("edges:")) {
    if (!pages) return;
    const paint = policy.parseEdges(command, pages.place.top);
    if (paint) {
      pages.gripPaint = paint;
      pages.repaint();
    }
    return;
  }
  if (command.startsWith("open:")) {
    const url = policy.allowedTailscaleOpenUrl(command.slice(5));
    if (url && pages) pages.tell({ event: "popup", url, isolated: false });
    return;
  }
  if (command.startsWith("drop-box:")) return; // drops are read in chrome-preload.js
  if (command.startsWith("containers:")) return onContainers(command);
  if (command.startsWith("bookmarks:")) return onBookmarks(command);
  if (command === "files:pick-root") return void pickFilesRoot();
  if (command.startsWith("dapp-reply:")) return pages && pages.deliverDappReply(command.slice("dapp-reply:".length));
  if (command.startsWith("dapp-emit:")) return pages && pages.deliverDappEmit(command.slice("dapp-emit:".length));
  if (command === "menu:hide") return pages && pages.paintMenu(null);
  if (command.startsWith("menu:")) return pages && pages.paintMenu(command.slice(5));
  if (command === "close") return win && win.close();
  if (command === "min") return win && win.minimize();
  if (command === "max") {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return;
  }
  // "grip:" (move handle) is a CSS drag region here; nothing to do.
}

function openExternalUrl(raw) {
  const url = policy.allowedBrowserOpenUrl(raw);
  if (!url) return;
  if (pages && chromeReady) {
    pages.tell({ event: "popup", url, isolated: false });
    return;
  }
  if (!pendingUrls.includes(url) && pendingUrls.length < 20) pendingUrls.push(url);
}

function urlsFromArgv(argv) {
  return argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg));
}

const CHROME_CSS = `
#win-drag { -webkit-app-region: drag; cursor: grab; }
#winctl, #winctl button { -webkit-app-region: no-drag; }
.resize-frame { display: none !important; }
`;

function createWindow() {
  const chromeSession = session.fromPartition(CHROME_PARTITION);
  prepareChromeSession(chromeSession);
  const icon = iconPath();
  win = new BrowserWindow({
    title: "Hog",
    width: 1180,
    height: 760,
    minWidth: 480,
    minHeight: 320,
    frame: false,
    backgroundColor: "#0b0b0d",
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    show: false,
    webPreferences: {
      partition: CHROME_PARTITION,
      preload: path.join(__dirname, "chrome-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false, // the node tab keeps syncing while hidden
    },
  });
  pages = new PageHost();
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    const target = policy.allowedBrowserOpenUrl(url);
    if (target && !isOwnUrl(target)) pages.tell({ event: "popup", url: target, isolated: false });
    return { action: "deny" };
  });
  wc.on("will-navigate", (event) => {
    if (!isOwnUrl(event.url)) event.preventDefault();
  });
  wc.on("dom-ready", () => wc.insertCSS(CHROME_CSS).catch(() => {}));
  wc.on("did-finish-load", () => {
    log(`Hog preview is open at ${server.url}`);
    chromeReady = true;
    for (const url of pendingUrls.splice(0)) pages.tell({ event: "popup", url, isolated: false });
  });
  wc.on("render-process-gone", (_event, details) => {
    log(`Hog preview: the Hog UI page process stopped (${details.reason}); reloading it.`);
    chromeReady = false;
    setTimeout(() => !win.isDestroyed() && wc.loadURL(server.url), 500);
  });
  wc.on("before-input-event", (event, input) => onShortcutInput(event, input, wc));
  win.on("resize", () => pages.layout());
  win.on("maximize", () => pages.layout());
  win.on("unmaximize", () => pages.layout());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });
  wc.loadURL(server.url);
}

// Messages come only from our own preloads; check the sender anyway.
ipcMain.on("hogwin", (event, command) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  onWindowMessage(String(command));
});
ipcMain.on("hog:share-drop", (event, paths) => {
  if (!win || event.sender !== win.webContents || !Array.isArray(paths)) return;
  const { pathToFileURL } = require("node:url");
  receiveShareDrop(paths.filter(safePath).slice(0, 200).map((p) => pathToFileURL(p).href));
});
ipcMain.on("hogedge", (event, command) => {
  if (!pages || event.senderFrame !== event.sender.mainFrame) return;
  pages.onEdgeMessage(event.sender, String(command));
});
ipcMain.on("hog:gesture", (event) => {
  if (process.env.HOG_PREVIEW_DEBUG) log(`gesture from ${event.sender.id}`);
  if (pages) pages.gestures.set(event.sender.id, Date.now());
});
ipcMain.on("hog:page-scripts", (event, href) => {
  const scripts = [];
  if (EDGE_GRIP_SCRIPT) scripts.push(EDGE_GRIP_SCRIPT);
  if (DAPP_PROVIDER_SCRIPT && policy.dappProviderAllowed(href)) scripts.push(DAPP_PROVIDER_SCRIPT);
  event.returnValue = scripts;
});

// ---------------------------------------------------------------- lifecycle

/** Is the GTK Hog (python3 /opt/hog-browser/hog or ./hog) running as this user? */
function webkitHogRunning() {
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (argv.length >= 2 && /python3?$/.test(path.basename(argv[0])) && path.basename(argv[1]) === "hog") return true;
      if (argv.length >= 1 && argv[0] === "/usr/bin/hog-browser") return true;
    } catch {
      /* gone or not ours */
    }
  }
  return false;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    for (const url of urlsFromArgv(argv)) openExternalUrl(url);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      await server.ensure();
    } catch (error) {
      dialog.showErrorBox(APP_NAME, String(error.message || error));
      app.quit();
      return;
    }
    fs.mkdirSync(HOG_DATA, { recursive: true });
    guard = new GuardBridge({ root: ROOT, dataDir: HOG_DATA, origin: `http://127.0.0.1:${server.port}`, log });
    for (const url of urlsFromArgv(process.argv)) openExternalUrl(url);
    createWindow();
    loadBlocker();
    // If the WebKit Hog owned the server and quits, start our own and reload.
    setInterval(async () => {
      if (!win || server.child) return;
      if (await server.alive()) return;
      log("Hog preview: Hog's server went away; starting this app's own copy.");
      try {
        await server.ensure();
        chromeReady = false;
        win.webContents.loadURL(server.url);
      } catch (error) {
        log(`Hog preview: could not restart the server: ${error.message}`);
      }
    }, 5000).unref();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    // The WebKit Hog may have attached to the server this app started. Leave
    // it running for that window instead of pulling it out from under it.
    if (server.child && webkitHogRunning()) {
      log("Hog preview: the WebKit Hog is using this server; leaving it running.");
      server.child.unref();
      server.child = null;
    }
    server.stop();
    if (guard) guard.stop();
  });
}
