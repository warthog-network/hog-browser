/* Hog disk storage for the Warthog WASM node.
   WebKitGTK exposes the file system API, then rejects createSyncAccessHandle.
   This runs inside wart-node.js, including its pthread worker. */
(() => {
  if (globalThis.__hogOpfs) return;
  globalThis.__hogOpfs = true;

  function fail(name, message) {
    if (name === "TypeError") return new TypeError(message);
    return new DOMException(message, name);
  }

  function syncCall(op, path, query, body) {
    const xhr = new XMLHttpRequest();
    const origin = self.location && String(self.location.origin || "").indexOf("http") === 0
      ? self.location.origin
      : "";
    let url = origin + "/__hog/opfs?op=" + encodeURIComponent(op) + "&path=" + encodeURIComponent(path || "");
    if (query) url += query.charAt(0) === "&" ? query : "&" + query;
    xhr.open("POST", url, false);
    xhr.send(body === undefined ? null : body);
    const text = xhr.responseText || "";
    if (xhr.status === 404) throw fail("NotFoundError", text || "Missing");
    if (xhr.status === 409 && text === "mismatch") throw fail("TypeMismatchError", "Wrong entry type");
    if (xhr.status === 409 && text === "not empty") throw fail("InvalidModificationError", "Directory is not empty");
    if (xhr.status === 409) throw fail("NoModificationAllowedError", text || "File is already open");
    if (xhr.status !== 200) throw fail("NotReadableError", text || "Storage failed");
    return text;
  }

  function childPath(parent, name) {
    const label = String(name || "");
    if (!label || label === "." || label === ".." || /[\\/\0]/.test(label)) {
      throw fail("TypeError", "Bad file name");
    }
    return parent ? parent + "/" + label : label;
  }

  function fromB64(text) {
    if (!text) return new Uint8Array(0);
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toU8(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    return new Uint8Array(buffer);
  }

  function makeAccess(path, token) {
    const timer = setInterval(() => {
      try { syncCall("touch", path, "&token=" + encodeURIComponent(token)); } catch (e) {}
    }, 10000);
    let closed = false;
    return {
      read(buffer, options) {
        const view = toU8(buffer);
        const at = options && options.at ? Number(options.at) : 0;
        const bytes = fromB64(syncCall("read", path, "&at=" + at + "&len=" + view.byteLength));
        const n = Math.min(view.byteLength, bytes.byteLength);
        if (n) view.set(bytes.subarray(0, n));
        return n;
      },
      write(buffer, options) {
        const view = toU8(buffer);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        const at = options && options.at ? Number(options.at) : 0;
        return Number(syncCall("write", path, "&at=" + at, copy));
      },
      flush() {
        syncCall("flush", path);
        return Promise.resolve();
      },
      getSize() {
        return Promise.resolve(Number(syncCall("size", path)));
      },
      truncate(size) {
        syncCall("truncate", path, "&size=" + Number(size));
        return Promise.resolve();
      },
      close() {
        if (closed) return Promise.resolve();
        closed = true;
        clearInterval(timer);
        try { syncCall("flush", path); } catch (e) {}
        syncCall("unlock", path, "&token=" + encodeURIComponent(token));
        return Promise.resolve();
      },
    };
  }

  function makeFile(path) {
    return {
      kind: "file",
      path,
      getFile() {
        const size = Number(syncCall("size", path));
        return Promise.resolve({
          size,
          slice(start, end) {
            const from = Number(start || 0);
            const to = end == null ? size : Number(end);
            return {
              arrayBuffer() {
                const bytes = fromB64(syncCall("read", path, "&at=" + from + "&len=" + Math.max(0, to - from)));
                return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
              },
            };
          },
        });
      },
      createWritable() {
        return Promise.resolve({
          truncate(size) {
            syncCall("truncate", path, "&size=" + Number(size));
            return Promise.resolve();
          },
          close() {
            return Promise.resolve();
          },
        });
      },
      createSyncAccessHandle() {
        try {
          return Promise.resolve(makeAccess(path, syncCall("lock", path)));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      move(dest, name) {
        const to = childPath(dest && dest.path, name);
        syncCall("move", path, "&to=" + encodeURIComponent(to));
        path = to;
        this.path = to;
        return Promise.resolve();
      },
    };
  }

  function makeDir(path) {
    return {
      kind: "directory",
      path,
      getFileHandle(name, options) {
        try {
          const next = childPath(path, name);
          const kind = syncCall("stat", next);
          if (kind === "directory") throw fail("TypeMismatchError", "Not a file");
          if (kind === "missing") {
            if (!(options && options.create)) throw fail("NotFoundError", "Missing");
            syncCall("create", next);
          }
          return Promise.resolve(makeFile(next));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      getDirectoryHandle(name, options) {
        try {
          const next = childPath(path, name);
          const kind = syncCall("stat", next);
          if (kind === "file") throw fail("TypeMismatchError", "Not a directory");
          if (kind === "missing") {
            if (!(options && options.create)) throw fail("NotFoundError", "Missing");
            syncCall("mkdir", next);
          }
          return Promise.resolve(makeDir(next));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      removeEntry(name, options) {
        try {
          const query = options && options.recursive ? "&recursive=1" : "";
          syncCall("remove", childPath(path, name), query);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      entries() {
        let items = null;
        let index = 0;
        return {
          next() {
            try {
              if (!items) items = JSON.parse(syncCall("list", path));
              if (index >= items.length) return Promise.resolve({ done: true, value: undefined });
              const item = items[index];
              index += 1;
              const next = childPath(path, item.name);
              const handle = item.kind === "directory" ? makeDir(next) : makeFile(next);
              return Promise.resolve({ done: false, value: [item.name, handle] });
            } catch (error) {
              return Promise.reject(error);
            }
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  const getDirectory = () => Promise.resolve(makeDir(""));

  function createSyncAccessHandle() {
    if (this && typeof this.path === "string") {
      try {
        return Promise.resolve(makeAccess(this.path, syncCall("lock", this.path)));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return Promise.reject(fail("NotReadableError", "Hog stores this file on disk"));
  }

  function install() {
    const Storage = globalThis.StorageManager;
    const proto = (typeof navigator !== "undefined" && navigator.storage && Object.getPrototypeOf(navigator.storage))
      || (typeof Storage === "function" ? Storage.prototype : null);
    if (proto) {
      try {
        Object.defineProperty(proto, "getDirectory", {
          configurable: true,
          enumerable: true,
          get() { return getDirectory; },
          set() {},
        });
      } catch (e) {}
    }
    try {
      if (navigator.storage && Object.prototype.hasOwnProperty.call(navigator.storage, "getDirectory")) {
        delete navigator.storage.getDirectory;
      }
    } catch (e) {}
    if (typeof navigator !== "undefined" && !navigator.storage) {
      try { navigator.storage = { getDirectory }; } catch (e) {}
    }
    try {
      if (navigator.storage && navigator.storage.getDirectory !== getDirectory) {
        navigator.storage.getDirectory = getDirectory;
      }
    } catch (e) {}
    const NativeFile = globalThis.FileSystemFileHandle;
    if (typeof NativeFile === "function" && NativeFile.prototype) {
      try {
        Object.defineProperty(NativeFile.prototype, "createSyncAccessHandle", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: createSyncAccessHandle,
        });
      } catch (e) {
        try { NativeFile.prototype.createSyncAccessHandle = createSyncAccessHandle; } catch (err) {}
      }
    } else if (typeof NativeFile !== "function") {
      function FileSystemFileHandle() {}
      FileSystemFileHandle.prototype.createSyncAccessHandle = createSyncAccessHandle;
      globalThis.FileSystemFileHandle = FileSystemFileHandle;
    }
  }

  install();
})();
/* hog-opfs-end */
