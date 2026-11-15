import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchIndexerHistory,
  historyFilters,
  historyItemsFromNode,
  matchesHistoryFilter,
  normalizeIndexerTransaction,
  rewardWindowCounts,
} from "../src/wart-history.js";

const viewer = "ab".repeat(24);

test("node history flattens rewards and transfers for the viewer", () => {
  const page = {
    fromId: 10,
    perBlock: [{
      height: 20,
      header: { time: { timestamp: 1_700_000_000 } },
      body: {
        reward: { transaction: { hash: "aa".repeat(32), data: { amount: { str: "50" } } } },
        wartTransfer: [{
          transaction: {
            hash: "bb".repeat(32),
            data: { amount: { str: "1.5" }, toAddress: viewer },
            signedCommon: { originAddress: "cd".repeat(24) },
          },
        }],
      },
    }],
  };
  const items = historyItemsFromNode(page, viewer);
  assert.equal(items.length, 2);
  assert.equal(items[0].isReward, true);
  assert.equal(items[0].direction, "in");
  assert.equal(items[0].amount, "+50 WART");
  assert.equal(items[1].type, "wart_transfer");
  assert.equal(items[1].direction, "in");
  assert.equal(items[1].amount, "+1.5 WART");
  assert.equal(items[1].fromAddress, "cd".repeat(24));
  const transfers = items.filter((tx) => matchesHistoryFilter(tx, "transfers", viewer));
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].txHash, "bb".repeat(32));
  assert.equal(historyFilters(false).some((item) => item.id === "limit_swaps"), false);
  assert.equal(historyFilters(true).some((item) => item.id === "limit_swaps"), true);
});

test("indexer cards keep confirmations and the summary", async () => {
  const row = normalizeIndexerTransaction({
    type: "limit_swap",
    direction: "out",
    amount: "0",
    height: 5,
    hash: "cc".repeat(32),
    timestamp: 1_700_000_000,
    meta: { summary: "Buy 10 HOG at 2" },
  }, 10);
  assert.equal(row.confirmations, 6);
  assert.equal(row.description, "Buy 10 HOG at 2");
  assert.equal(row.type, "limit_swap");
  const now = 1_800_000_000;
  const counts = rewardWindowCounts([
    { isReward: true, timestamp: now - 1000 },
    { isReward: true, timestamp: now - 900_000 },
    { isReward: false, timestamp: now },
  ], now);
  assert.equal(counts.h24, 1);
  assert.equal(counts.week, 1);
  assert.equal(counts.month, 2);
  let seen = "";
  const result = await fetchIndexerHistory(viewer, {
    filter: "limit_swaps",
    fetchImpl: async (url) => {
      seen = String(url);
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ ok: true, dbHeight: 10 }) };
      }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { transactions: [{ type: "limit_swap", direction: "out", amount: "1", height: 5, hash: "dd".repeat(32), timestamp: 1_700_000_000 }] },
        }),
      };
    },
  });
  assert.match(seen, /group=limit_swap/);
  assert.equal(result.source, "indexer");
  assert.equal(result.items[0].confirmations, 6);
  assert.equal(result.hasMore, false);
});
