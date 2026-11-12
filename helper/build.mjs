// Pack the Warthog mining helper into dist/warthog-mining-helper/:
// one bundled JS file (ws included), the two patched node builds, and launchers
// for Linux and Windows. It needs only Node 18+ on the user's computer.
// (A single .exe needs Node's SEA tooling; see helper/README.md.)
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "warthog-mining-helper");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "helper", "helper.mjs")],
  outfile: join(out, "warthog-mining-helper.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  // ws loads these native speedups only if present.
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  define: { "process.env.WARTHOG_HELPER_MAIN": '"1"' },
});

for (const net of ["node-defi", "node-mainnet"]) {
  mkdirSync(join(out, net));
  for (const f of ["wart-node.js", "wart-node.wasm", "SHA256SUMS", "README.md"]) copyFileSync(join(root, net, f), join(out, net, f));
}
copyFileSync(join(root, "helper", "README.md"), join(out, "README.md"));
copyFileSync(join(root, "public", "hog-icon-128.png"), join(out, "icon.png"));

writeFileSync(join(out, "warthog-mining-helper.sh"), `#!/bin/sh
HERE=$(dirname "$(readlink -f "$0")")
exec node "$HERE/warthog-mining-helper.mjs" "$@"
`);
chmodSync(join(out, "warthog-mining-helper.sh"), 0o755);
writeFileSync(join(out, "Warthog-Mining-Helper.cmd"), [
  "@echo off",
  "cd /d \"%~dp0\"",
  "where node >nul 2>&1 || (echo Install Node.js 18 or newer from https://nodejs.org/ first. & pause & exit /b 1)",
  "node warthog-mining-helper.mjs %*",
  "pause",
  "",
].join("\r\n"));
// Linux app-menu entry, like the IPv4 forwarder's. Copy it to
// ~/.local/share/applications/ (paths point at this folder).
writeFileSync(join(out, "warthog-mining-helper.desktop"), `[Desktop Entry]
Version=1.0
Type=Application
Name=Warthog mining helper
Comment=Solo mine with BzMiner to a Warthog browser node in Brave
Exec=${join(out, "warthog-mining-helper.sh")}
Icon=${join(out, "icon.png")}
StartupWMClass=warthog-mining-helper
Terminal=true
Categories=Network;
`);
const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "helper", "helper.mjs"), "utf8"))[1];
console.log(`${out} (helper ${version})`);
