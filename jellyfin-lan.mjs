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

/** The ufw rules a user can run to let home devices in (Hog never runs them). */
export function ufwCommands(addresses, port = JELLYFIN_PORT) {
  const out = [];
  for (const a of addresses) {
    if (!a || !a.subnet || !/^[A-Za-z0-9_.:-]{1,15}$/.test(a.name || "")) continue;
    const cmd = `sudo ufw allow in on ${a.name} from ${a.subnet} to any port ${port} proto tcp comment 'Jellyfin on home network (Hog)'`;
    if (!out.includes(cmd)) out.push(cmd);
  }
  return out;
}

export function lanUrls(addresses, port = JELLYFIN_PORT) {
  return addresses.map((a) => `http://${typeof a === "string" ? a : a.address}:${port}`);
}

/** Persisted on/off switch. Default off. */
export function createLanState({ file }) {
  let enabled = false;
  try {
    if (file && existsSync(file)) enabled = JSON.parse(readFileSync(file, "utf8")).enabled === true;
  } catch {
    enabled = false;
  }
  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = value === true;
      if (!file) return;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
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
export async function lanStatus(state, forwarder, { findLan = lanAddresses, probe = probeTcp, targetHost = "127.0.0.1", targetPort = JELLYFIN_PORT, firewall = ufwEnabled } = {}) {
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
    ufw: firewall() ? { enabled: true, commands: ufwCommands(candidates, fwd.port) } : { enabled: false, commands: [] },
    error: state.enabled ? fwd.error : "",
  };
}
