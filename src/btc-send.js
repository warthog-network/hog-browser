import { Address, NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";
import { ethers } from "ethers";

const MEMPOOL = "https://mempool.space";
const DUST_SATS = 546n;

function guessVsize(inputs, outputs) {
  return BigInt(11 + inputs * 68 + outputs * 43);
}

export function assertBtcAddress(address) {
  const text = String(address || "").trim();
  try {
    Address(NETWORK).decode(text);
  } catch {
    throw new Error("Enter a Bitcoin address.");
  }
  return text;
}

function paymentScript(publicKey) {
  const payment = p2wpkh(publicKey, NETWORK);
  if (!payment.script) throw new Error("Could not build the Bitcoin spend script.");
  return payment.script;
}

/** Signed native-segwit send. Change goes back to the same address. */
export function buildSignedBtcTx({ publicKey, privateKey, utxos, to, amount, changeAddress, feeRate }) {
  if (amount < DUST_SATS) throw new Error("That Bitcoin amount is below the dust limit.");
  const script = paymentScript(publicKey);
  let fee = BigInt(feeRate) * guessVsize(2, 2);
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selected = [];
    let sum = 0n;
    for (const utxo of utxos) {
      selected.push(utxo);
      sum += BigInt(utxo.value);
      const feeIfChange = BigInt(feeRate) * guessVsize(selected.length, 2);
      const feeIfDrop = BigInt(feeRate) * guessVsize(selected.length, 1);
      if (sum >= amount + feeIfChange + DUST_SATS) {
        fee = feeIfChange;
        break;
      }
      if (sum >= amount + feeIfDrop) {
        fee = feeIfDrop;
        break;
      }
    }
    if (sum < amount + fee) throw new Error("Not enough Bitcoin for that amount and the network fee.");
    let change = sum - amount - fee;
    const outputs = change >= DUST_SATS ? 2 : 1;
    fee = BigInt(feeRate) * guessVsize(selected.length, outputs);
    if (sum < amount + fee) throw new Error("Not enough Bitcoin for that amount and the network fee.");
    change = sum - amount - fee;
    const keepChange = change >= DUST_SATS;
    if (!keepChange) {
      fee += change;
      change = 0n;
    }
    const tx = new Transaction();
    for (const utxo of selected) {
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script, amount: BigInt(utxo.value) },
      });
    }
    tx.addOutputAddress(to, amount, NETWORK);
    if (keepChange) tx.addOutputAddress(changeAddress, change, NETWORK);
    tx.sign(privateKey);
    tx.finalize();
    const vsize = Math.ceil(tx.weight / 4);
    const exact = BigInt(feeRate) * BigInt(vsize);
    last = { hex: tx.hex, txid: tx.id, feeSats: fee };
    if (exact === fee || attempt === 3) return last;
    fee = exact;
  }
  if (!last) throw new Error("Could not build the Bitcoin transaction.");
  return last;
}

export async function fetchBtcUtxos(address, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${MEMPOOL}/api/address/${encodeURIComponent(address)}/utxo`);
  if (!response.ok) throw new Error("Could not load Bitcoin coins.");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Could not load Bitcoin coins.");
  return rows
    .map((row) => ({
      txid: String(row.txid || ""),
      vout: Number(row.vout),
      value: Number(row.value),
      confirmed: row.status?.confirmed !== false,
    }))
    .filter((row) => /^[0-9a-f]{64}$/i.test(row.txid) && Number.isInteger(row.vout) && row.value > 0)
    .sort((a, b) => b.value - a.value);
}

export async function fetchBtcFeeRate(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${MEMPOOL}/api/v1/fees/recommended`);
    if (!response.ok) return 5;
    const body = await response.json();
    return Math.max(1, Number(body.halfHourFee) || 5);
  } catch {
    return 5;
  }
}

export function maxSendableBtc(utxos, feeRate) {
  const sum = utxos.reduce((total, utxo) => total + BigInt(utxo.value), 0n);
  if (sum === 0n) return 0n;
  const fee = BigInt(feeRate) * guessVsize(Math.max(1, utxos.length), 1);
  const max = sum - fee;
  return max >= DUST_SATS ? max : 0n;
}

async function broadcastBtc(rawHex, fetchImpl) {
  const response = await fetchImpl(`${MEMPOOL}/api/tx`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: rawHex,
  });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(text || "Bitcoin rejected the transaction.");
  return text;
}

/** Sign and broadcast a native-segwit send. Returns the txid. */
export async function sendBtc({ privateKey, publicKey, to, amount, fetchImpl = globalThis.fetch }) {
  const destination = assertBtcAddress(to);
  const sats = BigInt(amount);
  const pub = publicKey instanceof Uint8Array ? publicKey : ethers.getBytes(publicKey);
  const key = privateKey instanceof Uint8Array ? privateKey : ethers.getBytes(privateKey);
  const from = p2wpkh(pub, NETWORK).address;
  if (!from) throw new Error("Could not build the Bitcoin address.");
  if (destination === from) throw new Error("Choose a different recipient.");
  const [utxos, feeRate] = await Promise.all([fetchBtcUtxos(from, fetchImpl), fetchBtcFeeRate(fetchImpl)]);
  const built = buildSignedBtcTx({
    publicKey: pub,
    privateKey: key,
    utxos,
    to: destination,
    amount: sats,
    changeAddress: from,
    feeRate,
  });
  const txid = await broadcastBtc(built.hex, fetchImpl);
  return txid || built.txid;
}
