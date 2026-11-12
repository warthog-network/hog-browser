import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { isLoopback, isTailnetIpv4, isTailnetIpv6, normalizeIp, rigNameSuggestion, stratumPeerAllowed, tailnetAddresses } from "../tailnet.mjs";
import { createStratumBridge } from "../stratum.mjs";

const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";

test("tailnet IPv4 is exactly 100.64.0.0/10", () => {
  for (const ip of ["100.64.0.0", "100.64.0.1", "100.119.132.89", "100.127.255.255", "::ffff:100.100.1.2"]) assert.ok(isTailnetIpv4(ip), ip);
  for (const ip of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "192.168.1.10", "0.0.0.0", "1.2.3.4", "100.64.0", "fd7a:115c:a1e0::1"]) assert.ok(!isTailnetIpv4(ip), ip);
});

test("tailnet IPv6 is exactly fd7a:115c:a1e0::/48", () => {
  for (const ip of ["fd7a:115c:a1e0::352c:845a", "FD7A:115C:A1E0:ab12::1", "fd7a:115c:a1e0::1%tailscale0"]) assert.ok(isTailnetIpv6(ip), ip);
  for (const ip of ["fd7a:115c:a1e1::1", "fd7a:115c::1", "fe80::1", "::1", "100.64.0.1", "2001:db8::1"]) assert.ok(!isTailnetIpv6(ip), ip);
});

test("stratum peers: loopback always, tailnet only when allowed, nothing else ever", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.5.5.5"]) {
    assert.ok(isLoopback(ip), ip);
    assert.ok(stratumPeerAllowed(ip, false), ip);
  }
  for (const ip of ["100.70.1.2", "::ffff:100.70.1.2", "fd7a:115c:a1e0::9"]) {
    assert.ok(!stratumPeerAllowed(ip, false), `${ip} refused when off`);
    assert.ok(stratumPeerAllowed(ip, true), `${ip} allowed when on`);
  }
  for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.0.1", "8.8.8.8", "fe80::1", "100.128.0.1", "", "garbage"]) {
    assert.ok(!stratumPeerAllowed(ip, true), ip);
  }
  assert.equal(normalizeIp("::FFFF:100.1.2.3"), "100.1.2.3");
});

test("only tailnet-range interface addresses are used; LAN, wildcard and internal never", () => {
  const found = tailnetAddresses({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    enp5s0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "0.0.0.0", family: "IPv4", internal: false }],
    eth9: [{ address: "100.80.0.9", family: "IPv4", internal: false }],
    tailscale0: [{ address: "100.119.132.89", family: "IPv4", internal: false }, { address: "fd7a:115c:a1e0::352c:845a", family: "IPv6", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
  });
  assert.deepEqual(found.map((a) => a.address), ["100.119.132.89", "100.80.0.9", "fd7a:115c:a1e0::352c:845a"]);
  assert.equal(rigNameSuggestion("mainnet"), "rig2-mainnet");
});

const reach = (port, host) => new Promise((resolve) => {
  const sock = connect(port, host);
  sock.setEncoding("utf8");
  sock.on("connect", () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
  sock.on("data", (d) => { resolve(JSON.parse(d.split("\n")[0]).id === 1 ? "served" : "odd"); sock.destroy(); });
  sock.on("error", (e) => resolve(e.code));
  sock.on("close", () => resolve("closed"));
});

test("toggle: tailnet listener appears and disappears; loopback stays", async () => {
  // 127.0.0.2 stands in for the Tailscale address so the test runs anywhere on Linux.
  const fake = () => [{ name: "tailscale0", address: "127.0.0.2", family: 4 }];
  const call = async () => ({ ok: false, code: "no-page" });
  const bridge = createStratumBridge({ call, findTailnet: fake, pollMs: 60_000 });
  const port = await bridge.start(0);
  try {
    assert.deepEqual(bridge.status().tailnetListening, []);
    assert.equal(bridge.status().allowTailnet, false);
    assert.equal(await reach(port, "127.0.0.2"), "ECONNREFUSED");
    await bridge.setTailnet(true);
    assert.deepEqual(bridge.status().tailnetListening, ["127.0.0.2"]);
    assert.deepEqual(bridge.status().stratumHosts, ["127.0.0.1", "127.0.0.2"]);
    assert.equal(await reach(port, "127.0.0.2"), "served");
    await bridge.setTailnet(false);
    assert.deepEqual(bridge.status().tailnetListening, []);
    assert.equal(await reach(port, "127.0.0.2"), "ECONNREFUSED");
    assert.equal(await reach(port, "127.0.0.1"), "served");
  } finally {
    await bridge.stop();
  }
});

test("toggle on with no Tailscale address reports it and stays loopback-only", async () => {
  const bridge = createStratumBridge({ call: async () => ({ ok: false }), findTailnet: () => [], pollMs: 60_000 });
  await bridge.start(0, { tailnet: true });
  try {
    assert.equal(bridge.status().allowTailnet, true);
    assert.deepEqual(bridge.status().tailnetListening, []);
    assert.match(bridge.status().tailnetError, /No Tailscale address/);
  } finally {
    await bridge.stop();
  }
});

test("per-rig stats: each -r name and source is listed", async () => {
  const bridge = createStratumBridge({ call: async () => ({ ok: false, code: "no-page" }), findTailnet: () => [], pollMs: 60_000 });
  const port = await bridge.start(0);
  const rig = (name) => new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(`{"id":2,"method":"mining.authorize","params":["${ADDRESS}.${name}","x"]}\n`));
    sock.setEncoding("utf8");
    sock.on("data", () => resolve(sock));
  });
  try {
    const a = await rig("rigA");
    const b = await rig("rigB");
    const workers = bridge.status().workers;
    assert.deepEqual(workers.map((w) => [w.worker, w.source, w.connected, w.remote]).sort(), [["rigA", "127.0.0.1", 1, false], ["rigB", "127.0.0.1", 1, false]]);
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.status().workers.find((w) => w.worker === "rigA").connected, 0);
    b.destroy();
  } finally {
    await bridge.stop();
  }
});

test("remote rig command uses the MagicDNS name, the IP as fallback, and bzminer.exe on Windows", async () => {
  const { tailnetMiningInfo } = await import("../server.mjs");
  const addresses = [{ name: "tailscale0", address: "100.119.132.89", family: 4 }];
  const info = tailnetMiningInfo({ allow: true, listening: ["100.119.132.89"], port: 3456, wallet: ADDRESS, network: "defi", dnsName: "hog.tail314642.ts.net", addresses });
  assert.equal(info.remoteCommand, `./bzminer -a warthog -p stratum+tcp://hog.tail314642.ts.net:3456 -w ${ADDRESS} -r rig2-defi`);
  assert.equal(info.remoteCommandIp, `./bzminer -a warthog -p stratum+tcp://100.119.132.89:3456 -w ${ADDRESS} -r rig2-defi`);
  assert.equal(info.remoteCommandWindows, `bzminer.exe -a warthog -p stratum+tcp://hog.tail314642.ts.net:3456 -w ${ADDRESS} -r rig2-defi`);
  const noDns = tailnetMiningInfo({ allow: true, listening: [], port: 3456, wallet: ADDRESS, network: "mainnet", dnsName: "", addresses });
  assert.match(noDns.remoteCommand, /stratum\+tcp:\/\/100\.119\.132\.89:3456 .* -r rig2-mainnet$/);
  assert.equal(noDns.remoteCommandIp, "");
  const none = tailnetMiningInfo({ allow: true, listening: [], port: 3456, network: "defi", dnsName: "", addresses: [] });
  assert.equal(none.tailnetAvailable, false);
  assert.equal(none.remoteCommand, "");
});
