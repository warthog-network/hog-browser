import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ethers } from "ethers";
import {
  btcAddressFromCompressed,
  chainAccountsFromPhrase,
  chainAccountsFromPrivateKey,
  parseDecimal,
  readNativeBalance,
  sendNativeEvm,
} from "../src/chains.js";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("chain accounts", () => {
  test("a raw key has Ethereum, Hemi, and Bitcoin addresses and no Solana account", () => {
    const account = chainAccountsFromPrivateKey("1".padStart(64, "0"));
    assert.equal(account.btcAddress, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.equal(account.evmAddress, ethers.computeAddress(`0x${"1".padStart(64, "0")}`));
    assert.equal(account.solAddress, "");
    assert.equal(account.evmKey, account.privateKey);
  });

  test("a recovery phrase matches the extension account", () => {
    const account = chainAccountsFromPhrase(PHRASE);
    assert.equal(account.evmAddress, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    assert.equal(account.btcAddress, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    assert.equal(account.solAddress, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    assert.notEqual(account.evmKey, account.privateKey);
    assert.equal(account.address.length, 48);
  });

  test("bitcoin balance includes confirmed and mempool coins", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        chain_stats: { funded_txo_sum: 10_000, spent_txo_sum: 1_000 },
        mempool_stats: { funded_txo_sum: 500, spent_txo_sum: 0 },
      }),
    });
    const read = await readNativeBalance("bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", fetchImpl);
    assert.equal(read.symbol, "BTC");
    assert.equal(read.amount, 9_500n);
  });

  test("an approved ethereum send returns only the hash", async () => {
    const account = chainAccountsFromPrivateKey("11".repeat(32));
    let raw = "";
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === "eth_sendRawTransaction") raw = body.params[0];
      const result = {
        eth_getTransactionCount: "0x1",
        eth_getBlockByNumber: { baseFeePerGas: "0x10" },
        eth_maxPriorityFeePerGas: "0x2",
        eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      }[body.method];
      return { ok: true, json: async () => ({ result }) };
    };
    const hash = await sendNativeEvm({
      privateKey: account.evmKey,
      to: "0x0000000000000000000000000000000000000001",
      amount: 5n,
      chain: "ethereum",
      fetchImpl,
    });
    const parsed = ethers.Transaction.from(raw);
    assert.equal(parsed.from, account.evmAddress);
    assert.equal(parsed.value, 5n);
    assert.equal(hash, `0x${"ab".repeat(32)}`);
    assert.equal(JSON.stringify(hash).includes(account.privateKey), false);
  });

  test("amounts keep the decimals they were given", () => {
    assert.equal(parseDecimal("1.5", 18), 1_500_000_000_000_000_000n);
    assert.equal(parseDecimal("1.000000001", 8), null);
    assert.equal(btcAddressFromCompressed("02" + "00".repeat(32)), btcAddressFromCompressed("02" + "00".repeat(32)));
  });
});
