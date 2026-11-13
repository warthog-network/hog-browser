"use strict";
// Preload for Hog's own UI page (http://127.0.0.1:<port>/). Gives app.js the
// same bridge the WebKitGTK shell injects: window.__hogDesktop and
// window.webkit.messageHandlers.hogwin.postMessage(command).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("__hogDesktop", true);
contextBridge.exposeInMainWorld("__hogPageSandbox", true);
contextBridge.exposeInMainWorld("__hogChromium", true);
contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    hogwin: {
      postMessage: (command) => ipcRenderer.send("hogwin", String(command)),
    },
  },
});

// Settings -> Files "drop files here": the GTK shell lays a native drop target
// over #share-drop to learn real file paths. Chromium can read them directly.
function inShareDrop(event) {
  const target = event.target;
  return Boolean(target && target.closest && target.closest("#share-drop"));
}
window.addEventListener(
  "dragover",
  (event) => {
    if (!inShareDrop(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  },
  true,
);
window.addEventListener(
  "drop",
  (event) => {
    if (!inShareDrop(event) || !event.dataTransfer) return;
    const paths = [];
    for (const file of event.dataTransfer.files) {
      try {
        const p = webUtils.getPathForFile(file);
        if (p) paths.push(p);
      } catch {
        /* not a local file */
      }
    }
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.send("hog:share-drop", paths);
  },
  true,
);

// Hog menus over web pages: report the open page menus (as HTML copies) and
// whether any other Hog panel overlaps the page area. main.js draws the menus
// in an overlay view above the page and puts a still picture under other
// panels, so no site can paint over Hog's own UI.
const PAGE_MENUS = [
  ["suggestions", "suggestions"],
  ["history-panel", "history"],
  ["settings-menu", "settings"],
];
const COVER_SELECTOR = [
  ".popover", ".picker", ".connect-card", "[role=dialog]", "[role=menu]",
  ".wallet", ".net-panel", ".dapp-sheet", ".w-menu", ".kebab-menu",
].join(",");

function shown(el) {
  if (!el || el.hidden || el.closest("[hidden]")) return false;
  if (!el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.02;
}

function overlaps(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
}

function readSurface() {
  const view = document.getElementById("view");
  const out = { menus: [], toasts: [], cover: false, css: [] };
  if (!view || !document.body) return out;
  const area = view.getBoundingClientRect();
  const menuEls = [];
  for (const [id, kind] of PAGE_MENUS) {
    const el = document.getElementById(id);
    if (!shown(el)) continue;
    menuEls.push(el);
    const r = el.getBoundingClientRect();
    if (!overlaps(r, area)) continue;
    const list = el.querySelector("ul");
    // Ancestors (tag, id, classes) so the copy matches the same CSS selectors.
    const chain = [];
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      chain.unshift({ tag: node.tagName.toLowerCase(), id: node.id || "", cls: node.getAttribute("class") || "" });
    }
    out.menus.push({ kind, html: el.outerHTML, chain, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, scroll: list ? list.scrollTop : 0 });
  }
  // Download, copy and update notices: the toast stack sits over the page.
  const toasts = document.getElementById("hog-toasts");
  if (toasts && toasts.children.length && shown(toasts)) {
    const r = toasts.getBoundingClientRect();
    if (overlaps(r, area)) {
      out.toasts.push({ kind: "toasts", html: toasts.outerHTML, chain: [], rect: { x: r.left, y: r.top, w: r.width, h: r.height }, scroll: 0 });
    }
  }
  for (const el of document.querySelectorAll(COVER_SELECTOR)) {
    if (view.contains(el) || el.contains(view)) continue;
    if (menuEls.some((menu) => menu === el || menu.contains(el))) continue;
    if (!shown(el)) continue;
    if (overlaps(el.getBoundingClientRect(), area)) {
      out.cover = true;
      break;
    }
  }
  if (out.menus.length || out.toasts.length) {
    out.css = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href).filter(Boolean);
    out.htmlClass = document.documentElement.getAttribute("class") || "";
    out.bodyClass = document.body.getAttribute("class") || "";
    out.theme = document.documentElement.dataset.theme || "";
  }
  return out;
}

let surfaceQueued = false;
let lastSurface = "";
function queueSurface() {
  if (surfaceQueued) return;
  surfaceQueued = true;
  requestAnimationFrame(() => {
    surfaceQueued = false;
    let surface;
    try {
      surface = readSurface();
    } catch {
      return;
    }
    const key = JSON.stringify(surface);
    if (key === lastSurface) return;
    lastSurface = key;
    ipcRenderer.send("hog:chrome-surface", surface);
  });
}
window.addEventListener("DOMContentLoaded", () => {
  new MutationObserver(queueSurface).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style", "aria-selected", "aria-current", "aria-expanded", "open"],
  });
  queueSurface();
});
window.addEventListener("resize", queueSurface);
window.addEventListener("scroll", queueSurface, true);
window.addEventListener("transitionend", queueSurface, true);
window.addEventListener("animationend", queueSurface, true);

// ---------------------------------------------------------------- preview settings card
// Settings -> General gets a "Chromium preview" card for things only the
// preview has: import from the WebKit Hog, third-party cookies, remembered
// site permissions and preview updates. It is built here (not in public/),
// so the WebKit Hog's UI is untouched.
let previewState = null;

function el(tag, attrs = {}, text = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function previewRow(title, statusId, buttons) {
  const row = el("div", { class: "engine-row default-browser-row" });
  const copy = el("div", { class: "default-browser-copy" });
  copy.append(el("strong", {}, title), el("p", { id: statusId, class: "note", role: "status" }), el("p", { id: `${statusId}-error`, class: "error", role: "status" }));
  const actions = el("div", { class: "hog-update-actions" });
  for (const [id, label] of buttons) actions.append(el("button", { type: "button", id }, label));
  row.append(copy, actions);
  return row;
}

function buildPreviewCard() {
  const card = el("section", { id: "preview-card", class: "connect-card", "aria-label": "Chromium preview" });
  const style = el("style");
  style.textContent = `
    #preview-card .default-browser-row { flex-wrap: wrap; }
    #preview-card .default-browser-copy { flex: 1 1 260px; }
    #preview-card .hog-update-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; flex: 0 1 auto; }
    #preview-card button { border: 1px solid rgba(var(--accent-rgb), 0.55); background: var(--panel); color: var(--gold); border-radius: 999px; padding: 6px 14px; max-width: 100%; white-space: normal; text-align: center; cursor: pointer; }
    #preview-card button.is-on { background: rgba(var(--accent-rgb), 0.12); border-color: rgba(var(--accent-rgb), 0.7); }
    #preview-card button:disabled { opacity: 0.6; cursor: wait; }
    #preview-card .default-browser-row + .default-browser-row { margin-top: 12px; }
    #preview-card p.error:empty, #preview-card p.note:empty { display: none; }`;
  card.append(style, el("p", { class: "eyebrow" }, "Chromium preview"));
  card.append(previewRow("Import from Hog", "preview-import-status", [["preview-import", "Import bookmarks, history…"], ["preview-import-wallet", "Import wallet…"]]));
  card.append(previewRow("Third-party cookies", "preview-cookies-status", [["preview-cookies", "Allow"]]));
  card.append(previewRow("Location for sites", "preview-location-status", [["preview-location-system", "System (GeoClue)"], ["preview-location-beacondb", "BeaconDB"], ["preview-location-off", "Off"]]));
  card.append(previewRow("Site permissions", "preview-perms-status", [["preview-perms-forget", "Forget all"]]));
  card.append(previewRow("Preview updates", "preview-update-status", [["preview-update-check", "Check now"], ["preview-update-auto", "Check on start"], ["preview-update-install", "Install update"], ["preview-update-restart", "Restart now"], ["preview-update-open", "Open release"]]));
  card.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest("button");
    if (!button || button.disabled) return;
    const send = (action, value) => ipcRenderer.send("hog:preview", { action, value });
    const id = button.id;
    if (id === "preview-import") send("import");
    else if (id === "preview-import-wallet") send("import-wallet");
    else if (id === "preview-cookies") send("cookies", !(previewState && previewState.blockThirdPartyCookies));
    else if (id === "preview-perms-forget") send("forget-permissions");
    else if (id.startsWith("preview-location-")) send("location", id.slice("preview-location-".length));
    else if (id === "preview-update-check") send("update-check");
    else if (id === "preview-update-auto") send("update-auto", !(previewState && previewState.previewUpdateChecks));
    else if (id === "preview-update-open") send("update-open");
    else if (id === "preview-update-install") send("update-install");
    else if (id === "preview-update-restart") send("update-restart");
  });
  return card;
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text || "";
}

function renderPreviewCard() {
  const s = previewState;
  if (!s || !document.getElementById("preview-card")) return;
  setText("preview-import-status", s.importStatus || (s.webkitFound ? "Copy bookmarks, favorites, history and settings from the WebKit Hog on this computer. The wallet is separate and only on request." : "No WebKit Hog data was found on this computer."));
  setText("preview-import-status-error", s.importError);
  for (const id of ["preview-import", "preview-import-wallet"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = !s.webkitFound || Boolean(s.busy);
  }
  setText("preview-cookies-status", s.blockThirdPartyCookies ? "Blocked, like Hog: sites only get cookies when they are the site in the address bar." : "Allowed: embedded sites (logins, comments, ads) can use their cookies.");
  setText("preview-cookies", s.blockThirdPartyCookies ? "Allow" : "Block");
  const cookieButton = document.getElementById("preview-cookies");
  if (cookieButton) cookieButton.setAttribute("aria-pressed", String(Boolean(s.blockThirdPartyCookies)));
  const loc = s.locationProvider || "system";
  setText(
    "preview-location-status",
    loc === "system"
      ? "Sites that you allow get your location from the desktop's location service (GeoClue: Settings → Privacy → Location Services). No Google service is used."
      : loc === "beacondb"
        ? "Sites that you allow get an approximate location from BeaconDB (beacondb.net, an open location service; it sees your IP address)."
        : "Location is off: sites get “position unavailable”.",
  );
  for (const name of ["system", "beacondb", "off"]) {
    const b = document.getElementById(`preview-location-${name}`);
    if (b) {
      b.classList.toggle("is-on", loc === name);
      b.setAttribute("aria-pressed", String(loc === name));
    }
  }
  setText("preview-perms-status", s.permissions ? `${s.permissions} remembered answer${s.permissions === 1 ? "" : "s"} for notifications, location, camera or microphone.` : "No remembered answers. Sites ask before notifications, location, camera or microphone.");
  const forget = document.getElementById("preview-perms-forget");
  if (forget) forget.disabled = !s.permissions;
  setText("preview-update-status", s.updateStatus || `This is the Chromium preview ${s.version}.`);
  setText("preview-update-status-error", s.updateError);
  setText("preview-update-auto", s.previewUpdateChecks ? "Stop checking on start" : "Check on start");
  const open = document.getElementById("preview-update-open");
  if (open) open.hidden = !s.updateUrl;
  const install = document.getElementById("preview-update-install");
  if (install) {
    install.hidden = !s.updateCanInstall;
    install.disabled = Boolean(s.updateBusy);
  }
  const restart = document.getElementById("preview-update-restart");
  if (restart) restart.hidden = !s.updateInstalled;
  if (!s.updateError && s.updateUrl && !s.updateCanInstall && s.updateInstallNote && !s.updateInstalled) setText("preview-update-status-error", s.updateInstallNote);
}

function ensurePreviewCard() {
  const general = document.getElementById("settings-general");
  if (!general || document.getElementById("preview-card")) return;
  const after = document.getElementById("default-browser-card");
  const card = buildPreviewCard();
  if (after && after.parentElement === general) after.after(card);
  else general.append(card);
  ipcRenderer.send("hog:preview", { action: "state" });
  renderPreviewCard();
}

ipcRenderer.on("hog:preview-state", (_event, state) => {
  previewState = state && typeof state === "object" ? state : null;
  renderPreviewCard();
});
window.addEventListener("DOMContentLoaded", () => {
  ensurePreviewCard();
  new MutationObserver(() => ensurePreviewCard()).observe(document.body, { childList: true, subtree: true });
});
