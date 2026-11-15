/**
 * Warthog activity rows for the sidebar.
 * DeFi prefers the public explorer indexer. Every network can fall back to
 * the node history page. The card fields match the extension history panel.
 */

export const DEFI_INDEXER = "https://warthog-defitestnet.duckdns.org/api/explorer";

const MAINNET_FILTERS = [
  { id: "all", label: "All" },
  { id: "rewards", label: "Rewards" },
  { id: "transfers", label: "Transfers" },
  { id: "in", label: "In" },
  { id: "out", label: "Out" },
];

const DEFI_FILTERS = [
  ...MAINNET_FILTERS.slice(0, 3),
  { id: "limit_swaps", label: "Limit Swaps" },
  { id: "matches", label: "Matches" },
  { id: "cancels", label: "Cancels" },
  { id: "asset_creations", label: "Asset Creation" },
  { id: "liquidity", label: "Liquidity" },
  { id: "in", label: "In" },
  { id: "out", label: "Out" },
];

export function historyFilters(defi) {
  return defi ? DEFI_FILTERS : MAINNET_FILTERS;
}

function amountStr(value, fallback = "0") {
  if (value == null) return fallback;
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === "object") {
    if (value.str) return String(value.str);
    if (value.E8 != null) {
      const raw = BigInt(value.E8);
      const sign = raw < 0n ? "-" : "";
      const whole = raw < 0n ? -raw : raw;
      const frac = whole % 100_000_000n;
      const head = whole / 100_000_000n;
      const tail = frac.toString().padStart(8, "0").replace(/0+$/, "");
      return `${sign}${head}${tail ? `.${tail}` : ""}`;
    }
  }
  return fallback;
}

function epochSeconds(value) {
  const n = Number(value || 0);
  if (!n) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function when(timestamp, height) {
  const ts = epochSeconds(timestamp);
  if (ts > 0) return new Date(ts * 1000).toLocaleString();
  if (height) return `Block ${height}`;
  return "Unknown date";
}

function abbreviate(value) {
  const text = String(value || "");
  if (!text || text.length <= 12) return text || "N/A";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function zeroAmount(amount) {
  const text = String(amount ?? "").trim();
  if (!text || text === "0") return true;
  return /^0+(?:\.0+)?$/.test(text);
}

export function historyFilterQuery(filter) {
  const id = String(filter || "all").toLowerCase().replace(/-/g, "_");
  if (id === "rewards" || id === "reward") return { group: "reward" };
  if (id === "transfers" || id === "transfer") return { group: "transfer" };
  if (id === "limit_swaps" || id === "limit_swap") return { group: "limit_swap" };
  if (id === "matches" || id === "match") return { group: "match" };
  if (id === "cancels" || id === "cancel" || id === "cancelation") return { group: "cancelation" };
  if (id === "asset_creations" || id === "asset_creation") return { group: "asset_creation" };
  if (id === "liquidity") return { group: "liquidity" };
  if (id === "in" || id === "out") return { direction: id };
  return {};
}

export function matchesHistoryFilter(tx, filter, account) {
  if (!filter || filter === "all") return true;
  const type = String(tx.type || "").toLowerCase().replace(/-/g, "_");
  const reward = Boolean(tx.isReward) || type === "reward";
  const dir = String(tx.direction || "").toLowerCase();
  if (filter === "rewards") return reward;
  if (filter === "transfers") return type === "wart_transfer" || type === "token_transfer" || type === "transfer";
  if (filter === "limit_swaps") return type === "limit_swap";
  if (filter === "matches") return type === "match";
  if (filter === "cancels") return type === "cancelation" || type.includes("cancel");
  if (filter === "asset_creations") return type === "asset_creation";
  if (filter === "liquidity") return type === "liquidity_deposit" || type === "liquidity_withdrawal";
  if (filter === "in") {
    if (dir === "in") return true;
    if (dir === "out" || dir === "self") return false;
    return reward || tx.isIncoming === true || type === "liquidity_withdrawal";
  }
  if (filter === "out") {
    if (dir === "out") return true;
    if (dir === "in" || dir === "self") return false;
    if (reward || tx.isIncoming === true || type === "match") return false;
    return Boolean(account && tx.fromAddress && tx.fromAddress.toLowerCase().startsWith(account.slice(0, 40)));
  }
  return true;
}

export function rewardWindowCounts(items, nowSeconds = Date.now() / 1000) {
  const rewards = (items || []).filter((tx) => tx.isReward);
  const within = (span) => rewards.filter((tx) => epochSeconds(tx.timestamp) >= nowSeconds - span).length;
  return { h24: within(86400), week: within(604800), month: within(2592000) };
}

function typeName(hint) {
  if (hint === "reward") return "reward";
  if (hint === "wartTransfer") return "wart_transfer";
  if (hint === "tokenTransfer") return "token_transfer";
  if (hint === "liquidityDeposit") return "liquidity_deposit";
  if (hint === "liquidityWithdrawal") return "liquidity_withdrawal";
  if (hint === "limitSwap") return "limit_swap";
  if (hint === "assetCreation") return "asset_creation";
  if (hint === "cancelation") return "cancelation";
  return String(hint || "wart_transfer").replace(/-/g, "_");
}

function pushFlat(items, entry, block, hint) {
  const nested = entry?.transaction || entry || {};
  const data = nested.data || entry || {};
  const common = nested.signedCommon || nested.signingData || {};
  const reward = hint === "reward"
    || Boolean(entry?.txHash && !entry?.fromAddress && hint !== "wartTransfer")
    || Boolean(!common.originAddress && data.amount && !data.toAddress && hint === "reward");
  const header = block.header || {};
  const timestamp = header.time?.timestamp || Number(block.timestamp) || null;
  const fee = amountStr(data.fee ?? entry.fee ?? common.fee, "");
  items.push({
    amount: amountStr(data.amount ?? entry.amount ?? entry.amountE8 ?? data.wart ?? data.wartE8),
    toAddress: String(data.toAddress || entry.toAddress || entry.toAddr || ""),
    fromAddress: String(common.originAddress || data.fromAddress || entry.fromAddress || entry.fromAddr || ""),
    txHash: String(nested.hash || entry.txHash || entry.hash || entry.txid || ""),
    isReward: hint === "reward" || reward,
    height: Number(block.height) || undefined,
    timestamp,
    confirmations: Number(block.confirmations) || undefined,
    category: hint,
    fee: fee === "0" ? "" : fee,
  });
}

/** Flatten one node `account/.../history` page into card rows. */
export function historyItemsFromNode(raw, viewingAddress) {
  const perBlock = raw?.perBlock;
  if (!Array.isArray(perBlock)) return [];
  const flat = [];
  for (const block of perBlock) {
    const body = block?.body || block?.transactions || {};
    const rewards = body.rewards || block.transactions?.rewards;
    if (Array.isArray(rewards)) rewards.forEach((row) => pushFlat(flat, row, block, "reward"));
    const transfers = body.transfers || block.transactions?.transfers;
    if (Array.isArray(transfers)) transfers.forEach((row) => pushFlat(flat, row, block, "wartTransfer"));
    if (body.reward) {
      const list = Array.isArray(body.reward) ? body.reward : [body.reward];
      list.forEach((row) => pushFlat(flat, row, block, "reward"));
    }
    for (const key of ["wartTransfer", "tokenTransfer", "limitSwap", "liquidityDeposit", "liquidityWithdrawal", "assetCreation", "match", "cancelation"]) {
      if (!Array.isArray(body[key])) continue;
      body[key].forEach((row) => pushFlat(flat, row, block, key));
    }
  }
  const account = String(viewingAddress || "").toLowerCase().replace(/^0x/i, "");
  return flat.map((tx) => nodeItem(tx, account));
}

function nodeItem(tx, account) {
  const to = (tx.toAddress || "").toLowerCase();
  const from = (tx.fromAddress || "").toLowerCase();
  const head = account.slice(0, 40);
  let direction = "unknown";
  if (tx.isReward) direction = "in";
  else if (head && from.startsWith(head) && to.startsWith(head)) direction = "self";
  else if (head && from.startsWith(head)) direction = "out";
  else if (head && to.startsWith(head)) direction = "in";
  const type = typeName(tx.category);
  const signed = direction === "out" ? `-${tx.amount}` : direction === "in" ? `+${tx.amount}` : tx.amount;
  const action = tx.isReward
    ? "Reward"
    : type === "wart_transfer" && direction === "out"
      ? "Send WART"
      : type === "wart_transfer" && direction === "in"
        ? "Receive WART"
        : type === "token_transfer"
          ? "Token Transfer"
          : type === "limit_swap"
            ? "Limit Swap"
            : type === "match"
              ? "DEX Match"
              : type === "cancelation"
                ? "Cancel"
                : type === "liquidity_deposit"
                  ? "LP Deposit"
                  : type === "liquidity_withdrawal"
                    ? "LP Withdraw"
                    : type === "asset_creation"
                      ? "Create Asset"
                      : direction === "out"
                        ? "Send WART"
                        : direction === "in"
                          ? "Receive WART"
                          : "Transfer";
  const description = tx.isReward
    ? `Block reward ${tx.amount} WART`
    : direction === "out"
      ? `Sent ${tx.amount} WART`
      : direction === "in"
        ? `Received ${tx.amount} WART`
        : `${action} ${tx.amount} WART`;
  return {
    date: when(tx.timestamp, tx.height),
    action,
    amount: type === "wart_transfer" || tx.isReward ? `${signed} WART` : `${signed}`,
    amountRaw: tx.amount,
    usdAmount: "",
    txHash: tx.txHash,
    direction,
    type,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    height: tx.height,
    confirmations: tx.confirmations,
    timestamp: epochSeconds(tx.timestamp) || null,
    isReward: Boolean(tx.isReward),
    isIncoming: direction === "in",
    asset: "WART",
    description,
    fee: tx.fee,
    source: "node",
  };
}

export function mapIndexerType(raw) {
  const type = String(raw || "").toLowerCase().replace(/-/g, "_");
  if (!type) return "unknown";
  if (type === "reward") return "reward";
  if (type === "transfer" || type === "wart_transfer" || type === "warttransfer") return "wart_transfer";
  if (type === "token_transfer" || type === "tokentransfer") return "token_transfer";
  if (type === "limit_swap" || type === "limitswap") return "limit_swap";
  if (type === "match") return "match";
  if (type === "cancelation" || type === "cancellation" || type.includes("cancel")) return "cancelation";
  if (type === "asset_creation" || type === "assetcreation") return "asset_creation";
  if (type === "liquidity_deposit" || type === "liquiditydeposit") return "liquidity_deposit";
  if (type === "liquidity_withdrawal" || type === "liquiditywithdrawal" || type.includes("liquiditywithdraw")) return "liquidity_withdrawal";
  return type;
}

function actionLabel(type, reward, direction) {
  if (reward || type === "reward") return "Reward";
  if (type === "wart_transfer") return direction === "out" ? "Send WART" : direction === "in" ? "Receive WART" : "Transfer";
  if (type === "token_transfer") return "Token Transfer";
  if (type === "limit_swap") return "Limit Swap";
  if (type === "match") return "DEX Match";
  if (type === "cancelation") return "Cancel";
  if (type === "liquidity_deposit") return "LP Deposit";
  if (type === "liquidity_withdrawal") return "LP Withdraw";
  if (type === "asset_creation") return "Create Asset";
  return type.replace(/_/g, " ") || "Transfer";
}

function applyIndexerMeta(row, meta) {
  if (!meta || typeof meta !== "object") return row;
  const next = { ...row, meta };
  if (meta.summary) next.description = String(meta.summary);
  if (meta.asset_name) next.assetName = String(meta.asset_name);
  if (meta.asset_hash) next.assetHash = String(meta.asset_hash);
  const type = String(next.type || "");
  if (type === "limit_swap") {
    if (meta.side) next.side = String(meta.side);
    if (meta.order_amount != null) next.orderAmount = String(meta.order_amount);
    if (meta.limit_price != null) next.limitPrice = String(meta.limit_price);
    if (meta.order_amount && zeroAmount(next.amountRaw ?? next.amount)) {
      next.amountRaw = String(meta.order_amount);
      next.amount = String(meta.order_amount);
      next.asset = meta.side === "sell" ? meta.asset_name || "ASSET" : "WART";
    } else if (meta.asset_name && meta.side === "sell") next.asset = String(meta.asset_name);
  }
  if (type === "match") {
    if (meta.base_amount != null) next.baseAmount = String(meta.base_amount);
    if (meta.quote_amount != null) next.quoteAmount = String(meta.quote_amount);
    if (meta.swap_count != null) next.swapCount = Number(meta.swap_count);
    if (meta.base_amount) {
      next.amountRaw = String(meta.base_amount);
      next.amount = String(meta.base_amount);
      next.asset = meta.asset_name || next.asset || "ASSET";
      if (meta.quote_amount) next.amountSecondary = `${meta.quote_amount} WART`;
    }
  }
  if (type === "token_transfer" && meta.token_amount != null) {
    next.amountRaw = String(meta.token_amount);
    next.amount = String(meta.token_amount);
    if (meta.asset_name) next.asset = String(meta.asset_name);
  }
  if (type === "asset_creation" && meta.asset_name) next.asset = String(meta.asset_name);
  if (type === "cancelation" && meta.cancel_txid && !meta.summary) {
    next.description = `Canceled tx ${abbreviate(meta.cancel_txid)}`;
  }
  return next;
}

export function normalizeIndexerTransaction(tx, tipHeight = null) {
  const type = mapIndexerType(tx?.type);
  const reward = type === "reward";
  const directionRaw = String(tx?.direction || "").toLowerCase();
  const amount = tx?.amount != null ? String(tx.amount) : "0";
  const height = tx?.height != null ? Number(tx.height) : undefined;
  const incoming = directionRaw === "in" || reward || type === "liquidity_withdrawal";
  let direction = "unknown";
  if (directionRaw === "in" || directionRaw === "out" || directionRaw === "self") direction = directionRaw;
  else if (incoming) direction = "in";
  let asset = "WART";
  let description = type || "Transaction";
  if (type === "reward") description = `Block reward ${amount} WART`;
  else if (type === "wart_transfer") description = incoming ? `Received ${amount} WART` : `Sent ${amount} WART to ${abbreviate(tx?.recipient)}`;
  else if (type === "token_transfer") {
    asset = "TOKEN";
    description = incoming ? `Received ${amount}` : `Sent ${amount}`;
  } else if (type === "limit_swap") description = zeroAmount(amount) ? "Limit order placed" : `Limit order ${amount}`;
  else if (type === "match") description = zeroAmount(amount) ? "DEX match" : `DEX match ${amount} WART`;
  else if (type === "cancelation") description = "Canceled order";
  else if (type === "liquidity_deposit") description = `Liquidity deposit ${amount}`;
  else if (type === "liquidity_withdrawal") description = `Liquidity withdrawal ${amount}`;
  else if (type === "asset_creation") description = `Asset creation ${amount}`;
  const confirmations = tipHeight != null && height != null ? Math.max(0, Number(tipHeight) - height + 1) : undefined;
  const base = {
    date: when(tx?.timestamp, height),
    action: actionLabel(type, reward, direction),
    amount,
    amountRaw: amount,
    usdAmount: "",
    txHash: tx?.hash ? String(tx.hash) : "",
    direction,
    type,
    fromAddress: tx?.sender ? String(tx.sender) : "",
    toAddress: tx?.recipient ? String(tx.recipient) : "",
    height,
    confirmations,
    timestamp: epochSeconds(tx?.timestamp) || null,
    isReward: reward,
    isIncoming: incoming,
    asset,
    description,
    fee: tx?.fee != null ? String(tx.fee) : "",
    source: "indexer",
    assetName: null,
    assetHash: null,
    amountSecondary: null,
  };
  return applyIndexerMeta(base, tx?.meta);
}

export async function fetchIndexerHistory(address, { page = 1, filter = "all", count = 50, fetchImpl = globalThis.fetch, base = DEFI_INDEXER } = {}) {
  const addr = String(address || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(addr)) throw new Error("Invalid address for indexer history");
  const healthResponse = await fetchImpl(`${base}/health`, { headers: { accept: "application/json" } });
  if (!healthResponse.ok) throw new Error("Indexer is unavailable.");
  const health = await healthResponse.json();
  if (!health?.ok) throw new Error("Indexer is unavailable.");
  const query = historyFilterQuery(filter);
  const params = new URLSearchParams({ page: String(Math.max(1, page)), count: String(count) });
  if (query.group) params.set("group", query.group);
  if (query.direction) params.set("direction", query.direction);
  const response = await fetchImpl(`${base}/accounts/${addr}/transactions?${params}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Indexer history is unavailable.");
  const body = await response.json();
  if (body?.code !== 0) throw new Error(body?.error || "Indexer history is unavailable.");
  const txs = Array.isArray(body.data?.transactions) ? body.data.transactions : [];
  return {
    items: txs.map((tx) => normalizeIndexerTransaction(tx, health.dbHeight)),
    hasMore: txs.length >= count,
    nextPage: page + 1,
    source: "indexer",
  };
}
