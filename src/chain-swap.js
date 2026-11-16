/** Route labels for the other-chain swap panel. Quotes only. Hog does not broadcast these routers. */

export const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const SUSHI_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
export const HEMI_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const HEMI_SUSHI_QUOTE = "https://api.sushi.com/swap/v7/43111";
const JUP_BRIDGE_QUOTE = "https://bridge-api.gum.ag/api/bridge/quote";

const ETH = { symbol: "ETH", mark: "ETH" };
const HEMI_ETH = { symbol: "ETH", mark: "HEMIETH" };
const BTC = { symbol: "BTC", mark: "BTC" };
const HEMI_BTC = { symbol: "hemiBTC", mark: "HEMIBTC" };
const SOL = { symbol: "SOL", mark: "SOL" };

/** Ethereum and Solana assets the Jupiter tunnel can move. A Solana swap token such as JUP is absent. */
export const JUP_BRIDGE = [
  { id: "bridge:ethereum:ETH", network: "ethereum", symbol: "ETH", name: "Ether", address: "0x0000000000000000000000000000000000000000", decimals: 18, native: true },
  { id: "bridge:ethereum:USDC", network: "ethereum", symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, native: false },
  { id: "bridge:ethereum:USDT", network: "ethereum", symbol: "USDT", name: "Tether", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, native: false },
  { id: "bridge:solana:SOL", network: "solana", symbol: "SOL", name: "Solana", address: "11111111111111111111111111111111", decimals: 9, native: true },
  { id: "bridge:solana:USDC", network: "solana", symbol: "USDC", name: "USD Coin", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, native: false },
  { id: "bridge:solana:USDT", network: "solana", symbol: "USDT", name: "Tether", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, native: false },
];

export function lockedSwapRoute(input) {
  const withdraw = input.direction === "withdraw";
  const stargate = input.chain === "hemi" && input.mode === "swap" && input.venue === "stargate";
  const ethTunnel = (input.chain === "hemi" && input.mode === "tunnel" && input.target === "eth")
    || (input.chain === "ethereum" && input.mode === "tunnel" && input.target === "hemi");
  if (stargate || ethTunnel) {
    return {
      pay: withdraw ? HEMI_ETH : ETH,
      receive: withdraw ? ETH : HEMI_ETH,
      subtitle: stargate
        ? (withdraw ? "ETH · Hemi → Ethereum" : "ETH · Ethereum → Hemi")
        : (withdraw ? "hemiETH → ETH" : "ETH → hemiETH"),
      payNetwork: withdraw ? "Hemi" : "Ethereum",
      receiveNetwork: withdraw ? "Ethereum" : "Hemi",
      hint: stargate
        ? "Stargate moves native ETH between Ethereum and Hemi. The message fee is on top of the amount."
        : "The Hemi standard bridge moves ETH 1 for 1. A withdrawal is proved on Ethereum, then finalized after the wait.",
    };
  }
  if (input.chain === "solana" && input.mode === "tunnel" && input.target === "bitcoin") {
    return {
      pay: withdraw ? BTC : SOL,
      receive: withdraw ? SOL : BTC,
      subtitle: withdraw ? "Bitcoin → Solana" : "Solana → Bitcoin",
      payNetwork: withdraw ? "Bitcoin" : "Solana",
      receiveNetwork: withdraw ? "Solana" : "Bitcoin",
      hint: "This tunnel moves SOL and BTC between Solana and Bitcoin.",
    };
  }
  const btcTunnel = input.chain === "bitcoin" || (input.chain === "hemi" && input.mode === "tunnel" && input.target === "btc");
  if (btcTunnel) {
    return {
      pay: withdraw ? HEMI_BTC : BTC,
      receive: withdraw ? BTC : HEMI_BTC,
      subtitle: withdraw ? "hemiBTC → BTC" : "BTC → hemiBTC",
      payNetwork: withdraw ? "Hemi" : "Bitcoin",
      receiveNetwork: withdraw ? "Bitcoin" : "Hemi",
      hint: "The Hemi vault tunnels Bitcoin. hemiBTC mints after confirmations, and a withdrawal pays Bitcoin back.",
    };
  }
  return null;
}

export function tunnelEnds(input) {
  if (input.mode !== "tunnel") return null;
  const forward = forwardChains(input.chain, input.target);
  if (!forward) return null;
  const withdraw = input.direction === "withdraw";
  const payChain = withdraw ? forward.to : forward.from;
  const receiveChain = withdraw ? forward.from : forward.to;
  return { payChain, receiveChain, subtitle: `${payChain} → ${receiveChain}` };
}

function forwardChains(chain, target) {
  if (chain === "bitcoin" || (chain === "hemi" && target === "btc")) return { from: "Bitcoin", to: "Hemi" };
  if ((chain === "hemi" && target === "eth") || (chain === "ethereum" && target === "hemi")) return { from: "Ethereum", to: "Hemi" };
  if (chain === "ethereum" && target === "solana") return { from: "Ethereum", to: "Solana" };
  if (chain === "solana" && target === "ethereum") return { from: "Solana", to: "Ethereum" };
  if (chain === "solana" && target === "bitcoin") return { from: "Solana", to: "Bitcoin" };
  return null;
}

/** Jupiter tunnel pair. Each side stays on its own chain. ETH, SOL, USDC, and USDT bridge. */
export function jupTunnelPair(input) {
  const all = [...input.ethereum, ...input.solana];
  const pickedPay = all.find((row) => row.id === input.payId);
  const pickedReceive = all.find((row) => row.id === input.receiveId);
  const otherSide = (asset) => (asset.network === "ethereum" ? input.solana[0] : input.ethereum[0]);
  if (pickedPay && pickedReceive && pickedPay.network !== pickedReceive.network) {
    return { pay: pickedPay, receive: pickedReceive };
  }
  if (pickedPay) {
    const receive = otherSide(pickedPay);
    if (!receive) throw new Error("The bridge has no assets.");
    return { pay: pickedPay, receive };
  }
  if (pickedReceive) {
    const pay = otherSide(pickedReceive);
    if (!pay) throw new Error("The bridge has no assets.");
    return { pay, receive: pickedReceive };
  }
  const pay = input.page === "solana" ? input.solana[0] : input.ethereum[0];
  const receive = input.page === "solana" ? input.ethereum[0] : input.solana[0];
  if (!pay || !receive) throw new Error("The bridge has no assets.");
  return { pay, receive };
}

/** Hemi Sushi starts on USDT. Other networks keep the next listed token. */
export function counterpartToken(tokens, pay, receiveId, chain) {
  const chosen = tokens.find((token) => token.id === receiveId && token.id !== pay?.id);
  if (chosen) return chosen;
  if (chain === "hemi") {
    const usdt = tokens.find((token) => token.symbol === "USDT" && token.id !== pay?.id);
    if (usdt) return usdt;
  }
  return tokens.find((token) => token.id !== pay?.id);
}

/** SushiSwap V2 path through WETH. Native legs use the wrapped asset. */
export function sushiPath(pay, receive, weth) {
  const payAddr = pay.native ? weth : pay.address;
  const receiveAddr = receive.native ? weth : receive.address;
  if (pay.native && receive.native) throw new Error("Choose two different assets.");
  if (!pay.native && !receive.native && String(pay.address).toLowerCase() === String(receive.address).toLowerCase()) {
    throw new Error("Choose two different assets.");
  }
  if (pay.native) return [weth, receiveAddr];
  if (receive.native) return [payAddr, weth];
  return [payAddr, weth, receiveAddr];
}

function padWord(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** ABI calldata for getAmountsOut(uint256,address[]). */
export function encodeGetAmountsOut(amount, path) {
  const addresses = path.map((addr) => String(addr).toLowerCase().replace(/^0x/, "").padStart(64, "0")).join("");
  return `0xd06ca61f${padWord(amount)}${padWord(64)}${padWord(path.length)}${addresses}`;
}

/** Last uint256 in an ABI-encoded uint256[] eth_call result. */
export function decodeAmountsOut(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  const words = body.match(/.{64}/g) || [];
  if (words.length < 3) return 0n;
  const length = Number(BigInt(`0x${words[1]}`));
  if (!Number.isInteger(length) || length < 1 || words.length < 2 + length) return 0n;
  return BigInt(`0x${words[1 + length]}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Jupiter quote for two Solana mints. Native SOL uses the wrapped mint. Does not build a transaction. */
export async function quoteJupiter({ inputMint, outputMint, amount, slippageBps, fetchImpl = globalThis.fetch }) {
  if (inputMint === outputMint) throw new Error("Choose two different assets.");
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  const response = await fetchImpl(`${JUPITER_QUOTE}?${params}`);
  const body = await readJson(response);
  if (!response.ok || !body || body.error || !body.outAmount) {
    throw new Error(body?.error || body?.message || "Jupiter could not quote that swap.");
  }
  const labels = Array.isArray(body.routePlan)
    ? body.routePlan.map((leg) => leg?.swapInfo?.label).filter(Boolean)
    : [];
  return {
    outAmount: String(body.outAmount),
    minOut: String(body.otherAmountThreshold || body.outAmount),
    impactPct: body.priceImpactPct || "0",
    route: labels.length ? labels.join(" → ") : "Jupiter",
  };
}

/** Hemi Sushi quote. The returned transaction is dropped so this cannot be broadcast by accident. */
export async function quoteHemiSushi({ tokenIn, tokenOut, amount, slippageBps, sender, fetchImpl = globalThis.fetch }) {
  if (String(tokenIn).toLowerCase() === String(tokenOut).toLowerCase()) throw new Error("Choose two different assets.");
  const url = new URL(HEMI_SUSHI_QUOTE);
  url.searchParams.set("tokenIn", tokenIn);
  url.searchParams.set("tokenOut", tokenOut);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("maxSlippage", String(slippageBps / 10000));
  url.searchParams.set("sender", sender);
  const response = await fetchImpl(url.toString());
  const body = await readJson(response);
  if (!body || typeof body !== "object") throw new Error("Sushi returned an incomplete quote.");
  if (!response.ok || body.status !== "Success") {
    throw new Error(body.status === "NoWay" ? "Sushi has no route for that amount on Hemi." : "Sushi returned an incomplete quote.");
  }
  let outAmount = 0n;
  try {
    outAmount = BigInt(String(body.assumedAmountOut || "0"));
  } catch {
    outAmount = 0n;
  }
  if (outAmount <= 0n) throw new Error("Sushi returned an empty quote.");
  return { outAmount: outAmount.toString(), route: "SushiSwap" };
}

/** Public Jupiter bridge quote. Execution payloads are not returned. */
export async function quoteJupBridge({ pay, receive, amount, ethAddress, solAddress, slippageBps, fetchImpl = globalThis.fetch }) {
  if (pay.network === receive.network) throw new Error("Pick one asset on Ethereum and one on Solana.");
  const ethToSol = pay.network === "ethereum";
  const response = await fetchImpl(JUP_BRIDGE_QUOTE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      inputToken: {
        chainId: pay.network === "ethereum" ? "evm:1" : "solana:mainnet",
        address: pay.address,
        symbol: pay.symbol,
        name: pay.name,
        decimals: pay.decimals,
        isNative: pay.native,
      },
      outputToken: {
        chainId: receive.network === "ethereum" ? "evm:1" : "solana:mainnet",
        address: receive.address,
        symbol: receive.symbol,
        name: receive.name,
        decimals: receive.decimals,
        isNative: receive.native,
      },
      amount: String(amount),
      slippageBps,
      execution: {
        sourceAddress: ethToSol ? ethAddress : solAddress,
        recipient: ethToSol ? solAddress : ethAddress,
      },
    }),
  });
  const body = await readJson(response);
  if (response.status === 429) throw new Error("Bridge quotes are busy. Wait a moment and try again.");
  if (!response.ok || !body || !Array.isArray(body.routes)) {
    const minimum = body && (body.minimumUsd ?? body.minimum);
    if (minimum != null) throw new Error(`Minimum bridge amount is $${minimum}.`);
    throw new Error("No route is available for that amount.");
  }
  const routes = body.routes.filter((row) => row && (row.provider === "relay" || row.provider === "mayan") && /^\d+$/.test(String(row.outAmount || "")));
  routes.sort((a, b) => (BigInt(a.outAmount) > BigInt(b.outAmount) ? -1 : 1));
  const best = routes[0];
  if (!best) throw new Error("No route is available for that amount.");
  const label = typeof best.routeLabel === "string" && best.routeLabel.trim()
    ? best.routeLabel.trim()
    : best.provider === "relay" ? "Relay" : "Mayan";
  return { outAmount: String(best.outAmount), minOut: String(best.minOutAmount || best.outAmount), route: label };
}
