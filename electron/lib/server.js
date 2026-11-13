"use strict";
// Find or start Hog's local Node server (server.mjs) for the Chromium shell.
//
// 1. A Hog server already answering on 127.0.0.1:4188 (the installed WebKit
//    Hog is running) is reused as is: same wallet API, mining, Tailscale,
//    Files, phone app. Nothing is started twice.
// 2. If 4188 is free, this app starts its own copy of server.mjs there with
//    Electron's bundled Node (ELECTRON_RUN_AS_NODE), so no system Node is needed.
// 3. If something that is not Hog holds 4188, it picks the next free port.
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 4188;
const DEFAULT_NODE_PORT = 43100;

function probeHog(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/__hog/version", timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(data && data.app === "hog-browser" ? { version: String(data.version || "") } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function portOpen(port, timeout = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeout, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function firstFree(from, to) {
  for (let port = from; port <= to; port += 1) {
    if (!(await portOpen(port))) return port;
  }
  return 0;
}

class HogServer {
  constructor({ root, log = console.log, execPath = process.execPath, env = process.env } = {}) {
    this.root = root;
    this.log = log;
    this.execPath = execPath;
    this.env = env;
    this.child = null;
    this.port = 0;
    this.nodePort = DEFAULT_NODE_PORT;
    this.shared = false;
    this.version = "";
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  async ensure() {
    const wanted = Number(this.env.HOG_PORT || DEFAULT_PORT);
    const running = await probeHog(wanted);
    if (running) {
      this.port = wanted;
      this.shared = true;
      this.version = running.version;
      this.nodePort = DEFAULT_NODE_PORT;
      this.log(`Hog preview: using the Hog server already running on ${wanted} (version ${running.version || "unknown"}).`);
      return this;
    }
    let port = wanted;
    if (await portOpen(port)) {
      port = await firstFree(wanted + 1, wanted + 40);
      if (!port) throw new Error("No free local port for Hog's server.");
    }
    let nodePort = DEFAULT_NODE_PORT;
    if (await portOpen(nodePort)) nodePort = (await firstFree(DEFAULT_NODE_PORT + 1, DEFAULT_NODE_PORT + 40)) || DEFAULT_NODE_PORT;
    await this.start(port, nodePort);
    return this;
  }

  start(port, nodePort) {
    this.port = port;
    this.nodePort = nodePort;
    this.shared = false;
    const env = { ...this.env, ELECTRON_RUN_AS_NODE: "1", HOG_PORT: String(port) };
    if (nodePort !== DEFAULT_NODE_PORT) env.HOG_NODE_PORT = String(nodePort);
    this.log(`Hog preview: starting server.mjs on ${port} (node tab ${nodePort}).`);
    const child = spawn(this.execPath, ["server.mjs"], {
      cwd: this.root,
      env,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      this.log(`Hog preview: server.mjs exited (${code ?? signal}).`);
      if (this.child === child) this.child = null;
    });
    return new Promise((resolve, reject) => {
      let tries = 0;
      const tick = async () => {
        if (await portOpen(port)) return resolve();
        if (!this.child) return reject(new Error("Hog's local server stopped before the window opened."));
        tries += 1;
        if (tries > 100) return reject(new Error("Hog's local server did not start."));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async alive() {
    return portOpen(this.port, 500);
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { HogServer, probeHog, portOpen, firstFree, DEFAULT_PORT, DEFAULT_NODE_PORT };
