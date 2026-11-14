import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const layout = require("../lib/terminal-layout.js");
const { hostShellCommand, loadPty, ptyEnv } = require("../lib/host-shell.js");
const { LogBuffer } = require("../lib/log-buffer.js");

test("panel height is clamped and remembered as a bottom strip", () => {
  assert.equal(layout.clampHeight(240, 800), 240);
  assert.equal(layout.clampHeight(20, 800), layout.MIN_HEIGHT);
  assert.equal(layout.clampHeight(900, 800), Math.floor(800 * layout.MAX_RATIO));
  assert.equal(layout.clampHeight(undefined, 800), layout.DEFAULT_HEIGHT);
  assert.deepEqual(layout.panelBounds(1000, 800, 200), { x: 0, y: 600, width: 1000, height: 200 });
  assert.equal(layout.reservedHeight(false, 240, 800), 0);
  assert.equal(layout.reservedHeight(true, 240, 800), 240);
});

test("page views shrink so the panel does not cover them", () => {
  const page = { x: 10, y: 50, width: 980, height: 650 };
  assert.deepEqual(layout.panelInset(page, 200), { x: 10, y: 50, width: 980, height: 450 });
  assert.deepEqual(layout.panelInset(page, 0), page);
  assert.deepEqual(layout.panelInset(page, 900), { x: 10, y: 50, width: 980, height: 0 });
});

test("host shell is $SHELL at home, or powershell on Windows", () => {
  const linux = hostShellCommand("linux", { SHELL: "/bin/zsh", HOME: "/home/wwart" });
  assert.deepEqual(linux, { file: "/bin/zsh", args: [], cwd: "/home/wwart" });
  const fallback = hostShellCommand("linux", { HOME: "/home/wwart" });
  assert.equal(fallback.file, "/bin/bash");
  const win = hostShellCommand("win32", { USERPROFILE: "C:\\Users\\wwart" });
  assert.equal(win.file, "powershell.exe");
  assert.deepEqual(win.args, ["-NoLogo"]);
  assert.equal(win.cwd, "C:\\Users\\wwart");
  const env = ptyEnv("linux", { PATH: "/bin" });
  assert.equal(env.TERM, "xterm-256color");
  const missing = loadPty(() => { throw new Error("Cannot find module 'node-pty'"); });
  assert.match(missing.error, /node-pty/);
});

test("only running, named containers are offered as tabs", () => {
  const items = [
    { name: "jellyfin", state: "running" },
    { name: "tailscale", state: "running", reason: "needs login" },
    { name: "stopped", state: "exited" },
    { name: "../evil", state: "running" },
    { name: "ok", state: "running", image: "ubuntu:24.04" },
  ];
  assert.deepEqual(layout.runningContainers(items), [
    { name: "jellyfin", image: "" },
    { name: "ok", image: "ubuntu:24.04" },
  ]);
  assert.equal(layout.validContainerName("jellyfin"), true);
  assert.equal(layout.validContainerName("a b"), false);
});

test("log buffer keeps a tail and notifies listeners", () => {
  const buf = new LogBuffer(20);
  const got = [];
  const off = buf.on((line) => got.push(line));
  buf.append("abcdefghij");
  buf.append("xyz");
  assert.equal(buf.text().includes("xyz"), true);
  assert.ok(buf.text().length <= 24);
  assert.deepEqual(got, ["abcdefghij\n", "xyz\n"]);
  off();
  buf.append("nope");
  assert.equal(got.length, 2);
});

test("IPC message types stay a closed list", () => {
  for (const type of ["ready", "input", "resize", "close", "open", "select", "drag", "hide", "list"]) {
    assert.equal(layout.VALID_TYPES.has(type), true);
  }
  assert.equal(layout.VALID_TYPES.has("eval"), false);
});
