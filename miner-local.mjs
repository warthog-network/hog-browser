// Start and stop the local Warthog BzMiner from the phone.
//
// The phone sends only "start" or "stop". It never chooses the program or
// the arguments. Hog runs one launcher, start_warthog.sh, and only when that
// file is a real executable inside the home directory. A second start does
// nothing if that miner is already running. Stop signals only processes this
// user owns, so a miner started as root is left alone.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

export const MINER_SCRIPT_NAME = "start_warthog.sh";

export function defaultMinerScript(home = homedir()) {
  return join(home, "Downloads", "bzminer_v100.02b6_linux", MINER_SCRIPT_NAME);
}

/** Why this path cannot be launched, or "". */
export function minerScriptProblem(script, home = homedir()) {
  if (typeof script !== "string" || !script.trim()) return "Hog has no miner launcher configured.";
  if (!isAbsolute(script) || basename(script) !== MINER_SCRIPT_NAME) {
    return "Hog only starts start_warthog.sh in your home folder.";
  }
  let homeReal;
  let real;
  try {
    homeReal = realpathSync(home);
    real = realpathSync(script);
  } catch {
    return "Hog could not find start_warthog.sh.";
  }
  const root = homeReal.endsWith(sep) ? homeReal : homeReal + sep;
  if (real !== homeReal && !real.startsWith(root)) return "The miner launcher has to stay in your home folder.";
  let info;
  try {
    info = statSync(real);
  } catch {
    return "Hog could not find start_warthog.sh.";
  }
  if (!info.isFile()) return "Hog could not find start_warthog.sh.";
  if ((info.mode & 0o111) === 0) return "start_warthog.sh is not executable.";
  return "";
}

/** "miner", "launcher", or "" for one process command line. */
export function classifyMinerProc(args, { script, port }) {
  if (!Array.isArray(args) || args.length === 0) return "";
  const pool = `127.0.0.1:${port}`;
  const bin = String(args[0]).split(/[/\\]/).pop();
  const isMiner = bin === "bzminer" || args.some((arg) => arg === "./bzminer" || String(arg).endsWith("/bzminer"));
  if (isMiner && args.includes("warthog") && args.some((arg) => String(arg).includes(pool))) return "miner";
  if (script && args.includes(script)) return "launcher";
  return "";
}

/** Command lines under /proc. Args stay here and are not returned to the phone. */
export function listProcCmdlines() {
  let ids = [];
  try {
    ids = readdirSync("/proc");
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    try {
      const args = readFileSync(join("/proc", id, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (!args.length) continue;
      const status = readFileSync(join("/proc", id, "status"), "utf8");
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
      out.push({
        pid: Number(id),
        ppid: Number.isInteger(ppid) ? ppid : 0,
        uid: Number.isInteger(uid) ? uid : null,
        args,
      });
    } catch {
      // The process exited while we were reading it.
    }
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function treeOf(seeds, all) {
  const keep = new Set(seeds.map((proc) => proc.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of all) {
      if (keep.has(proc.ppid) && !keep.has(proc.pid)) {
        keep.add(proc.pid);
        grew = true;
      }
    }
  }
  return all.filter((proc) => keep.has(proc.pid));
}

function signalPid(pid, sig) {
  try {
    process.kill(pid, sig);
    return "";
  } catch (error) {
    return error?.code || "error";
  }
}

/**
 * @param {{ home?: string, scriptPath?: () => string, port?: number | (() => number),
 *   uid?: number, list?: () => Array<{pid:number,ppid:number,uid:number|null,args:string[]}>,
 *   spawnImpl?: typeof spawn, logFile?: string, settleMs?: number,
 *   rootHelper?: string }} [options]
 */
export function createLocalMiner({
  home = homedir(),
  scriptPath = () => "",
  port = 3456,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  list = listProcCmdlines,
  spawnImpl = spawn,
  logFile = join(home, ".local", "share", "hog-browser", "miner.log"),
  settleMs = 1500,
  rootHelper = "",
} = {}) {
  let lastError = "";
  let busy = null;

  function currentPort() {
    const value = typeof port === "function" ? port() : port;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 && number < 65536 ? number : 3456;
  }

  function script() {
    const picked = scriptPath();
    return typeof picked === "string" && picked.trim() ? picked.trim() : defaultMinerScript(home);
  }

  function matched() {
    const path = script();
    const listen = currentPort();
    return list().filter((proc) => classifyMinerProc(proc.args, { script: path, port: listen }));
  }

  function rootReady() {
    if (typeof rootHelper !== "string" || !rootHelper.trim()) return false;
    try {
      const info = statSync(rootHelper);
      return info.isFile() && (info.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  /** sudo -n the installed helper. The helper accepts only start or stop. */
  function runRoot(action) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl("sudo", ["-n", "--", rootHelper, action], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve({ ok: false, error: "Hog could not run the miner helper." });
        return;
      }
      if (!child || typeof child.on !== "function") {
        resolve({ ok: false, error: "Hog could not run the miner helper." });
        return;
      }
      let err = "";
      if (child.stderr && typeof child.stderr.on === "function") {
        child.stderr.on("data", (chunk) => {
          err = `${err}${chunk}`.slice(-600);
        });
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.on("error", () => finish({ ok: false, error: "Hog could not run the miner helper." }));
      child.on("exit", (code) => {
        if (code === 0) {
          finish({ ok: true, error: "" });
          return;
        }
        const text = err.trim();
        const needsInstall = /password|interactive authentication/i.test(text);
        finish({
          ok: false,
          error: needsInstall
            ? "Update Hog so the phone can start BzMiner as root, then try again."
            : (text.slice(0, 300) || "Hog could not change BzMiner."),
        });
      });
    });
  }

  function status() {
    const problem = minerScriptProblem(script(), home);
    if (problem) return { state: "missing", error: problem };
    if (matched().length) return { state: "running", error: "" };
    return { state: "stopped", error: lastError };
  }

  async function start() {
    if (busy) return busy;
    busy = doStart().finally(() => {
      busy = null;
    });
    return busy;
  }

  async function doStart() {
    const path = script();
    const problem = minerScriptProblem(path, home);
    if (problem) {
      lastError = problem;
      return { ok: false, started: false, ...status() };
    }
    if (matched().length) {
      lastError = "";
      return { ok: true, started: false, ...status() };
    }
    if (rootReady()) {
      const ran = await runRoot("start");
      await delay(settleMs);
      if (!ran.ok) {
        lastError = ran.error;
        return { ok: false, started: false, ...status() };
      }
      if (!matched().length) {
        lastError = "BzMiner stopped right away.";
        return { ok: false, started: true, ...status() };
      }
      lastError = "";
      return { ok: true, started: true, ...status() };
    }
    const real = realpathSync(path);
    let fd;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      fd = openSync(logFile, "a", 0o600);
      chmodSync(logFile, 0o600);
      const child = spawnImpl(real, [], {
        cwd: dirname(real),
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
    } catch {
      lastError = "Hog could not start BzMiner.";
      return { ok: false, started: false, ...status() };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    await delay(settleMs);
    if (!matched().length) {
      lastError = "BzMiner stopped right away.";
      return { ok: false, started: true, ...status() };
    }
    lastError = "";
    return { ok: true, started: true, ...status() };
  }

  async function stop() {
    if (busy) return busy;
    busy = doStop().finally(() => {
      busy = null;
    });
    return busy;
  }

  async function doStop() {
    const seeds = matched();
    if (!seeds.length) {
      lastError = "";
      return { ok: true, stopped: false, ...status() };
    }
    const tree = treeOf(seeds, list());
    if (tree.some((proc) => proc.uid !== uid)) {
      if (!rootReady()) {
        lastError = "This miner was started as another user. Hog cannot stop it.";
        return { ...status(), ok: false, stopped: false, error: lastError };
      }
      const ran = await runRoot("stop");
      await delay(Math.min(settleMs, 200));
      if (!ran.ok) {
        lastError = ran.error;
        return { ...status(), ok: false, stopped: false, error: lastError };
      }
      if (matched().length) {
        lastError = "BzMiner is still running.";
        return { ...status(), ok: false, stopped: false, error: lastError };
      }
      lastError = "";
      return { ok: true, stopped: true, ...status() };
    }
    for (const proc of tree) signalPid(proc.pid, "SIGTERM");
    await delay(Math.min(settleMs, 800));
    const alive = new Set(list().map((proc) => proc.pid));
    for (const proc of tree) {
      if (alive.has(proc.pid)) signalPid(proc.pid, "SIGKILL");
    }
    await delay(100);
    if (matched().length) {
      lastError = "BzMiner is still running.";
      return { ...status(), ok: false, stopped: false, error: lastError };
    }
    lastError = "";
    return { ok: true, stopped: true, ...status() };
  }

  return { status, start, stop };
}
