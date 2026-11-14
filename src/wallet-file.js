import { md5 } from "@noble/hashes/legacy";

const PBKDF2_ITERATIONS = 210_000;

function bytesToB64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64ToBytes(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function passwordCipher(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("{")) {
    try {
      const envelope = JSON.parse(text);
      if (envelope && (envelope.kind === "warthog-wallet" || envelope.password || envelope.passkey)) {
        return String(envelope.password || "");
      }
    } catch {
      return text;
    }
  }
  return text;
}

async function deriveKey(password, salt, iterations, usages) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function asWallet(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.privateKey || !parsed.address) {
    throw new Error("Invalid wallet file");
  }
  return {
    privateKey: String(parsed.privateKey),
    address: String(parsed.address),
    publicKey: parsed.publicKey ? String(parsed.publicKey) : "",
    mnemonic: parsed.mnemonic ? String(parsed.mnemonic) : "",
  };
}

async function decryptV3(envelope, password) {
  const iterations = Number(envelope.iter) > 0 ? Number(envelope.iter) : PBKDF2_ITERATIONS;
  const key = await deriveKey(password, b64ToBytes(envelope.salt), iterations, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      key,
      b64ToBytes(envelope.ct),
    );
    return asWallet(JSON.parse(new TextDecoder().decode(plain)));
  } catch (error) {
    if (error instanceof Error && /invalid wallet/i.test(error.message)) throw error;
    throw new Error("Invalid password");
  }
}

async function decryptV2(envelope, password) {
  const iterations = Number(envelope.iter) > 0 ? Number(envelope.iter) : PBKDF2_ITERATIONS;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(envelope.salt), iterations, hash: "SHA-256" },
    base,
    { name: "AES-CBC", length: 256 },
    false,
    ["decrypt"],
  );
  let text = "";
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ct));
    text = new TextDecoder().decode(plain);
  } catch {
    throw new Error("Invalid password");
  }
  if (!text) throw new Error("Invalid password");
  return asWallet(JSON.parse(text));
}

function evpBytesToKey(password, salt) {
  const pass = new TextEncoder().encode(password);
  const blocks = [];
  let prev = new Uint8Array();
  while (blocks.reduce((sum, block) => sum + block.length, 0) < 48) {
    const input = new Uint8Array(prev.length + pass.length + salt.length);
    input.set(prev, 0);
    input.set(pass, prev.length);
    input.set(salt, prev.length + pass.length);
    prev = md5(input);
    blocks.push(prev);
  }
  const material = new Uint8Array(48);
  let offset = 0;
  for (const block of blocks) {
    material.set(block.subarray(0, Math.min(block.length, 48 - offset)), offset);
    offset += block.length;
    if (offset >= 48) break;
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

async function decryptLegacy(encrypted, password) {
  const raw = b64ToBytes(encrypted);
  const head = new TextDecoder().decode(raw.subarray(0, 8));
  if (head !== "Salted__" || raw.length < 32) throw new Error("Invalid wallet file");
  const salt = raw.subarray(8, 16);
  const ct = raw.subarray(16);
  const { key, iv } = await evpBytesToKey(password, salt);
  const aes = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  let text = "";
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aes, ct);
    text = new TextDecoder().decode(plain);
  } catch {
    throw new Error("Invalid password");
  }
  if (!text) throw new Error("Invalid password");
  return asWallet(JSON.parse(text));
}

/** Decrypt a warthog_wallet.txt password blob, including a passkey envelope's password field. */
export async function decryptWalletFile(raw, password) {
  if (!password) throw new Error("Invalid password");
  const cipher = passwordCipher(raw);
  if (!cipher) throw new Error("This wallet has no password unlock. Use the passkey, or re-save the file with a password.");
  if (cipher.startsWith("{")) {
    const envelope = JSON.parse(cipher);
    if (envelope && envelope.ct && envelope.salt && envelope.iv) {
      if (Number(envelope.v) === 3 || envelope.alg === "aes-256-gcm") return decryptV3(envelope, password);
      if (Number(envelope.v) === 2) return decryptV2(envelope, password);
    }
  }
  return decryptLegacy(cipher, password);
}

export async function encryptWalletFile(wallet, password) {
  if (!password) throw new Error("Password is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify({
      privateKey: wallet.privateKey,
      publicKey: wallet.publicKey || "",
      address: wallet.address,
      mnemonic: wallet.mnemonic || "",
    })),
  ));
  return JSON.stringify({
    v: 3,
    kdf: "pbkdf2-sha256",
    alg: "aes-256-gcm",
    iter: PBKDF2_ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  });
}
