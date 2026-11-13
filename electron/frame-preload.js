"use strict";
// Runs in every subframe of web pages (session frame preload). When
// third-party cookies are blocked (Settings -> General), a frame from another
// site than the address bar's gets an empty document.cookie that ignores
// writes and no cookieStore, so embedded trackers cannot read or set cookies
// from script either. HTTP Cookie / Set-Cookie are handled in main.js.
const { contextBridge, ipcRenderer } = require("electron");

function topOrigin() {
  try {
    const list = location.ancestorOrigins;
    if (list && list.length) return String(list[list.length - 1]);
  } catch {
    /* ignore */
  }
  return "";
}

if (window !== window.top) {
  let block = false;
  try {
    block = ipcRenderer.sendSync("hog:frame-cookies", { frame: String(location.href), top: topOrigin() }) === true;
  } catch {
    block = false;
  }
  if (block) {
    contextBridge.executeInMainWorld({
      func: () => {
        try {
          Object.defineProperty(Document.prototype, "cookie", { configurable: true, get: () => "", set: () => {} });
        } catch {
          /* ignore */
        }
        try {
          for (const target of [window, Object.getPrototypeOf(window), window.Window && Window.prototype]) {
            if (target && Object.getOwnPropertyDescriptor(target, "cookieStore")) Object.defineProperty(target, "cookieStore", { configurable: true, get: () => undefined });
          }
        } catch {
          /* ignore */
        }
      },
    });
  }
}
