import { ethers } from "ethers";
import { Funds, Liquidity, TokenPrecision, Wart, Price, encodeLimitPrice } from "warthog-js";

/** 1 WART = 1e8 E8 units. */
export const WART_E8 = 100_000_000n;

/**
 * @param {string} publicKeyHex Compressed (33-byte) or uncompressed public key.
 * @returns {string} 48-char Warthog address hex.
 */
export function addressHexFromPublicKey(publicKeyHex) {
  let pk = publicKeyHex.startsWith("0x") ? publicKeyHex : `0x${publicKeyHex}`;
  if (pk.length === 132 && pk.slice(2, 4).toLowerCase() === "04") {
    pk = ethers.SigningKey.computePublicKey(pk, true);
  }
  const body = pk.slice(2).toLowerCase();
  const prefix = body.slice(0, 2);
  if (body.length !== 66 || (prefix !== "02" && prefix !== "03")) {
    throw new Error("Public key must be compressed secp256k1");
  }
  pk = `0x${body}`;
  const ripe = ethers.ripemd160(ethers.sha256(pk)).slice(2);
  const checksum = ethers.sha256(`0x${ripe}`).slice(2, 10);
  return (ripe + checksum).toLowerCase();
}

/**
 * @param {string} hex
 * @returns {boolean}
 */
export function validateAddress(hex) {
  const clean = String(hex || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(clean)) return false;
  const payload = clean.slice(0, 40);
  const checksum = clean.slice(40);
  const expected = ethers.sha256(`0x${payload}`).slice(2, 10);
  return checksum === expected;
}

function normalizePrivateKey(hex) {
  const clean = String(hex || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("Private key must be 64 hex characters");
  }
  return `0x${clean}`;
}

/**
 * @param {string} privateKeyHex
 * @returns {{ privateKey: string, publicKey: string, address: string }}
 */
export function accountFromPrivateKey(privateKeyHex) {
  const signingKey = new ethers.SigningKey(normalizePrivateKey(privateKeyHex));
  const publicKey = signingKey.compressedPublicKey;
  return {
    privateKey: signingKey.privateKey.slice(2),
    publicKey: publicKey.slice(2),
    address: addressHexFromPublicKey(publicKey),
    evmAddress: ethers.computeAddress(signingKey.publicKey),
  };
}

/** @returns {{ privateKey: string, publicKey: string, address: string }} */
export function createAccount() {
  return accountFromPrivateKey(ethers.Wallet.createRandom().privateKey);
}

function hexToBytes(hex) {
  const clean = String(hex || "").trim().replace(/^0x/i, "").toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error("Expected hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function writeU32(buf, offset, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error("Value does not fit in uint32");
  }
  new DataView(buf.buffer).setUint32(offset, n, false);
}

function writeU64(buf, offset, value) {
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new Error("Value does not fit in uint64");
  }
  new DataView(buf.buffer).setBigUint64(offset, n, false);
}

function jsonUint(value) {
  const n = BigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is too large to submit as a JSON number");
  }
  return Number(n);
}

/**
 * Sign a native WART transfer. The preimage matches warthog-js transferWart.
 * DeFi nodes want wartE8 plus type. Mainnet wants amountE8 and no type.
 *
 * @param {{
 *   privateKey: string,
 *   pinHash: string,
 *   pinHeight: number,
 *   nonceId: number,
 *   feeE8: bigint | number,
 *   toAddr: string,
 *   amountE8: bigint | number,
 *   network: "defi" | "mainnet",
 * }} args
 */
export function signWartTransfer(args) {
  if (!validateAddress(args.toAddr)) {
    throw new Error("Recipient address checksum is wrong");
  }
  const pinHash = hexToBytes(args.pinHash);
  if (pinHash.length !== 32) throw new Error("Chain pin hash must be 32 bytes");
  const to = hexToBytes(args.toAddr);
  if (to.length !== 24) throw new Error("Recipient address must be 24 bytes");

  const msg = new Uint8Array(32 + 4 + 4 + 3 + 8 + 20 + 8);
  let offset = 0;
  msg.set(pinHash, offset);
  offset += 32;
  writeU32(msg, offset, args.pinHeight);
  offset += 4;
  writeU32(msg, offset, args.nonceId);
  offset += 4;
  offset += 3;
  writeU64(msg, offset, args.feeE8);
  offset += 8;
  msg.set(to.subarray(0, 20), offset);
  offset += 20;
  writeU64(msg, offset, args.amountE8);

  const signingKey = new ethers.SigningKey(normalizePrivateKey(args.privateKey));
  const sig = signingKey.sign(ethers.getBytes(ethers.sha256(msg)));
  const signature65 = `${sig.r.slice(2)}${sig.s.slice(2)}${(sig.v - 27).toString(16).padStart(2, "0")}`;
  const toAddr = args.toAddr.trim().replace(/^0x/i, "").toLowerCase();
  const common = {
    pinHeight: Number(args.pinHeight),
    nonceId: Number(args.nonceId),
    feeE8: jsonUint(args.feeE8),
    toAddr,
    signature65,
  };
  if (args.network === "mainnet") {
    return { ...common, amountE8: jsonUint(args.amountE8) };
  }
  return { type: "wartTransfer", ...common, wartE8: jsonUint(args.amountE8) };
}

function signature65(privateKey, message) {
  const signingKey = new ethers.SigningKey(normalizePrivateKey(privateKey));
  const sig = signingKey.sign(ethers.getBytes(ethers.sha256(message)));
  return `${sig.r.slice(2)}${sig.s.slice(2)}${(sig.v - 27).toString(16).padStart(2, "0")}`;
}

function beginMessage(pinHashHex, pinHeight, nonceId, feeE8, total) {
  const pinHash = hexToBytes(pinHashHex);
  if (pinHash.length !== 32) throw new Error("Chain pin hash must be 32 bytes");
  const message = new Uint8Array(total);
  message.set(pinHash, 0);
  writeU32(message, 32, pinHeight);
  writeU32(message, 36, nonceId);
  writeU64(message, 43, feeE8);
  return message;
}

function chainFields(args, signature) {
  return {
    pinHeight: Number(args.pinHeight),
    nonceId: Number(args.nonceId),
    feeE8: jsonUint(args.feeE8),
    signature65: signature,
  };
}

function readAssetHash(hash) {
  const clean = String(hash || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Asset hash must be 64 hex characters");
  return { clean, bytes: hexToBytes(clean) };
}

function decimalsOf(value) {
  const decimals = Number(value ?? 8);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Decimals must be a whole number from 0 to 18");
  }
  return decimals;
}

/**
 * DeFi limit order. Buy spends WART. Sell spends the asset. Preimage matches warthog-js.
 */
export function signLimitSwap(args) {
  const asset = readAssetHash(args.assetHash);
  const decimals = decimalsOf(args.decimals);
  const limitHex = encodeLimitPrice(args.limitPrice, decimals, { ceil: Boolean(args.isBuy) });
  const limit = Price.fromHex(limitHex);
  if (!limit) throw new Error("Invalid limit price");
  const parsed = args.isBuy
    ? Wart.parse(String(args.amount).trim())
    : Funds.parse(String(args.amount).trim(), new TokenPrecision(decimals));
  if (!parsed) throw new Error("Invalid amount");
  const amountE8 = args.isBuy ? parsed.E8 : parsed.amount;
  const message = beginMessage(args.pinHash, args.pinHeight, args.nonceId, args.feeE8, 51 + 32 + 1 + 8 + 3);
  let offset = 51;
  message.set(asset.bytes, offset);
  offset += 32;
  message[offset] = args.isBuy ? 1 : 0;
  offset += 1;
  writeU64(message, offset, amountE8);
  offset += 8;
  message.set(hexToBytes(limit.toHex()), offset);
  return {
    type: "limitSwap",
    ...chainFields(args, signature65(args.privateKey, message)),
    assetHash: asset.clean,
    isBuy: Boolean(args.isBuy),
    amountU64: jsonUint(amountE8),
    limit: limit.toHex(),
  };
}

/** DeFi liquidity deposit. Preimage matches warthog-js. */
export function signLiquidityDeposit(args) {
  const asset = readAssetHash(args.assetHash);
  const decimals = decimalsOf(args.decimals);
  const tokens = Funds.parse(String(args.assetAmount).trim(), new TokenPrecision(decimals));
  const wart = Wart.parse(String(args.wartAmount).trim());
  if (!tokens) throw new Error("Invalid asset amount");
  if (!wart) throw new Error("Invalid WART amount");
  const message = beginMessage(args.pinHash, args.pinHeight, args.nonceId, args.feeE8, 51 + 32 + 8 + 8);
  let offset = 51;
  message.set(asset.bytes, offset);
  offset += 32;
  writeU64(message, offset, tokens.amount);
  offset += 8;
  writeU64(message, offset, wart.E8);
  return {
    type: "liquidityDeposit",
    ...chainFields(args, signature65(args.privateKey, message)),
    assetHash: asset.clean,
    amountU64: jsonUint(tokens.amount),
    wartE8: jsonUint(wart.E8),
  };
}

/** DeFi liquidity withdrawal. Preimage matches warthog-js. */
export function signLiquidityWithdraw(args) {
  const asset = readAssetHash(args.assetHash);
  const units = Liquidity.parse(String(args.shares).trim());
  if (!units) throw new Error("Invalid LP shares amount");
  const message = beginMessage(args.pinHash, args.pinHeight, args.nonceId, args.feeE8, 51 + 32 + 8);
  let offset = 51;
  message.set(asset.bytes, offset);
  writeU64(message, 51 + 32, units.E8);
  return {
    type: "liquidityWithdrawal",
    ...chainFields(args, signature65(args.privateKey, message)),
    assetHash: asset.clean,
    amountE8: jsonUint(units.E8),
  };
}

/** DeFi asset creation. The name is 1 to 5 ASCII characters. Preimage matches warthog-js. */
export function signAssetCreation(args) {
  const name = String(args.name || "").trim();
  if (!/^[\x20-\x7e]{1,5}$/.test(name)) throw new Error("Asset name must be 1 to 5 characters");
  const precision = new TokenPrecision(decimalsOf(args.decimals));
  const supply = Funds.parse(String(args.supply).trim(), precision);
  if (!supply) throw new Error("Invalid total supply");
  const message = beginMessage(args.pinHash, args.pinHeight, args.nonceId, args.feeE8, 51 + 8 + 1 + 5);
  let offset = 51;
  writeU64(message, offset, supply.amount);
  offset += 8;
  message[offset] = precision.precision;
  message.set(new TextEncoder().encode(name), offset + 1);
  return {
    type: "assetCreation",
    ...chainFields(args, signature65(args.privateKey, message)),
    supplyU64: jsonUint(supply.amount),
    decimals: precision.precision,
    name,
  };
}

/** Cancel a Warthog transaction, including an open limit order. Preimage matches warthog-js. */
export function signCancel(args) {
  const message = beginMessage(args.pinHash, args.pinHeight, args.nonceId, args.feeE8, 51 + 4 + 4);
  writeU32(message, 51, args.cancelHeight);
  writeU32(message, 55, args.cancelNonceId);
  return {
    type: "cancelation",
    ...chainFields(args, signature65(args.privateKey, message)),
    cancelHeight: Number(args.cancelHeight),
    cancelNonceId: Number(args.cancelNonceId),
  };
}
