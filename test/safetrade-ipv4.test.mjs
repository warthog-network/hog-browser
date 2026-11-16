import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the SafeTrade proxy resolves names as IPv4", () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const SAFE_TRADE_PY = `");
  const end = source.indexOf("`;", start);
  assert.ok(start > 0 && end > start);
  const py = source.slice(start + "const SAFE_TRADE_PY = `".length, end);
  const head = py.split("incoming = json.load")[0];
  assert.match(head, /socket\.AF_INET/);
  const probe = `${head}
infos = socket.getaddrinfo("localhost", 9)
assert infos, "no address"
assert all(item[0] == socket.AF_INET for item in infos), infos
assert all(":" not in item[4][0] for item in infos), infos
print("ipv4")
`;
  const ran = spawnSync("python3", ["-c", probe], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  assert.match(ran.stdout, /ipv4/);
});
