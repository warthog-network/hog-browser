// Preload for Hog's own window (the wallet, tab strip and node tab at
// http://127.0.0.1:4188). It gives app.js the same bridge the Linux shell
// gives it: window.webkit.messageHandlers.hogwin.postMessage(command).
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__hogDesktop", true);
contextBridge.exposeInMainWorld("__hogPageSandbox", true);
contextBridge.exposeInMainWorld("__hogPlatform", process.platform);
contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    hogwin: { postMessage: (command) => ipcRenderer.send("hogwin", String(command)) },
  },
});
