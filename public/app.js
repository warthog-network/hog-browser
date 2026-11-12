import {
  chainAccountsFromPhrase,
  chainAccountsFromPrivateKey,
  evmTransferReserve,
  readNativeBalance,
  sendNativeEvm,
} from "./chains-bundle.js";
import { answerDappRequest, CHAINS, DappError } from "./dapp-bundle.js";
import { FitAddon, Terminal } from "./xterm-bundle.js";
import {
  createAccount,
  signAssetCreation,
  signCancel,
  signLimitSwap,
  signLiquidityDeposit,
  signLiquidityWithdraw,
  signWartTransfer,
  validateAddress,
} from "./wallet-bundle.js";
import {
  ROOT_ID as BOOKMARK_ROOT,
  addBookmark as addBookmarkEntry,
  addFolder as addBookmarkFolder,
  exportNetscape as exportBookmarkHtml,
  favorites as bookmarkFavorites,
  findByUrl as findBookmarkByUrl,
  folderPath as bookmarkFolderPath,
  folderTree as bookmarkFolderTree,
  hostLabel as bookmarkHost,
  importNetscape as importBookmarkHtml,
  listBookmarks as listBookmarkEntries,
  loadStore as loadBookmarkStore,
  moveFavorite as moveFavoriteTo,
  nudgeBookmark as nudgeBookmarkEntry,
  removeBookmark as removeBookmarkEntry,
  removeFolder as removeBookmarkFolder,
  renameFolder as renameBookmarkFolder,
  safeUrl as bookmarkSafeUrl,
  saveStore as saveBookmarkStore,
  toggleFavorite as toggleBookmarkFavorite,
  updateBookmark as updateBookmarkEntry,
} from "./bookmarks-store.js";

const STORE = "hog-wallet-v1";
const LAST_URL = "hog-last-url";
const HISTORY_KEY = "hog-history";
const WALLET_OPEN_KEY = "hog-wallet-open";
const TABS_OPEN_KEY = "hog-tabs-open";
const NAME_KEY = "hog-account-name";
const LOCK_KEY = "hog-autolock";
const DISPLAY_KEY = "hog-display";
const SITES_KEY = "hog-dapp-sites";
const CHAIN_KEY = "hog-wallet-chain";
const CHAIN_VIEW = {
  defi: { symbol: "WART", label: "Warthog DeFi", chainKey: "" },
  mainnet: { symbol: "WART", label: "Warthog mainnet", chainKey: "" },
  ethereum: { symbol: "ETH", label: "Ethereum", chainKey: "0x1" },
  bitcoin: { symbol: "BTC", label: "Bitcoin", chainKey: "" },
  hemi: { symbol: "ETH", label: "Hemi", chainKey: "0xa867" },
  solana: { symbol: "SOL", label: "Solana", chainKey: "" },
};
const EVM_RPC = {
  ethereum: { chainId: 1n, url: "https://ethereum.publicnode.com" },
  hemi: { chainId: 43111n, url: "https://rpc.hemi.network/rpc" },
};
const SOL_RPC = "https://solana.publicnode.com";
const HOLDINGS = {
  ethereum: [
    { symbol: "ETH", name: "Ether", mark: "eth", decimals: 18, native: true },
    { symbol: "USDC", name: "USD Coin", letter: "U", color: "#2775CA", decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "USDT", name: "Tether", letter: "T", color: "#26A17B", decimals: 6, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "WBTC", name: "Wrapped Bitcoin", letter: "W", color: "#F09242", decimals: 8, address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  ],
  hemi: [
    { symbol: "ETH", name: "Hemi ETH", mark: "eth", decimals: 18, native: true },
    { symbol: "hemiBTC", name: "hemiBTC", mark: "btc", decimals: 8, address: "0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28" },
    { symbol: "HEMI", name: "HEMI", mark: "hemi", decimals: 18, address: "0x99e3dE3817F6081B2568208337ef83295b7f591D" },
    { symbol: "VUSD", name: "VUSD", letter: "V", color: "#596AEC", decimals: 18, address: "0x7A06C4AeF988e7925575C50261297a946aD204A8" },
    { symbol: "USDT", name: "Tether", letter: "T", color: "#26A17B", decimals: 6, address: "0xbB0D083fb1be0A9f6157ec484b6C79E0A4e31C2e" },
  ],
  solana: [
    { symbol: "SOL", name: "Solana", mark: "sol", decimals: 9, native: true },
    { symbol: "USDC", name: "USD Coin", letter: "U", color: "#2775CA", decimals: 6, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    { symbol: "USDT", name: "Tether", letter: "T", color: "#26A17B", decimals: 6, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
    { symbol: "JUP", name: "Jupiter", letter: "J", color: "#141726", decimals: 6, mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  ],
  bitcoin: [
    { symbol: "BTC", name: "Bitcoin", mark: "btc", decimals: 8, native: true },
  ],
};
const HISTORY_CAP = 40;
const E8 = 100_000_000n;
const NETWORKS = {
  defi: {
    label: "DeFi testnet",
    base: "https://warthog-defitestnet.duckdns.org",
  },
  mainnet: {
    label: "Mainnet",
    base: "https://warthognode.duckdns.org",
  },
};
const NODE_ORIGIN = "https://browser-node.netlify.app";
const DDG_HOME = "https://duckduckgo.com/";
const WALLET_PAGES = [
  "home", "send", "receive", "trade", "swap", "liquidity", "mint",
  "safetrade", "aave", "activity", "settings", "account", "accounts", "key",
  "phrase", "autolock", "display", "nodes", "ledger", "sites",
];
const TRADE_PAGES = new Set(["trade", "swap", "liquidity", "mint", "safetrade", "aave"]);
const SETTINGS_PAGES = new Set(["settings", "account", "accounts", "key", "phrase", "autolock", "display", "nodes", "ledger", "sites"]);

const $ = (id) => document.getElementById(id);

const addressInput = $("address");
const frame = $("frame");
const nodeFrame = $("node-frame");
const home = $("home");
const status = $("status");
const statusText = $("status-text");
const wallet = $("wallet");
const networkSelect = $("network");

const tabs = [];
const loads = new Map();
const navGen = new Map();
let activeId = 0;
let tabSeq = 1;
let viewSeq = 0;
let session = null;
let balance = null;
let refreshGen = 0;
let wartUsd = 0;
let wartUsdAt = 0;
let reviewing = false;
let pendingAccount = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64ToBytes(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sealKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(privateKey)),
  );
  return { v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

async function openKey(record, password) {
  const key = await deriveKey(password, b64ToBytes(record.salt));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(record.iv) },
    key,
    b64ToBytes(record.ct),
  );
  return decoder.decode(plain);
}

function savedRecord() {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function parseWartToE8(input) {
  const text = String(input ?? "").trim();
  if (!/^\d+(\.\d{0,8})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const padded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * E8 + BigInt(padded);
}

function formatE8(value) {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / E8;
  let frac = (abs % E8).toString().padStart(8, "0");
  const places = localStorage.getItem(DISPLAY_KEY) || "full";
  if (places !== "full") frac = frac.slice(0, Number(places));
  frac = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

function e8Of(value) {
  if (value == null) return 0n;
  if (typeof value === "object") {
    const raw = value.E8 ?? value.u64 ?? value.amount;
    if (raw == null) return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function breakdownOf(data) {
  if (typeof data?.balance === "string" || typeof data?.balance === "number") {
    const total = parseWartToE8(String(data.balance)) ?? 0n;
    return { total, locked: 0n, mempool: 0n, available: total };
  }
  const container =
    data?.wart ||
    (data?.balance && typeof data.balance === "object" ? data.balance : data) ||
    {};
  const total = e8Of(container.total ?? container);
  const locked = e8Of(container.locked);
  const mempool = e8Of(container.mempool);
  const spent = locked + mempool;
  const available = total > spent ? total - spent : 0n;
  return { total, locked, mempool, available };
}

function selectedChain() {
  return CHAIN_VIEW[networkSelect.value] ? networkSelect.value : "mainnet";
}

function isWartChain(chain = selectedChain()) {
  return chain === "defi" || chain === "mainnet";
}

function savedWartNet() {
  return localStorage.getItem("hog-wart-net") === "defi" ? "defi" : "mainnet";
}

function networkId() {
  const chain = selectedChain();
  if (isWartChain(chain)) return chain;
  return savedWartNet();
}

function activeAddress() {
  if (!session) return "";
  const chain = selectedChain();
  if (chain === "ethereum" || chain === "hemi") return session.evmAddress || "";
  if (chain === "bitcoin") return session.btcAddress || "";
  if (chain === "solana") return session.solAddress || "";
  return session.address || "";
}

function network() {
  return NETWORKS[networkId()];
}

async function nodeGet(path) {
  const url = `/api/node?base=${encodeURIComponent(network().base)}&path=${encodeURIComponent(path)}`;
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok || json.code !== 0) {
    throw new Error(json.error || "The Warthog node did not answer");
  }
  return json.data;
}

async function nodePost(path, body) {
  const response = await fetch("/api/node", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base: network().base, path, body }),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 0) {
    throw new Error(json.error || "The node rejected the transaction");
  }
  return json.data;
}

function setSetupError(message) {
  $("setup-error").textContent = message || "";
}

function setSendError(message) {
  $("send-error").textContent = message || "";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function activeTab() {
  return tabs.find((tab) => tab.id === activeId) || null;
}

function bump(tabId) {
  const next = (navGen.get(tabId) || 0) + 1;
  navGen.set(tabId, next);
  return next;
}

function abortLoad(tabId) {
  const controller = loads.get(tabId);
  if (!controller) return;
  loads.delete(tabId);
  controller.abort();
}

function isNodeUrl(value) {
  try {
    return new URL(value).origin === NODE_ORIGIN;
  } catch {
    return false;
  }
}

function desktopOn() {
  return Boolean(window.__hogDesktop);
}

function isNativeTab(tab) {
  return desktopOn() && Boolean(tab) && tab.kind !== "node" && tab.kind !== "shell";
}

function resolveAddress(text) {
  const raw = String(text || "").trim();
  if (!raw) return { error: "Enter a URL or a search" };
  if (/^hog-post:/i.test(raw)) return { error: "This browser opens links. It does not submit forms." };
  const target = looksLikeUrl(raw) ? raw : `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "That address is not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http and https pages can be opened" };
  }
  if (url.username || url.password) return { error: "URLs with a username or password are blocked" };
  const host = url.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return { error: "That host is blocked" };
  }
  return { href: url.href };
}

function parkNode() {
  nodeFrame.classList.remove("is-front");
  nodeFrame.inert = true;
}

function reportShareDrop() {
  const zone = $("share-drop");
  const settings = $("browser-settings");
  if (!zone || !settings || settings.hidden) {
    desktopCommand("drop-box:0,0,0,0");
    return;
  }
  const rect = zone.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 36 || rect.bottom < 40) {
    desktopCommand("drop-box:0,0,0,0");
    return;
  }
  desktopCommand(`drop-box:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
}

function hideBrowserSettings() {
  hideBookmarksView();
  const panel = $("browser-settings");
  const menu = $("settings-menu");
  if (menu) menu.hidden = true;
  const button = $("settings-btn");
  if (button) {
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("is-open");
  }
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  reportShareDrop();
}

function hideShell() {
  const panel = $("shell-view");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
}

function pageSurfaceClear() {
  const shell = $("shell-view");
  const marks = $("bookmarks-view");
  return home.hidden && $("browser-settings").hidden && (!shell || shell.hidden) && (!marks || marks.hidden);
}

function showBrowserSettings() {
  hideShell();
  hideBookmarksView();
  hideBookmarkRow();
  hideSuggestions();
  closePopovers();
  viewSeq += 1;
  home.hidden = true;
  status.hidden = true;
  frame.hidden = true;
  view.classList.remove("is-page");
  frame.removeAttribute("srcdoc");
  if (frame.getAttribute("src")) frame.src = "about:blank";
  parkNode();
  $("browser-settings").hidden = false;
  $("settings-btn").classList.add("is-open");
  reportView(false);
  desktopCommand("containers:list");
  requestAnimationFrame(reportShareDrop);
}

const SETTINGS_SECTIONS = ["general", "files", "containers", "networks", "tailscale", "mining"];

function normalizeSettingsPage(page) {
  if (page === "docker") return "containers";
  return SETTINGS_SECTIONS.includes(page) ? page : "containers";
}

function showSettingsPage(page) {
  const next = normalizeSettingsPage(page);
  const wasHidden = $("browser-settings").hidden;
  if (wasHidden) showBrowserSettings();
  for (const name of SETTINGS_SECTIONS) {
    const pane = $(`settings-${name}`);
    if (pane) pane.hidden = name !== next;
  }
  $("browser-settings").scrollTop = 0;
  const menu = $("settings-menu");
  if (menu) menu.hidden = true;
  $("settings-btn").setAttribute("aria-expanded", "false");
  $("settings-btn").classList.add("is-open");
  document.querySelectorAll("#settings-menu [data-settings], #settings-nav [data-settings]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.settings === next ? "page" : "false");
  });
  if (!wasHidden) {
    desktopCommand("containers:list");
    requestAnimationFrame(reportShareDrop);
  }
  if (next === "networks") requestNetworks(networkRuntime);
  if (next === "files" || next === "tailscale") {
    desktopCommand("containers:share-status");
  }
  if (next === "mining") refreshMining();
  if (next === "general") {
    desktopCommand("containers:browser-default");
    desktopCommand("containers:update-status");
  }
}

function showHome() {
  viewSeq += 1;
  hideBrowserSettings();
  hideShell();
  home.hidden = false;
  frame.hidden = true;
  status.hidden = true;
  view.classList.remove("is-page");
  frame.removeAttribute("srcdoc");
  if (frame.getAttribute("src")) frame.src = "about:blank";
  parkNode();
  reportView(false);
}

function showStatus(message) {
  viewSeq += 1;
  hideBrowserSettings();
  hideShell();
  home.hidden = true;
  frame.hidden = true;
  status.hidden = false;
  view.classList.remove("is-page");
  statusText.textContent = message;
  frame.removeAttribute("srcdoc");
  parkNode();
  reportView(false);
}

function showNative() {
  viewSeq += 1;
  hideBrowserSettings();
  hideShell();
  home.hidden = true;
  status.hidden = true;
  frame.hidden = true;
  view.classList.add("is-page");
  frame.removeAttribute("srcdoc");
  if (frame.getAttribute("src")) frame.src = "about:blank";
  parkNode();
  reportView(true);
}

function showNode(frameUrl) {
  viewSeq += 1;
  hideBrowserSettings();
  hideShell();
  home.hidden = true;
  status.hidden = true;
  frame.hidden = true;
  view.classList.remove("is-page");
  nodeFrame.classList.add("is-front");
  nodeFrame.inert = false;
  const next = String(frameUrl || "");
  if (next && nodeFrame.getAttribute("src") !== next) nodeFrame.src = next;
  reportView(false);
}

function mountFrame(frameUrl) {
  const seq = ++viewSeq;
  hideShell();
  parkNode();
  frame.removeAttribute("srcdoc");
  if (!frameUrl) {
    frame.src = "about:blank";
    showStatus("Could not show that page");
    return;
  }
  frame.hidden = false;
  hideBrowserSettings();
  home.hidden = true;
  status.hidden = true;
  const next = String(frameUrl);
  const apply = () => {
    if (seq !== viewSeq) return;
    frame.src = next;
  };
  if (frame.getAttribute("src") === next) {
    frame.addEventListener("load", function once() {
      frame.removeEventListener("load", once);
      apply();
    });
    frame.src = "about:blank";
    return;
  }
  apply();
}

function updateNav() {
  const tab = activeTab();
  if (isNativeTab(tab) && tab.url) {
    $("back").disabled = !tab.canBack;
    $("forward").disabled = !tab.canForward;
  } else {
    $("back").disabled = !tab || tab.index <= 0;
    $("forward").disabled = !tab || tab.index < 0 || tab.index >= tab.stack.length - 1;
  }
  const loading = Boolean(tab && (loads.has(tab.id) || tab.loading));
  $("reload").hidden = loading;
  $("stop").hidden = !loading;
}

function renderShield(tab) {
  const title = $("shield-title");
  const copy = $("shield-copy");
  if (!title || !copy) return;
  if (tab?.kind === "shell") {
    title.textContent = "SSH";
    copy.textContent = "This tab is an SSH session into a container Hog started. It is not a web page, and the page cannot see it or the wallet.";
    return;
  }
  if (tab?.kind === "node") {
    title.textContent = tab.synced ? "Node synced" : "Node";
    copy.textContent = "The Warthog node keeps running while you use other tabs. It cannot read the wallet key. The Node button turns green when the node says it is synced.";
    return;
  }
  if (!tab?.url) {
    title.textContent = "New tab";
    copy.textContent = "Open a page here, or use Iso for a tab with its own cookies and storage.";
    return;
  }
  const sandbox = window.__hogPageSandbox
    ? " The page runs in a sandboxed web process, separate from the wallet."
    : "";
  if (tab.isolated) {
    title.textContent = "Isolated";
    copy.textContent = `This tab has its own cookies and storage. It cannot read the wallet or your other tabs.${sandbox}`;
    return;
  }
  title.textContent = "Direct";
  copy.textContent = `This page loads at its real address. Cookies are shared with your other direct tabs. It cannot read the wallet.${sandbox}`;
}

function renderTabs() {
  const strip = $("tabstrip");
  strip.replaceChildren();
  for (const tab of tabs) {
    const wrap = document.createElement("div");
    wrap.className = `tab-wrap${tab.id === activeId ? " is-active" : ""}${tab.isolated ? " is-isolated" : ""}${tab.synced ? " is-synced" : ""}`;
    wrap.setAttribute("role", "tab");
    wrap.setAttribute("aria-selected", tab.id === activeId ? "true" : "false");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.textContent = tab.title || "New tab";
    button.title = tab.tip || tab.url || "New tab";
    button.addEventListener("click", () => selectTab(tab.id));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-x";
    close.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    wrap.append(button, close);
    strip.append(wrap);
  }
}

function renderTab() {
  const tab = activeTab();
  if (!tab) return;
  addressInput.value = tab.url || "";
  document.title = tab.url && tab.title ? `${tab.title} — Hog` : "Hog";
  const surface = tab.kind === "node" ? nodeFrame : frame;
  surface.style.zoom = String(tab.zoom || 1);
  $("zoom-btn").textContent = `${Math.round((tab.zoom || 1) * 100)}%`;
  updateStar();
  updateNav();
  renderShield(tab);
  if (tab.kind === "shell") {
    showShell(tab);
    return;
  }
  if (isNativeTab(tab)) {
    if (tab.status) {
      showStatus(tab.status);
      return;
    }
    if (tab.url) {
      showNative();
      return;
    }
    showHome();
    return;
  }
  if (tab.kind === "node") {
    if (tab.status) {
      showStatus(tab.status);
      return;
    }
    if (tab.frameUrl) {
      showNode(tab.frameUrl);
      return;
    }
    showHome();
    return;
  }
  if (tab.status) {
    showStatus(tab.status);
    return;
  }
  if (tab.frameUrl) {
    mountFrame(tab.frameUrl);
    return;
  }
  showHome();
}

function selectTab(id) {
  if (id === activeId) return;
  activeId = id;
  renderTabs();
  renderTab();
}

function createTab({ activate = true, kind = "", isolated = false, title = "" } = {}) {
  const tab = {
    id: tabSeq++,
    kind,
    isolated: Boolean(isolated) && kind !== "node" && kind !== "shell",
    title: title || (kind === "node" ? "Node" : isolated ? "Isolated" : "New tab"),
    url: "",
    frameUrl: "",
    status: "",
    stack: [],
    index: -1,
    zoom: 1,
    canBack: false,
    canForward: false,
    loading: false,
    synced: false,
  };
  tabs.push(tab);
  if (activate) activeId = tab.id;
  renderTabs();
  if (activate) renderTab();
  return tab;
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  if (tabs[index].kind === "node") {
    parkNode();
    if (nodeFrame.getAttribute("src")) nodeFrame.src = "about:blank";
    setNodeSynced(false);
  } else if (tabs[index].kind === "shell") {
    closeShell(tabs[index].id);
  } else if (isNativeTab(tabs[index])) {
    desktopCommand(`drop:${tabs[index].id}`);
  }
  abortLoad(id);
  bump(id);
  const wasActive = id === activeId;
  tabs.splice(index, 1);
  if (!tabs.length) {
    createTab();
    return;
  }
  if (wasActive) activeId = tabs[Math.min(index, tabs.length - 1)].id;
  renderTabs();
  if (wasActive) renderTab();
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = (index + step + tabs.length) % tabs.length;
  selectTab(tabs[next].id);
}

function applyEntry(entry) {
  const tab = activeTab();
  if (!tab || !entry) return;
  tab.url = entry.url || "";
  tab.title = entry.title || (entry.url ? hostOf(entry.url) : "New tab");
  tab.frameUrl = entry.frameUrl || "";
  tab.status = "";
  tab.method = entry.method || "";
  tab.fields = entry.fields || null;
  renderTabs();
  renderTab();
}

function goBack() {
  const tab = activeTab();
  if (!tab) return;
  if (isNativeTab(tab)) {
    if (!tab.canBack) return;
    desktopCommand(`back:${tab.id}`);
    return;
  }
  if (tab.index <= 0) return;
  abortLoad(tab.id);
  bump(tab.id);
  tab.index -= 1;
  applyEntry(tab.stack[tab.index]);
}

function goForward() {
  const tab = activeTab();
  if (!tab) return;
  if (isNativeTab(tab)) {
    if (!tab.canForward) return;
    desktopCommand(`fwd:${tab.id}`);
    return;
  }
  if (tab.index >= tab.stack.length - 1) return;
  abortLoad(tab.id);
  bump(tab.id);
  tab.index += 1;
  applyEntry(tab.stack[tab.index]);
}

function goHome() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.kind === "node" || tab.kind === "shell") {
    createTab();
    return;
  }
  abortLoad(tab.id);
  bump(tab.id);
  const current = tab.stack[tab.index];
  tab.url = "";
  tab.title = "New tab";
  tab.frameUrl = "";
  tab.status = "";
  if (!current || current.url) {
    tab.stack.splice(tab.index + 1);
    tab.stack.push({ url: "", title: "New tab", frameUrl: "" });
    tab.index = tab.stack.length - 1;
  }
  renderTabs();
  renderTab();
}

function setZoom(next) {
  const tab = activeTab();
  if (!tab) return;
  tab.zoom = Math.min(2, Math.max(0.5, Math.round(next * 20) / 20));
  if (isNativeTab(tab)) desktopCommand(`zoom:${tab.id}:${tab.zoom}`);
  else {
    const surface = tab.kind === "node" ? nodeFrame : frame;
    surface.style.zoom = String(tab.zoom);
  }
  $("zoom-btn").textContent = `${Math.round(tab.zoom * 100)}%`;
}

function readList(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

// ---------- Bookmarks and favorites (one store, see bookmarks-store.js) ----------

let bmStore = null;
const bmState = { view: "all", query: "", sort: "manual", editing: null, dragId: "", favDragId: "" };

function bmLoad() {
  if (bmStore) return bmStore;
  const { store, backup } = loadBookmarkStore(localStorage);
  bmStore = store;
  // First run after the upgrade: also keep a copy of the old list on disk.
  if (backup) desktopCommand(`bookmarks:backup:${backup}`);
  return bmStore;
}

function bmCommit(next) {
  bmStore = next;
  saveBookmarkStore(localStorage, next);
  renderBookmarks();
}

function bookmarks() {
  return bmLoad().items;
}

function bmFaviconUrl(url) {
  return `/api/favicon?url=${encodeURIComponent(url)}`;
}

// Letter badges use the theme accents only: Warthog gold, brand blue (lifted for dark), brand gray.
const BM_TILE_COLORS = ["#fdb913", "#7fb2e5", "#e9e9e9"];

function bmLetterTile(item, className) {
  const host = bmHost(item.url);
  const letter = (item.title || host || "?").replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "•";
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const tile = document.createElement("span");
  tile.className = `${className} bm-letter`;
  tile.textContent = letter;
  tile.style.setProperty("--tile", BM_TILE_COLORS[hash % BM_TILE_COLORS.length]);
  tile.setAttribute("aria-hidden", "true");
  return tile;
}

function bmIcon(item, className = "bm-icon") {
  const wrap = document.createElement("span");
  wrap.className = `${className}-wrap`;
  const tile = bmLetterTile(item, className);
  wrap.append(tile);
  if (!/^https?:/i.test(item.url)) return wrap;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.decoding = "async";
  img.width = 32;
  img.height = 32;
  img.hidden = true;
  img.addEventListener("load", () => {
    if (img.naturalWidth > 0) {
      img.hidden = false;
      tile.hidden = true;
    }
  });
  img.addEventListener("error", () => img.remove());
  img.src = bmFaviconUrl(item.url);
  wrap.append(img);
  return wrap;
}

function bmHost(url) {
  return bookmarkHost(url);
}

// Chrome strip: favorites as compact chips.
function renderFavoriteStrip() {
  const bar = $("bookmarks");
  if (!bar) return;
  bar.replaceChildren();
  for (const item of bookmarkFavorites(bmLoad())) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = `${item.title}\n${item.url}`;
    button.append(bmIcon(item, "chip-icon"));
    const label = document.createElement("span");
    label.textContent = item.title || bmHost(item.url);
    button.append(label);
    button.addEventListener("click", () => openUrl(item.url));
    bar.append(button);
  }
}

// Home: favorites grid with reorder, edit, and remove.
function renderFavGrid() {
  const grid = $("fav-grid");
  if (!grid) return;
  grid.replaceChildren();
  const favs = bookmarkFavorites(bmLoad());
  favs.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "fav-tile";
    li.draggable = true;
    li.dataset.id = item.id;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "fav-open";
    open.title = `${item.title}\n${item.url}`;
    open.append(bmIcon(item, "fav-icon"));
    const name = document.createElement("span");
    name.className = "fav-name";
    name.textContent = item.title || bmHost(item.url);
    const host = document.createElement("small");
    host.className = "fav-host";
    host.textContent = bmHost(item.url);
    open.append(name, host);
    open.addEventListener("click", () => openUrl(item.url));
    const tools = document.createElement("div");
    tools.className = "fav-tools";
    const mk = (label, text, handler, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fav-tool";
      button.textContent = text;
      button.setAttribute("aria-label", `${label} ${item.title}`);
      button.title = label;
      button.disabled = disabled;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        handler();
      });
      return button;
    };
    tools.append(
      mk("Move left", "‹", () => bmCommit(moveFavoriteTo(bmLoad(), item.id, index - 1)), index === 0),
      mk("Move right", "›", () => bmCommit(moveFavoriteTo(bmLoad(), item.id, index + 1)), index === favs.length - 1),
      mk("Edit", "✎", () => showBookmarksView({ edit: item.id })),
      mk("Remove from Favorites", "×", () => {
        bmCommit(updateBookmarkEntry(bmLoad(), item.id, { favorite: false }));
      }),
    );
    li.append(open, tools);
    li.addEventListener("dragstart", (event) => {
      bmState.favDragId = item.id;
      li.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.url);
    });
    li.addEventListener("dragend", () => {
      bmState.favDragId = "";
      li.classList.remove("is-dragging");
      grid.querySelectorAll(".is-drop").forEach((el) => el.classList.remove("is-drop"));
    });
    li.addEventListener("dragover", (event) => {
      if (!bmState.favDragId || bmState.favDragId === item.id) return;
      event.preventDefault();
      li.classList.add("is-drop");
    });
    li.addEventListener("dragleave", () => li.classList.remove("is-drop"));
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      const id = bmState.favDragId;
      bmState.favDragId = "";
      if (id && id !== item.id) bmCommit(moveFavoriteTo(bmLoad(), id, index));
    });
    grid.append(li);
  });
  const add = document.createElement("li");
  add.className = "fav-tile fav-add";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "fav-open";
  addButton.innerHTML = '<span class="fav-icon-wrap"><span class="fav-icon bm-letter fav-plus" aria-hidden="true">+</span></span><span class="fav-name">Add favorite</span><small class="fav-host">or pick from Bookmarks</small>';
  addButton.addEventListener("click", () => showBookmarksView({ add: true, favorite: true }));
  add.append(addButton);
  grid.append(add);
  $("favs-hint").hidden = favs.length < 2;
}

function updateStar() {
  const tab = activeTab();
  const url = tab?.url || "";
  const saved = url ? findBookmarkByUrl(bmLoad(), url) : null;
  const on = Boolean(saved);
  const star = $("star");
  star.disabled = !url || !bookmarkSafeUrl(url);
  star.classList.toggle("star-on", on);
  star.textContent = on ? "★" : "☆";
  star.setAttribute("aria-pressed", on ? "true" : "false");
  const row = $("bookmark-row");
  if (row && !row.hidden && (!saved || saved.id !== row.dataset.id)) hideBookmarkRow();
}

function fillFolderSelect(select, selected) {
  select.replaceChildren();
  for (const folder of bookmarkFolderTree(bmLoad())) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = `${"\u2003".repeat(folder.depth)}${folder.name}`;
    if (folder.id === selected) option.selected = true;
    select.append(option);
  }
}

// Ctrl+D or the star: save the page, then offer favorite, folder, edit, remove in a row under the toolbar.
function toggleBookmark() {
  const tab = activeTab();
  if (!tab?.url || !bookmarkSafeUrl(tab.url)) return;
  let item = findBookmarkByUrl(bmLoad(), tab.url);
  if (!item) {
    const result = addBookmarkEntry(bmLoad(), { title: tab.title || bmHost(tab.url), url: tab.url });
    bmCommit(result.store);
    item = result.item;
    showBookmarkRow(item, "Bookmarked");
  } else {
    showBookmarkRow(item, "Already bookmarked");
  }
  updateStar();
}

function showBookmarkRow(item, heading) {
  const row = $("bookmark-row");
  row.dataset.id = item.id;
  $("bookmark-row-title").textContent = heading;
  $("bookmark-row-name").textContent = item.title;
  $("bookmark-row-name").title = item.url;
  fillFolderSelect($("bookmark-row-folder"), item.folder);
  const fav = $("bookmark-row-fav");
  fav.setAttribute("aria-pressed", item.favorite ? "true" : "false");
  fav.textContent = item.favorite ? "★ Favorite" : "☆ Favorite";
  row.hidden = false;
  syncPageView();
  try { $("bookmark-row-done").focus({ preventScroll: true }); } catch { /* ignore */ }
}

function hideBookmarkRow() {
  const row = $("bookmark-row");
  if (!row || row.hidden) return;
  row.hidden = true;
  syncPageView();
}

function bookmarkRowItem() {
  const id = $("bookmark-row").dataset.id;
  return bmLoad().items.find((item) => item.id === id) || null;
}

// ---------- hog://bookmarks ----------

function bookmarksViewOpen() {
  const panel = $("bookmarks-view");
  return Boolean(panel && !panel.hidden);
}

function hideBookmarksView() {
  const panel = $("bookmarks-view");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $("bookmarks-btn")?.classList.remove("is-open");
  if (addressInput.value === "hog://bookmarks") addressInput.value = activeTab()?.url || "";
  const more = $("bm-more-menu");
  if (more) more.hidden = true;
}

function showBookmarksView({ view, edit, add, favorite } = {}) {
  hideShell();
  hideSuggestions();
  closePopovers();
  hideBrowserSettings();
  hideBookmarkRow();
  viewSeq += 1;
  home.hidden = true;
  status.hidden = true;
  frame.hidden = true;
  $("view").classList.remove("is-page");
  frame.removeAttribute("srcdoc");
  if (frame.getAttribute("src")) frame.src = "about:blank";
  parkNode();
  $("bookmarks-view").hidden = false;
  $("bookmarks-btn")?.classList.add("is-open");
  addressInput.value = "hog://bookmarks";
  if (view) bmState.view = view;
  if (!bmViewValid(bmState.view)) bmState.view = "all";
  bmState.editing = null;
  $("bm-editor").hidden = true;
  $("bm-rename-form").hidden = true;
  renderBookmarksPage();
  if (edit) openBookmarkEditor(edit);
  else if (add) openBookmarkEditor(null, { favorite: Boolean(favorite) });
  else {
    $("bookmarks-view").scrollTop = 0;
    try { $("bm-search").focus({ preventScroll: true }); } catch { $("bm-search").focus(); }
  }
  reportView(false);
  // Earlier syncPageView calls queue a frame that may still say "show the page".
  // Run after them so the page view stays hidden behind hog://bookmarks.
  requestAnimationFrame(() => {
    if (bookmarksViewOpen()) reportView(false);
    requestAnimationFrame(() => { if (bookmarksViewOpen()) reportView(false); });
  });
}

function bmViewValid(view) {
  return view === "all" || view === "favorites" || bmLoad().folders.some((folder) => folder.id === view);
}

function bmViewTitle(view) {
  if (view === "all") return "All bookmarks";
  if (view === "favorites") return "Favorites";
  return bmLoad().folders.find((folder) => folder.id === view)?.name || "Bookmarks";
}

function renderBookmarksPage() {
  if (!bookmarksViewOpen()) return;
  const store = bmLoad();
  if (!bmViewValid(bmState.view)) bmState.view = "all";
  const view = bmState.view;
  const isFolder = view !== "all" && view !== "favorites";
  $("bm-count-all").textContent = String(store.items.length);
  $("bm-count-fav").textContent = String(bookmarkFavorites(store).length);
  $("bm-views").querySelectorAll("[data-bm-view]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.bmView === view ? "page" : "false");
  });
  const folderList = $("bm-folders");
  folderList.replaceChildren();
  for (const folder of bookmarkFolderTree(store)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.bmView = folder.id;
    button.style.setProperty("--depth", String(folder.depth));
    button.setAttribute("aria-current", folder.id === view ? "page" : "false");
    const glyph = document.createElement("span");
    glyph.className = "bm-glyph";
    glyph.textContent = folder.id === BOOKMARK_ROOT ? "◆" : "▸";
    const name = document.createElement("span");
    name.className = "bm-name";
    name.textContent = folder.name;
    const count = document.createElement("small");
    count.textContent = String(store.items.filter((item) => item.folder === folder.id).length);
    button.append(glyph, name, count);
    // Drop a bookmark row on a folder to move it there.
    button.addEventListener("dragover", (event) => {
      if (!bmState.dragId) return;
      event.preventDefault();
      button.classList.add("is-drop");
    });
    button.addEventListener("dragleave", () => button.classList.remove("is-drop"));
    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("is-drop");
      const id = bmState.dragId;
      bmState.dragId = "";
      if (!id) return;
      bmCommit(updateBookmarkEntry(bmLoad(), id, { folder: folder.id }));
      bmStatus(`Moved to ${folder.name}.`);
    });
    folderList.append(button);
  }
  $("bm-title").textContent = bmViewTitle(view);
  $("bm-path").textContent = isFolder && view !== BOOKMARK_ROOT ? bookmarkFolderPath(store, view) : "";
  document.querySelectorAll("#bm-more-menu .bm-folder-only").forEach((li) => {
    li.hidden = !isFolder || view === BOOKMARK_ROOT;
  });
  const sortSelect = $("bm-sort");
  if (sortSelect.value !== bmState.sort) sortSelect.value = bmState.sort;
  const items = listBookmarkEntries(store, {
    view,
    query: bmState.query,
    sort: bmState.sort,
    deep: Boolean(bmState.query) && isFolder,
  });
  const manual = bmState.sort === "manual" && !bmState.query;
  const list = $("bm-list");
  list.replaceChildren();
  items.forEach((item, index) => list.append(bookmarkRow(item, { index, total: items.length, manual, view })));
  const empty = $("bm-empty");
  if (items.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    empty.textContent = bmState.query
      ? "Nothing matches that filter."
      : view === "favorites"
        ? "No favorites yet. Star a bookmark (☆) to pin it to the new tab page and the toolbar."
        : "No bookmarks here yet. Press Ctrl+D on any page, use + Add bookmark, or import an HTML file from the ⋯ menu.";
  }
}

function bookmarkRow(item, { index, total, manual, view }) {
  const store = bmLoad();
  const li = document.createElement("li");
  li.className = `bm-row${item.favorite ? " is-fav" : ""}`;
  li.dataset.id = item.id;
  li.draggable = true;
  li.addEventListener("dragstart", (event) => {
    bmState.dragId = item.id;
    li.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.url);
  });
  li.addEventListener("dragend", () => {
    bmState.dragId = "";
    li.classList.remove("is-dragging");
  });
  const open = document.createElement("button");
  open.type = "button";
  open.className = "bm-open";
  open.title = item.url;
  open.append(bmIcon(item, "bm-icon"));
  const text = document.createElement("span");
  text.className = "bm-text";
  const title = document.createElement("span");
  title.className = "bm-row-title";
  title.textContent = item.title;
  const url = document.createElement("small");
  url.className = "bm-row-url";
  url.textContent = item.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  text.append(title, url);
  open.append(text);
  open.addEventListener("click", () => openUrl(item.url));
  const meta = document.createElement("span");
  meta.className = "bm-row-meta";
  if (view === "all" || view === "favorites" || bmState.query) {
    const chip = document.createElement("span");
    chip.className = "bm-chip";
    chip.textContent = store.folders.find((folder) => folder.id === item.folder)?.name || "Bookmarks";
    meta.append(chip);
  }
  const tools = document.createElement("span");
  tools.className = "bm-tools";
  const mk = (label, glyph, handler, { disabled = false, pressed } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bm-tool";
    button.textContent = glyph;
    button.title = label;
    button.setAttribute("aria-label", `${label}: ${item.title}`);
    if (pressed !== undefined) button.setAttribute("aria-pressed", pressed ? "true" : "false");
    button.disabled = disabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  };
  tools.append(mk(item.favorite ? "Remove from Favorites" : "Add to Favorites", item.favorite ? "★" : "☆", () => {
    bmCommit(toggleBookmarkFavorite(bmLoad(), item.id));
  }, { pressed: item.favorite }));
  if (manual && view === "favorites") {
    tools.append(
      mk("Move up", "↑", () => bmCommit(moveFavoriteTo(bmLoad(), item.id, index - 1)), { disabled: index === 0 }),
      mk("Move down", "↓", () => bmCommit(moveFavoriteTo(bmLoad(), item.id, index + 1)), { disabled: index === total - 1 }),
    );
  } else if (manual && view !== "all") {
    tools.append(
      mk("Move up", "↑", () => bmCommit(nudgeBookmarkEntry(bmLoad(), item.id, -1)), { disabled: index === 0 }),
      mk("Move down", "↓", () => bmCommit(nudgeBookmarkEntry(bmLoad(), item.id, 1)), { disabled: index === total - 1 }),
    );
  }
  const move = document.createElement("select");
  move.className = "bm-move";
  move.setAttribute("aria-label", `Move ${item.title} to folder`);
  move.title = "Move to folder";
  fillFolderSelect(move, item.folder);
  move.addEventListener("change", () => {
    const folder = bmLoad().folders.find((entry) => entry.id === move.value);
    bmCommit(updateBookmarkEntry(bmLoad(), item.id, { folder: move.value }));
    if (folder) bmStatus(`Moved “${item.title}” to ${folder.name}.`);
  });
  tools.append(
    move,
    mk("Edit", "✎", () => openBookmarkEditor(item.id)),
    mk("Delete", "🗑", () => deleteBookmarkWithUndo(item.id)),
  );
  meta.append(tools);
  li.append(open, meta);
  return li;
}

let bmUndo = null;
function deleteBookmarkWithUndo(id) {
  const before = bmLoad();
  const item = before.items.find((entry) => entry.id === id);
  if (!item) return;
  bmUndo = before;
  bmCommit(removeBookmarkEntry(before, id));
  bmStatus(`Deleted “${item.title}”.`, { undo: true });
}

let bmStatusTimer = 0;
function bmStatus(message, { undo = false, error = false } = {}) {
  const line = $("bm-status");
  if (!line) return;
  clearTimeout(bmStatusTimer);
  line.replaceChildren();
  line.classList.toggle("is-error", error);
  if (!message) return;
  line.append(document.createTextNode(message));
  if (undo && bmUndo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tiny bm-undo";
    button.textContent = "Undo";
    button.addEventListener("click", () => {
      if (!bmUndo) return;
      bmCommit(bmUndo);
      bmUndo = null;
      bmStatus("Restored.");
    });
    line.append(" ", button);
  }
  bmStatusTimer = setTimeout(() => {
    line.replaceChildren();
    if (undo) bmUndo = null;
  }, undo ? 12000 : 6000);
}

function openBookmarkEditor(id, { favorite = false } = {}) {
  const store = bmLoad();
  const item = id ? store.items.find((entry) => entry.id === id) : null;
  bmState.editing = item ? item.id : "new";
  $("bm-editor-title").textContent = item ? "Edit bookmark" : "Add bookmark";
  $("bm-edit-title").value = item ? item.title : "";
  const tab = activeTab();
  const suggest = !item && tab?.url && bookmarkSafeUrl(tab.url) && !findBookmarkByUrl(store, tab.url) ? tab.url : "";
  $("bm-edit-url").value = item ? item.url : suggest;
  if (!item && suggest) $("bm-edit-title").value = tab.title || "";
  const folder = item ? item.folder : (bmState.view !== "all" && bmState.view !== "favorites" ? bmState.view : BOOKMARK_ROOT);
  fillFolderSelect($("bm-edit-folder"), folder);
  $("bm-edit-fav").checked = item ? item.favorite : (favorite || bmState.view === "favorites");
  $("bm-edit-delete").hidden = !item;
  $("bm-edit-error").textContent = "";
  $("bm-editor").hidden = false;
  $("bookmarks-view").scrollTop = 0;
  const focus = item || !suggest ? $("bm-edit-url") : $("bm-edit-title");
  try { (item ? $("bm-edit-title") : focus).focus({ preventScroll: true }); } catch { focus.focus(); }
}

function closeBookmarkEditor() {
  bmState.editing = null;
  $("bm-editor").hidden = true;
}

function saveBookmarkEditor(event) {
  event.preventDefault();
  const fields = {
    title: $("bm-edit-title").value,
    url: $("bm-edit-url").value,
    folder: $("bm-edit-folder").value,
    favorite: $("bm-edit-fav").checked,
  };
  try {
    let store = bmLoad();
    if (bmState.editing && bmState.editing !== "new") {
      store = updateBookmarkEntry(store, bmState.editing, fields);
      bmCommit(store);
      bmStatus("Saved.");
    } else {
      const result = addBookmarkEntry(store, fields);
      store = result.store;
      if (!result.created) store = updateBookmarkEntry(store, result.item.id, { folder: fields.folder, favorite: fields.favorite });
      bmCommit(store);
      bmStatus(result.created ? `Added “${result.item.title}”.` : `That page was already saved, so it was updated.`);
    }
    closeBookmarkEditor();
    updateStar();
  } catch (error) {
    $("bm-edit-error").textContent = error instanceof Error ? error.message : "Could not save that bookmark";
  }
}

function bmImportText(text, name = "") {
  try {
    const label = `Imported ${new Date().toISOString().slice(0, 10)}`;
    const result = importBookmarkHtml(bmLoad(), text, { folderName: label });
    if (!result.added && !result.duplicates) {
      bmStatus("No bookmarks found in that file. Export an HTML bookmarks file from Brave (Bookmarks → Export bookmarks) and try again.", { error: true });
      return;
    }
    bmCommit(result.store);
    bmState.view = result.folder.id;
    renderBookmarksPage();
    const parts = [`Imported ${result.added} bookmark${result.added === 1 ? "" : "s"}${name ? ` from ${name}` : ""}`];
    if (result.duplicates) parts.push(`${result.duplicates} already saved`);
    if (result.skipped) parts.push(`${result.skipped} skipped (not http or https)`);
    bmStatus(`${parts.join(", ")}.`);
  } catch (error) {
    bmStatus(error instanceof Error ? error.message : "Could not read that file", { error: true });
  }
}

function bmExport() {
  const html = exportBookmarkHtml(bmLoad());
  if (desktopOn()) {
    desktopCommand(`bookmarks:export:${html}`);
    return;
  }
  const blob = new Blob([html], { type: "text/html" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `hog-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  bmStatus("Exported.");
}

function bmImport() {
  if (desktopOn()) {
    desktopCommand("bookmarks:import");
    return;
  }
  $("bm-file").click();
}

// Replies from hog's native file dialogs.
window.__hogBookmarks = (payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.kind === "import") {
    if (payload.ok && typeof payload.text === "string") bmImportText(payload.text, payload.name || "");
    else if (payload.error) bmStatus(payload.error, { error: true });
  } else if (payload.kind === "export") {
    if (payload.ok) bmStatus(`Exported to ${payload.path}.`);
    else if (payload.error) bmStatus(payload.error, { error: true });
  }
};

// Keys hog's window catches while a web page has focus.
window.__hogKey = (name) => {
  if (name === "bookmark") toggleBookmark();
  else if (name === "bookmarks") showBookmarksView();
};

function renderBookmarks() {
  renderFavoriteStrip();
  renderFavGrid();
  renderBookmarksPage();
  if (typeof activeTab === "function" && activeTab()) updateStar();
}

function bindBookmarks() {
  $("bookmarks-btn").addEventListener("click", () => {
    if (bookmarksViewOpen()) renderTab();
    else showBookmarksView();
  });
  $("favs-all").addEventListener("click", () => showBookmarksView({ view: "all" }));
  $("favs-add").addEventListener("click", () => showBookmarksView({ add: true, favorite: true }));
  $("bookmark-row-done").addEventListener("click", hideBookmarkRow);
  $("bookmark-row-fav").addEventListener("click", () => {
    const item = bookmarkRowItem();
    if (!item) return hideBookmarkRow();
    bmCommit(toggleBookmarkFavorite(bmLoad(), item.id));
    const next = bookmarkRowItem();
    if (next) showBookmarkRow(next, $("bookmark-row-title").textContent);
  });
  $("bookmark-row-folder").addEventListener("change", (event) => {
    const item = bookmarkRowItem();
    if (!item) return hideBookmarkRow();
    bmCommit(updateBookmarkEntry(bmLoad(), item.id, { folder: event.target.value }));
  });
  $("bookmark-row-edit").addEventListener("click", () => {
    const item = bookmarkRowItem();
    hideBookmarkRow();
    if (item) showBookmarksView({ edit: item.id });
  });
  $("bookmark-row-remove").addEventListener("click", () => {
    const item = bookmarkRowItem();
    if (item) bmCommit(removeBookmarkEntry(bmLoad(), item.id));
    hideBookmarkRow();
    updateStar();
  });
  $("bookmark-row").addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideBookmarkRow();
  });
  const sides = [$("bm-views"), $("bm-folders")];
  for (const side of sides) {
    side.addEventListener("click", (event) => {
      const button = event.target.closest("[data-bm-view]");
      if (!button) return;
      bmState.view = button.dataset.bmView;
      closeBookmarkEditor();
      $("bm-rename-form").hidden = true;
      renderBookmarksPage();
    });
  }
  $("bm-views").querySelector('[data-bm-view="favorites"]').addEventListener("dragover", (event) => {
    if (!bmState.dragId) return;
    event.preventDefault();
    event.currentTarget.classList.add("is-drop");
  });
  $("bm-views").querySelector('[data-bm-view="favorites"]').addEventListener("dragleave", (event) => event.currentTarget.classList.remove("is-drop"));
  $("bm-views").querySelector('[data-bm-view="favorites"]').addEventListener("drop", (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove("is-drop");
    const id = bmState.dragId;
    bmState.dragId = "";
    if (id) bmCommit(updateBookmarkEntry(bmLoad(), id, { favorite: true }));
  });
  $("bm-folder-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("bm-folder-name");
    try {
      const parent = bmState.view !== "all" && bmState.view !== "favorites" ? bmState.view : BOOKMARK_ROOT;
      const result = addBookmarkFolder(bmLoad(), input.value, parent);
      input.value = "";
      bmState.view = result.folder.id;
      bmCommit(result.store);
      bmStatus(`Made folder “${result.folder.name}”.`);
    } catch (error) {
      bmStatus(error instanceof Error ? error.message : "Could not make that folder", { error: true });
    }
  });
  $("bm-search").addEventListener("input", (event) => {
    bmState.query = event.target.value;
    renderBookmarksPage();
  });
  $("bm-search").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.target.value) {
      event.target.value = "";
      bmState.query = "";
      renderBookmarksPage();
    }
  });
  $("bm-sort").addEventListener("change", (event) => {
    bmState.sort = event.target.value;
    renderBookmarksPage();
  });
  $("bm-add").addEventListener("click", () => openBookmarkEditor(null));
  $("bm-editor").addEventListener("submit", saveBookmarkEditor);
  $("bm-edit-cancel").addEventListener("click", closeBookmarkEditor);
  $("bm-edit-delete").addEventListener("click", () => {
    const id = bmState.editing;
    closeBookmarkEditor();
    if (id && id !== "new") deleteBookmarkWithUndo(id);
  });
  $("bm-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBookmarkEditor();
  });
  $("bm-more").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("bm-more-menu");
    menu.hidden = !menu.hidden;
    $("bm-more").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  $("bm-more-menu").addEventListener("click", () => {
    $("bm-more-menu").hidden = true;
    $("bm-more").setAttribute("aria-expanded", "false");
  });
  $("bm-import").addEventListener("click", bmImport);
  $("bm-export").addEventListener("click", bmExport);
  $("bm-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 20_000_000) {
      bmStatus("That file is too large for a bookmarks file.", { error: true });
      return;
    }
    bmImportText(await file.text(), file.name);
  });
  $("bm-rename-folder").addEventListener("click", () => {
    const folder = bmLoad().folders.find((entry) => entry.id === bmState.view);
    if (!folder) return;
    $("bm-rename-input").value = folder.name;
    $("bm-rename-form").hidden = false;
    $("bm-rename-input").focus();
    $("bm-rename-input").select();
  });
  $("bm-rename-cancel").addEventListener("click", () => { $("bm-rename-form").hidden = true; });
  $("bm-rename-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      bmCommit(renameBookmarkFolder(bmLoad(), bmState.view, $("bm-rename-input").value));
      $("bm-rename-form").hidden = true;
    } catch (error) {
      bmStatus(error instanceof Error ? error.message : "Could not rename that folder", { error: true });
    }
  });
  $("bm-delete-folder").addEventListener("click", () => {
    const store = bmLoad();
    const folder = store.folders.find((entry) => entry.id === bmState.view);
    if (!folder || folder.id === BOOKMARK_ROOT) return;
    bmUndo = store;
    const parent = folder.parent || BOOKMARK_ROOT;
    bmState.view = parent;
    bmCommit(removeBookmarkFolder(store, folder.id));
    bmStatus(`Deleted folder “${folder.name}”. Its bookmarks moved up a level.`, { undo: true });
  });
}

function historyItems() {
  return readList(HISTORY_KEY) || [];
}

function rememberHistory(title, url) {
  if (!url) return;
  const items = historyItems().filter((item) => item.url !== url);
  items.unshift({ title: title || hostOf(url), url, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_CAP)));
}

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  const items = historyItems();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.textContent = "No pages yet.";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("span");
    title.textContent = item.title || hostOf(item.url);
    const small = document.createElement("small");
    small.textContent = item.url;
    button.title = item.url;
    button.append(title, small);
    button.addEventListener("click", () => {
      closePopovers();
      openUrl(item.url);
    });
    li.append(button);
    list.append(li);
  }
}

function hideSuggestions() {
  $("suggestions").hidden = true;
  $("suggestions").replaceChildren();
  addressInput.setAttribute("aria-expanded", "false");
  syncPageView();
}

function showSuggestions(query) {
  const box = $("suggestions");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    hideSuggestions();
    return;
  }
  const pool = [
    ...bookmarks().map((item) => ({ ...item, kind: "Bookmark" })),
    ...historyItems().map((item) => ({ ...item, kind: "History" })),
  ];
  const seen = new Set();
  const hits = [];
  for (const item of pool) {
    if (!item.url || seen.has(item.url)) continue;
    const blob = `${item.title || ""} ${item.url}`.toLowerCase();
    if (!blob.includes(needle)) continue;
    seen.add(item.url);
    hits.push(item);
    if (hits.length >= 6) break;
  }
  box.replaceChildren();
  if (!hits.length) {
    hideSuggestions();
    return;
  }
  for (const hit of hits) {
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("span");
    title.textContent = hit.title || hostOf(hit.url);
    const small = document.createElement("small");
    small.textContent = `${hit.kind} · ${hit.url}`;
    button.title = hit.url;
    button.append(title, small);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      hideSuggestions();
      openUrl(hit.url);
    });
    box.append(button);
  }
  box.hidden = false;
  addressInput.setAttribute("aria-expanded", "true");
  syncPageView();
}

function closePopovers() {
  $("shields-panel").hidden = true;
  $("history-panel").hidden = true;
  $("shields").setAttribute("aria-expanded", "false");
  $("history-btn").setAttribute("aria-expanded", "false");
  const menu = $("settings-menu");
  if (menu) menu.hidden = true;
  const settingsBtn = $("settings-btn");
  if (settingsBtn) settingsBtn.setAttribute("aria-expanded", "false");
  if (typeof closeKebabs === "function") closeKebabs();
  setNetOpen(false);
  syncPageView();
}

function togglePopover(panelId, buttonId) {
  const panel = $(panelId);
  const willOpen = panel.hidden;
  closePopovers();
  panel.hidden = !willOpen;
  $(buttonId).setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (panelId === "history-panel" && willOpen) renderHistory();
  syncPageView();
}

function directUrl(text) {
  try {
    const url = new URL(text);
    if (url.hostname === "html.duckduckgo.com") {
      const query = url.searchParams.get("q");
      return query ? `https://duckduckgo.com/?q=${encodeURIComponent(query)}` : DDG_HOME;
    }
  } catch {
    return text;
  }
  return text;
}

function looksLikeUrl(text) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return true;
  if (/\s/.test(text)) return false;
  return text.includes(".");
}

function openNative(tab, href, { push = true } = {}) {
  abortLoad(tab.id);
  tab.status = "";
  tab.loading = true;
  tab.url = href;
  tab.frameUrl = "";
  tab.title = hostOf(href);
  const entry = { url: href, title: tab.title, frameUrl: "", native: true };
  if (push) {
    tab.stack.splice(tab.index + 1);
    tab.stack.push(entry);
    tab.index = tab.stack.length - 1;
  } else if (tab.stack[tab.index]) {
    tab.stack[tab.index] = entry;
  } else {
    tab.stack.push(entry);
    tab.index = tab.stack.length - 1;
  }
  desktopCommand(`page:${tab.id}:${tab.isolated ? 1 : 0}:${href}`);
  renderTabs();
  if (tab.id === activeId) {
    addressInput.value = href;
    updateNav();
    renderTab();
  }
}

function setNodeSynced(synced) {
  const on = synced === true;
  $("node-btn").classList.toggle("is-synced", on);
  $("node-btn").setAttribute("aria-label", on ? "Warthog node, synced" : "Warthog node");
  let changed = false;
  for (const tab of tabs) {
    if (tab.kind !== "node" || tab.synced === on) continue;
    tab.synced = on;
    changed = true;
  }
  if (changed) renderTabs();
  const current = activeTab();
  if (current?.kind === "node") renderShield(current);
}

function onPageMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.event === "popup" && msg.url) {
    createTab({ isolated: Boolean(msg.isolated) });
    openUrl(msg.url);
    return;
  }
  const tab = tabs.find((item) => String(item.id) === String(msg.id));
  if (!tab || tab.kind === "node") return;
  if (msg.event === "fail") {
    tab.loading = false;
    const failed = String(msg.url || "");
    const current = String(tab.url || "");
    // A frame or a custom-scheme probe is not the page the person opened.
    if (isNativeTab(tab) && /^https?:\/\//i.test(current) && failed && failed !== current) {
      if (tab.id === activeId) updateNav();
      return;
    }
    tab.status = msg.error || "Could not open that page";
    renderTabs();
    if (tab.id === activeId) renderTab();
    return;
  }
  if (msg.url) {
    tab.url = msg.url;
    const entry = tab.stack[tab.index];
    if (entry) entry.url = msg.url;
  }
  if (msg.title) {
    tab.title = String(msg.title).slice(0, 80);
    const entry = tab.stack[tab.index];
    if (entry) entry.title = tab.title;
  }
  if (typeof msg.back === "boolean") tab.canBack = msg.back;
  if (typeof msg.forward === "boolean") tab.canForward = msg.forward;
  if (typeof msg.loading === "boolean") tab.loading = msg.loading;
  if (msg.event === "commit" || msg.event === "finish") {
    tab.status = "";
    if (msg.event === "finish" && tab.url) {
      sessionStorage.setItem(LAST_URL, tab.url);
      rememberHistory(tab.title, tab.url);
    }
  }
  renderTabs();
  if (tab.id !== activeId) return;
  // A page finishing in the background must not close hog://bookmarks.
  if (bookmarksViewOpen()) {
    updateNav();
    updateStar();
    return;
  }
  renderTab();
}

async function openUrl(raw, { push = true, method, fields } = {}) {
  let tab = activeTab();
  if (!tab) return;
  if (tab.kind === "shell") {
    createTab();
    return openUrl(raw, { push, method, fields });
  }
  let text = String(raw || "").trim();
  if (/^hog:\/\/bookmarks\/?$/i.test(text)) {
    showBookmarksView();
    return;
  }
  if (/^hog:\/\/settings\/?/i.test(text)) {
    showSettingsPage(text.replace(/^hog:\/\/settings\/?/i, "") || "general");
    return;
  }
  text = directUrl(text);
  if (!text) {
    goHome();
    return;
  }
  hideSuggestions();
  if (/^hog-post:/i.test(text)) {
    tab.status = "This browser opens links. It does not submit forms.";
    tab.frameUrl = "";
    renderTab();
    return;
  }
  const target = looksLikeUrl(text)
    ? text
    : `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  if (isNodeUrl(target) && tab.kind !== "node") {
    const node = tabs.find((item) => item.kind === "node");
    if (node?.frameUrl) {
      selectTab(node.id);
      return;
    }
    if (!node) createTab({ kind: "node" });
    else if (node.id !== activeId) selectTab(node.id);
    return openUrl(target, { push, method, fields });
  }
  tab = activeTab();
  const posting = String(method || "GET").toUpperCase() === "POST";
  if (isNativeTab(tab) && !posting) {
    const resolved = resolveAddress(target);
    if (resolved.error) {
      tab.status = resolved.error;
      tab.frameUrl = "";
      tab.url = target;
      renderTab();
      return;
    }
    openNative(tab, resolved.href, { push });
    return;
  }
  abortLoad(tab.id);
  const gen = bump(tab.id);
  const controller = new AbortController();
  loads.set(tab.id, controller);
  const tabId = tab.id;
  tab.status = "Loading…";
  tab.url = target;
  addressInput.value = tabId === activeId ? target : addressInput.value;
  renderTabs();
  if (tabId === activeId) {
    updateNav();
    showStatus("Loading…");
  }
  try {
    const payload = { url: target };
    if (posting) {
      payload.method = "POST";
      payload.fields = (Array.isArray(fields) ? fields : []).slice(0, 40).map((field) => ({
        name: String(field?.name ?? "").slice(0, 200),
        value: String(field?.value ?? "").slice(0, 4000),
      }));
    }
    const response = await fetch("/api/browse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();
    const owner = tabs.find((item) => item.id === tabId);
    if (!owner || navGen.get(tabId) !== gen) return;
    if (!response.ok || !data.ok) {
      owner.status = data.error || "Could not open that page";
      owner.frameUrl = "";
      if (tabId === activeId) renderTab();
      else renderTabs();
      return;
    }
    owner.status = "";
    owner.frameUrl = data.frameUrl || "";
    owner.url = data.finalUrl;
    owner.title = (data.title || hostOf(data.finalUrl) || "Page").slice(0, 80);
    sessionStorage.setItem(LAST_URL, data.finalUrl);
    rememberHistory(owner.title, data.finalUrl);
    const entry = {
      url: data.finalUrl,
      title: owner.title,
      frameUrl: data.frameUrl || "",
      method: posting ? "POST" : "",
      fields: posting ? payload.fields : null,
    };
    owner.method = entry.method;
    owner.fields = entry.fields;
    if (push) {
      owner.stack.splice(owner.index + 1);
      owner.stack.push(entry);
      owner.index = owner.stack.length - 1;
    } else if (owner.stack[owner.index]) {
      owner.stack[owner.index] = entry;
    } else {
      owner.stack.push(entry);
      owner.index = owner.stack.length - 1;
    }
    renderTabs();
    if (tabId === activeId) renderTab();
  } catch (error) {
    if (error.name === "AbortError") {
      const owner = tabs.find((item) => item.id === tabId);
      if (!owner || navGen.get(tabId) !== gen) return;
      const previous = owner.stack[owner.index];
      if (previous) applyOwned(owner, previous);
      else {
        owner.status = "";
        owner.url = "";
        owner.frameUrl = "";
        owner.title = "New tab";
      }
      renderTabs();
      if (tabId === activeId) renderTab();
      return;
    }
    const owner = tabs.find((item) => item.id === tabId);
    if (!owner || navGen.get(tabId) !== gen) return;
    owner.status = error.message || "Could not open that page";
    owner.frameUrl = "";
    if (tabId === activeId) renderTab();
  } finally {
    if (loads.get(tabId) === controller) loads.delete(tabId);
    if (tabId === activeId) updateNav();
  }
}

function applyOwned(tab, entry) {
  tab.url = entry.url || "";
  tab.title = entry.title || (entry.url ? hostOf(entry.url) : "New tab");
  tab.frameUrl = entry.frameUrl || "";
  tab.status = "";
  tab.method = entry.method || "";
  tab.fields = entry.fields || null;
}

function shortAddress(address) {
  if (!address || address.length < 12) return address || "Not unlocked";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortEvm(address) {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function startSession(account) {
  session = {
    privateKey: account.privateKey,
    address: account.address,
    evmAddress: account.evmAddress,
    evmKey: account.evmKey || account.privateKey,
    btcAddress: account.btcAddress || "",
    solAddress: account.solAddress || "",
  };
}

function paintNetMenu() {
  const chain = selectedChain();
  const menuChain = isWartChain(chain) ? "wart" : chain;
  const option = document.querySelector(`#net-list [data-chain="${menuChain}"]`);
  $("net-face").dataset.mark = option?.dataset.mark || "wart";
  $("net-ticker").textContent = option?.dataset.ticker || "WART";
  document.querySelectorAll("#net-list [data-chain]").forEach((node) => {
    const on = node.dataset.chain === menuChain;
    node.classList.toggle("is-on", on);
    node.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function paintWartBadge() {
  const badge = $("wart-net");
  const chain = selectedChain();
  const wart = isWartChain(chain);
  badge.hidden = !wart;
  if (!wart) return;
  const mainnet = chain === "mainnet";
  badge.textContent = mainnet ? "Mainnet" : "Testnet";
  badge.classList.toggle("is-main", mainnet);
  badge.title = mainnet ? "Switch to the DeFi testnet" : "Switch to mainnet";
  badge.setAttribute("aria-label", `${badge.textContent}. Switch network`);
}

function setNetOpen(open) {
  $("net-panel").hidden = !open;
  $("net-btn").setAttribute("aria-expanded", open ? "true" : "false");
  $("net-menu").classList.toggle("is-open", open);
}

function paintChain() {
  const chain = selectedChain();
  const spec = CHAIN_VIEW[chain];
  const address = activeAddress();
  paintNetMenu();
  paintWartBadge();
  if (!session) {
    $("w-addr-short").textContent = "Not unlocked";
    $("evm-line").textContent = "";
  } else {
    $("w-addr-short").textContent = address ? shortAddress(address) : "No account";
    drawIdenticon(address || session.address);
    if (chain === "ethereum" && session.evmAddress) $("evm-line").textContent = `Sites see ${shortEvm(session.evmAddress)}`;
    else if (chain === "hemi") $("evm-line").textContent = "Same address as Ethereum. Gas is ETH on Hemi.";
    else if (chain === "solana" && !address) $("evm-line").textContent = "Restore a recovery phrase to open Solana.";
    else if (chain === "solana") $("evm-line").textContent = "SOL on this address. Other tokens show here once they have a balance.";
    else $("evm-line").textContent = "";
  }
  if (session) $("address-line").textContent = session.address;
  $("receive-address").textContent = address || "No address on this network.";
  $("receive-note").textContent = address
    ? `Send ${spec.symbol} to this address on ${spec.label}.`
    : "Restore a 12 or 24 word phrase to open a Solana account.";
  const spend = isWartChain(chain) || chain === "ethereum" || chain === "hemi";
  $("send-to-label").hidden = !spend;
  $("send-amount-label").hidden = !spend;
  $("send-fee-label").hidden = !isWartChain(chain);
  $("send-button").hidden = !spend;
  $("send-to").placeholder = isWartChain(chain) ? "48 hex characters" : "0x address";
  $("send-chain-note").hidden = spend;
  if (chain === "bitcoin") {
    $("send-chain-note").textContent = "You can receive Bitcoin at this address. Sending Bitcoin from this window is not ready yet.";
  } else if (chain === "solana") {
    $("send-chain-note").textContent = address
      ? "You can receive SOL at this address. Sending Solana from this window is not ready yet."
      : "This key has no Solana account. Restore a 12 or 24 word phrase to open one.";
  }
  if ($("phrase-note") && session) {
    $("phrase-note").textContent = session.solAddress
      ? "This wallet was restored from a recovery phrase. Ethereum, Bitcoin, Hemi, and Solana come from that phrase. It is not shown again."
      : "This wallet is one private key. Ethereum and Hemi share its address, and Bitcoin uses the same key. Solana needs a recovery phrase.";
  }
}

function drawIdenticon(address) {
  const canvas = $("identicon");
  const ctx = canvas.getContext("2d");
  const cells = 5;
  const scale = canvas.width / cells;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!address) {
    ctx.fillStyle = "#27272a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  let hash = 0;
  for (let i = 0; i < address.length; i++) hash = (hash * 33 + address.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  ctx.fillStyle = `hsl(${hue} 42% 16%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = `hsl(${hue} 72% 58%)`;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < 3; x++) {
      hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
      if ((hash & 1) === 0) continue;
      ctx.fillRect(x * scale, y * scale, scale, scale);
      const mirror = cells - 1 - x;
      if (mirror !== x) ctx.fillRect(mirror * scale, y * scale, scale, scale);
    }
  }
}

function edgeFace(which, open) {
  const tab = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  tab.querySelector(".edge-chevron").textContent = which === "wallet" ? (open ? "›" : "‹") : (open ? "‹" : "›");
  tab.classList.toggle("is-open", open);
}

const PILL_W = 112;
const SPOT_TOP_KEY = { tabs: "hog-tabs-spot-top", wallet: "hog-wallet-spot-top" };
let pillLive = "";

function nativePageUp() {
  const tab = activeTab();
  return Boolean(tab && isNativeTab(tab) && tab.url && !tab.status && pageSurfaceClear());
}

function pillBox(which) {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  const rect = el.getBoundingClientRect();
  const y = Math.round(rect.top);
  const h = Math.max(1, Math.round(rect.height));
  if (which === "tabs") {
    const stage = $("stage").getBoundingClientRect();
    return { x: Math.round(stage.left + 2), y, w: PILL_W, h };
  }
  const stage = $("stage").getBoundingClientRect();
  return { x: Math.round(stage.right - 2 - PILL_W), y, w: PILL_W, h };
}

function spotParent(el) {
  return el.offsetParent || $("stage");
}

function clampSpotTop(el, top) {
  const parent = spotParent(el);
  const height = el.getBoundingClientRect().height || 46;
  const limit = Math.max(8, parent.clientHeight - height - 8);
  return Math.min(limit, Math.max(8, Math.round(top)));
}

function applySpotTop(which, top, publish = true) {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  const next = clampSpotTop(el, top);
  el.style.top = next + "px";
  localStorage.setItem(SPOT_TOP_KEY[which], String(next));
  if (publish) publishEdges();
  return next;
}

function restoreSpotTops() {
  localStorage.removeItem("hog-tabs-spot-h");
  localStorage.removeItem("hog-wallet-spot-h");
  for (const which of ["tabs", "wallet"]) {
    const raw = localStorage.getItem(SPOT_TOP_KEY[which]);
    if (raw == null || raw === "") continue;
    const saved = Number(raw);
    if (Number.isFinite(saved) && saved >= 0) applySpotTop(which, saved);
  }
}

function bindSpotDrag(which) {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  let originY = 0;
  let originTop = 0;
  let active = false;
  let moved = false;
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    active = true;
    moved = false;
    originY = event.clientY;
    originTop = el.offsetTop;
    try { el.setPointerCapture(event.pointerId); } catch { /* synthetic press */ }
  });
  el.addEventListener("pointermove", (event) => {
    if (!active) return;
    const dy = event.clientY - originY;
    if (Math.abs(dy) < 4) return;
    moved = true;
    el.classList.add("is-dragging");
    el.classList.remove("is-hot");
    hideEdgePill();
    applySpotTop(which, originTop + dy);
  });
  const stop = () => {
    if (!active) return;
    active = false;
    el.classList.remove("is-dragging");
    if (moved) el.dataset.dragged = "1";
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("click", (event) => {
    if (el.dataset.dragged !== "1") return;
    event.preventDefault();
    event.stopPropagation();
    delete el.dataset.dragged;
  }, true);
}

function pillFace(which) {
  if (which === "tabs") {
    return $("stage").classList.contains("is-tabs-closed") ? "Tabs ›" : "‹ Tabs";
  }
  return wallet.classList.contains("is-hidden") ? "‹ Wallet" : "Wallet ›";
}

function pillHitsPage(box) {
  if (!nativePageUp()) return false;
  const page = $("view").getBoundingClientRect();
  return box.x < page.right - 1 && box.x + box.w > page.left + 1 && box.y < page.bottom - 1 && box.y + box.h > page.top + 1;
}

function hideEdgePill() {
  if (!pillLive) return;
  pillLive = "";
  const command = "pill:hide";
  window.__hogLastPill = command;
  desktopCommand(command);
}

function showEdgePill(which) {
  const box = pillBox(which);
  if (!desktopOn() || !pillHitsPage(box)) {
    hideEdgePill();
    return;
  }
  const command = `pill:${box.x}:${box.y}:${box.w}:${box.h}:${which}:${pillFace(which)}`;
  if (command === pillLive) return;
  pillLive = command;
  window.__hogLastPill = command;
  desktopCommand(command);
}

function heatEdge(which, on, event) {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  if (el.classList.contains("is-dragging")) return;
  el.classList.toggle("is-hot", on);
  if (on) {
    showEdgePill(which);
    return;
  }
  if (event && pillLive) {
    const box = pillBox(which);
    if (event.clientX >= box.x && event.clientX < box.x + box.w && event.clientY >= box.y && event.clientY < box.y + box.h) return;
  }
  hideEdgePill();
}

let pillHold = false;
let spotHold = "";
let spotLeave = 0;
window.__hogPillHold = () => {
  pillHold = true;
};
window.__hogPillHide = () => {
  pillHold = false;
  hideEdgePill();
  $("tabs-edge").classList.remove("is-hot");
  $("wallet-edge").classList.remove("is-hot");
};
window.__hogSpotIn = (which) => {
  spotLeave += 1;
  spotHold = which;
  heatEdge(which, true);
};
window.__hogSpotOut = (which) => {
  const token = ++spotLeave;
  if (spotHold === which) spotHold = "";
  setTimeout(() => {
    if (token !== spotLeave || pillHold) return;
    heatEdge(which, false);
  }, 50);
};
window.__hogSpotDown = (which) => {
  spotLeave += 1;
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  el.classList.add("is-dragging");
  el.classList.remove("is-hot");
  hideEdgePill();
};
window.__hogSpotSlide = (which, viewportTop) => {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  const parentTop = spotParent(el).getBoundingClientRect().top;
  applySpotTop(which, viewportTop - parentTop, false);
};
window.__hogSpotUp = (which, moved) => {
  const el = $(which === "wallet" ? "wallet-edge" : "tabs-edge");
  el.classList.remove("is-dragging");
  if (moved) publishEdges();
  else el.click();
};
window.__hogEdgeMove = (which, top) => {
  if (which !== "tabs" && which !== "wallet") return;
  applySpotTop(which, Number(top), false);
};
window.__hogEdgeEnd = (which) => {
  if (which !== "tabs" && which !== "wallet") return;
  publishEdges();
};
window.__hogEdgeClick = (which) => {
  const el = document.getElementById(which === "wallet" ? "wallet-edge" : "tabs-edge");
  if (el) el.click();
};
window.__hogLastPill = "";
let lastEdges = "";

function publishEdges() {
  if (!desktopOn()) return;
  const page = nativePageUp();
  const stageEl = $("stage");
  const stage = stageEl.getBoundingClientRect();
  const metrics = getComputedStyle(stageEl);
  const lineW = parseFloat(metrics.getPropertyValue("--edge")) || 2;
  const spotW = parseFloat(metrics.getPropertyValue("--nub")) || 16;
  const pack = (show, rect) => show
    ? [Math.round(rect.left), Math.round(rect.top), Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))].join(":")
    : "0:0:0:0";
  const spot = (which) => {
    const rect = $(which === "wallet" ? "wallet-edge" : "tabs-edge").getBoundingClientRect();
    const left = which === "wallet" ? stage.right - spotW : stage.left;
    return { left, top: rect.top, width: spotW, height: rect.height };
  };
  const tabsClosed = stageEl.classList.contains("is-tabs-closed");
  const walletClosed = wallet.classList.contains("is-hidden");
  const command = [
    "edges",
    pack(page && tabsClosed, { left: stage.left, top: stage.top, width: lineW, height: stage.height }),
    pack(page && walletClosed, { left: stage.right - lineW, top: stage.top, width: lineW, height: stage.height }),
    pack(page && tabsClosed, spot("tabs")),
    pack(page && walletClosed, spot("wallet")),
  ].join(":");
  if (command === lastEdges) return;
  lastEdges = command;
  window.__hogLastEdges = command;
  desktopCommand(command);
}

function setWalletOpen(open) {
  wallet.classList.toggle("is-hidden", !open);
  if (open) wallet.removeAttribute("inert");
  else wallet.setAttribute("inert", "");
  const tab = $("wallet-edge");
  tab.hidden = false;
  tab.classList.remove("is-hot");
  edgeFace("wallet", open);
  $("wallet-edge-label").textContent = "Wallet";
  tab.setAttribute("aria-expanded", open ? "true" : "false");
  tab.setAttribute("aria-label", open ? "Hide wallet" : "Wallet");
  if (!open && wallet.contains(document.activeElement)) tab.focus();
  localStorage.setItem(WALLET_OPEN_KEY, open ? "1" : "0");
  hideEdgePill();
  trackView();
  if (!open) stopCelebrate();
}

function setTabsOpen(open) {
  const stage = $("stage");
  stage.classList.toggle("is-tabs-closed", !open);
  const tab = $("tabs-edge");
  tab.classList.remove("is-hot");
  edgeFace("tabs", open);
  $("tabs-edge-label").textContent = "Tabs";
  tab.setAttribute("aria-expanded", open ? "true" : "false");
  tab.setAttribute("aria-label", open ? "Hide tabs" : "Tabs");
  localStorage.setItem(TABS_OPEN_KEY, open ? "1" : "0");
  hideEdgePill();
  trackView();
}

function navFor(page) {
  if (TRADE_PAGES.has(page)) return "trade";
  if (page === "activity") return "activity";
  if (SETTINGS_PAGES.has(page)) return "settings";
  return "home";
}

function showWalletPage(name) {
  stopCelebrate();
  const page = WALLET_PAGES.includes(name) ? name : "home";
  for (const id of WALLET_PAGES) $(`wpage-${id}`).hidden = id !== page;
  const nav = navFor(page);
  document.querySelectorAll("#w-nav [data-wpage]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.wpage === nav);
  });
  if (page === "display") renderDisplayPicks();
  if (page === "autolock") $("autolock").value = localStorage.getItem(LOCK_KEY) || "0";
  if (page === "account") $("account-name").value = localStorage.getItem(NAME_KEY) || "";
  if (page === "sites") renderSites();
  syncNetworkActions();
}

const shells = new Map();

function showShell(tab) {
  hideSuggestions();
  closePopovers();
  viewSeq += 1;
  hideBrowserSettings();
  home.hidden = true;
  status.hidden = true;
  frame.hidden = true;
  view.classList.remove("is-page");
  frame.removeAttribute("srcdoc");
  if (frame.getAttribute("src")) frame.src = "about:blank";
  parkNode();
  const panel = $("shell-view");
  panel.hidden = false;
  for (const child of panel.children) child.hidden = child.dataset.tab !== String(tab.id);
  addressInput.value = tab.tip || tab.title || "";
  document.title = tab.title ? `${tab.title} — Hog` : "Hog";
  reportView(false);
  const session = shells.get(tab.id);
  if (session) {
    requestAnimationFrame(() => {
      session.fit.fit();
      session.term.focus();
    });
  }
}

function closeShell(id) {
  const session = shells.get(id);
  if (!session) return;
  shells.delete(id);
  if (session.ws) session.ws.close();
  session.term.dispose();
  document.querySelector(`#shell-view [data-tab="${id}"]`)?.remove();
  if (session.token) desktopCommand(`containers:shell-close:${session.token}`);
}

function beginShell(name) {
  const tab = createTab({ kind: "shell", title: `ssh ${name}` });
  tab.tip = `ssh hog@${name}`;
  tab.shellName = name;
  const pane = document.createElement("div");
  pane.className = "shell-pane";
  pane.dataset.tab = String(tab.id);
  const bar = document.createElement("div");
  bar.className = "shell-bar";
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = `hog can sudo apt-get, or sudo dnf on Fedora. Save image stores ${name}:local.`;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "tiny";
  save.textContent = "Save image";
  save.addEventListener("click", () => {
    save.disabled = true;
    note.textContent = `Saving ${name}:local…`;
    desktopCommand(`containers:commit:${name}`);
  });
  const host = document.createElement("div");
  host.className = "shell-term";
  bar.append(note, save);
  pane.append(bar, host);
  $("shell-view").append(pane);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    scrollback: 2000,
    theme: {
      background: "#101012",
      foreground: "#f4f4f5",
      cursor: "#fdb913",
      selectionBackground: "#fdb91355",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.writeln(`Installing SSH in ${name}.`);
  term.writeln("The first time can take a few minutes.");
  term.writeln("You are hog. Update with: sudo apt-get update");
  shells.set(tab.id, { term, fit, ws: null, token: "", name, note, save });
  renderTabs();
  showShell(tab);
  desktopCommand(`containers:shell:${name}`);
}

function connectShell(shell) {
  const tab = [...tabs].reverse().find((item) => item.kind === "shell" && item.shellName === shell.name && !shells.get(item.id)?.ws);
  const session = tab && shells.get(tab.id);
  if (!session) return;
  if (!shell.token || !shell.port) {
    session.term.writeln(`\r\n${shell.error || "Could not open SSH."}`);
    return;
  }
  session.token = shell.token;
  const ws = new WebSocket(`ws://127.0.0.1:${shell.port}/ssh?token=${encodeURIComponent(shell.token)}`);
  ws.binaryType = "arraybuffer";
  session.ws = ws;
  let noted = false;
  const note = (text) => {
    if (noted) return;
    noted = true;
    session.term.writeln(`\r\n${text}`);
  };
  ws.addEventListener("open", () => {
    session.fit.fit();
    ws.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
    session.term.focus();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") session.term.write(event.data);
    else session.term.write(new Uint8Array(event.data));
  });
  ws.addEventListener("close", () => note("Session closed."));
  ws.addEventListener("error", () => note("Could not open the SSH session."));
  session.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  });
  session.term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
}

const SSH_CAPS = ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE", "SYS_CHROOT", "AUDIT_WRITE", "KILL"];

function publishSpec(port) {
  const body = `${port.host}:${port.dest}/${port.proto}`;
  return port.bind ? `${port.bind}:${body}` : body;
}

function composeCommand(spec) {
  const parts = ["docker", "run", "-d", "--name", spec.name, "--cap-drop=ALL"];
  for (const cap of SSH_CAPS) parts.push(`--cap-add=${cap}`);
  if (spec.vpn) parts.push("--cap-add=NET_ADMIN", "--device", "/dev/net/tun");
  parts.push("--pids-limit", "1024", "--memory", "2g", "--memory-swap", "2g");
  if (spec.network) parts.push("--network", spec.network);
  if (spec.network !== "host") {
    for (const port of spec.ports) parts.push("-p", publishSpec(port));
    for (const item of spec.sysctls || []) parts.push("--sysctl", item);
  }
  for (const item of spec.env || []) parts.push("-e", item);
  parts.push(spec.image);
  if (spec.command && spec.command.length) parts.push(...spec.command);
  else if (!imageBringsCommand(spec.image)) parts.push("sleep", "infinity");
  return parts.join(" ");
}

function imageBringsCommand(image) {
  const text = String(image || "").toLowerCase();
  return text.includes("wireguard") || text.includes("tailscale") || text.includes("cartesi") || text.includes("jellyfin");
}

function allowedLaunchNetwork(name, image, network) {
  if (!network) return true;
  const img = String(image || "").toLowerCase();
  if (network === "hog-tailscale" || network === "host") {
    return name === "tailscale" && img.includes("tailscale");
  }
  return false;
}

function readPort(text) {
  const match = /^(?:(?<bind>(?:\d{1,3}\.){3}\d{1,3}):)?(?<host>\d{1,5}):(?<dest>\d{1,5})(?:\/(?<proto>tcp|udp))?$/.exec(text || "");
  if (!match) return null;
  const num = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return "";
    return String(number);
  };
  const host = num(match.groups.host);
  const dest = num(match.groups.dest);
  if (!host || !dest) return null;
  let bind = "";
  if (match.groups.bind) {
    const parts = match.groups.bind.split(".");
    if (parts.some((part) => Number(part) > 255)) return null;
    bind = parts.map((part) => String(Number(part))).join(".");
  }
  return { bind, host, dest, proto: match.groups.proto || "tcp" };
}

function readLaunch(text) {
  const raw = String(text || "").trim();
  if (!raw || /['"`$\\;&|<>]/.test(raw)) return null;
  const tokens = raw.split(/\s+/);
  if (tokens.length < 4 || tokens[0] !== "docker" || tokens[1] !== "run") return null;
  let name = "";
  const ports = [];
  const env = [];
  const sysctls = [];
  let vpn = false;
  let tun = false;
  let network = "";
  const positional = [];
  let index = 2;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-d" || token === "--detach") {
      index += 1;
      continue;
    }
    if (token === "--cap-drop=ALL" || token === "--cap-drop=CAP_ALL") {
      index += 1;
      continue;
    }
    if (token === "--cap-drop") {
      const value = (tokens[index + 1] || "").toUpperCase();
      if (value !== "ALL" && value !== "CAP_ALL") return null;
      index += 2;
      continue;
    }
    if (token === "--cap-add" || token.startsWith("--cap-add=")) {
      const cap = (token === "--cap-add" ? tokens[index + 1] : token.slice("--cap-add=".length) || "")
        .toUpperCase()
        .replace(/^CAP_/, "");
      if (!cap) return null;
      if (cap === "NET_ADMIN") vpn = true;
      else if (!SSH_CAPS.includes(cap)) return null;
      index += token === "--cap-add" ? 2 : 1;
      continue;
    }
    if (token === "--device" || token.startsWith("--device=")) {
      const device = token === "--device" ? tokens[index + 1] : token.slice("--device=".length);
      if (device !== "/dev/net/tun") return null;
      tun = true;
      index += token === "--device" ? 2 : 1;
      continue;
    }
    if (token === "-p" || token === "--publish" || token.startsWith("--publish=") || (token.startsWith("-p") && token !== "-p")) {
      const spec = token === "-p" || token === "--publish"
        ? tokens[index + 1]
        : token.replace(/^(?:--publish=|-p)/, "");
      const port = readPort(spec);
      if (!port) return null;
      ports.push(port);
      index += token === "-p" || token === "--publish" ? 2 : 1;
      continue;
    }
    if (positional.length) {
      positional.push(token);
      index += 1;
      continue;
    }
    if (token === "--name") {
      name = tokens[index + 1] || "";
      index += 2;
      continue;
    }
    if (token.startsWith("--name=")) {
      name = token.slice("--name=".length);
      index += 1;
      continue;
    }
    if (token === "--pids-limit" || token === "--memory" || token === "--memory-swap") {
      if (!tokens[index + 1]) return null;
      index += 2;
      continue;
    }
    if (/^--(?:pids-limit|memory|memory-swap)=/.test(token)) {
      index += 1;
      continue;
    }
    if (token === "-e" || token === "--env" || token.startsWith("--env=")) {
      const value = token === "-e" || token === "--env" ? tokens[index + 1] : token.slice("--env=".length);
      if (!/^[A-Z][A-Z0-9_]{0,79}=[A-Za-z0-9_.:/+@,-]{1,80}$/.test(value || "")) return null;
      env.push(value);
      index += token.startsWith("--env=") ? 1 : 2;
      continue;
    }
    if (token === "--sysctl" || token.startsWith("--sysctl=")) {
      const value = token === "--sysctl" ? tokens[index + 1] : token.slice("--sysctl=".length);
      if (value !== "net.ipv4.conf.all.src_valid_mark=1" && value !== "net.ipv4.ip_forward=1" && value !== "net.ipv6.conf.all.forwarding=1") return null;
      sysctls.push(value);
      index += token === "--sysctl" ? 2 : 1;
      continue;
    }
    if (token === "--network" || token === "--net" || token.startsWith("--network=") || token.startsWith("--net=")) {
      const value = token === "--network" || token === "--net" ? tokens[index + 1] : token.slice(token.indexOf("=") + 1);
      if ((value !== "hog-tailscale" && value !== "host") || network) return null;
      network = value;
      index += token === "--network" || token === "--net" ? 2 : 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    positional.push(token);
    index += 1;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) return null;
  if (!positional.length) return null;
  const image = positional[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,200}$/.test(image) || image.includes("..") || image.startsWith("-")) return null;
  const command = positional.slice(1);
  if (!command.length && !imageBringsCommand(image)) command.push("sleep", "infinity");
  if (command.some((part) => !/^[A-Za-z0-9_./:-]+$/.test(part))) return null;
  if (tun && !vpn) return null;
  if (ports.length > 8 || env.length > 16) return null;
  if (network && !allowedLaunchNetwork(name, image, network)) return null;
  return { name, image, ports, vpn, command, env, sysctls, network };
}

function paintLaunch(spec, status) {
  const box = $("container-command");
  if (!box || !spec) return;
  box.value = composeCommand(spec);
  if (status != null) $("container-status").textContent = status;
  $("container-error").textContent = "";
  syncLaunchButtons();
}

function fillLaunch(name, image, status, extra = {}) {
  paintLaunch({
    name,
    image,
    ports: extra.ports || [],
    vpn: Boolean(extra.vpn),
    command: Object.prototype.hasOwnProperty.call(extra, "command") ? extra.command : ["sleep", "infinity"],
    env: extra.env || [],
    sysctls: extra.sysctls || [],
    network: extra.network || "",
  }, status);
  if (extra.runtime) setLaunchRuntime(extra.runtime, { silent: true });
}

let wireguardModule = null;
let dockerRuntimeState = { engine: { ok: false, detail: "" }, desktop: { ok: false, detail: "" } };
let launchRuntime = "desktop";
let networkRuntime = "desktop";
let lastNetworkItems = [];
let lastContainerItems = [];

function runtimeDetail(side) {
  const item = dockerRuntimeState[side] || {};
  return item.detail || (side === "engine"
    ? "Docker Engine is not available."
    : "Docker Desktop is not available.");
}

function runtimeOk(side) {
  return Boolean((dockerRuntimeState[side] || {}).ok);
}

function paintRuntimeButtons(engineId, desktopId, selected) {
  const engine = $(engineId);
  const desktop = $(desktopId);
  if (!engine || !desktop) return;
  const engineReady = runtimeOk("engine");
  const desktopReady = runtimeOk("desktop");
  engine.disabled = !engineReady;
  desktop.disabled = !desktopReady;
  engine.title = engineReady ? "Run this container on native Docker Engine." : runtimeDetail("engine");
  desktop.title = desktopReady ? "Run this container on Docker Desktop." : runtimeDetail("desktop");
  engine.classList.toggle("is-on", selected === "engine");
  desktop.classList.toggle("is-on", selected === "desktop");
  engine.setAttribute("aria-pressed", selected === "engine" ? "true" : "false");
  desktop.setAttribute("aria-pressed", selected === "desktop" ? "true" : "false");
}

function applyTailscaleNetwork(runtime) {
  const box = $("container-command");
  if (!box) return;
  const spec = readLaunch(box.value);
  if (!spec || spec.name !== "tailscale" || !String(spec.image || "").toLowerCase().includes("tailscale")) return;
  if (runtime === "engine") {
    spec.network = "host";
    spec.sysctls = [];
  } else {
    spec.network = "hog-tailscale";
    const needed = ["net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1", "net.ipv6.conf.all.forwarding=1"];
    const have = new Set(spec.sysctls || []);
    spec.sysctls = [...(spec.sysctls || []), ...needed.filter((item) => !have.has(item))];
  }
  box.value = composeCommand(spec);
  syncLaunchButtons();
}

function setLaunchRuntime(side, options = {}) {
  if (side !== "engine" && side !== "desktop") return;
  if (!runtimeOk(side) && !options.silent) return;
  launchRuntime = side;
  paintRuntimeButtons("runtime-engine", "runtime-desktop", launchRuntime);
  const status = $("container-runtime-status");
  if (status) {
    if (!runtimeOk("engine") && !runtimeOk("desktop")) {
      status.textContent = `${runtimeDetail("engine")} ${runtimeDetail("desktop")}`;
    } else if (side === "engine" && !runtimeOk("engine")) {
      status.textContent = runtimeDetail("engine");
    } else if (side === "desktop" && !runtimeOk("desktop")) {
      status.textContent = runtimeDetail("desktop");
    } else if (side === "engine") {
      status.textContent = "Docker Engine runs containers directly on this computer. Tailscale can use the host network so your phone can usually connect directly.";
    } else {
      status.textContent = "Docker Desktop runs containers in its own virtual machine. GPU passthrough is not available there.";
    }
  }
  applyTailscaleNetwork(side);
}

function rememberRuntimes(payload) {
  if (!payload || !payload.dockerRuntimes) return;
  const engine = payload.dockerRuntimes.engine || {};
  const desktop = payload.dockerRuntimes.desktop || {};
  dockerRuntimeState = {
    engine: { ok: Boolean(engine.ok), detail: engine.detail || "" },
    desktop: { ok: Boolean(desktop.ok), detail: desktop.detail || "" },
  };
  if (!runtimeOk(launchRuntime)) {
    if (runtimeOk("engine")) launchRuntime = "engine";
    else if (runtimeOk("desktop")) launchRuntime = "desktop";
  }
  paintRuntimeButtons("runtime-engine", "runtime-desktop", launchRuntime);
  const status = $("container-runtime-status");
  if (status && !status.dataset.locked) {
    if (launchRuntime === "engine") {
      status.textContent = "Docker Engine runs containers directly on this computer. Tailscale can use the host network so your phone can usually connect directly.";
    } else {
      status.textContent = "Docker Desktop runs containers in its own virtual machine. GPU passthrough is not available there.";
    }
  }
}

function requestNetworks(side) {
  const runtime = side === "engine" || side === "desktop" ? side : networkRuntime;
  networkRuntime = runtime;
  paintRuntimeButtons("network-runtime-engine", "network-runtime-desktop", networkRuntime);
  desktopCommand(`containers:network-list:${runtime}`);
}

function paintNetworks(payload) {
  const list = $("network-list");
  const status = $("network-status");
  const error = $("network-error");
  if (!list) return;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "networkRuntime") && payload.networkRuntime) {
    networkRuntime = payload.networkRuntime;
  }
  paintRuntimeButtons("network-runtime-engine", "network-runtime-desktop", networkRuntime);
  if (payload && Object.prototype.hasOwnProperty.call(payload, "networks")) {
    lastNetworkItems = Array.isArray(payload.networks) ? payload.networks : [];
  } else if (!Array.isArray(lastNetworkItems)) {
    lastNetworkItems = [];
  } else {
    return;
  }
  if (error && Object.prototype.hasOwnProperty.call(payload, "networks")) {
    error.textContent = payload.ok === false ? (payload.error || "") : "";
  }
  if (status && Object.prototype.hasOwnProperty.call(payload, "networks")) {
    status.textContent = payload.notice || "Create a network on Docker Engine or Docker Desktop, then attach a Hog container to it.";
  }
  list.replaceChildren();
  const rows = lastNetworkItems.filter((item) => !item.runtime || item.runtime === networkRuntime);
  if (!rows.length) {
    const empty = document.createElement("li");
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = runtimeOk(networkRuntime)
      ? "No networks on this runtime yet."
      : runtimeDetail(networkRuntime);
    empty.append(note);
    list.append(empty);
  } else {
    for (const item of rows) {
      const li = document.createElement("li");
      const details = document.createElement("details");
      details.className = "network-item";
      const summary = document.createElement("summary");
      summary.className = "menu-row";
      const title = document.createElement("span");
      title.textContent = item.name;
      const small = document.createElement("small");
      const bits = [item.driver, item.subnet].filter(Boolean);
      small.textContent = bits.join(" · ") || "no subnet";
      if (item.internal) small.textContent += " · internal";
      if (item.builtin) small.textContent += " · built-in";
      const count = (item.containers || []).length;
      if (count) small.textContent += count === 1 ? " · 1 container" : ` · ${count} containers`;
      summary.append(title, small);
      const meta = document.createElement("p");
      meta.className = "network-meta";
      const attached = (item.containers || []).join(", ") || "No containers attached.";
      meta.textContent = [item.gateway ? `Gateway ${item.gateway}` : "", attached].filter(Boolean).join(" · ");
      const actions = document.createElement("div");
      actions.className = "menu-actions";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tiny";
      remove.textContent = "Delete";
      const busy = Boolean((item.containers || []).length) || Boolean(item.builtin);
      remove.disabled = busy;
      remove.title = item.builtin
        ? "Built-in Docker networks cannot be deleted."
        : (item.containers || []).length
          ? "Disconnect every container before deleting this network."
          : "Delete this unused network.";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        if (item.builtin || (item.containers || []).length) return;
        if (!window.confirm(`Delete network ${item.name}? This only works when nothing is attached.`)) return;
        desktopCommand(`containers:network-remove:${networkRuntime}:${item.name}`);
      });
      actions.append(remove);
      details.append(summary, meta, actions);
      li.append(details);
      list.append(li);
    }
  }
  const attach = $("network-attach");
  const containerSelect = $("network-container");
  const networkSelect = $("network-attach-name");
  if (attach && containerSelect && networkSelect) {
    const containers = (lastContainerItems || []).filter((item) => (item.runtime || "desktop") === networkRuntime && item.name);
    const userNets = rows.filter((item) => item.name && !item.builtin && item.name !== "host" && item.name !== "none");
    containerSelect.replaceChildren();
    networkSelect.replaceChildren();
    for (const item of containers) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      containerSelect.append(option);
    }
    for (const item of userNets) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      networkSelect.append(option);
    }
    attach.hidden = !(containers.length && userNets.length);
  }
}

function paintWireguardSetup() {
  const row = $("wireguard-setup");
  const button = $("load-wireguard");
  if (!row || !button) return;
  const spec = readLaunch($("container-command")?.value || "");
  const wants = Boolean(spec && spec.image.toLowerCase().includes("wireguard"));
  row.hidden = !(wants && wireguardModule !== true);
  if (button.dataset.busy !== "1") {
    button.disabled = false;
    button.textContent = "Load kernel module";
  }
}

function syncLaunchButtons() {
  const button = $("vpn-toggle");
  const box = $("container-command");
  if (!button || !box) return;
  const spec = readLaunch(box.value);
  const on = Boolean(spec && spec.vpn);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? "VPN interface on" : "VPN interface";
  paintWireguardSetup();
}

function launchBusy(busy) {
  for (const id of ["run-command", "recreate-command", "add-port", "vpn-toggle"]) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
}

function sendLaunch(replace) {
  const box = $("container-command");
  const command = box ? box.value.trim() : "";
  if (!command.startsWith("docker run")) {
    $("container-error").textContent = "The command has to start with docker run.";
    return;
  }
  const spec = readLaunch(command);
  const name = spec ? spec.name : "that container";
  if (replace) {
    const saved = name === "hog-ubuntu" ? " hog-ubuntu is the saved SSH machine. Save image first if you want those files." : "";
    const ok = window.confirm(`Recreate ${name}? Docker cannot change ports on a container that already exists. This stops it, removes it, and runs this command. Files inside ${name} are deleted unless you used Save image.${saved}`);
    if (!ok) return;
  }
  $("container-error").textContent = "";
  $("container-status").textContent = replace ? `Recreating ${name}…` : `Starting ${name}…`;
  launchBusy(true);
  const runtime = launchRuntime === "engine" || launchRuntime === "desktop" ? launchRuntime : "desktop";
  desktopCommand(`containers:${replace ? "recreate" : "run"}:${runtime}:${command}`);
}

function noteCommit(commit) {
  if (!commit?.name) return;
  const text = commit.error || `Saved as ${commit.image || `${commit.name}:local`}.`;
  const error = $("container-error");
  if (error) error.textContent = text;
  for (const session of shells.values()) {
    if (session.name !== commit.name || !session.note) continue;
    session.note.textContent = text;
    if (session.save) session.save.disabled = false;
  }
}

function paintEndpointChoice(items) {
  const row = $("wireguard-endpoint");
  if (!row) return;
  const live = Array.isArray(items) && items.some((item) => {
    return item && item.name === "wireguard" && item.state === "running" && !item.reason;
  });
  row.hidden = !live;
  if (!live) return;
  for (const id of ["endpoint-lan", "endpoint-public"]) {
    const button = $(id);
    if (button && button.dataset.busy !== "1") button.disabled = false;
  }
}

function tailscaleIpText(value) {
  if (typeof value !== "string" || !value) return "";
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "";
  if (parts[0] !== 100 || parts[1] < 64 || parts[1] > 127) return "";
  return value;
}

function paintTailscaleSetup(payload) {
  const items = payload && payload.items;
  const item = Array.isArray(items) && items.find((entry) => {
    return entry && entry.name === "tailscale" && !entry.reason;
  });
  const live = Boolean(item && item.state === "running");
  const state = payload && typeof payload.tailscaleState === "string" ? payload.tailscaleState : "";
  const signedIn = live && (state === "Running" || state === "NeedsMachineAuth");
  const button = $("tailscale-up");
  const auth = $("tailscale-auth");
  const error = $("tailscale-error");
  const link = $("tailscale-login-link");
  const url = tailscaleEnableUrl((payload && payload.tailscaleLoginUrl) || "");
  if (button) {
    button.hidden = !live || signedIn;
    if (live && !signedIn && button.dataset.busy !== "1") {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  }
  if (error && payload && (Object.prototype.hasOwnProperty.call(payload, "tailscaleState") || payload.openLogin)) {
    error.textContent = payload.error || "";
  }
  if (auth) {
    if (signedIn) {
      auth.textContent = state === "NeedsMachineAuth"
        ? "Tailscale is signed in. Waiting for admin approval."
        : "Tailscale is signed in. On the phone, choose hog as the exit node.";
    } else if (!item) {
      auth.textContent = "Start the tailscale container in Docker, then sign in here.";
    } else if (!live) {
      auth.textContent = "Start the tailscale container in Docker, then sign in here.";
    } else if (url) {
      auth.textContent = "Open the sign-in link, then finish login. Approve hog as an exit node in the Tailscale admin page.";
    } else {
      auth.textContent = "Press Sign in, open the link, and finish login. Approve hog as an exit node in the Tailscale admin page.";
    }
    if (payload && payload.ok && typeof payload.notice === "string" && payload.notice && (signedIn || url || payload.openLogin)) {
      auth.textContent = payload.notice;
    }
  }
  if (link) {
    link.hidden = !url;
    link.dataset.url = url;
  }
  if (payload && payload.openLogin && url) maybeOpenTailscaleLogin(url);
}

let lastOpenedLogin = "";

function maybeOpenTailscaleLogin(url) {
  const allowed = tailscaleEnableUrl(url);
  if (!allowed || allowed === lastOpenedLogin) return;
  lastOpenedLogin = allowed;
  openTailscaleUrl(allowed);
}

function openTailscaleUrl(url) {
  const allowed = tailscaleEnableUrl(url);
  if (!allowed) return;
  // Open Tailscale login/admin inside Hog so Brave/system browser is not needed.
  if (desktopOn()) {
    createTab();
    openUrl(allowed);
    return;
  }
  desktopCommand(`open:${allowed}`);
}

let sharesOpen = false;

function tailscaleLive(items) {
  return Array.isArray(items) && items.some((item) => {
    return item && item.name === "tailscale" && item.state === "running" && !item.reason;
  });
}

function phoneHttps(url, port) {
  if (typeof url !== "string" || url.length > 160) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  if (String(parsed.port) !== String(port)) return false;
  return /^[a-z0-9.-]+$/i.test(parsed.hostname);
}

function tailnetHttp(url, port) {
  if (typeof url !== "string" || url.length > 80) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) return false;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  if (String(parsed.port) !== String(port)) return false;
  const parts = parsed.hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function tailscaleEnableUrl(url) {
  if (typeof url !== "string" || url.length < 30 || url.length >= 300 || /\s/.test(url)) return "";
  let parsed;
  try { parsed = new URL(url); } catch { return ""; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "login.tailscale.com") return "";
  if (parsed.username || parsed.password || parsed.port) return "";
  return url;
}

let mediaCwd = "";

function mediaPathOk(path) {
  if (typeof path !== "string" || path.length > 500 || /[\\\n\r\0]/.test(path)) return false;
  if (!path) return true;
  return path.split("/").every((part) => {
    return part && part !== "." && part !== ".." && !part.startsWith(".") && part.length <= 180 && !/[/\\]/.test(part);
  });
}

function mediaNameOk(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 180
    && name !== "." && name !== ".." && !name.startsWith(".") && !/[/\\\n\r\0]/.test(name);
}

function libraryLabel(path) {
  if (!path) return "~/hog-shares";
  return `~/hog-shares/${path}`;
}

function openMedia(path) {
  if (!mediaPathOk(path)) return;
  mediaCwd = path;
  updateDropHint(path);
  const status = $("media-status");
  if (status) status.textContent = path ? "Opening folder…" : "";
  desktopCommand(`containers:media-open:${path}`);
}

function updateDropHint(path) {
  const shown = mediaPathOk(path) ? path : mediaCwd;
  const target = $("share-drop-target");
  if (target) target.textContent = libraryLabel(shown);
  const creating = $("share-drop-new");
  const form = $("media-folder-form");
  const input = $("media-folder-name");
  const name = input && form && !form.hidden ? input.value.trim() : "";
  if (creating) {
    if (mediaNameOk(name) && mediaPathOk(shown)) {
      const next = shown ? `${shown}/${name}` : name;
      creating.hidden = false;
      creating.textContent = `New folder: ${libraryLabel(next)}`;
    } else {
      creating.hidden = true;
      creating.textContent = "";
    }
  }
  requestAnimationFrame(reportShareDrop);
}

function mediaMeta(item) {
  if (item.kind !== "folder") return typeof item.size === "string" ? item.size : "";
  const count = Number(item.items);
  const parts = ["Folder"];
  if (item.shared) parts.push("on the phone");
  if (Number.isInteger(count) && count >= 0) {
    const shown = count >= 100 ? "100+" : String(count);
    parts.push(shown === "1" ? "1 item" : `${shown} items`);
  }
  return parts.join(" · ");
}

function paintMediaCrumb(path) {
  const crumb = $("media-crumb");
  if (!crumb) return;
  crumb.replaceChildren();
  const root = document.createElement("button");
  root.type = "button";
  root.dataset.mediaPath = "";
  root.textContent = "Library";
  crumb.append(root);
  if (!path) return;
  let acc = "";
  const parts = path.split("/");
  parts.forEach((part, index) => {
    crumb.append(document.createTextNode(" / "));
    acc = acc ? `${acc}/${part}` : part;
    if (index === parts.length - 1) {
      const here = document.createElement("span");
      here.textContent = part;
      crumb.append(here);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mediaPath = acc;
    button.textContent = part;
    crumb.append(button);
  });
}

function paintMedia(payload) {
  if (!payload || !Array.isArray(payload.media) || typeof payload.mediaPath !== "string") return;
  if (!mediaPathOk(payload.mediaPath)) return;
  const list = $("media-list");
  const empty = $("media-empty");
  const status = $("media-status");
  if (!list || !empty) return;
  mediaCwd = payload.mediaPath;
  paintMediaCrumb(mediaCwd);
  updateDropHint(mediaCwd);
  if (status && typeof payload.mediaNote === "string") status.textContent = payload.mediaNote;
  empty.hidden = payload.media.length > 0;
  empty.textContent = mediaCwd
    ? "This folder is empty."
    : "Nothing in the library yet. Drop films and photos above, or use Add files.";
  list.replaceChildren();
  for (const item of payload.media) {
    if (!item || !mediaNameOk(item.name)) continue;
    if (item.kind !== "file" && item.kind !== "folder") continue;
    const full = mediaCwd ? `${mediaCwd}/${item.name}` : item.name;
    const li = document.createElement("li");
    let name;
    if (item.kind === "folder") {
      name = document.createElement("button");
      name.type = "button";
      name.className = "media-open";
      name.dataset.openPath = full;
      name.setAttribute("aria-label", `Open ${item.name}`);
    } else {
      name = document.createElement("span");
      name.className = "media-name";
    }
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "media-size";
    meta.textContent = mediaMeta(item);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tiny";
    remove.textContent = "Remove";
    remove.dataset.removePath = full;
    remove.dataset.removeKind = item.kind;
    remove.dataset.removeName = item.name;
    remove.dataset.removeShared = item.shared ? "1" : "";
    li.append(name, meta, remove);
    list.append(li);
  }
  requestAnimationFrame(reportShareDrop);
}

window.__hogMediaNote = (text) => {
  const status = $("media-status");
  if (!status || typeof text !== "string" || text.length > 240) return;
  status.textContent = text;
};

function paintJellyfinPhone(payload) {
  const host = $("jellyfin-host");
  if (!host) return;
  if (!payload) return;
  const hasUrl = Object.prototype.hasOwnProperty.call(payload, "jellyfinUrl");
  const hasIp = Object.prototype.hasOwnProperty.call(payload, "tailscaleIp");
  if (!hasUrl && !hasIp) return;
  const url = hasUrl && tailnetHttp(payload.jellyfinUrl, "8096") ? payload.jellyfinUrl : "";
  const ip = hasIp ? tailscaleIpText(payload.tailscaleIp) : "";
  if (url) host.textContent = url.replace(/^https?:\/\//, "");
  else if (ip) host.textContent = ip;
  else host.textContent = "100.—";
  const copy = $("jellyfin-copy");
  if (copy) {
    copy.hidden = !url;
    copy.dataset.url = url;
    copy.textContent = "Copy";
  }
  requestAnimationFrame(reportShareDrop);
}

function openJellyfinConnect() {
  showSettingsPage("tailscale");
  requestAnimationFrame(() => {
    const panel = $("jellyfin-connect");
    if (panel) panel.scrollIntoView({ block: "start" });
  });
}

function openTailscaleShares() {
  sharesOpen = true;
  showSettingsPage("tailscale");
  requestAnimationFrame(() => {
    const panel = $("jellyfin-connect") || $("exit-node-guide") || $("tailscale-shares");
    if (panel) panel.scrollIntoView({ block: "start" });
  });
  desktopCommand("containers:share-list");
}

function paintShares(payload) {
  const panel = $("tailscale-shares");
  if (!panel || !payload) return;
  const live = tailscaleLive(payload.items);
  const offline = $("share-offline");
  const steps = $("share-steps");
  if (offline) offline.hidden = live;
  if (steps) steps.hidden = !live;
  if (!Array.isArray(payload.shares)) return;
  const dns = $("share-dns");
  if (dns) {
    dns.textContent = payload.dns
      ? `The phone uses the Tailscale app on this same account. This computer is ${payload.dns}. Funnel stays off.`
      : "The phone uses the Tailscale app on this same account. Funnel stays off.";
  }
  const list = $("share-list");
  const empty = $("share-empty");
  if (empty) empty.hidden = payload.shares.length > 0;
  if (list) {
    list.replaceChildren();
    for (const item of payload.shares) {
      if (!item || typeof item.name !== "string" || typeof item.path !== "string") continue;
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = item.name;
      const kind = document.createElement("small");
      kind.textContent = item.kind === "network" ? "Network folder" : "On this computer";
      const path = document.createElement("small");
      path.textContent = item.path;
      li.append(title, document.createTextNode(" "), kind, document.createElement("br"), path);
      let shown = "";
      if (typeof item.url === "string" && item.url) {
        try {
          const parsed = new URL(item.url);
          if (phoneHttps(item.url, parsed.port)) shown = item.url;
        } catch { /* leave the folder unpublished in the list */ }
      }
      const link = document.createElement("code");
      link.className = "share-url";
      link.textContent = shown || "Not on the phone yet. Press Publish to the phone.";
      li.append(link);
      const row = document.createElement("div");
      row.className = "row";
      if (shown) {
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "tiny";
        copy.textContent = "Copy link";
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(item.url);
            copy.textContent = "Copied";
          } catch {
            copy.textContent = "Select the link";
          }
        });
        row.append(copy);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tiny";
      remove.textContent = "Stop sharing";
      remove.addEventListener("click", () => {
        if (!/^[a-z][a-z0-9-]{0,24}$/.test(item.name)) return;
        if (!window.confirm(`Stop sharing ${item.name}? The folder stays in the library.`)) return;
        desktopCommand(`containers:share-remove:${item.name}`);
      });
      row.append(remove);
      li.append(row);
      list.append(li);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "enableUrl")) {
    const allow = $("share-enable");
    const enable = tailscaleEnableUrl(payload.enableUrl);
    if (allow) {
      allow.hidden = !enable;
      allow.dataset.url = enable;
      if (allow.dataset.busy !== "1") allow.disabled = false;
    }
  }
  const made = payload.ok && typeof payload.notice === "string" && (payload.notice.startsWith("Created ") || payload.notice.startsWith("Sharing "));
  const form = $("share-name-form");
  const input = $("share-name");
  if (made && form) form.hidden = true;
  if (made && input) input.value = "";
}

function sendEndpoint(mode) {
  const lan = mode === "lan";
  for (const id of ["endpoint-lan", "endpoint-public"]) {
    const button = $(id);
    if (!button) continue;
    button.dataset.busy = "1";
    button.disabled = true;
  }
  $("container-error").textContent = "";
  $("container-status").textContent = lan
    ? "Writing this Wi-Fi address into a new square…"
    : "Writing the public address into a new square…";
  desktopCommand(`containers:endpoint:${lan ? "lan" : "public"}`);
}

function paintQr(codes) {
  const host = $("container-qr");
  if (!host) return;
  host.replaceChildren();
  const ready = (Array.isArray(codes) ? codes : []).filter((code) => {
    return code && typeof code.png === "string" && code.png.startsWith("data:image/png;base64,") && code.png.length < 300000;
  });
  host.hidden = ready.length === 0;
  for (const code of ready) {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.alt = "WireGuard setup code";
    img.src = code.png;
    const caption = document.createElement("figcaption");
    const endpoint = /^(\d{1,3}\.){3}\d{1,3}:51820$/.test(code.endpoint || "") ? code.endpoint : "";
    caption.textContent = endpoint
      ? `${code.label || "Peer"}. Scan this square. It uses ${endpoint}.`
      : `${code.label || "Peer"}. Point the phone at this square.`;
    figure.append(img, caption);
    host.append(figure);
  }
  if (ready.length) host.scrollIntoView({ block: "nearest" });
}


function paintDefaultBrowser(payload) {
  const button = $("default-browser-toggle");
  const status = $("default-browser-status");
  const error = $("default-browser-error");
  if (!button || !status || !error || !payload) return;
  if (!Object.prototype.hasOwnProperty.call(payload, "defaultBrowser")
      && !Object.prototype.hasOwnProperty.call(payload, "defaultBrowserAvailable")) {
    return;
  }
  delete button.dataset.busy;
  button.disabled = false;
  const available = payload.defaultBrowserAvailable !== false;
  const on = Boolean(payload.defaultBrowser);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? "Using Hog as default" : "Set as default browser";
  const current = typeof payload.defaultBrowserId === "string" ? payload.defaultBrowserId : "";
  const previous = typeof payload.defaultBrowserPrevious === "string" ? payload.defaultBrowserPrevious : "";
  if (!available) {
    status.textContent = "Install the hog-browser .deb to register Hog as a browser, then try again.";
  } else if (on) {
    status.textContent = previous
      ? `Hog opens http(s) links. Turning this off restores ${previous.replace(/\.desktop$/, "")}.`
      : "Hog opens http(s) links from other apps.";
  } else if (current) {
    status.textContent = `Currently ${current.replace(/\.desktop$/, "")}. Turn this on so Hog opens http(s) links.`;
  } else {
    status.textContent = "Turn this on so Hog opens http(s) links from other apps.";
  }
  if (Object.prototype.hasOwnProperty.call(payload, "error")) {
    error.textContent = payload.error || "";
  }
  if (payload.ok && typeof payload.notice === "string" && payload.notice) {
    status.textContent = payload.notice;
  }
}

function paintJellyfinGpu(payload) {
  const button = $("jellyfin-gpu-toggle");
  const status = $("jellyfin-gpu-status");
  const error = $("jellyfin-gpu-error");
  const list = $("jellyfin-gpu-checks");
  const hint = $("jellyfin-gpu-hint");
  if (!button || !status || !error || !list || !payload) return;
  if (!Object.prototype.hasOwnProperty.call(payload, "jellyfinGpu")
      && !Object.prototype.hasOwnProperty.call(payload, "jellyfinGpuChecks")) {
    return;
  }
  delete button.dataset.busy;
  button.disabled = false;
  const on = Boolean(payload.jellyfinGpu);
  const ready = Boolean(payload.jellyfinGpuReady);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? "Using NVIDIA GPU" : "Use NVIDIA GPU";
  if (on) {
    status.textContent = "Jellyfin runs on Docker Engine with the NVIDIA GPU. Turn this off to keep it on Docker Engine without the GPU. Login and libraries do not carry over from Docker Desktop; ~/hog-shares stays the same. Use the runtime control to move it to Docker Desktop.";
  } else if (ready) {
    status.textContent = "This computer is ready. Turn this on to recreate Jellyfin on Docker Engine with --gpus all. Docker Desktop settings will not carry over.";
  } else if (payload.jellyfinGpuCanInstall) {
    status.textContent = "GPU transcoding needs the three checks below. If the NVIDIA toolkit is missing, press Install NVIDIA toolkit. Ubuntu will ask for your password. Hog never stores that password.";
  } else {
    status.textContent = "GPU transcoding needs the three checks below. Copy the install commands when a check is missing. Installing the hog-browser .deb enables the Install NVIDIA toolkit button.";
  }
  if (Object.prototype.hasOwnProperty.call(payload, "error") && (payload.jellyfinGpu === true || payload.jellyfinGpu === false || payload.jellyfinGpuChecks)) {
    error.textContent = payload.error || "";
  }
  if (payload.ok && typeof payload.notice === "string" && payload.notice && (on || Object.prototype.hasOwnProperty.call(payload, "jellyfinGpu"))) {
    if (/NVIDIA|GPU|Docker Engine|Docker Desktop \(CPU\)/.test(payload.notice)) {
      status.textContent = payload.notice;
    }
  }
  const checks = Array.isArray(payload.jellyfinGpuChecks) ? payload.jellyfinGpuChecks : [];
  list.replaceChildren();
  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const item = document.createElement("li");
    item.classList.toggle("is-ready", Boolean(check.ok));
    const head = document.createElement("div");
    head.className = "gpu-check-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = check.label || "Check";
    const detail = document.createElement("p");
    detail.className = "note";
    detail.textContent = check.detail || (check.ok ? "Ready." : "Not ready.");
    copy.append(title, detail);
    const mark = document.createElement("span");
    mark.className = "gpu-check-mark";
    mark.textContent = check.ok ? "Ready" : "Missing";
    head.append(copy, mark);
    item.append(head);
    const commands = Array.isArray(check.commands) ? check.commands.filter((line) => typeof line === "string" && line.trim()) : [];
    if (commands.length) {
      const pre = document.createElement("pre");
      pre.className = "mono";
      pre.textContent = commands.join("\n");
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "gpu-copy";
      copyBtn.textContent = "Copy commands";
      copyBtn.addEventListener("click", async () => {
        const blob = commands.join("\n");
        try {
          await navigator.clipboard.writeText(blob);
          copyBtn.textContent = "Copied";
        } catch (_err) {
          copyBtn.textContent = "Select the commands";
          const range = document.createRange();
          range.selectNodeContents(pre);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        window.setTimeout(() => {
          copyBtn.textContent = "Copy commands";
        }, 1500);
      });
      item.append(pre, copyBtn);
    }
    list.append(item);
  }
  if (hint) hint.hidden = !on;
  const toolkit = checks.find((item) => item && item.id === "toolkit");
  const installRow = $("jellyfin-gpu-install-row");
  const installBtn = $("jellyfin-gpu-install");
  if (installRow && installBtn) {
    const showInstall = Boolean(payload.jellyfinGpuCanInstall) && Boolean(toolkit) && !toolkit.ok;
    installRow.hidden = !showInstall;
    if (installBtn.dataset.busy !== "1") {
      installBtn.disabled = !showInstall;
      installBtn.textContent = "Install NVIDIA toolkit";
    }
  }
  const log = $("jellyfin-gpu-install-log");
  if (log) {
    const textLog = typeof payload.jellyfinGpuInstallLog === "string" ? payload.jellyfinGpuInstallLog : "";
    log.hidden = !textLog;
    log.textContent = textLog;
    if (textLog) log.scrollTop = log.scrollHeight;
  }
  if (installBtn) {
    // Clear busy after a result that included install fields or a fresh check list.
    if (Object.prototype.hasOwnProperty.call(payload, "jellyfinGpuInstallLog")
        || Object.prototype.hasOwnProperty.call(payload, "jellyfinGpuChecks")) {
      if (installBtn.dataset.busy === "1" && (payload.ok === true || payload.ok === false)) {
        delete installBtn.dataset.busy;
        if (installRow && !installRow.hidden) {
          installBtn.disabled = false;
          installBtn.textContent = "Install NVIDIA toolkit";
        }
      }
    }
  }
}

function paintDocker(payload) {
  const state = $("docker-state");
  const button = $("start-docker");
  if (!state || !button || typeof payload.docker !== "boolean") return;
  rememberRuntimes(payload);
  const engine = dockerRuntimeState.engine || {};
  const desktop = dockerRuntimeState.desktop || {};
  const desktopOn = Boolean(desktop.ok) || payload.docker;
  button.hidden = desktopOn;
  button.disabled = false;
  button.textContent = "Start Docker";
  const parts = [];
  if (engine.ok) parts.push("Docker Engine is running.");
  else if (engine.detail) parts.push(engine.detail);
  if (desktop.ok || payload.docker) parts.push("Docker Desktop is running.");
  else parts.push("Docker Desktop is not running. Start it here if you want Desktop containers.");
  state.textContent = parts.join(" ");
}

function paintUpdate(payload) {
  const status = $("hog-update-status");
  const error = $("hog-update-error");
  const check = $("hog-update-check");
  const install = $("hog-update-install");
  const restart = $("hog-update-restart");
  const manual = $("hog-update-manual");
  const link = $("hog-update-link");
  const command = $("hog-update-command");
  const log = $("hog-update-log");
  const badge = $("hog-update-menu-badge");
  const gear = $("settings-btn");
  if (!status || !payload || !Object.prototype.hasOwnProperty.call(payload, "currentVersion")) return;
  if (check) {
    delete check.dataset.busy;
    check.disabled = false;
  }
  if (install) delete install.dataset.busy;
  const current = payload.currentVersion || "";
  const latest = payload.latestVersion || "";
  const available = Boolean(payload.updateAvailable);
  const canInstall = Boolean(payload.updateCanInstall);
  const helperReady = Boolean(payload.updateHelperReady);
  const needRestart = Boolean(payload.updateRestart);
  if (payload.notice) status.textContent = payload.notice;
  else if (current && latest && available) status.textContent = `This is Hog ${current}. Hog ${latest} is available.`;
  else if (current) status.textContent = `This is Hog ${current}.`;
  else status.textContent = "Hog could not read its current version.";
  if (error) error.textContent = payload.ok === false ? (payload.error || "") : "";
  if (install) {
    install.hidden = !(canInstall && !needRestart);
    install.disabled = install.hidden;
  }
  if (restart) {
    restart.hidden = !needRestart;
    restart.disabled = false;
  }
  if (check) check.hidden = needRestart;
  if (link) {
    const url = typeof payload.releaseUrl === "string" && payload.releaseUrl
      ? payload.releaseUrl
      : "https://github.com/warthog-network/hog-browser/releases/latest";
    link.setAttribute("href", url);
  }
  if (command) command.textContent = payload.manualCommand || "";
  if (manual) manual.hidden = !(available && !helperReady && (payload.manualCommand || payload.releaseUrl));
  if (log) {
    const text = payload.updateLog || "";
    log.hidden = !text;
    log.textContent = text;
  }
  if (gear) gear.classList.toggle("has-update", available && !needRestart);
  if (badge) badge.hidden = !(available && !needRestart);
}

function openHogRelease(url) {
  let allowed = "";
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:") return;
    if (parsed.hostname !== "github.com") return;
    if (!parsed.pathname.startsWith("/warthog-network/hog-browser/releases")) return;
    allowed = parsed.toString();
  } catch {
    return;
  }
  if (typeof createTab === "function") createTab();
  if (typeof openUrl === "function") openUrl(allowed);
}


const ACCORDION_KEY = "hog-settings-accordions";
const ACCORDION_DEFAULTS = {
  "container-images": true,
  "container-advanced": false,
  "network-create-wrap": false,
  "network-attach-wrap": false,
  "exit-node-guide": false,
};

function accordionOpen(id, fallback) {
  if (!id) return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(ACCORDION_KEY) || "{}");
    if (saved && typeof saved === "object" && Object.prototype.hasOwnProperty.call(saved, id)) {
      return Boolean(saved[id]);
    }
  } catch {}
  if (Object.prototype.hasOwnProperty.call(ACCORDION_DEFAULTS, id)) return ACCORDION_DEFAULTS[id];
  return fallback;
}

function rememberAccordion(el) {
  if (!el || !el.id || el.dataset.accordionBound === "1") return;
  el.dataset.accordionBound = "1";
  el.addEventListener("toggle", () => {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(ACCORDION_KEY) || "{}") || {};
    } catch {
      saved = {};
    }
    saved[el.id] = el.open;
    localStorage.setItem(ACCORDION_KEY, JSON.stringify(saved));
  });
}

function pruneAccordions() {
  // Older versions saved panels that no longer exist (for example the AI page).
  try {
    const saved = JSON.parse(localStorage.getItem(ACCORDION_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      localStorage.removeItem(ACCORDION_KEY);
      return;
    }
    let changed = false;
    for (const id of Object.keys(saved)) {
      if (id.startsWith("ai-")) {
        delete saved[id];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(ACCORDION_KEY, JSON.stringify(saved));
  } catch {
    try { localStorage.removeItem(ACCORDION_KEY); } catch {}
  }
}

function restoreAccordions() {
  pruneAccordions();
  document.querySelectorAll("#browser-settings details[id]").forEach((el) => {
    el.open = accordionOpen(el.id, el.open);
    rememberAccordion(el);
  });
}

function showToast(message, kind) {
  const host = $("hog-toasts");
  const text = String(message || "").trim();
  if (!host || !text) return;
  const item = document.createElement("div");
  item.className = `hog-toast is-${kind === "error" ? "error" : "ok"}`;
  item.setAttribute("role", "status");
  item.textContent = text;
  host.append(item);
  setTimeout(() => item.classList.add("is-out"), 3600);
  setTimeout(() => item.remove(), 4200);
}

let lastToastKey = "";
function maybeToast(payload) {
  if (!payload) return;
  const failed = payload.ok === false;
  const message = failed ? (payload.error || "") : (payload.notice || "");
  if (!message) return;
  if (!Object.prototype.hasOwnProperty.call(payload, "notice") && !failed) return;
  const key = `${failed ? "error" : "ok"}:${message}`;
  if (key === lastToastKey) return;
  lastToastKey = key;
  showToast(message, failed ? "error" : "ok");
}

function setProgress(barId, fillId, textId, info) {
  const bar = $(barId);
  const fill = $(fillId);
  const text = $(textId);
  if (!bar) return;
  if (!info || !info.status) {
    bar.hidden = true;
    bar.classList.remove("is-indeterminate");
    if (fill) fill.style.width = "0%";
    return;
  }
  bar.hidden = false;
  const pct = Number.isInteger(info.percent) ? info.percent : null;
  if (pct == null) {
    bar.classList.add("is-indeterminate");
    if (fill) fill.style.width = "";
  } else {
    bar.classList.remove("is-indeterminate");
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  if (text) {
    const label = [info.name || info.image || "", info.status, pct != null ? `${pct}%` : ""].filter(Boolean).join(" · ");
    text.textContent = label;
  }
}

function closeKebabs(except) {
  document.querySelectorAll(".kebab-menu").forEach((menu) => {
    if (except && menu === except) return;
    menu.hidden = true;
    const button = menu.parentElement?.querySelector(".kebab");
    if (button) button.setAttribute("aria-expanded", "false");
  });
}

function statusPill(label, kind) {
  const pill = document.createElement("span");
  pill.className = `pill${kind ? ` is-${kind}` : ""}`;
  pill.textContent = label;
  return pill;
}

const SERVICE_LINK_KINDS = ["local", "lan", "tailnet"];

function serviceLinkHostOk(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "127.0.0.1") return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*\.ts\.net$/.test(host);
}

function serviceLinkUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  if (parsed.pathname && parsed.pathname !== "/") return "";
  if (!parsed.port) return "";
  if (!serviceLinkHostOk(parsed.hostname)) return "";
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}/`;
}

function serviceLinksFor(item) {
  const rows = item && Array.isArray(item.links) ? item.links : [];
  const seen = new Set();
  const out = [];
  for (const link of rows) {
    if (!link || typeof link !== "object") continue;
    const url = serviceLinkUrl(link.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const kind = SERVICE_LINK_KINDS.includes(link.kind) ? link.kind : "local";
    const fallback = kind === "local" ? "This computer" : kind === "lan" ? "Home network" : "Tailnet";
    const label = typeof link.label === "string" && link.label.trim() ? link.label.trim().slice(0, 40) : fallback;
    out.push({ kind, label, url, text: url.replace(/^https?:\/\//, "").replace(/\/$/, "") });
  }
  return out;
}

function openServiceLink(raw) {
  const url = serviceLinkUrl(raw);
  if (!url) return;
  if (typeof createTab === "function") createTab();
  if (typeof openUrl === "function") openUrl(url);
}

async function copyServiceLink(button, url) {
  const text = String(url || "").replace(/\/$/, "");
  if (!text) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = label; }, 1200);
}

function renderServiceLinks(links, name) {
  const host = document.createElement("div");
  host.className = "service-links";
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", `Addresses for ${name || "this container"}`);
  for (const link of links) {
    const row = document.createElement("div");
    row.className = "service-link-row";
    const pill = statusPill(link.label, link.kind === "tailnet" ? "tailnet" : (link.kind === "lan" ? "lan" : "running"));
    const anchor = document.createElement("a");
    anchor.className = "service-link";
    anchor.href = link.url;
    anchor.textContent = link.text;
    anchor.title = `Open ${link.text} in a new tab`;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openServiceLink(link.url);
    });
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tiny service-link-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy ${link.text}`);
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      copyServiceLink(copy, link.url);
    });
    row.append(pill, anchor, copy);
    host.append(row);
  }
  return host;
}

function paintJellyfinLinks(items) {
  const host = $("jellyfin-links");
  if (!host || !Array.isArray(items)) return;
  const jellyfin = items.find((item) => item && item.name === "jellyfin");
  const links = jellyfin && jellyfin.state === "running" && !jellyfin.reason ? serviceLinksFor(jellyfin) : [];
  host.replaceChildren();
  host.hidden = !links.length;
  if (links.length) host.append(...renderServiceLinks(links, "Jellyfin").children);
}


function renderContainers(payload) {
  const list = $("container-list");
  const error = $("container-error");
  if (!list || !error || !payload) return;
  if (Object.prototype.hasOwnProperty.call(payload, "currentVersion")
      && !Array.isArray(payload.items)
      && !Array.isArray(payload.shares)
      && !Array.isArray(payload.media)) {
    paintUpdate(payload);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "defaultBrowser")
      && !Array.isArray(payload.items)
      && !Array.isArray(payload.shares)
      && !Array.isArray(payload.media)) {
    paintDefaultBrowser(payload);
    return;
  }
  paintDocker(payload);
  paintDefaultBrowser(payload);
  paintJellyfinGpu(payload);
  if (Array.isArray(payload.items)) {
    lastContainerItems = payload.items;
    paintJellyfinLinks(payload.items);
  }
  paintNetworks(payload);
  launchBusy(false);
  maybeToast(payload);
  if (payload.imagePull && payload.imagePull.status) {
    setProgress("image-pull-bar", "image-pull-bar-fill", "image-pull-progress", payload.imagePull);
  } else if (payload.ok === true || !payload.imagePull) {
    setProgress("image-pull-bar", "image-pull-bar-fill", "image-pull-progress", null);
  }
  error.textContent = payload.ok === false ? (payload.error || "") : "";
  if (payload.notice && payload.ok !== false) {
    const status = $("container-status");
    if (status) status.textContent = payload.notice;
  }
  if (typeof payload.wireguard === "boolean") wireguardModule = payload.wireguard;
  const loadModule = $("load-wireguard");
  if (loadModule) delete loadModule.dataset.busy;
  for (const id of ["endpoint-lan", "endpoint-public", "tailscale-up", "share-publish", "share-enable"]) {
    const button = $(id);
    if (!button) continue;
    delete button.dataset.busy;
    if (id === "share-publish" || id === "share-enable") button.disabled = false;
  }
  paintWireguardSetup();
  paintEndpointChoice(payload.items);
  paintTailscaleSetup(payload);
  paintJellyfinPhone(payload);
  paintMedia(payload);
  paintShares(payload);
  const status = $("container-status");
  if (status && (payload.notice || payload.error)) status.textContent = payload.notice || "";
  if (payload.command && $("container-command")) {
    $("container-command").value = payload.command;
    syncLaunchButtons();
  }
  const logs = $("container-logs");
  if (payload.logs != null) {
    logs.hidden = false;
    logs.textContent = payload.logs.trim() || "No logs.";
  }
  if (payload.qr != null) paintQr(payload.qr);
  document.querySelectorAll("[data-launch]").forEach((button) => {
    button.disabled = false;
  });
  if (!Array.isArray(payload.items)) return;
  const items = payload.items.filter((item) => item && item.name);
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    const note = document.createElement("p");
    note.className = "empty-state";
    note.textContent = "No containers yet. Open Images to run Jellyfin, Tailscale, or another image.";
    empty.append(note);
    list.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const wrap = document.createElement("div");
    wrap.className = "container-row";
    const line = document.createElement("div");
    line.className = "menu-row";
    const title = document.createElement("span");
    title.textContent = item.name;
    const pills = document.createElement("div");
    pills.className = "status-pills";
    const running = item.state === "running";
    const missing = item.state === "missing";
    pills.append(statusPill(running ? "Running" : (missing ? "Not created" : (item.state || "unknown")), running ? "running" : (missing ? "missing" : "stopped")));
    const runtimeLabel = item.runtime === "engine" ? "Engine" : "Desktop";
    pills.append(statusPill(runtimeLabel, item.runtime === "engine" ? "engine" : "desktop"));
    if (item.name === "jellyfin" && running) pills.append(statusPill("Tailnet", "tailnet"));
    if (item.image) {
      const image = statusPill(item.image);
      image.title = item.image;
      pills.append(image);
    }
    line.append(title, pills);
    if (item.reason) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = item.reason;
      line.append(note);
    }
    if (item.name === "jellyfin" && running && !item.reason) {
      line.classList.add("is-share");
      line.tabIndex = 0;
      line.setAttribute("role", "button");
      line.title = "Tailscale IP. Use it as the hostname in the Jellyfin app.";
      line.addEventListener("click", () => openJellyfinConnect());
      line.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openJellyfinConnect();
      });
    }
    if (item.name === "tailscale" && running && !item.reason) {
      line.classList.add("is-share");
      line.tabIndex = 0;
      line.setAttribute("role", "button");
      line.title = "Tailscale IP, sign in, and phone folders";
      line.addEventListener("click", () => openTailscaleShares());
      line.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openTailscaleShares();
      });
    }
    const kebab = document.createElement("button");
    kebab.type = "button";
    kebab.className = "kebab";
    kebab.setAttribute("aria-haspopup", "menu");
    kebab.setAttribute("aria-expanded", "false");
    kebab.setAttribute("aria-label", `Actions for ${item.name}`);
    kebab.textContent = "⋯";
    const menu = document.createElement("div");
    menu.className = "kebab-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    kebab.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = menu.hidden;
      closeKebabs();
      menu.hidden = !willOpen;
      kebab.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
    const actions = [["Command", "command"]];
    const other = item.runtime === "engine" ? "desktop" : "engine";
    const otherLabel = other === "engine" ? "Move to Engine" : "Move to Desktop";
    if (runtimeOk(other)) actions.push([otherLabel, "runtime"]);
    if (running && !item.reason) actions.push(["SSH", "shell"], ["Save image", "commit"], ["Restart", "restart"]);
    actions.push(...(running
      ? [["Stop", "stop"], ["Logs", "logs"]]
      : [["Start", "start"], ["Logs", "logs"], ["Remove", "remove"]]));
    if (running) actions.push(["Recreate", "recreate-prompt"]);
    for (const [label, action] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = label;
      if (action === "remove") button.classList.add("is-danger");
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        closeKebabs();
        if (action === "command") {
          const image = item.image && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,200}$/.test(item.image) && !item.image.includes("..")
            ? item.image
            : "ubuntu:24.04";
          const extra = {};
          if (item.name === "tailscale") {
            extra.vpn = true;
            extra.command = [];
            extra.runtime = item.runtime === "engine" ? "engine" : "desktop";
            extra.network = extra.runtime === "engine" ? "host" : "hog-tailscale";
            extra.env = ["TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"];
            if (extra.runtime !== "engine") {
              extra.sysctls = ["net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1", "net.ipv6.conf.all.forwarding=1"];
            }
          } else if (item.runtime) {
            extra.runtime = item.runtime;
          }
          const advanced = $("container-advanced");
          if (advanced) advanced.open = true;
          fillLaunch(item.name, image, `Command for ${item.name}. Add a port, then Recreate. Docker cannot add a port in place.`, extra);
          showSettingsPage("containers");
          $("container-command")?.focus();
          return;
        }
        if (action === "runtime") {
          const target = item.runtime === "engine" ? "desktop" : "engine";
          const label = target === "engine" ? "Docker Engine" : "Docker Desktop";
          const ok = window.confirm(`Move ${item.name} to ${label}? Hog stops and removes it on the current runtime, then starts it again on ${label}. Login, libraries, and other files kept in that runtime's Docker volumes do not carry over.`);
          if (!ok) return;
          $("container-status").textContent = `Moving ${item.name} to ${label}…`;
          desktopCommand(`containers:runtime-set:${item.name}:${target}`);
          return;
        }
        if (action === "recreate-prompt") {
          const advanced = $("container-advanced");
          if (advanced) advanced.open = true;
          showSettingsPage("containers");
          $("container-status").textContent = `Use Recreate in Advanced to replace ${item.name}.`;
          return;
        }
        if (action === "shell") beginShell(item.name);
        else if (action === "remove" && !window.confirm(`Remove ${item.name}? This deletes that container.`)) return;
        else if (action === "logs") {
          const advanced = $("container-advanced");
          if (advanced) advanced.open = true;
          desktopCommand(`containers:logs:${item.name}`);
        } else {
          if (action === "commit") error.textContent = `Saving ${item.name}:local…`;
          if (action === "remove") error.textContent = `Removing ${item.name}…`;
          desktopCommand(`containers:${action}:${item.name}`);
        }
      });
      menu.append(button);
    }
    wrap.append(line, kebab);
    const links = running && !item.reason ? serviceLinksFor(item) : [];
    if (links.length) li.append(wrap, renderServiceLinks(links, item.name), menu);
    else li.append(wrap, menu);
    list.append(li);
  }

  if (payload.shell) connectShell(payload.shell);
  if (payload.commit) noteCommit(payload.commit);
}
window.__hogContainers = renderContainers;
window.__hogUpdate = paintUpdate;

function syncNetworkActions() {
  const chain = selectedChain();
  const defi = chain === "defi";
  document.querySelectorAll("[data-defi-only]").forEach((node) => {
    node.hidden = !defi;
  });
  document.querySelectorAll("[data-mainnet-only]").forEach((node) => {
    node.hidden = chain !== "mainnet";
  });
  $("go-receive").hidden = defi;
  $("home-actions").classList.toggle("is-quad", defi);
  $("trade-aave").hidden = chain === "bitcoin" || chain === "solana";
}

function renderDisplayPicks() {
  const current = localStorage.getItem(DISPLAY_KEY) || "full";
  document.querySelectorAll("[data-display]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.display === current);
  });
}

let lockTimer = 0;
function scheduleLock() {
  clearTimeout(lockTimer);
  const minutes = Number(localStorage.getItem(LOCK_KEY) || "0");
  if (!session || !minutes) return;
  lockTimer = setTimeout(() => {
    session = null;
    balance = null;
    showSetup();
  }, minutes * 60_000);
}

const SIDE_COPY = "The toolbar icon opens a panel docked on the side of the browser. The Nano connects there.";
const DROP_COPY = "The toolbar icon opens the small menu. Hog keeps the wallet in this side panel.";

function hideSetupForms() {
  for (const id of ["create-name-form", "create-form", "import-form", "phrase-form", "unlock-form", "restore-menu"]) {
    $(id).hidden = true;
  }
  $("restore-limit").hidden = true;
}

function showHub() {
  pendingAccount = null;
  $("new-key").value = "";
  $("hub").hidden = false;
  $("setup-steps").hidden = true;
  hideSetupForms();
  const locked = Boolean(savedRecord());
  $("hub-title").textContent = locked ? "Welcome back" : "Get started";
  $("hub-hint").textContent = locked
    ? "Unlock with passkey or password, or start another path."
    : "Create a wallet locked by a password in this window. A passkey stays in the extension.";
  $("hub-unlock").hidden = !locked;
  $("hub-unlock").classList.toggle("is-primary", locked);
  $("create").classList.toggle("is-primary", !locked);
  $("hub-restore-label").textContent = locked ? "Other restore options" : "I already have a wallet";
  setSetupError("");
}

function showStep(which) {
  $("hub").hidden = true;
  $("setup-steps").hidden = false;
  hideSetupForms();
  const copy = {
    create: ["Create wallet", "Name the wallet. This window creates a private key. A recovery phrase and a Ledger Nano stay in the extension."],
    key: ["Create wallet", "Write this key down. Hog cannot show it again after you set a password."],
    restore: ["Restore wallet", "How do you want to restore access?"],
    import: ["Private key", "Paste the 64-character private key."],
    phrase: ["Recovery phrase", "12 or 24 words. This matches the extension account, including Ethereum, Bitcoin, Hemi, and Solana."],
    unlock: ["Unlock wallet", "This window unlocks with the password. A passkey stays in the extension."],
  };
  $("step-title").textContent = copy[which][0];
  $("step-hint").textContent = copy[which][1];
  if (which === "create") $("create-name-form").hidden = false;
  if (which === "key") $("create-form").hidden = false;
  if (which === "restore") $("restore-menu").hidden = false;
  if (which === "import") $("import-form").hidden = false;
  if (which === "phrase") $("phrase-form").hidden = false;
  if (which === "unlock") $("unlock-form").hidden = false;
  setSetupError("");
}

function setWindowCopy(side) {
  $("mode-side").classList.toggle("is-on", side);
  $("mode-dropdown").classList.toggle("is-on", !side);
  $("mode-side").setAttribute("aria-pressed", side ? "true" : "false");
  $("mode-dropdown").setAttribute("aria-pressed", side ? "false" : "true");
  $("hub-window-copy").textContent = side ? SIDE_COPY : DROP_COPY;
}

function showLimit(text) {
  $("restore-limit").hidden = false;
  $("restore-limit").textContent = text;
}

function showSetup() {
  $("panel-setup").hidden = false;
  $("panel-open").hidden = true;
  $("w-nav").hidden = true;
  showWalletPage("home");
  $("w-title").textContent = localStorage.getItem(NAME_KEY) || "Warthog";
  $("w-addr-short").textContent = "Not unlocked";
  $("evm-line").textContent = "";
  drawIdenticon("");
  const record = savedRecord();
  if (record) {
    $("saved-address").textContent = record.address;
    $("w-addr-short").textContent = shortAddress(record.address);
    drawIdenticon(record.address);
  }
  showHub();
}

function showOpen() {
  $("panel-setup").hidden = true;
  $("panel-open").hidden = false;
  $("w-nav").hidden = false;
  $("w-title").textContent = localStorage.getItem(NAME_KEY) || "Warthog";
  $("account-label").textContent = localStorage.getItem(NAME_KEY) || "Account";
  syncNetworkActions();
  paintChain();
  renderBalance();
  showWalletPage("home");
  clearReview();
  scheduleLock();
}

function formatNative(amount, decimals) {
  const text = formatUnits(amount, decimals);
  const places = localStorage.getItem(DISPLAY_KEY) || "full";
  if (places === "full" || !text.includes(".")) return text;
  const [whole, frac] = text.split(".");
  const cut = frac.slice(0, Number(places)).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

function setRefreshBusy(busy) {
  const button = $("bal-refresh");
  if (!button) return;
  button.disabled = busy;
  $("bal-refresh-mark").textContent = busy ? "…" : "⟳";
  $("bal-refresh-label").textContent = busy ? "Refreshing…" : "Refresh";
}

function holdMark(token) {
  const mark = document.createElement("span");
  mark.className = "net-mark";
  mark.setAttribute("aria-hidden", "true");
  if (token.letter) {
    mark.classList.add("is-letter");
    mark.style.background = token.color;
    mark.textContent = token.letter;
  } else {
    mark.dataset.mark = token.mark || "wart";
  }
  return mark;
}

function holdRow(token, amountText) {
  const row = document.createElement("div");
  row.className = "hold-row";
  const id = document.createElement("div");
  id.className = "hold-id";
  const copy = document.createElement("div");
  const sym = document.createElement("p");
  sym.className = "hold-sym";
  sym.textContent = token.symbol;
  copy.append(sym);
  if (token.name && token.name !== token.symbol) {
    const sub = document.createElement("p");
    sub.className = "hold-sub";
    sub.textContent = token.name;
    copy.append(sub);
  }
  id.append(holdMark(token), copy);
  const amt = document.createElement("p");
  amt.className = "hold-amt";
  amt.textContent = amountText;
  row.append(id, amt);
  return row;
}

function showHolding(token, amount, known) {
  if (token.native) return true;
  if (!known) return false;
  return amount == null || amount !== 0n;
}

function holdingAmountText(row, loading) {
  if (row.amount == null) return loading ? "…" : "—";
  return formatNative(row.amount, row.decimals);
}

function formatUsd(value) {
  if (!(value > 0)) return "";
  const digits = value >= 0.01 ? 2 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function renderBalance() {
  const body = $("bal-body");
  if (!body) return;
  const chain = selectedChain();
  body.replaceChildren();
  if (isWartChain(chain)) {
    const fresh = balance && balance.kind === "wart" && balance.chain === chain;
    body.append(holdRow({ symbol: "WART", mark: "wart" }, fresh ? formatE8(balance.available) : "—"));
    if (fresh && (balance.locked > 0n || balance.mempool > 0n)) {
      const meta = document.createElement("p");
      meta.className = "hold-meta";
      const parts = [];
      if (balance.locked > 0n) parts.push(["Locked", formatE8(balance.locked)]);
      if (balance.mempool > 0n) parts.push(["Pending", formatE8(balance.mempool)]);
      parts.push(["Total", formatE8(balance.total)]);
      parts.forEach((part, index) => {
        if (index) meta.append(" · ");
        meta.append(`${part[0]} `);
        const span = document.createElement("span");
        span.textContent = part[1];
        meta.append(span);
      });
      body.append(meta);
    }
    if (fresh && chain === "mainnet" && wartUsd > 0) {
      const usd = Number(balance.available) / 1e8 * wartUsd;
      const text = formatUsd(usd);
      if (text) {
        const line = document.createElement("p");
        line.className = "hold-usd";
        line.textContent = `≈ ${text} USD`;
        body.append(line);
      }
    }
    return;
  }
  const spec = CHAIN_VIEW[chain];
  const known = Boolean(balance && balance.kind === "native" && balance.chain === chain && !balance.loading);
  const loading = !known;
  const label = document.createElement("div");
  label.className = "hold-label";
  const name = document.createElement("span");
  name.textContent = spec.label;
  label.append(name);
  if (loading) {
    const wait = document.createElement("span");
    wait.className = "hold-wait";
    wait.textContent = "…";
    label.append(wait);
  }
  body.append(label);
  if (known && balance.error) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = balance.error;
    body.append(err);
  }
  const catalog = HOLDINGS[chain] || [];
  const rows = known && Array.isArray(balance.rows) && balance.rows.length
    ? balance.rows
    : catalog.filter((token) => token.native).map((token) => ({
      ...token,
      amount: known && balance.amount != null ? balance.amount : null,
    }));
  for (const row of rows) {
    if (!showHolding(row, row.amount, known && !balance.failed)) continue;
    body.append(holdRow(row, holdingAmountText(row, loading)));
  }
}

function renderActivity(items) {
  const list = $("activity");
  list.replaceChildren();
  $("activity-empty").hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement("li");
    const dir = document.createElement("div");
    dir.className = item.incoming ? "in" : "out";
    dir.textContent = `${item.incoming ? "In" : "Out"} ${item.amount} WART`;
    const meta = document.createElement("div");
    meta.className = "sub";
    meta.textContent = `block ${item.height} · ${(item.peer || "").slice(0, 12)}…`;
    li.append(dir, meta);
    list.append(li);
  }
}

function transfersFrom(data, address) {
  const items = [];
  for (const block of data?.perBlock || []) {
    const moves = block.body?.wartTransfer || [];
    for (const entry of moves) {
      const tx = entry.transaction || entry;
      const to = String(tx.data?.toAddress || "").toLowerCase();
      const from = String(tx.signedCommon?.originAddress || "").toLowerCase();
      if (to !== address && from !== address) continue;
      const amount = tx.data?.amount?.str || formatE8(e8Of(tx.data?.amount));
      items.push({
        height: block.height,
        amount,
        incoming: to === address,
        peer: to === address ? from : to,
      });
    }
  }
  return items.slice(0, 8);
}

async function jsonRpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error || body.result == null) {
    throw new Error(body.error?.message || "The network did not answer.");
  }
  return body.result;
}

async function loadHoldings(chain, address) {
  const tokens = HOLDINGS[chain] || [];
  if (chain === "solana" && !address) {
    return { failed: false, error: "", rows: tokens.filter((token) => token.native).map((token) => ({ ...token, amount: null })) };
  }
  if (chain === "bitcoin") {
    const read = await readNativeBalance(chain, address);
    return {
      failed: false,
      error: "",
      rows: [{ ...tokens[0], amount: read.missing ? null : read.amount }],
    };
  }
  if (chain === "ethereum" || chain === "hemi") {
    const row = EVM_RPC[chain];
    const live = await jsonRpc(row.url, "eth_chainId", []);
    if (BigInt(live) !== row.chainId) throw new Error("That network did not answer as expected.");
    const rows = await Promise.all(tokens.map(async (token) => {
      try {
        const raw = token.native
          ? BigInt(await jsonRpc(row.url, "eth_getBalance", [address, "latest"]))
          : BigInt(await jsonRpc(row.url, "eth_call", [{
            to: token.address,
            data: `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`,
          }, "latest"]));
        return { ...token, amount: raw };
      } catch {
        return { ...token, amount: null };
      }
    }));
    const failed = rows.every((item) => item.amount == null);
    return { failed, error: failed ? `${CHAIN_VIEW[chain].label} balances unavailable` : "", rows };
  }
  const rows = await Promise.all(tokens.map(async (token) => {
    try {
      if (token.native) {
        const read = await readNativeBalance(chain, address);
        return { ...token, amount: read.missing ? null : read.amount };
      }
      const result = await jsonRpc(SOL_RPC, "getTokenAccountsByOwner", [
        address,
        { mint: token.mint },
        { encoding: "jsonParsed" },
      ]);
      let sum = 0n;
      for (const item of result?.value || []) {
        const raw = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (raw) sum += BigInt(raw);
      }
      return { ...token, amount: sum };
    } catch {
      return { ...token, amount: null };
    }
  }));
  const failed = rows.every((item) => item.amount == null);
  return { failed, error: failed ? `${CHAIN_VIEW[chain].label} balances unavailable` : "", rows };
}

async function refreshWartUsd(gen) {
  if (selectedChain() !== "mainnet") return;
  if (wartUsd > 0 && Date.now() - wartUsdAt < 300_000) {
    if (gen === refreshGen) renderBalance();
    return;
  }
  let price = 0;
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=warthog&vs_currencies=usd");
    const data = await response.json();
    price = Number(data?.warthog?.usd);
  } catch {
    price = 0;
  }
  if (!(price > 0)) {
    try {
      const response = await fetch("https://api.coinpaprika.com/v1/tickers/wart-warthog");
      const data = await response.json();
      price = Number(data?.quotes?.USD?.price);
    } catch {
      price = 0;
    }
  }
  if (!(price > 0) || gen !== refreshGen || selectedChain() !== "mainnet") return;
  wartUsd = price;
  wartUsdAt = Date.now();
  renderBalance();
}

async function refreshWallet() {
  if (!session) return;
  const gen = ++refreshGen;
  const chain = selectedChain();
  setRefreshBusy(true);
  setSendError("");
  try {
  if (!isWartChain(chain)) {
    const spec = CHAIN_VIEW[chain];
    $("chain-line").textContent = spec.label;
    balance = { kind: "native", chain, loading: true, failed: false, error: "", rows: [] };
    renderBalance();
    try {
      const loaded = await loadHoldings(chain, activeAddress());
        if (gen !== refreshGen) return;
      const native = loaded.rows.find((row) => row.native);
      balance = {
        kind: "native",
        chain,
        loading: false,
        amount: native?.amount ?? null,
        decimals: native?.decimals ?? 18,
        ...loaded,
      };
    } catch (error) {
      if (gen !== refreshGen) return;
      balance = { kind: "native", chain, loading: false, failed: true, error: error.message, amount: null, rows: [] };
      $("chain-line").textContent = error.message;
    }
    renderBalance();
    renderActivity([]);
    $("activity-empty").hidden = false;
    $("activity-empty").textContent = `${spec.label} transfers are not listed in this window.`;
    await refreshOrders();
    await refreshPending();
    return;
  }
  $("activity-empty").textContent = "No WART transfers on this page of history.";
  $("chain-line").textContent = "Reading the chain…";
  try {
    const head = await nodeGet("chain/head");
    const chain = head.chainHead || head;
    $("chain-line").textContent = `${network().label} · height ${chain.height ?? "?"} · pin ${chain.pinHeight ?? "?"}`;
  } catch (error) {
    $("chain-line").textContent = error.message;
  }
  try {
    let data;
    try {
      data = await nodeGet(`account/${session.address}/wart_balance`);
    } catch {
      data = await nodeGet(`account/${session.address}/balance`);
    }
    if (gen !== refreshGen) return;
    balance = { kind: "wart", chain: networkId(), ...breakdownOf(data) };
    renderBalance();
    void refreshWartUsd(gen);
  } catch (error) {
    if (gen !== refreshGen) return;
    balance = { kind: "wart", chain: networkId(), total: 0n, locked: 0n, mempool: 0n, available: 0n };
    renderBalance();
    setSendError(error.message);
  }
  try {
    const history = await nodeGet(`account/${session.address}/history/4294967295`);
    if (gen !== refreshGen) return;
    renderActivity(transfersFrom(history, session.address));
  } catch {
    if (gen === refreshGen) renderActivity([]);
  }
  await refreshOrders();
  await refreshPending();
  } finally {
    if (gen === refreshGen) setRefreshBusy(false);
  }
}

function ordersFrom(data) {
  const rows = Array.isArray(data) ? data : data?.orders || data?.openOrders || [];
  const items = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const tx = entry.transaction || entry;
    const body = tx.data || entry;
    const txHash = String(entry.txHash || tx.hash || entry.hash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txHash)) continue;
    const isBuy = entry.isBuy === true || body.isBuy === true || String(entry.side || body.side || "").toLowerCase() === "buy";
    items.push({
      txHash,
      side: isBuy ? "Buy" : "Sell",
      amount: body.amount?.str || entry.amount || "?",
      price: body.limit?.doubleAdjusted || body.limit?.hex || body.limit || "—",
    });
  }
  return items.slice(0, 8);
}

function renderOrders(items) {
  const list = $("orders");
  list.replaceChildren();
  $("orders-empty").hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement("li");
    const line = document.createElement("div");
    line.textContent = `${item.side} ${item.amount}`;
    const meta = document.createElement("div");
    meta.className = "sub";
    meta.textContent = `limit ${item.price}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tiny";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelOrder(item));
    li.append(line, meta, cancel);
    list.append(li);
  }
}

function pendingFrom(data) {
  const rows = Array.isArray(data) ? data : data?.entries || data?.transactions || [];
  const items = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const tx = entry.transaction || entry;
    const type = String(entry.type || tx.type || "Pending");
    const hash = String(tx.hash || entry.hash || "");
    items.push({ type, hash });
  }
  return items.slice(0, 8);
}

function renderPending(items) {
  const list = $("pending");
  list.replaceChildren();
  $("pending-empty").hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement("li");
    const line = document.createElement("div");
    line.textContent = item.type;
    const meta = document.createElement("div");
    meta.className = "sub";
    meta.textContent = item.hash ? `${item.hash.slice(0, 16)}…` : "In the mempool";
    li.append(line, meta);
    list.append(li);
  }
}

async function refreshPending() {
  if (!$("pending") || !session || !isWartChain()) {
    if ($("pending")) renderPending([]);
    return;
  }
  try {
    renderPending(pendingFrom(await nodeGet(`account/${session.address}/mempool`)));
  } catch {
    renderPending([]);
  }
}

async function refreshOrders() {
  if (!$("orders")) return;
  $("orders-error").textContent = "";
  if (!session || networkId() !== "defi") {
    renderOrders([]);
    $("orders-empty").hidden = false;
    $("orders-empty").textContent = "Open orders are on the DeFi testnet.";
    return;
  }
  $("orders-empty").textContent = "No open limit orders.";
  try {
    renderOrders(ordersFrom(await nodeGet(`account/${session.address}/open_orders`)));
  } catch {
    renderOrders([]);
  }
}

async function liveBalance() {
  const data = await nodeGet(`account/${session.address}/wart_balance`).catch(() =>
    nodeGet(`account/${session.address}/balance`),
  );
  balance = { kind: "wart", chain: networkId(), ...breakdownOf(data) };
  renderBalance();
  return balance;
}

async function cancelOrder(item) {
  if (!session) return;
  $("orders-error").textContent = "";
  try {
    const lookup = await nodeGet(`transaction/lookup/${item.txHash}`);
    const signed = lookup?.transaction?.signedCommon || lookup?.signedCommon || {};
    if (signed.pinHeight == null || signed.nonceId == null) {
      throw new Error("That order has no pin to cancel");
    }
    const feeText = "0.001";
    const fee = await roundedFeeE8(feeText);
    const live = await liveBalance();
    if (fee > live.available) throw new Error(insufficientMessage(live));
    const head = await nodeGet("chain/head");
    const chain = head.chainHead || head;
    const tx = signCancel({
      privateKey: session.privateKey,
      pinHash: chain.pinHash,
      pinHeight: chain.pinHeight,
      nonceId: crypto.getRandomValues(new Uint32Array(1))[0],
      feeE8: fee,
      cancelHeight: signed.pinHeight,
      cancelNonceId: signed.nonceId,
    });
    const result = await nodePost("transaction/add", tx);
    $("orders-error").textContent = `Cancel submitted ${result?.txHash || result?.hash || ""}`.trim();
    await refreshWallet();
  } catch (error) {
    $("orders-error").textContent = error.message;
  }
}

const marketReview = {};

async function reviewMarket(event, spec) {
  event.preventDefault();
  if (!session) return;
  $(spec.error).textContent = "";
  if (networkId() !== "defi") {
    $(spec.error).textContent = "This action is on the DeFi testnet.";
    return;
  }
  let built;
  try {
    built = await spec.build();
  } catch (error) {
    marketReview[spec.id] = null;
    $(spec.review).hidden = true;
    $(spec.button).textContent = spec.reviewLabel;
    $(spec.error).textContent = error.message;
    return;
  }
  if (!marketReview[spec.id]) {
    marketReview[spec.id] = built;
    $(spec.review).hidden = false;
    $(spec.review).textContent = built.summary;
    $(spec.button).textContent = spec.sendLabel;
    return;
  }
  try {
    const fee = await roundedFeeE8(built.feeText);
    const live = await liveBalance();
    if (built.wartSpend + fee > live.available) throw new Error(insufficientMessage(live));
    const head = await nodeGet("chain/head");
    const chain = head.chainHead || head;
    if (!chain.pinHash || chain.pinHeight == null) throw new Error("Chain head is missing a pin");
    if (built.guard) await built.guard();
    const tx = built.sign({
      pinHash: chain.pinHash,
      pinHeight: chain.pinHeight,
      nonceId: crypto.getRandomValues(new Uint32Array(1))[0],
      feeE8: fee,
    });
    const result = await nodePost("transaction/add", tx);
    $(spec.review).hidden = false;
    $(spec.review).textContent = `Submitted ${result?.txHash || result?.hash || "submitted"}`;
    $(spec.button).textContent = spec.reviewLabel;
    marketReview[spec.id] = null;
    if (spec.id === "swap") celebrateWallet();
    await refreshWallet();
  } catch (error) {
    marketReview[spec.id] = null;
    $(spec.review).hidden = true;
    $(spec.button).textContent = spec.reviewLabel;
    $(spec.error).textContent = error.message;
  }
}

function assetHashFrom(value) {
  const clean = String(value || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Enter an asset hash, or find one by name.");
  return clean;
}

function assetsFrom(data) {
  const rows = Array.isArray(data)
    ? data
    : data?.assets || data?.matches || data?.asset || (data && (data.hash || data.assetHash) ? [data] : []);
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .map((row) => ({
      hash: String(row.hash || row.assetHash || row.asset || "").replace(/^0x/i, "").toLowerCase(),
      name: row.name || row.token?.name || "Asset",
      decimals: Number(row.decimals ?? row.token?.decimals ?? 8),
    }))
    .filter((row) => /^[0-9a-f]{64}$/.test(row.hash));
}

function parseUnits(input, decimals) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) return null;
  const text = String(input ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > places) return null;
  const scale = 10n ** BigInt(places);
  const padded = (frac + "0".repeat(places)).slice(0, places);
  return BigInt(whole) * scale + (places ? BigInt(padded) : 0n);
}

function formatUnits(value, decimals) {
  const places = Number(decimals);
  const raw = BigInt(value);
  const scale = 10n ** BigInt(places || 0);
  const whole = raw / scale;
  if (!places) return whole.toString();
  const frac = (raw % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function decimalsField(id) {
  const decimals = Number($(id).value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Decimals must be a whole number from 0 to 18");
  }
  return decimals;
}

function requireFee(id) {
  const feeText = $(id).value.trim();
  const parsed = parseWartToE8(feeText);
  if (parsed == null || parsed <= 0n) throw new Error("Enter a fee greater than 0");
  return feeText;
}

function rawUnits(value, decimals) {
  if (value == null) return 0n;
  if (typeof value === "object") {
    if (value.u64 != null || value.E8 != null || value.amount != null) return e8Of(value);
    if (value.str != null) return parseUnits(String(value.str), decimals) ?? 0n;
    return 0n;
  }
  if (typeof value === "string" || typeof value === "number") return parseUnits(String(value), decimals) ?? 0n;
  return 0n;
}

function tokenShort(live, label) {
  const locked = live.locked + live.mempool;
  return `Only ${formatUnits(live.available, live.decimals)} ${label} free; ${formatUnits(locked, live.decimals)} locked in open orders.`;
}

async function assetBalance(hash, decimals) {
  let data;
  try {
    data = await nodeGet(`account/${session.address}/balance/${hash}`);
  } catch (error) {
    if (/not found|unknown account|does not exist|code 56/i.test(error.message)) {
      return { total: 0n, locked: 0n, mempool: 0n, available: 0n, decimals, name: "tokens" };
    }
    throw error;
  }
  const token = data?.token || {};
  const places = Number.isInteger(token.decimals) ? token.decimals : decimals;
  const box = data?.balance && typeof data.balance === "object" ? data.balance : data?.balance ?? data;
  const total = rawUnits(box?.total ?? box, places);
  const locked = rawUnits(box?.locked, places);
  const mempool = rawUnits(box?.mempool, places);
  const spent = locked + mempool;
  return {
    total,
    locked,
    mempool,
    available: total > spent ? total - spent : 0n,
    decimals: places,
    name: token.name || "tokens",
  };
}

let swapAsset = null;

function selectedSwapAsset() {
  const query = $("swap-query").value.trim();
  const hash = query.replace(/^0x/i, "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hash)) {
    const known = swapAsset && swapAsset.hash === hash ? swapAsset : null;
    return {
      hash,
      name: known?.name || "Asset",
      decimals: known?.decimals ?? decimalsField("swap-decimals"),
    };
  }
  if (swapAsset) return swapAsset;
  throw new Error("Enter an asset hash, or find one by name.");
}

function rememberAsset(row) {
  swapAsset = row;
  $("swap-query").value = row.hash;
  $("swap-decimals").value = String(row.decimals);
  marketReview.swap = null;
  $("swap-review").hidden = true;
  $("swap-button").textContent = "Review swap";
}

async function findSwapAssets() {
  $("swap-error").textContent = "";
  const hits = $("swap-hits");
  hits.replaceChildren();
  const raw = $("swap-query").value.trim();
  try {
    let rows;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
      const hash = raw.replace(/^0x/i, "").toLowerCase();
      const data = await nodeGet(`asset/lookup/${hash}`);
      rows = assetsFrom(data);
      if (!rows.length) {
        const token = data?.token || data?.asset || data || {};
        rows = [{
          hash,
          name: token.name || "Asset",
          decimals: Number(token.decimals ?? 8),
        }];
      }
    } else {
      const prefix = raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 5);
      rows = assetsFrom(await nodeGet(`asset/complete?namePrefix=${prefix}`));
    }
    if (!rows.length) {
      $("swap-error").textContent = "No assets matched.";
      return;
    }
    for (const row of rows.slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${row.name} · ${row.hash.slice(0, 8)}`;
      button.addEventListener("click", () => rememberAsset(row));
      hits.append(button);
    }
  } catch (error) {
    $("swap-error").textContent = error.message;
  }
}

async function fillSwapMax() {
  $("swap-error").textContent = "";
  try {
    const buying = $("swap-side").value !== "sell";
    if (buying) {
      const live = await liveBalance();
      const fee = await roundedFeeE8($("swap-fee").value || "0.001");
      const room = live.available > fee ? live.available - fee : 0n;
      $("swap-amount").value = formatE8(room);
    } else {
      const asset = selectedSwapAsset();
      const live = await assetBalance(asset.hash, decimalsField("swap-decimals"));
      $("swap-amount").value = formatUnits(live.available, live.decimals);
    }
    marketReview.swap = null;
    $("swap-review").hidden = true;
    $("swap-button").textContent = "Review swap";
  } catch (error) {
    $("swap-error").textContent = error.message;
  }
}

const DRY = {
  pinHash: "22".repeat(32),
  pinHeight: 1,
  nonceId: 1,
  feeE8: 100000n,
};

function swapSpec() {
  return {
    id: "swap",
    error: "swap-error",
    review: "swap-review",
    button: "swap-button",
    reviewLabel: "Review swap",
    sendLabel: "Place order",
    async build() {
      const asset = selectedSwapAsset();
      const decimals = decimalsField("swap-decimals");
      const isBuy = $("swap-side").value !== "sell";
      const amountText = $("swap-amount").value.trim();
      const amountRaw = parseUnits(amountText, isBuy ? 8 : decimals);
      if (amountRaw == null || amountRaw <= 0n) throw new Error("Enter an amount greater than 0");
      const price = $("swap-price").value.trim();
      if (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) throw new Error("Enter a limit price greater than 0");
      const feeText = requireFee("swap-fee");
      const feeE8 = parseWartToE8(feeText);
      let wartSpend = 0n;
      const wartLive = await liveBalance();
      if (isBuy) {
        const wart = parseWartToE8(amountText);
        if (wart == null) throw new Error("Enter a WART amount with at most 8 decimals");
        wartSpend = wart;
        if (wart + feeE8 > wartLive.available) throw new Error(insufficientMessage(wartLive));
      } else if (feeE8 > wartLive.available) {
        throw new Error(insufficientMessage(wartLive));
      } else {
        const live = await assetBalance(asset.hash, decimals);
        if (amountRaw > live.available) throw new Error(tokenShort(live, live.name || asset.name));
      }
      const signed = signLimitSwap({
        privateKey: session.privateKey,
        ...DRY,
        assetHash: asset.hash,
        isBuy,
        amount: amountText,
        limitPrice: price,
        decimals,
      });
      if (!signed.signature65) throw new Error("Could not build this order");
      const side = isBuy ? "Buy" : "Sell";
      const unit = isBuy ? "WART" : asset.name;
      return {
        summary: `${side} ${amountText} ${unit} at ${price} WART. Fee ${feeText} WART.`,
        feeText,
        wartSpend,
        guard: isBuy
          ? null
          : async () => {
            const live = await assetBalance(asset.hash, decimals);
            if (amountRaw > live.available) throw new Error(tokenShort(live, live.name || asset.name));
          },
        sign(ctx) {
          return signLimitSwap({
            privateKey: session.privateKey,
            ...ctx,
            assetHash: asset.hash,
            isBuy,
            amount: amountText,
            limitPrice: price,
            decimals,
          });
        },
      };
    },
  };
}

function depositSpec() {
  return {
    id: "deposit",
    error: "liq-error",
    review: "liq-review",
    button: "liq-button",
    reviewLabel: "Review deposit",
    sendLabel: "Deposit",
    async build() {
      const hash = assetHashFrom($("liq-asset").value);
      const decimals = decimalsField("liq-decimals");
      const assetText = $("liq-asset-amount").value.trim();
      const wartText = $("liq-wart").value.trim();
      const assetRaw = parseUnits(assetText, decimals);
      const wart = parseWartToE8(wartText);
      if (assetRaw == null || assetRaw <= 0n) throw new Error("Enter an asset amount greater than 0");
      if (wart == null || wart <= 0n) throw new Error("Enter a WART amount greater than 0, with at most 8 decimals");
      const feeText = requireFee("liq-fee");
      const live = await liveBalance();
      if (wart + parseWartToE8(feeText) > live.available) throw new Error(insufficientMessage(live));
      const tokens = await assetBalance(hash, decimals);
      if (assetRaw > tokens.available) throw new Error(tokenShort(tokens, tokens.name));
      const signed = signLiquidityDeposit({
        privateKey: session.privateKey,
        ...DRY,
        assetHash: hash,
        assetAmount: assetText,
        wartAmount: wartText,
        decimals,
      });
      if (!signed.signature65) throw new Error("Could not build this deposit");
      return {
        summary: `Deposit ${assetText} ${tokens.name} and ${wartText} WART. Fee ${feeText} WART.`,
        feeText,
        wartSpend: wart,
        guard: async () => {
          const again = await assetBalance(hash, decimals);
          if (assetRaw > again.available) throw new Error(tokenShort(again, again.name));
        },
        sign(ctx) {
          return signLiquidityDeposit({
            privateKey: session.privateKey,
            ...ctx,
            assetHash: hash,
            assetAmount: assetText,
            wartAmount: wartText,
            decimals,
          });
        },
      };
    },
  };
}

function withdrawSpec() {
  return {
    id: "withdraw",
    error: "liq-out-error",
    review: "liq-out-review",
    button: "liq-out-button",
    reviewLabel: "Review withdrawal",
    sendLabel: "Withdraw",
    async build() {
      const hash = assetHashFrom($("liq-asset").value);
      const shares = $("liq-shares").value.trim();
      if (parseWartToE8(shares) == null || parseWartToE8(shares) <= 0n) {
        throw new Error("Enter LP shares greater than 0, with at most 8 decimals");
      }
      const feeText = requireFee("liq-fee");
      const wartLive = await liveBalance();
      if (parseWartToE8(feeText) > wartLive.available) throw new Error(insufficientMessage(wartLive));
      const signed = signLiquidityWithdraw({
        privateKey: session.privateKey,
        ...DRY,
        assetHash: hash,
        shares,
      });
      if (!signed.signature65) throw new Error("Could not build this withdrawal");
      return {
        summary: `Withdraw ${shares} LP shares. Fee ${feeText} WART.`,
        feeText,
        wartSpend: 0n,
        sign(ctx) {
          return signLiquidityWithdraw({
            privateKey: session.privateKey,
            ...ctx,
            assetHash: hash,
            shares,
          });
        },
      };
    },
  };
}

function mintSpec() {
  return {
    id: "mint",
    error: "mint-error",
    review: "mint-review",
    button: "mint-button",
    reviewLabel: "Review mint",
    sendLabel: "Mint asset",
    async build() {
      const name = $("mint-name").value.trim();
      if (!/^[\x20-\x7e]{1,5}$/.test(name)) throw new Error("Asset name must be 1 to 5 characters");
      const decimals = decimalsField("mint-decimals");
      const supply = $("mint-supply").value.trim();
      if (parseUnits(supply, decimals) == null || parseUnits(supply, decimals) <= 0n) {
        throw new Error("Enter a total supply greater than 0");
      }
      const feeText = requireFee("mint-fee");
      const wartLive = await liveBalance();
      if (parseWartToE8(feeText) > wartLive.available) throw new Error(insufficientMessage(wartLive));
      const signed = signAssetCreation({
        privateKey: session.privateKey,
        ...DRY,
        name,
        supply,
        decimals,
      });
      if (!signed.signature65) throw new Error("Could not build this mint");
      return {
        summary: `Mint ${supply} ${name} with ${decimals} decimals. Fee ${feeText} WART.`,
        feeText,
        wartSpend: 0n,
        sign(ctx) {
          return signAssetCreation({
            privateKey: session.privateKey,
            ...ctx,
            name,
            supply,
            decimals,
          });
        },
      };
    },
  };
}

function armMarketReset(id, reviewId, buttonId, label, fields) {
  const reset = () => {
    marketReview[id] = null;
    $(reviewId).hidden = true;
    $(buttonId).textContent = label;
  };
  for (const field of fields) {
    $(field).addEventListener("input", reset);
    $(field).addEventListener("change", reset);
  }
}

function clearReview() {
  reviewing = false;
  $("send-review").hidden = true;
  $("send-button").textContent = "Review send";
}

async function roundedFeeE8(feeText) {
  const parsed = parseWartToE8(feeText);
  if (parsed == null || parsed <= 0n) throw new Error("Enter a fee greater than 0");
  const data = await nodeGet(`tools/encode16bit/from_string/${feeText.trim()}`);
  const rounded = data.roundedE8 ?? data.rounded?.E8;
  if (rounded == null) throw new Error("The node did not return a rounded fee");
  return BigInt(rounded);
}

function insufficientMessage(live) {
  const locked = live.locked + live.mempool;
  return `Only ${formatE8(live.available)} free; ${formatE8(locked)} locked in open orders.`;
}

async function reviewOrSendEvm(event, chain) {
  event.preventDefault();
  if (!session) return;
  setSendError("");
  const to = $("send-to").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    setSendError("That recipient is not an Ethereum address.");
    clearReview();
    return;
  }
  const amount = parseUnits($("send-amount").value, 18);
  if (amount == null || amount <= 0n) {
    setSendError("Enter an amount greater than 0.");
    clearReview();
    return;
  }
  const spec = CHAIN_VIEW[chain];
  let live;
  let reserve;
  try {
    live = await readNativeBalance(chain, session.evmAddress);
    reserve = await evmTransferReserve(chain);
    const rows = balance?.chain === chain && Array.isArray(balance.rows)
      ? balance.rows.map((row) => (row.native ? { ...row, amount: live.amount } : row))
      : undefined;
    balance = { kind: "native", chain, ...live, rows };
    renderBalance();
  } catch (error) {
    setSendError(error.message);
    clearReview();
    return;
  }
  if (amount + reserve > live.amount) {
    const room = live.amount > reserve ? live.amount - reserve : 0n;
    $("send-amount").value = formatNative(room, 18);
    setSendError(`Only ${formatNative(live.amount, 18)} ${spec.symbol} available, and the network fee is extra.`);
    clearReview();
    return;
  }
  if (!reviewing) {
    reviewing = true;
    $("send-review").hidden = false;
    $("send-review").textContent = `Send ${formatNative(amount, 18)} ${spec.symbol} to ${to} on ${spec.label}. The network fee is extra.`;
    $("send-button").textContent = `Send ${spec.symbol}`;
    return;
  }
  try {
    const hash = await sendNativeEvm({
      privateKey: session.evmKey,
      to,
      amount,
      chain,
    });
    $("send-review").hidden = false;
    $("send-review").textContent = `Submitted ${hash}`;
    $("send-to").value = "";
    $("send-amount").value = "";
    reviewing = false;
    $("send-button").textContent = "Review send";
    await refreshWallet();
  } catch (error) {
    setSendError(error.message);
    clearReview();
  }
}

async function reviewOrSend(event) {
  const chain = selectedChain();
  if (chain === "ethereum" || chain === "hemi") return reviewOrSendEvm(event, chain);
  event.preventDefault();
  if (!session || !isWartChain(chain)) return;
  setSendError("");
  const to = $("send-to").value.trim().replace(/^0x/i, "").toLowerCase();
  if (!validateAddress(to)) {
    setSendError("That recipient address is not a valid Warthog address.");
    clearReview();
    return;
  }
  const amount = parseWartToE8($("send-amount").value);
  if (amount == null || amount <= 0n) {
    setSendError("Enter an amount greater than 0, with at most 8 decimals.");
    clearReview();
    return;
  }
  let fee;
  try {
    fee = await roundedFeeE8($("send-fee").value);
  } catch (error) {
    setSendError(error.message);
    clearReview();
    return;
  }
  let live;
  try {
    const data = await nodeGet(`account/${session.address}/wart_balance`).catch(() =>
      nodeGet(`account/${session.address}/balance`),
    );
    live = { kind: "wart", chain: networkId(), ...breakdownOf(data) };
    balance = live;
    renderBalance();
  } catch (error) {
    setSendError(error.message);
    clearReview();
    return;
  }
  if (amount + fee > live.available) {
    const room = live.available > fee ? live.available - fee : 0n;
    $("send-amount").value = formatE8(room);
    setSendError(insufficientMessage(live));
    clearReview();
    return;
  }
  if (!reviewing) {
    reviewing = true;
    const review = $("send-review");
    review.hidden = false;
    review.textContent = `Send ${formatE8(amount)} WART to ${to} on ${network().label}. Fee ${formatE8(fee)} WART.`;
    $("send-button").textContent = "Send WART";
    return;
  }
  try {
    const head = await nodeGet("chain/head");
    const chain = head.chainHead || head;
    if (!chain.pinHash || chain.pinHeight == null) {
      throw new Error("Chain head is missing a pin");
    }
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
    const tx = signWartTransfer({
      privateKey: session.privateKey,
      pinHash: chain.pinHash,
      pinHeight: chain.pinHeight,
      nonceId: nonce,
      feeE8: fee,
      toAddr: to,
      amountE8: amount,
      network: networkId(),
    });
    const result = await nodePost("transaction/add", tx);
    const hash = result?.txHash || result?.hash || "submitted";
    $("send-review").hidden = false;
    $("send-review").textContent = `Submitted ${hash}`;
    $("send-to").value = "";
    $("send-amount").value = "";
    reviewing = false;
    $("send-button").textContent = "Review send";
    celebrateWallet();
    await refreshWallet();
  } catch (error) {
    setSendError(error.message);
    clearReview();
  }
}

async function fillMax() {
  if (!session) return;
  setSendError("");
  const chain = selectedChain();
  try {
    if (chain === "ethereum" || chain === "hemi") {
      if (!balance || balance.chain !== chain) await refreshWallet();
      const reserve = await evmTransferReserve(chain);
      const have = balance && balance.kind === "native" ? balance.amount : 0n;
      const room = have > reserve ? have - reserve : 0n;
      $("send-amount").value = formatNative(room, 18);
      clearReview();
      return;
    }
    if (!isWartChain(chain)) return;
    if (!balance) await refreshWallet();
    const fee = await roundedFeeE8($("send-fee").value || "0.001");
    const room = balance && balance.available > fee ? balance.available - fee : 0n;
    $("send-amount").value = formatE8(room);
    clearReview();
  } catch (error) {
    setSendError(error.message);
  }
}

async function saveAccount(account, password) {
  const sealed = await sealKey(account.privateKey, password);
  const record = { ...sealed, address: account.address };
  if (account.phrase) record.phrase = await sealKey(account.phrase, password);
  localStorage.setItem(STORE, JSON.stringify(record));
  startSession(account);
  pendingAccount = null;
  showOpen();
  await refreshWallet();
}

function forgetWallet() {
  const ok = window.confirm(
    "Forget this wallet in Hog? The coins stay on the chain. You will need the private key to open them again.",
  );
  if (!ok) return;
  for (const origin of Object.keys(readSites())) {
    desktopCommand(`dapp-emit:${JSON.stringify({ origin, event: "accountsChanged", payload: [] })}`);
  }
  localStorage.removeItem(SITES_KEY);
  localStorage.removeItem(STORE);
  finishDapp(false);
  session = null;
  balance = null;
  setSetupError("");
  showSetup();
}

async function copyAddress(label, restore) {
  const value = activeAddress();
  if (!session || !value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  label.textContent = "Copied";
  setTimeout(() => {
    if (session) label.textContent = restore();
  }, 1200);
}

function onShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "t") {
    event.preventDefault();
    createTab();
    addressInput.focus();
  } else if (key === "w") {
    event.preventDefault();
    closeTab(activeId);
  } else if (key === "l") {
    event.preventDefault();
    addressInput.focus();
    addressInput.select();
  } else if (key === "d" && !event.shiftKey) {
    event.preventDefault();
    toggleBookmark();
  } else if (key === "o" && event.shiftKey) {
    event.preventDefault();
    showBookmarksView();
  } else if (key === "h") {
    event.preventDefault();
    togglePopover("history-panel", "history-btn");
  } else if (key === "tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  } else if (key === "+" || key === "=") {
    event.preventDefault();
    setZoom((activeTab()?.zoom || 1) + 0.1);
  } else if (key === "-" || key === "_") {
    event.preventDefault();
    setZoom((activeTab()?.zoom || 1) - 0.1);
  } else if (key === "0") {
    event.preventDefault();
    setZoom(1);
  }
}

function desktopCommand(command) {
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (handlers && handlers.hogwin) handlers.hogwin.postMessage(command);
}

let lastViewCommand = "";

// The page webview covers #view on every site. A menu that drops into that
// hole is drawn again inside the page, or the site hides it.
const PAGE_MENUS = [
  { id: "suggestions", kind: "suggestions" },
  { id: "history-panel", kind: "history" },
  { id: "settings-menu", kind: "settings" },
];

function openMenuElements() {
  return PAGE_MENUS
    .map((entry) => ({ ...entry, el: $(entry.id) }))
    .filter((entry) => entry.el && !entry.el.hidden);
}

let lastMenuCommand = "";

function menuItems(kind) {
  if (kind === "history") {
    const buttons = [...$("history-list").querySelectorAll("button")];
    if (!buttons.length) {
      const note = $("history-list").textContent.trim() || "No pages yet.";
      return [{ title: note, sub: "", inert: true }];
    }
    return buttons.map((button) => ({
      title: button.querySelector("span")?.textContent || "",
      sub: button.querySelector("small")?.textContent || "",
    }));
  }
  if (kind === "settings") {
    return [...$("settings-menu").querySelectorAll("[data-settings]")].map((button) => ({
      title: button.querySelector("span")?.textContent || "",
      sub: button.querySelector("small")?.textContent || "",
      accent: button.dataset.settings === "files" || button.dataset.settings === "tailscale"
        ? "flare"
        : button.dataset.settings === "general"
          ? "gold"
          : "amber",
      current: button.getAttribute("aria-current") === "page",
    }));
  }
  return [...$("suggestions").querySelectorAll("button")].map((button) => ({
    title: button.querySelector("span")?.textContent || "",
    sub: button.querySelector("small")?.textContent || "",
  }));
}

function publishMenu() {
  if (!desktopOn()) return;
  const open = nativePageUp() ? openMenuElements() : [];
  if (!open.length) {
    if (lastMenuCommand === "menu:hide") return;
    lastMenuCommand = "menu:hide";
    desktopCommand(lastMenuCommand);
    return;
  }
  const page = $("view").getBoundingClientRect();
  const menus = open.map((entry) => {
    const rect = entry.el.getBoundingClientRect();
    return {
      kind: entry.kind,
      x: Math.round(rect.left - page.left),
      y: Math.round(rect.top - page.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      items: menuItems(entry.kind),
    };
  }).filter((menu) => menu.w > 2 && menu.h > 2 && menu.y + menu.h > 0);
  const command = menus.length ? `menu:${JSON.stringify({ menus })}` : "menu:hide";
  if (command === lastMenuCommand) return;
  lastMenuCommand = command;
  desktopCommand(command);
}

window.__hogMenuDismiss = () => {
  hideSuggestions();
  closePopovers();
};
window.__hogMenuClear = () => {
  $("clear-history").click();
};
window.__hogMenuActivate = (kind, index) => {
  if (kind === "settings") {
    const button = document.querySelectorAll("#settings-menu [data-settings]")[index];
    button?.click();
    return;
  }
  const root = document.getElementById(kind === "history" ? "history-list" : "suggestions");
  const button = root?.querySelectorAll("button")[index];
  if (!button) return;
  if (kind === "suggestions") {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return;
  }
  button.click();
};

function reportView(showPage) {
  if (!desktopOn()) return;
  const rect = $("view").getBoundingClientRect();
  let left = Math.max(0, Math.round(rect.left));
  let top = Math.max(0, Math.round(rect.top));
  let right = Math.max(0, Math.round(window.innerWidth - rect.right));
  let bottom = Math.max(0, Math.round(window.innerHeight - rect.bottom));
  const tab = activeTab();
  const show = showPage === true && isNativeTab(tab) && tab.url && !tab.status;
  const command = `view:${left}:${top}:${right}:${bottom}:${show ? 1 : 0}:${show ? tab.id : ""}`;
  if (command !== lastViewCommand) {
    lastViewCommand = command;
    desktopCommand(command);
  }
  publishEdges();
  publishMenu();
}

function syncPageView() {
  if (!desktopOn()) return;
  const tab = activeTab();
  const show = Boolean(tab && isNativeTab(tab) && tab.url && !tab.status && pageSurfaceClear());
  reportView(show);
  requestAnimationFrame(() => reportView(show));
}

function trackView() {
  if (!desktopOn()) return;
  const start = performance.now();
  const step = (now) => {
    const tab = activeTab();
    reportView(Boolean(tab && isNativeTab(tab) && tab.url && !tab.status && pageSurfaceClear()));
    if (now - start < 280) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

window.__hogPage = onPageMessage;

function reportGrip() {
  const grip = $("win-drag");
  if (!grip || grip.hidden) return;
  const rect = grip.getBoundingClientRect();
  desktopCommand(`grip:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`);
}

function bindDesktop() {
  if (!window.__hogDesktop) return;
  $("win-drag").hidden = false;
  $("winctl").hidden = false;
  $("win-min").addEventListener("click", () => desktopCommand("min"));
  $("win-max").addEventListener("click", () => desktopCommand("max"));
  $("win-close").addEventListener("click", () => desktopCommand("close"));
  $("resize-frame").hidden = false;
  reportGrip();
  window.addEventListener("resize", () => {
    reportGrip();
    hideEdgePill();
    trackView();
  });
  wallet.addEventListener("transitionend", () => trackView());
  document.querySelector(".pane")?.addEventListener("transitionend", () => trackView());
  $("tabbar").addEventListener("transitionend", (event) => {
    if (event.target === $("tabbar") && event.propertyName === "width") trackView();
  });
}

function readSites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SITES_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSites(sites) {
  localStorage.setItem(SITES_KEY, JSON.stringify(sites));
}

function siteRecord(origin) {
  const row = readSites()[origin];
  const fallback = selectedChain() === "hemi" ? "0xa867" : "0x1";
  if (!row || typeof row !== "object") return { chain: fallback, connected: false };
  return { chain: CHAINS[row.chain] ? row.chain : "0x1", connected: !!row.connected };
}

function applyWalletChainToSites() {
  const key = CHAIN_VIEW[selectedChain()].chainKey;
  if (!key) return;
  const sites = readSites();
  let changed = false;
  for (const origin of Object.keys(sites)) {
    const row = sites[origin];
    if (!row || !row.connected || row.chain === key) continue;
    sites[origin] = { ...row, chain: key };
    emitDapp(origin, "chainChanged", key);
    changed = true;
  }
  if (changed) writeSites(sites);
}

function renderSites() {
  const list = $("site-list");
  const empty = $("site-empty");
  const sites = readSites();
  list.replaceChildren();
  const origins = Object.keys(sites).filter((origin) => sites[origin] && sites[origin].connected);
  empty.hidden = origins.length > 0;
  $("site-address").textContent = session && session.evmAddress ? session.evmAddress : "";
  for (const origin of origins) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    const chain = CHAINS[sites[origin].chain];
    name.textContent = `${origin.replace(/^https?:\/\//, "")} · ${chain ? chain.name : "Ethereum"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tiny";
    button.dataset.origin = origin;
    button.textContent = "Disconnect";
    row.append(name, button);
    list.append(row);
  }
}

function disconnectSite(origin) {
  const sites = readSites();
  if (sites[origin]) sites[origin].connected = false;
  writeSites(sites);
  renderSites();
  desktopCommand(`dapp-emit:${JSON.stringify({ origin, event: "accountsChanged", payload: [] })}`);
}

let dappWait = null;
const dappQueue = [];
let dappBusy = false;

function askDapp(prompt) {
  return new Promise((resolve) => {
    dappWait = resolve;
    $("dapp-title").textContent = prompt.title;
    $("dapp-origin").textContent = prompt.body;
    const lines = $("dapp-lines");
    lines.replaceChildren();
    for (const line of prompt.lines || []) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("b");
      label.textContent = line.label;
      value.textContent = line.value;
      row.append(label, value);
      lines.append(row);
    }
    $("dapp-sure").checked = false;
    $("dapp-sure-row").hidden = !prompt.sure;
    $("dapp-ok").textContent = prompt.confirm || "Approve";
    $("dapp-ok").disabled = !!prompt.sure;
    $("dapp-sheet").hidden = false;
    if (wallet.classList.contains("is-hidden")) setWalletOpen(true);
  });
}

function finishDapp(ok) {
  const resolve = dappWait;
  dappWait = null;
  $("dapp-sheet").hidden = true;
  if (resolve) resolve(!!ok);
}

function replyDapp(request, ok, payload) {
  desktopCommand(`dapp-reply:${JSON.stringify({
    tab: request.tab,
    id: request.id,
    ok: !!ok,
    payload,
  })}`);
}

function emitDapp(origin, event, payload) {
  desktopCommand(`dapp-emit:${JSON.stringify({ origin, event, payload })}`);
}

async function handleDapp(request) {
  if (!request || typeof request.origin !== "string" || typeof request.method !== "string") return;
  if (!session || !session.evmAddress) {
    if (wallet.classList.contains("is-hidden")) setWalletOpen(true);
    replyDapp(request, false, { code: 4100, message: "Unlock the wallet first." });
    return;
  }
  const record = siteRecord(request.origin);
  try {
    const answer = await answerDappRequest({
      method: request.method,
      params: request.params,
      origin: request.origin,
      address: session.evmAddress,
      privateKey: session.evmKey || session.privateKey,
      chain: record.chain,
      connected: record.connected,
      ask: askDapp,
    });
    const sites = readSites();
    const next = sites[request.origin] && typeof sites[request.origin] === "object" ? sites[request.origin] : {};
    if (answer.chainKey && CHAINS[answer.chainKey]) next.chain = answer.chainKey;
    if (answer.connect) next.connected = true;
    if (answer.disconnect) next.connected = false;
    if (answer.connect || answer.disconnect || answer.chainKey) {
      sites[request.origin] = next;
      writeSites(sites);
    }
    if (answer.connect) {
      emitDapp(request.origin, "accountsChanged", [session.evmAddress]);
      emitDapp(request.origin, "chainChanged", next.chain || record.chain);
    } else if (answer.disconnect) {
      emitDapp(request.origin, "accountsChanged", []);
    } else if (answer.chainKey && answer.chainKey !== record.chain) {
      emitDapp(request.origin, "chainChanged", answer.chainKey);
    }
    if (answer.chainKey === "0x1" || answer.chainKey === "0xa867") {
      const next = answer.chainKey === "0xa867" ? "hemi" : "ethereum";
      if (networkSelect.value !== next) {
        networkSelect.value = next;
        localStorage.setItem(CHAIN_KEY, next);
        balance = null;
        syncNetworkActions();
        paintChain();
        refreshWallet();
      }
    }
    replyDapp(request, true, answer.result);
  } catch (error) {
    const code = error instanceof DappError ? error.code : -32603;
    const message = error && error.message ? error.message : "Request failed";
    replyDapp(request, false, { code, message });
  }
}

function pumpDapp() {
  if (dappBusy) return;
  const request = dappQueue.shift();
  if (!request) return;
  dappBusy = true;
  handleDapp(request).finally(() => {
    dappBusy = false;
    pumpDapp();
  });
}

window.__hogDappAsk = (request) => {
  if (dappQueue.length > 8) {
    replyDapp(request, false, { code: 4001, message: "Too many requests." });
    return;
  }
  dappQueue.push(request);
  pumpDapp();
};

function bind() {
  $("omnibox").addEventListener("submit", (event) => {
    event.preventDefault();
    hideSuggestions();
    openUrl(addressInput.value);
  });
  addressInput.addEventListener("input", () => showSuggestions(addressInput.value));
  addressInput.addEventListener("focus", () => showSuggestions(addressInput.value));
  addressInput.addEventListener("blur", () => setTimeout(hideSuggestions, 200));
  $("back").addEventListener("click", goBack);
  $("forward").addEventListener("click", goForward);
  $("reload").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab?.url) return;
    if (isNativeTab(tab)) {
      desktopCommand(`reload:${tab.id}`);
      return;
    }
    if (tab.kind === "node" && nodeFrame.getAttribute("src")) nodeFrame.src = "about:blank";
    openUrl(tab.url, { push: false, method: tab.method, fields: tab.fields });
  });
  $("stop").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    if (isNativeTab(tab)) {
      tab.loading = false;
      desktopCommand(`stop:${tab.id}`);
      updateNav();
      return;
    }
    abortLoad(tab.id);
  });
  $("home-btn").addEventListener("click", goHome);
  $("new-tab").addEventListener("click", () => {
    createTab();
    addressInput.focus();
  });
  $("isolate-tab").addEventListener("click", () => {
    createTab({ isolated: true });
    addressInput.focus();
  });
  $("star").addEventListener("click", toggleBookmark);
  bindBookmarks();
  $("zoom-btn").addEventListener("click", () => setZoom(1));
  $("shields").addEventListener("click", () => togglePopover("shields-panel", "shields"));
  $("history-btn").addEventListener("click", () => togglePopover("history-panel", "history-btn"));
  $("settings-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("settings-menu");
    const willOpen = menu.hidden;
    closePopovers();
    menu.hidden = !willOpen;
    $("settings-btn").setAttribute("aria-expanded", willOpen ? "true" : "false");
    syncPageView();
  });
  $("settings-menu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-settings]");
    if (!button) return;
    event.stopPropagation();
    if (button.dataset.settings === "bookmarks") {
      showBookmarksView();
      return;
    }
    showSettingsPage(button.dataset.settings);
  });
  const settingsNav = $("settings-nav");
  if (settingsNav) {
    settingsNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-settings]");
      if (!button) return;
      showSettingsPage(button.dataset.settings);
    });
    settingsNav.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = [...settingsNav.querySelectorAll("[data-settings]")];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? buttons[(index + 1) % buttons.length]
        : buttons[(index - 1 + buttons.length) % buttons.length];
      next.focus();
    });
  }
  document.querySelectorAll("#home [data-settings]").forEach((button) => {
    button.addEventListener("click", () => showSettingsPage(button.dataset.settings));
  });
  restoreAccordions();
  document.querySelectorAll("[data-launch]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.launch;
      if (kind === "wireguard") {
        fillLaunch(kind, button.dataset.image, "Command for a separate WireGuard container. Run loads the kernel module on this computer when it can. This does not change hog-ubuntu.", {
          vpn: true,
          ports: [{ bind: "", host: "51820", dest: "51820", proto: "udp" }],
          command: [],
          env: ["PUID=1000", "PGID=1000", "TZ=Etc/UTC", "SERVERURL=auto", "SERVERPORT=51820", "PEERS=1", "PEERDNS=auto", "LOG_CONFS=true", "ALLOWEDIPS=0.0.0.0/0"],
          sysctls: ["net.ipv4.conf.all.src_valid_mark=1", "net.ipv4.ip_forward=1"],
        });
        return;
      }
      if (kind === "cartesi-db") {
        fillLaunch(kind, button.dataset.image, "Database for cartesi-bridge. It already names bridge-v2-r10. Start this and wait until it is running, then start cartesi-bridge. It listens on this computer only, port 5433. This does not change the VPS.", {
          ports: [{ bind: "127.0.0.1", host: "5433", dest: "5432", proto: "tcp" }],
          command: [],
          env: ["POSTGRES_PASSWORD=password", "POSTGRES_DB=rollupsdb"],
        });
        return;
      }
      if (kind === "cartesi-bridge") {
        fillLaunch(kind, button.dataset.image, "Follows bridge-v2-r10 on the public chain and does not submit claims. Start Cartesi database first. This does not change the VPS node.", {
          ports: [
            { bind: "127.0.0.1", host: "10011", dest: "10011", proto: "tcp" },
            { bind: "127.0.0.1", host: "10012", dest: "10012", proto: "tcp" },
          ],
          command: ["cartesi-rollups-node"],
          env: [
            "CARTESI_BLOCKCHAIN_HTTP_ENDPOINT=https://cartesi-bridge.duckdns.org/rpc",
            "CARTESI_BLOCKCHAIN_ID=31337",
            "CARTESI_BLOCKCHAIN_DEFAULT_BLOCK=latest",
            "CARTESI_FEATURE_CLAIM_SUBMISSION_ENABLED=false",
            "CARTESI_FEATURE_INPUT_READER_ENABLED=true",
            "CARTESI_FEATURE_INSPECT_ENABLED=true",
            "CARTESI_FEATURE_JSONRPC_API_ENABLED=true",
            "CARTESI_LOG_LEVEL=info",
            "CARTESI_CONTRACTS_INPUT_BOX_ADDRESS=0x346B3df038FE9f8380071eC6514D5a83aD143939",
            "CARTESI_CONTRACTS_SELF_HOSTED_APPLICATION_FACTORY_ADDRESS=0x6145C5996a71a379E030aEb0440df79D60833418",
            "CARTESI_DATABASE_CONNECTION=postgres://postgres:password@host.docker.internal:5433/rollupsdb",
            "CARTESI_SNAPSHOTS_DIR=/var/lib/cartesi-rollups-node/snapshots",
          ],
        });
        return;
      }
      if (kind === "tailscale") {
        const existing = (lastContainerItems || []).find((item) => item && item.name === "tailscale");
        const preferEngine = runtimeOk("engine") && (!existing || existing.runtime === "engine");
        const runtime = preferEngine ? "engine" : "desktop";
        fillLaunch(kind, button.dataset.image, preferEngine
          ? "In Docker, click Tailscale, then Run. Docker Engine is selected so Tailscale can use this computer's network and your phone can usually connect directly. Open the running tailscale container, press Sign in, and approve hog as an exit node. State stays in a Docker volume so login survives a recreate on the same runtime."
          : "In Docker, click Tailscale, then Run. Open the running tailscale container, press Sign in, open the link, and finish login. Approve hog as an exit node in the Tailscale admin page. State stays in a Docker volume so login survives a recreate on the same runtime.", {
          vpn: true,
          ports: [],
          command: [],
          env: ["TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"],
          sysctls: preferEngine ? [] : ["net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1", "net.ipv6.conf.all.forwarding=1"],
          network: preferEngine ? "host" : "hog-tailscale",
          runtime,
        });
        return;
      }
      if (kind === "jellyfin") {
        fillLaunch(kind, button.dataset.image, "Click Jellyfin, then Run. That creates the empty folder ~/hog-shares and attaches it inside Jellyfin at /media. Use GPU acceleration (NVIDIA) on this page for NVENC.", {
          ports: [{ bind: "127.0.0.1", host: "8096", dest: "8096", proto: "tcp" }],
          command: [],
        });
        return;
      }
      fillLaunch(kind, button.dataset.image, `Command for ${button.dataset.image} as ${kind}. Add a port or the VPN interface, then Run.`);
    });
  });
  if ($("container-command") && !$("container-command").value.trim()) {
    fillLaunch("ubuntu", "ubuntu:24.04", "");
  }
  $("container-command").addEventListener("input", syncLaunchButtons);
  $("add-port").addEventListener("click", () => {
    const spec = readLaunch($("container-command").value);
    if (!spec) {
      $("container-error").textContent = "Start from one of the image buttons, then add a port.";
      return;
    }
    const num = (value) => {
      if (!/^\d+$/.test(value)) return "";
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 65535) return "";
      return String(number);
    };
    const host = num($("port-host").value.trim());
    const dest = num($("port-dest").value.trim());
    const proto = $("port-proto").value === "udp" ? "udp" : "tcp";
    if (!host || !dest) {
      $("container-error").textContent = "Use a port from 1 to 65535.";
      return;
    }
    if (spec.ports.length >= 8) {
      $("container-error").textContent = "Eight ports is the limit.";
      return;
    }
    if (spec.ports.some((port) => !port.bind && port.host === host && port.dest === dest && port.proto === proto)) {
      $("container-error").textContent = "That port is already in the command.";
      return;
    }
    spec.ports.push({ bind: "", host, dest, proto });
    paintLaunch(spec, `Added ${host}:${dest}/${proto}. Run starts a new container. Recreate replaces one that already exists.`);
  });
  $("vpn-toggle").addEventListener("click", () => {
    const spec = readLaunch($("container-command").value);
    if (!spec) {
      $("container-error").textContent = "Start from one of the image buttons, then add the VPN interface.";
      return;
    }
    spec.vpn = !spec.vpn;
    paintLaunch(
      spec,
      spec.vpn ? "VPN interface adds NET_ADMIN and /dev/net/tun. It does not load a kernel module." : "",
    );
  });
  $("run-command").addEventListener("click", () => sendLaunch(false));
  $("recreate-command").addEventListener("click", () => sendLaunch(true));
  $("load-wireguard").addEventListener("click", () => {
    const button = $("load-wireguard");
    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = "Waiting for approval…";
    $("container-error").textContent = "";
    $("container-status").textContent = "Approve sudo modprobe wireguard in the password prompt.";
    desktopCommand("containers:modprobe");
  });
  $("endpoint-lan").addEventListener("click", () => sendEndpoint("lan"));
  $("endpoint-public").addEventListener("click", () => sendEndpoint("public"));
  $("tailscale-up").addEventListener("click", () => {
    const button = $("tailscale-up");
    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = "Waiting for the link…";
    const error = $("tailscale-error");
    const auth = $("tailscale-auth");
    if (error) error.textContent = "";
    if (auth) auth.textContent = "Signing in to Tailscale. The link appears here. Open it before the wait ends.";
    $("container-error").textContent = "";
    $("container-status").textContent = "Signing in to Tailscale. The link appears here. Open it before the wait ends.";
    desktopCommand("containers:tailscale-up");
  });
  $("tailscale-login-link").addEventListener("click", () => {
    openTailscaleUrl($("tailscale-login-link").dataset.url || "");
  });

  $("hog-update-check").addEventListener("click", () => {
    const button = $("hog-update-check");
    if (!button || button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    button.disabled = true;
    const error = $("hog-update-error");
    const status = $("hog-update-status");
    if (error) error.textContent = "";
    if (status) status.textContent = "Checking GitHub for a newer Hog release…";
    desktopCommand("containers:update-check-now");
  });
  $("hog-update-install").addEventListener("click", () => {
    const button = $("hog-update-install");
    if (!button || button.hidden || button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    button.disabled = true;
    const check = $("hog-update-check");
    if (check) check.disabled = true;
    const error = $("hog-update-error");
    const status = $("hog-update-status");
    if (error) error.textContent = "";
    if (status) status.textContent = "Downloading and verifying the update…";
    desktopCommand("containers:update-install");
  });
  $("hog-update-restart").addEventListener("click", () => {
    const button = $("hog-update-restart");
    if (!button || button.hidden) return;
    button.disabled = true;
    const status = $("hog-update-status");
    if (status) status.textContent = "Restarting Hog…";
    desktopCommand("containers:update-restart");
  });
  $("hog-update-link").addEventListener("click", (event) => {
    event.preventDefault();
    const link = $("hog-update-link");
    openHogRelease(link && link.getAttribute("href"));
  });

  $("default-browser-toggle").addEventListener("click", () => {
    const button = $("default-browser-toggle");
    if (!button || button.dataset.busy === "1") return;
    const on = button.getAttribute("aria-pressed") === "true";
    button.dataset.busy = "1";
    button.disabled = true;
    const status = $("default-browser-status");
    const error = $("default-browser-error");
    if (error) error.textContent = "";
    if (status) {
      status.textContent = on
        ? "Restoring the previous default browser…"
        : "Setting Hog as the default browser…";
    }
    desktopCommand(on ? "containers:browser-default-clear" : "containers:browser-default-set");
  });

  $("jellyfin-gpu-toggle").addEventListener("click", () => {
    const button = $("jellyfin-gpu-toggle");
    if (!button || button.dataset.busy === "1") return;
    const on = button.getAttribute("aria-pressed") === "true";
    const message = on
      ? "Turn off GPU acceleration? Jellyfin stays on Docker Engine, but without the NVIDIA GPU. Use the runtime control if you want to move it to Docker Desktop. Desktop settings stay on Docker Desktop's volumes."
      : "Move Jellyfin onto Docker Engine with the NVIDIA GPU? Login and libraries from Docker Desktop do not carry over; this engine has its own config volume. ~/hog-shares stays the same.";
    if (!window.confirm(message)) return;
    button.dataset.busy = "1";
    button.disabled = true;
    const status = $("jellyfin-gpu-status");
    const error = $("jellyfin-gpu-error");
    if (error) error.textContent = "";
    if (status) {
      status.textContent = on
        ? "Turning off GPU acceleration…"
        : "Starting Jellyfin with the NVIDIA GPU…";
    }
    desktopCommand(on ? "containers:jellyfin-gpu-clear" : "containers:jellyfin-gpu-set");
  });

  $("jellyfin-gpu-install").addEventListener("click", () => {
    const button = $("jellyfin-gpu-install");
    if (!button || button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = "Waiting for approval…";
    const status = $("jellyfin-gpu-status");
    const error = $("jellyfin-gpu-error");
    const log = $("jellyfin-gpu-install-log");
    if (error) error.textContent = "";
    if (log) {
      log.hidden = true;
      log.textContent = "";
    }
    if (status) {
      status.textContent = "Ubuntu will ask for your password. Hog is installing the NVIDIA Container Toolkit and configuring Docker Engine. Docker Desktop is not changed.";
    }
    desktopCommand("containers:jellyfin-gpu-install");
  });

  const bindRuntime = (id, side, kind) => {
    const button = $(id);
    if (!button) return;
    button.addEventListener("click", () => {
      if (kind === "launch") {
        if (!runtimeOk(side)) return;
        const spec = readLaunch($("container-command")?.value || "");
        if (spec && spec.name && lastContainerItems.some((item) => item && item.name === spec.name)) {
          const label = side === "engine" ? "Docker Engine" : "Docker Desktop";
          const ok = window.confirm(`Move ${spec.name} to ${label}? Hog stops and removes it on the current runtime, then starts it again on ${label}. Login, libraries, and other files kept in that runtime's Docker volumes do not carry over.`);
          if (!ok) return;
          $("container-status").textContent = `Moving ${spec.name} to ${label}…`;
          desktopCommand(`containers:runtime-set:${spec.name}:${side}`);
        }
        setLaunchRuntime(side);
      } else {
        if (!runtimeOk(side)) return;
        requestNetworks(side);
      }
    });
  };
  bindRuntime("runtime-engine", "engine", "launch");
  bindRuntime("runtime-desktop", "desktop", "launch");
  bindRuntime("network-runtime-engine", "engine", "networks");
  bindRuntime("network-runtime-desktop", "desktop", "networks");
  const driver = $("network-driver");
  if (driver) {
    driver.addEventListener("change", () => {
      const row = $("network-parent-row");
      if (row) row.hidden = driver.value === "bridge";
    });
  }
  const form = $("network-create-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = {
        runtime: networkRuntime,
        name: ($("network-name")?.value || "").trim(),
        driver: $("network-driver")?.value || "bridge",
        subnet: ($("network-subnet")?.value || "").trim(),
        gateway: ($("network-gateway")?.value || "").trim(),
        parent: ($("network-parent")?.value || "").trim(),
        internal: Boolean($("network-internal")?.checked),
      };
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(body.name) || ["bridge", "host", "none"].includes(body.name)) {
        const error = $("network-error");
        if (error) error.textContent = "Use a plain network name. Built-in names such as bridge, host, and none cannot be created.";
        return;
      }
      if (!["bridge", "macvlan", "ipvlan"].includes(body.driver)) {
        const error = $("network-error");
        if (error) error.textContent = "Use the bridge, macvlan, or ipvlan driver.";
        return;
      }
      if (body.subnet && !/^((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]+)\/\d{1,3}$/.test(body.subnet)) {
        const error = $("network-error");
        if (error) error.textContent = "Use a subnet like 172.28.0.0/16.";
        return;
      }
      desktopCommand(`containers:network-create:${JSON.stringify(body)}`);
    });
  }
  const sendNetworkMembership = (action) => {
    const container = $("network-container")?.value || "";
    const network = $("network-attach-name")?.value || "";
    if (!container || !network) return;
    if (action === "connect") {
      desktopCommand(`containers:network-connect:${networkRuntime}:${network}:${container}`);
    } else {
      desktopCommand(`containers:network-disconnect:${networkRuntime}:${network}:${container}`);
    }
  };
  const connectBtn = $("network-connect");
  if (connectBtn) connectBtn.addEventListener("click", () => sendNetworkMembership("connect"));
  const disconnectBtn = $("network-disconnect");
  if (disconnectBtn) disconnectBtn.addEventListener("click", () => sendNetworkMembership("disconnect"));

  $("share-computer").addEventListener("click", () => {
    const form = $("share-name-form");
    form.hidden = false;
    $("share-name").focus();
  });
  $("share-network").addEventListener("click", () => {
    $("container-error").textContent = "";
    $("container-status").textContent = "Choose a folder on this computer.";
    desktopCommand("containers:share-pick");
  });
  $("share-name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("share-name").value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,24}$/.test(name)) {
      $("container-error").textContent = "Use a short name like photos.";
      return;
    }
    $("container-error").textContent = "";
    $("container-status").textContent = `Creating ${name}…`;
    desktopCommand(`containers:share-computer:${name}`);
  });
  $("share-publish").addEventListener("click", () => {
    const button = $("share-publish");
    button.dataset.busy = "1";
    button.disabled = true;
    $("container-error").textContent = "";
    $("container-status").textContent = "Publishing folders to the phone…";
    desktopCommand("containers:share-publish");
  });
  $("media-crumb").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-media-path]");
    if (!button) return;
    openMedia(button.dataset.mediaPath || "");
  });
  $("media-list").addEventListener("click", (event) => {
    const open = event.target.closest("button[data-open-path]");
    if (open) {
      openMedia(open.dataset.openPath || "");
      return;
    }
    const remove = event.target.closest("button[data-remove-path]");
    if (!remove || !mediaNameOk(remove.dataset.removeName)) return;
    const folder = remove.dataset.removeKind === "folder";
    const message = folder
      ? `Remove ${remove.dataset.removeName} from the library? This deletes that folder${remove.dataset.removeShared === "1" ? " and stops the phone link" : ""}.`
      : `Remove ${remove.dataset.removeName} from the library? The original file on this computer stays.`;
    if (!window.confirm(message)) return;
    const status = $("media-status");
    if (status) status.textContent = `Removing ${remove.dataset.removeName}…`;
    desktopCommand(`containers:media-remove:${remove.dataset.removePath}`);
  });
  $("media-add").addEventListener("click", () => {
    const status = $("media-status");
    if (status) status.textContent = "Choose files to add.";
    desktopCommand("containers:media-pick");
  });
  $("media-add-folder").addEventListener("click", () => {
    const status = $("media-status");
    if (status) status.textContent = "Choose a folder to add.";
    desktopCommand("containers:media-pick-folder");
  });
  $("media-new-folder").addEventListener("click", () => {
    const form = $("media-folder-form");
    form.hidden = false;
    $("media-folder-name").focus();
    updateDropHint(mediaCwd);
  });
  $("media-folder-name").addEventListener("input", () => updateDropHint(mediaCwd));
  $("media-folder-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("media-folder-name");
    const name = input.value.trim();
    const status = $("media-status");
    if (!mediaNameOk(name)) {
      if (status) status.textContent = "Use a folder name without slashes.";
      return;
    }
    const next = mediaCwd ? `${mediaCwd}/${name}` : name;
    if (status) status.textContent = `Creating ${name}…`;
    desktopCommand(`containers:media-mkdir:${next}`);
    $("media-folder-form").hidden = true;
    input.value = "";
    updateDropHint(mediaCwd);
  });
  $("browser-settings").addEventListener("scroll", reportShareDrop);
  window.addEventListener("resize", reportShareDrop);
  $("jellyfin-copy").addEventListener("click", async () => {
    const url = $("jellyfin-copy").dataset.url || "";
    if (!tailnetHttp(url, "8096")) return;
    try {
      await navigator.clipboard.writeText(url);
      $("jellyfin-copy").textContent = "Copied";
    } catch {
      $("jellyfin-copy").textContent = "Select the address";
    }
  });
  $("share-enable").addEventListener("click", () => {
    openTailscaleUrl($("share-enable").dataset.url || "");
  });
  $("exit-node-admin").addEventListener("click", () => {
    openTailscaleUrl("https://login.tailscale.com/admin/machines");
  });
  window.addEventListener("resize", () => {
    const tab = activeTab();
    const session = tab && shells.get(tab.id);
    if (session && !$("shell-view").hidden) session.fit.fit();
  });
  $("start-docker").addEventListener("click", () => {
    const button = $("start-docker");
    button.disabled = true;
    button.textContent = "Starting…";
    $("docker-state").textContent = "Starting Docker Desktop. This can take a minute.";
    $("container-error").textContent = "";
    desktopCommand("containers:engine-start");
  });
  $("node-btn").addEventListener("click", () => openUrl("https://browser-node.netlify.app/"));
  $("clear-history").addEventListener("click", () => {
    localStorage.setItem(HISTORY_KEY, "[]");
    renderHistory();
    syncPageView();
  });
  document.querySelectorAll("[data-url]").forEach((button) => {
    button.addEventListener("click", () => openUrl(button.dataset.url));
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#net-menu")) return;
    if (!event.target.closest("#bm-more, #bm-more-menu")) {
      const more = $("bm-more-menu");
      if (more && !more.hidden) {
        more.hidden = true;
        $("bm-more").setAttribute("aria-expanded", "false");
      }
    }
    if (event.target.closest("#shields, #shields-panel, #history-btn, #history-panel, #settings-btn, #settings-menu")) return;
    closePopovers();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideSuggestions();
      closePopovers();
    }
    onShortcut(event);
  });
  window.addEventListener("message", (event) => {
    const fromPage = event.source === frame.contentWindow;
    const fromNode = event.source === nodeFrame.contentWindow;
    if (!fromPage && !fromNode) return;
    const data = event.data;
    if (!data || data.source !== "hog") return;
    if (data.type === "node-sync") {
      if (fromNode) setNodeSynced(data.synced === true);
      return;
    }
    if (data.type !== "navigate") return;
    if (fromNode && data.url && !isNodeUrl(data.url)) createTab();
    openUrl(data.url, { method: data.method, fields: data.fields });
  });

  $("wallet-edge").addEventListener("pointerenter", () => heatEdge("wallet", true));
  $("wallet-edge").addEventListener("pointerleave", (event) => heatEdge("wallet", false, event));
  $("wallet-edge").addEventListener("focus", () => heatEdge("wallet", true));
  $("wallet-edge").addEventListener("blur", () => heatEdge("wallet", false));
  $("wallet-edge").addEventListener("click", () => setWalletOpen(wallet.classList.contains("is-hidden")));
  $("tabs-edge").addEventListener("pointerenter", () => heatEdge("tabs", true));
  $("tabs-edge").addEventListener("pointerleave", (event) => heatEdge("tabs", false, event));
  $("tabs-edge").addEventListener("focus", () => heatEdge("tabs", true));
  $("tabs-edge").addEventListener("blur", () => heatEdge("tabs", false));
  $("tabs-edge").addEventListener("click", () => setTabsOpen($("stage").classList.contains("is-tabs-closed")));
  bindSpotDrag("tabs");
  bindSpotDrag("wallet");
  $("net-btn").addEventListener("click", () => setNetOpen($("net-panel").hidden));
  $("net-list").addEventListener("click", (event) => {
    const option = event.target.closest("[data-chain]");
    if (!option) return;
    setNetOpen(false);
    const next = option.dataset.chain === "wart"
      ? (isWartChain() ? selectedChain() : savedWartNet())
      : option.dataset.chain;
    if (networkSelect.value === next) return;
    networkSelect.value = next;
    networkSelect.dispatchEvent(new Event("change"));
  });
  $("wart-net").addEventListener("click", () => {
    if (!isWartChain()) return;
    networkSelect.value = selectedChain() === "defi" ? "mainnet" : "defi";
    networkSelect.dispatchEvent(new Event("change"));
  });
  $("bal-refresh").addEventListener("click", () => refreshWallet());
  networkSelect.addEventListener("change", () => {
    const chain = selectedChain();
    localStorage.setItem(CHAIN_KEY, chain);
    if (isWartChain(chain)) localStorage.setItem("hog-wart-net", chain);
    clearReview();
    balance = null;
    syncNetworkActions();
    paintNetMenu();
    if (!session) return;
    showWalletPage("home");
    paintChain();
    renderBalance();
    applyWalletChainToSites();
    refreshWallet();
  });
  document.querySelectorAll("[data-wpage]").forEach((button) => {
    button.addEventListener("click", () => showWalletPage(button.dataset.wpage));
  });
  document.querySelectorAll("[data-back]").forEach((button) => {
    button.addEventListener("click", () => showWalletPage(button.dataset.back || "home"));
  });
  $("go-send").addEventListener("click", () => showWalletPage("send"));
  $("go-receive").addEventListener("click", () => showWalletPage("receive"));
  $("go-receive-defi").addEventListener("click", () => showWalletPage("receive"));
  $("go-swap").addEventListener("click", () => showWalletPage("swap"));
  $("go-liquidity").addEventListener("click", () => showWalletPage("liquidity"));
  $("go-mint").addEventListener("click", () => showWalletPage("mint"));
  $("trade-swap").addEventListener("click", () => showWalletPage("swap"));
  $("trade-safe").addEventListener("click", () => showWalletPage("safetrade"));
  $("trade-aave").addEventListener("click", () => showWalletPage("aave"));
  $("open-safetrade").addEventListener("click", () => openUrl("https://safetrade.com"));
  $("swap-find").addEventListener("click", findSwapAssets);
  $("swap-max").addEventListener("click", fillSwapMax);
  $("swap-form").addEventListener("submit", (event) => reviewMarket(event, swapSpec()));
  $("liq-form").addEventListener("submit", (event) => reviewMarket(event, depositSpec()));
  $("liq-out-form").addEventListener("submit", (event) => reviewMarket(event, withdrawSpec()));
  $("mint-form").addEventListener("submit", (event) => reviewMarket(event, mintSpec()));
  armMarketReset("swap", "swap-review", "swap-button", "Review swap", ["swap-query", "swap-amount", "swap-price", "swap-decimals", "swap-fee", "swap-side"]);
  armMarketReset("deposit", "liq-review", "liq-button", "Review deposit", ["liq-asset", "liq-asset-amount", "liq-wart", "liq-decimals", "liq-fee"]);
  armMarketReset("withdraw", "liq-out-review", "liq-out-button", "Review withdrawal", ["liq-asset", "liq-shares", "liq-fee"]);
  armMarketReset("mint", "mint-review", "mint-button", "Review mint", ["mint-name", "mint-supply", "mint-decimals", "mint-fee"]);
  $("name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("account-name").value.trim().slice(0, 32);
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
    $("w-title").textContent = name || "Warthog";
    $("account-label").textContent = name || "Account";
  });
  $("key-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("key-error").textContent = "";
    const record = savedRecord();
    if (!record) return;
    try {
      const privateKey = await openKey(record, $("key-pass").value);
      const account = chainAccountsFromPrivateKey(privateKey);
      if (account.address !== record.address) throw new Error("The saved wallet did not decrypt");
      $("revealed-key").hidden = false;
      $("revealed-key").value = account.privateKey;
      $("key-pass").value = "";
      setTimeout(() => {
        $("revealed-key").value = "";
        $("revealed-key").hidden = true;
      }, 20000);
    } catch {
      $("key-error").textContent = "Wrong password.";
    }
  });
  $("autolock").addEventListener("change", () => {
    localStorage.setItem(LOCK_KEY, $("autolock").value);
    scheduleLock();
  });
  document.querySelectorAll("[data-display]").forEach((button) => {
    button.addEventListener("click", () => {
      localStorage.setItem(DISPLAY_KEY, button.dataset.display);
      renderDisplayPicks();
      renderBalance();
    });
  });
  document.addEventListener("pointerdown", scheduleLock);
  document.addEventListener("keydown", scheduleLock);
  bindDesktop();

  $("create").addEventListener("click", () => showStep("create"));
  $("hub-unlock").addEventListener("click", () => showStep("unlock"));
  $("show-import").addEventListener("click", () => showStep("restore"));
  $("setup-back").addEventListener("click", () => showHub());
  $("mode-side").addEventListener("click", () => setWindowCopy(true));
  $("mode-dropdown").addEventListener("click", () => setWindowCopy(false));
  $("restore-key").addEventListener("click", () => showStep("import"));
  $("restore-seed").addEventListener("click", () => showStep("phrase"));
  $("restore-file").addEventListener("click", () => {
    showLimit("An encrypted warthog_wallet.txt file stays in the extension. Paste the private key here if you have it.");
  });
  $("restore-ledger").addEventListener("click", () => {
    showLimit("A Ledger Nano stays in the extension. This window cannot see the device.");
  });
  $("create-name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    setSetupError("");
    const name = $("create-name").value.trim().slice(0, 32);
    if (!name) {
      setSetupError("Enter a wallet name first.");
      return;
    }
    localStorage.setItem(NAME_KEY, name);
    $("w-title").textContent = name;
    pendingAccount = chainAccountsFromPrivateKey(createAccount().privateKey);
    $("new-key").value = pendingAccount.privateKey;
    $("saved-key").checked = false;
    $("create-pass").value = "";
    $("create-pass2").value = "";
    showStep("key");
  });
  $("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setSetupError("");
    if (!pendingAccount) return;
    if (!$("saved-key").checked) {
      setSetupError("Save the private key before continuing.");
      return;
    }
    const password = $("create-pass").value;
    if (password.length < 8) {
      setSetupError("Use a password of at least 8 characters.");
      return;
    }
    if (password !== $("create-pass2").value) {
      setSetupError("Passwords do not match.");
      return;
    }
    try {
      await saveAccount(pendingAccount, password);
    } catch (error) {
      setSetupError(error.message);
    }
  });
  $("phrase-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setSetupError("");
    const password = $("phrase-pass").value;
    if (password.length < 8) {
      setSetupError("Use a password of at least 8 characters.");
      return;
    }
    if (savedRecord() && !window.confirm("Replace the wallet saved in this window with this phrase?")) return;
    try {
      const account = chainAccountsFromPhrase($("import-phrase").value);
      await saveAccount(account, password);
      $("import-phrase").value = "";
      $("phrase-pass").value = "";
    } catch (error) {
      setSetupError(error.message);
    }
  });
  $("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setSetupError("");
    const password = $("import-pass").value;
    if (password.length < 8) {
      setSetupError("Use a password of at least 8 characters.");
      return;
    }
    try {
      const account = chainAccountsFromPrivateKey($("import-key").value);
      await saveAccount(account, password);
      $("import-key").value = "";
      $("import-pass").value = "";
    } catch (error) {
      setSetupError(error.message);
    }
  });
  $("unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setSetupError("");
    const record = savedRecord();
    if (!record) return;
    try {
      const privateKey = await openKey(record, $("unlock-pass").value);
      let account = chainAccountsFromPrivateKey(privateKey);
      if (record.phrase) account = chainAccountsFromPhrase(await openKey(record.phrase, $("unlock-pass").value));
      if (account.address !== record.address) {
        throw new Error("The saved wallet did not decrypt to its address");
      }
      startSession(account);
      $("unlock-pass").value = "";
      showOpen();
      await refreshWallet();
    } catch {
      setSetupError("Wrong password.");
    }
  });
  $("forget").addEventListener("click", forgetWallet);
  $("forget-open").addEventListener("click", forgetWallet);
  $("lock").addEventListener("click", () => {
    session = null;
    balance = null;
    finishDapp(false);
    showSetup();
  });
  $("copy-address").addEventListener("click", () => {
    copyAddress($("w-addr-short"), () => shortAddress(activeAddress()));
  });
  $("copy-receive").addEventListener("click", () => {
    copyAddress($("copy-receive"), () => "Copy address");
  });
  $("refresh").addEventListener("click", () => refreshWallet());
  $("send-max").addEventListener("click", () => fillMax());
  $("send-form").addEventListener("submit", (event) => {
    reviewOrSend(event);
  });
  for (const id of ["send-to", "send-amount", "send-fee"]) {
    $(id).addEventListener("input", () => {
      if (reviewing) clearReview();
    });
  }
  $("dapp-reject").addEventListener("click", () => finishDapp(false));
  $("dapp-ok").addEventListener("click", () => finishDapp(true));
  $("dapp-sure").addEventListener("change", () => {
    $("dapp-ok").disabled = $("dapp-sure-row").hidden ? false : !$("dapp-sure").checked;
  });
  $("site-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-origin]");
    if (!button) return;
    disconnectSite(button.dataset.origin);
  });
}

let brandReady = false;

function motionReduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stopCelebrate() {
  const el = $("wallet-run");
  if (!el) return;
  el.pause();
  el.hidden = true;
  if (el.getAttribute("src")) {
    el.removeAttribute("src");
    try { el.load(); } catch { /* element is already clear */ }
  }
}

function celebrateWallet() {
  const el = $("wallet-run");
  if (!el || !brandReady || document.hidden || motionReduced()) return;
  if (wallet.classList.contains("is-hidden")) return;
  const play = Number(el.dataset.play || "0") + 1;
  el.dataset.play = String(play);
  el.hidden = false;
  el.removeAttribute("src");
  try { el.load(); } catch { /* element is already clear */ }
  // A seek back to 0 freezes this clip in WebKitGTK. A new URL starts a fresh play.
  el.src = `wartlogorun-wallet.mp4?play=${play}`;
  const pending = el.play();
  if (pending && pending.catch) pending.catch(() => stopCelebrate());
}

function armCelebrate() {
  const el = $("wallet-run");
  if (!el || el.dataset.armed) return;
  el.dataset.armed = "1";
  el.addEventListener("ended", () => stopCelebrate());
  el.addEventListener("error", () => stopCelebrate());
}

let bootOpened = false;

function resumeAfterFlash() {
  if (bootOpened) return;
  bootOpened = true;
  const last = sessionStorage.getItem(LAST_URL);
  if (last) openUrl(last);
}

function bootFlash() {
  const flash = $("boot-flash");
  const video = $("boot-video");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey);
    brandReady = true;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      try { video.load(); } catch { /* splash element already gone */ }
    }
    if (!flash) {
      resumeAfterFlash();
      return;
    }
    flash.classList.add("is-done");
    flash.setAttribute("aria-hidden", "true");
    setTimeout(() => { flash.hidden = true; }, 280);
    resumeAfterFlash();
  };
  const onKey = (event) => {
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      finish();
    }
  };
  document.addEventListener("visibilitychange", () => {
    const clip = $("wallet-run");
    if (clip && !clip.hidden) {
      if (document.hidden) clip.pause();
      else if (!clip.ended) {
        const pending = clip.play();
        if (pending && pending.catch) pending.catch(() => {});
      }
    }
    if (done || !video) return;
    if (document.hidden) {
      video.pause();
      return;
    }
    const pending = video.play();
    if (pending && pending.catch) pending.catch(() => {});
  });
  if (!flash || !video || motion) {
    if (flash) flash.hidden = true;
    finish();
    return;
  }
  video.addEventListener("ended", finish);
  video.addEventListener("error", finish);
  flash.addEventListener("click", finish);
  document.addEventListener("keydown", onKey);
  setTimeout(finish, 8000);
  try { flash.focus({ preventScroll: true }); } catch { flash.focus(); }
  const pending = video.play();
  if (pending && pending.catch) pending.catch(() => {});
}

const savedChain = localStorage.getItem(CHAIN_KEY);
if (savedChain && CHAIN_VIEW[savedChain]) networkSelect.value = savedChain;
bind();
paintNetMenu();
renderBookmarks();
createTab();
showSetup();
setWalletOpen(localStorage.getItem(WALLET_OPEN_KEY) !== "0");
setTabsOpen(localStorage.getItem(TABS_OPEN_KEY) !== "0");
restoreSpotTops();
armCelebrate();
bootFlash();
window.__hogReady = true;


// ---------- Solo mining (BzMiner -> stratum 127.0.0.1:3456 -> node tab) ----------
const MINING_ADDRESS_RE = /^[0-9a-fA-F]{48}$/;
let miningAddressDirty = false;

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function paintMining(state) {
  const button = $("mining-toggle");
  const status = $("mining-status");
  const error = $("mining-error");
  if (!button || !status || !error || !state) return;
  delete button.dataset.busy;
  button.disabled = false;
  const on = Boolean(state.enabled);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? "Turn off" : "Turn on";
  if (state.command) setText("mining-command", state.command);
  setText("mining-source", state.defiNodeSource ? `DeFi node build: ${state.defiNodeSource}` : "");
  const input = $("mining-address");
  if (input && !miningAddressDirty && document.activeElement !== input) input.value = state.address || "";
  if (!miningAddressDirty) {
    setText("mining-address-note", state.address ? "Saved. BzMiner's command below uses it." : "Paste the address you want block rewards paid to.");
  }
  const tab = !state.pageConnected
    ? "Not open"
    : state.pageNetwork && state.pageNetwork !== "defi"
      ? `On ${state.pageNetwork}`
      : state.synced ? "Synced" : state.pageNetwork === "defi" ? "Running" : "Open, not started";
  setText("mining-stat-node", tab);
  setText("mining-stat-height", state.height ? Number(state.height).toLocaleString() : "—");
  setText("mining-stat-miners", String(state.miners || 0));
  setText("mining-stat-blocks", String(state.blocks || 0));
  setText("mining-stat-rejected", String(state.rejected || 0));
  setText("mining-last", state.lastResult || "");
  if (!on) {
    status.textContent = "Off. Turn this on to let BzMiner connect.";
  } else if (!state.stratumListening) {
    status.textContent = "On, but the stratum port could not open.";
  } else {
    const miners = state.miners ? `${state.miners} miner${state.miners === 1 ? "" : "s"} connected.` : "Waiting for BzMiner.";
    status.textContent = `Stratum on 127.0.0.1:${state.stratumPort}. ${miners}`;
  }
  error.textContent = state.error || state.lastError || "";
}

async function postMining(body) {
  const response = await fetch("/api/mining", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || `Hog returned ${response.status}`);
  return state;
}

async function refreshMining() {
  try {
    const response = await fetch("/api/mining", { credentials: "same-origin" });
    paintMining(await response.json());
  } catch (err) {
    setText("mining-error", err instanceof Error ? err.message : String(err));
  }
}

async function saveMiningAddress() {
  const input = $("mining-address");
  if (!input) return;
  const value = input.value.trim();
  if (value && !MINING_ADDRESS_RE.test(value)) {
    setText("mining-address-note", "A Warthog address is 48 hex characters (0-9, a-f).");
    input.setAttribute("aria-invalid", "true");
    return;
  }
  try {
    const state = await postMining({ address: value });
    input.removeAttribute("aria-invalid");
    miningAddressDirty = false;
    paintMining(state);
  } catch (err) {
    input.setAttribute("aria-invalid", "true");
    setText("mining-address-note", err instanceof Error ? err.message : String(err));
  }
}

(function wireMining() {
  const button = $("mining-toggle");
  if (!button) return;
  button.addEventListener("click", async () => {
    if (button.dataset.busy) return;
    button.dataset.busy = "1";
    button.disabled = true;
    const enabled = button.getAttribute("aria-pressed") !== "true";
    try {
      paintMining(await postMining({ enabled }));
    } catch (err) {
      delete button.dataset.busy;
      button.disabled = false;
      setText("mining-error", err instanceof Error ? err.message : String(err));
    }
  });
  const input = $("mining-address");
  if (input) {
    input.addEventListener("input", () => {
      miningAddressDirty = true;
      const value = input.value.trim();
      const shaped = !value || MINING_ADDRESS_RE.test(value);
      input.toggleAttribute("aria-invalid", !shaped);
      setText("mining-address-note", !value
        ? "Paste the address you want block rewards paid to."
        : shaped ? "Press Save to check it and use it." : `${value.length}/48 hex characters.`);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveMiningAddress();
    });
  }
  const save = $("mining-address-save");
  if (save) save.addEventListener("click", saveMiningAddress);
  const copy = $("mining-command-copy");
  if (copy) {
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("mining-command").textContent);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });
  }
  const open = $("mining-open-node");
  if (open) open.addEventListener("click", () => openUrl("https://browser-node.netlify.app/?network=defi"));
  const dash = $("mining-dashboard");
  if (dash) {
    dash.addEventListener("click", (event) => {
      event.preventDefault();
      openUrl("http://127.0.0.1:4014/");
    });
  }
  setInterval(() => {
    const pane = $("settings-mining");
    if (pane && !pane.hidden && !$("browser-settings").hidden) refreshMining();
  }, 3000);
})();
