// "Home network access" for Jellyfin (Settings → Containers → Jellyfin).
//
// Jellyfin's container publishes 127.0.0.1:8096 only, and Tailscale serve
// brings it to the tailnet. TVs such as Roku cannot run Tailscale, so this
// optional forwarder listens on this computer's private home-network IPv4
// addresses (10/8, 172.16/12, 192.168/16 on Wi-Fi or Ethernet) and pipes each
// connection to 127.0.0.1:8096. The container is never recreated.
//
// It never listens on 0.0.0.0, a Docker bridge, a VPN or Tailscale address,
// and it drops peers that are not on a private network, so a router port
// forward cannot expose Jellyfin to the internet through it.
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection, createServer, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { isLoopback, normalizeIp } from "./tailnet.mjs";

export const JELLYFIN_PORT = 8096;
const RECONCILE_MS = 15_000;

// Interfaces that are never "the home network": container bridges, VMs, VPNs.
const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|vnet|vmnet|vboxnet|tailscale|ts\d|tun|tap|wg|zt|lxc|lxd|incus|cni|flannel|cali|cilium|kube|podman|nerdctl|utun|ham|ipsec|ppp)/i;

function ipv4Parts(raw) {
  const ip = normalizeIp(raw);
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. */
export function isPrivateIpv4(raw) {
  const p = ipv4Parts(raw);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/** Who may use the home-network forwarder: loopback and private IPv4 peers. */
export function lanPeerAllowed(raw) {
  return isLoopback(raw) || isPrivateIpv4(raw);
}

/**
 * Private IPv4 addresses of this computer's real network interfaces
 * (Wi-Fi, Ethernet). Docker, VM, VPN and Tailscale interfaces are skipped.
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 */
export function lanAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const entry of list || []) {
      if (entry.internal) continue;
      const family = entry.family === 4 || entry.family === "IPv4" ? 4 : 6;
      if (family !== 4) continue;
      const address = normalizeIp(entry.address);
      if (!isPrivateIpv4(address)) continue;
      if (!out.some((a) => a.address === address)) out.push({ name, address, subnet: subnetOf(address, entry.cidr, entry.netmask) });
    }
  }
  return out;
}

/** "192.168.1.0/24" from an address and its cidr or netmask; "" if unknown. */
export function subnetOf(address, cidr, netmask) {
  const p = ipv4Parts(address);
  if (!p) return "";
  let bits = Number(String(cidr || "").split("/")[1]);
  if (!Number.isInteger(bits) && netmask) {
    const m = ipv4Parts(netmask);
    if (m) bits = m.reduce((n, octet) => n + (octet.toString(2).match(/1/g) || []).length, 0);
  }
  if (!Number.isInteger(bits) || bits < 8 || bits > 32) return "";
  const n = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${bits}`;
}

/** Whether Ubuntu's ufw firewall is switched on (readable without root). */
export function ufwEnabled(file = "/etc/ufw/ufw.conf") {
  try {
    return /^\s*ENABLED\s*=\s*yes\s*$/im.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export const UFW_COMMENT = "Jellyfin on home network (Hog)";
export const PKEXEC = "/usr/bin/pkexec";
export const UFW = "/usr/sbin/ufw";
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/;

/** A rule Hog may add: real LAN interface, private network address in CIDR form, valid port. */
export function validUfwRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  const { iface, subnet, port } = rule;
  if (typeof iface !== "string" || !IFACE_RE.test(iface) || VIRTUAL_IFACE.test(iface)) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(subnet || ""));
  if (!m) return false;
  const bits = Number(m[2]);
  if (bits < 8 || bits > 32 || !isPrivateIpv4(m[1])) return false;
  return subnetOf(m[1], `${m[1]}/${bits}`) === subnet;
}

function cleanRule(rule) {
  return { iface: rule.iface, subnet: rule.subnet, port: rule.port };
}

/** Rules for this computer's current home-network interfaces. */
export function ufwRulesFor(addresses, port = JELLYFIN_PORT) {
  const out = [];
  for (const a of addresses || []) {
    const rule = { iface: a?.name, subnet: a?.subnet, port };
    if (validUfwRule(rule) && !out.some((r) => r.iface === rule.iface && r.subnet === rule.subnet)) out.push(rule);
  }
  return out;
}

/** Fixed argv for ufw (no shell). */
export function ufwArgs(rule, remove = false) {
  if (!validUfwRule(rule)) throw new Error("That firewall rule is not valid.");
  const spec = ["allow", "in", "on", rule.iface, "from", rule.subnet, "to", "any", "port", String(rule.port), "proto", "tcp"];
  return remove ? ["delete", ...spec] : [...spec, "comment", UFW_COMMENT];
}

/** The line a user can paste into a terminal instead. */
export function ufwCommandText(rule, remove = false) {
  return `sudo ufw ${ufwArgs(rule, remove).map((a) => (a === UFW_COMMENT ? `'${a}'` : a)).join(" ")}`;
}

/** The ufw rules a user can run to let home devices in. */
export function ufwCommands(addresses, port = JELLYFIN_PORT) {
  return ufwRulesFor(addresses, port).map((rule) => ufwCommandText(rule));
}

/** Whether Hog can ask for the password with polkit's own dialog. */
export function canPrompt({ exists = existsSync } = {}) {
  return exists(PKEXEC) && exists(UFW);
}

/**
 * Runs ufw through pkexec, so polkit shows its own password dialog and Hog
 * never sees the password. execFile with a fixed argv, never a shell.
 * Resolves { ok, cancelled, error, output }.
 */
export function runUfw(rule, { remove = false, execFile = nodeExecFile, timeoutMs = 180_000 } = {}) {
  let args;
  try {
    args = [UFW, ...ufwArgs(rule, remove)];
  } catch (error) {
    return Promise.resolve({ ok: false, cancelled: false, error: error.message, output: "" });
  }
  return new Promise((resolve) => {
    execFile(PKEXEC, args, { timeout: timeoutMs, maxBuffer: 64_000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`.trim().slice(-400);
      if (!error) {
        resolve({ ok: true, cancelled: false, error: "", output });
        return;
      }
      const code = typeof error.code === "number" ? error.code : null;
      if (code === 126 || code === 127) {
        resolve({ ok: false, cancelled: true, error: "The password prompt was cancelled or not authorised. Nothing changed.", output });
      } else if (error.killed) {
        resolve({ ok: false, cancelled: false, error: "The password prompt timed out. Nothing changed.", output });
      } else if (error.code === "ENOENT") {
        resolve({ ok: false, cancelled: false, error: "pkexec is not available. Run the command below in a terminal instead.", output });
      } else {
        const last = output.split("\n").filter(Boolean).pop() || `ufw exited with ${code ?? "an error"}`;
        resolve({ ok: false, cancelled: false, error: `The firewall did not change: ${last}`, output });
      }
    });
  });
}

/**
 * Add or remove Hog's ufw rules. Allow uses this computer's current LAN
 * interfaces; remove uses the rules Hog recorded adding (and current ones).
 */
export async function changeFirewall(state, { remove = false, addresses = [], port = JELLYFIN_PORT, run = runUfw } = {}) {
  const current = ufwRulesFor(addresses, port);
  let targets = current;
  if (remove) {
    targets = [...state.rules];
    for (const rule of current) if (!targets.some((r) => r.iface === rule.iface && r.subnet === rule.subnet && r.port === rule.port)) targets.push(rule);
  }
  if (!targets.length) return { ok: false, error: remove ? "There is no Hog firewall rule to remove." : "This computer has no home-network address to allow." };
  for (const rule of targets) {
    const result = await run(rule, { remove });
    if (!result.ok) return { ok: false, cancelled: result.cancelled, error: result.error };
    if (remove) state.dropRule(rule);
    else state.addRule(rule);
  }
  return {
    ok: true,
    error: "",
    notice: remove ? "Removed Hog's firewall rule for Jellyfin." : "The firewall now lets devices on your home network reach Jellyfin.",
  };
}

export function lanUrls(addresses, port = JELLYFIN_PORT) {
  return addresses.map((a) => `http://${typeof a === "string" ? a : a.address}:${port}`);
}

/** Persisted on/off switch (default off) and the ufw rules Hog added. */
export function createLanState({ file }) {
  let enabled = false;
  let rules = [];
  try {
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      enabled = saved.enabled === true;
      rules = Array.isArray(saved.rules) ? saved.rules.filter((r) => validUfwRule(r)).map(cleanRule) : [];
    }
  } catch {
    enabled = false;
    rules = [];
  }
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const body = rules.length ? { enabled, rules } : { enabled };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  const same = (a, b) => a.iface === b.iface && a.subnet === b.subnet && a.port === b.port;
  return {
    get enabled() {
      return enabled;
    },
    get rules() {
      return rules.map((r) => ({ ...r }));
    },
    setEnabled(value) {
      enabled = value === true;
      save();
    },
    addRule(rule) {
      if (!validUfwRule(rule)) return;
      if (!rules.some((r) => same(r, rule))) rules.push(cleanRule(rule));
      save();
    },
    dropRule(rule) {
      rules = rules.filter((r) => !same(r, rule));
      save();
    },
  };
}

/** Quick check that something answers on the target (Jellyfin on this computer). */
export function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * TCP forwarder from this computer's LAN addresses to the local Jellyfin port.
 * Re-checks addresses every reconcileMs so a new DHCP lease or a Wi-Fi switch
 * is picked up, and a port that was busy is tried again.
 */
export function createLanForwarder({
  port = JELLYFIN_PORT,
  targetHost = "127.0.0.1",
  targetPort = JELLYFIN_PORT,
  findLan = lanAddresses,
  peerAllowed = lanPeerAllowed,
  hostAllowed = isPrivateIpv4,
  reconcileMs = RECONCILE_MS,
} = {}) {
  const servers = new Map();
  const sockets = new Set();
  let wanted = false;
  let timer = null;
  let error = "";
  let refused = 0;
  let listenPort = port;

  function pipe(client) {
    if (!peerAllowed(client.remoteAddress)) {
      refused += 1;
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  function listenOn(host) {
    const server = createServer(pipe);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: listenPort, host, exclusive: true }, () => {
        server.removeAllListeners("error");
        server.on("error", () => {});
        if (!listenPort) {
          const address = server.address();
          if (typeof address === "object" && address) listenPort = address.port;
        }
        resolve(server);
      });
    });
  }

  async function sync() {
    if (!wanted) return;
    let want = [];
    try {
      // Never a wildcard: only concrete addresses that pass hostAllowed (private IPv4).
      want = findLan().map((a) => normalizeIp(a.address)).filter((ip) => isIP(ip) === 4 && ip !== "0.0.0.0" && hostAllowed(ip));
    } catch {
      want = [];
    }
    for (const [host, srv] of servers) {
      if (!want.includes(host)) {
        srv.close();
        servers.delete(host);
      }
    }
    const problems = [];
    for (const host of want) {
      if (servers.has(host)) continue;
      try {
        const server = await listenOn(host);
        if (!wanted) {
          server.close();
          return;
        }
        servers.set(host, server);
      } catch (e) {
        problems.push(`${host}: ${e?.code === "EADDRINUSE" ? `port ${listenPort} is already in use` : e?.code || e?.message || e}`);
      }
    }
    error = problems.length
      ? `Could not listen on the home network (${problems.join("; ")}).`
      : want.length ? "" : "This computer has no home-network address right now. Connect to Wi-Fi or Ethernet.";
  }

  return {
    async start() {
      wanted = true;
      await sync();
      if (!timer) {
        timer = setInterval(() => sync().catch(() => {}), reconcileMs);
        timer.unref?.();
      }
    },
    async stop() {
      wanted = false;
      clearInterval(timer);
      timer = null;
      error = "";
      const all = [...servers.values()];
      servers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all(all.map((srv) => new Promise((resolve) => srv.close(() => resolve()))));
    },
    sync,
    status() {
      return { wanted, hosts: [...servers.keys()], port: listenPort, error, refused };
    },
  };
}

/** What the Jellyfin card shows. */
export async function lanStatus(state, forwarder, { findLan = lanAddresses, probe = probeTcp, targetHost = "127.0.0.1", targetPort = JELLYFIN_PORT, firewall = ufwEnabled, prompt = canPrompt } = {}) {
  const fwd = forwarder.status();
  let candidates = [];
  try {
    candidates = findLan();
  } catch {
    candidates = [];
  }
  const jellyfinUp = await probe(targetHost, targetPort).catch(() => false);
  return {
    ok: true,
    enabled: state.enabled,
    listening: fwd.hosts,
    port: fwd.port,
    urls: lanUrls(fwd.hosts, fwd.port),
    addresses: candidates.map((a) => ({ name: a.name, address: a.address, subnet: a.subnet || "" })),
    suggested: lanUrls(candidates, fwd.port),
    jellyfinUp,
    ufw: firewallStatus(state, candidates, fwd.port, { firewall, prompt }),
    error: state.enabled ? fwd.error : "",
  };
}

/** Firewall part of the card. "added" is what Hog itself added; other rules are unknown without root. */
export function firewallStatus(state, candidates, port = JELLYFIN_PORT, { firewall = ufwEnabled, prompt = canPrompt } = {}) {
  const added = state.rules || [];
  const current = ufwRulesFor(candidates, port);
  const known = (rule) => added.some((r) => r.iface === rule.iface && r.subnet === rule.subnet && r.port === rule.port);
  const removable = [...added];
  for (const rule of current) if (!known(rule)) removable.push(rule);
  if (!firewall()) return { enabled: false, canPrompt: false, needed: false, commands: [], added, removeCommands: added.map((r) => ufwCommandText(r, true)) };
  return {
    enabled: true,
    canPrompt: Boolean(prompt()),
    needed: current.some((rule) => !known(rule)),
    commands: current.map((rule) => ufwCommandText(rule)),
    added,
    removeCommands: removable.map((r) => ufwCommandText(r, true)),
  };
}
