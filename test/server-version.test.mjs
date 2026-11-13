import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import test from "node:test";
import { serverVersionInfo, startServer } from "../server.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("server reports its own version so a newer hog window can replace an old server", async () => {
  assert.deepEqual(serverVersionInfo(), { app: "hog-browser", version: pkg.version, pid: process.pid });
  const server = await startServer(0);
  const { port } = server.address();
  try {
    const reply = await get(port, "/__hog/version", `127.0.0.1:${port}`);
    assert.equal(reply.status, 200);
    const body = JSON.parse(reply.body);
    assert.equal(body.app, "hog-browser");
    assert.equal(body.version, pkg.version);
    // Only for Hog itself on the wallet host, not for a rebound site name.
    const other = await get(port, "/__hog/version", `evil.example:${port}`);
    assert.notEqual(other.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
