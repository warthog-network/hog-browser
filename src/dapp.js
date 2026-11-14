import { ethers } from "ethers";

/** Public networks a site may use. The site does not get to choose the RPC. */
export const CHAINS = {
  "0x1": { id: 1, name: "Ethereum", rpc: "https://ethereum.publicnode.com" },
  "0xa867": { id: 43111, name: "Hemi", rpc: "https://rpc.hemi.network/rpc" },
  "0x2105": { id: 8453, name: "Base", rpc: "https://mainnet.base.org" },
  "0xa4b1": { id: 42161, name: "Arbitrum", rpc: "https://arb1.arbitrum.io/rpc" },
  "0xa": { id: 10, name: "Optimism", rpc: "https://mainnet.optimism.io" },
  "0x89": { id: 137, name: "Polygon", rpc: "https://polygon-rpc.com" },
};

const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
]);

export class DappError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DappError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {string | null} Allowlisted chain key, such as "0x1".
 */
export function chainKey(value) {
  const id = chainNumber(value);
  if (id == null) return null;
  const key = `0x${id.toString(16)}`;
  return Object.prototype.hasOwnProperty.call(CHAINS, key) ? key : null;
}

/**
 * @param {string} origin
 */
export function siteHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "This site";
  }
}

/** https, or http on loopback. Plain http and Tailscale never get the wallet. */
export function providerOriginAllowed(origin) {
  let url;
  try {
    url = new URL(String(origin || ""));
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "tailscale.com" || host.endsWith(".tailscale.com")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return host === "127.0.0.1" || host === "localhost" || host === "::1";
  return false;
}

/**
 * A dotted domain name is compared to the real site. A display name such as
 * "Uniswap" is not a host, so it is shown without a mismatch warning.
 */
export function typedDomainWarning(domainName, origin) {
  const name = String(domainName || "");
  let host = "";
  try {
    host = new URL(String(origin || "")).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const shown = name.toLowerCase();
  const looksLikeHost = shown.includes(".");
  const mismatch = Boolean(
    looksLikeHost && host && shown !== host && !host.endsWith(`.${shown}`) && !shown.endsWith(`.${host}`),
  );
  return { host, mismatch };
}

/**
 * @param {string} chain
 * @param {string} method
 * @param {unknown[]} params
 */
export async function evmRpc(chain, method, params) {
  const row = CHAINS[chain];
  if (!row) throw new DappError(-32603, "That network is not available.");
  let response;
  try {
    response = await fetch(row.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new DappError(-32603, `${row.name} did not answer.`);
  }
  if (!response.ok) throw new DappError(-32603, `${row.name} did not answer.`);
  const body = await response.json();
  if (body && body.error) {
    throw new DappError(-32603, clip(body.error.message || `${row.name} rejected this request.`));
  }
  return body ? body.result ?? null : null;
}

/**
 * Answer one EIP-1193 request. The private key is used to sign and is not returned.
 * @param {{
 *   method: string,
 *   params: unknown,
 *   origin: string,
 *   address: string,
 *   privateKey: string,
 *   signer?: { signMessage: Function, signTypedData: Function, signTransaction: Function },
 *   chain: string,
 *   connected: boolean,
 *   ask: (prompt: { title: string, body: string, lines: {label: string, value: string}[], confirm: string, sure: boolean }) => Promise<boolean>,
 *   rpc?: typeof evmRpc,
 * }} input
 */
export async function answerDappRequest(input) {
  if (!providerOriginAllowed(input.origin)) {
    throw new DappError(4100, "Hog does not connect to this site.");
  }
  const method = String(input.method || "");
  const params = asParams(input.params);
  const chain = CHAINS[input.chain] ? input.chain : "0x1";
  const rpc = input.rpc || evmRpc;
  const host = siteHost(input.origin);
  const address = ethers.getAddress(input.address);

  if (method === "eth_chainId") return { result: chain };
  if (method === "net_version") return { result: String(CHAINS[chain].id) };
  if (method === "web3_clientVersion") return { result: "Hog" };
  if (method === "eth_syncing") return { result: false };
  if (method === "eth_accounts") return { result: input.connected ? [address] : [] };
  if (method === "wallet_getPermissions") {
    return { result: input.connected ? [{ parentCapability: "eth_accounts" }] : [] };
  }
  if (READ_METHODS.has(method)) return { result: await rpc(chain, method, params) };

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    const first = params[0];
    const requested = chainKey(first && typeof first === "object" ? first.chainId : first);
    if (!requested) throw new DappError(4902, "Hog does not use that network.");
    if (requested === chain) return { result: null, chainKey: requested };
    const ok = await input.ask({
      title: "Switch network",
      body: `${host} wants to switch this connection to ${CHAINS[requested].name}.`,
      lines: [{ label: "Network", value: CHAINS[requested].name }],
      confirm: "Switch",
      sure: false,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: null, chainKey: requested };
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    if (input.connected) return { result: accountsResult(method, address), connect: true, chainKey: chain };
    const ok = await input.ask({
      title: "Connect",
      body: `${host} wants to see this Ethereum address. It cannot move funds until you approve a transaction.`,
      lines: [
        { label: "Address", value: address },
        { label: "Network", value: CHAINS[chain].name },
      ],
      confirm: "Connect",
      sure: false,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: accountsResult(method, address), connect: true, chainKey: chain };
  }

  if (method === "wallet_revokePermissions") {
    return { result: null, disconnect: true };
  }

  if (!input.connected) throw new DappError(4100, "Connect this site first.");

  if (method === "personal_sign") {
    const parts = signParts(params);
    sameAddress(parts.address, address);
    const shown = previewMessage(parts.raw);
    const ok = await input.ask({
      title: "Sign",
      body: `${host} wants a signature. This does not send a transaction.`,
      lines: [{ label: "Message", value: shown }],
      confirm: "Sign",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: await signingWallet(input).signMessage(messageBytes(parts.raw)) };
  }

  if (method === "eth_signTypedData_v4" || method === "eth_signTypedData_v3") {
    const typed = parseTyped(params, CHAINS[chain].id);
    sameAddress(typed.address, address);
    const domain = typedDomainWarning(typed.domainName, input.origin);
    const ok = await input.ask({
      title: "Sign",
      body: domain.mismatch
        ? `${host} wants a typed signature. The name in the signature does not match this site.`
        : `${host} wants a typed signature. This does not send a transaction.`,
      lines: [
        { label: "Site", value: host },
        { label: "Name in signature", value: typed.domainName },
        { label: "Type", value: typed.primary },
        { label: "Message", value: typed.summary },
      ],
      confirm: "Sign",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: await signingWallet(input).signTypedData(typed.domain, typed.types, typed.message) };
  }

  if (method === "eth_sign" || method === "eth_signTypedData") {
    throw new DappError(-32601, "This site uses an old signature format. It needs personal_sign or typed data v4.");
  }

  if (method === "eth_sendTransaction") {
    const prepared = await prepareTx(params, address, chain, rpc);
    const ok = await input.ask({
      title: "Send",
      body: `${host} wants to send this on ${CHAINS[chain].name}.`,
      lines: [
        { label: "Action", value: prepared.action },
        { label: "To", value: prepared.to || "New contract" },
        { label: "Amount", value: `${ethers.formatEther(prepared.value)} ETH` },
        { label: "Max fee", value: prepared.fee == null ? "Unavailable" : `${ethers.formatEther(prepared.fee)} ETH` },
        { label: "Network", value: CHAINS[chain].name },
      ],
      confirm: "Send",
      sure: true,
    });
    if (!ok) throw new DappError(4001, "You rejected the request.");
    return { result: await broadcast(prepared, address, signingWallet(input), chain, rpc) };
  }

  throw new DappError(-32601, "Hog does not support that request.");
}

function accountsResult(method, address) {
  if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
  return [address];
}

function asParams(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  throw new DappError(-32602, "This request has bad parameters.");
}

function chainNumber(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000_000) return value;
  if (typeof value === "bigint" && value >= 0n && value < 1_000_000_000n) return Number(value);
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(text)) {
    const id = BigInt(text);
    if (id >= 1_000_000_000n) return null;
    return Number(id);
  }
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    if (!Number.isInteger(id) || id < 0 || id >= 1_000_000_000) return null;
    return id;
  }
  return null;
}

function signingWallet(input) {
  if (input.signer) return input.signer;
  if (!input.privateKey) throw new DappError(-32603, "The wallet key is not available.");
  return new ethers.Wallet(normalizeKey(input.privateKey));
}

function normalizeKey(hex) {
  const clean = String(hex || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new DappError(-32603, "The wallet key is not available.");
  return `0x${clean}`;
}

function sameAddress(given, expected) {
  if (given && ethers.getAddress(given) !== ethers.getAddress(expected)) {
    throw new DappError(4100, "This request is for a different address.");
  }
}

function signParts(params) {
  const texts = params.filter((item) => typeof item === "string");
  const address = texts.find((item) => ethers.isAddress(item)) || null;
  const raw = texts.find((item) => item !== address) || "";
  return { address: address ? ethers.getAddress(address) : null, raw };
}

function messageBytes(raw) {
  if (/^0x[0-9a-fA-F]*$/.test(raw) && raw.length % 2 === 0 && raw.length >= 2) return ethers.getBytes(raw);
  return raw;
}

function previewMessage(raw) {
  if (!raw) return "(empty message)";
  let text = raw;
  if (/^0x[0-9a-fA-F]*$/.test(raw) && raw.length % 2 === 0 && raw.length > 2) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(ethers.getBytes(raw));
    } catch {
      text = raw;
    }
  }
  const clean = text.replace(/\u0000/g, "");
  const shown = clean.trim() ? clean : raw;
  return shown.length > 600 ? `${shown.slice(0, 600)}…` : shown;
}

function parseTyped(params, chainId) {
  const texts = params.filter((item) => typeof item === "string");
  const address = texts.find((item) => ethers.isAddress(item)) || null;
  const payload = params.find((item) => item && typeof item === "object") || texts.find((item) => !ethers.isAddress(item));
  let body;
  if (typeof payload === "string") {
    try {
      body = JSON.parse(payload);
    } catch {
      throw new DappError(-32602, "This signature data is not readable.");
    }
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    body = payload;
  } else {
    throw new DappError(-32601, "This site uses an old signature format. It needs typed data v4.");
  }
  if (!body.types || !body.message || typeof body.types !== "object") {
    throw new DappError(-32602, "This signature data is not readable.");
  }
  const domain = { ...(body.domain || {}) };
  if (domain.chainId != null && chainNumber(domain.chainId) !== chainId) {
    throw new DappError(4902, "This signature is for a different network.");
  }
  const types = { ...body.types };
  delete types.EIP712Domain;
  const names = Object.keys(types);
  const primary = body.primaryType && types[body.primaryType] ? body.primaryType : names[names.length - 1];
  if (!primary) throw new DappError(-32602, "This signature data is not readable.");
  let summary = "";
  try {
    summary = JSON.stringify(body.message);
  } catch {
    summary = primary;
  }
  if (summary.length > 600) summary = `${summary.slice(0, 600)}…`;
  return {
    address: address ? ethers.getAddress(address) : null,
    domainName: typeof domain.name === "string" && domain.name ? domain.name : "Signature",
    primary,
    summary,
    domain,
    types,
    message: body.message,
  };
}

async function prepareTx(params, address, chain, rpc) {
  const first = params[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new DappError(-32602, "This transaction is missing.");
  }
  const tx = first;
  if (typeof tx.from === "string" && tx.from) {
    if (!ethers.isAddress(tx.from)) throw new DappError(-32602, "That from address is not valid.");
    sameAddress(tx.from, address);
  }
  if (tx.chainId != null && chainKey(tx.chainId) !== chain) {
    throw new DappError(4902, "This transaction is for a different network.");
  }
  const to = tx.to == null || tx.to === "" ? null : addressOf(tx.to);
  const value = tx.value == null ? 0n : hexQuantity(tx.value);
  const data = hexData(tx.data);
  const siteGas = tx.gas == null && tx.gasLimit == null ? null : hexQuantity(tx.gas ?? tx.gasLimit);
  if (siteGas != null && siteGas > 30_000_000n) throw new DappError(-32602, "That gas limit is too high.");
  let estimated = null;
  try {
    const raw = await rpc(chain, "eth_estimateGas", [{ from: address, to: to || undefined, value: hex(value), data }]);
    if (typeof raw === "string") estimated = hexQuantity(raw);
  } catch (error) {
    if (siteGas == null) throw error;
  }
  const gasLimit = siteGas != null && (estimated == null || siteGas >= estimated) ? siteGas : estimated;
  if (gasLimit == null || gasLimit <= 0n) throw new DappError(-32603, "Could not estimate this transaction.");
  const fees = await networkFees(tx, chain, rpc);
  const fee = fees.maxFeePerGas != null
    ? gasLimit * fees.maxFeePerGas
    : fees.gasPrice != null
      ? gasLimit * fees.gasPrice
      : null;
  return {
    to,
    value,
    data,
    gasLimit,
    nonce: tx.nonce == null ? null : safeNonce(hexQuantity(tx.nonce)),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    gasPrice: fees.gasPrice,
    fee,
    action: txAction(data, value, to),
  };
}

async function networkFees(tx, chain, rpc) {
  if (tx.maxFeePerGas != null || tx.maxPriorityFeePerGas != null) {
    const tip = tx.maxPriorityFeePerGas == null ? 0n : hexQuantity(tx.maxPriorityFeePerGas);
    const max = tx.maxFeePerGas == null ? tip : hexQuantity(tx.maxFeePerGas);
    return { maxFeePerGas: max, maxPriorityFeePerGas: tip, gasPrice: null };
  }
  if (tx.gasPrice != null) {
    return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: hexQuantity(tx.gasPrice) };
  }
  try {
    const [block, tipHex] = await Promise.all([
      rpc(chain, "eth_getBlockByNumber", ["latest", false]),
      rpc(chain, "eth_maxPriorityFeePerGas", []),
    ]);
    if (block && typeof block === "object" && block.baseFeePerGas && typeof tipHex === "string") {
      const base = hexQuantity(block.baseFeePerGas);
      const tip = hexQuantity(tipHex);
      return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip, gasPrice: null };
    }
  } catch {
    // Fall through to a legacy gas price.
  }
  const gasPrice = await rpc(chain, "eth_gasPrice", []);
  if (typeof gasPrice !== "string") throw new DappError(-32603, "The network did not return a fee.");
  return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: hexQuantity(gasPrice) };
}

async function broadcast(prepared, address, wallet, chain, rpc) {
  const nonce = prepared.nonce ?? safeNonce(hexQuantity(await rpc(chain, "eth_getTransactionCount", [address, "pending"])));
  const shared = {
    chainId: CHAINS[chain].id,
    nonce,
    gasLimit: prepared.gasLimit,
    to: prepared.to || undefined,
    value: prepared.value,
    data: prepared.data,
  };
  const signed = prepared.maxFeePerGas != null
    ? await wallet.signTransaction({
      ...shared,
      type: 2,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas ?? 0n,
    })
    : await wallet.signTransaction({
      ...shared,
      type: 0,
      gasPrice: prepared.gasPrice ?? 1n,
    });
  const parsed = ethers.Transaction.from(signed);
  if ((parsed.from || "").toLowerCase() !== address.toLowerCase()) {
    throw new DappError(-32603, "The signing key does not match this address.");
  }
  const hash = await rpc(chain, "eth_sendRawTransaction", [signed]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new DappError(-32603, "The network did not return a transaction hash.");
  }
  return hash;
}

function txAction(data, value, to) {
  const selector = data.slice(2, 10).toLowerCase();
  if (selector === "095ea7b3") return "Approve";
  if (selector === "a9059cbb") return "Token transfer";
  if (!to) return "Create contract";
  if (data === "0x") return value > 0n ? "Send" : "Contract call";
  return "Contract call";
}

function addressOf(value) {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new DappError(-32602, "That destination address is not valid.");
  }
  return ethers.getAddress(value);
}

function hexQuantity(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new DappError(-32602, "A value in this request is not hex.");
}

function hex(value) {
  return `0x${value.toString(16)}`;
}

function hexData(value) {
  if (value == null || value === "" || value === "0x") return "0x";
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new DappError(-32602, "The transaction data is not hex.");
  }
  return value.toLowerCase();
}

function safeNonce(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DappError(-32602, "That nonce is not valid.");
  return Number(value);
}

function clip(text) {
  const shown = String(text || "The network rejected this request.");
  return shown.length > 180 ? `${shown.slice(0, 180)}…` : shown;
}
