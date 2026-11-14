"use strict";
// Preload for the preview's bottom terminal view. The host PTY is not
// exposed here: the renderer may only send hog:term messages, and the main
// process accepts them only from this view's frame.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hogTerm", {
  ready: () => ipcRenderer.send("hog:term", { type: "ready" }),
  input: (id, data) => ipcRenderer.send("hog:term", { type: "input", id: String(id || ""), data: String(data || "").slice(0, 32768) }),
  resize: (id, cols, rows) => ipcRenderer.send("hog:term", { type: "resize", id: String(id || ""), cols, rows }),
  close: (id) => ipcRenderer.send("hog:term", { type: "close", id: String(id || "") }),
  open: (kind, name) => ipcRenderer.send("hog:term", { type: "open", kind: String(kind || ""), name: String(name || "") }),
  select: (id) => ipcRenderer.send("hog:term", { type: "select", id: String(id || "") }),
  drag: (phase, y) => ipcRenderer.send("hog:term", { type: "drag", phase: String(phase || ""), y }),
  hide: () => ipcRenderer.send("hog:term", { type: "hide" }),
  list: () => ipcRenderer.send("hog:term", { type: "list" }),
  onState: (cb) => {
    ipcRenderer.on("hog:term-state", (_event, state) => cb(state));
  },
  onData: (cb) => {
    ipcRenderer.on("hog:term-data", (_event, message) => cb(message));
  },
});
