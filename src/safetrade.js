export const SAFE_ROOT = "https://safe.trade/api/v2";

/** Same-origin Hog proxy. safe.trade answers with Cross-Origin-Resource-Policy: same-origin, so the page cannot read it directly. */
export function safeApiRoot() {
  const loc = globalThis.location;
  if (loc && /^https?:$/i.test(loc.protocol) && loc.host) return `${loc.origin}/api/safetrade`;
  return SAFE_ROOT;
}

export const SAFE_MARKETS = [
  { id: "wartusdt", base: "WART", quote: "USDT", amountPlaces: 4, pricePlaces: 4, totalPlaces: 4, minBase: 0.01 },
  { id: "btcusdt", base: "BTC", quote: "USDT", amountPlaces: 8, pricePlaces: 1, totalPlaces: 4, minBase: 0.00001 },
  { id: "ethusdt", base: "ETH", quote: "USDT", amountPlaces: 3, pricePlaces: 2, totalPlaces: 4, minBase: 0.00001 },
  { id: "ethbtc", base: "ETH", quote: "BTC", amountPlaces: 4, pricePlaces: 6, totalPlaces: 4, minBase: 0.0001 },
  { id: "solbtc", base: "SOL", quote: "BTC", amountPlaces: 2, pricePlaces: 8, totalPlaces: 4, minBase: 0.1 },
  { id: "usdcusdt", base: "USDC", quote: "USDT", amountPlaces: 4, pricePlaces: 5, totalPlaces: 4, minBase: 1 },
];

/** Deposit and withdraw networks this wallet can hold. Hemi is absent: SafeTrade lists no Hemi network. */
export const SAFE_ROUTES = [
  { id: "wart:wart-key", currency: "wart", symbol: "WART", chain: "wart", network: "Warthog", blockchainKey: "wart-key", canDeposit: true, minDeposit: 20, minWithdraw: 5, fee: 0.1, confirmations: 100, decimals: 8 },
  { id: "btc:bitcoin-key", currency: "btc", symbol: "BTC", chain: "bitcoin", network: "Bitcoin", blockchainKey: "bitcoin-key", canDeposit: true, minDeposit: 0.0001, minWithdraw: 0.001, fee: 0.0001, confirmations: 1, decimals: 8 },
  { id: "eth:erc20_key", currency: "eth", symbol: "ETH", chain: "ethereum", network: "Ethereum", blockchainKey: "erc20_key", canDeposit: true, minDeposit: 0.01, minWithdraw: 0.01, fee: 0.004, confirmations: 7, decimals: 8 },
  { id: "usdt:erc20_key", currency: "usdt", symbol: "USDT", chain: "ethereum", network: "Ethereum", blockchainKey: "erc20_key", canDeposit: true, minDeposit: 50, minWithdraw: 50, fee: 3, confirmations: 7, decimals: 6 },
  { id: "usdc:erc20_key", currency: "usdc", symbol: "USDC", chain: "ethereum", network: "Ethereum", blockchainKey: "erc20_key", canDeposit: true, minDeposit: 50, minWithdraw: 50, fee: 7, confirmations: 7, decimals: 6 },
  { id: "sol:spl-key", currency: "sol", symbol: "SOL", chain: "solana", network: "Solana", blockchainKey: "spl-key", canDeposit: true, minDeposit: 0.005, minWithdraw: 0.01, fee: 0.009, confirmations: 32, decimals: 8 },
  { id: "usdt:spl-key", currency: "usdt", symbol: "USDT", chain: "solana", network: "Solana", blockchainKey: "spl-key", canDeposit: true, minDeposit: 0.01, minWithdraw: 2, fee: 1, confirmations: 32, decimals: 6 },
  { id: "usdc:spl-key", currency: "usdc", symbol: "USDC", chain: "solana", network: "Solana", blockchainKey: "spl-key", canDeposit: true, minDeposit: 0.001, minWithdraw: 1, fee: 3, confirmations: 32, decimals: 6 },
];

/** Direct market for two SafeTrade currencies. Null when the pair is not listed. */
export function safePair(pay, receive) {
  const left = String(pay || "").toLowerCase();
  const right = String(receive || "").toLowerCase();
  if (!left || left === right) return null;
  const market = SAFE_MARKETS.find((row) => {
    const base = row.base.toLowerCase();
    const quote = row.quote.toLowerCase();
    return (base === left && quote === right) || (base === right && quote === left);
  });
  if (!market) return null;
  return { market, side: market.base.toLowerCase() === left ? "sell" : "buy" };
}

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
    response = await fetchImpl(`${safeApiRoot()}${path}`, {
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
    const raw = parsed && typeof parsed === "object"
      ? parsed.error || parsed.message || (Array.isArray(parsed.errors) ? parsed.errors.join(" ") : parsed.errors)
      : parsed;
    const text = typeof raw === "string" ? raw : "";
    const auth = response.status === 401
      || /authz|nonce|signature|api.?key/i.test(text)
      || (creds && response.status === 404 && /not_found|authz|nonce|signature/i.test(text));
    const line = auth ? "SafeTrade rejected that API key." : (text || "SafeTrade rejected the request.");
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

const DEPTH_LIMIT = 500;

function readLevels(raw, highFirst) {
  if (!Array.isArray(raw)) return [];
  const levels = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = Number(row[0]);
    const amount = Number(row[1]);
    if (!(price > 0) || !(amount > 0) || !Number.isFinite(price) || !Number.isFinite(amount)) continue;
    levels.push({ price, amount });
  }
  levels.sort((a, b) => (highFirst ? b.price - a.price : a.price - b.price));
  return levels;
}

/** Public depth. Asks are cheapest first. Bids are highest first. No API key. */
export async function safeDepth(marketId, fetchImpl = globalThis.fetch) {
  const id = encodeURIComponent(marketId);
  const body = await safeRequest({
    path: `/trade/public/markets/${id}/depth?limit=${DEPTH_LIMIT}`,
    fetchImpl,
  });
  const rec = body && typeof body === "object" ? body : {};
  const asks = readLevels(rec.asks, false);
  const bids = readLevels(rec.bids, true);
  if (!asks.length && !bids.length) throw new Error("SafeTrade did not return an order book.");
  const rawAsks = Array.isArray(rec.asks) ? rec.asks.length : 0;
  const rawBids = Array.isArray(rec.bids) ? rec.bids.length : 0;
  return {
    asks,
    bids,
    asksCapped: rawAsks >= DEPTH_LIMIT,
    bidsCapped: rawBids >= DEPTH_LIMIT,
  };
}

/** Walk the book. A buy spends quote. A sell spends base. Null when that side is empty. */
export function walkBook(depth, side, spend, referencePrice) {
  if (!(spend > 0) || !Number.isFinite(spend)) return null;
  const levels = side === "buy" ? depth.asks : depth.bids;
  if (!levels.length) return null;
  let base = 0;
  let quote = 0;
  let left = spend;
  let touched = 0;
  for (const level of levels) {
    if (left <= spend * 1e-12) break;
    if (side === "buy") {
      const levelQuote = level.price * level.amount;
      if (!(levelQuote > 0)) continue;
      const takeQuote = Math.min(left, levelQuote);
      base += takeQuote / level.price;
      quote += takeQuote;
      left -= takeQuote;
    } else {
      const takeBase = Math.min(left, level.amount);
      base += takeBase;
      quote += takeBase * level.price;
      left -= takeBase;
    }
    touched += 1;
  }
  if (!(base > 0) || !(quote > 0)) return null;
  const complete = left <= Math.max(spend * 1e-9, 1e-12);
  const capped = side === "buy" ? depth.asksCapped : depth.bidsCapped;
  const referenceIsLast = referencePrice > 0 && Number.isFinite(referencePrice);
  const reference = referenceIsLast ? referencePrice : levels[0].price;
  const averagePrice = quote / base;
  const slippageBps = side === "buy"
    ? Math.round(((averagePrice - reference) / reference) * 10000)
    : Math.round(((reference - averagePrice) / reference) * 10000);
  const slippageQuote = side === "buy"
    ? base * (averagePrice - reference)
    : base * (reference - averagePrice);
  return {
    averagePrice,
    base,
    quote,
    touched,
    complete,
    shortBook: !complete && capped,
    bestPrice: levels[0].price,
    referencePrice: reference,
    referenceIsLast,
    slippageBps,
    slippageQuote,
  };
}

/** Worst price SafeTrade will accept. Null slippage on safeSwap omits max_price. */
export function safeSlippagePrice(last, side, slippageBps, pricePlaces) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) return null;
  if (!(last > 0) || !Number.isInteger(pricePlaces) || pricePlaces < 0 || pricePlaces > 12) return null;
  const factor = side === "buy" ? 1 + slippageBps / 10000 : 1 - slippageBps / 10000;
  const price = Number((last * factor).toFixed(pricePlaces));
  return price > 0 ? price : null;
}

function retryableOrderShape(error) {
  if (!error || (error.status !== 400 && error.status !== 422)) return false;
  return !/market_price_exceeded|insufficient_balance|less_than_min|geater_than_max|greater_than_max|non_round/i.test(error.message || "");
}

/** Market trade of a free SafeTrade balance. Buy spends quote. Sell spends base. */
export async function safeSwap(creds, input, fetchImpl = globalThis.fetch) {
  const market = input.market;
  const side = input.side;
  let maxPrice = null;
  let last = 0;
  if (input.slippageBps != null || side === "buy") {
    const ticker = await safeTicker(market.id, fetchImpl);
    last = Number(ticker.last);
  }
  if (input.slippageBps != null) {
    maxPrice = safeSlippagePrice(last, side, input.slippageBps, market.pricePlaces);
    if (maxPrice == null) throw new Error("That slippage does not leave a usable price.");
  }
  const bounded = maxPrice == null ? {} : { max_price: maxPrice };
  if (side === "sell") {
    const amount = floorDecimals(input.amount, market.amountPlaces);
    if (amount < market.minBase) throw new Error(`Minimum ${market.base} sell is ${market.minBase}.`);
    const body = await safeRequest({
      creds,
      path: "/trade/market/orders",
      method: "POST",
      body: { market: market.id, side: "sell", type: "market", amount, ...bounded },
      fetchImpl,
    });
    return readOrder(body);
  }
  const places = Number.isInteger(market.totalPlaces) ? market.totalPlaces : 4;
  const total = floorDecimals(input.amount, places);
  if (!(total > 0)) throw new Error("Enter an amount.");
  const postBuy = (type, extra) => safeRequest({
    creds,
    path: "/trade/market/orders",
    method: "POST",
    body: { market: market.id, side: "buy", type, ...extra, ...bounded },
    fetchImpl,
  });
  try {
    return readOrder(await postBuy("market", { total }));
  } catch (error) {
    if (!retryableOrderShape(error)) throw error;
    try {
      return readOrder(await postBuy("market_quote", { total }));
    } catch (again) {
      if (!retryableOrderShape(again) || !(last > 0)) throw again;
      const amount = floorDecimals(total / last, market.amountPlaces);
      if (amount < market.minBase) throw again;
      return readOrder(await postBuy("market", { amount }));
    }
  }
}

/** Public network rules. Null when SafeTrade cannot be read. */
export async function safePublicNetwork(currency, blockchainKey, fetchImpl = globalThis.fetch) {
  try {
    const body = await safeRequest({
      path: `/trade/public/currencies/${encodeURIComponent(currency)}`,
      fetchImpl,
    });
    const networks = body && Array.isArray(body.networks) ? body.networks : [];
    const network = networks.find((row) => row && String(row.blockchain_key ?? "") === blockchainKey);
    if (!network) return null;
    return {
      minDeposit: asNumber(network.min_deposit_amount),
      minWithdraw: asNumber(network.min_withdraw_amount),
      fee: asNumber(network.withdraw_fee),
      confirmations: asNumber(network.min_confirmations),
      depositEnabled: network.deposit_enabled !== false && String(network.status ?? "active") !== "disabled",
      withdrawEnabled: network.withdraw_enabled !== false && String(network.status ?? "active") !== "disabled",
    };
  } catch {
    return null;
  }
}

/** Signed deposit address. A memo query, when present, is stripped. */
export async function safeDepositAddress(creds, currency, blockchainKey, fetchImpl = globalThis.fetch) {
  const body = await safeRequest({
    creds,
    path: `/trade/account/deposit_address/${encodeURIComponent(currency)}?network=${encodeURIComponent(blockchainKey)}`,
    fetchImpl,
  });
  const nested = body && body.data && typeof body.data === "object" ? body.data : null;
  const address = String(body?.address ?? nested?.address ?? "").split("?memo=")[0].trim();
  if (!address) throw new Error("SafeTrade did not return a deposit address.");
  return address;
}

function recordList(body) {
  if (Array.isArray(body)) return body.filter((row) => row && typeof row === "object");
  if (body && typeof body === "object" && Array.isArray(body.data)) {
    return body.data.filter((row) => row && typeof row === "object");
  }
  return [];
}

function beneficiaryDestination(row) {
  const data = row.data && typeof row.data === "object" ? row.data : null;
  const nested = row.beneficiary && typeof row.beneficiary === "object" ? row.beneficiary : null;
  const raw = row.address ?? row.rid ?? data?.address ?? nested?.address ?? "";
  return String(raw).split("?memo=")[0].trim().toLowerCase();
}

function sameCoinAddress(row, address, blockchainKey) {
  const chain = String(row.blockchain_key ?? "");
  return beneficiaryDestination(row) === address.toLowerCase() && (chain === "" || chain === blockchainKey);
}

function usableBeneficiary(row) {
  const state = String(row.state ?? "active").toLowerCase();
  return state !== "pending" && state !== "disabled" && state !== "archived";
}

function readBeneficiaryId(body) {
  const nested = body && body.data && typeof body.data === "object" ? body.data : null;
  return asNumber(body?.id ?? nested?.id);
}

function readWithdraw(body) {
  const rec = body && typeof body === "object" ? body : {};
  return {
    id: String(rec.id ?? ""),
    status: String(rec.status ?? rec.state ?? ""),
    txid: rec.txid != null ? String(rec.txid) : "",
    amount: asNumber(rec.amount),
    fee: asNumber(rec.fee),
  };
}

async function listCoinBeneficiaries(creds, currency, fetchImpl) {
  return recordList(await safeRequest({
    creds,
    path: `/trade/account/beneficiaries?currency_id=${encodeURIComponent(currency)}&limit=100`,
    fetchImpl,
  }));
}

async function postCoinWithdraw(creds, coin, payload, fetchImpl, includeChain) {
  const send = (amount) => safeRequest({
    creds,
    path: "/trade/account/withdraws",
    method: "POST",
    body: {
      ...payload,
      amount,
      currency: coin.currency,
      ...(includeChain ? { blockchain_key: coin.blockchainKey } : {}),
    },
    fetchImpl,
  });
  const amount = asNumber(payload.amount);
  try {
    return readWithdraw(await send(amount));
  } catch (error) {
    const reduced = floorDecimals(amount - coin.fee, coin.decimals);
    if (!/insufficient|fee/i.test(error.message || "") || reduced < coin.min) throw error;
    return readWithdraw(await send(reduced));
  }
}

/**
 * Withdraw to an address already in this wallet.
 * SafeTrade rejects an address that is not an active address-book entry.
 * Returns `{ needCode, message }` when an email code or 2FA code is still required.
 */
export async function safeWithdrawCoin(creds, coin, input, fetchImpl = globalThis.fetch) {
  const asset = String(coin.currency || "").toUpperCase();
  const amount = floorDecimals(Number(input.amount), coin.decimals);
  const address = String(input.address || "").trim();
  if (!(amount >= coin.min)) throw new Error(`Minimum ${asset} withdraw is ${coin.min}.`);
  if (!address) throw new Error(`This wallet has no ${asset} address to withdraw to.`);
  const emailCode = String(input.emailCode || "").trim();
  const otpCode = String(input.otpCode || "").trim();
  const listed = await listCoinBeneficiaries(creds, coin.currency, fetchImpl);
  const matches = listed.filter((row) => sameCoinAddress(row, address, coin.blockchainKey));
  const active = matches.find(usableBeneficiary);
  if (active) {
    const beneficiaryId = asNumber(active.id);
    if (!(beneficiaryId > 0)) throw new Error("SafeTrade listed this address without an id.");
    try {
      return await postCoinWithdraw(creds, coin, {
        amount,
        beneficiary_id: beneficiaryId,
        ...(otpCode ? { otp_code: otpCode } : {}),
      }, fetchImpl, false);
    } catch (error) {
      if (/missing_otp|invalid_otp|otp/i.test(error.message || "")) {
        return {
          needCode: true,
          message: "This address is already saved. Enter the 2FA code from your authenticator, then withdraw again.",
        };
      }
      throw error;
    }
  }
  if (matches.some((row) => String(row.state ?? "").toLowerCase() === "pending")) {
    throw new Error("SafeTrade has this address saved but it is not active yet. Confirm it in the SafeTrade address book, then withdraw again.");
  }
  if (!emailCode) {
    await safeRequest({
      creds,
      path: "/trade/account/beneficiaries/generate_code",
      method: "POST",
      body: {
        type: "email",
        currency_id: coin.currency,
        blockchain_key: coin.blockchainKey,
        data: { address },
      },
      fetchImpl,
    });
    return {
      needCode: true,
      message: `SafeTrade will not send ${asset} until this address is in your address book. A code is in your email. Enter that code and your 2FA code, then withdraw again.`,
    };
  }
  if (!otpCode) {
    return {
      needCode: true,
      message: "Enter your 2FA code and withdraw again to save this address. Nothing is sent until that succeeds.",
    };
  }
  let created;
  try {
    created = await safeRequest({
      creds,
      path: "/trade/account/beneficiaries",
      method: "POST",
      body: {
        label: coin.bookLabel || asset,
        currency_id: coin.currency,
        blockchain_key: coin.blockchainKey,
        email_code: emailCode,
        otp_code: otpCode,
        data: { address },
      },
      fetchImpl,
    });
  } catch (error) {
    const message = error.message || "";
    if (/2fa_disabled/i.test(message)) {
      throw new Error("SafeTrade requires 2FA on the account before it will save a withdrawal address. Turn on 2FA in SafeTrade, then try again.");
    }
    if (/invalid_code|missing_email_code/i.test(message)) {
      return {
        needCode: true,
        clearEmail: true,
        message: "That email code cannot save this address. SafeTrade can send a new one. Clear the email code and withdraw again.",
      };
    }
    if (/invalid_otp|missing_otp/i.test(message)) {
      return { needCode: true, message: "SafeTrade rejected the 2FA code. Enter the current authenticator code and withdraw again." };
    }
    throw error;
  }
  const beneficiaryId = readBeneficiaryId(created);
  const state = String(created?.state ?? created?.data?.state ?? "").toLowerCase();
  if (state === "pending" || !(beneficiaryId > 0)) {
    return {
      needCode: true,
      message: "SafeTrade saved this address, but it is not active yet. Confirm it in the SafeTrade address book, then withdraw again.",
    };
  }
  try {
    return await postCoinWithdraw(creds, coin, {
      amount,
      beneficiary_id: beneficiaryId,
      otp_code: otpCode,
    }, fetchImpl, false);
  } catch (error) {
    if (/invalid_otp|missing_otp/i.test(error.message || "")) {
      return {
        needCode: true,
        message: "This address is saved in the SafeTrade address book. Enter a new 2FA code and withdraw again.",
      };
    }
    throw error;
  }
}
