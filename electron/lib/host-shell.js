"use strict";
// Host-shell command and a node-pty spawn wrapper. The PTY lives only in the
// Electron main process and is reached from the chrome terminal view via IPC.
// No HTTP or WebSocket endpoint is created for it.
const os = require("node:os");
const path = require("node:path");

function hostShellCommand(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const fromEnv = typeof env.SHELL === "string" && /\.exe$/i.test(env.SHELL) ? env.SHELL : "";
    const comspec = typeof env.ComSpec === "string" && /powershell/i.test(env.ComSpec) ? env.ComSpec : "";
    const file = fromEnv || comspec || "powershell.exe";
    const base = path.basename(file).toLowerCase();
    const args = base === "powershell.exe" || base === "pwsh.exe" ? ["-NoLogo"] : [];
    return { file, args, cwd: env.USERPROFILE || os.homedir() };
  }
  const shell = typeof env.SHELL === "string" && env.SHELL.startsWith("/") ? env.SHELL : "/bin/bash";
  return { file: shell, args: [], cwd: env.HOME || os.homedir() };
}

function loadPty(requireFn = require) {
  try {
    return requireFn("node-pty");
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) };
  }
}

function ptyEnv(platform = process.platform, env = process.env) {
  const out = { ...env };
  if (platform !== "win32") {
    out.TERM = out.TERM || "xterm-256color";
    out.COLORTERM = out.COLORTERM || "truecolor";
  }
  return out;
}

function spawnHostPty(pty, platform, env, { cols = 80, rows = 24 } = {}) {
  if (!pty || typeof pty.spawn !== "function") {
    throw new Error("The host terminal could not load node-pty. This preview build may be missing the native module.");
  }
  const cmd = hostShellCommand(platform, env);
  return pty.spawn(cmd.file, cmd.args, {
    name: "xterm-256color",
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    cwd: cmd.cwd,
    env: ptyEnv(platform, env),
  });
}

module.exports = { hostShellCommand, loadPty, ptyEnv, spawnHostPty };
