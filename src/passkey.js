const INFO = new TextEncoder().encode("hog-wallet-passkey-v1");

export function bytesToBase64Url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value) {
  const text = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function aesFromPrf(prfBytes) {
  if (!(prfBytes instanceof Uint8Array) || prfBytes.length < 32) {
    throw new Error("This passkey has no PRF secret. Use the password.");
  }
  const base = await crypto.subtle.importKey("raw", prfBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt the phrase or private key with the passkey PRF secret. */
export async function sealWithPrf(prfBytes, payload) {
  const key = await aesFromPrf(prfBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify({
      phrase: payload.phrase || "",
      privateKey: payload.privateKey || "",
    })),
  ));
  return { iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ct) };
}

/** Decrypt a Hog passkey record. An extension passkey uses a different HKDF label and will fail here. */
export async function openWithPrf(prfBytes, record) {
  const key = await aesFromPrf(prfBytes);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(record.iv) },
      key,
      base64UrlToBytes(record.ciphertext),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    const phrase = parsed && parsed.phrase ? String(parsed.phrase) : "";
    const privateKey = parsed && parsed.privateKey ? String(parsed.privateKey) : "";
    if (!phrase && !privateKey) throw new Error("empty");
    return { phrase, privateKey };
  } catch (error) {
    if (error instanceof Error && /PRF secret/.test(error.message)) throw error;
    throw new Error("Passkey unlock failed. Use the password.");
  }
}
