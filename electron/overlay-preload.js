"use strict";
// Preload for Hog's overlay views (menus and edge grips drawn above web pages).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hogOverlay", {
  post: (message) => ipcRenderer.send("hog:overlay", String(message).slice(0, 2000)),
});
