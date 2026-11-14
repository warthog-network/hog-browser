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
  clipboard,
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
const geometry = require("./lib/overlay-geometry");
const contextMenu = require("./lib/context-menu");
const cookies = require("./lib/cookies");
const { PreviewSettings, SitePermissions } = require("./lib/preview-settings");
const webkitImport = require("./lib/webkit-import");
const previewUpdate = require("./lib/preview-update");
const { DefaultBrowser } = require("./lib/default-browser");
const geolocation = require("./lib/geolocation");
const { LogBuffer } = require("./lib/log-buffer");
const { createTerminalPanel } = require("./lib/terminal-panel");
const layout = require("./lib/terminal-layout");

const APP_NAME = "Hog (Chromium preview)";
const HOG_DATA = process.env.HOG_DATA || path.join(os.homedir(), ".local", "share", "hog-browser");
// The preview's own browser profile (cookies, wallet localStorage, node chain,
// history). Never the WebKit Hog's ~/.local/share/hog-browser/pages.
const PREVIEW_DATA =
  process.env.HOG_PREVIEW_DATA ||
  (process.platform === "win32" ? path.join(app.getPath("appData"), "hog-chromium-preview") : path.join(os.homedir(), ".local", "share", "hog-chromium-preview"));
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

const appLogs = new LogBuffer();

function log(text) {
  process.stderr.write(`${text}\n`);
  appLogs.append(text);
}

const server = new HogServer({ root: ROOT, log, logs: appLogs });
let guard = null;
let win = null;
let pages = null;
let overlays = null;
const previewSettings = new PreviewSettings(PREVIEW_DATA);
const sitePermissions = new SitePermissions(PREVIEW_DATA);
let findBar = null;
let termPanel = null;
let lastTermToggle = 0;
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

  /** A file Hog wrote itself (print to PDF): same toast, "Show in folder" works. */
  async saveFile(name, data) {
    const id = String(this.nextId++);
    const entry = { item: null, name, path: "", done: true, shown: 1 };
    this.items.set(id, entry);
    try {
      const folder = downloadsFolder();
      fs.mkdirSync(folder, { recursive: true });
      entry.path = policy.uniqueDownloadPath(folder, policy.downloadName(name), this.takenPaths());
      entry.name = path.basename(entry.path);
      await fsp.writeFile(entry.path, data, { flag: "wx" });
      this.emit(id, "done", { progress: 1, received: data.length });
    } catch (error) {
      this.emit(id, "failed", { error: `Could not save it: ${error.message}` });
    }
  }

  /** A file Hog saved itself (Save page as): show the usual "done" toast. */
  notifySaved(filePath) {
    const id = String(this.nextId++);
    const entry = { item: null, name: path.basename(filePath), path: filePath, done: true, shown: 1 };
    this.items.set(id, entry);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    this.emit(id, "done", { progress: 1, received: size });
  }

  command(command) {
    const parts = command.split(":");
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) return;
    const entry = this.items.get(parts[2]);
    if (!entry) return;
    if (parts[1] === "cancel" && !entry.done && entry.item) entry.item.cancel();
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

function topUrlOf(details) {
  try {
    if (details.frame && details.frame.top) return details.frame.top.url;
  } catch {
    /* frame gone */
  }
  try {
    return details.webContents ? details.webContents.getURL() : "";
  } catch {
    return "";
  }
}

function thirdPartyRequest(details) {
  if (!previewSettings || !previewSettings.get("blockThirdPartyCookies")) return false;
  return cookies.isThirdParty(details.url, topUrlOf(details), details.resourceType);
}

const ASKED_PERMISSIONS = {
  notifications: { title: "Notifications", what: () => "show notifications" },
  geolocation: { title: "Location", what: () => "know your location" },
  media: { title: "Camera and microphone", what: (kinds) => `use your ${kinds.join(" and ").replace("audio", "microphone").replace("video", "camera") || "camera or microphone"}` },
};

const isoPermissionStores = new WeakMap();
/** Remembered answers for a session: the saved store, or memory for Iso tabs. */
function permissionStore(ses) {
  if (ses.isPersistent()) return sitePermissions;
  if (!isoPermissionStores.has(ses)) isoPermissionStores.set(ses, new SitePermissions(null));
  return isoPermissionStores.get(ses);
}

function askPermission(store, permission, origin, mediaTypes, persistent) {
  const key = SitePermissions.key(origin, permission, mediaTypes);
  const known = store.lookup(key);
  if (known !== undefined) return Promise.resolve(known);
  const info = ASKED_PERMISSIONS[permission];
  return dialog
    .showMessageBox(win, {
      type: "question",
      buttons: ["Block", "Allow"],
      defaultId: 0,
      cancelId: 0,
      title: info.title,
      message: `${origin} wants to ${info.what(mediaTypes)}.`,
      checkboxLabel: persistent ? "Remember for this site" : undefined,
      checkboxChecked: persistent,
      detail: persistent ? "You can forget remembered answers in Settings → General." : "This is an Iso tab: Hog forgets the answer when the tab closes.",
    })
    .then(({ response, checkboxChecked }) => {
      const allow = response === 1;
      store.answer(key, allow, persistent && checkboxChecked);
      if (persistent && checkboxChecked) sendPreviewState();
      return allow;
    })
    .catch(() => false);
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
  // Third-party cookies are blocked like WebKit Hog does (Settings -> General).
  ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    let headers = { ...details.requestHeaders, "Sec-GPC": "1" };
    if (thirdPartyRequest(details)) headers = cookies.stripHeader(headers, "Cookie").headers;
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    let changed = null;
    if (details.responseHeaders && thirdPartyRequest(details)) {
      const { headers, removed } = cookies.stripHeader(details.responseHeaders, "Set-Cookie");
      if (removed) changed = headers;
    }
    const next = changed ? { ...details, responseHeaders: changed } : details;
    const done = (result) => callback(result && result.responseHeaders ? result : changed ? { responseHeaders: changed } : result || {});
    if (blocker) return blocker.onHeadersReceived(next, done);
    return done({});
  });
  ses.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "frame-preload.js") });
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
  const persistent = ses.isPersistent();
  const isoAnswers = permissionStore(ses);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const always = ["fullscreen", "clipboard-sanitized-write", "pointerLock", "window-management"];
    if (always.includes(permission)) return callback(true);
    if (!ASKED_PERMISSIONS[permission]) return callback(false);
    const origin = policy.pageOrigin(details.requestingUrl || wc.getURL(), ports());
    if (!origin) return callback(false);
    const mediaTypes = permission === "media" ? (details.mediaTypes || []).filter((t) => t === "audio" || t === "video") : [];
    const store = persistent ? sitePermissions : isoAnswers;
    askPermission(store, permission, origin, mediaTypes, persistent).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (["fullscreen", "clipboard-sanitized-write", "pointerLock"].includes(permission)) return true;
    if (!ASKED_PERMISSIONS[permission]) return false;
    const origin = policy.pageOrigin(requestingOrigin, ports());
    if (!origin) return false;
    const store = persistent ? sitePermissions : isoAnswers;
    const kinds = permission === "media" && details && details.mediaType ? [details.mediaType] : [];
    return store.allows(origin, permission, kinds);
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
    this.suspended = false;
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
        // Preloads also run in iframes (still sandboxed, no Node): frame-preload.js
        // blocks script cookies in third-party frames, clicks there count as gestures.
        nodeIntegrationInSubFrames: true,
      },
    });
    view.setBackgroundColor(PAGE_BG);
    view.setVisible(false);
    const wc = view.webContents;
    preparePageSession(wc.session);
    const entry = { view, isolated: Boolean(isolated), failed: false };
    this.views.set(tabId, entry);
    this.byContents.set(wc.id, tabId);
    win.contentView.addChildView(view);
    if (termPanel) termPanel.raise();
    if (overlays) overlays.raise();

    wc.setWindowOpenHandler((details) => {
      const decision = policy.popupDecision(details, { allowed: policy.pageAllowed(details.url, ports()), gesture: this.recentGesture(wc.id) });
      if (process.env.HOG_PREVIEW_DEBUG) log(`popup ${details.url} ${details.disposition} gesture=${this.recentGesture(wc.id)} -> ${decision.kind}`);
      // A click may open a new tab, or a sign-in popup window that keeps
      // window.opener (OAuth). A page may not open either by itself.
      if (decision.kind === "tab") this.tell({ event: "popup", url: details.url, isolated: entry.isolated });
      if (decision.kind === "window") return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: popupWindowOptions(decision) };
      return { action: "deny" };
    });
    wc.on("did-create-window", (child) => preparePopupWindow(child, entry));
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
    wc.on("context-menu", (_event, params) => showContextMenu(wc, params, true));
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
      this.repaint();
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
    const bounds = policy.edgeInset(this.pageBounds(), this.gripPaint);
    for (const [tabId, entry] of this.views) {
      if (this.fullTab === tabId) {
        entry.view.setBounds({ x: 0, y: 0, width, height });
      } else {
        entry.view.setBounds(bounds);
      }
    }
    if (termPanel && this.fullTab) termPanel.view && termPanel.view.setVisible(false);
    else if (termPanel) termPanel.layout();
    if (overlays) overlays.raise();
    this.repaint();
  }

  placeView(place) {
    this.place = place;
    this.layout();
    const tabId = String(place.tabId || "");
    if (!place.show || !this.views.has(tabId)) {
      for (const entry of this.views.values()) entry.view.setVisible(false);
      this.shown = null;
      this.repaint();
      return;
    }
    for (const [id, entry] of this.views) entry.view.setVisible(id === tabId && !this.suspended);
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

  // Grips and menus are drawn by the overlay views above the page, not
  // inside the page (YouTube's Trusted Types and stacking broke that).
  repaint() {
    if (overlays) overlays.sync();
  }

  pageBounds() {
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    const [width, height] = win.getContentSize();
    const reserved = this.fullTab ? 0 : (termPanel ? termPanel.reservedHeight() : 0);
    return layout.panelInset(policy.viewBounds(this.place, width, height), reserved);
  }

  /** Show or hide the live page under a still picture while a Hog panel
   *  (shields, network menu, narrow-window wallet) covers the page area. */
  setSuspended(on) {
    on = Boolean(on);
    if (this.suspended === on) return;
    this.suspended = on;
    const entry = this.shown ? this.views.get(this.shown) : null;
    if (entry) entry.view.setVisible(!on);
    if (!on) entry?.view.webContents.focus();
  }

  onEdgeMessage(wc, command) {
    const tabId = this.tabFor(wc);
    if (!tabId || tabId !== this.shown || typeof command !== "string") return;
    // Pages only speak the dapp provider. Grips and menus live in the
    // overlay views now, so a site cannot click Hog's menus for the user.
    if (command.startsWith("dapp:")) return this.onDappRequest(wc, tabId, command.slice(5));
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

function toggleTerminalPanel() {
  const now = Date.now();
  if (now - lastTermToggle < 200) return;
  lastTermToggle = now;
  if (termPanel) termPanel.toggleFromUser();
  if (pages) pages.layout();
}

function installAppMenu() {
  const template = [
    {
      label: "View",
      submenu: [
        { label: "Toggle Terminal", accelerator: "Ctrl+`", click: () => toggleTerminalPanel() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (win && !win.isDestroyed()) {
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);
  }
}

function onShortcutInput(event, input, wc) {
  if (input.type !== "keyDown") return;
  const key = String(input.key || "").toLowerCase();
  const ctrl = input.control || input.meta;
  const backquote = input.code === "Backquote" || key === "`" || key === "backquote";
  if (ctrl && !input.alt && !input.shift && backquote) {
    event.preventDefault();
    toggleTerminalPanel();
    return;
  }
  if (termPanel && termPanel.isContents(wc)) {
    if (key === "f12" || (ctrl && input.shift && key === "i")) {
      event.preventDefault();
      wc.toggleDevTools();
    }
    return;
  }
  if (key === "f12" || (ctrl && input.shift && key === "i")) {
    event.preventDefault();
    wc.toggleDevTools();
    return;
  }
  // Find in page and print act on the shown page from anywhere in the window.
  const shownPage = pages && pages.activeContents();
  if (shownPage && !pages.fullTab) {
    if (ctrl && !input.alt && key === "f") {
      event.preventDefault();
      findBar.show(shownPage);
      return;
    }
    if ((key === "f3" || (ctrl && key === "g")) && findBar.open) {
      event.preventDefault();
      findBar.find(findBar.text, !input.shift, true);
      return;
    }
    if (ctrl && !input.alt && !input.shift && key === "p") {
      event.preventDefault();
      printPage(shownPage);
      return;
    }
    if (ctrl && !input.alt && !input.shift && key === "s") {
      event.preventDefault();
      savePageAs(shownPage);
      return;
    }
    if (key === "escape" && findBar.open && wc === shownPage) {
      findBar.close(true);
      return;
    }
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

// The default-browser buttons point at the preview's own .desktop file
// (lib/default-browser.js). Update actions are handled below: they must
// not reach guard.py, which checks releases/latest (the WebKit Hog).
function onContainers(command) {
  const first = command.indexOf(":");
  const second = command.indexOf(":", first + 1);
  const action = second < 0 ? command.slice(first + 1) : command.slice(first + 1, second);
  const rest = second < 0 ? "" : command.slice(second + 1);
  if (!CONTAINER_ACTIONS.has(action)) return;
  if (action === "share-pick") return void pickShareFolder();
  if (action === "media-pick") return void pickLibrary("files");
  if (action === "media-pick-folder") return void pickLibrary("folder");
  if (action.startsWith("update-")) return void onPreviewUpdateAction(action);
  const hookName = action.startsWith("samba-") ? "__hogSamba" : "__hogContainers";
  if (action.startsWith("browser-default")) {
    const job = action === "browser-default-set" ? defaultBrowser.set() : action === "browser-default-clear" ? defaultBrowser.clear() : defaultBrowser.status();
    job.then((payload) => hook(hookName, payload), (error) => hook(hookName, { ok: false, error: error.message }));
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
  if (command === "pill:hide" || command.startsWith("pill:")) return overlays && overlays.setPill(command === "pill:hide" ? null : command);
  if (command.startsWith("edges:")) {
    if (!pages) return;
    const paint = policy.parseEdges(command, pages.place.top);
    if (paint && !(overlays && overlays.dragging)) {
      pages.gripPaint = paint;
      pages.layout(); // rail lines change the page inset; layout() repaints
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
  // "menu:" copies are not needed: chrome-preload.js sends the real menus.
  if (command.startsWith("menu:")) return;
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
/* The top bar's empty space moves the window too (like a title bar);
   everything clickable in it, and the menus that hang from it, stay clicks. */
header.chrome { -webkit-app-region: drag; }
header.chrome * { -webkit-app-region: no-drag; }
header.chrome #win-drag, header.chrome #bookmarks { -webkit-app-region: drag; }
header.chrome #bookmarks * { -webkit-app-region: no-drag; }
#winctl, #winctl button { -webkit-app-region: no-drag; }
.resize-frame { display: none !important; }
`;

// ---------------------------------------------------------------- overlays
// Hog's menus and page-edge grips are drawn in transparent WebContentsViews
// stacked above every page view, so no site (YouTube, video players,
// Trusted Types pages, z-index games) can cover them. They have bounds only
// where something is drawn, so the rest of the page keeps its own input.
// Hog panels that cannot be copied (shields, network list, the narrow-window
// wallet) get a still picture of the page under them while they are open.

const OVERLAY_PARTITION = "hog-overlay"; // in memory
const SNAPSHOT_CSS = `
.view.hog-snap { isolation: isolate; }
#hog-page-snapshot { position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: fill; z-index: 50; user-select: none; -webkit-user-drag: none; }
`;

function snapshotScript(url) {
  return `(function (u) {
    var v = document.getElementById("view");
    if (!v) return;
    var i = document.getElementById("hog-page-snapshot");
    if (!u) { if (i) i.remove(); v.classList.remove("hog-snap"); return; }
    if (!i) { i = document.createElement("img"); i.id = "hog-page-snapshot"; i.alt = ""; i.draggable = false; v.prepend(i); }
    i.src = u;
    v.classList.add("hog-snap");
    var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); };
    return (i.decode ? i.decode() : Promise.resolve()).catch(function () {}).then(frame);
  })(${JSON.stringify(url)})`;
}

function prepareOverlaySession(ses) {
  const local = (url) => {
    try {
      return url.startsWith("file:") || url.startsWith("devtools:") || isOwnUrl(url);
    } catch {
      return false;
    }
  };
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !local(details.url) }));
  // Hog's fonts are cross-origin from file://; let the overlay use them.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "access-control-allow-origin") delete headers[key];
    headers["Access-Control-Allow-Origin"] = ["*"];
    callback({ responseHeaders: headers });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

class Overlays {
  constructor() {
    prepareOverlaySession(session.fromPartition(OVERLAY_PARTITION));
    this.surface = { menus: [], toasts: [], cover: false, css: [] };
    this.sent = new Map();
    this.dragging = null;
    this.dragTop = 0;
    this.pill = null; // { x, y, w, h, side, label } in window coordinates
    this.snapWant = false;
    this.snapTab = null;
    this.snapToken = 0;
    this.grips = { tabs: this.make("grip", "tabs"), wallet: this.make("grip", "wallet") };
    this.pillView = this.make("pill");
    this.toastView = this.make("toasts");
    this.menu = this.make("menu");
  }

  make(mode, side) {
    const view = new WebContentsView({
      webPreferences: {
        partition: OVERLAY_PARTITION,
        preload: path.join(__dirname, "overlay-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.ready = false;
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("before-input-event", (event, input) => onShortcutInput(event, input, wc));
    wc.on("did-finish-load", () => {
      view.ready = true;
      this.sent.delete(view);
      this.sync();
    });
    wc.on("render-process-gone", () => {
      view.ready = false;
      setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
    });
    wc.loadFile(path.join(__dirname, "overlay.html"), { query: side ? { mode, side } : { mode } }).catch(() => {});
    win.contentView.addChildView(view);
    return view;
  }

  views() {
    return [this.grips.tabs, this.grips.wallet, this.pillView, this.toastView, this.menu];
  }

  /** Keep the overlays above every page view (addChildView re-orders). */
  raise() {
    for (const view of this.views()) win.contentView.addChildView(view);
    if (findBar) findBar.raise();
  }

  setSurface(raw) {
    this.surface = geometry.cleanSurface(raw);
    this.sync();
  }

  setPill(raw) {
    this.pill = geometry.parsePill(raw);
    this.sync();
  }

  send(view, state) {
    const key = JSON.stringify(state);
    if (this.sent.get(view) === key) return;
    this.sent.set(view, key);
    view.webContents.executeJavaScript(`window.__hogOverlay && window.__hogOverlay(${key})`, false).catch(() => {});
  }

  hide(view) {
    if (view.getVisible()) view.setVisible(false);
  }

  showCopies(view, items, extra) {
    const [width, height] = win.getContentSize();
    const bounds = geometry.menuBounds(items.map((m) => m.rect), width, height);
    view.setBounds(bounds);
    const { css, htmlClass, bodyClass, theme } = this.surface;
    this.send(view, { menus: items, css, htmlClass, bodyClass, theme, origin: { x: bounds.x, y: bounds.y }, ...extra });
    if (!view.getVisible()) view.setVisible(true);
  }

  sync() {
    if (!win || win.isDestroyed() || !pages) return;
    if (findBar) findBar.sync();
    const page = pages.pageBounds();
    const live = Boolean(pages.shown) && !pages.fullTab && page.width > 0 && page.height > 0;
    const cover = live && this.surface.cover;
    this.snapshot(cover);
    const active = live && !cover;
    if (process.env.HOG_PREVIEW_DEBUG) {
      const key = `${live}:${cover}:${this.surface.menus.length}:${this.surface.toasts.length}:${JSON.stringify(pages.gripPaint)}`;
      if (key !== this.debugKey) log(`overlays live=${live} cover=${cover} menus=${this.surface.menus.length} toasts=${this.surface.toasts.length} grips=${JSON.stringify(pages.gripPaint)}`);
      this.debugKey = key;
    }

    const menus = active ? this.surface.menus : [];
    if (menus.length && this.menu.ready) this.showCopies(this.menu, menus);
    else this.hide(this.menu);

    // Toasts stay up over the page even while a Hog panel covers it.
    const toasts = live ? this.surface.toasts : [];
    if (toasts.length && this.toastView.ready) this.showCopies(this.toastView, toasts);
    else this.hide(this.toastView);

    const paint = pages.gripPaint;
    for (const side of ["tabs", "wallet"]) {
      const view = this.grips[side];
      if (!(active && paint && paint[side] && view.ready)) {
        this.hide(view);
        if (this.dragging === side) this.dragging = null;
        continue;
      }
      const top = this.dragging === side ? this.dragTop : paint[`${side}Top`];
      const bounds = geometry.gripBounds(side, page, top, false);
      view.setBounds(bounds);
      this.send(view, { top: bounds.top });
      if (!view.getVisible()) view.setVisible(true);
    }

    const pill = active && this.pillView.ready ? this.pill : null;
    if (pill) {
      this.pillView.setBounds({ x: pill.x, y: pill.y, width: pill.w, height: pill.h });
      this.send(this.pillView, { side: pill.side, label: pill.label });
      if (!this.pillView.getVisible()) this.pillView.setVisible(true);
    } else {
      this.hide(this.pillView);
    }
  }

  async snapshot(on) {
    if (on && this.snapWant && this.snapTab !== pages.shown) this.snapWant = false; // tab changed under a panel
    if (on === this.snapWant) return;
    this.snapWant = on;
    const token = ++this.snapToken;
    if (!on) {
      this.snapTab = null;
      pages.setSuspended(false);
      tellChrome(snapshotScript(null));
      return;
    }
    const tabId = pages.shown;
    this.snapTab = tabId;
    const entry = pages.views.get(tabId);
    let url = null;
    if (entry && !pages.suspended) {
      try {
        const image = await entry.view.webContents.capturePage();
        if (!image.isEmpty()) url = `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
      } catch {
        /* blank under the panel */
      }
    }
    if (token !== this.snapToken || !win || win.isDestroyed()) return;
    if (url) {
      await win.webContents.executeJavaScript(snapshotScript(url), false).catch(() => {});
      if (token !== this.snapToken) return;
    }
    pages.setSuspended(true);
  }

  /** A click on the shown page closes Hog menus, like a click outside them. */
  onPageGesture() {
    if (this.surface.menus.length) tellChrome("window.__hogMenuDismiss && window.__hogMenuDismiss()");
  }

  onMessage(wc, message) {
    if (typeof message !== "string") return;
    const parts = message.split(":");
    if (wc === this.menu.webContents) {
      if (parts[0] === "menu" && this.menu.getVisible()) pages.onMenuMessage(parts);
      return;
    }
    if (wc === this.toastView.webContents) {
      // menu:toasts:<button index> -> click that button in the Hog UI's toasts.
      const index = Number.parseInt(parts[2], 10);
      if (parts[0] === "menu" && parts[1] === "toasts" && parts.length === 3 && index >= 0 && index < 50 && this.toastView.getVisible()) {
        tellChrome(`(function(){var b=document.querySelectorAll('#hog-toasts button')[${index}]; if (b && !b.disabled && !b.hidden) b.click();})()`);
      }
      return;
    }
    if (wc === this.pillView.webContents) {
      if (!this.pillView.getVisible() || !this.pill) return;
      const side = this.pill.side;
      if (message === "enter") tellChrome("window.__hogPillHold && window.__hogPillHold()");
      else if (message === "leave") {
        this.pill = null;
        this.sync();
        tellChrome("window.__hogPillHide && window.__hogPillHide()");
      } else if (message === "click") {
        this.pill = null;
        this.sync();
        tellChrome(`window.__hogPillHide && window.__hogPillHide(); document.getElementById('${side === "wallet" ? "wallet-edge" : "tabs-edge"}').click()`);
      }
      return;
    }
    const side = wc === this.grips.tabs.webContents ? "tabs" : wc === this.grips.wallet.webContents ? "wallet" : null;
    if (!side || parts[1] !== side || !this.grips[side].getVisible()) return;
    // Same protocol as the WebKit shell's EdgeSpot widgets (__hogSpot*).
    const kind = parts[0];
    if ((kind === "in" || kind === "out" || kind === "down") && parts.length === 2) {
      const name = { in: "__hogSpotIn", out: "__hogSpotOut", down: "__hogSpotDown" }[kind];
      tellChrome(`window.${name} && window.${name}('${side}')`);
    } else if (kind === "move" && parts.length === 3) {
      const top = Number.parseInt(parts[2], 10);
      if (!Number.isFinite(top) || top < -200 || top > 10000) return;
      const page = pages.pageBounds();
      this.dragging = side;
      this.dragTop = geometry.gripBounds(side, page, top, false).top;
      this.sync();
      tellChrome(`window.__hogSpotSlide && window.__hogSpotSlide('${side}', ${page.y + this.dragTop})`);
    } else if (kind === "up" && parts.length === 3) {
      const moved = parts[2] === "1";
      if (moved && pages.gripPaint) pages.gripPaint[`${side}Top`] = this.dragTop;
      this.dragging = null;
      tellChrome(`window.__hogSpotUp && window.__hogSpotUp('${side}', ${moved ? 1 : 0})`);
      this.sync();
    }
  }
}

// ---------------------------------------------------------------- find in page, print, right-click

class FindBar {
  constructor() {
    this.view = overlays.make("find");
    this.target = null; // page webContents being searched
    this.text = "";
    this.state = { matches: null, active: 0 };
    this.onFound = (_event, result) => {
      if (!result || !this.target) return;
      this.state = { matches: result.matches, active: result.activeMatchOrdinal };
      this.push(false);
    };
  }

  raise() {
    win.contentView.addChildView(this.view);
  }

  get open() {
    return Boolean(this.target);
  }

  push(focus) {
    overlays.sent.delete(this.view);
    overlays.send(this.view, { ...this.state, focus, text: focus ? this.text : undefined, n: Date.now() });
  }

  place() {
    if (!this.target) return;
    const page = pages.pageBounds();
    const width = Math.min(380, Math.max(220, page.width - 24));
    this.view.setBounds({ x: page.x + page.width - width - 12, y: page.y + 8, width, height: 46 });
  }

  show(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (this.target !== wc) {
      this.close(false);
      this.target = wc;
      wc.on("found-in-page", this.onFound);
    }
    this.place();
    this.raise();
    this.view.setVisible(true);
    this.view.webContents.focus();
    this.push(true);
  }

  find(text, forward = true, findNext = false) {
    if (!this.target || this.target.isDestroyed()) return;
    this.text = text;
    if (!text) {
      this.target.stopFindInPage("clearSelection");
      this.state = { matches: null, active: 0 };
      this.push(false);
      return;
    }
    this.target.findInPage(text, { forward, findNext });
  }

  close(focusPage = true) {
    const wc = this.target;
    this.target = null;
    this.view.setVisible(false);
    this.state = { matches: null, active: 0 };
    if (!wc || wc.isDestroyed()) return;
    wc.removeListener("found-in-page", this.onFound);
    wc.stopFindInPage("keepSelection");
    if (focusPage) wc.focus();
  }

  /** Called on layout or tab changes. */
  sync() {
    if (!this.target) return;
    const shown = pages.activeContents();
    if (!shown || shown !== this.target || pages.fullTab) return this.close(false);
    this.place();
  }

  onMessage(message) {
    if (typeof message !== "string" || !this.target) return;
    if (message.startsWith("find:")) return this.find(message.slice(5), true, false);
    if (message === "next") return this.find(this.text, true, true);
    if (message === "prev") return this.find(this.text, false, true);
    if (message === "close") return this.close(true);
  }
}

function printPage(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.print({ silent: false, printBackground: true }, (ok, reason) => {
    if (ok || !reason || /cancel/i.test(reason)) return;
    log(`Hog preview: print failed (${reason}); saving a PDF instead.`);
    // No printer set up (or no CUPS): save the page as a PDF in Downloads.
    const title = (wc.getTitle() || "page").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "page";
    wc.printToPDF({ printBackground: true })
      .then((data) => pages.downloads.saveFile(`${title}.pdf`, data))
      .catch((error) => log(`Hog preview: PDF failed (${error.message}).`));
  });
}

// ---------------------------------------------------------------- sign-in popups

function popupWindowOptions(decision) {
  return {
    parent: win || undefined,
    width: decision.width,
    height: decision.height,
    minWidth: 320,
    minHeight: 240,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    title: "Sign-in window",
    webPreferences: {
      // The opener's session and partition are kept by Electron; these
      // only make sure the popup is locked down like a tab.
      preload: path.join(__dirname, "page-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      safeDialogs: true,
      navigateOnDragDrop: false,
      nodeIntegrationInSubFrames: true,
    },
  };
}

/** A popup window (OAuth sign-in): no menus, the site's address in the title,
 *  same navigation rules as tabs, popups of its own become tabs. */
function preparePopupWindow(child, opener) {
  child.setMenuBarVisibility(false);
  const wc = child.webContents;
  const showTitle = () => {
    if (child.isDestroyed()) return;
    let host = "";
    try {
      host = new URL(wc.getURL()).host;
    } catch {
      host = "";
    }
    const title = wc.getTitle();
    child.setTitle(host ? `${host}${title && title !== wc.getURL() ? ` — ${title}` : ""}` : "Sign-in window");
  };
  wc.on("page-title-updated", (event) => {
    event.preventDefault();
    showTitle();
  });
  wc.on("did-navigate", showTitle);
  const guardNav = (event, url) => {
    if (policy.pageAllowed(url, ports()) || policy.inPageNavigation(url)) return;
    event.preventDefault();
  };
  wc.on("will-navigate", (event) => guardNav(event, event.url));
  wc.on("will-redirect", (event) => event.isMainFrame && guardNav(event, event.url));
  wc.setWindowOpenHandler(({ url }) => {
    if (policy.pageAllowed(url, ports()) && pages && pages.recentGesture(wc.id)) pages.tell({ event: "popup", url, isolated: opener.isolated });
    return { action: "deny" };
  });
  wc.on("context-menu", (_event, params) => showContextMenu(wc, params, true));
  wc.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.control || input.meta) && String(input.key).toLowerCase() === "w") {
      event.preventDefault();
      child.close();
    }
  });
}

/** Ctrl+S / "Save page as…": a save dialog in Downloads, then Chromium's own
 *  page saver (HTML with a _files folder, HTML only, or one .mhtml file). */
async function savePageAs(wc) {
  if (!win || wc.isDestroyed()) return;
  const title = (wc.getTitle() || "page").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "page";
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Save page as",
    defaultPath: path.join(app.getPath("downloads"), `${title}.html`),
    filters: [
      { name: "Web page, complete", extensions: ["html", "htm"] },
      { name: "Web page, single file", extensions: ["mhtml"] },
    ],
  });
  if (canceled || !filePath || !safePath(filePath)) return;
  const type = /\.mhtml?$/i.test(filePath) ? "MHTML" : "HTMLComplete";
  try {
    await wc.savePage(filePath, type);
    pages.downloads.notifySaved(filePath);
  } catch (error) {
    log(`Hog preview: saving the page failed (${error.message}).`);
  }
}

function showContextMenu(wc, params, page) {
  const actions = {
    canBack: page && wc.navigationHistory.canGoBack(),
    canForward: page && wc.navigationHistory.canGoForward(),
    openTab: (url, isolated) => pages.tell({ event: "popup", url, isolated: Boolean(isolated) }),
    copy: (text) => clipboard.writeText(String(text)),
    download: (url) => wc.downloadURL(url),
    copyImage: (x, y) => wc.copyImageAt(x, y),
    search: (text) => pages.tell({ event: "popup", url: contextMenu.searchUrl(text), isolated: false }),
    replaceMisspelling: (word) => wc.replaceMisspelling(word),
    addWord: (word) => wc.session.addWordToSpellCheckerDictionary(word),
    back: () => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(),
    forward: () => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(),
    reload: () => wc.reload(),
    print: () => printPage(wc),
    savePage: () => savePageAs(wc),
    inspect: (x, y) => wc.inspectElement(x, y),
  };
  const template = contextMenu.buildTemplate(params, actions, {
    page,
    allowed: (u) => (policy.pageAllowed(u, ports()) ? policy.allowedBrowserOpenUrl(u) : ""),
  });
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: win, frame: params.frame || undefined });
}


// Theme --bg, .boot-flash, and wartlogorun.mp4's flattened background.
// The 0.1.32 WebKit fix painted the GTK chrome view this color before the
// page paints, so the running logo is not a square on a different black.
// WebContentsView defaults to white, so the Chromium shell has to set it too.
const CHROME_BG = "#0b0b0d";
const PAGE_BG = "#ffffff";

function paintChromeBackground(window = win, color = CHROME_BG) {
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(color);
  const root = window.contentView;
  if (root && typeof root.setBackgroundColor === "function") {
    root.setBackgroundColor(color);
  }
  const children = (root && root.children) || [];
  for (const child of children) {
    if (child && child.webContents === window.webContents && typeof child.setBackgroundColor === "function") {
      child.setBackgroundColor(color);
    }
  }
}

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
    backgroundColor: CHROME_BG,
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
  paintChromeBackground(win);
  pages = new PageHost();
  termPanel = createTerminalPanel({
    win,
    settings: previewSettings,
    guard,
    logs: appLogs,
    root: ROOT,
    dirname: __dirname,
    log,
  });
  termPanel.onLayout = () => pages && pages.layout();
  overlays = new Overlays();
  findBar = new FindBar();
  paintChromeBackground(win);
  installAppMenu();
  const wc = win.webContents;
  wc.on("context-menu", (_event, params) => showContextMenu(wc, params, false));
  wc.setWindowOpenHandler(({ url }) => {
    const target = policy.allowedBrowserOpenUrl(url);
    if (target && !isOwnUrl(target)) pages.tell({ event: "popup", url: target, isolated: false });
    return { action: "deny" };
  });
  wc.on("will-navigate", (event) => {
    if (!isOwnUrl(event.url)) event.preventDefault();
  });
  wc.on("dom-ready", () => wc.insertCSS(CHROME_CSS + SNAPSHOT_CSS).catch(() => {}));
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
  win.once("ready-to-show", () => {
    paintChromeBackground(win);
    win.show();
  });
  win.on("closed", () => {
    win = null;
  });
  wc.loadURL(server.url);
}

// ---------------------------------------------------------------- preview settings card

const defaultBrowser = new DefaultBrowser(PREVIEW_DATA);
const preview = { busy: false, importStatus: "", importError: "", updateStatus: "", updateError: "", updateUrl: "", updateTimer: null, updateFound: null, updateBusy: false, updateInstalled: false };

function updateInstallable() {
  return previewUpdate.canInstallDeb({ isPackaged: app.isPackaged, execPath: process.execPath });
}

function webkitStorageFile() {
  return webkitImport.localStorageFile(HOG_DATA);
}

function previewState() {
  return {
    version: app.getVersion(),
    webkitFound: Boolean(webkitStorageFile()),
    busy: preview.busy,
    importStatus: preview.importStatus,
    importError: preview.importError,
    blockThirdPartyCookies: previewSettings.get("blockThirdPartyCookies"),
    permissions: sitePermissions.count(),
    previewUpdateChecks: previewSettings.get("previewUpdateChecks"),
    locationProvider: previewSettings.get("locationProvider"),
    terminalPanel: previewSettings.get("terminalPanel"),
    updateStatus: preview.updateStatus,
    updateError: preview.updateError,
    updateUrl: preview.updateUrl,
    updateCanInstall: Boolean(preview.updateFound && preview.updateFound.debUrl && updateInstallable().ok && !preview.updateInstalled),
    updateInstallNote: preview.updateFound ? updateInstallable().why : "",
    updateBusy: preview.updateBusy,
    updateInstalled: preview.updateInstalled,
  };
}

function sendPreviewState() {
  if (win && !win.isDestroyed()) win.webContents.send("hog:preview-state", previewState());
}

function updateUiPayload() {
  return previewUpdate.uiPayload({
    version: app.getVersion(),
    found: preview.updateFound,
    status: preview.updateStatus,
    error: preview.updateError,
    busy: preview.updateBusy,
    installed: preview.updateInstalled,
    canInstall: updateInstallable(),
  });
}

function emitUpdateUi() {
  sendPreviewState();
  hook("__hogUpdate", updateUiPayload());
}

function onPreviewUpdateAction(action) {
  if (action === "update-status") return emitUpdateUi();
  if (action === "update-check" || action === "update-check-now") return void runUpdateCheck();
  if (action === "update-install") return void runUpdateInstall();
  if (action === "update-restart") {
    if (preview.updateInstalled) relaunchSoon();
    else emitUpdateUi();
  }
}

async function chromeStorageRead(keys) {
  const code = `JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, localStorage.getItem(k)]).filter((e) => e[1] !== null)))`;
  return JSON.parse(await win.webContents.executeJavaScript(code, true));
}

async function chromeStorageWrite(writes) {
  const code = `(() => { const w = ${JSON.stringify(writes)}; for (const k of Object.keys(w)) localStorage.setItem(k, w[k]); return Object.keys(w).length; })()`;
  return win.webContents.executeJavaScript(code, true);
}

async function readWebKitKeys(keys) {
  const file = webkitStorageFile();
  if (!file) throw new Error("No WebKit Hog data was found on this computer.");
  const out = await webkitImport.readWebKit({ helper: path.join(ROOT, "webkit-import.py"), file, keys });
  if (!out.ok) throw new Error(out.error || "Could not read Hog's saved data.");
  return out.items || {};
}

function relaunchSoon() {
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 400);
}

async function runImport() {
  const bm = await import(require("node:url").pathToFileURL(path.join(ROOT, "public", "bookmarks-store.js")).href);
  const keys = [...webkitImport.BOOKMARK_KEYS, webkitImport.HISTORY_KEY, ...webkitImport.SETTINGS_KEYS];
  const fromWebKit = await readWebKitKeys(keys);
  const mine = await chromeStorageRead(keys);
  const plan = webkitImport.planImport(mine, fromWebKit, bm);
  const s = plan.summary;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Cancel", "Import and restart"],
    defaultId: 1,
    cancelId: 0,
    title: "Import from Hog",
    message: "Copy your WebKit Hog data into the Chromium preview?",
    detail: `Bookmarks after import: ${s.bookmarks} (${s.added} new, ${s.favorites} favorites)\nHistory entries from Hog: ${s.history}\nSettings: ${s.settings}\n\nThe WebKit Hog's data is only read, never changed. The wallet is not copied. The preview restarts to load the imported data.`,
  });
  if (response !== 1) return "Import cancelled.";
  await chromeStorageWrite(plan.writes);
  relaunchSoon();
  return "Imported. Restarting the preview…";
}

async function runWalletImport() {
  const keys = webkitImport.WALLET_KEYS;
  const fromWebKit = await readWebKitKeys(keys);
  const mine = await chromeStorageRead(keys);
  const plan = webkitImport.planWallet(mine, fromWebKit);
  if (!plan.ok) throw new Error(plan.error);
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Copy wallet"],
    defaultId: 0,
    cancelId: 0,
    title: "Copy wallet from Hog",
    message: "Copy the WebKit Hog's wallet into the Chromium preview?",
    detail: "This copies the encrypted wallet record (and the account name, chain and connected sites) to the preview's own storage on this computer. It stays locked with the same password; nothing is decrypted and nothing leaves this computer.\n\nBoth browsers will then hold the same wallet. Only continue if you trust this preview build.",
  });
  if (response !== 1) return "Wallet not copied.";
  await chromeStorageWrite(plan.writes);
  relaunchSoon();
  return "Wallet copied. Restarting the preview…";
}

async function runUpdateCheck() {
  if (preview.updateBusy) return emitUpdateUi();
  preview.updateError = "";
  preview.updateStatus = "Checking for a newer preview build…";
  sendPreviewState();
  try {
    const found = await previewUpdate.checkPreviewUpdate(app.getVersion());
    preview.updateUrl = found ? found.url : "";
    preview.updateFound = found;
    preview.updateStatus = found ? `Preview ${found.version} is available (${found.deb}).` : `No newer preview build is published. This is ${app.getVersion()}.`;
  } catch (error) {
    preview.updateStatus = "";
    preview.updateError = `Could not check for preview builds (${error.message}).`;
  }
  emitUpdateUi();
}

async function runUpdateInstall() {
  const found = preview.updateFound;
  if (!found || preview.updateBusy || preview.updateInstalled) return;
  const can = updateInstallable();
  if (!can.ok) {
    preview.updateError = can.why;
    return emitUpdateUi();
  }
  preview.updateBusy = true;
  preview.updateError = "";
  preview.updateStatus = `Downloading ${found.deb}…`;
  emitUpdateUi();
  let dir = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hog-preview-update-"));
    fs.chmodSync(dir, 0o755); // apt's _apt user reads the file
    let lastPct = -1;
    const file = await previewUpdate.downloadVerified(found, dir, {
      onProgress: (got, total) => {
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          preview.updateStatus = `Downloading ${found.deb}… ${pct}%`;
          emitUpdateUi();
        }
      },
    });
    await previewUpdate.checkDebFields(file, found.version);
    preview.updateStatus = "Checked against SHA256SUMS. Enter your password in the system prompt to install…";
    emitUpdateUi();
    const result = await previewUpdate.installDeb(file);
    if (!result.ok) throw new Error(result.error);
    preview.updateInstalled = true;
    preview.updateStatus = `Preview ${found.version} is installed. Restart the preview to use it.`;
  } catch (error) {
    preview.updateStatus = "";
    preview.updateError = `Update failed: ${error.message}`;
  } finally {
    preview.updateBusy = false;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    emitUpdateUi();
  }
}

function scheduleUpdateChecks() {
  clearInterval(preview.updateTimer);
  preview.updateTimer = null;
  if (!previewSettings.get("previewUpdateChecks")) return;
  setTimeout(() => previewSettings.get("previewUpdateChecks") && runUpdateCheck(), 60_000);
  preview.updateTimer = setInterval(() => previewSettings.get("previewUpdateChecks") && runUpdateCheck(), 12 * 3600_000);
}

async function guarded(statusKey, job) {
  if (preview.busy) return;
  preview.busy = true;
  preview.importError = "";
  preview.importStatus = "Working…";
  sendPreviewState();
  try {
    preview.importStatus = await job();
  } catch (error) {
    preview.importStatus = "";
    preview.importError = error.message;
  } finally {
    preview.busy = false;
    sendPreviewState();
  }
}

function onPreviewMessage(message) {
  const action = message && typeof message.action === "string" ? message.action : "";
  if (action === "cookies") previewSettings.set("blockThirdPartyCookies", Boolean(message.value));
  else if (action === "forget-permissions") sitePermissions.forgetAll();
  else if (action === "location") {
    if (geolocation.validProvider(message.value)) previewSettings.set("locationProvider", message.value);
  }
  else if (action === "terminal") {
    if (termPanel) termPanel.setEnabled(Boolean(message.value));
    else previewSettings.set("terminalPanel", Boolean(message.value));
    if (pages) pages.layout();
  }
  else if (action === "update-auto") {
    previewSettings.set("previewUpdateChecks", Boolean(message.value));
    scheduleUpdateChecks();
  } else if (action === "update-check") return void runUpdateCheck();
  else if (action === "update-install") return void runUpdateInstall();
  else if (action === "update-restart") {
    if (preview.updateInstalled) relaunchSoon();
  }
  else if (action === "update-open") {
    if (preview.updateUrl && pages) pages.tell({ event: "popup", url: preview.updateUrl, isolated: false });
  } else if (action === "import") return void guarded("import", runImport);
  else if (action === "import-wallet") return void guarded("import", runWalletImport);
  else if (action !== "state") return;
  sendPreviewState();
}

ipcMain.on("hog:preview", (event, message) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  onPreviewMessage(message);
});

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
  if (!pages) return;
  pages.gestures.set(event.sender.id, Date.now());
  const shown = pages.shown && pages.views.get(pages.shown);
  if (overlays && shown && shown.view.webContents === event.sender) overlays.onPageGesture();
});
ipcMain.on("hog:chrome-surface", (event, surface) => {
  if (!overlays || !win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) return;
  overlays.setSurface(surface);
});
ipcMain.on("hog:overlay", (event, message) => {
  if (findBar && event.sender === findBar.view.webContents) return findBar.onMessage(message);
  if (overlays) overlays.onMessage(event.sender, message);
});
// frame-preload.js: should this subframe's script cookies be blocked?
ipcMain.on("hog:frame-cookies", (event, info) => {
  if (process.env.HOG_PREVIEW_DEBUG) log(`frame-cookies ${JSON.stringify(info)}`);
  const frame = info && typeof info.frame === "string" ? info.frame : "";
  const top = info && typeof info.top === "string" ? info.top : "";
  event.returnValue = Boolean(previewSettings.get("blockThirdPartyCookies") && top && cookies.isThirdParty(frame, top, "subFrame"));
});
const locator = new geolocation.Locator({ helper: path.join(ROOT, "geoclue-locate.py") });
ipcMain.handle("hog:geo", async (event, request) => {
  if (process.env.HOG_PREVIEW_DEBUG) log(`geo from ${event.senderFrame && event.senderFrame.url}`);
  const wc = event.sender;
  const frame = event.senderFrame;
  if (!frame || frame !== wc.mainFrame) return { ok: false, code: 2, error: "Position unavailable" };
  const origin = policy.pageOrigin(frame.url, ports());
  if (!origin || !(pages && (pages.tabFor(wc) !== undefined || BrowserWindow.fromWebContents(wc)))) return { ok: false, code: 2, error: "Position unavailable" };
  const ses = wc.session;
  const allowed = await askPermission(permissionStore(ses), "geolocation", origin, [], ses.isPersistent());
  if (!allowed) return { ok: false, code: 1, error: "User denied Geolocation" };
  const provider = previewSettings.get("locationProvider");
  const answer = await locator.locate(provider, { high: Boolean(request && request.high) });
  if (!answer.ok) log(`Hog preview: location for ${origin} failed (${answer.error}).`);
  return answer.ok ? { ok: true, fix: answer.fix } : { ok: false, code: 2, error: answer.error };
});
ipcMain.on("hog:page-scripts", (event, href) => {
  const scripts = [geolocation.GEO_SHIM];
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
    Menu.setApplicationMenu(null); // replaced with a hidden View menu in createWindow
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
    scheduleUpdateChecks();
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
    if (termPanel) termPanel.dispose();
    server.stop();
    if (guard) guard.stop();
  });
}
