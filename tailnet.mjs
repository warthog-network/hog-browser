// Tailnet helpers for "Allow rigs on my tailnet" (solo mining).
//
// Tailscale gives this computer an address in 100.64.0.0/10 (IPv4) and
// fd7a:115c:a1e0::/48 (IPv6) on its tailscale interface. Hog's stratum can
// listen on those addresses as well as 127.0.0.1, and only accepts peers from
// those ranges or loopback. It never listens on 0.0.0.0 or a LAN address.
import { networkInterfaces } from "node:os";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const MAGIC_DNS = "100.100.100.100";

function ipv4Number(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Drop an IPv4-mapped IPv6 prefix and a zone id. */
export function normalizeIp(raw) {
  let ip = String(raw || "").trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

/** 100.64.0.0/10 */
export function isTailnetIpv4(raw) {
  const n = ipv4Number(normalizeIp(raw));
  return n !== null && (n >>> 22) === (((100 << 24) >>> 0) + (64 << 16)) >>> 22;
}

/** fd7a:115c:a1e0::/48 */
export function isTailnetIpv6(raw) {
  const ip = normalizeIp(raw);
  if (isIP(ip) !== 6) return false;
  const groups = expandIpv6(ip);
  return groups !== null && groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
}

function expandIpv6(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

export function isLoopback(raw) {
  const ip = normalizeIp(raw);
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

/** Who may talk to the stratum port: loopback always, tailnet peers only if allowed. */
export function stratumPeerAllowed(raw, allowTailnet) {
  if (isLoopback(raw)) return true;
  return Boolean(allowTailnet) && (isTailnetIpv4(raw) || isTailnetIpv6(raw));
}

/**
 * This computer's tailnet addresses, IPv4 first. Only addresses in the
 * tailnet ranges count, so a LAN or public address is never returned.
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 */
export function tailnetAddresses(ifaces = networkInterfaces()) {
  const v4 = [];
  const v6 = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const entry of list || []) {
      if (entry.internal) continue;
      const address = normalizeIp(entry.address);
      if (isTailnetIpv4(address)) v4.push({ name, address, family: 4 });
      else if (isTailnetIpv6(address)) v6.push({ name, address, family: 6 });
    }
  }
  // Prefer the interface Tailscale names (tailscale0 on Linux, "Tailscale" on Windows).
  const rank = (a) => (/tailscale/i.test(a.name) ? 0 : 1);
  v4.sort((a, b) => rank(a) - rank(b));
  v6.sort((a, b) => rank(a) - rank(b));
  return [...v4, ...v6];
}

const dnsCache = new Map();
/**
 * MagicDNS name for a tailnet IPv4 (e.g. hog.tail314642.ts.net), asked of
 * Tailscale's resolver directly so it works even when the OS does not use it.
 * Returns "" if it does not resolve back to the same address.
 */
export async function magicDnsName(ip, { timeoutMs = 1500 } = {}) {
  if (!isTailnetIpv4(ip)) return "";
  const cached = dnsCache.get(ip);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.name;
  let name = "";
  try {
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([MAGIC_DNS]);
    const names = await resolver.reverse(ip);
    const candidate = String(names?.[0] || "").replace(/\.$/, "").toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(candidate)) {
      const back = await resolver.resolve4(candidate);
      if (back.includes(ip)) name = candidate;
    }
  } catch {
    name = "";
  }
  dnsCache.set(ip, { name, at: Date.now() });
  return name;
}

/** Suggest a BzMiner -r name for a remote rig. */
export function rigNameSuggestion(network, index = 2) {
  return `rig${index}-${network || "defi"}`;
}
