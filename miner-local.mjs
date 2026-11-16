// Start and stop the local Warthog BzMiner from the phone.
//
// The phone sends only "start" or "stop", or picks one of the saved
// start_warthog.sh files by id. It never chooses a different program or the
// miner's arguments. Hog runs one launcher, and only when that file is a real
// executable inside the home directory. A second start does nothing if that
// miner is already running. Stop signals only processes this user owns, so a
// miner started as root is left alone.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { isTailnetIpv4, isTailnetIpv6 } from "./tailnet.mjs";

export const MINER_SCRIPT_NAME = "start_warthog.sh";
const SYSTEMD_RUN = "/usr/bin/systemd-run";

/**
 * Hog sets no_new_privs, so sudo it spawns cannot become root
 * ("The no new privileges flag is set"). systemd-run asks the user
 * session to start sudo, and that process is allowed to be setuid.
 * @returns {[string, string[]]}
 */
export function minerRootArgv(helper, action, systemdRun = "") {
  const sudoArgs = ["-n", "--", helper, action];
  if (systemdRun) {
    return [systemdRun, ["--user", "--pipe", "--wait", "--collect", "--quiet", "--", "sudo", ...sudoArgs]];
  }
  return ["sudo", sudoArgs];
}

function rootFailure(text) {
  if (/no new privileges/i.test(text)) {
    return "Hog could not start BzMiner as root from inside the browser.";
  }
  if (/password|interactive authentication/i.test(text)) {
    return "Update Hog so the phone can start BzMiner as root, then try again.";
  }
  return text.slice(0, 300) || "Hog could not change BzMiner.";
}
export const MAX_MINER_LAUNCHERS = 6;
const LAUNCHER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const POOL_LINE = /^POOL="stratum\+tcp:\/\/[^"\r\n]*"\s*$/m;

function poolHost(raw) {
  let host = String(raw || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

/** This arg is bzminer pointed at Hog's own stratum: loopback, a tailnet address, or a .ts.net name. */
export function hogPoolArg(arg, port) {
  const text = String(arg || "");
  const match = text.match(/stratum\+tcp:\/\/(\[[0-9a-f:]+\]|[^:/\s]+):(\d+)/i);
  if (!match || Number(match[2]) !== Number(port)) return false;
  const host = poolHost(match[1]);
  if (host === "127.0.0.1") return true;
  if (isTailnetIpv4(host) || isTailnetIpv6(host)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

/**
 * A pool the phone may ask a rig to use. Loopback means this computer's node.
 * Anything else has to be a Tailscale address or MagicDNS name. Returns the
 * canonical URL, or "" when the value is not allowed.
 */
export function canonicalMinerPool(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^stratum\+tcp:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d+)$/i);
  if (!match) return "";
  const port = Number(match[2]);
  if (!hogPoolArg(`stratum+tcp://${match[1]}:${port}`, port)) return "";
  const host = poolHost(match[1]);
  const literal = host.includes(":") ? `[${host}]` : host;
  return `stratum+tcp://${literal}:${port}`;
}

/** Replace the POOL= line. Leaves the wallet, the worker, and comments alone. */
export function rewriteMinerPool(text, poolUrl) {
  const pool = canonicalMinerPool(poolUrl);
  if (!pool) return { ok: false, error: "That is not a Tailscale stratum address." };
  if (!POOL_LINE.test(String(text))) return { ok: false, error: "Hog could not find POOL=\"stratum+tcp://...\" in start_warthog.sh." };
  return { ok: true, text: String(text).replace(POOL_LINE, `POOL="${pool}"`) };
}

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

/** "~/Downloads/..." when the path is inside home. The saved path stays absolute. */
export function homePathNote(script, home = homedir()) {
  const text = String(script || "");
  const root = String(home || "").replace(/[\\/]+$/, "");
  if (root && (text === root || text.startsWith(root + sep))) return `~${text.slice(root.length)}`;
  return text;
}

/** "~/rest" becomes an absolute path in home. Other text is unchanged. */
export function expandHomePath(script, home = homedir()) {
  const text = String(script || "").trim();
  if (text === "~") return String(home || "");
  if (text.startsWith("~/") || text.startsWith(`~${sep}`)) return join(String(home || ""), text.slice(2));
  return text;
}

export function launcherName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  return LAUNCHER_NAME.test(name) ? name : "";
}

function launcherIdFor(script) {
  return createHash("sha256").update(String(script)).digest("hex").slice(0, 16);
}

function labelForScript(script) {
  return launcherName(basename(dirname(String(script || "")))) || "Start file";
}

function sameScript(a, b) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** { script, launchers: [{ id, name, script }] } from miner.json, or from nothing. */
export function normalizeMinerConfig(raw) {
  const launchers = [];
  const seenPaths = new Set();
  const seenIds = new Set();
  const items = raw && typeof raw === "object" && Array.isArray(raw.launchers) ? raw.launchers : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const script = typeof item.script === "string" ? item.script.trim() : "";
    if (!script || script.length > 500 || seenPaths.has(script)) continue;
    const id = /^[a-f0-9]{16}$/.test(item.id) ? item.id : launcherIdFor(script);
    if (seenIds.has(id)) continue;
    seenPaths.add(script);
    seenIds.add(id);
    launchers.push({ id, name: launcherName(item.name) || labelForScript(script), script });
    if (launchers.length >= MAX_MINER_LAUNCHERS) break;
  }
  let script = raw && typeof raw === "object" && typeof raw.script === "string" ? raw.script.trim() : "";
  if (script.length > 500) script = "";
  if (script && !seenPaths.has(script)) {
    const id = launcherIdFor(script);
    if (!seenIds.has(id)) {
      launchers.unshift({ id, name: labelForScript(script), script });
      if (launchers.length > MAX_MINER_LAUNCHERS) launchers.pop();
    }
  }
  return { script, launchers };
}

function decorateLauncher(item, home) {
  return {
    id: item.id,
    name: item.name,
    path: homePathNote(item.script, home),
    active: false,
    problem: minerScriptProblem(item.script, home),
  };
}

/**
 * Saved start files for the settings page and the phone.
 * `path` is the note under the name. `pinnedScript` is HOG_MINER_SCRIPT, used
 * only when miner.json does not exist yet.
 */
export function launcherView(config, { home = homedir(), pinnedScript = "" } = {}) {
  const normalized = normalizeMinerConfig(config);
  const defScript = defaultMinerScript(home);
  const items = normalized.launchers.map((item) => decorateLauncher(item, home));
  if (!normalized.launchers.some((item) => sameScript(item.script, defScript))) {
    items.unshift(decorateLauncher({ id: "default", name: "Downloads", script: defScript }, home));
  }
  const pinned = String(pinnedScript || "").trim();
  const activeScript = normalized.script || (pinned ? "" : defScript);
  let marked = false;
  if (!pinned) {
    for (const item of items) {
      const stored = item.id === "default" ? defScript : (normalized.launchers.find((row) => row.id === item.id)?.script || "");
      item.active = !marked && sameScript(stored, activeScript);
      if (item.active) marked = true;
    }
    if (!marked && items[0]) items[0].active = true;
  }
  if (pinned) {
    items.unshift({
      id: "pinned",
      name: "From HOG_MINER_SCRIPT",
      path: homePathNote(pinned, home),
      active: true,
      problem: minerScriptProblem(pinned, home),
    });
  }
  return {
    launcherPinned: Boolean(pinned),
    launcherNote: pinned ? "HOG_MINER_SCRIPT is set, and no start file is saved yet. The line under that name is the path Hog starts. Save one by name to choose a different file." : "",
    launchers: items,
  };
}

function cleanLauncherScript(script, home) {
  const expanded = expandHomePath(script, home);
  if (!expanded || expanded.length > 500) return { ok: false, error: "Enter the path to start_warthog.sh." };
  const problem = minerScriptProblem(expanded, home);
  if (problem) return { ok: false, error: problem };
  return { ok: true, script: expanded };
}

export function addMinerLauncher(config, { name, script, home = homedir() } = {}) {
  const cleanName = launcherName(name);
  if (!cleanName) return { ok: false, error: "Name the start file with letters, numbers, spaces, dots, or dashes (up to 40 characters)." };
  const cleaned = cleanLauncherScript(script, home);
  if (!cleaned.ok) return cleaned;
  const normalized = normalizeMinerConfig(config);
  const visible = launcherView(normalized, { home }).launchers.filter((item) => item.id !== "pinned");
  if (visible.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
    return { ok: false, error: "That name is already used." };
  }
  if (normalized.launchers.some((item) => sameScript(item.script, cleaned.script)) || sameScript(cleaned.script, defaultMinerScript(home))) {
    return { ok: false, error: "That start file is already saved." };
  }
  if (normalized.launchers.length >= MAX_MINER_LAUNCHERS) {
    return { ok: false, error: "Hog keeps 6 start files. Remove one to add another." };
  }
  return {
    ok: true,
    config: {
      script: cleaned.script,
      launchers: [...normalized.launchers, { id: launcherIdFor(cleaned.script), name: cleanName, script: cleaned.script }],
    },
  };
}

export function selectMinerLauncher(config, id, home = homedir()) {
  const picked = String(id || "");
  if (picked !== "default" && !/^[a-f0-9]{16}$/.test(picked)) return { ok: false, error: "Pick a saved start file." };
  const normalized = normalizeMinerConfig(config);
  if (picked === "default") {
    const problem = minerScriptProblem(defaultMinerScript(home), home);
    if (problem) return { ok: false, error: problem };
    return { ok: true, config: { script: "", launchers: normalized.launchers } };
  }
  const item = normalized.launchers.find((row) => row.id === picked);
  if (!item) return { ok: false, error: "Hog does not have that start file saved." };
  const problem = minerScriptProblem(item.script, home);
  if (problem) return { ok: false, error: problem };
  return { ok: true, config: { script: item.script, launchers: normalized.launchers } };
}

export function removeMinerLauncher(config, id, home = homedir()) {
  const picked = String(id || "");
  if (picked === "default" || picked === "pinned") return { ok: false, error: "That start file stays in the list." };
  if (!/^[a-f0-9]{16}$/.test(picked)) return { ok: false, error: "Pick a saved start file." };
  const normalized = normalizeMinerConfig(config);
  const item = normalized.launchers.find((row) => row.id === picked);
  if (!item) return { ok: false, error: "Hog does not have that start file saved." };
  const launchers = normalized.launchers.filter((row) => row.id !== picked);
  const script = normalized.script === item.script ? "" : normalized.script;
  return { ok: true, config: { script, launchers } };
}

export function applyMinerLauncher(config, input, home = homedir()) {
  const op = input && typeof input === "object" ? String(input.op || "") : "";
  if (op === "add") return addMinerLauncher(config, { name: input.name, script: input.script, home });
  if (op === "select") return selectMinerLauncher(config, input.id, home);
  if (op === "remove") return removeMinerLauncher(config, input.id, home);
  return { ok: false, error: "Use add, select, or remove." };
}

/** "miner", "launcher", or "" for one process command line. */
export function classifyMinerProc(args, { script, port }) {
  if (!Array.isArray(args) || args.length === 0) return "";
  const bin = String(args[0]).split(/[/\\]/).pop();
  const isMiner = bin === "bzminer" || args.some((arg) => arg === "./bzminer" || String(arg).endsWith("/bzminer"));
  if (isMiner && args.includes("warthog") && args.some((arg) => hogPoolArg(arg, port))) return "miner";
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
 *   rootHelper?: string, systemdRun?: string }} [options]
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
  systemdRun = existsSync(SYSTEMD_RUN) ? SYSTEMD_RUN : "",
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

  /** sudo -n the installed helper, from outside Hog when systemd-run is there. */
  function runRoot(action) {
    return new Promise((resolve) => {
      let child;
      const [cmd, args] = minerRootArgv(rootHelper, action, systemdRun);
      try {
        child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve({ ok: false, error: "Hog could not run the miner helper." });
        return;
      }
      if (!child || typeof child.on !== "function") {
        resolve({ ok: false, error: "Hog could not run the miner helper." });
        return;
      }
      let err = "";
      const take = (chunk) => {
        err = `${err}${chunk}`.slice(-600);
      };
      if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", take);
      if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", take);
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
        finish({ ok: false, error: rootFailure(err.trim()) });
      });
    });
  }

  function status() {
    const problem = minerScriptProblem(script(), home);
    if (problem) return { state: "missing", error: problem };
    if (matched().length) return { state: "running", error: "" };
    return { state: "stopped", error: lastError };
  }

  async function start(options = {}) {
    if (busy) return busy;
    const pool = options && typeof options.pool === "string" ? options.pool : "";
    busy = doStart(pool).finally(() => {
      busy = null;
    });
    return busy;
  }

  function pointScript(path, pool) {
    if (!pool) return "";
    if (!canonicalMinerPool(pool)) return "That is not a Tailscale stratum address.";
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return "Hog could not read start_warthog.sh.";
    }
    const applied = rewriteMinerPool(text, pool);
    if (!applied.ok) return applied.error;
    if (applied.text === text) return "";
    try {
      writeFileSync(path, applied.text);
    } catch {
      return "Hog could not set the pool in start_warthog.sh.";
    }
    return "";
  }

  async function doStart(pool = "") {
    const path = script();
    const problem = minerScriptProblem(path, home);
    if (problem) {
      lastError = problem;
      return { ok: false, started: false, ...status() };
    }
    if (pool && !canonicalMinerPool(pool)) {
      lastError = "That is not a Tailscale stratum address.";
      return { ok: false, started: false, ...status() };
    }
    if (matched().length) {
      if (pool) {
        let current = "";
        try { current = readFileSync(path, "utf8"); } catch { current = ""; }
        const applied = current ? rewriteMinerPool(current, pool) : { ok: false, text: "" };
        if (applied.ok && applied.text !== current) {
          lastError = "Stop the miner before changing which node it mines to.";
          return { ok: false, started: false, ...status(), error: lastError };
        }
      }
      lastError = "";
      return { ok: true, started: false, ...status() };
    }
    const pointed = pointScript(path, pool);
    if (pointed) {
      lastError = pointed;
      return { ok: false, started: false, ...status(), error: pointed };
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
