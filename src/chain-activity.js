const ETH_SCAN = "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api";
const HEMI_SCAN = "https://api.routescan.io/v2/network/mainnet/evm/43111/etherscan/api";
const MEMPOOL = "https://mempool.space";
const SOLANA_RPC = "https://solana.publicnode.com";

function formatUnits(value, decimals, places = 6) {
  const scale = 10n ** BigInt(decimals);
  const raw = value < 0n ? -value : value;
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${whole.toString()}${frac ? `.${frac}` : ""}`;
}

async function scan(base, action, address, fetchImpl) {
  const params = new URLSearchParams({
    module: "account",
    action,
    address,
    page: "1",
    offset: "25",
    sort: "desc",
  });
  const response = await fetchImpl(`${base}?${params}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Activity is unavailable.");
  const body = await response.json();
  if (Array.isArray(body.result)) return body.result;
  if (typeof body.result === "string" && /no transactions/i.test(body.result)) return [];
  if (typeof body.result === "string" && body.result.trim()) throw new Error(body.result);
  return [];
}

function evmFee(tx) {
  try {
    const gas = BigInt(tx.gasUsed || "0");
    const price = BigInt(tx.gasPrice || "0");
    if (gas <= 0n || price <= 0n) return "";
    return `${formatUnits(gas * price, 18)} ETH`;
  } catch {
    return "";
  }
}

function evmWhen(tx) {
  const n = Number(tx.timeStamp || 0);
  return n > 0 ? n * 1000 : 0;
}

function chainFields(tx, { hash, incoming, failed, symbol, fee = "" }) {
  return {
    hash: hash || "",
    from: tx.from || "",
    to: tx.to || "",
    fee,
    time: evmWhen(tx),
    height: Number(tx.blockNumber) || 0,
    status: failed ? "Failed" : "Confirmed",
    tone: failed ? "fail" : incoming ? "in" : "out",
    symbol,
  };
}

export function rowsFromEvm(address, txs, tokens, network) {
  const me = String(address || "").toLowerCase();
  const explorer = network === "hemi" ? "https://explorer.hemi.xyz/tx/" : "https://etherscan.io/tx/";
  const native = "ETH";
  const rows = [];
  for (const tx of txs) {
    let value = 0n;
    try { value = BigInt(tx.value || "0"); } catch { value = 0n; }
    if (value <= 0n || !tx.hash) continue;
    const incoming = String(tx.to || "").toLowerCase() === me;
    const failed = tx.isError === "1" || tx.txreceipt_status === "0";
    rows.push({
      id: `${tx.hash}:native`,
      title: failed ? `${native} transfer failed` : incoming ? `Received ${native}` : `Sent ${native}`,
      amount: `${incoming ? "+" : "−"} ${formatUnits(value, 18)} ${native}`,
      incoming,
      failed,
      url: `${explorer}${tx.hash}`,
      ...chainFields(tx, { hash: tx.hash, incoming, failed, symbol: native, fee: evmFee(tx) }),
    });
  }
  for (const tx of tokens) {
    if (!tx.hash) continue;
    const decimals = Number(tx.tokenDecimal || "18");
    const symbol = tx.tokenSymbol || "token";
    let value = 0n;
    try { value = BigInt(tx.value || "0"); } catch { value = 0n; }
    if (value <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
    const incoming = String(tx.to || "").toLowerCase() === me;
    rows.push({
      id: `${tx.hash}:${String(tx.contractAddress || symbol).toLowerCase()}`,
      title: incoming ? `Received ${symbol}` : `Sent ${symbol}`,
      amount: `${incoming ? "+" : "−"} ${formatUnits(value, decimals)} ${symbol}`,
      incoming,
      failed: false,
      url: `${explorer}${tx.hash}`,
      ...chainFields(tx, { hash: tx.hash, incoming, failed: false, symbol }),
    });
  }
  return rows.slice(0, 40);
}

export function rowsFromBitcoin(address, txs) {
  return (Array.isArray(txs) ? txs : []).slice(0, 25).map((tx) => {
    let net = 0n;
    for (const input of tx.vin || []) {
      if (input.prevout?.scriptpubkey_address === address) net -= BigInt(Math.trunc(input.prevout.value || 0));
    }
    for (const output of tx.vout || []) {
      if (output.scriptpubkey_address === address) net += BigInt(Math.trunc(output.value || 0));
    }
    const incoming = net > 0n;
    const txid = tx.txid || "";
    const otherIn = (tx.vin || []).find((input) => input.prevout?.scriptpubkey_address && input.prevout.scriptpubkey_address !== address);
    const otherOut = (tx.vout || []).find((output) => output.scriptpubkey_address && output.scriptpubkey_address !== address);
    let fee = "";
    try {
      if (tx.fee != null) fee = `${formatUnits(BigInt(Math.trunc(Number(tx.fee))), 8)} BTC`;
    } catch {
      fee = "";
    }
    return {
      id: txid,
      title: tx.status?.confirmed === false ? "Bitcoin pending" : incoming ? "Received BTC" : "Sent BTC",
      amount: `${incoming ? "+" : "−"} ${formatUnits(net < 0n ? -net : net, 8)} BTC`,
      incoming,
      failed: false,
      url: txid ? `https://mempool.space/tx/${txid}` : "",
      hash: txid,
      from: incoming ? (otherIn?.prevout?.scriptpubkey_address || "") : address,
      to: incoming ? address : (otherOut?.scriptpubkey_address || ""),
      fee,
      time: Number(tx.status?.block_time || 0) * 1000,
      height: Number(tx.status?.block_height || 0),
      status: tx.status?.confirmed === false ? "Pending" : "Confirmed",
      tone: incoming ? "in" : "out",
      symbol: "BTC",
    };
  });
}

export function rowsFromSolana(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.signature,
    title: row.err ? "Solana transaction failed" : "Solana transaction",
    amount: row.err ? "Failed" : "Confirmed",
    incoming: false,
    failed: Boolean(row.err),
    url: row.signature ? `https://solscan.io/tx/${row.signature}` : "",
    hash: row.signature || "",
    symbol: "SOL",
    status: row.err ? "Failed" : "Confirmed",
    tone: row.err ? "fail" : "",
    time: row.blockTime ? Number(row.blockTime) * 1000 : 0,
  }));
}

async function solanaTransfer(address, signature, fetchImpl) {
  const response = await fetchImpl(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const tx = body?.result;
  if (!tx?.meta) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => (key?.pubkey || key) === address);
  if (index < 0) return null;
  const pre = BigInt(tx.meta.preBalances?.[index] ?? 0);
  const post = BigInt(tx.meta.postBalances?.[index] ?? 0);
  const delta = post - pre;
  const abs = delta < 0n ? -delta : delta;
  return {
    incoming: delta > 0n,
    amount: `${delta > 0n ? "+" : "−"} ${formatUnits(abs, 9)} SOL`,
    fee: tx.meta.fee != null ? `${formatUnits(BigInt(tx.meta.fee), 9)} SOL` : "",
    time: Number(tx.blockTime || 0) * 1000,
    height: Number(tx.slot || 0),
  };
}

export async function readChainActivity(chain, address, fetchImpl = globalThis.fetch) {
  if (!address) return [];
  if (chain === "ethereum" || chain === "hemi") {
    const base = chain === "hemi" ? HEMI_SCAN : ETH_SCAN;
    const [txs, tokens] = await Promise.all([
      scan(base, "txlist", address, fetchImpl),
      scan(base, "tokentx", address, fetchImpl).catch(() => []),
    ]);
    return rowsFromEvm(address, txs, tokens, chain);
  }
  if (chain === "bitcoin") {
    const response = await fetchImpl(`${MEMPOOL}/api/address/${encodeURIComponent(address)}/txs`);
    if (!response.ok) throw new Error("Bitcoin activity is unavailable.");
    return rowsFromBitcoin(address, await response.json());
  }
  if (chain === "solana") {
    const response = await fetchImpl(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [address, { limit: 20 }],
      }),
    });
    if (!response.ok) throw new Error("Solana activity is unavailable.");
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || "Solana activity is unavailable.");
    const rows = rowsFromSolana(body.result);
    return Promise.all(rows.map(async (row) => {
      if (!row.hash) return row;
      try {
        const extra = await solanaTransfer(address, row.hash, fetchImpl);
        if (!extra) return row;
        return {
          ...row,
          ...extra,
          title: row.failed ? row.title : extra.incoming ? "Received SOL" : "Sent SOL",
          tone: row.failed ? "fail" : extra.incoming ? "in" : "out",
          incoming: extra.incoming,
        };
      } catch {
        return row;
      }
    }));
  }
  return [];
}
