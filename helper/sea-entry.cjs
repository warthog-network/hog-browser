// Entry point of the Windows single-file helper (Node single executable app).
// The two patched node builds ride inside the .exe as SEA assets. Unpack them
// once per build into %LOCALAPPDATA%\warthog-mining-helper\runtime\<id>\ and
// point the helper there, then start the helper as usual.
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { homedir, platform } = require("node:os");
const { join } = require("node:path");

const FILES = ["node-defi/wart-node.js", "node-defi/wart-node.wasm", "node-mainnet/wart-node.js", "node-mainnet/wart-node.wasm", "README.md"];

function runtimeRoot() {
  if (process.env.WARTHOG_HELPER_RUNTIME_DIR) return process.env.WARTHOG_HELPER_RUNTIME_DIR;
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "warthog-mining-helper", "runtime");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "warthog-mining-helper", "runtime");
}

function unpack() {
  let sea;
  try {
    sea = require("node:sea");
  } catch {
    return;
  }
  if (!sea.isSea()) return;
  const blobs = FILES.map((name) => [name, Buffer.from(sea.getRawAsset(name))]);
  const id = createHash("sha256");
  for (const [name, body] of blobs) id.update(name).update(body);
  const dir = join(runtimeRoot(), id.digest("hex").slice(0, 16));
  for (const [name, body] of blobs) {
    const file = join(dir, ...name.split("/"));
    if (existsSync(file) && statSync(file).size === body.length) continue;
    mkdirSync(join(file, ".."), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, body);
    renameSync(part, file);
  }
  process.env.WARTHOG_HELPER_HOME = dir;
}

unpack();
require("./helper.mjs");
