import assert from "node:assert/strict";
import test from "node:test";

const SSH_CAPS = ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE", "SYS_CHROOT", "AUDIT_WRITE", "KILL"];

function publishSpec(port) {
  const body = `${port.host}:${port.dest}/${port.proto}`;
  return port.bind ? `${port.bind}:${body}` : body;
}

function imageBringsCommand(image) {
  const text = String(image || "").toLowerCase();
  return text.includes("wireguard") || text.includes("tailscale") || text.includes("cartesi") || text.includes("jellyfin");
}

function allowedLaunchNetwork(name, image, network) {
  if (!network) return true;
  const img = String(image || "").toLowerCase();
  if (network === "hog-tailscale" || network === "host") {
    return name === "tailscale" && img.includes("tailscale");
  }
  return false;
}

function composeCommand(spec) {
  const parts = ["docker", "run", "-d", "--name", spec.name, "--cap-drop=ALL"];
  for (const cap of SSH_CAPS) parts.push(`--cap-add=${cap}`);
  if (spec.vpn) parts.push("--cap-add=NET_ADMIN", "--device", "/dev/net/tun");
  parts.push("--pids-limit", "1024", "--memory", "2g", "--memory-swap", "2g");
  if (spec.network) parts.push("--network", spec.network);
  if (spec.network !== "host") {
    for (const port of spec.ports || []) parts.push("-p", publishSpec(port));
    for (const item of spec.sysctls || []) parts.push("--sysctl", item);
  }
  for (const item of spec.env || []) parts.push("-e", item);
  parts.push(spec.image);
  if (spec.command && spec.command.length) parts.push(...spec.command);
  else if (!imageBringsCommand(spec.image)) parts.push("sleep", "infinity");
  return parts.join(" ");
}

function readLaunch(text) {
  const raw = String(text || "").trim();
  if (!raw || /['"`$\\;&|<>]/.test(raw)) return null;
  const tokens = raw.split(/\s+/);
  if (tokens.length < 4 || tokens[0] !== "docker" || tokens[1] !== "run") return null;
  let name = "";
  const ports = [];
  const env = [];
  const sysctls = [];
  let vpn = false;
  let network = "";
  const positional = [];
  let index = 2;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-d" || token === "--detach") { index += 1; continue; }
    if (token === "--cap-drop=ALL" || token === "--cap-drop=CAP_ALL") { index += 1; continue; }
    if (token.startsWith("--cap-add=")) {
      const cap = token.slice("--cap-add=".length).toUpperCase().replace(/^CAP_/, "");
      if (cap === "NET_ADMIN") vpn = true;
      else if (!SSH_CAPS.includes(cap)) return null;
      index += 1;
      continue;
    }
    if (token === "--device") {
      if (tokens[index + 1] !== "/dev/net/tun") return null;
      index += 2;
      continue;
    }
    if (token === "--name") { name = tokens[index + 1] || ""; index += 2; continue; }
    if (token === "--pids-limit" || token === "--memory" || token === "--memory-swap") { index += 2; continue; }
    if (token === "-e" || token === "--env") { env.push(tokens[index + 1]); index += 2; continue; }
    if (token === "--sysctl") { sysctls.push(tokens[index + 1]); index += 2; continue; }
    if (token === "-p" || token === "--publish") {
      const spec = tokens[index + 1] || "";
      const match = /^(?:(?<bind>(?:\d{1,3}\.){3}\d{1,3}):)?(?<host>\d{1,5}):(?<dest>\d{1,5})(?:\/(?<proto>tcp|udp))?$/.exec(spec);
      if (!match) return null;
      ports.push({
        bind: match.groups.bind || "",
        host: match.groups.host,
        dest: match.groups.dest,
        proto: match.groups.proto || "tcp",
      });
      index += 2;
      continue;
    }
    if (token === "--network" || token === "--net") {
      const value = tokens[index + 1];
      if ((value !== "hog-tailscale" && value !== "host") || network) return null;
      network = value;
      index += 2;
      continue;
    }
    if (token.startsWith("-")) return null;
    positional.push(token);
    index += 1;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name) || !positional.length) return null;
  const image = positional[0];
  if (network && !allowedLaunchNetwork(name, image, network)) return null;
  return { name, image, ports, vpn, command: positional.slice(1), env, sysctls, network };
}

function validNetworkName(name, allowBuiltin = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name || "")) return false;
  if (!allowBuiltin && ["bridge", "host", "none"].includes(name)) return false;
  return true;
}

function validCidr(text) {
  const raw = String(text || "").trim();
  if (!raw.includes("/")) return false;
  const [addr, prefix] = raw.split("/");
  const number = Number(prefix);
  if (!Number.isInteger(number)) return false;
  if (/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(addr)) {
    return number >= 0 && number <= 32;
  }
  if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(":")) {
    return number >= 0 && number <= 128;
  }
  return false;
}

const tailscaleEnv = [
  "TS_HOSTNAME=hog",
  "TS_USERSPACE=false",
  "TS_AUTH_ONCE=true",
  "TS_STATE_DIR=/var/lib/tailscale",
  "TS_EXTRA_ARGS=--advertise-exit-node",
  "TS_BOOT_TIMEOUT=10m",
  "TS_DEBUG_FIREWALL_MODE=nftables",
];

test("desktop Tailscale command uses hog-tailscale and keeps sysctls", () => {
  const text = composeCommand({
    name: "tailscale",
    image: "tailscale/tailscale:latest",
    ports: [],
    vpn: true,
    command: [],
    env: tailscaleEnv,
    sysctls: ["net.ipv4.ip_forward=1", "net.ipv6.conf.all.forwarding=1"],
    network: "hog-tailscale",
  });
  assert.match(text, /--network hog-tailscale/);
  assert.doesNotMatch(text, /--network host/);
  assert.match(text, /--sysctl net.ipv4.ip_forward=1/);
  assert.match(text, /-e TS_USERSPACE=false/);
  assert.equal(readLaunch(text).network, "hog-tailscale");
});

test("engine Tailscale command uses host networking and drops published ports", () => {
  const text = composeCommand({
    name: "tailscale",
    image: "tailscale/tailscale:latest",
    ports: [{ bind: "127.0.0.1", host: "41641", dest: "41641", proto: "udp" }],
    vpn: true,
    command: [],
    env: tailscaleEnv,
    sysctls: ["net.ipv4.ip_forward=1"],
    network: "host",
  });
  assert.match(text, /--network host/);
  assert.doesNotMatch(text, /-p /);
  assert.doesNotMatch(text, /--sysctl/);
  assert.doesNotMatch(text, /NET_RAW/);
  const parsed = readLaunch(text);
  assert.equal(parsed.network, "host");
  assert.equal(parsed.name, "tailscale");
});

test("readLaunch rejects host networking on other images", () => {
  assert.equal(readLaunch("docker run -d --name ubuntu --network host ubuntu:24.04 sleep infinity"), null);
  assert.equal(readLaunch("docker run -d --name demo --network hog-tailscale tailscale/tailscale:latest"), null);
});

test("network names and CIDR values are validated", () => {
  assert.equal(validNetworkName("hog-app"), true);
  assert.equal(validNetworkName("bridge"), false);
  assert.equal(validNetworkName("host"), false);
  assert.equal(validNetworkName("none"), false);
  assert.equal(validNetworkName("bridge", true), true);
  assert.equal(validCidr("172.28.0.0/16"), true);
  assert.equal(validCidr("fd00:686f:6700:1::/64"), true);
  assert.equal(validCidr("172.28.0.0"), false);
  assert.equal(validCidr("172.28.0.0/99"), false);
});

test("readLaunch only allows Tailscale's own networks", () => {
  assert.equal(readLaunch("docker run -d --name ubuntu --network hog-ai ubuntu:24.04 sleep infinity"), null);
  assert.equal(readLaunch("docker run -d --name hog-ollama --network hog-ai ollama/ollama:latest"), null);
  assert.equal(readLaunch("docker run -d --name ubuntu --network host ubuntu:24.04 sleep infinity"), null);
});
