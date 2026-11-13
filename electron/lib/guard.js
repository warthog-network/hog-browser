"use strict";
// Talks to guard-bridge.py (Hog's guard.py) over JSON lines. Settings ->
// Containers, Tailscale, Samba, Jellyfin and SSH tabs all go through guard.py,
// exactly like the WebKit shell.
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

class GuardBridge {
  constructor({ root, dataDir, origin, python = process.env.HOG_PYTHON || "python3", log = console.log }) {
    this.root = root;
    this.dataDir = dataDir;
    this.origin = origin;
    this.python = python;
    this.log = log;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  ensure() {
    if (this.child) return this.child;
    const child = spawn(this.python, [path.join(this.root, "guard-bridge.py")], {
      cwd: this.root,
      env: { ...process.env, HOG_DATA: this.dataDir, HOG_ORIGIN: this.origin, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.on("error", (error) => {
      this.log(`Hog preview: guard bridge failed: ${error.message}`);
      this.failAll(`Hog could not start python3 for this: ${error.message}`);
      if (this.child === child) this.child = null;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.failAll("Hog's container helper stopped.");
    });
    return child;
  }

  failAll(message) {
    for (const [, entry] of this.pending) entry.onDone({ ok: false, error: message, items: [] });
    this.pending.clear();
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.ready) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.done) {
      this.pending.delete(msg.id);
      entry.onDone(msg.payload);
    } else if (entry.onProgress) {
      entry.onProgress(msg.payload);
    }
  }

  send(obj, onDone, onProgress) {
    const id = this.nextId++;
    this.pending.set(id, { onDone, onProgress });
    try {
      this.ensure().stdin.write(`${JSON.stringify({ ...obj, id })}\n`);
    } catch (error) {
      this.pending.delete(id);
      onDone({ ok: false, error: String(error.message || error), items: [] });
    }
  }

  handle(action, name, image, onDone, onProgress) {
    this.send({ action, name, image }, onDone, onProgress);
  }

  useLibrary(rel) {
    this.send({ op: "use_library", rel }, () => {});
  }

  stop() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill("SIGTERM");
      } catch {
        /* gone */
      }
      this.child = null;
    }
  }
}

module.exports = { GuardBridge };
