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
