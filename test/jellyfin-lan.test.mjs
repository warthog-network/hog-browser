import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLanForwarder, createLanState, isPrivateIpv4, lanAddresses, lanPeerAllowed, lanStatus, lanUrls, subnetOf, ufwCommands, ufwEnabled } from "../jellyfin-lan.mjs";
import { writeFileSync } from "node:fs";
import { lanStateText } from "../public/jellyfin-lan.js";

const v4 = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", cidr: `${address}/24` });
const v6 = (address) => ({ address, family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::" });

test("private IPv4 is RFC1918 only", () => {
  for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.223", "::ffff:192.168.0.9"]) assert.ok(isPrivateIpv4(ip), ip);
  for (const ip of ["0.0.0.0", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.119.132.89", "127.0.0.1", "169.254.1.1", "fd00::1", "", "nope"]) assert.ok(!isPrivateIpv4(ip), ip);
});

test("peers: loopback and home network only, never the internet or the tailnet", () => {
  assert.ok(lanPeerAllowed("192.168.1.40"));
  assert.ok(lanPeerAllowed("::ffff:10.1.2.3"));
  assert.ok(lanPeerAllowed("127.0.0.1"));
  assert.ok(!lanPeerAllowed("203.0.113.7"));
  assert.ok(!lanPeerAllowed("100.82.142.120"));
  assert.ok(!lanPeerAllowed("2001:db8::1"));
});

test("LAN addresses skip Docker, VM, VPN, Tailscale, loopback and IPv6", () => {
  const found = lanAddresses({
    lo: [v4("127.0.0.1", true)],
    wlp4s0: [v4("192.168.1.223"), v6("fe80::1")],
    enp3s0: [v4("10.0.0.8")],
    docker0: [v4("172.17.0.1")],
    "br-1a2b3c": [v4("172.18.0.1")],
    veth12: [v4("172.17.0.9")],
    virbr0: [v4("192.168.122.1")],
    tailscale0: [v4("100.119.132.89"), v6("fd7a:115c:a1e0::1")],
    wg0: [v4("10.8.0.1")],
    eth9: [v4("8.8.4.4")],
  });
  assert.deepEqual(found, [{ name: "wlp4s0", address: "192.168.1.223", subnet: "192.168.1.0/24" }, { name: "enp3s0", address: "10.0.0.8", subnet: "10.0.0.0/24" }]);
  assert.deepEqual(lanUrls(found), ["http://192.168.1.223:8096", "http://10.0.0.8:8096"]);
});

test("setting is off by default and persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hog-lan-"));
  const file = join(dir, "sub", "jellyfin-lan.json");
  const state = createLanState({ file });
  assert.equal(state.enabled, false);
  state.setEnabled(true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: true });
  assert.equal(createLanState({ file }).enabled, true);
  state.setEnabled(false);
  assert.equal(createLanState({ file }).enabled, false);
});

function echoServer() {
  const server = createServer((socket) => socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("jf:"), chunk]))));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function talk(port, text) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let out = "";
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk) => {
      out += chunk;
      socket.end();
    });
    socket.on("close", () => resolve(out));
    socket.on("error", () => resolve(out));
  });
}

test("forwarder pipes to Jellyfin, follows address changes and stops cleanly", async () => {
  const upstream = await echoServer();
  let hosts = [{ address: "127.0.0.1" }, { address: "0.0.0.0" }];
  const fwd = createLanForwarder({ port: 0, targetPort: upstream.address().port, findLan: () => hosts, hostAllowed: () => true, reconcileMs: 60_000 });
  try {
    await fwd.start();
    const st = fwd.status();
    assert.deepEqual(st.hosts, ["127.0.0.1"], "never binds the wildcard even if offered");
    assert.ok(st.port > 0);
    assert.equal(await talk(st.port, "hello"), "jf:hello");
    hosts = [];
    await fwd.sync();
    assert.deepEqual(fwd.status().hosts, []);
    assert.match(fwd.status().error, /no home-network address/);
    hosts = [{ address: "127.0.0.1" }];
    await fwd.sync();
    assert.deepEqual(fwd.status().hosts, ["127.0.0.1"]);
  } finally {
    await fwd.stop();
    upstream.close();
  }
  assert.deepEqual(fwd.status().hosts, []);
  assert.equal(fwd.status().wanted, false);
});

test("forwarder drops peers that are not allowed", async () => {
  const upstream = await echoServer();
  const fwd = createLanForwarder({ port: 0, targetPort: upstream.address().port, findLan: () => [{ address: "127.0.0.1" }], hostAllowed: () => true, peerAllowed: () => false, reconcileMs: 60_000 });
  try {
    await fwd.start();
    assert.equal(await talk(fwd.status().port, "hello"), "");
    assert.equal(fwd.status().refused, 1);
  } finally {
    await fwd.stop();
    upstream.close();
  }
});

test("default forwarder refuses non-private hosts", async () => {
  const fwd = createLanForwarder({ port: 0, findLan: () => [{ address: "127.0.0.1" }, { address: "8.8.8.8" }], reconcileMs: 60_000 });
  await fwd.start();
  assert.deepEqual(fwd.status().hosts, []);
  await fwd.stop();
});

test("a busy port is reported and retried", async () => {
  const busy = createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const port = busy.address().port;
  const fwd = createLanForwarder({ port, targetPort: 1, findLan: () => [{ address: "127.0.0.1" }], hostAllowed: () => true, reconcileMs: 60_000 });
  try {
    await fwd.start();
    assert.deepEqual(fwd.status().hosts, []);
    assert.match(fwd.status().error, /already in use/);
    await new Promise((resolve) => busy.close(resolve));
    await fwd.sync();
    assert.deepEqual(fwd.status().hosts, ["127.0.0.1"]);
    assert.equal(fwd.status().error, "");
  } finally {
    await fwd.stop();
  }
});

test("status lists the URLs to type into a TV app", async () => {
  const state = { enabled: true };
  const fwd = { status: () => ({ hosts: ["192.168.1.223"], port: 8096, error: "" }) };
  const st = await lanStatus(state, fwd, { findLan: () => [{ name: "wlp4s0", address: "192.168.1.223" }], probe: async () => true });
  assert.deepEqual(st.urls, ["http://192.168.1.223:8096"]);
  assert.equal(st.jellyfinUp, true);
  assert.match(lanStateText(st), /^On\. Type this address/);
  const off = await lanStatus({ enabled: false }, { status: () => ({ hosts: [], port: 8096, error: "x" }) }, { findLan: () => [{ name: "wlp4s0", address: "192.168.1.223" }], probe: async () => false });
  assert.equal(off.error, "");
  assert.match(lanStateText(off), /^Off\..*http:\/\/192\.168\.1\.223:8096/);
  assert.match(lanStateText({ enabled: true, urls: ["http://10.0.0.2:8096"], jellyfinUp: false }), /not answering/);
  assert.match(lanStateText({ enabled: true, urls: [], error: "This computer has no home-network address right now." }), /^On, but not reachable yet/);
});

test("firewall hint: ufw detection and the command a user runs", () => {
  assert.equal(subnetOf("192.168.1.223", "192.168.1.223/24"), "192.168.1.0/24");
  assert.equal(subnetOf("10.4.5.6", "", "255.255.0.0"), "10.4.0.0/16");
  assert.equal(subnetOf("10.4.5.6", "", ""), "");
  const dir = mkdtempSync(join(tmpdir(), "hog-ufw-"));
  const conf = join(dir, "ufw.conf");
  writeFileSync(conf, "# ufw\nENABLED=yes\nLOGLEVEL=low\n");
  assert.equal(ufwEnabled(conf), true);
  writeFileSync(conf, "ENABLED=no\n");
  assert.equal(ufwEnabled(conf), false);
  assert.equal(ufwEnabled(join(dir, "missing")), false);
  assert.deepEqual(ufwCommands([{ name: "wlp4s0", address: "192.168.1.223", subnet: "192.168.1.0/24" }, { name: "bad;rm", address: "10.0.0.2", subnet: "10.0.0.0/24" }, { name: "eth0", address: "10.1.1.1", subnet: "" }]), [
    "sudo ufw allow in on wlp4s0 from 192.168.1.0/24 to any port 8096 proto tcp comment 'Jellyfin on home network (Hog)'",
  ]);
});
