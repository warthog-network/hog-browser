/* Hog disk storage for the Warthog WASM node.
   WebKitGTK exposes the file system API, then rejects createSyncAccessHandle,
   so that browser talks to Hog's disk endpoint. Chromium's own storage works,
   but each SQLite page is a separate sync call; the wrapper below caches
   those reads and holds writes until flush. This runs inside wart-node.js,
   including its pthread worker. */
(() => {
  if (globalThis.__hogOpfs) return;
  globalThis.__hogOpfs = true;
  // navigator.userAgentData exists only in Chromium, in pages and workers.
  let chromium = false;
  try {
    chromium = typeof navigator !== "undefined" && !!navigator.userAgentData
      && typeof FileSystemFileHandle !== "undefined"
      && typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function";
  } catch (e) {}
  if (chromium) {
    installChromiumCache();
    return;
  }

  // Read cache and write holding for Chromium's native sync file handles.
  // SQLite flushes when a commit must reach disk. Log files never flush, so
  // held bytes are written after HOLD_MS even without one. Durability of the
  // chain matches the browser: flush() still calls the native flush.
  function installChromiumCache() {
    const NativeFile = globalThis.FileSystemFileHandle;
    const nativeOpen = NativeFile && NativeFile.prototype && NativeFile.prototype.createSyncAccessHandle;
    if (typeof nativeOpen !== "function" || nativeOpen.__hogCached) return;
    const CHUNK = 64 * 1024;
    const CACHE_CHUNKS = 1024;
    const PENDING_LIMIT = 8 * 1024 * 1024;
    const PENDING_HARD_LIMIT = 64 * 1024 * 1024;
    const HOLD_MS = 2000;

    function wrapNativeAccess(raw) {
      const cache = new Map();
      const dirty = new Map();
      let pendingBytes = 0;
      let pendingSince = 0;
      let size = 0;
      let sizeKnown = false;
      let closed = false;

      function ensure(index) {
        const hit = cache.get(index);
        if (hit) {
          cache.delete(index);
          cache.set(index, hit);
          return hit;
        }
        const bytes = new Uint8Array(CHUNK);
        const n = Number(raw.read(bytes, { at: index * CHUNK }));
        if (!Number.isFinite(n) || n < 0) throw new TypeError("Short read");
        const entry = { bytes, valid: n };
        cache.set(index, entry);
        if (n > 0 && n < CHUNK) {
          size = Math.max(size, index * CHUNK + n);
          sizeKnown = true;
        } else if (n === 0 && index === 0) {
          size = Math.max(size, 0);
          sizeKnown = true;
        } else if (n === CHUNK && size < (index + 1) * CHUNK) {
          size = (index + 1) * CHUNK;
        }
        evict();
        return entry;
      }

      function evict() {
        while (cache.size > CACHE_CHUNKS) {
          let dropped = false;
          for (const index of cache.keys()) {
            if (dirty.has(index)) continue;
            cache.delete(index);
            dropped = true;
            break;
          }
          if (dropped) continue;
          writeBack();
          const oldest = cache.keys().next().value;
          if (oldest == null) break;
          cache.delete(oldest);
        }
      }

      function writeBack() {
        if (!dirty.size) return;
        for (const [index, range] of dirty) {
          const entry = cache.get(index);
          if (!entry) continue;
          const slice = entry.bytes.subarray(range.lo, range.hi);
          const n = Number(raw.write(slice, { at: index * CHUNK + range.lo }));
          if (n !== slice.byteLength) throw new TypeError("Short write");
        }
        dirty.clear();
        pendingBytes = 0;
        pendingSince = 0;
      }

      function sendAged(force) {
        if (closed || !dirty.size) return;
        if (!force && pendingBytes < PENDING_LIMIT && Date.now() - pendingSince < HOLD_MS) return;
        try {
          writeBack();
        } catch (error) {
          if (force || pendingBytes >= PENDING_HARD_LIMIT) throw error;
        }
      }

      const timer = setInterval(() => {
        try { sendAged(false); } catch (e) {}
      }, 1000);

      function finishClose() {
        if (closed) return Promise.resolve();
        sendAged(true);
        const flushed = raw.flush();
        const after = flushed && typeof flushed.then === "function" ? flushed : Promise.resolve();
        return after.then(() => {
          closed = true;
          clearInterval(timer);
          return raw.close();
        });
      }

      return {
        read(buffer, options) {
          const view = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
          const at = options && options.at ? Number(options.at) : 0;
          let done = 0;
          while (done < view.byteLength) {
            const pos = at + done;
            const index = Math.floor(pos / CHUNK);
            const offset = pos - index * CHUNK;
            const entry = ensure(index);
            if (offset >= entry.valid) break;
            const take = Math.min(view.byteLength - done, entry.valid - offset);
            view.set(entry.bytes.subarray(offset, offset + take), done);
            done += take;
          }
          return done;
        },
        write(buffer, options) {
          const view = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
          const at = options && options.at ? Number(options.at) : 0;
          if (!view.byteLength) return 0;
          const bytes = new Uint8Array(view.byteLength);
          bytes.set(view);
          const first = Math.floor(at / CHUNK);
          const last = Math.floor((at + bytes.byteLength - 1) / CHUNK);
          for (let index = first; index <= last; index += 1) {
            const entry = ensure(index);
            const base = index * CHUNK;
            const from = Math.max(base, at);
            const to = Math.min(base + CHUNK, at + bytes.byteLength);
            entry.bytes.set(bytes.subarray(from - at, to - at), from - base);
            const end = to - base;
            if (end > entry.valid) entry.valid = end;
            // Dirty before the next chunk is loaded. Eviction must not drop
            // bytes this write just placed.
            const lo = from - base;
            const hi = to - base;
            const prev = dirty.get(index);
            dirty.set(index, prev ? { lo: Math.min(prev.lo, lo), hi: Math.max(prev.hi, hi) } : { lo, hi });
          }
          if (!pendingBytes) pendingSince = Date.now();
          pendingBytes += bytes.byteLength;
          const end = at + bytes.byteLength;
          if (end > size) size = end;
          sendAged(false);
          return bytes.byteLength;
        },
        flush() {
          try {
            sendAged(true);
            const out = raw.flush();
            return out && typeof out.then === "function" ? out : Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        },
        getSize() {
          if (sizeKnown) return Promise.resolve(size);
          return Promise.resolve(raw.getSize()).then((n) => {
            const native = Number(n) || 0;
            size = Math.max(size, native);
            sizeKnown = true;
            return size;
          });
        },
        truncate(next) {
          try {
            sendAged(true);
            const target = Number(next);
            const out = raw.truncate(target);
            const apply = () => {
              size = target;
              sizeKnown = true;
              const keep = Math.floor(target / CHUNK);
              for (const index of Array.from(cache.keys())) {
                if (index > keep) cache.delete(index);
              }
              for (const index of Array.from(dirty.keys())) {
                if (index > keep) dirty.delete(index);
              }
              const edge = cache.get(keep);
              if (edge) {
                const within = target - keep * CHUNK;
                if (edge.valid > within) edge.valid = within;
                edge.bytes.fill(0, within);
                const range = dirty.get(keep);
                if (range && range.lo >= within) dirty.delete(keep);
                else if (range && range.hi > within) range.hi = within;
              }
            };
            return Promise.resolve(out).then(apply);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        close() {
          try {
            return Promise.resolve(finishClose());
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
    }

    function createSyncAccessHandle(...args) {
      return Promise.resolve(nativeOpen.apply(this, args)).then(wrapNativeAccess);
    }
    Object.defineProperty(createSyncAccessHandle, "length", { value: nativeOpen.length });
    createSyncAccessHandle.__hogCached = true;
    try {
      Object.defineProperty(NativeFile.prototype, "createSyncAccessHandle", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createSyncAccessHandle,
      });
    } catch (e) {
      NativeFile.prototype.createSyncAccessHandle = createSyncAccessHandle;
    }
  }

  function fail(name, message) {
    if (name === "TypeError") return new TypeError(message);
    return new DOMException(message, name);
  }

  // Hog's endpoint is one synchronous HTTP request per storage call, millions
  // of them during a mainnet sync. One lost request used to surface as an
  // SQLite "disk I/O error" and stop the node, so transient failures (network
  // errors, 5xx) are retried with a short backoff. Every call is safe to repeat:
  // reads and sizes are pure, writes carry their offsets, truncate/flush/mkdir/
  // create are idempotent on the server, and lock carries a client token.
  // ~31 s in all: long enough to ride out a machine that is briefly out of
  // memory or swamped (a game loading, say), short enough to report a real outage.
  const RETRY_DELAYS = globalThis.__hogOpfsRetryDelays || [5, 20, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 15000];
  // GET and PUT reuse one keep-alive connection in WebKitGTK; libsoup opens a
  // new TCP connection for every POST. remove/move stay POST so libsoup never
  // resends them on its own (a silent resend of a finished remove is a 404).
  const READ_OPS = { stat: 1, list: 1, size: 1, read: 1 };
  const POST_OPS = { remove: 1, move: 1 };
  const stats = { requests: 0, retries: 0, failures: 0 };
  globalThis.__hogOpfsStats = stats;
  let sleepCell = null;

  function pause(ms) {
    try {
      if (!sleepCell) sleepCell = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleepCell, 0, 0, ms);
      return;
    } catch (e) {
      // The page's main thread may not block in Atomics.wait; spin instead.
    }
    const end = Date.now() + ms;
    while (Date.now() < end) { /* wait */ }
  }

  function transient(status) {
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  function reportFailure(op, path, status) {
    stats.failures += 1;
    try {
      const channel = new BroadcastChannel("hog-opfs");
      channel.postMessage({ type: "storage-failure", op, path, status, at: Date.now() });
      channel.close();
    } catch (e) {}
  }

  function requestOnce(op, path, query, body, retry) {
    const origin = self.location && String(self.location.origin || "").indexOf("http") === 0
      ? self.location.origin
      : "";
    let url = origin + "/__hog/opfs?op=" + encodeURIComponent(op) + "&path=" + encodeURIComponent(path || "");
    if (query) url += query.charAt(0) === "&" ? query : "&" + query;
    if (retry) url += "&retry=" + retry;
    const method = READ_OPS[op] ? "GET" : POST_OPS[op] ? "POST" : "PUT";
    stats.requests += 1;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, false);
      xhr.send(body === undefined || method === "GET" ? null : body);
      return { status: Number(xhr.status) || 0, text: xhr.responseText || "" };
    } catch (e) {
      return { status: 0, text: "Storage request failed" };
    }
  }

  function interpret(status, text) {
    if (status === 404) throw fail("NotFoundError", text || "Missing");
    if (status === 409 && text === "mismatch") throw fail("TypeMismatchError", "Wrong entry type");
    if (status === 409 && text === "not empty") throw fail("InvalidModificationError", "Directory is not empty");
    if (status === 409) throw fail("NoModificationAllowedError", text || "File is already open");
    if (status !== 200) throw fail("NotReadableError", text || "Storage failed");
    return text;
  }

  function syncCall(op, path, query, body, options) {
    const retries = options && options.retries != null ? options.retries : RETRY_DELAYS.length;
    for (let attempt = 0; ; attempt += 1) {
      const out = requestOnce(op, path, query, body, attempt);
      if (transient(out.status) && attempt < retries) {
        stats.retries += 1;
        pause(RETRY_DELAYS[attempt]);
        continue;
      }
      if (attempt > 0 && out.status !== 200) {
        // An earlier try may have finished on the server before its reply was lost.
        if (op === "remove" && out.status === 404) return "ok";
        if (op === "move" && options && options.to && !transient(out.status)) {
          let moved = false;
          try {
            moved = syncCall("stat", path) === "missing" && syncCall("stat", options.to) !== "missing";
          } catch (e) {}
          if (moved) return "ok";
        }
      }
      if (transient(out.status)) reportFailure(op, path, out.status);
      return interpret(out.status, out.text);
    }
  }

  function newToken() {
    const bytes = new Uint8Array(12);
    try {
      crypto.getRandomValues(bytes);
    } catch (e) {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] + 256).toString(16).slice(1);
    return out;
  }

  // The token travels with the request, so a retried lock whose first try
  // already succeeded is recognised as ours instead of "already open".
  function lockCall(path) {
    const token = newToken();
    syncCall("lock", path, "&token=" + token);
    return token;
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

  // Every storage call is a synchronous HTTP round trip (~0.3-0.6 ms in
  // WebKitGTK), while the chain database does thousands of small page reads
  // and writes per block batch. The sync handle is exclusive (Hog's lock), so
  // it can keep a read cache and hold writes until flush() without anyone else
  // seeing stale data. Durability is unchanged: flush() still reaches the disk
  // and fsyncs before it returns, which is what SQLite relies on.
  const CHUNK = 64 * 1024;
  const CACHE_CHUNKS = 1024; // 64 MiB of read cache per open file
  const PENDING_LIMIT = 8 * 1024 * 1024;
  // Held writes are never dropped. If an early push fails they stay held and
  // the next flush()/close() sends them or reports the error; past this much
  // held data the write itself reports it.
  const PENDING_HARD_LIMIT = 64 * 1024 * 1024;
  const TOUCH_MS = 10000;
  // Writes are held at most this long before the next write or lock refresh
  // sends them. Log files are never flushed by the node, so without this they
  // stayed in memory until the page closed and were lost.
  const HOLD_MS = 2000;
  const openHandles = new Map();

  function encodeWrites(list) {
    let total = 0;
    for (const item of list) total += 12 + item.bytes.byteLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const item of list) {
      view.setFloat64(pos, item.at, true);
      view.setUint32(pos + 8, item.bytes.byteLength, true);
      out.set(item.bytes, pos + 12);
      pos += 12 + item.bytes.byteLength;
    }
    return out;
  }

  function makeAccess(path, token) {
    let lastTouch = Date.now();
    function touch() {
      lastTouch = Date.now();
      try { syncCall("touch", path, "&token=" + encodeURIComponent(token), undefined, { retries: 2 }); } catch (e) {}
      sendAged();
    }
    // A thread busy in long synchronous work may not run its timers; storage
    // calls refresh the lock too so it never lapses under an active node.
    function keepLock() {
      if (Date.now() - lastTouch > 2 * TOUCH_MS) touch();
    }
    let size;
    try {
      size = Number(syncCall("size", path));
    } catch (error) {
      try { syncCall("unlock", path, "&token=" + encodeURIComponent(token)); } catch (e) {}
      throw error;
    }
    const timer = setInterval(touch, TOUCH_MS);
    let closed = false;
    let diskSize = size; // bytes the server file holds; chunks past it need no read
    const cache = new Map(); // chunk index -> Uint8Array(CHUNK), insertion order = LRU
    let pending = []; // { at, bytes } in write order, not yet on disk
    let pendingBytes = 0;
    let pendingSince = 0;

    // An early push that fails is not fatal: the writes stay held and
    // flush()/close() retries and reports. Only refuse to grow forever.
    function sendAged(force) {
      if (closed || !pending.length) return;
      if (!force && pendingBytes < PENDING_LIMIT && Date.now() - pendingSince < HOLD_MS) return;
      try {
        push(false);
      } catch (error) {
        if (pendingBytes >= PENDING_HARD_LIMIT) throw error;
      }
    }

    function overlay(index, chunk) {
      const base = index * CHUNK;
      for (const item of pending) {
        const from = Math.max(base, item.at);
        const to = Math.min(base + CHUNK, item.at + item.bytes.byteLength);
        if (from < to) chunk.set(item.bytes.subarray(from - item.at, to - item.at), from - base);
      }
    }

    function chunkAt(index) {
      let chunk = cache.get(index);
      if (chunk) {
        cache.delete(index);
        cache.set(index, chunk);
        return chunk;
      }
      chunk = new Uint8Array(CHUNK);
      const base = index * CHUNK;
      if (base < diskSize) {
        const bytes = fromB64(syncCall("read", path, "&at=" + base + "&len=" + CHUNK));
        chunk.set(bytes.subarray(0, Math.min(bytes.byteLength, CHUNK)));
      }
      overlay(index, chunk);
      cache.set(index, chunk);
      while (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value);
      return chunk;
    }

    function push(sync) {
      keepLock();
      if (pending.length) {
        const body = encodeWrites(pending);
        // Throws after retries; the writes stay held for the next push.
        syncCall("writev", path, sync ? "&sync=1" : "", body);
        for (const item of pending) diskSize = Math.max(diskSize, item.at + item.bytes.byteLength);
        pending = [];
        pendingBytes = 0;
      } else if (sync) {
        syncCall("flush", path);
      }
    }

    function finishClose() {
      if (closed) return;
      try {
        push(true);
      } catch (error) {
        // Keep the handle, its held writes and its lock: closing now would
        // lose data SQLite believes is written. A later close() or a reopen
        // of this file retries the flush.
        handle.__hogCloseFailed = true;
        throw error;
      }
      closed = true;
      handle.__hogCloseFailed = false;
      clearInterval(timer);
      if (openHandles.get(path) === handle) openHandles.delete(path);
      cache.clear();
      try {
        syncCall("unlock", path, "&token=" + encodeURIComponent(token));
      } catch (e) {
        // The data is on disk; an unreleased lock lapses on its own in 60 s.
      }
    }

    const handle = {
      read(buffer, options) {
        keepLock();
        const view = toU8(buffer);
        const at = options && options.at ? Number(options.at) : 0;
        const n = Math.max(0, Math.min(view.byteLength, size - at));
        let done = 0;
        while (done < n) {
          const pos = at + done;
          const index = Math.floor(pos / CHUNK);
          const offset = pos - index * CHUNK;
          const take = Math.min(n - done, CHUNK - offset);
          view.set(chunkAt(index).subarray(offset, offset + take), done);
          done += take;
        }
        return n;
      },
      write(buffer, options) {
        const view = toU8(buffer);
        const at = options && options.at ? Number(options.at) : 0;
        const bytes = new Uint8Array(view.byteLength);
        bytes.set(view);
        if (!bytes.byteLength) return 0;
        if (!pending.length) pendingSince = Date.now();
        pending.push({ at, bytes });
        pendingBytes += bytes.byteLength;
        const first = Math.floor(at / CHUNK);
        const last = Math.floor((at + bytes.byteLength - 1) / CHUNK);
        for (let index = first; index <= last; index += 1) {
          const chunk = cache.get(index);
          if (!chunk) continue;
          const base = index * CHUNK;
          const from = Math.max(base, at);
          const to = Math.min(base + CHUNK, at + bytes.byteLength);
          chunk.set(bytes.subarray(from - at, to - at), from - base);
        }
        size = Math.max(size, at + bytes.byteLength);
        sendAged(false);
        return bytes.byteLength;
      },
      flush() {
        push(true);
        return Promise.resolve();
      },
      getSize() {
        return Promise.resolve(size);
      },
      truncate(next) {
        push(false);
        const target = Number(next);
        syncCall("truncate", path, "&size=" + target);
        size = target;
        diskSize = target;
        const keep = Math.floor(target / CHUNK);
        for (const index of Array.from(cache.keys())) {
          if (index > keep) cache.delete(index);
        }
        const edge = cache.get(keep);
        if (edge) edge.fill(0, target - keep * CHUNK);
        return Promise.resolve();
      },
      close() {
        try {
          finishClose();
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve();
      },
      __hogFinishClose() {
        finishClose();
      },
      __hogPush() {
        push(false);
      },
      __hogDiscard() {
        // The file was deleted: its held writes have nowhere to go.
        pending = [];
        pendingBytes = 0;
        cache.clear();
      },
    };
    openHandles.set(path, handle);
    return handle;
  }

  // Reads and renames that bypass the sync handle must see its held writes.
  function settle(path) {
    const open = openHandles.get(path);
    if (open) open.__hogPush();
  }

  function discardUnder(path) {
    for (const [key, open] of openHandles) {
      if (key === path || key.indexOf(path + "/") === 0) open.__hogDiscard();
    }
  }

  // A handle whose close() failed still holds this file's lock in this thread.
  // Finish that close (or report why it still fails) before locking again.
  function openAccess(path) {
    const stale = openHandles.get(path);
    if (stale && stale.__hogCloseFailed) stale.__hogFinishClose();
    return makeAccess(path, lockCall(path));
  }

  function makeFile(path) {
    return {
      kind: "file",
      path,
      getFile() {
        settle(path);
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
          return Promise.resolve(openAccess(path));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      move(dest, name) {
        const to = childPath(dest && dest.path, name);
        settle(path);
        syncCall("move", path, "&to=" + encodeURIComponent(to), undefined, { to });
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
          const target = childPath(path, name);
          syncCall("remove", target, query);
          discardUnder(target);
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
        return Promise.resolve(openAccess(this.path));
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
