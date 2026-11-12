import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const script = readFileSync(new URL("packaging/build-deb.sh", root), "utf8");

/** Local files a module pulls in with import or createRequire. */
function localDeps(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(new URL(file, root), "utf8");
  for (const m of text.matchAll(/(?:from\s+|import\(|require\()\s*["']\.\/([^"']+)["']/g)) {
    if (m[1].endsWith(".mjs")) localDeps(m[1], seen);
    else seen.add(m[1]);
  }
  for (const m of text.matchAll(/join\(APP_ROOT, "([^"]+)"\)/g)) seen.add(m[1]);
  return seen;
}

test("the .deb ships every local file server.mjs needs", () => {
  for (const dep of localDeps("server.mjs")) {
    const top = dep.split("/")[0];
    const listed = script.includes(`"\${HB}/${dep}"`) || script.includes(`"\${HB}/${top}" "\${APP}/"`);
    assert.ok(listed, `packaging/build-deb.sh does not copy ${dep}`);
  }
});

test("the .deb ships the Python modules the hog launcher imports", () => {
  const hog = readFileSync(new URL("hog", root), "utf8");
  const mods = [...hog.matchAll(/^from (\w+) import/gm)].map((m) => m[1]).filter((m) => !["gi", "pathlib"].includes(m));
  for (const mod of [...mods, "mobile_guard"]) assert.ok(script.includes(`"\${HB}/${mod}.py"`), `packaging/build-deb.sh does not copy ${mod}.py`);
});
