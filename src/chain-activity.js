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
    return {
      id: txid,
      title: tx.status?.confirmed === false ? "Bitcoin pending" : incoming ? "Received BTC" : "Sent BTC",
      amount: `${incoming ? "+" : "−"} ${formatUnits(net < 0n ? -net : net, 8)} BTC`,
      incoming,
      failed: false,
      url: txid ? `https://mempool.space/tx/${txid}` : "",
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
  }));
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
    return rowsFromSolana(body.result);
  }
  return [];
}
