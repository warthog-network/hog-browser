import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { Transaction } from "@scure/btc-signer";
import { btcKeyFromPhrase, sendEvmCall, solKeyFromPhrase, waitEvmReceipt } from "../src/chains.js";
import { buildSignedBtcTx } from "../src/btc-send.js";
import { buildSolTransfer } from "../src/sol-send.js";
import { rowsFromBitcoin, rowsFromEvm, rowsFromSolana } from "../src/chain-activity.js";
import { decryptWalletFile, encryptWalletFile } from "../src/wallet-file.js";
import { safeSignature } from "../src/safetrade.js";
import { formatHealth, planBorrow } from "../src/aave.js";
import { openWithPrf, sealWithPrf } from "../src/passkey.js";
import { createVault } from "../src/vault-core.js";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("phrase accounts keep the published Bitcoin and Solana addresses", () => {
  assert.equal(btcKeyFromPhrase(PHRASE).address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  assert.equal(solKeyFromPhrase(PHRASE).address, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
});

test("a Bitcoin send signs a native-segwit transaction and does not broadcast", () => {
  const spent = btcKeyFromPhrase(PHRASE);
  const built = buildSignedBtcTx({
    publicKey: spent.publicKey,
    privateKey: spent.privateKey,
    utxos: [{ txid: "11".repeat(32), vout: 0, value: 100_000 }],
    to: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    amount: 20_000n,
    changeAddress: spent.address,
    feeRate: 2,
  });
  assert.match(built.hex, /^[0-9a-f]+$/);
  assert.match(built.txid, /^[0-9a-f]{64}$/);
  const parsed = Transaction.fromRaw(Uint8Array.from(built.hex.match(/../g).map((byte) => Number.parseInt(byte, 16))));
  assert.equal(parsed.id, built.txid);
  assert.equal(parsed.outputsLength, 2);
  spent.privateKey.fill(0);
});

test("a Solana transfer signature verifies", () => {
  const key = ed25519.utils.randomPrivateKey();
  const from = ed25519.getPublicKey(key);
  const to = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const raw = buildSolTransfer({
    from,
    to,
    lamports: 1000n,
    blockhash: new Uint8Array(32).fill(7),
    privateKey: key,
  });
  assert.equal(raw[0], 1);
  const signature = raw.slice(1, 65);
  const message = raw.slice(65);
  assert.equal(ed25519.verify(signature, message, from), true);
});

test("wallet file v3 and its envelope round-trip", async () => {
  const wallet = {
    privateKey: "11".repeat(32),
    publicKey: "02".padEnd(66, "1"),
    address: "aa".repeat(24),
    mnemonic: PHRASE,
  };
  const file = await encryptWalletFile(wallet, "password123");
  const opened = await decryptWalletFile(file, "password123");
  assert.equal(opened.mnemonic, PHRASE);
  assert.equal(opened.privateKey, wallet.privateKey);
  const wrapped = JSON.stringify({ kind: "warthog-wallet", password: file });
  const again = await decryptWalletFile(wrapped, "password123");
  assert.equal(again.address, wallet.address);
  await assert.rejects(() => decryptWalletFile(file, "nope"), /password/i);
});

test("SafeTrade signatures match HMAC-SHA256 of nonce plus key", async () => {
  const expected = createHmac("sha256", "secret").update("noncekey").digest("hex");
  assert.equal(await safeSignature("key", "secret", "nonce"), expected);
});

test("Aave blocks a borrow that would leave health under 1.5", () => {
  assert.equal(formatHealth(null), "No debt");
  const asset = {
    id: 7,
    symbol: "USDC",
    underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    price: 100_000_000n,
    canBorrow: true,
    borrowRoom: 10n ** 18n,
    paused: false,
  };
  const tight = {
    account: {
      totalCollateralValue: 10n ** 26n,
      avgCollateralFactorWad: 10n ** 18n,
      totalDebtValueRay: 0n,
    },
  };
  assert.throws(
    () => planBorrow("0x9858EfFD232B4033E47d90003D41EC34EcaEda94", tight, asset, 1_000_000n, false),
    /1\.5/,
  );
  const roomy = {
    account: {
      totalCollateralValue: 10n ** 30n,
      avgCollateralFactorWad: 10n ** 18n,
      totalDebtValueRay: 0n,
    },
  };
  const steps = planBorrow("0x9858EfFD232B4033E47d90003D41EC34EcaEda94", roomy, asset, 1_000_000n, false);
  assert.equal(steps.length, 1);
  assert.match(steps[0].data, /^0x/);
  assert.equal(steps[0].to.toLowerCase(), "0x94e7a5dcbe816e498b89ab752661904e2f56c485");
});

test("activity rows keep native transfers, bitcoin net, and solana signatures", () => {
  const evm = rowsFromEvm("0xabc", [
    { hash: "0x1", value: "0", to: "0xabc" },
    { hash: "0x2", value: "1000000000000000000", to: "0xAbC", isError: "0" },
  ], [], "ethereum");
  assert.equal(evm.length, 1);
  assert.equal(evm[0].incoming, true);
  assert.match(evm[0].url, /etherscan\.io\/tx\/0x2/);
  const btc = rowsFromBitcoin("bc1q", [{
    txid: "ab",
    status: { confirmed: true },
    vin: [{ prevout: { scriptpubkey_address: "bc1q", value: 5000 } }],
    vout: [{ scriptpubkey_address: "bc1q", value: 15000 }],
  }]);
  assert.equal(btc[0].incoming, true);
  assert.match(btc[0].amount, /0\.0001 BTC/);
  const sol = rowsFromSolana([{ signature: "sig", err: null }]);
  assert.equal(sol[0].title, "Solana transaction");
  assert.match(sol[0].url, /solscan\.io\/tx\/sig/);
});

test("a passkey PRF seal opens only with the same secret", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealWithPrf(secret, { phrase: PHRASE, privateKey: "" });
  const opened = await openWithPrf(secret, sealed);
  assert.equal(opened.phrase, PHRASE);
  const other = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(() => openWithPrf(other, sealed), /passkey/i);
});

test("a raw key cannot send Solana, and an EVM call returns only the hash", async () => {
  const vault = createVault();
  vault.unlock({ privateKey: "11".repeat(32) });
  await assert.rejects(() => vault.sendSol({ to: "x", amount: 1n }), /recovery phrase/i);
  vault.lock();

  let raw = "";
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const result = {
      eth_getTransactionCount: "0x1",
      eth_estimateGas: "0x5208",
      eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
      eth_maxPriorityFeePerGas: "0x1",
      eth_sendRawTransaction: `0x${"cd".repeat(32)}`,
    }[body.method];
    if (body.method === "eth_sendRawTransaction") raw = body.params[0];
    if (result === undefined) throw new Error(body.method);
    return { ok: true, json: async () => ({ result }) };
  };
  const hash = await sendEvmCall({
    privateKey: `0x${"11".repeat(32)}`,
    to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    data: "0x1234",
    value: 0n,
    chain: "ethereum",
    fetchImpl,
  });
  assert.equal(hash, `0x${"cd".repeat(32)}`);
  assert.equal(raw.includes("11".repeat(32)), false);
  const receipt = await waitEvmReceipt({
    hash,
    attempts: 2,
    pauseMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: { status: "0x1" } }) }),
  });
  assert.equal(receipt.status, "0x1");
});
