import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: {
    "wallet-bundle": "src/wallet-core.js",
    "dapp-bundle": "src/dapp.js",
    "chains-bundle": "src/chains.js",
    "vault-worker": "src/vault-worker.js",
    "xterm-bundle": "src/terminal.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: "public",
  legalComments: "none",
  // warthog-js's package barrel re-exports Node-only TransactionContext.
  // Redirect the browser bundle to the wallet subset Hog actually uses.
  alias: {
    "warthog-js": join(here, "warthog-js-browser-entry.js"),
  },
});
copyFileSync("node_modules/xterm/css/xterm.css", "public/xterm.css");
