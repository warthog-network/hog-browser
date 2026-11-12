// Stage Hog's local server and web UI for the Windows app:
//   stage/hog/server.mjs   server.mjs + mining/stratum/tailnet + ws, one file
//   stage/hog/public/      the wallet / tab UI (built bundles included)
//   stage/hog/node-defi/, node-mainnet/   patched node builds (POST /chain/append)
//   stage/hog/opfs-polyfill.js
//   gen/preload-page.cjs   page preload with the Linux shell's page scripts
// Run `npm run build` at the repo root first (wallet bundles).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const esbuild = require("esbuild");
const out = join(here, "stage", "hog");
rmSync(join(here, "stage"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ["public/wallet-bundle.js", "public/index.html", "public/app.js"]) {
  if (!existsSync(join(root, f))) throw new Error(`${f} is missing: run npm run build at the repo root`);
}

await esbuild.build({
  entryPoints: [join(root, "server.mjs")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire as __hogCr } from "node:module"; const require = __hogCr(import.meta.url);' },
  logLevel: "warning",
});
cpSync(join(root, "public"), join(out, "public"), { recursive: true });
for (const net of ["node-defi", "node-mainnet"]) cpSync(join(root, net), join(out, net), { recursive: true });
cpSync(join(root, "opfs-polyfill.js"), join(out, "opfs-polyfill.js"));
writeFileSync(join(out, "package.json"), '{"type":"module","private":true}\n');

/** Pull a r"""...""" script constant out of the Linux shell so both apps share one copy. */
function pythonScript(source, name) {
  const m = new RegExp(`^${name} = r"""\\n([\\s\\S]*?)\\n"""`, "m").exec(source);
  if (!m) throw new Error(`${name} not found in hog`);
  return m[1];
}
const hog = readFileSync(join(root, "hog"), "utf8").replace(/\r\n/g, "\n");
const edge = pythonScript(hog, "EDGE_GRIP_SCRIPT");
const dapp = readFileSync(join(root, "public", "dapp-provider.js"), "utf8");
const template = readFileSync(join(here, "preload-page.template.cjs"), "utf8");
mkdirSync(join(here, "gen"), { recursive: true });
writeFileSync(join(here, "gen", "preload-page.cjs"), template
  .replace("/*@EDGE_GRIP_SCRIPT@*/", () => edge)
  .replace("/*@DAPP_PROVIDER_SCRIPT@*/", () => dapp));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(join(here, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(`staged Hog ${version} for Windows in ${out}`);
