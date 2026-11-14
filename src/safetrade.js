export const SAFE_ROOT = "https://safe.trade/api/v2";

export const SAFE_MARKETS = [
  { id: "wartusdt", base: "WART", quote: "USDT", amountPlaces: 4, pricePlaces: 4, minBase: 0.01 },
  { id: "btcusdt", base: "BTC", quote: "USDT", amountPlaces: 8, pricePlaces: 1, minBase: 0.00001 },
  { id: "ethusdt", base: "ETH", quote: "USDT", amountPlaces: 3, pricePlaces: 2, minBase: 0.00001 },
  { id: "ethbtc", base: "ETH", quote: "BTC", amountPlaces: 4, pricePlaces: 6, minBase: 0.0001 },
  { id: "solbtc", base: "SOL", quote: "BTC", amountPlaces: 2, pricePlaces: 8, minBase: 0.1 },
  { id: "usdcusdt", base: "USDC", quote: "USDT", amountPlaces: 4, pricePlaces: 5, minBase: 1 },
];

function hexOf(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of nonce + apiKey, hex. Matches SafeTrade's CryptoJS signature. */
export async function safeSignature(apiKey, secret, nonce) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${nonce}${apiKey}`));
  return hexOf(sig);
}

let lastNonce = 0;

function nextNonce() {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return String(lastNonce);
}

function asNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function floorDecimals(value, places) {
  const factor = 10 ** places;
  return Math.floor(value * factor + 1e-9) / factor;
}

async function safeRequest({ creds, path, method = "GET", body, fetchImpl = globalThis.fetch, nonce }) {
  const headers = { accept: "application/json" };
  if (creds) {
    const stamp = nonce || nextNonce();
    headers["X-Auth-Apikey"] = creds.apiKey;
    headers["X-Auth-Nonce"] = stamp;
    headers["X-Auth-Signature"] = await safeSignature(creds.apiKey, creds.secret, stamp);
  }
  if (body != null) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetchImpl(`${SAFE_ROOT}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "SafeTrade did not answer.");
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object"
      ? parsed.error || parsed.message || parsed.errors
      : parsed;
    const line = typeof message === "string" ? message : "SafeTrade rejected the request.";
    const error = new Error(line);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

export function safeMarket(id) {
  return SAFE_MARKETS.find((row) => row.id === id) || null;
}

export async function safeTicker(marketId, fetchImpl = globalThis.fetch) {
  const body = await safeRequest({ path: `/trade/public/tickers/${marketId}`, fetchImpl });
  const last = body && body.last != null ? String(body.last) : "";
  const known = safeMarket(marketId);
  const name = known ? `${known.base}/${known.quote}` : String(marketId).toUpperCase();
  if (!last) throw new Error(`SafeTrade did not return a ${name} price.`);
  return {
    market: name,
    last,
    change: body.price_change_percent != null ? String(body.price_change_percent) : "",
  };
}

export async function safeBalances(creds, fetchImpl = globalThis.fetch) {
  const body = await safeRequest({ creds, path: "/trade/account/balances/spot", fetchImpl });
  if (!Array.isArray(body)) throw new Error("SafeTrade did not return balances.");
  return body.map((row) => ({
    asset: String(row.currency ?? row.asset ?? "").toUpperCase(),
    available: asNumber(row.balance ?? row.available),
    locked: asNumber(row.locked),
  }));
}

function readOrder(body) {
  const row = body && typeof body === "object" ? body : {};
  return {
    id: String(row.id ?? row.uuid ?? ""),
    state: String(row.state ?? ""),
    side: String(row.side ?? ""),
    market: String(row.market ?? ""),
    price: asNumber(row.price),
    amount: asNumber(row.origin_volume ?? row.volume ?? row.amount),
    filled: asNumber(row.executed_volume ?? row.filled),
  };
}

export async function safeLimitOrder(creds, input, fetchImpl = globalThis.fetch) {
  const market = input.market;
  const amount = floorDecimals(Number(input.amount), market.amountPlaces);
  const price = Number(Number(input.price).toFixed(market.pricePlaces));
  if (!(amount > 0) || amount < market.minBase) {
    throw new Error(`Minimum ${market.base} order is ${market.minBase}.`);
  }
  if (!(price > 0)) throw new Error("Enter a price.");
  const body = await safeRequest({
    creds,
    path: "/trade/market/orders",
    method: "POST",
    body: { market: market.id, side: input.side, type: "limit", amount, price },
    fetchImpl,
  });
  return readOrder(body);
}

function orderRows(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray(body.data)) return body.data;
  return [];
}

export async function safeOpenOrders(creds, marketId, fetchImpl = globalThis.fetch) {
  const market = encodeURIComponent(marketId);
  let body;
  try {
    body = await safeRequest({
      creds,
      path: `/trade/market/orders?market=${market}&state=wait,pending&limit=100`,
      fetchImpl,
    });
  } catch (error) {
    if (error.status !== 400 && error.status !== 422) throw error;
    body = await safeRequest({
      creds,
      path: `/trade/market/orders?market=${market}&limit=100`,
      fetchImpl,
    });
  }
  return orderRows(body)
    .map(readOrder)
    .filter((row) => row.id && (!row.state || row.state === "wait" || row.state === "pending"));
}

export async function safeCancelOrder(creds, orderId, fetchImpl = globalThis.fetch) {
  if (!/^\d+$/.test(String(orderId))) throw new Error("That order cannot be canceled.");
  const body = await safeRequest({
    creds,
    path: `/trade/market/orders/${orderId}/cancel`,
    method: "POST",
    body: {},
    fetchImpl,
  });
  return readOrder(body);
}
