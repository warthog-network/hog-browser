import { ethers } from "ethers";
import { chainAccountsFromPhrase, chainAccountsFromPrivateKey, sendNativeEvm } from "./chains.js";
import {
  signAssetCreation,
  signCancel,
  signLimitSwap,
  signLiquidityDeposit,
  signLiquidityWithdraw,
  signWartTransfer,
} from "./wallet-core.js";

const SIGNERS = {
  transfer: signWartTransfer,
  limitSwap: signLimitSwap,
  liquidityDeposit: signLiquidityDeposit,
  liquidityWithdraw: signLiquidityWithdraw,
  assetCreation: signAssetCreation,
  cancel: signCancel,
};

function evmHex(account) {
  const hex = String(account.evmKey || account.privateKey || "").trim().replace(/^0x/i, "");
  return `0x${hex}`;
}

function publish(account, hasPhrase) {
  return {
    address: account.address,
    evmAddress: account.evmAddress || "",
    btcAddress: account.btcAddress || "",
    solAddress: account.solAddress || "",
    accountIndex: Number.isInteger(account.accountIndex) ? account.accountIndex : 0,
    hasPhrase: Boolean(hasPhrase),
  };
}

/**
 * Holds the phrase and the active private key. Callers receive addresses
 * and signatures. The phrase and key come back only from exportKey and
 * exportPhrase.
 */
export function createVault() {
  let material = null;

  function clear() {
    if (material) {
      material.phrase = "";
      material.privateKey = "";
    }
    material = null;
  }

  function account() {
    if (!material) throw new Error("Wallet is locked");
    if (material.phrase) return chainAccountsFromPhrase(material.phrase, material.accountIndex);
    return chainAccountsFromPrivateKey(material.privateKey);
  }

  return {
    unlock(payload = {}) {
      clear();
      const phrase = String(payload.phrase || "").trim();
      const privateKey = String(payload.privateKey || "").trim();
      if (phrase) {
        const row = chainAccountsFromPhrase(phrase, payload.accountIndex || 0);
        material = { phrase, accountIndex: row.accountIndex };
        return publish(row, true);
      }
      if (!privateKey) throw new Error("Wallet is locked");
      const row = chainAccountsFromPrivateKey(privateKey);
      material = { privateKey: row.privateKey, accountIndex: 0 };
      return publish(row, false);
    },
    lock() {
      clear();
      return { unlocked: false };
    },
    status() {
      if (!material) return { unlocked: false };
      return { unlocked: true, ...publish(account(), Boolean(material.phrase)) };
    },
    activate(payload = {}) {
      if (!material || !material.phrase) throw new Error("This wallet is one private key.");
      const row = chainAccountsFromPhrase(material.phrase, payload.index);
      material.accountIndex = row.accountIndex;
      return publish(row, true);
    },
    exportKey() {
      return { privateKey: account().privateKey };
    },
    exportPhrase() {
      if (!material || !material.phrase) throw new Error("This wallet is one private key.");
      return { phrase: material.phrase };
    },
    signWart(payload = {}) {
      const sign = SIGNERS[payload.kind];
      if (!sign) throw new Error("That signature is not available.");
      return sign({ ...(payload.args || {}), privateKey: account().privateKey });
    },
    sendNativeEvm(payload = {}) {
      return sendNativeEvm({
        privateKey: evmHex(account()),
        to: payload.to,
        amount: payload.amount,
        chain: payload.chain,
        fetchImpl: payload.fetchImpl,
      });
    },
    async signMessage(payload = {}) {
      const wallet = new ethers.Wallet(evmHex(account()));
      if (payload.encoding === "hex") return wallet.signMessage(ethers.getBytes(payload.message));
      return wallet.signMessage(String(payload.message ?? ""));
    },
    async signTypedData(payload = {}) {
      const wallet = new ethers.Wallet(evmHex(account()));
      return wallet.signTypedData(payload.domain, payload.types, payload.message);
    },
    async signTransaction(payload = {}) {
      const wallet = new ethers.Wallet(evmHex(account()));
      return wallet.signTransaction(payload.tx || {});
    },
  };
}
