import { test } from "node:test";
import assert from "node:assert/strict";
import { signWartTransfer } from "../src/wallet-core.js";
import { chainAccountsFromPhrase } from "../src/chains.js";
import { createVault } from "../src/vault-core.js";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("the vault returns addresses and keeps the phrase inside", () => {
  const vault = createVault();
  const opened = vault.unlock({ phrase: PHRASE, accountIndex: 0 });
  const full = chainAccountsFromPhrase(PHRASE, 0);
  assert.equal(opened.address, full.address);
  assert.equal(opened.evmAddress, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  assert.equal(opened.hasPhrase, true);
  assert.equal("privateKey" in opened, false);
  assert.equal("phrase" in opened, false);
  assert.equal(JSON.stringify(opened).includes("abandon"), false);
  assert.equal(vault.exportPhrase().phrase, PHRASE);
  const second = vault.activate({ index: 1 });
  assert.notEqual(second.address, opened.address);
  assert.equal(second.evmAddress, opened.evmAddress);
  assert.equal(vault.exportKey().privateKey, chainAccountsFromPhrase(PHRASE, 1).privateKey);
});

test("a locked vault signs nothing and a raw key has no phrase", () => {
  const vault = createVault();
  assert.throws(() => vault.exportKey(), /locked/i);
  const key = "11".repeat(32);
  const opened = vault.unlock({ privateKey: key });
  assert.equal(opened.hasPhrase, false);
  assert.equal("privateKey" in opened, false);
  assert.throws(() => vault.activate({ index: 1 }), /one private key/i);
  assert.throws(() => vault.exportPhrase(), /one private key/i);
  vault.lock();
  assert.throws(() => vault.exportKey(), /locked/i);
  assert.deepEqual(vault.status(), { unlocked: false });
});

test("wart signatures match the page signer and use the key inside the vault", () => {
  const vault = createVault();
  vault.unlock({ phrase: PHRASE, accountIndex: 0 });
  const key = chainAccountsFromPhrase(PHRASE, 0).privateKey;
  const args = {
    pinHash: "22".repeat(32),
    pinHeight: 4,
    nonceId: 9,
    feeE8: 100000n,
    toAddr: chainAccountsFromPhrase(PHRASE, 1).address,
    amountE8: 250000000n,
    network: "defi",
  };
  assert.deepEqual(vault.signWart({ kind: "transfer", args }), signWartTransfer({ ...args, privateKey: key }));
  assert.deepEqual(
    vault.signWart({ kind: "transfer", args: { ...args, privateKey: "ff".repeat(32) } }),
    signWartTransfer({ ...args, privateKey: key }),
  );
});
