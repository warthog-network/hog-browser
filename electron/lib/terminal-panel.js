"use strict";
// Bottom terminal panel for the Chromium preview. Drawn in its own
// WebContentsView above page views; page views are inset so content is not
// hidden. Host PTYs are spawned with node-pty in this process and reached
// only through hog:term IPC from this view (no HTTP server, nothing on
// 4188/4189). Container tabs reuse guard.py's existing shell action; the
// WebSocket stays in the main process.
const { WebContentsView, session, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const layout = require("./terminal-layout");
const { hostShellCommand, loadPty, spawnHostPty } = require("./host-shell");

const PARTITION = "hog-terminal";
const KINDS = new Set(["host", "container", "log"]);
const VALID_TYPES = layout.VALID_TYPES;

function xtermFiles(root, dirname) {
  const dirs = [path.join(root, "public"), path.join(dirname, "..", "public")];
  const found = {};
  for (const dir of dirs) {
    const js = path.join(dir, "xterm-bundle.js");
    const css = path.join(dir, "xterm.css");
    if (fs.existsSync(js) && fs.existsSync(css)) {
      found.js = pathToFileURL(js).href;
      found.css = pathToFileURL(css).href;
      return found;
    }
  }
  return found;
}

function prepareSession(ses) {
  const local = (url) => {
    try {
      return url.startsWith("file:") || url.startsWith("devtools:");
    } catch {
      return false;
    }
  };
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !local(details.url) }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

class TerminalPanel {
  constructor({
    win,
    settings,
    guard,
    logs,
    root,
    dirname = __dirname,
    log = console.log,
    platform = process.platform,
    env = process.env,
  }) {
    this.win = win;
    this.settings = settings;
    this.guard = guard;
    this.logs = logs;
    this.root = root;
    this.dirname = dirname;
    this.log = log;
    this.platform = platform;
    this.env = env;
    this.open = false;
    this.height = layout.clampHeight(settings && settings.get("terminalHeight"), 800);
    this.sessions = new Map();
    this.activeId = "";
    this.containers = [];
    this.pty = loadPty();
    this.nextId = 1;
    this.drag = null;
    this.unsubLog = null;
    this.ipcBound = false;
    this.view = this.makeView();
    this.bindIpc();
  }

  makeView() {
    prepareSession(session.fromPartition(PARTITION));
    const electronDir = path.dirname(this.dirname);
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: path.join(electronDir, "terminal-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#0b0b0d");
    view.setVisible(false);
    view.ready = false;
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("did-finish-load", () => {
      view.ready = true;
      this.pushState();
    });
    wc.on("render-process-gone", () => {
      view.ready = false;
      setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
    });
    wc.loadFile(path.join(electronDir, "terminal.html"), {
      query: xtermFiles(this.root, electronDir),
    }).catch((error) => this.log(`Hog preview: terminal view failed to load: ${error.message}`));
    this.win.contentView.addChildView(view);
    return view;
  }

  isContents(wc) {
    return Boolean(this.view && this.view.webContents && wc && this.view.webContents.id === wc.id);
  }

  enabled() {
    return Boolean(this.settings && this.settings.get("terminalPanel"));
  }

  reservedHeight() {
    if (!this.win || this.win.isDestroyed() || !this.open || !this.enabled()) return 0;
    const [, height] = this.win.getContentSize();
    return layout.reservedHeight(true, this.height, height);
  }

  raise() {
    if (!this.win || this.win.isDestroyed() || !this.view) return;
    this.win.contentView.addChildView(this.view);
  }

  layout() {
    if (!this.win || this.win.isDestroyed() || !this.view) return;
    if (!this.open || !this.enabled()) {
      if (this.view.getVisible()) this.view.setVisible(false);
      return;
    }
    const [width, height] = this.win.getContentSize();
    this.height = layout.clampHeight(this.height, height);
    this.view.setBounds(layout.panelBounds(width, height, this.height));
    if (!this.view.getVisible()) this.view.setVisible(true);
    this.raise();
    this.pushState();
  }

  setEnabled(on) {
    const value = Boolean(on);
    if (this.settings) this.settings.set("terminalPanel", value);
    if (!value) {
      this.hide(true);
      this.closeAll();
    } else {
      this.show();
    }
  }

  toggleFromUser() {
    if (!this.enabled()) {
      this.setEnabled(true);
      return;
    }
    if (this.open) this.hide(false);
    else this.show();
  }

  show() {
    if (!this.enabled()) return;
    this.open = true;
    if (![...this.sessions.values()].some((s) => s.kind === "host" || s.kind === "container" || s.kind === "log")) {
      this.openTab("host");
    }
    this.layout();
    this.refreshContainers();
    if (this.view && this.view.webContents && !this.view.webContents.isDestroyed()) this.view.webContents.focus();
  }

  hide(keepSetting) {
    this.open = false;
    if (this.view && this.view.getVisible()) this.view.setVisible(false);
    this.pushState();
    if (keepSetting === true) return;
  }

  persistHeight() {
    if (this.settings) this.settings.set("terminalHeight", this.height);
  }

  tabList() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      name: s.name || "",
      alive: s.kind === "log" ? true : Boolean(s.alive),
      readonly: s.kind === "log",
    }));
  }

  pushState() {
    if (!this.view || !this.view.webContents || this.view.webContents.isDestroyed() || !this.view.ready) return;
    const assets = xtermFiles(this.root, path.dirname(this.dirname));
    const state = {
      open: this.open && this.enabled(),
      height: this.height,
      enabled: this.enabled(),
      tabs: this.tabList(),
      active: this.activeId,
      containers: this.containers,
      assets,
      shellHint: hostShellCommand(this.platform, this.env).file,
    };
    this.view.webContents.send("hog:term-state", state);
  }

  sendData(id, data) {
    if (!this.view || !this.view.webContents || this.view.webContents.isDestroyed()) return;
    this.view.webContents.send("hog:term-data", { id, data: String(data) });
  }

  newId() {
    const id = `t${this.nextId++}`;
    return id;
  }

  openTab(kind, name = "") {
    if (kind === "log") {
      const existing = [...this.sessions.values()].find((s) => s.kind === "log");
      if (existing) {
        this.activeId = existing.id;
        this.pushState();
        this.sendData(existing.id, "");
        return existing.id;
      }
    }
    if (kind === "container" && !layout.validContainerName(name)) return "";
    const id = this.newId();
    const title = kind === "host" ? "Host" : kind === "log" ? "Hog log" : name;
    const session = { id, kind, name: name || "", title, alive: false, pty: null, ws: null, token: "", cols: 80, rows: 24 };
    this.sessions.set(id, session);
    this.activeId = id;
    this.pushState();
    if (kind === "host") this.spawnHost(session);
    else if (kind === "container") this.spawnContainer(session);
    else if (kind === "log") this.attachLog(session);
    return id;
  }

  spawnHost(session) {
    if (this.pty && this.pty.error) {
      this.sendData(session.id, `\r\nCould not start a host shell: ${this.pty.error}\r\n`);
      return;
    }
    try {
      const proc = spawnHostPty(this.pty, this.platform, this.env, { cols: session.cols, rows: session.rows });
      session.pty = proc;
      session.alive = true;
      proc.onData((data) => this.sendData(session.id, data));
      proc.onExit(({ exitCode, signal }) => {
        session.alive = false;
        session.pty = null;
        this.sendData(session.id, `\r\n[process exited${exitCode != null ? ` with code ${exitCode}` : ""}${signal ? ` signal ${signal}` : ""}]\r\n`);
        this.pushState();
      });
      this.pushState();
    } catch (error) {
      this.sendData(session.id, `\r\nCould not start a host shell: ${error.message}\r\n`);
    }
  }

  spawnContainer(session) {
    const name = session.name;
    if (!this.guard) {
      this.sendData(session.id, "\r\nHog's container helper is not ready.\r\n");
      return;
    }
    this.sendData(session.id, `Installing SSH in ${name}.\r\nThe first time can take a few minutes.\r\nYou are hog.\r\n`);
    this.guard.handle("shell", name, "", (payload) => {
      if (!this.sessions.has(session.id)) {
        const token = payload && payload.shell && payload.shell.token;
        if (token) this.guard.handle("shell-close", token, "", () => {}, () => {});
        return;
      }
      const shell = payload && payload.shell;
      if (!shell || !shell.token || !shell.port) {
        const err = (shell && shell.error) || (payload && payload.error) || "Could not open SSH.";
        this.sendData(session.id, `\r\n${err}\r\n`);
        this.pushState();
        return;
      }
      this.connectContainerWs(session, shell);
    }, () => {});
  }

  openWs(url) {
    if (typeof WebSocket === "function") {
      const ws = new WebSocket(url);
      return ws;
    }
    const WS = require(path.join(this.root, "node_modules", "ws"));
    return new WS(url);
  }

  connectContainerWs(session, shell) {
    session.token = shell.token;
    const url = `ws://127.0.0.1:${Number(shell.port)}/ssh?token=${encodeURIComponent(shell.token)}`;
    let ws;
    try {
      ws = this.openWs(url);
    } catch (error) {
      this.sendData(session.id, `\r\nCould not open the SSH session: ${error.message}\r\n`);
      return;
    }
    session.ws = ws;
    if (typeof ws.binaryType === "string") ws.binaryType = "arraybuffer";
    const sendResize = () => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: session.cols, rows: session.rows }));
    };
    const onOpen = () => {
      session.alive = true;
      sendResize();
      this.pushState();
    };
    const onMessage = (event) => {
      const raw = event && Object.prototype.hasOwnProperty.call(event, "data") ? event.data : event;
      if (typeof raw === "string") this.sendData(session.id, raw);
      else if (raw && raw.byteLength != null) this.sendData(session.id, Buffer.from(raw).toString("utf8"));
      else if (Buffer.isBuffer(raw)) this.sendData(session.id, raw.toString("utf8"));
      else this.sendData(session.id, String(raw || ""));
    };
    const onClose = () => {
      session.alive = false;
      session.ws = null;
      this.sendData(session.id, "\r\nSession closed.\r\n");
      this.pushState();
    };
    const onError = () => this.sendData(session.id, "\r\nCould not open the SSH session.\r\n");
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } else {
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    }
  }

  attachLog(session) {
    session.alive = true;
    const past = this.logs && this.logs.text ? this.logs.text() : "";
    if (past) this.sendData(session.id, past);
    else this.sendData(session.id, "No Hog server output captured yet. If this preview attached to an already-running Hog server, that process's stdout is not in this tab.\r\n");
    if (this.logs && typeof this.logs.on === "function") {
      session.unsub = this.logs.on((line) => {
        if (this.sessions.has(session.id)) this.sendData(session.id, line);
      });
    }
    this.pushState();
  }

  writeInput(id, data) {
    const session = this.sessions.get(id);
    if (!session || session.kind === "log") return;
    const text = String(data);
    if (!text || text.length > 32768) return;
    if (session.pty && typeof session.pty.write === "function") session.pty.write(text);
    else if (session.ws && session.ws.readyState === 1) {
      const buf = Buffer.from(text, "utf8");
      session.ws.send(buf);
    }
  }

  resizeSession(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    const c = Math.max(2, Math.min(400, Math.round(Number(cols) || 0)));
    const r = Math.max(1, Math.min(200, Math.round(Number(rows) || 0)));
    session.cols = c;
    session.rows = r;
    try {
      if (session.pty && typeof session.pty.resize === "function") session.pty.resize(c, r);
    } catch {
      /* ignore */
    }
    if (session.ws && session.ws.readyState === 1) {
      try {
        session.ws.send(JSON.stringify({ type: "resize", cols: c, rows: r }));
      } catch {
        /* ignore */
      }
    }
  }

  closeTab(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.unsub) try { session.unsub(); } catch { /* ignore */ }
    if (session.pty) {
      try { session.pty.kill(); } catch { /* ignore */ }
      session.pty = null;
    }
    if (session.ws) {
      try { session.ws.close(); } catch { /* ignore */ }
      session.ws = null;
    }
    if (session.token && this.guard) {
      this.guard.handle("shell-close", session.token, "", () => {}, () => {});
    }
    session.alive = false;
    if (this.activeId === id) {
      const last = [...this.sessions.keys()].pop() || "";
      this.activeId = last;
    }
    this.pushState();
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.closeTab(id);
  }

  refreshContainers() {
    if (!this.guard) {
      this.containers = [];
      this.pushState();
      return;
    }
    this.guard.handle("list", "", "", (payload) => {
      this.containers = layout.runningContainers(payload && payload.items);
      this.pushState();
    }, () => {});
  }

  onDrag(phase, y) {
    if (!this.win || this.win.isDestroyed()) return;
    const [, height] = this.win.getContentSize();
    if (phase === "start") {
      this.drag = { height: this.height, origin: Number(y) || 0 };
      return;
    }
    if (!this.drag) return;
    if (phase === "move" || phase === "end") {
      const origin = this.drag.origin;
      const start = this.drag.height;
      this.height = layout.clampHeight(start - ((Number(y) || 0) - origin), height);
      this.layout();
      if (typeof this.onLayout === "function") this.onLayout();
    }
    if (phase === "end") {
      this.persistHeight();
      this.drag = null;
    }
  }

  acceptIpc(event) {
    return Boolean(
      this.view &&
        this.view.webContents &&
        event &&
        event.sender === this.view.webContents &&
        event.senderFrame === this.view.webContents.mainFrame,
    );
  }

  bindIpc() {
    if (this.ipcBound) return;
    this.ipcBound = true;
    ipcMain.on("hog:term", (event, message) => {
      if (!this.acceptIpc(event)) return;
      this.onMessage(message);
    });
  }

  onMessage(message) {
    if (!message || typeof message !== "object") return;
    const type = message.type;
    if (!VALID_TYPES.has(type)) return;
    if (type === "ready") return this.pushState();
    if (type === "hide") {
      this.hide(false);
      if (typeof this.onLayout === "function") this.onLayout();
      return;
    }
    if (type === "list") return this.refreshContainers();
    if (type === "open") {
      const kind = KINDS.has(message.kind) ? message.kind : "";
      if (!kind) return;
      const name = kind === "container" ? String(message.name || "") : "";
      this.openTab(kind, name);
      return;
    }
    if (type === "select") {
      if (this.sessions.has(String(message.id || ""))) {
        this.activeId = String(message.id);
        this.pushState();
      }
      return;
    }
    if (type === "close") return this.closeTab(String(message.id || ""));
    if (type === "input") return this.writeInput(String(message.id || ""), message.data);
    if (type === "resize") return this.resizeSession(String(message.id || ""), message.cols, message.rows);
    if (type === "drag") return this.onDrag(String(message.phase || ""), message.y);
  }

  dispose() {
    this.closeAll();
    this.open = false;
    if (this.view && this.win && !this.win.isDestroyed()) {
      try { this.win.contentView.removeChildView(this.view); } catch { /* closing */ }
      try { this.view.webContents.close(); } catch { /* already gone */ }
    }
  }
}

// main.js passes dirname = electron/. The class stores electron/lib as this.dirname
// so existing lib/ relative requires stay natural and UI files sit in .. .
function createTerminalPanel(opts) {
  const electronDir = opts.dirname || path.dirname(__dirname);
  return new TerminalPanel({ ...opts, dirname: path.join(electronDir, "lib") });
}

module.exports = { TerminalPanel, createTerminalPanel, xtermFiles };
