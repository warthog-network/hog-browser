import { copyFileSync } from "node:fs";
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: {
    "wallet-bundle": "src/wallet-core.js",
    "dapp-bundle": "src/dapp.js",
    "chains-bundle": "src/chains.js",
    "xterm-bundle": "src/terminal.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: "public",
  legalComments: "none",
});
copyFileSync("node_modules/xterm/css/xterm.css", "public/xterm.css");
