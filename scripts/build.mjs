import { copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

// ethers ships community fallback credentials inside provider modules.
// Hog does not call those providers. Leave the defaults blank so a rebuild
// cannot copy the credentials into the committed bundles.
function stripEthersCommunityCredentials() {
  return {
    name: "strip-ethers-community-credentials",
    setup(build) {
      build.onLoad({ filter: /node_modules\/ethers\/lib\.esm\/providers\/provider-(?:ankr|alchemy|blockscout|infura|pocket)\.js$/ }, async (args) => {
        const contents = (await readFile(args.path, "utf8")).replace(
          /const (defaultApiKey|defaultProjectId|defaultApplicationId) = "(?:[^"\\]|\\.)*";/g,
          'const $1 = "";',
        );
        return { contents, loader: "js" };
      });
    },
  };
}

await esbuild.build({
  entryPoints: {
    "wallet-bundle": "src/wallet-core.js",
    "dapp-bundle": "src/dapp.js",
    "chains-bundle": "src/chains.js",
    "vault-worker": "src/vault-worker.js",
    "extra-bundle": "src/extra.js",
    "xterm-bundle": "src/terminal.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: "public",
  legalComments: "none",
  plugins: [stripEthersCommunityCredentials()],
  // warthog-js's package barrel re-exports Node-only TransactionContext.
  // Redirect the browser bundle to the wallet subset Hog actually uses.
  alias: {
    "warthog-js": join(here, "warthog-js-browser-entry.js"),
  },
});
copyFileSync("node_modules/xterm/css/xterm.css", "public/xterm.css");
