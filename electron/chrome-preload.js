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
