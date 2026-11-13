import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Point Hog's Files at a temp folder before server.mjs reads the settings.
const base = realpathSync(mkdtempSync(join(tmpdir(), "hog-files-srv-")));
const shares = join(base, "hog-shares");
mkdirSync(shares, { recursive: true });
mkdirSync(join(base, "data"), { recursive: true });
writeFileSync(join(shares, "hello.txt"), "hi there");
process.env.HOG_SHARES_DIR = shares;
process.env.HOG_FILES_CONFIG = join(base, "data", "files.json");
process.env.HOG_DATA = join(base, "data");
const { startServer } = await import("../server.mjs");

function gateFrom(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  const match = list.join(";").match(/hog_gate=[^;]+/);
  assert.ok(match, "gate cookie");
  return match[0];
}

test("Files API needs Hog's gate cookie on the wallet host", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const bare = await fetch(`${origin}/api/files/list?root=shares&path=`);
    assert.equal(bare.status, 403);
    const raw = await fetch(`${origin}/api/files/raw?root=shares&path=hello.txt`);
    assert.equal(raw.status, 403);
    const cookie = gateFrom(await fetch(`${origin}/`));
    const listing = await fetch(`${origin}/api/files/list?root=shares&path=`, { headers: { cookie } });
    assert.equal(listing.status, 200);
    const body = await listing.json();
    assert.deepEqual(body.entries.map((e) => e.name), ["hello.txt"]);
    const file = await fetch(`${origin}/api/files/raw?root=shares&path=hello.txt`, { headers: { cookie } });
    assert.equal(await file.text(), "hi there");
    // Another host name (a page served on localhost) does not count.
    const other = await fetch(`http://localhost:${port}/api/files/list?root=shares&path=`, { headers: { cookie } });
    assert.equal(other.status, 403);
    // Cross-site fetches and changes without Hog's header are refused.
    const cross = await fetch(`${origin}/api/files/list?root=shares&path=`, { headers: { cookie, "sec-fetch-site": "cross-site" } });
    assert.equal(cross.status, 403);
    const forged = await fetch(`${origin}/api/files/mkdir`, { method: "POST", headers: { cookie, origin: "http://localhost:43110", "x-hog-files": "1" }, body: JSON.stringify({ root: "shares", path: "", name: "x" }) });
    assert.equal(forged.status, 403);
    const made = await fetch(`${origin}/api/files/mkdir`, { method: "POST", headers: { cookie, origin, "x-hog-files": "1" }, body: JSON.stringify({ root: "shares", path: "", name: "x" }) });
    assert.equal(made.status, 200);
    const roots = await (await fetch(`${origin}/api/files/roots`, { headers: { cookie } })).json();
    assert.equal(roots.roots[0].path, shares);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
