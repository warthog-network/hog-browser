import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseBzminerSnapshot, readBzminerSnapshot } from "../bz-stats.mjs";

const wallet = "a".repeat(48);

test("a BzMiner snapshot keeps hashrate and the rig name, and drops the wallet", () => {
  const parsed = parseBzminerSnapshot({
    summary: { total_hashrate: 431645550, avg_hashrate: 782348664.8, power_w: 192.6 },
    devices: [
      { name: "GPU 0", hashrate: 407285361, temp_c: 62, power_w: 82.5, accepted: 1, rejected: 0, stale: 0 },
      { name: "CPU", hashrate: "nope", temp_c: null, power_w: 110.1 },
    ],
    pools: [{ user: `${wallet}.hog-mainnet`, url: "stratum+tcp://127.0.0.1:3456" }],
  });
  assert.equal(parsed.hashrate, 431645550);
  assert.equal(parsed.worker, "hog-mainnet");
  assert.equal(parsed.powerW, 192.6);
  assert.equal(parsed.devices[0].tempC, 62);
  assert.equal(parsed.devices[1].hashrate, null);
  assert.equal(JSON.stringify(parsed).includes(wallet), false);
  assert.equal(JSON.stringify(parsed).includes("stratum"), false);
});

test("a snapshot without a total hashrate is not a reading", () => {
  assert.equal(parseBzminerSnapshot({ summary: {} }), null);
  assert.equal(parseBzminerSnapshot(null), null);
  assert.equal(parseBzminerSnapshot({ summary: { total_hashrate: 0 }, devices: [] }).hashrate, 0);
});

test("the reader only accepts a snapshot from the local dashboard", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/snapshot");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ summary: { total_hashrate: 1500 }, devices: [], pools: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const parsed = await readBzminerSnapshot({ port, timeoutMs: 1000 });
    assert.equal(parsed.hashrate, 1500);
    assert.equal(parsed.worker, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
