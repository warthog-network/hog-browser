import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const BUNDLES = [
  "public/chains-bundle.js",
  "public/dapp-bundle.js",
  "public/extra-bundle.js",
  "public/vault-worker.js",
  "public/wallet-bundle.js",
];

test("wallet bundles do not ship ethers community credentials", () => {
  const filled = /(?:defaultApiKey|defaultProjectId|defaultApplicationId) = "[^"]+"/;
  for (const file of BUNDLES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, filled, file);
    assert.equal(source.includes("proapi_"), false, file);
  }
});
