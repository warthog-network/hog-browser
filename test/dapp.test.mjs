import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ethers } from "ethers";
import { accountFromPrivateKey } from "../src/wallet-core.js";
import { answerDappRequest, chainKey, DappError } from "../src/dapp.js";

const KNOWN = "966a71a98bb5d13e9116c0dffa3f1a7877e45c6f563897b96cfd5c59bf0803e0";
const account = accountFromPrivateKey(KNOWN);

function asker(ok) {
  return async () => ok;
}

test("the Warthog key has an Ethereum address", () => {
  const wallet = new ethers.Wallet(`0x${KNOWN}`);
  assert.equal(account.evmAddress, wallet.address);
});

test("chain allowlist rejects a private network", () => {
  assert.equal(chainKey("0x1"), "0x1");
  assert.equal(chainKey("0xa867"), "0xa867");
  assert.equal(chainKey(43111), "0xa867");
  assert.equal(chainKey("0x539"), null);
});

test("a site sees no account until it is connected", async () => {
  const hidden = await answerDappRequest({
    method: "eth_accounts",
    params: [],
    origin: "https://app.uniswap.org",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0x1",
    connected: false,
    ask: asker(true),
  });
  assert.deepEqual(hidden.result, []);
  let asked = false;
  const connected = await answerDappRequest({
    method: "eth_requestAccounts",
    params: [],
    origin: "https://app.uniswap.org",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0x1",
    connected: false,
    ask: async (prompt) => {
      asked = prompt.title === "Connect" && prompt.lines.some((line) => line.value === account.evmAddress);
      return true;
    },
  });
  assert.equal(asked, true);
  assert.deepEqual(connected.result, [account.evmAddress]);
  assert.equal(connected.connect, true);
  assert.equal(JSON.stringify(connected).includes(account.privateKey), false);
});

test("a rejected signature is not produced", async () => {
  await assert.rejects(
    () => answerDappRequest({
      method: "personal_sign",
      params: ["hello", account.evmAddress],
      origin: "https://app.uniswap.org",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0x1",
      connected: true,
      ask: asker(false),
    }),
    (error) => error instanceof DappError && error.code === 4001,
  );
});

test("personal_sign matches ethers and stays off until connected", async () => {
  await assert.rejects(
    () => answerDappRequest({
      method: "personal_sign",
      params: ["hello", account.evmAddress],
      origin: "https://hemi.xyz",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0xa867",
      connected: false,
      ask: asker(true),
    }),
    (error) => error.code === 4100,
  );
  const signed = await answerDappRequest({
    method: "personal_sign",
    params: ["hello", account.evmAddress],
    origin: "https://hemi.xyz",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0xa867",
    connected: true,
    ask: asker(true),
  });
  const wallet = new ethers.Wallet(`0x${KNOWN}`);
  assert.equal(signed.result, await wallet.signMessage("hello"));
  assert.equal(JSON.stringify(signed).includes(KNOWN), false);
});

test("a signer answers personal_sign without a page private key", async () => {
  let seen = null;
  const signed = await answerDappRequest({
    method: "personal_sign",
    params: ["hello", account.evmAddress],
    origin: "https://hemi.xyz",
    address: account.evmAddress,
    chain: "0xa867",
    connected: true,
    signer: {
      async signMessage(message) {
        seen = message;
        return "0xsig";
      },
    },
    ask: asker(true),
  });
  assert.equal(seen, "hello");
  assert.equal(signed.result, "0xsig");
  await assert.rejects(
    () => answerDappRequest({
      method: "personal_sign",
      params: ["hello", account.evmAddress],
      origin: "https://hemi.xyz",
      address: account.evmAddress,
      chain: "0xa867",
      connected: true,
      ask: asker(true),
    }),
    (error) => error instanceof DappError && error.code === -32603,
  );
});

test("plain http cannot use the wallet, and a mismatched signature name is shown", async () => {
  await assert.rejects(
    () => answerDappRequest({
      method: "eth_chainId",
      params: [],
      origin: "http://evil.example",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0x1",
      connected: false,
      ask: asker(true),
    }),
    (error) => error.code === 4100,
  );
  const local = await answerDappRequest({
    method: "eth_chainId",
    params: [],
    origin: "http://127.0.0.1:8080",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0x1",
    connected: false,
    ask: asker(true),
  });
  assert.equal(local.result, "0x1");
  let prompt = null;
  await assert.rejects(
    () => answerDappRequest({
      method: "eth_signTypedData_v4",
      params: [account.evmAddress, JSON.stringify({
        types: {
          EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }],
          Mail: [{ name: "contents", type: "string" }],
        },
        primaryType: "Mail",
        domain: { name: "app.uniswap.org", chainId: 1 },
        message: { contents: "hi" },
      })],
      origin: "https://evil.example",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0x1",
      connected: true,
      ask: async (value) => {
        prompt = value;
        return false;
      },
    }),
    (error) => error.code === 4001,
  );
  assert.match(prompt.body, /does not match/);
  assert.equal(prompt.lines[0].label, "Site");
  assert.equal(prompt.lines[0].value, "evil.example");
  assert.equal(prompt.lines[1].value, "app.uniswap.org");
});

test("an unknown chain is refused and a known one can switch", async () => {
  await assert.rejects(
    () => answerDappRequest({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x539" }],
      origin: "https://app.uniswap.org",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0x1",
      connected: true,
      ask: asker(true),
    }),
    (error) => error.code === 4902,
  );
  const switched = await answerDappRequest({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: "0xa867" }],
    origin: "https://app.uniswap.org",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0x1",
    connected: true,
    ask: asker(true),
  });
  assert.equal(switched.chainKey, "0xa867");
  assert.equal(switched.result, null);
});

test("a rejected send does not broadcast", async () => {
  const calls = [];
  const rpc = async (chain, method, params) => {
    calls.push(method);
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_sendRawTransaction") return `0x${"ab".repeat(32)}`;
    return null;
  };
  await assert.rejects(
    () => answerDappRequest({
      method: "eth_sendTransaction",
      params: [{ from: account.evmAddress, to: account.evmAddress, value: "0x1" }],
      origin: "https://app.uniswap.org",
      address: account.evmAddress,
      privateKey: account.privateKey,
      chain: "0x1",
      connected: true,
      ask: asker(false),
      rpc,
    }),
    (error) => error.code === 4001,
  );
  assert.equal(calls.includes("eth_sendRawTransaction"), false);
});

test("an approved send broadcasts a signed transaction and returns only the hash", async () => {
  const calls = [];
  const rpc = async (chain, method, params) => {
    calls.push([method, params]);
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_getTransactionCount") return "0x1";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x2" };
    if (method === "eth_sendRawTransaction") {
      const parsed = ethers.Transaction.from(params[0]);
      assert.equal(parsed.from, account.evmAddress);
      return parsed.hash;
    }
    return null;
  };
  const sent = await answerDappRequest({
    method: "eth_sendTransaction",
    params: [{ from: account.evmAddress, to: account.evmAddress, value: "0x1" }],
    origin: "https://app.uniswap.org",
    address: account.evmAddress,
    privateKey: account.privateKey,
    chain: "0x1",
    connected: true,
    ask: asker(true),
    rpc,
  });
  assert.match(sent.result, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(sent).includes(KNOWN), false);
  assert.equal(calls.some((call) => call[0] === "eth_sendRawTransaction"), true);
});

test("the page provider posts a request and applies the answer", async () => {
  const posted = [];
  const sandbox = {
    posted,
    setTimeout(fn, ms) {
      if (ms >= 1000) return setTimeout(fn, ms);
      return 0;
    },
    clearTimeout,
    CustomEvent,
    Event,
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.webkit = { messageHandlers: { hogedge: { postMessage: (message) => posted.push(message) } } };
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../public/dapp-provider.js", import.meta.url), "utf8"), sandbox);
  assert.equal(sandbox.ethereum.isHog, true);
  assert.equal(sandbox.ethereum.isMetaMask, true);
  const pending = sandbox.ethereum.request({ method: "eth_chainId" });
  const message = JSON.parse(posted[0].slice(5));
  assert.equal(message.method, "eth_chainId");
  sandbox.__hogDappResolve(message.id, true, "0xa867");
  assert.equal(await pending, "0xa867");
  assert.equal(sandbox.ethereum.chainId, "0xa867");
});
