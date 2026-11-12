// Build the Warthog mining helper as one Windows .exe (Node single executable
// application). Run on Windows (CI: windows-latest):
//   node helper/build-sea.mjs            -> dist/Warthog-Mining-Helper.exe (+ .sha256)
// Steps: bundle helper + ws into one CommonJS file (esbuild), embed it and the
// patched node builds as a SEA blob, then inject that into a copy of the
// official node.exe from nodejs.org, verified against SHASUMS256.txt.
// Downloads go to a cache folder; postject runs from that cache (no global installs).
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_VERSION = process.env.NODE_VERSION || "v22.23.1";
const POSTJECT = "postject@1.0.0-alpha.6";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const cache = process.env.HELPER_BUILD_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "warthog-mining-helper-build");
const work = join(root, "dist", "sea");
const out = join(root, "dist");
const exe = join(out, "Warthog-Mining-Helper.exe");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

if (platform() !== "win32" && !process.env.HELPER_SEA_BUNDLE_ONLY) {
  console.error("Build the .exe on Windows (or set HELPER_SEA_BUNDLE_ONLY=1 to only bundle).");
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(cache, { recursive: true });

// 1. One CommonJS file: SEA runs a single CommonJS script with builtins only.
await esbuild.build({
  entryPoints: [join(root, "helper", "sea-entry.cjs")],
  outfile: join(work, "helper.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'var __hogMetaUrl = require("node:url").pathToFileURL(process.execPath).href;' },
  define: { "import.meta.url": "__hogMetaUrl", "process.env.WARTHOG_HELPER_MAIN": '"1"' },
  logLevel: "warning",
});

const assets = {
  "node-defi/wart-node.js": join(root, "node-defi", "wart-node.js"),
  "node-defi/wart-node.wasm": join(root, "node-defi", "wart-node.wasm"),
  "node-mainnet/wart-node.js": join(root, "node-mainnet", "wart-node.js"),
  "node-mainnet/wart-node.wasm": join(root, "node-mainnet", "wart-node.wasm"),
  "README.md": join(root, "helper", "README.md"),
};
writeFileSync(join(work, "sea-config.json"), JSON.stringify({
  main: join(work, "helper.cjs"),
  output: join(work, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));
if (process.env.HELPER_SEA_BUNDLE_ONLY) {
  console.log(join(work, "helper.cjs"));
  process.exit(0);
}

// 2. Official node.exe, checked against nodejs.org SHASUMS256.txt.
const zipName = `node-${NODE_VERSION}-win-x64.zip`;
const zip = join(cache, zipName);
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  copyFileSync(`${file}.part`, file);
  rmSync(`${file}.part`);
}
const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash("sha256");
  createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});
if (!existsSync(zip)) await download(`https://nodejs.org/dist/${NODE_VERSION}/${zipName}`, zip);
const sums = await (await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text();
const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === zipName)?.[0];
const actual = await sha256(zip);
if (!expected || expected !== actual) {
  rmSync(zip, { force: true });
  throw new Error(`Node zip checksum mismatch (expected ${expected || "none"}, got ${actual})`);
}
console.log(`node ${NODE_VERSION} win-x64 sha256 OK: ${actual}`);
const unz = join(cache, `node-${NODE_VERSION}-win-x64`);
if (!existsSync(join(unz, "node.exe"))) {
  run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${cache}' -Force`]);
}
const nodeExe = join(unz, "node.exe");

// 3. SEA blob, made by the same Node build that will run it.
run(nodeExe, ["--experimental-sea-config", join(work, "sea-config.json")]);

// 4. Inject into a copy of node.exe. postject comes from a local cache folder.
const pj = join(cache, "postject");
if (!existsSync(join(pj, "node_modules", "postject", "dist", "cli.js"))) {
  mkdirSync(pj, { recursive: true });
  writeFileSync(join(pj, "package.json"), '{"private":true}\n');
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-save", "--prefix", pj, POSTJECT], { shell: process.platform === "win32" });
}
rmSync(exe, { force: true });
copyFileSync(nodeExe, exe);
// node.exe is Authenticode-signed; the injected copy is not (signature would be invalid).
try {
  run("signtool", ["remove", "/s", exe], { stdio: "ignore" });
} catch {}
run(process.execPath, [join(pj, "node_modules", "postject", "dist", "cli.js"), exe, "NODE_SEA_BLOB", join(work, "sea-prep.blob"), "--sentinel-fuse", FUSE]);
const hash = await sha256(exe);
writeFileSync(`${exe}.sha256`, `${hash}  Warthog-Mining-Helper.exe\n`);
const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "helper", "helper.mjs"), "utf8"))[1];
console.log(`${exe} (helper ${version}) sha256 ${hash}`);
