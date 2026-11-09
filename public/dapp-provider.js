(function () {
  if (window.top !== window) return;
  if (window.ethereum && window.ethereum.isHog) return;
  var pending = {};
  var listeners = {};
  var seq = 1;

  function post(message) {
    try { window.webkit.messageHandlers.hogedge.postMessage(message); } catch (err) {}
  }

  function emit(event, payload) {
    var list = listeners[event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) {}
    }
  }

  window.__hogDappResolve = function (id, ok, payload) {
    var item = pending[id];
    if (!item) return;
    delete pending[id];
    clearTimeout(item.timer);
    if (ok) item.resolve(payload);
    else {
      var error = new Error((payload && payload.message) || "Request failed");
      error.code = (payload && payload.code) || 4001;
      item.reject(error);
    }
  };

  window.__hogDappEmit = function (event, payload) {
    if (event === "accountsChanged") {
      ethereum.selectedAddress = payload && payload.length ? payload[0] : null;
    }
    if (event === "chainChanged" && typeof payload === "string") {
      ethereum.chainId = payload;
      var parsed = parseInt(payload, 16);
      if (isFinite(parsed)) ethereum.networkVersion = String(parsed);
    }
    emit(event, payload);
  };

  function ask(method, params) {
    var id = seq++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        var error = new Error("Request timed out");
        error.code = -32603;
        reject(error);
      }, 120000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      post("dapp:" + JSON.stringify({ id: id, method: String(method || ""), params: params || [] }));
    });
  }

  var ethereum = {
    isHog: true,
    isMetaMask: true,
    chainId: "0x1",
    networkVersion: "1",
    selectedAddress: null,
    _metamask: {
      isUnlocked: function () { return Promise.resolve(true); }
    },
    request: function (args) {
      var method = args && args.method;
      return ask(method, args && args.params).then(function (result) {
        if ((method === "eth_requestAccounts" || method === "eth_accounts") && result && result.length) {
          ethereum.selectedAddress = result[0];
        }
        if (method === "eth_accounts" && result && !result.length) ethereum.selectedAddress = null;
        if (method === "eth_chainId" && typeof result === "string") {
          ethereum.chainId = result;
          var parsed = parseInt(result, 16);
          if (isFinite(parsed)) ethereum.networkVersion = String(parsed);
        }
        return result;
      });
    },
    send: function (methodOrPayload, params) {
      if (typeof methodOrPayload === "string") return ask(methodOrPayload, params);
      if (methodOrPayload && methodOrPayload.method) return ask(methodOrPayload.method, methodOrPayload.params);
      var bad = new Error("Unsupported request.");
      bad.code = -32601;
      return Promise.reject(bad);
    },
    sendAsync: function (payload, callback) {
      var body = payload || {};
      ask(body.method, body.params).then(function (result) {
        callback(null, { id: body.id, jsonrpc: "2.0", result: result });
      }, function (err) {
        callback(err, { id: body.id, jsonrpc: "2.0", error: { code: err.code || -32603, message: err.message } });
      });
    },
    enable: function () { return ask("eth_requestAccounts", []); },
    on: function (event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
      return ethereum;
    },
    addListener: function (event, fn) { return ethereum.on(event, fn); },
    removeListener: function (event, fn) {
      listeners[event] = (listeners[event] || []).filter(function (item) { return item !== fn; });
      return ethereum;
    },
    removeAllListeners: function (event) {
      delete listeners[event];
      return ethereum;
    }
  };
  window.ethereum = ethereum;

  var info = {
    uuid: "hog-browser",
    name: "Hog",
    rdns: "app.hog.browser",
    icon: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='#fdb913'/></svg>")
  };
  function announce() {
    try {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: info, provider: ethereum } }));
    } catch (err) {}
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  setTimeout(announce, 50);
  try { window.dispatchEvent(new Event("ethereum#initialized")); } catch (err) {}
})();
