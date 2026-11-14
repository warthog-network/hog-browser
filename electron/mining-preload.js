"use strict";
// Isolated world for the node iframe on the Hog window. The page only sees
// virtual_get / virtual_post. The mining token and its WebSocket stay here.
const { contextBridge, ipcRenderer } = require("electron");

function nodeFrame() {
  try {
    const url = new URL(location.href);
    return url.protocol === "http:" && url.hostname === "localhost" && url.searchParams.get("hog_relay") === "preload";
  } catch {
    return false;
  }
}

if (nodeFrame()) {
  const PATH = "/__hog/mining";
  let ws = null;
  let beat = null;
  let token = "";

  function send(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  contextBridge.exposeInMainWorld("__hogMiningReply", (payload) => {
    if (!payload || payload.type !== "rpc-result") return;
    send(payload);
  });

  function report() {
    let network = "";
    try {
      const value = contextBridge.executeInMainWorld({
        func: () => (typeof window.__hogMiningStatus === "function" ? window.__hogMiningStatus() : { network: "" }),
      });
      if (value && typeof value.network === "string") network = value.network;
    } catch {
      network = "";
    }
    send({ type: "status", network });
  }

  function deliverRpc(msg) {
    try {
      contextBridge.executeInMainWorld({
        func: (message) => {
          if (typeof window.__hogMiningRpc === "function") {
            window.__hogMiningRpc(message);
            return;
          }
          if (typeof window.__hogMiningReply === "function") {
            window.__hogMiningReply({
              type: "rpc-result",
              id: message && message.id,
              ok: false,
              code: "not-running",
              network: "",
            });
          }
        },
        args: [msg],
      });
    } catch {
      send({ type: "rpc-result", id: msg && msg.id, ok: false, code: "not-running" });
    }
  }

  function connect() {
    if (!token) return;
    let socket;
    try {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}${PATH}`);
    } catch {
      setTimeout(connect, 3000);
      return;
    }
    ws = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "hello", token }));
      report();
      beat = setInterval(report, 2000);
    };
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || msg.type !== "rpc") return;
      deliverRpc(msg);
    };
    socket.onclose = () => {
      if (beat) clearInterval(beat);
      beat = null;
      setTimeout(connect, 3000);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* close follows */ } };
  }

  function pullToken() {
    ipcRenderer.invoke("hog:mining-token").then((value) => {
      token = typeof value === "string" ? value : "";
      if (token) connect();
      else setTimeout(pullToken, 3000);
    }).catch(() => setTimeout(pullToken, 3000));
  }

  pullToken();
}
