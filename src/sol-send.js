import { ed25519 } from "@noble/curves/ed25519";

const SOLANA_RPC = "https://solana.publicnode.com";
export const SOL_FEE_LAMPORTS = 5_000n;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function compactU16(value) {
  const out = [];
  let left = value;
  while (true) {
    const elem = left & 0x7f;
    left >>= 7;
    if (left === 0) {
      out.push(elem);
      break;
    }
    out.push(elem | 0x80);
  }
  return Uint8Array.from(out);
}

function u64le(value) {
  const out = new Uint8Array(8);
  let left = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(left & 0xffn);
    left >>= 8n;
  }
  return out;
}

export function base58Decode(text) {
  const clean = String(text || "").trim();
  if (!clean || [...clean].some((char) => !BASE58.includes(char))) {
    throw new Error("Enter a Solana address.");
  }
  let value = 0n;
  for (const char of clean) value = value * 58n + BigInt(BASE58.indexOf(char));
  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  let zeros = 0;
  while (zeros < clean.length && clean[zeros] === "1") zeros += 1;
  const body = Uint8Array.from(bytes.reverse());
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

export function assertSolAddress(address) {
  const raw = base58Decode(address);
  if (raw.length !== 32) throw new Error("Enter a Solana address.");
  return raw;
}

async function solanaRpc(method, params, fetchImpl) {
  const response = await fetchImpl(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("Solana did not answer.");
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Solana rejected the request.");
  if (body.result === undefined) throw new Error("Solana returned an empty result.");
  return body.result;
}

/** Legacy SystemProgram.transfer. Account order is signer, recipient, system program. */
export function solTransferMessage({ from, to, lamports, blockhash }) {
  const data = concat(Uint8Array.from([2, 0, 0, 0]), u64le(lamports));
  return concat(
    Uint8Array.from([1, 0, 1]),
    compactU16(3),
    from,
    to,
    new Uint8Array(32),
    blockhash,
    compactU16(1),
    Uint8Array.from([2]),
    compactU16(2),
    Uint8Array.from([0, 1]),
    compactU16(data.length),
    data,
  );
}

export function buildSolTransfer({ from, to, lamports, blockhash, privateKey }) {
  const message = solTransferMessage({ from, to, lamports, blockhash });
  const signature = ed25519.sign(message, privateKey);
  return concat(compactU16(1), signature, message);
}

export async function fetchSolBalance(address, fetchImpl = globalThis.fetch) {
  const result = await solanaRpc("getBalance", [address], fetchImpl);
  return BigInt(result?.value ?? 0);
}

export async function maxSendableSol(address, fetchImpl = globalThis.fetch) {
  const [balance, rent] = await Promise.all([
    fetchSolBalance(address, fetchImpl),
    solanaRpc("getMinimumBalanceForRentExemption", [0], fetchImpl).then(BigInt).catch(() => 890_880n),
  ]);
  const keep = SOL_FEE_LAMPORTS + rent;
  return balance > keep ? balance - keep : 0n;
}

function bytesToBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Sign and broadcast a SOL transfer. Returns the signature. */
export async function sendSol({ privateKey, fromAddress, to, amount, fetchImpl = globalThis.fetch }) {
  const destination = assertSolAddress(to);
  const owner = assertSolAddress(fromAddress);
  if (to.trim() === fromAddress) throw new Error("Choose a different recipient.");
  const lamports = BigInt(amount);
  if (lamports <= 0n) throw new Error("Enter an amount greater than 0.");
  const balance = await fetchSolBalance(fromAddress, fetchImpl);
  if (lamports + SOL_FEE_LAMPORTS > balance) {
    throw new Error("Not enough SOL for that amount and the network fee.");
  }
  const latest = await solanaRpc("getLatestBlockhash", [{ commitment: "confirmed" }], fetchImpl);
  const blockhash = base58Decode(latest?.value?.blockhash || "");
  if (blockhash.length !== 32) throw new Error("Solana did not return a blockhash.");
  const raw = buildSolTransfer({
    from: owner,
    to: destination,
    lamports,
    blockhash,
    privateKey,
  });
  return solanaRpc("sendTransaction", [
    bytesToBase64(raw),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ], fetchImpl);
}
