import { ethers } from "ethers";
import { createVault } from "./vault-core.js";

const vault = createVault();
const ACTIONS = new Set([
  "unlock",
  "lock",
  "status",
  "activate",
  "exportKey",
  "exportPhrase",
  "signWart",
  "sendNativeEvm",
  "sendBtc",
  "sendSol",
  "sendEvmCall",
  "signMessage",
  "signTypedData",
  "signTransaction",
]);

function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.$bigint === "string") return BigInt(value.$bigint);
  if (keys.length === 1 && typeof value.$bytes === "string") return ethers.getBytes(value.$bytes);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = unpack(item);
  return out;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  const id = data.id;
  if (!ACTIONS.has(data.action)) {
    self.postMessage({ id, ok: false, error: "That request is not available." });
    return;
  }
  try {
    const result = await vault[data.action](unpack(data.payload || {}));
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : "Request failed" });
  }
};
