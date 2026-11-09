import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha2";
import { ed25519 } from "@noble/curves/ed25519";
import { ethers } from "ethers";
import { accountFromPrivateKey } from "./wallet-core.js";

/** Same paths as the extension. Hemi uses the Ethereum account. */
const WART_PATH = "m/44'/2070'/0'/0/0";
const ETH_PATH = "m/44'/60'/0'/0/0";
const BTC_PATH = "m/84'/0'/0'/0/0";
const SOL_PATH = "m/44'/501'/0'/0'";

const EVM = {
  ethereum: { chainId: 1, rpc: "https://ethereum.publicnode.com" },
  hemi: { chainId: 43111, rpc: "https://rpc.hemi.network/rpc" },
};

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HARDENED = 0x80000000;

function hexKey(value) {
  return String(value || "").trim().replace(/^0x/i, "").toLowerCase();
}

function normalizePhrase(mnemonic) {
  const words = String(mnemonic || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error("Enter 12 or 24 words.");
  }
  const phrase = words.join(" ");
  if (!ethers.Mnemonic.isValidMnemonic(phrase)) {
    throw new Error("That recovery phrase is not valid.");
  }
  return phrase;
}

function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= gen[i];
  }
  return chk;
}

function convertBits(data, from, to) {
  let acc = 0;
  let bits = 0;
  const max = (1 << to) - 1;
  const out = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (bits) out.push((acc << (to - bits)) & max);
  return out;
}

/** Native segwit address for a compressed secp256k1 public key. */
export function btcAddressFromCompressed(publicKeyHex) {
  const body = hexKey(publicKeyHex);
  if (!/^(02|03)[0-9a-f]{64}$/.test(body)) {
    throw new Error("Bitcoin needs a compressed public key.");
  }
  const program = ethers.getBytes(ethers.ripemd160(ethers.sha256(`0x${body}`)));
  const data = [0, ...convertBits(program, 8, 5)];
  const expand = [];
  for (const char of "bc") expand.push(char.charCodeAt(0) >> 5);
  expand.push(0);
  for (const char of "bc") expand.push(char.charCodeAt(0) & 31);
  const mod = polymod(expand.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `bc1${data.concat(checksum).map((part) => BECH32[part]).join("")}`;
}

function slip10(seed, path) {
  const parts = path.trim().split("/");
  if (parts[0] !== "m" || parts.length < 2) throw new Error("Bad derivation path.");
  let digest = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = digest.slice(0, 32);
  let chain = digest.slice(32);
  for (const part of parts.slice(1)) {
    const mark = part.endsWith("'") || part.endsWith("h");
    const raw = mark ? part.slice(0, -1) : part;
    if (!mark || !/^\d+$/.test(raw)) throw new Error("Solana derivation only uses hardened steps.");
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index >= HARDENED) throw new Error("Bad derivation path.");
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index + HARDENED);
    digest = hmac(sha512, chain, data);
    key = digest.slice(0, 32);
    chain = digest.slice(32);
  }
  return key;
}

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]];
  return out;
}

/**
 * Addresses for one raw Warthog key.
 * Ethereum and Hemi share that key. Bitcoin is the same key as native segwit.
 * Solana is a different curve, so a raw key has no Solana account.
 */
export function chainAccountsFromPrivateKey(privateKeyHex) {
  const account = accountFromPrivateKey(privateKeyHex);
  return {
    privateKey: account.privateKey,
    publicKey: account.publicKey,
    address: account.address,
    evmAddress: account.evmAddress,
    evmKey: account.privateKey,
    btcAddress: btcAddressFromCompressed(account.publicKey),
    solAddress: "",
    phrase: "",
  };
}

/** Extension account 0. Warthog, Ethereum, Bitcoin, and Solana from one phrase. */
export function chainAccountsFromPhrase(mnemonic) {
  const phrase = normalizePhrase(mnemonic);
  const wart = accountFromPrivateKey(ethers.HDNodeWallet.fromPhrase(phrase, "", WART_PATH).privateKey);
  const eth = accountFromPrivateKey(ethers.HDNodeWallet.fromPhrase(phrase, "", ETH_PATH).privateKey);
  const btc = accountFromPrivateKey(ethers.HDNodeWallet.fromPhrase(phrase, "", BTC_PATH).privateKey);
  const seed = ethers.getBytes(ethers.Mnemonic.fromPhrase(phrase).computeSeed());
  const solKey = slip10(seed, SOL_PATH);
  seed.fill(0);
  const solAddress = base58Encode(ed25519.getPublicKey(solKey));
  solKey.fill(0);
  return {
    privateKey: wart.privateKey,
    publicKey: wart.publicKey,
    address: wart.address,
    evmAddress: eth.evmAddress,
    evmKey: eth.privateKey,
    btcAddress: btcAddressFromCompressed(btc.publicKey),
    solAddress,
    phrase,
  };
}

export function parseDecimal(input, decimals) {
  const text = String(input ?? "").trim();
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > places) return null;
  const padded = (frac + "0".repeat(places)).slice(0, places);
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(padded || "0");
}

export function formatUnits(value, decimals) {
  const places = Number(decimals);
  const scale = 10n ** BigInt(places);
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

async function evmCall(rpc, method, params, fetchImpl) {
  const response = await fetchImpl(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("That network did not answer.");
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "That network rejected the request.");
  return body.result;
}

export async function readNativeBalance(chain, address, fetchImpl = globalThis.fetch) {
  if (chain === "solana" && !address) {
    return {
      symbol: "SOL",
      decimals: 9,
      amount: 0n,
      missing: "This key has no Solana account. Restore a 12 or 24 word phrase to open one.",
    };
  }
  if (chain === "ethereum" || chain === "hemi") {
    const wei = BigInt(await evmCall(EVM[chain].rpc, "eth_getBalance", [address, "latest"], fetchImpl));
    return {
      symbol: "ETH",
      decimals: 18,
      amount: wei,
      note: chain === "hemi" ? "Same address as Ethereum. Gas on Hemi is ETH." : "",
    };
  }
  if (chain === "bitcoin") {
    const response = await fetchImpl(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
    if (!response.ok) throw new Error("Bitcoin balance is unavailable.");
    const data = await response.json();
    const confirmed = BigInt(data?.chain_stats?.funded_txo_sum ?? 0) - BigInt(data?.chain_stats?.spent_txo_sum ?? 0);
    const pending = BigInt(data?.mempool_stats?.funded_txo_sum ?? 0) - BigInt(data?.mempool_stats?.spent_txo_sum ?? 0);
    const amount = confirmed + pending;
    return { symbol: "BTC", decimals: 8, amount: amount > 0n ? amount : 0n, note: "" };
  }
  if (chain === "solana") {
    const result = await evmCall("https://solana.publicnode.com", "getBalance", [address], fetchImpl);
    const lamports = BigInt(result?.value ?? 0);
    return { symbol: "SOL", decimals: 9, amount: lamports, note: "" };
  }
  throw new Error("That network is not available.");
}

/** Fee reserve for a simple ETH transfer, so Max does not spend the fee. */
export async function evmTransferReserve(chain, fetchImpl = globalThis.fetch) {
  const row = EVM[chain];
  if (!row) throw new Error("That network is not available.");
  let price;
  try {
    const block = await evmCall(row.rpc, "eth_getBlockByNumber", ["latest", false], fetchImpl);
    const tip = BigInt(await evmCall(row.rpc, "eth_maxPriorityFeePerGas", [], fetchImpl));
    price = BigInt(block?.baseFeePerGas || 0) * 2n + tip;
  } catch {
    price = BigInt(await evmCall(row.rpc, "eth_gasPrice", [], fetchImpl));
  }
  if (price <= 0n) price = 1n;
  return 21_000n * price;
}

/**
 * Sign and broadcast a native transfer. Returns only the transaction hash.
 * The private key is not included in the result.
 */
export async function sendNativeEvm({ privateKey, to, amount, chain, fetchImpl = globalThis.fetch }) {
  const row = EVM[chain];
  if (!row) throw new Error("That network is not available.");
  if (!ethers.isAddress(to)) throw new Error("That recipient is not an Ethereum address.");
  const value = BigInt(amount);
  if (value <= 0n) throw new Error("Enter an amount greater than 0.");
  const key = hexKey(privateKey);
  const wallet = new ethers.Wallet(`0x${key}`);
  const from = wallet.address;
  if (ethers.getAddress(to) === from) throw new Error("Choose a different recipient.");
  const nonce = Number(BigInt(await evmCall(row.rpc, "eth_getTransactionCount", [from, "pending"], fetchImpl)));
  const reserve = await evmTransferReserve(chain, fetchImpl);
  const fee = reserve / 21_000n;
  const tx = {
    type: 2,
    chainId: row.chainId,
    nonce,
    gasLimit: 21_000n,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: fee > 1n ? fee / 2n : fee,
    to: ethers.getAddress(to),
    value,
  };
  const raw = await wallet.signTransaction(tx);
  const parsed = ethers.Transaction.from(raw);
  if (!parsed.from || parsed.from.toLowerCase() !== from.toLowerCase()) {
    throw new Error("The signature does not match this account.");
  }
  const hash = await evmCall(row.rpc, "eth_sendRawTransaction", [raw], fetchImpl);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("The network did not return a transaction hash.");
  }
  return hash;
}
