"use strict";
// Preload for web pages (sandboxed, isolated world). Puts Hog's page scripts
// into the page like the WebKitGTK shell's user scripts: the edge grips and
// menus drawn over the page, and the wallet provider (window.ethereum).
// They post to window.__hogEdgePost instead of WebKit's message handler.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("__hogEdgePost", (message) => {
  ipcRenderer.send("hogedge", String(message).slice(0, 250000));
});

let scripts = [];
try {
  scripts = ipcRenderer.sendSync("hog:page-scripts", String(location.href)) || [];
} catch {
  scripts = [];
}
const gpc = "try{Object.defineProperty(Navigator.prototype,'globalPrivacyControl',{get:function(){return true},configurable:true})}catch(e){}";
webFrame.executeJavaScript(gpc).catch(() => {});
for (const source of scripts) {
  webFrame.executeJavaScript(source).catch(() => {});
}

// A page may open a new tab only right after a click or key press.
let last = 0;
function gesture(event) {
  if (!event.isTrusted) return;
  const now = Date.now();
  if (now - last < 250) return;
  last = now;
  ipcRenderer.send("hog:gesture");
}
for (const type of ["pointerdown", "keydown", "click", "auxclick"]) {
  window.addEventListener(type, gesture, true);
}
