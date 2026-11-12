// This code implements the `-sMODULARIZE` settings by taking the generated
// JS program code (INNER_JS_CODE) and wrapping it in a factory function.

// When targeting node and ES6 we use `await import ..` in the generated code
// so the outer function needs to be marked as async.
async function Module(moduleArg = {}) {
  var moduleRtn;

// include: shell.js
// include: minimum_runtime_check.js
(function() {
  // "30.0.0" -> 300000
  function humanReadableVersionToPacked(str) {
    str = str.split("-")[0];
    // Remove any trailing part from e.g. "12.53.3-alpha"
    var vers = str.split(".").slice(0, 3);
    while (vers.length < 3) vers.push("00");
    vers = vers.map((n, i, arr) => n.padStart(2, "0"));
    return vers.join("");
  }
  // 300000 -> "30.0.0"
  var packedVersionToHumanReadable = n => [ n / 1e4 | 0, (n / 100 | 0) % 100, n % 100 ].join(".");
  var TARGET_NOT_SUPPORTED = 2147483647;
  // Note: We use a typeof check here instead of optional chaining using
  // globalThis because older browsers might not have globalThis defined.
  var currentNodeVersion = typeof process !== "undefined" && process.versions?.node ? humanReadableVersionToPacked(process.versions.node) : TARGET_NOT_SUPPORTED;
  if (currentNodeVersion < TARGET_NOT_SUPPORTED) {
    throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
  }
  if (currentNodeVersion < 2147483647) {
    throw new Error(`This emscripten-generated code requires node v${packedVersionToHumanReadable(2147483647)} (detected v${packedVersionToHumanReadable(currentNodeVersion)})`);
  }
  var userAgent = typeof navigator !== "undefined" && navigator.userAgent;
  if (!userAgent) {
    return;
  }
  var currentSafariVersion = userAgent.includes("Safari/") && !userAgent.includes("Chrome/") && userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/) ? humanReadableVersionToPacked(userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentSafariVersion < 15e4) {
    throw new Error(`This emscripten-generated code requires Safari v${packedVersionToHumanReadable(15e4)} (detected v${currentSafariVersion})`);
  }
  var currentFirefoxVersion = userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/) ? parseFloat(userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentFirefoxVersion < 114) {
    throw new Error(`This emscripten-generated code requires Firefox v114 (detected v${currentFirefoxVersion})`);
  }
  var currentChromeVersion = userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/) ? parseFloat(userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentChromeVersion < 85) {
    throw new Error(`This emscripten-generated code requires Chrome v85 (detected v${currentChromeVersion})`);
  }
})();

// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = moduleArg;

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() running directly in a worker. (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)
// The way we signal to a worker that it is hosting a pthread is to construct
// it with a specific name.
var ENVIRONMENT_IS_PTHREAD = ENVIRONMENT_IS_WORKER && globalThis.name?.startsWith("em-pthread");

if (ENVIRONMENT_IS_PTHREAD) {
  assert(!globalThis.moduleLoaded, "module should only be loaded once on each pthread worker");
  globalThis.moduleLoaded = true;
}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

var _scriptName = import.meta.url;

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_SHELL) {} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  if (!(globalThis.window || globalThis.WorkerGlobalScope)) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
  {
    // include: web_or_worker_shell_read.js
    if (ENVIRONMENT_IS_WORKER) {
      readBinary = url => {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
      };
    }
    readAsync = async url => {
      assert(!isFileURI(url), "readAsync does not work with file:// URLs");
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {
  throw new Error("environment detection error");
}

var out = console.log.bind(console);

var err = console.error.bind(console);

var IDBFS = "IDBFS is no longer included by default; build with -lidbfs.js";

var PROXYFS = "PROXYFS is no longer included by default; build with -lproxyfs.js";

var WORKERFS = "WORKERFS is no longer included by default; build with -lworkerfs.js";

var FETCHFS = "FETCHFS is no longer included by default; build with -lfetchfs.js";

var ICASEFS = "ICASEFS is no longer included by default; build with -licasefs.js";

var JSFILEFS = "JSFILEFS is no longer included by default; build with -ljsfilefs.js";

var OPFS = "OPFS is no longer included by default; build with -lopfs.js";

var NODEFS = "NODEFS is no longer included by default; build with -lnodefs.js";

// perform assertions in shell.js after we set up out() and err(), as otherwise
// if an assertion fails it cannot print the message
assert(ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_NODE, "pthreads do not work in this environment yet (need Web Workers, or an alternative to them)");

assert(!ENVIRONMENT_IS_NODE, "node environment detected but not enabled at build time (add `node` to `-sENVIRONMENT` to enable)");

assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time (add `shell` to `-sENVIRONMENT` to enable)");

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

if (!globalThis.WebAssembly) {
  err("no native wasm support detected");
}

// Wasm globals
// For sending to workers.
var wasmModule;

//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */ function assert(condition, text) {
  if (!condition) {
    abort("Assertion failed" + (text ? ": " + text : ""));
  }
}

// We used to include malloc/free by default in the past. Show a helpful error in
// builds with assertions.
/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

// include: runtime_common.js
// include: runtime_stack_check.js
// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  var max = _emscripten_stack_get_end();
  assert((max & 3) == 0);
  // If the stack ends at address zero we write our cookies 4 bytes into the
  // stack.  This prevents interference with SAFE_HEAP and ASAN which also
  // monitor writes to address zero.
  if (max == 0) {
    max += 4;
  }
  // The stack grow downwards towards _emscripten_stack_get_end.
  // We write cookies to the final two words in the stack and detect if they are
  // ever overwritten.
  (growMemViews(), HEAPU32)[((max) >> 2)] = 34821223;
  (growMemViews(), HEAPU32)[(((max) + (4)) >> 2)] = 2310721022;
  // Also test the global address 0 for integrity.
  (growMemViews(), HEAPU32)[((0) >> 2)] = 1668509029;
}

function checkStackCookie() {
  if (ABORT) return;
  var max = _emscripten_stack_get_end();
  // See writeStackCookie().
  if (max == 0) {
    max += 4;
  }
  var cookie1 = (growMemViews(), HEAPU32)[((max) >> 2)];
  var cookie2 = (growMemViews(), HEAPU32)[(((max) + (4)) >> 2)];
  if (cookie1 != 34821223 || cookie2 != 2310721022) {
    abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
  }
  // Also test the global address 0 for integrity.
  if ((growMemViews(), HEAPU32)[((0) >> 2)] != 1668509029) {
    abort("Runtime error: The application has corrupted its heap memory area (address zero)!");
  }
}

// end include: runtime_stack_check.js
// include: runtime_exceptions.js
// Base Emscripten EH error class
class EmscriptenEH extends Error {}

class EmscriptenSjLj extends EmscriptenEH {}

class CppException extends EmscriptenEH {
  constructor(excPtr) {
    super(excPtr);
    this.excPtr = excPtr;
    const excInfo = getExceptionMessage(this);
    this.name = excInfo[0];
    this.message = excInfo[1];
  }
}

// end include: runtime_exceptions.js
// include: runtime_debug.js
var runtimeDebug = true;

// Switch to false at runtime to disable logging at the right times
// Used by XXXXX_DEBUG settings to output debug messages.
function dbg(...args) {
  if (!runtimeDebug && typeof runtimeDebug != "undefined") return;
  // TODO(sbc): Make this configurable somehow.  Its not always convenient for
  // logging to show up as warnings.
  console.warn(...args);
}

// Endianness check
(() => {
  var h16 = new Int16Array(1);
  var h8 = new Int8Array(h16.buffer);
  h16[0] = 25459;
  if (h8[0] !== 115 || h8[1] !== 99) abort("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
})();

function consumedModuleProp(prop) {
  if (!Object.getOwnPropertyDescriptor(Module, prop)) {
    Object.defineProperty(Module, prop, {
      configurable: true,
      set() {
        abort(`Attempt to set \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
      }
    });
  }
}

function makeInvalidEarlyAccess(name) {
  return () => assert(false, `call to '${name}' via reference taken before Wasm module initialization`);
}

function ignoredModuleProp(prop) {
  if (Object.getOwnPropertyDescriptor(Module, prop)) {
    abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
  }
}

// forcing the filesystem exports a few things by default
function isExportedByForceFilesystem(name) {
  return name === "FS_createPath" || name === "FS_createDataFile" || name === "FS_createPreloadedFile" || name === "FS_preloadFile" || name === "FS_unlink" || name === "addRunDependency" || name === "removeRunDependency";
}

function missingLibrarySymbol(sym) {
  // Any symbol that is not included from the JS library is also (by definition)
  // not exported on the Module object.
  unexportedRuntimeSymbol(sym);
}

function unexportedRuntimeSymbol(sym) {
  if (ENVIRONMENT_IS_PTHREAD) {
    return;
  }
  if (!Object.getOwnPropertyDescriptor(Module, sym)) {
    Object.defineProperty(Module, sym, {
      configurable: true,
      get() {
        var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
        if (isExportedByForceFilesystem(sym)) {
          msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
        }
        abort(msg);
      }
    });
  }
}

/**
 * Override `err`/`out`/`dbg` to report thread / worker information
 */ function initWorkerLogging() {
  function getLogPrefix() {
    var t = 0;
    if (runtimeInitialized && typeof _pthread_self != "undefined") {
      t = _pthread_self();
    }
    return `w:${workerID},t:${ptrToString(t)}:`;
  }
  // Prefix all dbg() messages with the calling thread info.
  var origDbg = dbg;
  dbg = (...args) => origDbg(getLogPrefix(), ...args);
}

initWorkerLogging();

// end include: runtime_debug.js
// Support for growable heap + pthreads, where the buffer may change, so JS views
// must be updated.
function growMemViews() {
  // HEAP8 is unset until the pthread "load" message installs wasmMemory.
  // Chrome/Brave stable can run growMemViews in that window; .buffer on
  // undefined becomes an unhandledrejection (glue line ~401).
  if (!wasmMemory) return;
  if (!HEAP8 || wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}

var readyPromiseResolve, readyPromiseReject;

// include: runtime_pthread.js
// Pthread Web Worker handling code.
// This code runs only on pthread web workers and handles pthread setup
// and communication with the main thread via postMessage.
// Unique ID of the current pthread worker (zero on non-pthread-workers
// including the main thread).
var workerID = 0;

var startWorker;

if (ENVIRONMENT_IS_PTHREAD) {
  // Thread-local guard variable for one-time init of the JS state
  var initializedJS = false;
  // Turn unhandled rejected promises into errors so that the main thread will be
  // notified about them.
  self.onunhandledrejection = e => {
    throw e.reason || e;
  };
  function handleMessage(e) {
    try {
      var msgData = e["data"];
      //dbg('msgData: ' + Object.keys(msgData));
      var cmd = msgData.cmd;
      if (cmd === "load") {
        // Preload command that is called once per worker to parse and load the Emscripten code.
        workerID = msgData.workerID;
        // Until we initialize the runtime, queue up any further incoming messages.
        let messageQueue = [];
        self.onmessage = e => messageQueue.push(e);
        // And add a callback for when the runtime is initialized.
        startWorker = () => {
          // Notify the main thread that this thread has loaded.
          postMessage({
            cmd: "loaded"
          });
          // Process any messages that were queued before the thread was ready.
          for (let msg of messageQueue) {
            handleMessage(msg);
          }
          // Restore the real message handler.
          self.onmessage = handleMessage;
        };
        // Use `const` here to ensure that the variable is scoped only to
        // that iteration, allowing safe reference from a closure.
        for (const handler of msgData.handlers) {
          // If the main module has a handler for a certain event, but no
          // handler exists on the pthread worker, then proxy that handler
          // back to the main thread.
          if (!Module[handler] || Module[handler].proxy) {
            Module[handler] = (...args) => {
              postMessage({
                cmd: "callHandler",
                handler,
                args
              });
            };
            // Rebind the out / err handlers if needed
            if (handler == "print") out = Module[handler];
            if (handler == "printErr") err = Module[handler];
          }
        }
        wasmMemory = msgData.wasmMemory;
        wasmModule = msgData.wasmModule;
        if (!wasmMemory) {
          throw new Error("pthread load: wasmMemory missing from main thread");
        }
        updateMemoryViews();
        // createWasm is async; a throw becomes an unhandled rejection (line 401)
        // if we do not chain. Do not call run() until the instance exists.
        Promise.resolve(createWasm()).then(() => {
          run();
        }).catch((ex) => {
          err(`worker: createWasm failed: ${ex}`);
          if (ex?.stack) err(ex.stack);
          throw ex;
        });
      } else if (cmd === "run") {
        assert(msgData.pthread_ptr);
        // Call inside JS module to set up the stack frame for this pthread in JS module scope.
        // This needs to be the first thing that we do, as we cannot call to any C/C++ functions
        // until the thread stack is initialized.
        establishStackSpace(msgData.pthread_ptr);
        // Pass the thread address to wasm to store it for fast access.
        __emscripten_thread_init(msgData.pthread_ptr, /*is_main=*/ 0, /*is_runtime=*/ 0, /*can_block=*/ 1, 0, 0);
        PThread.threadInitTLS();
        // Await mailbox notifications with `Atomics.waitAsync` so we can start
        // using the fast `Atomics.notify` notification path.
        __emscripten_thread_mailbox_await(msgData.pthread_ptr);
        if (!initializedJS) {
          initializedJS = true;
        }
        try {
          invokeEntryPoint(msgData.start_routine, msgData.arg);
        } catch (ex) {
          if (ex != "unwind") {
            // The pthread "crashed".  Do not call `_emscripten_thread_exit` (which
            // would make this thread joinable).  Instead, re-throw the exception
            // and let the top level handler propagate it back to the main thread.
            throw ex;
          }
        }
      } else if (msgData.target === "setimmediate") {} else if (cmd === "checkMailbox") {
        if (initializedJS) {
          checkMailbox();
        }
      } else if (cmd) {
        // The received message looks like something that should be handled by this message
        // handler, (since there is a cmd field present), but is not one of the
        // recognized commands:
        err(`worker: received unknown command ${cmd}`);
        err(msgData);
      }
    } catch (ex) {
      err(`worker: onmessage() captured an uncaught exception: ${ex}`);
      if (ex?.stack) err(ex.stack);
      __emscripten_thread_crashed();
      throw ex;
    }
  }
  self.onmessage = handleMessage;
}

// ENVIRONMENT_IS_PTHREAD
// end include: runtime_pthread.js
// Memory management
var runtimeInitialized = false;

function updateMemoryViews() {
  if (!wasmMemory) {
    abort("updateMemoryViews: wasmMemory is not set (pthread load race)");
  }
  var b = wasmMemory.buffer;
  // Locals only. Module.HEAP* are getters (installLiveHeapExports) so WebRTC
  // never reads a stale/undefined snapshot after growth.
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}

// In non-standalone/normal mode, we create the memory here.
// include: runtime_init_memory.js
// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
function initMemory() {
  if ((ENVIRONMENT_IS_PTHREAD)) {
    return;
  }
  if (Module["wasmMemory"]) {
    wasmMemory = Module["wasmMemory"];
  } else {
    var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 8388608;
    assert(INITIAL_MEMORY >= 4194304, `INITIAL_MEMORY should be larger than STACK_SIZE, was ${INITIAL_MEMORY}! (STACK_SIZE=4194304)`);
    /** @suppress {checkTypes} */ wasmMemory = new WebAssembly.Memory({
      "initial": INITIAL_MEMORY / 65536,
      // In theory we should not need to emit the maximum if we want "unlimited"
      // or 4GB of memory, but VMs error on that atm, see
      // https://github.com/emscripten-core/emscripten/issues/14130
      // And in the pthreads case we definitely need to emit a maximum. So
      // always emit one.
      "maximum": 32768,
      "shared": true
    });
  }
  updateMemoryViews();
}

// end include: runtime_init_memory.js
// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
assert(globalThis.Int32Array && globalThis.Float64Array && Int32Array.prototype.subarray && Int32Array.prototype.set, "JS engine does not provide full typed array support");

function preRun() {
  assert(!ENVIRONMENT_IS_PTHREAD);
  // PThreads reuse the runtime from the main thread.
  if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
    while (Module["preRun"].length) {
      addOnPreRun(Module["preRun"].shift());
    }
  }
  consumedModuleProp("preRun");
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  assert(!runtimeInitialized);
  runtimeInitialized = true;
  if (ENVIRONMENT_IS_PTHREAD) return startWorker();
  checkStackCookie();
  // No ATINITS hooks
  wasmExports["__wasm_call_ctors"]();
}

function preMain() {
  checkStackCookie();
}

function postRun() {
  checkStackCookie();
  if ((ENVIRONMENT_IS_PTHREAD)) {
    return;
  }
  // PThreads reuse the runtime from the main thread.
  if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
    while (Module["postRun"].length) {
      addOnPostRun(Module["postRun"].shift());
    }
  }
  consumedModuleProp("postRun");
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/**
 * @param {string|number=} what
 */ function abort(what) {
  Module["onAbort"]?.(what);
  what = `Aborted(${what})`;
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
  readyPromiseReject?.(e);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

// show errors on likely calls to FS when it was not included
function fsMissing() {
  abort("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
}

var FS = {
  init: fsMissing,
  createDataFile: fsMissing,
  createPreloadedFile: fsMissing,
  createLazyFile: fsMissing,
  open: fsMissing,
  mkdev: fsMissing,
  registerDevice: fsMissing,
  analyzePath: fsMissing,
  ErrnoError: fsMissing
};

function createExportWrapper(name, nargs) {
  return (...args) => {
    assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
    var f = wasmExports[name];
    assert(f, `exported native function \`${name}\` not found`);
    // Only assert for too many arguments. Too few can be valid since the missing arguments will be zero filled.
    assert(args.length <= nargs, `native function \`${name}\` called with ${args.length} args but expects ${nargs}`);
    return f(...args);
  };
}

var wasmBinaryFile;

function findWasmBinary() {
  if (Module["locateFile"]) {
    return locateFile("wart-node.wasm");
  }
  // Use bundler-friendly `new URL(..., import.meta.url)` pattern; works in browsers too.
  return new URL("wart-node.wasm", import.meta.url).href;
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    // Warn on some common problems.
    if (isFileURI(binaryFile)) {
      err(`warning: Loading from a file URI (${binaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`);
    }
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  assignWasmImports();
  // prepare imports
  var imports = {
    "env": wasmImports,
    "wasi_snapshot_preview1": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    registerTLSInit(wasmExports["_emscripten_tls_init"]);
    assignWasmExports(wasmExports);
    // We now have the Wasm module loaded up, keep a reference to the compiled module so we can post it to the workers.
    wasmModule = module;
    return wasmExports;
  }
  // Prefer streaming instantiation if available.
  // Async compilation can be confusing when an error on the page overwrites Module
  // (for example, if the order of elements is wrong, and the one defining Module is
  // later), so we save Module and check it later.
  var trueModule = Module;
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    assert(Module === trueModule, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
    trueModule = null;
    return receiveInstance(result["instance"], result["module"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module["instantiateWasm"]) {
    return new Promise((resolve, reject) => {
      try {
        Module["instantiateWasm"](info, (inst, mod) => {
          resolve(receiveInstance(inst, mod));
        });
      } catch (e) {
        err(`Module.instantiateWasm callback failed with error: ${e}`);
        reject(e);
      }
    });
  }
  if ((ENVIRONMENT_IS_PTHREAD)) {
    // Instantiate from the module that was received via postMessage from
    // the main thread. We can just use sync instantiation in the worker.
    assert(wasmModule, "wasmModule should have been received via postMessage");
    var instance = new WebAssembly.Instance(wasmModule, getWasmImports());
    return receiveInstance(instance, wasmModule);
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

/** @type {!Int16Array} */ var HEAP16;

/** @type {!Int32Array} */ var HEAP32;

/** not-@type {!BigInt64Array} */ var HEAP64;

/** @type {!Int8Array} */ var HEAP8;

/** @type {!Float32Array} */ var HEAPF32;

/** @type {!Float64Array} */ var HEAPF64;

/** @type {!Uint16Array} */ var HEAPU16;

/** @type {!Uint32Array} */ var HEAPU32;

/** not-@type {!BigUint64Array} */ var HEAPU64;

/** @type {!Uint8Array} */ var HEAPU8;

var terminateWorker = worker => {
  worker.terminate();
  // terminate() can be asynchronous, so in theory the worker can continue
  // to run for some amount of time after termination.  However from our POV
  // the worker is now dead and we don't want to hear from it again, so we stub
  // out its message handler here.  This avoids having to check in each of
  // the onmessage handlers if the message was coming from a valid worker.
  worker.onmessage = e => {
    var cmd = e["data"].cmd;
    err(`received "${cmd}" command from terminated worker: ${worker.workerID}`);
  };
};

var cleanupThread = pthread_ptr => {
  assert(!ENVIRONMENT_IS_PTHREAD, "cleanupThread() should only be called from the main thread");
  assert(pthread_ptr, "null pthread_ptr passed to cleanupThread");
  var worker = PThread.pthreads[pthread_ptr];
  assert(worker);
  PThread.returnWorkerToPool(worker);
};

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var runDependencies = 0;

var dependenciesFulfilled = null;

var runDependencyTracking = {};

var runDependencyWatcher = null;

var removeRunDependency = id => {
  runDependencies--;
  Module["monitorRunDependencies"]?.(runDependencies);
  assert(id, "removeRunDependency requires an ID");
  assert(runDependencyTracking[id]);
  delete runDependencyTracking[id];
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback();
    }
  }
};

var addRunDependency = id => {
  runDependencies++;
  Module["monitorRunDependencies"]?.(runDependencies);
  assert(id, "addRunDependency requires an ID");
  assert(!runDependencyTracking[id]);
  runDependencyTracking[id] = 1;
  if (runDependencyWatcher === null && globalThis.setInterval) {
    // Check for missing dependencies every few seconds
    runDependencyWatcher = setInterval(() => {
      if (ABORT) {
        clearInterval(runDependencyWatcher);
        runDependencyWatcher = null;
        return;
      }
      var shown = false;
      for (var dep in runDependencyTracking) {
        if (!shown) {
          shown = true;
          err("still waiting on run dependencies:");
        }
        err(`dependency: ${dep}`);
      }
      if (shown) {
        err("(end of list)");
      }
    }, 1e4);
  }
};

var spawnThread = threadParams => {
  assert(!ENVIRONMENT_IS_PTHREAD, "spawnThread() should only be called from the main thread");
  assert(threadParams.pthread_ptr, "spawnThread called with null pthread ptr");
  var worker = PThread.getNewWorker();
  if (!worker) {
    // No available workers in the PThread pool.
    return 6;
  }
  assert(!worker.pthread_ptr);
  PThread.runningWorkers.push(worker);
  // Add to pthreads map
  PThread.pthreads[threadParams.pthread_ptr] = worker;
  worker.pthread_ptr = threadParams.pthread_ptr;
  var msg = {
    cmd: "run",
    start_routine: threadParams.startRoutine,
    arg: threadParams.arg,
    pthread_ptr: threadParams.pthread_ptr
  };
  // Ask the worker to start executing its pthread entry point function.
  worker.postMessage(msg, threadParams.transferList);
  return 0;
};

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var stackSave = () => _emscripten_stack_get_current();

var stackRestore = val => __emscripten_stack_restore(val);

var stackAlloc = sz => __emscripten_stack_alloc(sz);

/** @type{function(number, (number|boolean), ...number)} */ var proxyToMainThread = (funcIndex, emAsmAddr, proxyMode, ...callArgs) => {
  // EM_ASM proxying is done by passing a pointer to the address of the EM_ASM
  // content as `emAsmAddr`.  JS library proxying is done by passing an index
  // into `proxiedJSCallArgs` as `funcIndex`. If `emAsmAddr` is non-zero then
  // `funcIndex` will be ignored.
  // Additional arguments are passed after the first three are the actual
  // function arguments.
  // The serialization buffer contains the number of call params, and then
  // all the args here.
  // We also pass 'proxyMode' to C separately, since C needs to look at it.
  // Allocate a buffer (on the stack), which will be copied if necessary by
  // the C code.
  // First passed parameter specifies the number of arguments to the function.
  // When BigInt support is enabled, we must handle types in a more complex
  // way, detecting at runtime if a value is a BigInt or not (as we have no
  // type info here). To do that, add a "prefix" before each value that
  // indicates if it is a BigInt, which effectively doubles the number of
  // values we serialize for proxying. TODO: pack this?
  var bufSize = 8 * callArgs.length * 2;
  var sp = stackSave();
  var args = stackAlloc(bufSize);
  var b = ((args) >> 3);
  for (var arg of callArgs) {
    if (typeof arg == "bigint") {
      // The prefix is non-zero to indicate a bigint.
      (growMemViews(), HEAP64)[b++] = 1n;
      (growMemViews(), HEAP64)[b++] = arg;
    } else {
      // The prefix is zero to indicate a JS Number.
      (growMemViews(), HEAP64)[b++] = 0n;
      (growMemViews(), HEAPF64)[b++] = arg;
    }
  }
  var rtn = __emscripten_run_js_on_main_thread(funcIndex, emAsmAddr, bufSize, args, proxyMode);
  stackRestore(sp);
  return rtn;
};

function _proc_exit(code) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(0, 0, 1, code);
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    PThread.terminateAllThreads();
    Module["onExit"]?.(code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
}

var runtimeKeepalivePop = () => {
  assert(runtimeKeepaliveCounter > 0);
  runtimeKeepaliveCounter -= 1;
};

function exitOnMainThread(returnCode) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(1, 0, 0, returnCode);
  runtimeKeepalivePop();
  _exit(returnCode);
}

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  checkUnflushedContent();
  if (ENVIRONMENT_IS_PTHREAD) {
    // implicit exit can never happen on a pthread
    assert(!implicit);
    // When running in a pthread we propagate the exit back to the main thread
    // where it can decide if the whole process should be shut down or not.
    // The pthread may have decided not to exit its own runtime, for example
    // because it runs a main loop, but that doesn't affect the main thread.
    exitOnMainThread(status);
    throw "unwind";
  }
  // if exit() was called explicitly, warn the user if the runtime isn't actually being shut down
  if (keepRuntimeAlive() && !implicit) {
    var msg = `program exited (with status: ${status}), but keepRuntimeAlive() is set (counter=${runtimeKeepaliveCounter}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
    readyPromiseReject?.(msg);
    err(msg);
  }
  _proc_exit(status);
};

var _exit = exitJS;

var waitAsyncPolyfilled = (!Atomics.waitAsync || (globalThis.navigator?.userAgent && Number((navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./) || [])[2]) < 91));

function ptrToString(ptr) {
  assert(typeof ptr === "number", `ptrToString expects a number, got ${typeof ptr}`);
  // Convert to 32-bit unsigned value
  ptr >>>= 0;
  return "0x" + ptr.toString(16).padStart(8, "0");
}

var PThread = {
  unusedWorkers: [],
  runningWorkers: [],
  tlsInitFunctions: [],
  pthreads: {},
  nextWorkerID: 1,
  init() {
    if ((!(ENVIRONMENT_IS_PTHREAD))) {
      PThread.initMainThread();
    }
  },
  initMainThread() {
    var pthreadPoolSize = 4;
    // Start loading up the Worker pool, if requested.
    while (pthreadPoolSize--) {
      PThread.allocateUnusedWorker();
    }
    // MINIMAL_RUNTIME takes care of calling loadWasmModuleToAllWorkers
    // in postamble_minimal.js
    addOnPreRun(async () => {
      var pthreadPoolReady = PThread.loadWasmModuleToAllWorkers();
      addRunDependency("loading-workers");
      await pthreadPoolReady;
      removeRunDependency("loading-workers");
    });
  },
  terminateAllThreads: () => {
    assert(!ENVIRONMENT_IS_PTHREAD, "terminateAllThreads() should only be called from the main thread");
    // Attempt to kill all workers.  Sadly (at least on the web) there is no
    // way to terminate a worker synchronously, or to be notified when a
    // worker is actually terminated.  This means there is some risk that
    // pthreads will continue to be executing after `worker.terminate` has
    // returned.  For this reason, we don't call `returnWorkerToPool` here or
    // free the underlying pthread data structures.
    for (var worker of PThread.runningWorkers) {
      terminateWorker(worker);
    }
    for (var worker of PThread.unusedWorkers) {
      terminateWorker(worker);
    }
    PThread.unusedWorkers = [];
    PThread.runningWorkers = [];
    PThread.pthreads = {};
  },
  terminateRuntime: () => {
    assert(!ENVIRONMENT_IS_PTHREAD, "terminateRuntime() should only be called from the main thread");
    PThread.terminateAllThreads();
    var pthread_ptr = _pthread_self();
    ___set_thread_state(0, 0, 0, 1);
    if (!waitAsyncPolyfilled) {
      // Break the waitAsync loop.  Note that checkMailbox will not
      // re-register since the `___set_thread_state` above causes _pthread_self
      // to return 0.
      Atomics.notify((growMemViews(), HEAP32), ((pthread_ptr) >> 2));
    }
  },
  returnWorkerToPool: worker => {
    // We don't want to run main thread queued calls here, since we are doing
    // some operations that leave the worker queue in an invalid state until
    // we are completely done (it would be bad if free() ends up calling a
    // queued pthread_create which looks at the global data structures we are
    // modifying). To achieve that, defer the free() until the very end, when
    // we are all done.
    var pthread_ptr = worker.pthread_ptr;
    delete PThread.pthreads[pthread_ptr];
    // Note: worker is intentionally not terminated so the pool can
    // dynamically grow.
    PThread.unusedWorkers.push(worker);
    PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1);
    // Not a running Worker anymore
    // Detach the worker from the pthread object, and return it to the
    // worker pool as an unused worker.
    worker.pthread_ptr = 0;
    // Finally, free the underlying (and now-unused) pthread structure in
    // linear memory.
    __emscripten_thread_free_data(pthread_ptr);
  },
  threadInitTLS() {
    // Call thread init functions (these are the _emscripten_tls_init for each
    // module loaded.
    PThread.tlsInitFunctions.forEach(f => f());
  },
  loadWasmModuleToWorker: worker => new Promise(onFinishedLoading => {
    worker.onmessage = e => {
      var d = e["data"];
      var cmd = d.cmd;
      // If this message is intended to a recipient that is not the main
      // thread, forward it to the target thread.
      if (d.targetThread && d.targetThread != _pthread_self()) {
        var targetWorker = PThread.pthreads[d.targetThread];
        if (targetWorker) {
          targetWorker.postMessage(d, d.transferList);
        } else {
          err(`worker sent message (${cmd}) to pthread (${d.targetThread}) that no longer exists`);
        }
        return;
      }
      if (cmd === "checkMailbox") {
        checkMailbox();
      } else if (cmd === "spawnThread") {
        spawnThread(d);
      } else if (cmd === "cleanupThread") {
        // cleanupThread needs to be run via callUserCallback since it calls
        // back into user code to free thread data. Without this it's possible
        // the unwind or ExitStatus exception could escape here.
        callUserCallback(() => cleanupThread(d.thread));
      } else if (cmd === "loaded") {
        worker.loaded = true;
        onFinishedLoading(worker);
      } else if (d.target === "setimmediate") {
        // Worker wants to postMessage() to itself to implement setImmediate()
        // emulation.
        worker.postMessage(d);
      } else if (cmd === "callHandler") {
        Module[d.handler](...d.args);
      } else if (cmd) {
        // The received message looks like something that should be handled by this message
        // handler, (since there is a e.data.cmd field present), but is not one of the
        // recognized commands:
        err(`worker sent an unknown command ${cmd}`);
      }
    };
    worker.onerror = e => {
      var message = "worker sent an error!";
      if (worker.pthread_ptr) {
        message = `Pthread ${ptrToString(worker.pthread_ptr)} sent an error!`;
      }
      err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
      throw e;
    };
    assert(wasmMemory instanceof WebAssembly.Memory, "wasmMemory should have been loaded by now");
    assert(wasmModule instanceof WebAssembly.Module, "wasmModule should have been loaded by now");
    // When running on a pthread, none of the incoming parameters on the module
    // object are present. Proxy known handlers back to the main thread if specified.
    var handlers = [];
    var knownHandlers = [ "onExit", "onAbort", "print", "printErr" ];
    for (var handler of knownHandlers) {
      if (Module.propertyIsEnumerable(handler)) {
        handlers.push(handler);
      }
    }
    // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
    worker.postMessage({
      cmd: "load",
      handlers,
      wasmMemory,
      wasmModule,
      "workerID": worker.workerID
    });
  }),
  async loadWasmModuleToAllWorkers() {
    // Instantiation is synchronous in pthreads.
    if (ENVIRONMENT_IS_PTHREAD) {
      return;
    }
    let pthreadPoolReady = Promise.all(PThread.unusedWorkers.map(PThread.loadWasmModuleToWorker));
    return pthreadPoolReady;
  },
  allocateUnusedWorker() {
    var worker;
    // If we're using module output, use bundler-friendly pattern.
    if (Module["mainScriptUrlOrBlob"]) {
      var pthreadMainJs = Module["mainScriptUrlOrBlob"];
      if (typeof pthreadMainJs != "string") {
        pthreadMainJs = URL.createObjectURL(pthreadMainJs);
      }
      worker = new Worker(pthreadMainJs, {
        "type": "module",
        // This is the way that we signal to the Web Worker that it is hosting
        // a pthread.
        "name": "em-pthread-" + PThread.nextWorkerID
      });
    } else // We need to generate the URL with import.meta.url as the base URL of the JS file
    // instead of just using new URL(import.meta.url) because bundlers only recognize
    // the first case in their bundling step. The latter ends up producing an invalid
    // URL to import from the server (e.g., for webpack the file:// path).
    // See https://github.com/webpack/webpack/issues/12638
    worker = new Worker(new URL("wart-node.js", import.meta.url), {
      "type": "module",
      // This is the way that we signal to the Web Worker that it is hosting
      // a pthread.
      "name": "em-pthread-" + PThread.nextWorkerID
    });
    worker.workerID = PThread.nextWorkerID++;
    PThread.unusedWorkers.push(worker);
  },
  getNewWorker() {
    if (PThread.unusedWorkers.length == 0) {
      // PTHREAD_POOL_SIZE_STRICT should show a warning and, if set to level `2`, return from the function.
      PThread.allocateUnusedWorker();
      PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);
    }
    return PThread.unusedWorkers.pop();
  }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

function establishStackSpace(pthread_ptr) {
  var stackHigh = (growMemViews(), HEAPU32)[(((pthread_ptr) + (48)) >> 2)];
  var stackSize = (growMemViews(), HEAPU32)[(((pthread_ptr) + (52)) >> 2)];
  var stackLow = stackHigh - stackSize;
  assert(stackHigh != 0);
  assert(stackLow != 0);
  assert(stackHigh > stackLow, "stackHigh must be higher then stackLow");
  // Set stack limits used by `emscripten/stack.h` function.  These limits are
  // cached in wasm-side globals to make checks as fast as possible.
  _emscripten_stack_set_limits(stackHigh, stackLow);
  // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
  stackRestore(stackHigh);
  // Write the stack cookie last, after we have set up the proper bounds and
  // current position of the stack.
  writeStackCookie();
}

/**
   * @param {number} ptr
   * @param {string} type
   */ function getValue(ptr, type = "i8") {
  if (type.endsWith("*")) type = "*";
  switch (type) {
   case "i1":
    return (growMemViews(), HEAP8)[ptr];

   case "i8":
    return (growMemViews(), HEAP8)[ptr];

   case "i16":
    return (growMemViews(), HEAP16)[((ptr) >> 1)];

   case "i32":
    return (growMemViews(), HEAP32)[((ptr) >> 2)];

   case "i64":
    return (growMemViews(), HEAP64)[((ptr) >> 3)];

   case "float":
    return (growMemViews(), HEAPF32)[((ptr) >> 2)];

   case "double":
    return (growMemViews(), HEAPF64)[((ptr) >> 3)];

   case "*":
    return (growMemViews(), HEAPU32)[((ptr) >> 2)];

   default:
    abort(`invalid type for getValue: ${type}`);
  }
}

var wasmTableMirror = [];

var getWasmTableEntry = funcPtr => {
  var func = wasmTableMirror[funcPtr];
  if (!func) {
    /** @suppress {checkTypes} */ wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
  }
  /** @suppress {checkTypes} */ assert(wasmTable.get(funcPtr) == func, "table mirror is out of date");
  return func;
};

var invokeEntryPoint = (ptr, arg) => {
  // An old thread on this worker may have been canceled without returning the
  // `runtimeKeepaliveCounter` to zero. Reset it now so the new thread won't
  // be affected.
  runtimeKeepaliveCounter = 0;
  // Same for noExitRuntime.  The default for pthreads should always be false
  // otherwise pthreads would never complete and attempts to pthread_join to
  // them would block forever.
  // pthreads can still choose to set `noExitRuntime` explicitly, or
  // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
  // their main function.  See comment in src/runtime_pthread.js for more.
  noExitRuntime = 0;
  // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
  // Native codebases sometimes spawn threads with other thread entry point
  // signatures, such as void ThreadMain(void *arg), void *ThreadMain(), or
  // void ThreadMain().  That is not acceptable per C/C++ specification, but
  // x86 compiler ABI extensions enable that to work. If you find the
  // following line to crash, either change the signature to "proper" void
  // *ThreadMain(void *arg) form, or try linking with the Emscripten linker
  // flag -sEMULATE_FUNCTION_POINTER_CASTS to add in emulation for this x86
  // ABI extension.
  var result = getWasmTableEntry(ptr)(arg);
  checkStackCookie();
  function finish(result) {
    // In MINIMAL_RUNTIME the noExitRuntime concept does not apply to
    // pthreads. To exit a pthread with live runtime, use the function
    // emscripten_unwind_to_js_event_loop() in the pthread body.
    if (keepRuntimeAlive()) {
      EXITSTATUS = result;
      return;
    }
    __emscripten_thread_exit(result);
  }
  finish(result);
};

var noExitRuntime = true;

var registerTLSInit = tlsInitFunc => PThread.tlsInitFunctions.push(tlsInitFunc);

var runtimeKeepalivePush = () => {
  runtimeKeepaliveCounter += 1;
};

/**
   * @param {number} ptr
   * @param {number} value
   * @param {string} type
   */ function setValue(ptr, value, type = "i8") {
  if (type.endsWith("*")) type = "*";
  switch (type) {
   case "i1":
    (growMemViews(), HEAP8)[ptr] = value;
    break;

   case "i8":
    (growMemViews(), HEAP8)[ptr] = value;
    break;

   case "i16":
    (growMemViews(), HEAP16)[((ptr) >> 1)] = value;
    break;

   case "i32":
    (growMemViews(), HEAP32)[((ptr) >> 2)] = value;
    break;

   case "i64":
    (growMemViews(), HEAP64)[((ptr) >> 3)] = BigInt(value);
    break;

   case "float":
    (growMemViews(), HEAPF32)[((ptr) >> 2)] = value;
    break;

   case "double":
    (growMemViews(), HEAPF64)[((ptr) >> 3)] = value;
    break;

   case "*":
    (growMemViews(), HEAPU32)[((ptr) >> 2)] = value;
    break;

   default:
    abort(`invalid type for setValue: ${type}`);
  }
}

var warnOnce = text => {
  warnOnce.shown ||= {};
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    err(text);
  }
};

var wasmMemory;

var UTF8Decoder = globalThis.TextDecoder && new TextDecoder;

var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
  var maxIdx = idx + maxBytesToRead;
  if (ignoreNul) return maxIdx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.
  // As a tiny code save trick, compare idx against maxIdx using a negation,
  // so that maxBytesToRead=undefined/NaN means Infinity.
  while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
  return idx;
};

/**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
    return UTF8Decoder.decode(heapOrArray.buffer instanceof ArrayBuffer ? heapOrArray.subarray(idx, endPtr) : heapOrArray.slice(idx, endPtr));
  }
  var str = "";
  while (idx < endPtr) {
    // For UTF8 byte structure, see:
    // http://en.wikipedia.org/wiki/UTF-8#Description
    // https://www.ietf.org/rfc/rfc2279.txt
    // https://tools.ietf.org/html/rfc3629
    var u0 = heapOrArray[idx++];
    if (!(u0 & 128)) {
      str += String.fromCharCode(u0);
      continue;
    }
    var u1 = heapOrArray[idx++] & 63;
    if ((u0 & 224) == 192) {
      str += String.fromCharCode(((u0 & 31) << 6) | u1);
      continue;
    }
    var u2 = heapOrArray[idx++] & 63;
    if ((u0 & 240) == 224) {
      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
    } else {
      if ((u0 & 248) != 240) warnOnce(`Invalid UTF-8 leading byte ${ptrToString(u0)} encountered when deserializing a UTF-8 string in wasm memory to a JS string!`);
      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
    }
    if (u0 < 65536) {
      str += String.fromCharCode(u0);
    } else {
      var ch = u0 - 65536;
      str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
    }
  }
  return str;
};

/**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
  assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
  return ptr ? UTF8ArrayToString((growMemViews(), HEAPU8), ptr, maxBytesToRead, ignoreNul) : "";
};

var ___assert_fail = (condition, filename, line, func) => abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [ filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function" ]);

var ___call_sighandler = (fp, sig) => getWasmTableEntry(fp)(sig);

var exceptionCaught = [];

var uncaughtExceptionCount = 0;

var ___cxa_begin_catch = ptr => {
  var info = new ExceptionInfo(ptr);
  if (!info.get_caught()) {
    info.set_caught(true);
    uncaughtExceptionCount--;
  }
  info.set_rethrown(false);
  exceptionCaught.push(info);
  return ___cxa_get_exception_ptr(ptr);
};

var exceptionLast = null;

var ___cxa_end_catch = () => {
  // Clear state flag.
  _setThrew(0, 0);
  assert(exceptionCaught.length > 0);
  // Call destructor if one is registered then clear it.
  var info = exceptionCaught.pop();
  ___cxa_decrement_exception_refcount(info.excPtr);
  exceptionLast = null;
};

class ExceptionInfo {
  // excPtr - Thrown object pointer to wrap. Metadata pointer is calculated from it.
  constructor(excPtr) {
    this.excPtr = excPtr;
    this.ptr = excPtr - 24;
  }
  set_type(type) {
    (growMemViews(), HEAPU32)[(((this.ptr) + (4)) >> 2)] = type;
  }
  get_type() {
    return (growMemViews(), HEAPU32)[(((this.ptr) + (4)) >> 2)];
  }
  set_destructor(destructor) {
    (growMemViews(), HEAPU32)[(((this.ptr) + (8)) >> 2)] = destructor;
  }
  get_destructor() {
    return (growMemViews(), HEAPU32)[(((this.ptr) + (8)) >> 2)];
  }
  set_caught(caught) {
    caught = caught ? 1 : 0;
    (growMemViews(), HEAP8)[(this.ptr) + (12)] = caught;
  }
  get_caught() {
    return (growMemViews(), HEAP8)[(this.ptr) + (12)] != 0;
  }
  set_rethrown(rethrown) {
    rethrown = rethrown ? 1 : 0;
    (growMemViews(), HEAP8)[(this.ptr) + (13)] = rethrown;
  }
  get_rethrown() {
    return (growMemViews(), HEAP8)[(this.ptr) + (13)] != 0;
  }
  // Initialize native structure fields. Should be called once after allocated.
  init(type, destructor) {
    this.set_adjusted_ptr(0);
    this.set_type(type);
    this.set_destructor(destructor);
  }
  set_adjusted_ptr(adjustedPtr) {
    (growMemViews(), HEAPU32)[(((this.ptr) + (16)) >> 2)] = adjustedPtr;
  }
  get_adjusted_ptr() {
    return (growMemViews(), HEAPU32)[(((this.ptr) + (16)) >> 2)];
  }
}

var setTempRet0 = val => __emscripten_tempret_set(val);

var findMatchingCatch = args => {
  var thrown = exceptionLast?.excPtr;
  if (!thrown) {
    // just pass through the null ptr
    setTempRet0(0);
    return 0;
  }
  var info = new ExceptionInfo(thrown);
  info.set_adjusted_ptr(thrown);
  var thrownType = info.get_type();
  if (!thrownType) {
    // just pass through the thrown ptr
    setTempRet0(0);
    return thrown;
  }
  // can_catch receives a **, add indirection
  // The different catch blocks are denoted by different types.
  // Due to inheritance, those types may not precisely match the
  // type of the thrown object. Find one which matches, and
  // return the type of the catch block which should be called.
  for (var caughtType of args) {
    if (caughtType === 0 || caughtType === thrownType) {
      // Catch all clause matched or exactly the same type is caught
      break;
    }
    var adjusted_ptr_addr = info.ptr + 16;
    if (___cxa_can_catch(caughtType, thrownType, adjusted_ptr_addr)) {
      setTempRet0(caughtType);
      return thrown;
    }
  }
  setTempRet0(thrownType);
  return thrown;
};

var ___cxa_find_matching_catch_2 = () => findMatchingCatch([]);

var ___cxa_find_matching_catch_3 = arg0 => findMatchingCatch([ arg0 ]);

var ___cxa_find_matching_catch_4 = (arg0, arg1) => findMatchingCatch([ arg0, arg1 ]);

var ___cxa_rethrow = () => {
  if (!exceptionCaught.length) {
    abort("no exception to throw");
  }
  var info = exceptionCaught.at(-1);
  var ptr = info.excPtr;
  info.set_rethrown(true);
  info.set_caught(false);
  uncaughtExceptionCount++;
  ___cxa_increment_exception_refcount(ptr);
  exceptionLast = new CppException(ptr);
  throw exceptionLast;
};

var getExceptionMessageCommon = ptr => {
  var sp = stackSave();
  var type_addr_addr = stackAlloc(4);
  var message_addr_addr = stackAlloc(4);
  ___get_exception_message(ptr, type_addr_addr, message_addr_addr);
  var type_addr = (growMemViews(), HEAPU32)[((type_addr_addr) >> 2)];
  var message_addr = (growMemViews(), HEAPU32)[((message_addr_addr) >> 2)];
  var type = UTF8ToString(type_addr);
  _free(type_addr);
  var message;
  if (message_addr) {
    message = UTF8ToString(message_addr);
    _free(message_addr);
  }
  stackRestore(sp);
  return [ type, message ];
};

var getExceptionMessage = exn => getExceptionMessageCommon(exn.excPtr);

var decrementExceptionRefcount = exn => ___cxa_decrement_exception_refcount(exn.excPtr);

var incrementExceptionRefcount = exn => ___cxa_increment_exception_refcount(exn.excPtr);

var ___cxa_throw = (ptr, type, destructor) => {
  var info = new ExceptionInfo(ptr);
  // Initialize ExceptionInfo content after it was allocated in __cxa_allocate_exception.
  info.init(type, destructor);
  ___cxa_increment_exception_refcount(ptr);
  exceptionLast = new CppException(ptr);
  uncaughtExceptionCount++;
  throw exceptionLast;
};

var ___cxa_uncaught_exceptions = () => uncaughtExceptionCount;

function pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(2, 0, 1, pthread_ptr, attr, startRoutine, arg);
  return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg);
}

var _emscripten_has_threading_support = () => !!globalThis.SharedArrayBuffer;

var ___pthread_create_js = (pthread_ptr, attr, startRoutine, arg) => {
  if (!_emscripten_has_threading_support()) {
    dbg("pthread_create: environment does not support SharedArrayBuffer, pthreads are not available");
    return 6;
  }
  // List of JS objects that will transfer ownership to the Worker hosting the thread
  var transferList = [];
  var error = 0;
  // Synchronously proxy the thread creation to main thread if possible. If we
  // need to transfer ownership of objects, then proxy asynchronously via
  // postMessage.
  if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
    return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
  }
  // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
  // with the detected error.
  if (error) return error;
  var threadParams = {
    startRoutine,
    pthread_ptr,
    arg,
    transferList
  };
  if (ENVIRONMENT_IS_PTHREAD) {
    // The prepopulated pool of web workers that can host pthreads is stored
    // in the main JS thread. Therefore if a pthread is attempting to spawn a
    // new thread, the thread creation must be deferred to the main JS thread.
    threadParams.cmd = "spawnThread";
    postMessage(threadParams, transferList);
    // When we defer thread creation this way, we have no way to detect thread
    // creation synchronously today, so we have to assume success and return 0.
    return 0;
  }
  // We are the main thread, so we have the pthread warmup pool in this
  // thread and can fire off JS thread creation directly ourselves.
  return spawnThread(threadParams);
};

var ___resumeException = ptr => {
  if (!exceptionLast) {
    exceptionLast = new CppException(ptr);
  }
  throw exceptionLast;
};

var __abort_js = () => abort("native code called abort()");

var __emscripten_init_main_thread_js = tb => {
  // Pass the thread address to the native code where they are stored in wasm
  // globals which act as a form of TLS. Global constructors trying
  // to access this value will read the wrong value, but that is UB anyway.
  __emscripten_thread_init(tb, /*is_main=*/ !ENVIRONMENT_IS_WORKER, /*is_runtime=*/ 1, /*can_block=*/ !ENVIRONMENT_IS_WEB, /*default_stacksize=*/ 4194304, /*start_profiling=*/ false);
  PThread.threadInitTLS();
};

var handleException = e => {
  // Certain exception types we do not treat as errors since they are used for
  // internal control flow.
  // 1. ExitStatus, which is thrown by exit()
  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
  //    that wish to return to JS event loop.
  if (e instanceof ExitStatus || e == "unwind") {
    return EXITSTATUS;
  }
  checkStackCookie();
  if (e instanceof WebAssembly.RuntimeError) {
    if (_emscripten_stack_get_current() <= 0) {
      err("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 4194304)");
    }
  }
  quit_(1, e);
};

var maybeExit = () => {
  if (!keepRuntimeAlive()) {
    try {
      if (ENVIRONMENT_IS_PTHREAD) {
        // exit the current thread, but only if there is one active.
        // TODO(https://github.com/emscripten-core/emscripten/issues/25076):
        // Unify this check with the runtimeExited check above
        if (_pthread_self()) __emscripten_thread_exit(EXITSTATUS);
        return;
      }
      _exit(EXITSTATUS);
    } catch (e) {
      handleException(e);
    }
  }
};

var callUserCallback = func => {
  if (ABORT) {
    err("user callback triggered after runtime exited or application aborted.  Ignoring.");
    return;
  }
  try {
    return func();
  } catch (e) {
    handleException(e);
  } finally {
    maybeExit();
  }
};

var __emscripten_thread_mailbox_await = pthread_ptr => {
  if (!waitAsyncPolyfilled) {
    // Wait on the pthread's initial self-pointer field because it is easy and
    // safe to access from sending threads that need to notify the waiting
    // thread.
    // Note: Under wasm64 only the low 32-bit of the pthread_ptr are
    // read/compared here, but we don't actually care about the exact values
    // here as long as they match.
    var wait = Atomics.waitAsync((growMemViews(), HEAP32), ((pthread_ptr) >> 2), pthread_ptr);
    assert(wait.async);
    wait.value.then(checkMailbox);
    var waitingAsync = pthread_ptr + 120;
    Atomics.store((growMemViews(), HEAP32), ((waitingAsync) >> 2), 1);
  }
};

var checkMailbox = () => {
  // checkMailbox can be called after the pthread has shut down. See
  // Pthread.terminateRuntime().
  // In this case we return silently without re-registering using waitAsync.
  // Perhaps there is a more universal way we can detect runtime has exited.
  // TODO(https://github.com/emscripten-core/emscripten/issues/25076)
  var pthread_ptr = _pthread_self();
  if (!pthread_ptr) return;
  callUserCallback(() => {
    // If we are using Atomics.waitAsync as our notification mechanism, wait
    // for a notification before processing the mailbox to avoid missing any
    // work that could otherwise arrive after we've finished processing the
    // mailbox and before we're ready for the next notification.
    __emscripten_thread_mailbox_await(pthread_ptr);
    __emscripten_check_mailbox();
  });
};

var __emscripten_notify_mailbox_postmessage = (targetThread, currThreadId) => {
  if (targetThread == currThreadId) {
    setTimeout(checkMailbox);
  } else if (ENVIRONMENT_IS_PTHREAD) {
    postMessage({
      targetThread,
      cmd: "checkMailbox"
    });
  } else {
    var worker = PThread.pthreads[targetThread];
    if (!worker) {
      err(`Cannot send message to thread with ID ${targetThread}, unknown thread ID!`);
      return;
    }
    worker.postMessage({
      cmd: "checkMailbox"
    });
  }
};

var proxiedJSCallArgs = [];

var __emscripten_receive_on_main_thread_js = (funcIndex, emAsmAddr, callingThread, bufSize, args, ctx, ctxArgs) => {
  // Sometimes we need to backproxy events to the calling thread (e.g.
  // HTML5 DOM events handlers such as
  // emscripten_set_mousemove_callback()), so keep track in a globally
  // accessible variable about the thread that initiated the proxying.
  proxiedJSCallArgs.length = 0;
  var b = ((args) >> 3);
  var end = ((args + bufSize) >> 3);
  while (b < end) {
    var arg;
    if ((growMemViews(), HEAP64)[b++]) {
      // It's a BigInt.
      arg = (growMemViews(), HEAP64)[b++];
    } else {
      // It's a Number.
      arg = (growMemViews(), HEAPF64)[b++];
    }
    proxiedJSCallArgs.push(arg);
  }
  // Proxied JS library funcs use funcIndex and EM_ASM functions use emAsmAddr
  assert(!emAsmAddr);
  var func = proxiedFunctionTable[funcIndex];
  assert(!(funcIndex && emAsmAddr));
  assert(func.length == proxiedJSCallArgs.length, "Call args mismatch in _emscripten_receive_on_main_thread_js");
  PThread.currentProxiedOperationCallerThread = callingThread;
  var rtn = func(...proxiedJSCallArgs);
  PThread.currentProxiedOperationCallerThread = 0;
  if (ctx) {
    rtn.then(rtn => __emscripten_run_js_on_main_thread_done(ctx, ctxArgs, rtn));
    return;
  }
  // Proxied functions can return any type except bigint.  All other types
  // coerce to f64/double (the return type of this function in C) but not
  // bigint.
  assert(typeof rtn != "bigint");
  return rtn;
};

var __emscripten_runtime_keepalive_clear = () => {
  noExitRuntime = false;
  runtimeKeepaliveCounter = 0;
};

var __emscripten_thread_cleanup = thread => {
  // Called when a thread needs to be cleaned up so it can be reused.
  // A thread is considered reusable when it either returns from its
  // entry point, calls pthread_exit, or acts upon a cancellation.
  // Detached threads are responsible for calling this themselves,
  // otherwise pthread_join is responsible for calling this.
  if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread); else postMessage({
    cmd: "cleanupThread",
    thread
  });
};

var __emscripten_thread_set_strongref = thread => {};

var INT53_MAX = 9007199254740992;

var INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

function __gmtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  var date = new Date(time * 1e3);
  (growMemViews(), HEAP32)[((tmPtr) >> 2)] = date.getUTCSeconds();
  (growMemViews(), HEAP32)[(((tmPtr) + (4)) >> 2)] = date.getUTCMinutes();
  (growMemViews(), HEAP32)[(((tmPtr) + (8)) >> 2)] = date.getUTCHours();
  (growMemViews(), HEAP32)[(((tmPtr) + (12)) >> 2)] = date.getUTCDate();
  (growMemViews(), HEAP32)[(((tmPtr) + (16)) >> 2)] = date.getUTCMonth();
  (growMemViews(), HEAP32)[(((tmPtr) + (20)) >> 2)] = date.getUTCFullYear() - 1900;
  (growMemViews(), HEAP32)[(((tmPtr) + (24)) >> 2)] = date.getUTCDay();
  var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
  (growMemViews(), HEAP32)[(((tmPtr) + (28)) >> 2)] = yday;
}

var isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

var MONTH_DAYS_LEAP_CUMULATIVE = [ 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335 ];

var MONTH_DAYS_REGULAR_CUMULATIVE = [ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 ];

var ydayFromDate = date => {
  var leap = isLeapYear(date.getFullYear());
  var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
  var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
  // -1 since it's days since Jan 1
  return yday;
};

function __localtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  var date = new Date(time * 1e3);
  (growMemViews(), HEAP32)[((tmPtr) >> 2)] = date.getSeconds();
  (growMemViews(), HEAP32)[(((tmPtr) + (4)) >> 2)] = date.getMinutes();
  (growMemViews(), HEAP32)[(((tmPtr) + (8)) >> 2)] = date.getHours();
  (growMemViews(), HEAP32)[(((tmPtr) + (12)) >> 2)] = date.getDate();
  (growMemViews(), HEAP32)[(((tmPtr) + (16)) >> 2)] = date.getMonth();
  (growMemViews(), HEAP32)[(((tmPtr) + (20)) >> 2)] = date.getFullYear() - 1900;
  (growMemViews(), HEAP32)[(((tmPtr) + (24)) >> 2)] = date.getDay();
  var yday = ydayFromDate(date) | 0;
  (growMemViews(), HEAP32)[(((tmPtr) + (28)) >> 2)] = yday;
  (growMemViews(), HEAP32)[(((tmPtr) + (36)) >> 2)] = -(date.getTimezoneOffset() * 60);
  // Attention: DST is in December in South, and some regions don't have DST at all.
  var start = new Date(date.getFullYear(), 0, 1);
  var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  var winterOffset = start.getTimezoneOffset();
  var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
  (growMemViews(), HEAP32)[(((tmPtr) + (32)) >> 2)] = dst;
}

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  assert(typeof str === "string", `stringToUTF8Array expects a string (got ${typeof str})`);
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.codePointAt(i);
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 192 | (u >> 6);
      heap[outIdx++] = 128 | (u & 63);
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 224 | (u >> 12);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u > 1114111) warnOnce(`Invalid Unicode code point ${ptrToString(u)} encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).`);
      heap[outIdx++] = 240 | (u >> 18);
      heap[outIdx++] = 128 | ((u >> 12) & 63);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
};

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
  assert(typeof maxBytesToWrite == "number", "stringToUTF8 requires a third parameter that specifies the length of the output buffer");
  return stringToUTF8Array(str, (growMemViews(), HEAPU8), outPtr, maxBytesToWrite);
};

var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var c = str.charCodeAt(i);
    // possibly a lead surrogate
    if (c <= 127) {
      len++;
    } else if (c <= 2047) {
      len += 2;
    } else if (c >= 55296 && c <= 57343) {
      len += 4;
      ++i;
    } else {
      len += 3;
    }
  }
  return len;
};

var __tzset_js = (timezone, daylight, std_name, dst_name) => {
  // TODO: Use (malleable) environment variables instead of system settings.
  var currentYear = (new Date).getFullYear();
  var winter = new Date(currentYear, 0, 1);
  var summer = new Date(currentYear, 6, 1);
  var winterOffset = winter.getTimezoneOffset();
  var summerOffset = summer.getTimezoneOffset();
  // Local standard timezone offset. Local standard time is not adjusted for
  // daylight savings.  This code uses the fact that getTimezoneOffset returns
  // a greater value during Standard Time versus Daylight Saving Time (DST).
  // Thus it determines the expected output during Standard Time, and it
  // compares whether the output of the given date the same (Standard) or less
  // (DST).
  var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  // timezone is specified as seconds west of UTC ("The external variable
  // `timezone` shall be set to the difference, in seconds, between
  // Coordinated Universal Time (UTC) and local standard time."), the same
  // as returned by stdTimezoneOffset.
  // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
  (growMemViews(), HEAPU32)[((timezone) >> 2)] = stdTimezoneOffset * 60;
  (growMemViews(), HEAP32)[((daylight) >> 2)] = Number(winterOffset != summerOffset);
  var extractZone = timezoneOffset => {
    // Why inverse sign?
    // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
    var sign = timezoneOffset >= 0 ? "-" : "+";
    var absOffset = Math.abs(timezoneOffset);
    var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    var minutes = String(absOffset % 60).padStart(2, "0");
    return `UTC${sign}${hours}${minutes}`;
  };
  var winterName = extractZone(winterOffset);
  var summerName = extractZone(summerOffset);
  assert(winterName);
  assert(summerName);
  assert(lengthBytesUTF8(winterName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${winterName})`);
  assert(lengthBytesUTF8(summerName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${summerName})`);
  if (summerOffset < winterOffset) {
    // Northern hemisphere
    stringToUTF8(winterName, std_name, 17);
    stringToUTF8(summerName, dst_name, 17);
  } else {
    stringToUTF8(winterName, dst_name, 17);
    stringToUTF8(summerName, std_name, 17);
  }
};

var __wasmfs_copy_preloaded_file_data = (index, buffer) => (growMemViews(), HEAPU8).set(wasmFSPreloadedFiles[index].fileData, buffer);

var wasmFSPreloadedDirs = [];

var __wasmfs_get_num_preloaded_dirs = () => wasmFSPreloadedDirs.length;

var wasmFSPreloadedFiles = [];

var wasmFSPreloadingFlushed = false;

var __wasmfs_get_num_preloaded_files = () => {
  // When this method is called from WasmFS it means that we are about to
  // flush all the preloaded data, so mark that. (There is no call that
  // occurs at the end of that flushing, which would be more natural, but it
  // is fine to mark the flushing here as during the flushing itself no user
  // code can run, so nothing will check whether we have flushed or not.)
  wasmFSPreloadingFlushed = true;
  return wasmFSPreloadedFiles.length;
};

var __wasmfs_get_preloaded_child_path = (index, childNameBuffer) => {
  var s = wasmFSPreloadedDirs[index].childName;
  var len = lengthBytesUTF8(s) + 1;
  stringToUTF8(s, childNameBuffer, len);
};

var __wasmfs_get_preloaded_file_mode = index => wasmFSPreloadedFiles[index].mode;

var __wasmfs_get_preloaded_file_size = index => wasmFSPreloadedFiles[index].fileData.length;

var __wasmfs_get_preloaded_parent_path = (index, parentPathBuffer) => {
  var s = wasmFSPreloadedDirs[index].parentPath;
  var len = lengthBytesUTF8(s) + 1;
  stringToUTF8(s, parentPathBuffer, len);
};

var __wasmfs_get_preloaded_path_name = (index, fileNameBuffer) => {
  var s = wasmFSPreloadedFiles[index].pathName;
  var len = lengthBytesUTF8(s) + 1;
  stringToUTF8(s, fileNameBuffer, len);
};

class HandleAllocator {
  allocated=[ undefined ];
  freelist=[];
  get(id) {
    assert(this.allocated[id] !== undefined, `invalid handle: ${id}`);
    return this.allocated[id];
  }
  has(id) {
    return this.allocated[id] !== undefined;
  }
  allocate(handle) {
    var id = this.freelist.pop() || this.allocated.length;
    this.allocated[id] = handle;
    return id;
  }
  free(id) {
    assert(this.allocated[id] !== undefined);
    // Set the slot to `undefined` rather than using `delete` here since
    // apparently arrays with holes in them can be less efficient.
    this.allocated[id] = undefined;
    this.freelist.push(id);
  }
}

var wasmfsOPFSAccessHandles = new HandleAllocator;

var wasmfsOPFSProxyFinish = ctx => {
  // When using pthreads the proxy needs to know when the work is finished.
  // When used with JSPI the work will be executed in an async block so there
  // is no need to notify when done.
  _emscripten_proxy_finish(ctx);
};

function wasmfsOPFSIsStaleHandle(e) {
  return !!(e && (e.name === "InvalidStateError" || /state cached in an interface object/i.test(String(e && e.message || e))));
}

function wasmfsOPFSRefreshHandle(accessHandle) {
  try {
    accessHandle.getSize();
  } catch (_) {}
}

async function wasmfsOPFSRefreshRoot() {
  try {
    var root = await navigator.storage.getDirectory();
    if (wasmfsOPFSDirectoryHandles.allocated.length > 1) {
      wasmfsOPFSDirectoryHandles.allocated[1] = root;
    }
    return root;
  } catch (_) {
    return null;
  }
}

var __wasmfs_opfs_close_access = async (ctx, accessID, errPtr) => {
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  try {
    await accessHandle.close();
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSAccessHandles.free(accessID);
  wasmfsOPFSProxyFinish(ctx);
};

var wasmfsOPFSBlobs = new HandleAllocator;

var __wasmfs_opfs_close_blob = blobID => {
  wasmfsOPFSBlobs.free(blobID);
};

var __wasmfs_opfs_flush_access = async (ctx, accessID, errPtr) => {
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  try {
    await accessHandle.flush();
  } catch (e) {
    if (wasmfsOPFSIsStaleHandle(e)) {
      wasmfsOPFSRefreshHandle(accessHandle);
      try {
        await accessHandle.flush();
      } catch (e2) {
        if (!wasmfsOPFSIsStaleHandle(e2)) err("unexpected error:", e2, e2.stack);
        let err = -11;
        (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
      }
    } else {
      let err = -29;
      (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
    }
  }
  wasmfsOPFSProxyFinish(ctx);
};

var wasmfsOPFSDirectoryHandles = new HandleAllocator;

var __wasmfs_opfs_free_directory = dirID => {
  wasmfsOPFSDirectoryHandles.free(dirID);
};

var wasmfsOPFSFileHandles = new HandleAllocator;

var __wasmfs_opfs_free_file = fileID => {
  wasmfsOPFSFileHandles.free(fileID);
};

var wasmfsOPFSGetOrCreateFile = async (parent, name, create) => {
  let parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
  let fileHandle;
  try {
    fileHandle = await parentHandle.getFileHandle(name, {
      create
    });
  } catch (e) {
    if (e.name === "NotFoundError") {
      return -20;
    }
    if (e.name === "TypeMismatchError") {
      return -31;
    }
    if (wasmfsOPFSIsStaleHandle(e)) {
      if (parent === 1) await wasmfsOPFSRefreshRoot();
      parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
      try {
        fileHandle = await parentHandle.getFileHandle(name, {
          create
        });
      } catch (e2) {
        if (e2.name === "NotFoundError") return -20;
        if (e2.name === "TypeMismatchError") return -31;
        if (wasmfsOPFSIsStaleHandle(e2)) return -11;
        err("unexpected error:", e2, e2.stack);
        return -29;
      }
      return wasmfsOPFSFileHandles.allocate(fileHandle);
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
  return wasmfsOPFSFileHandles.allocate(fileHandle);
};

var wasmfsOPFSGetOrCreateDir = async (parent, name, create) => {
  let parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
  let childHandle;
  try {
    childHandle = await parentHandle.getDirectoryHandle(name, {
      create
    });
  } catch (e) {
    if (e.name === "NotFoundError") {
      return -20;
    }
    if (e.name === "TypeMismatchError") {
      return -54;
    }
    if (wasmfsOPFSIsStaleHandle(e)) {
      if (parent === 1) await wasmfsOPFSRefreshRoot();
      parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
      try {
        childHandle = await parentHandle.getDirectoryHandle(name, {
          create
        });
      } catch (e2) {
        if (e2.name === "NotFoundError") return -20;
        if (e2.name === "TypeMismatchError") return -54;
        if (wasmfsOPFSIsStaleHandle(e2)) return -11;
        err("unexpected error:", e2, e2.stack);
        return -29;
      }
      return wasmfsOPFSDirectoryHandles.allocate(childHandle);
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
  return wasmfsOPFSDirectoryHandles.allocate(childHandle);
};

var __wasmfs_opfs_get_child = async (ctx, parent, namePtr, childTypePtr, childIDPtr) => {
  let name = UTF8ToString(namePtr);
  let childType = 1;
  let childID = await wasmfsOPFSGetOrCreateFile(parent, name, false);
  if (childID == -31) {
    childType = 2;
    childID = await wasmfsOPFSGetOrCreateDir(parent, name, false);
  }
  (growMemViews(), HEAP32)[((childTypePtr) >> 2)] = childType;
  (growMemViews(), HEAP32)[((childIDPtr) >> 2)] = childID;
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_get_entries = async (ctx, dirID, entriesPtr, errPtr) => {
  let dirHandle = wasmfsOPFSDirectoryHandles.get(dirID);
  // TODO: Use 'for await' once Acorn supports that.
  try {
    let iter = dirHandle.entries();
    for (let entry; entry = await iter.next(), !entry.done; ) {
      let [name, child] = entry.value;
      let sp = stackSave();
      let namePtr = stringToUTF8OnStack(name);
      let type = child.kind == "file" ? 1 : 2;
      __wasmfs_opfs_record_entry(entriesPtr, namePtr, type);
      stackRestore(sp);
    }
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_get_size_access = async (ctx, accessID, sizePtr) => {
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  let size;
  try {
    size = await accessHandle.getSize();
  } catch (e) {
    if (wasmfsOPFSIsStaleHandle(e)) {
      try {
        size = await accessHandle.getSize();
      } catch {
        size = -11;
      }
    } else {
      size = -29;
    }
  }
  (growMemViews(), HEAP64)[((sizePtr) >> 3)] = BigInt(size);
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_get_size_blob = function(blobID) {
  var ret = (() => wasmfsOPFSBlobs.get(blobID).size)();
  return BigInt(ret);
};

var __wasmfs_opfs_get_size_file = async (ctx, fileID, sizePtr) => {
  let fileHandle = wasmfsOPFSFileHandles.get(fileID);
  let size;
  try {
    size = (await fileHandle.getFile()).size;
  } catch {
    size = -29;
  }
  (growMemViews(), HEAP64)[((sizePtr) >> 3)] = BigInt(size);
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_init_root_directory = async ctx => {
  // allocated.length starts off as 1 since 0 is a reserved handle
  if (wasmfsOPFSDirectoryHandles.allocated.length == 1) {
    // Closure compiler errors on this as it does not recognize the OPFS
    // API yet, it seems. Unfortunately an existing annotation for this is in
    // the closure compiler codebase, and cannot be overridden in user code
    // (it complains on a duplicate type annotation), so just suppress it.
    /** @suppress {checkTypes} */ let root = await navigator.storage.getDirectory();
    wasmfsOPFSDirectoryHandles.allocated.push(root);
  }
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_insert_directory = async (ctx, parent, namePtr, childIDPtr) => {
  let name = UTF8ToString(namePtr);
  let childID = await wasmfsOPFSGetOrCreateDir(parent, name, true);
  (growMemViews(), HEAP32)[((childIDPtr) >> 2)] = childID;
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_insert_file = async (ctx, parent, namePtr, childIDPtr) => {
  let name = UTF8ToString(namePtr);
  let childID = await wasmfsOPFSGetOrCreateFile(parent, name, true);
  (growMemViews(), HEAP32)[((childIDPtr) >> 2)] = childID;
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_move_file = async (ctx, fileID, newParentID, namePtr, errPtr) => {
  let name = UTF8ToString(namePtr);
  let fileHandle = wasmfsOPFSFileHandles.get(fileID);
  let newDirHandle = wasmfsOPFSDirectoryHandles.get(newParentID);
  try {
    await fileHandle.move(newDirHandle, name);
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_open_access = async (ctx, fileID, accessIDPtr) => {
  let fileHandle = wasmfsOPFSFileHandles.get(fileID);
  let accessID;
  try {
    let accessHandle;
    // TODO: Remove this once the Access Handles API has settled.
    // TODO: Closure is confused by this code that supports two versions of
    //       the same API, so suppress type checking on it.
    /** @suppress {checkTypes} */ var len = FileSystemFileHandle.prototype.createSyncAccessHandle.length;
    if (len == 0) {
      accessHandle = await fileHandle.createSyncAccessHandle();
    } else {
      accessHandle = await fileHandle.createSyncAccessHandle({
        mode: "in-place"
      });
    }
    accessID = wasmfsOPFSAccessHandles.allocate(accessHandle);
  } catch (e) {
    // TODO: Presumably only one of these will appear in the final API?
    if (e.name === "InvalidStateError" || e.name === "NoModificationAllowedError") {
      accessID = -2;
    } else {
      err("unexpected error:", e, e.stack);
      accessID = -29;
    }
  }
  (growMemViews(), HEAP32)[((accessIDPtr) >> 2)] = accessID;
  wasmfsOPFSProxyFinish(ctx);
};

var __wasmfs_opfs_open_blob = async (ctx, fileID, blobIDPtr) => {
  let fileHandle = wasmfsOPFSFileHandles.get(fileID);
  let blobID;
  try {
    let blob = await fileHandle.getFile();
    blobID = wasmfsOPFSBlobs.allocate(blob);
  } catch (e) {
    if (e.name === "NotAllowedError") {
      blobID = -2;
    } else {
      err("unexpected error:", e, e.stack);
      blobID = -29;
    }
  }
  (growMemViews(), HEAP32)[((blobIDPtr) >> 2)] = blobID;
  wasmfsOPFSProxyFinish(ctx);
};

function __wasmfs_opfs_read_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  growMemViews();
  if (!HEAPU8) return -28;
  // Chrome stable rejects SharedArrayBuffer views on SyncAccessHandle.
  let data = new Uint8Array(len);
  try {
    let nread = accessHandle.read(data, {
      at: pos
    });
    growMemViews();
    if (nread > 0 && HEAPU8) HEAPU8.set(data.subarray(0, nread), bufPtr);
    return nread;
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    if (wasmfsOPFSIsStaleHandle(e)) {
      wasmfsOPFSRefreshHandle(accessHandle);
      try {
        let nread = accessHandle.read(data, {
          at: pos
        });
        growMemViews();
        if (nread > 0 && HEAPU8) HEAPU8.set(data.subarray(0, nread), bufPtr);
        return nread;
      } catch (e2) {
        if (e2.name == "TypeError" || wasmfsOPFSIsStaleHandle(e2)) return -11;
        err("unexpected error:", e2, e2.stack);
        return -29;
      }
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}

async function __wasmfs_opfs_read_blob(ctx, blobID, bufPtr, len, pos, nreadPtr) {
  pos = bigintToI53Checked(pos);
  let blob = wasmfsOPFSBlobs.get(blobID);
  let slice = blob.slice(pos, pos + len);
  let nread = 0;
  try {
    // TODO: Use ReadableStreamBYOBReader once
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1189621 is
    // resolved.
    let buf = await slice.arrayBuffer();
    let data = new Uint8Array(buf);
    (growMemViews(), HEAPU8).set(data, bufPtr);
    nread += data.length;
  } catch (e) {
    if (e instanceof RangeError) {
      nread = -21;
    } else {
      err("unexpected error:", e, e.stack);
      nread = -29;
    }
  }
  (growMemViews(), HEAP32)[((nreadPtr) >> 2)] = nread;
  wasmfsOPFSProxyFinish(ctx);
}

var __wasmfs_opfs_remove_child = async (ctx, dirID, namePtr, errPtr) => {
  let name = UTF8ToString(namePtr);
  let dirHandle = wasmfsOPFSDirectoryHandles.get(dirID);
  try {
    await dirHandle.removeEntry(name);
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSProxyFinish(ctx);
};

async function __wasmfs_opfs_set_size_access(ctx, accessID, size, errPtr) {
  size = bigintToI53Checked(size);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  try {
    await accessHandle.truncate(size);
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSProxyFinish(ctx);
}

async function __wasmfs_opfs_set_size_file(ctx, fileID, size, errPtr) {
  size = bigintToI53Checked(size);
  let fileHandle = wasmfsOPFSFileHandles.get(fileID);
  try {
    let writable = await fileHandle.createWritable({
      keepExistingData: true
    });
    await writable.truncate(size);
    await writable.close();
  } catch {
    let err = -29;
    (growMemViews(), HEAP32)[((errPtr) >> 2)] = err;
  }
  wasmfsOPFSProxyFinish(ctx);
}

function __wasmfs_opfs_write_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  growMemViews();
  if (!HEAPU8) return -28;
  let data = new Uint8Array(HEAPU8.subarray(bufPtr, bufPtr + len));
  try {
    return accessHandle.write(data, {
      at: pos
    });
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    if (wasmfsOPFSIsStaleHandle(e)) {
      wasmfsOPFSRefreshHandle(accessHandle);
      try {
        return accessHandle.write(data, {
          at: pos
        });
      } catch (e2) {
        if (e2.name == "TypeError" || wasmfsOPFSIsStaleHandle(e2)) return -11;
        err("unexpected error:", e2, e2.stack);
        return -29;
      }
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}

var FS_stdin_getChar_buffer = [];

/** @type {function(string, boolean=, number=)} */ var intArrayFromString = (stringy, dontAddNull, length) => {
  var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
};

var FS_stdin_getChar = () => {
  if (!FS_stdin_getChar_buffer.length) {
    var result = null;
    if (globalThis.window?.prompt) {
      // Browser.
      result = window.prompt("Input: ");
      // returns null on cancel
      if (result !== null) {
        result += "\n";
      }
    } else {}
    if (!result) {
      return null;
    }
    FS_stdin_getChar_buffer = intArrayFromString(result, true);
  }
  return FS_stdin_getChar_buffer.shift();
};

var __wasmfs_stdin_get_char = () => {
  // Return the read character, or -1 to indicate EOF.
  var c = FS_stdin_getChar();
  if (typeof c === "number") {
    return c;
  }
  return -1;
};

var __wasmfs_thread_utils_heartbeat = queue => {
  var intervalID = setInterval(() => {
    if (ABORT) {
      clearInterval(intervalID);
    } else {
      _emscripten_proxy_execute_queue(queue);
    }
  }, 50);
};

var _emscripten_get_now = () => performance.timeOrigin + performance.now();

var _emscripten_date_now = () => Date.now();

var nowIsMonotonic = 1;

var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

function _clock_time_get(clk_id, ignored_precision, ptime) {
  ignored_precision = bigintToI53Checked(ignored_precision);
  if (!checkWasiClock(clk_id)) {
    return 28;
  }
  var now;
  // all wasi clocks but realtime are monotonic
  if (clk_id === 0) {
    now = _emscripten_date_now();
  } else if (nowIsMonotonic) {
    now = _emscripten_get_now();
  } else {
    return 52;
  }
  // "now" is in ms, and wasi times are in ns.
  var nsec = Math.round(now * 1e3 * 1e3);
  (growMemViews(), HEAP64)[((ptime) >> 3)] = BigInt(nsec);
  return 0;
}

var _emscripten_check_blocking_allowed = () => {
  if (ENVIRONMENT_IS_WORKER) return;
  // Blocking in a worker/pthread is fine.
  warnOnce("Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread");
};

var _emscripten_err = str => err(UTF8ToString(str));

var _emscripten_exit_with_live_runtime = () => {
  runtimeKeepalivePush();
  throw "unwind";
};

var getHeapMax = () => // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
2147483648;

var _emscripten_get_heap_max = () => getHeapMax();

var _emscripten_has_asyncify = () => 0;

var _emscripten_num_logical_cores = () => navigator["hardwareConcurrency"];

var _emscripten_out = str => out(UTF8ToString(str));

var alignMemory = (size, alignment) => {
  assert(alignment, "alignment argument is required");
  return Math.ceil(size / alignment) * alignment;
};

var growMemory = size => {
  var oldHeapSize = wasmMemory.buffer.byteLength;
  var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages);
    // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1;
  } catch (e) {
    err(`growMemory: Attempted to grow heap from ${oldHeapSize} bytes to ${size} bytes, but got error: ${e}`);
  }
};

var _emscripten_resize_heap = requestedSize => {
  var oldSize = (growMemViews(), HEAPU8).length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  if (requestedSize <= oldSize) {
    return false;
  }
  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.
  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
    return false;
  }
  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
    // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
    var replacement = growMemory(newSize);
    if (replacement) {
      return true;
    }
  }
  err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
  return false;
};

var _emscripten_runtime_keepalive_check = keepRuntimeAlive;

var _emscripten_unwind_to_js_event_loop = () => {
  throw "unwind";
};

var webSockets = new HandleAllocator;

var WS = {
  socketEvent: null,
  getSocket(socketId) {
    if (!webSockets.has(socketId)) {
      return 0;
    }
    return webSockets.get(socketId);
  },
  getSocketEvent(socketId) {
    // Singleton event pointer.  Use EmscriptenWebSocketCloseEvent, which is
    // the largest event struct
    this.socketEvent ||= _malloc(520);
    (growMemViews(), HEAPU32)[((this.socketEvent) >> 2)] = socketId;
    return this.socketEvent;
  }
};

function _emscripten_websocket_close(socketId, code, reason) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(3, 0, 1, socketId, code, reason);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  var reasonStr = reason ? UTF8ToString(reason) : undefined;
  // According to WebSocket specification, only close codes that are recognized have integer values
  // 1000-4999, with 3000-3999 and 4000-4999 denoting user-specified close codes:
  // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
  // Therefore be careful to call the .close() function with exact number and types of parameters.
  // Coerce code==0 to undefined, since Wasm->JS call can only marshal integers, and 0 is not allowed.
  if (reason) socket.close(code || undefined, UTF8ToString(reason)); else if (code) socket.close(code); else socket.close();
  return 0;
}

function _emscripten_websocket_delete(socketId) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(4, 0, 1, socketId);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
  webSockets.free(socketId);
  return 0;
}

function _emscripten_websocket_new(createAttributes) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(5, 0, 1, createAttributes);
  if (!globalThis.WebSocket) {
    return -1;
  }
  if (!createAttributes) {
    return -5;
  }
  var url = UTF8ToString((growMemViews(), HEAPU32)[((createAttributes) >> 2)]);
  var protocols = (growMemViews(), HEAPU32)[(((createAttributes) + (4)) >> 2)];
  // TODO: Add support for createOnMainThread==false; currently all WebSocket connections are created on the main thread.
  // var createOnMainThread = HEAP8[createAttributes+2];
  var socket = protocols ? new WebSocket(url, UTF8ToString(protocols).split(",")) : new WebSocket(url);
  // We always marshal received WebSocket data back to Wasm, so enable receiving the data as arraybuffers for easy marshalling.
  socket.binaryType = "arraybuffer";
  // TODO: While strictly not necessary, this ID would be good to be unique across all threads to avoid confusion.
  var socketId = webSockets.allocate(socket);
  return socketId;
}

function _emscripten_websocket_send_binary(socketId, binaryData, dataLength) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(6, 0, 1, socketId, binaryData, dataLength);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  // TODO: This is temporary to cast a shared Uint8Array to a non-shared Uint8Array. This could be removed if WebSocket API is improved
  // to allow passing in views to SharedArrayBuffers
  socket.send(new Uint8Array((growMemViews(), HEAPU8).subarray((binaryData), binaryData + dataLength)));
  return 0;
}

function _emscripten_websocket_set_onclose_callback_on_thread(socketId, userData, callbackFunc, thread) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(7, 0, 1, socketId, userData, callbackFunc, thread);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  socket.onclose = e => {
    var eventPtr = WS.getSocketEvent(socketId);
    (growMemViews(), HEAP8)[(eventPtr) + (4)] = e.wasClean, (growMemViews(), HEAP16)[(((eventPtr) + (6)) >> 1)] = e.code, 
    stringToUTF8(e.reason, eventPtr + 8, 512);
    getWasmTableEntry(callbackFunc)(0, eventPtr, userData);
  };
  return 0;
}

function _emscripten_websocket_set_onerror_callback_on_thread(socketId, userData, callbackFunc, thread) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(8, 0, 1, socketId, userData, callbackFunc, thread);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  socket.onerror = e => {
    var eventPtr = WS.getSocketEvent(socketId);
    getWasmTableEntry(callbackFunc)(0, eventPtr, userData);
  };
  return 0;
}

var stringToNewUTF8 = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8(str, ret, size);
  return ret;
};

function _emscripten_websocket_set_onmessage_callback_on_thread(socketId, userData, callbackFunc, thread) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(9, 0, 1, socketId, userData, callbackFunc, thread);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  socket.onmessage = e => {
    var isText = typeof e.data == "string";
    if (isText) {
      var buf = stringToNewUTF8(e.data);
      var len = lengthBytesUTF8(e.data) + 1;
    } else {
      var len = e.data.byteLength;
      var buf = _malloc(len);
      (growMemViews(), HEAP8).set(new Uint8Array(e.data), buf);
    }
    var eventPtr = WS.getSocketEvent(socketId);
    (growMemViews(), HEAPU32)[(((eventPtr) + (4)) >> 2)] = buf, (growMemViews(), HEAP32)[(((eventPtr) + (8)) >> 2)] = len, 
    (growMemViews(), HEAP8)[(eventPtr) + (12)] = isText, getWasmTableEntry(callbackFunc)(0, eventPtr, userData);
    _free(buf);
  };
  return 0;
}

function _emscripten_websocket_set_onopen_callback_on_thread(socketId, userData, callbackFunc, thread) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(10, 0, 1, socketId, userData, callbackFunc, thread);
  // TODO:
  //    if (thread == 2 ||
  //      (thread == _pthread_self()) return emscripten_websocket_set_onopen_callback_on_calling_thread(socketId, userData, callbackFunc);
  var socket = WS.getSocket(socketId);
  if (!socket) {
    return -3;
  }
  socket.onopen = e => {
    var eventPtr = WS.getSocketEvent(socketId);
    getWasmTableEntry(callbackFunc)(0, eventPtr, userData);
  };
  return 0;
}

var ENV = {};

var getExecutableName = () => thisProgram || "./this.program";

var getEnvStrings = () => {
  if (!getEnvStrings.strings) {
    // Default values.
    var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
    var env = {
      "USER": "web_user",
      "LOGNAME": "web_user",
      "PATH": "/",
      "PWD": "/",
      "HOME": "/home/web_user",
      "LANG": lang,
      "_": getExecutableName()
    };
    // Apply the user-provided values, if any.
    for (var x in ENV) {
      // x is a key in ENV; if ENV[x] is undefined, that means it was
      // explicitly set to be so. We allow user code to do that to
      // force variables with default values to remain unset.
      if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
      strings.push(`${x}=${env[x]}`);
    }
    getEnvStrings.strings = strings;
  }
  return getEnvStrings.strings;
};

function _environ_get(__environ, environ_buf) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(11, 0, 1, __environ, environ_buf);
  var bufSize = 0;
  var envp = 0;
  for (var string of getEnvStrings()) {
    var ptr = environ_buf + bufSize;
    (growMemViews(), HEAPU32)[(((__environ) + (envp)) >> 2)] = ptr;
    bufSize += stringToUTF8(string, ptr, Infinity) + 1;
    envp += 4;
  }
  return 0;
}

function _environ_sizes_get(penviron_count, penviron_buf_size) {
  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(12, 0, 1, penviron_count, penviron_buf_size);
  var strings = getEnvStrings();
  (growMemViews(), HEAPU32)[((penviron_count) >> 2)] = strings.length;
  var bufSize = 0;
  for (var string of strings) {
    bufSize += lengthBytesUTF8(string) + 1;
  }
  (growMemViews(), HEAPU32)[((penviron_buf_size) >> 2)] = bufSize;
  return 0;
}

var _llvm_eh_typeid_for = type => type;

var VIRTUALSTATE = {
  dataChannelsMap: {},
  nextId: 1,
  getId: function() {
    var ret = VIRTUALSTATE.nextId++;
    if (VIRTUALSTATE.nextId > 1e9) VIRTUALSTATE.nextId = 1;
    return ret;
  },
  getPromise: function(id) {
    var p = new Promise((resolve, reject) => {
      if (VIRTUALSTATE[id]) {
        VIRTUALSTATE[id].reject();
      }
      VIRTUALSTATE[id] = {
        resolve,
        reject
      };
    });
    return p;
  },
  resolvePromise: function(id, json) {
    if (VIRTUALSTATE[id]) {
      VIRTUALSTATE[id].resolve(json);
      delete VIRTUALSTATE[id];
    }
  }
};

function virtual_get(url) {
  var id = VIRTUALSTATE.getId();
  Module._virtual_get_request(id, stringToNewUTF8(url));
  return VIRTUALSTATE.getPromise(id);
}

function virtual_post(url, postdata) {
  var id = VIRTUALSTATE.postId();
  Module._virtual_post_request(id, stringToNewUTF8(url), stringToNewUTF8(postdata));
  return VIRTUALSTATE.getPromise(id);
}

function _onAPIResult(id, json) {
  VIRTUALSTATE.resolvePromise(id, JSON.parse(UTF8ToString(json)));
}

var _onChain = json => {
  if (typeof Module["onChain"] == "function") {
    Module["onChain"](JSON.parse(UTF8ToString(json)));
  }
};

var _onConnect = json => {
  if (typeof Module["onConnect"] == "function") {
    Module["onConnect"](JSON.parse(UTF8ToString(json)));
  }
};

var _onDisconnect = json => {
  if (typeof Module["onDisconnect"] == "function") {
    Module["onDisconnect"](JSON.parse(UTF8ToString(json)));
  }
};

var _onMempoolAdd = json => {
  if (typeof Module["onMempoolAdd"] == "function") {
    Module["onMempoolAdd"](JSON.parse(UTF8ToString(json)));
  }
};

var _onMempoolErase = json => {
  if (typeof Module["onMempoolErase"] == "function") {
    Module["onMempoolErase"](JSON.parse(UTF8ToString(json)));
  }
};

function stream_control(msg) {
  Module._stream_control(stringToNewUTF8(JSON.stringify(msg)));
}

var _onStream = json => {
  var f = Module["onStream"];
  if (typeof f == "function") {
    f(JSON.parse(UTF8ToString(json)));
  }
};

var initRandomFill = () => view => (view.set(crypto.getRandomValues(new Uint8Array(view.byteLength))), 
0);

var randomFill = view => (randomFill = initRandomFill())(view);

var _random_get = (buffer, size) => randomFill((growMemViews(), HEAPU8).subarray(buffer, buffer + size));

var WEBRTC = {
  peerConnectionsMap: {},
  dataChannelsMap: {},
  nextId: 1,
  allocUTF8FromString: function(str) {
    var strLen = lengthBytesUTF8(str);
    var strOnHeap = _malloc(strLen + 1);
    stringToUTF8(str, strOnHeap, strLen + 1);
    return strOnHeap;
  },
  registerPeerConnection: function(peerConnection) {
    var pc = WEBRTC.nextId++;
    WEBRTC.peerConnectionsMap[pc] = peerConnection;
    peerConnection.onnegotiationneeded = function() {
      peerConnection.createOffer().then(function(offer) {
        return WEBRTC.handleDescription(peerConnection, offer);
      }).catch(function(err) {
        console.error(err);
      });
    };
    peerConnection.onicecandidate = function(evt) {
      if (evt.candidate && evt.candidate.candidate) WEBRTC.handleCandidate(peerConnection, evt.candidate);
    };
    peerConnection.onconnectionstatechange = function() {
      WEBRTC.handleConnectionStateChange(peerConnection, peerConnection.connectionState);
    };
    peerConnection.oniceconnectionstatechange = function() {
      WEBRTC.handleIceStateChange(peerConnection, peerConnection.iceConnectionState);
    };
    peerConnection.onicegatheringstatechange = function() {
      WEBRTC.handleGatheringStateChange(peerConnection, peerConnection.iceGatheringState);
    };
    peerConnection.onsignalingstatechange = function() {
      WEBRTC.handleSignalingStateChange(peerConnection, peerConnection.signalingState);
    };
    return pc;
  },
  registerDataChannel: function(dataChannel) {
    var dc = WEBRTC.nextId++;
    WEBRTC.dataChannelsMap[dc] = dataChannel;
    dataChannel.binaryType = "arraybuffer";
    return dc;
  },
  handleDescription: function(peerConnection, description) {
    return peerConnection.setLocalDescription(description).then(function() {
      if (peerConnection.rtcUserDeleted) return;
      if (!peerConnection.rtcDescriptionCallback) return;
      var desc = peerConnection.localDescription;
      var pSdp = WEBRTC.allocUTF8FromString(desc.sdp);
      var pType = WEBRTC.allocUTF8FromString(desc.type);
      var callback = peerConnection.rtcDescriptionCallback;
      var userPointer = peerConnection.rtcUserPointer || 0;
      getWasmTableEntry(callback)(pSdp, pType, userPointer);
      _free(pSdp);
      _free(pType);
    });
  },
  handleCandidate: function(peerConnection, candidate) {
    if (peerConnection.rtcUserDeleted) return;
    if (!peerConnection.rtcCandidateCallback) return;
    var pCandidate = WEBRTC.allocUTF8FromString(candidate.candidate);
    var pSdpMid = WEBRTC.allocUTF8FromString(candidate.sdpMid);
    var candidateCallback = peerConnection.rtcCandidateCallback;
    var userPointer = peerConnection.rtcUserPointer || 0;
    getWasmTableEntry(candidateCallback)(pCandidate, pSdpMid, userPointer);
    _free(pCandidate);
    _free(pSdpMid);
  },
  handleConnectionStateChange: function(peerConnection, connectionState) {
    if (peerConnection.rtcUserDeleted) return;
    if (!peerConnection.rtcStateChangeCallback) return;
    var map = {
      "new": 0,
      "connecting": 1,
      "connected": 2,
      "disconnected": 3,
      "failed": 4,
      "closed": 5
    };
    if (connectionState in map) {
      var stateChangeCallback = peerConnection.rtcStateChangeCallback;
      var userPointer = peerConnection.rtcUserPointer || 0;
      getWasmTableEntry(stateChangeCallback)(map[connectionState], userPointer);
    }
  },
  handleIceStateChange: function(peerConnection, iceConnectionState) {
    if (peerConnection.rtcUserDeleted) return;
    if (!peerConnection.rtcIceStateChangeCallback) return;
    var map = {
      "new": 0,
      "checking": 1,
      "connected": 2,
      "completed": 3,
      "failed": 4,
      "disconnected": 5,
      "closed": 6
    };
    if (iceConnectionState in map) {
      var iceStateChangeCallback = peerConnection.rtcIceStateChangeCallback;
      var userPointer = peerConnection.rtcUserPointer || 0;
      getWasmTableEntry(iceStateChangeCallback)(map[iceConnectionState], userPointer);
    }
  },
  handleGatheringStateChange: function(peerConnection, iceGatheringState) {
    if (peerConnection.rtcUserDeleted) return;
    if (!peerConnection.rtcGatheringStateChangeCallback) return;
    var map = {
      "new": 0,
      "gathering": 1,
      "complete": 2
    };
    if (iceGatheringState in map) {
      var gatheringStateChangeCallback = peerConnection.rtcGatheringStateChangeCallback;
      var userPointer = peerConnection.rtcUserPointer || 0;
      getWasmTableEntry(gatheringStateChangeCallback)(map[iceGatheringState], userPointer);
    }
  },
  handleSignalingStateChange: function(peerConnection, signalingState) {
    if (peerConnection.rtcUserDeleted) return;
    if (!peerConnection.rtcSignalingStateChangeCallback) return;
    var map = {
      "stable": 0,
      "have-local-offer": 1,
      "have-remote-offer": 2,
      "have-local-pranswer": 3,
      "have-remote-pranswer": 4
    };
    if (signalingState in map) {
      var signalingStateChangeCallback = peerConnection.rtcSignalingStateChangeCallback;
      var userPointer = peerConnection.rtcUserPointer || 0;
      getWasmTableEntry(signalingStateChangeCallback)(map[signalingState], userPointer);
    }
  }
};

function _rtcCreateDataChannel(pc, pLabel, unordered, maxRetransmits, maxPacketLifeTime) {
  if (!pc) return 0;
  var label = UTF8ToString(pLabel);
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  var datachannelInit = {
    ordered: !unordered
  };
  // Browsers throw an exception when both are present (even if set to null)
  if (maxRetransmits >= 0) datachannelInit.maxRetransmits = maxRetransmits; else if (maxPacketLifeTime >= 0) datachannelInit.maxPacketLifeTime = maxPacketLifeTime;
  var channel = peerConnection.createDataChannel(label, datachannelInit);
  return WEBRTC.registerDataChannel(channel);
}

function _rtcCreatePeerConnection(pUrls, pUsernames, pPasswords, nIceServers) {
  if (!window.RTCPeerConnection) return 0;
  var iceServers = [];
  for (var i = 0; i < nIceServers; ++i) {
    growMemViews();
    var heap = HEAPU32;
    if (!heap) return 0;
    var pUrl = heap[pUrls / heap.BYTES_PER_ELEMENT + i];
    var url = UTF8ToString(pUrl);
    var pUsername = heap[pUsernames / heap.BYTES_PER_ELEMENT + i];
    var username = UTF8ToString(pUsername);
    var pPassword = heap[pPasswords / heap.BYTES_PER_ELEMENT + i];
    var password = UTF8ToString(pPassword);
    if (username == "") {
      iceServers.push({
        urls: [ url ]
      });
    } else {
      iceServers.push({
        urls: [ url ],
        username,
        credential: password
      });
    }
  }
  var config = {
    iceServers
  };
  return WEBRTC.registerPeerConnection(new RTCPeerConnection(config));
}

function _rtcDeleteDataChannel(dc) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  if (dataChannel) {
    dataChannel.rtcUserDeleted = true;
    delete WEBRTC.dataChannelsMap[dc];
  }
}

function _rtcDeletePeerConnection(pc) {
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  if (peerConnection) {
    peerConnection.close();
    peerConnection.rtcUserDeleted = true;
    delete WEBRTC.peerConnectionsMap[pc];
  }
}

function _rtcGetBufferedAmount(dc) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  return dataChannel.bufferedAmount;
}

function _rtcGetDataChannelLabel(dc, pBuffer, size) {
  var label = WEBRTC.dataChannelsMap[dc].label;
  stringToUTF8(label, pBuffer, size);
  return lengthBytesUTF8(label);
}

function _rtcGetLocalDescription(pc) {
  if (!pc) return 0;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  var localDescription = peerConnection.localDescription;
  if (!localDescription) return 0;
  var sdp = WEBRTC.allocUTF8FromString(localDescription.sdp);
  // sdp should be freed later in c++.
  return sdp;
}

function _rtcGetLocalDescriptionType(pc) {
  if (!pc) return 0;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  var localDescription = peerConnection.localDescription;
  if (!localDescription) return 0;
  var type = WEBRTC.allocUTF8FromString(localDescription.type);
  // type should be freed later in c++.
  return type;
}

function _rtcSendMessage(dc, pBuffer, size) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  if (dataChannel.readyState != "open") return -1;
  if (size >= 0) {
    growMemViews();
    if (!HEAPU8) return -1;
    var heapBytes = HEAPU8.subarray(pBuffer, pBuffer + size);
    var byteArray = new Uint8Array(size);
    byteArray.set(heapBytes);
    dataChannel.send(byteArray);
    return size;
  } else {
    var str = UTF8ToString(pBuffer);
    dataChannel.send(str);
    return lengthBytesUTF8(str);
  }
}

function _rtcSetBufferedAmountLowCallback(dc, bufferedAmountLowCallback) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  var cb = function(evt) {
    if (dataChannel.rtcUserDeleted) return;
    var userPointer = dataChannel.rtcUserPointer || 0;
    getWasmTableEntry(bufferedAmountLowCallback)(userPointer);
  };
  dataChannel.onbufferedamountlow = cb;
}

function _rtcSetBufferedAmountLowThreshold(dc, threshold) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  dataChannel.bufferedAmountLowThreshold = threshold;
}

function _rtcSetDataChannelCallback(pc, dataChannelCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.ondatachannel = function(evt) {
    if (peerConnection.rtcUserDeleted) return;
    var dc = WEBRTC.registerDataChannel(evt.channel);
    var userPointer = peerConnection.rtcUserPointer || 0;
    getWasmTableEntry(dataChannelCallback)(dc, userPointer);
  };
}

function _rtcSetErrorCallback(dc, errorCallback) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  var cb = function(evt) {
    if (dataChannel.rtcUserDeleted) return;
    var userPointer = dataChannel.rtcUserPointer || 0;
    var pError = evt.message ? WEBRTC.allocUTF8FromString(evt.message) : 0;
    getWasmTableEntry(errorCallback)(pError, userPointer);
    _free(pError);
  };
  dataChannel.onerror = cb;
}

function _rtcSetGatheringStateChangeCallback(pc, gatheringStateChangeCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcGatheringStateChangeCallback = gatheringStateChangeCallback;
}

function _rtcSetIceStateChangeCallback(pc, iceStateChangeCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcIceStateChangeCallback = iceStateChangeCallback;
}

function _rtcSetLocalCandidateCallback(pc, candidateCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcCandidateCallback = candidateCallback;
}

function _rtcSetLocalDescriptionCallback(pc, descriptionCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcDescriptionCallback = descriptionCallback;
}

function _rtcSetMessageCallback(dc, messageCallback) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  dataChannel.onmessage = function(evt) {
    if (dataChannel.rtcUserDeleted) return;
    var userPointer = dataChannel.rtcUserPointer || 0;
    if (typeof evt.data == "string") {
      var pStr = WEBRTC.allocUTF8FromString(evt.data);
      getWasmTableEntry(messageCallback)(pStr, -1, userPointer);
      _free(pStr);
    } else {
      var byteArray = new Uint8Array(evt.data);
      var size = byteArray.length;
      var pBuffer = _malloc(size);
      growMemViews();
      if (!HEAPU8) return;
      HEAPU8.subarray(pBuffer, pBuffer + size).set(byteArray);
      getWasmTableEntry(messageCallback)(pBuffer, size, userPointer);
      _free(pBuffer);
    }
  };
  dataChannel.onclose = function() {
    if (dataChannel.rtcUserDeleted) return;
    var userPointer = dataChannel.rtcUserPointer || 0;
    getWasmTableEntry(messageCallback)(0, 0, userPointer);
  };
}

function _rtcSetOpenCallback(dc, openCallback) {
  var dataChannel = WEBRTC.dataChannelsMap[dc];
  var cb = function() {
    if (dataChannel.rtcUserDeleted) return;
    var userPointer = dataChannel.rtcUserPointer || 0;
    getWasmTableEntry(openCallback)(userPointer);
  };
  dataChannel.onopen = cb;
  if (dataChannel.readyState == "open") setTimeout(cb, 0);
}

function _rtcSetRemoteDescription(pc, pSdp, pType) {
  var description = new RTCSessionDescription({
    sdp: UTF8ToString(pSdp),
    type: UTF8ToString(pType)
  });
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.setRemoteDescription(description).then(function() {
    if (peerConnection.rtcUserDeleted) return;
    if (description.type == "offer") {
      peerConnection.createAnswer().then(function(answer) {
        return WEBRTC.handleDescription(peerConnection, answer);
      }).catch(function(err) {
        console.error(err);
      });
    }
  }).catch(function(err) {
    console.error(err);
  });
}

function _rtcSetSignalingStateChangeCallback(pc, signalingStateChangeCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcSignalingStateChangeCallback = signalingStateChangeCallback;
}

function _rtcSetStateChangeCallback(pc, stateChangeCallback) {
  if (!pc) return;
  var peerConnection = WEBRTC.peerConnectionsMap[pc];
  peerConnection.rtcStateChangeCallback = stateChangeCallback;
}

function _rtcSetUserPointer(i, ptr) {
  if (WEBRTC.peerConnectionsMap[i]) WEBRTC.peerConnectionsMap[i].rtcUserPointer = ptr;
  if (WEBRTC.dataChannelsMap[i]) WEBRTC.dataChannelsMap[i].rtcUserPointer = ptr;
}

var stringToUTF8OnStack = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8(str, ret, size);
  return ret;
};

PThread.init();

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // With WASM_ESM_INTEGRATION this has to happen at the top level and not
  // delayed until processModuleArgs.
  initMemory();
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
  Module["FS_createDataFile"] = FS.createDataFile;
  Module["FS_createPreloadedFile"] = FS.createPreloadedFile;
  // End ATMODULES hooks
  checkIncomingModuleAPI();
  if (Module["arguments"]) arguments_ = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  // Assertions on removed incoming Module JS APIs.
  assert(typeof Module["memoryInitializerPrefixURL"] == "undefined", "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["pthreadMainPrefixURL"] == "undefined", "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["cdInitializerPrefixURL"] == "undefined", "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["filePackagePrefixURL"] == "undefined", "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["read"] == "undefined", "Module.read option was removed");
  assert(typeof Module["readAsync"] == "undefined", "Module.readAsync option was removed (modify readAsync in JS)");
  assert(typeof Module["readBinary"] == "undefined", "Module.readBinary option was removed (modify readBinary in JS)");
  assert(typeof Module["setWindowTitle"] == "undefined", "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
  assert(typeof Module["TOTAL_MEMORY"] == "undefined", "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
  assert(typeof Module["ENVIRONMENT"] == "undefined", "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
  assert(typeof Module["STACK_SIZE"] == "undefined", "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
  if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
    while (Module["preInit"].length > 0) {
      Module["preInit"].shift()();
    }
  }
  consumedModuleProp("preInit");
}

// Begin runtime exports
// End runtime exports
// Begin JS library exports
Module["ExitStatus"] = ExitStatus;

function installLiveHeapExports() {
  var specs = [
    ["HEAP8", () => HEAP8],
    ["HEAP16", () => HEAP16],
    ["HEAPU8", () => HEAPU8],
    ["HEAPU16", () => HEAPU16],
    ["HEAP32", () => HEAP32],
    ["HEAPU32", () => HEAPU32],
    ["HEAPF32", () => HEAPF32],
    ["HEAPF64", () => HEAPF64],
    ["HEAP64", () => HEAP64],
    ["HEAPU64", () => HEAPU64]
  ];
  for (const spec of specs) {
    Object.defineProperty(Module, spec[0], {
      configurable: true,
      enumerable: true,
      get: () => {
        growMemViews();
        return spec[1]();
      }
    });
  }
}
installLiveHeapExports();

Module["PThread"] = PThread;

Module["terminateWorker"] = terminateWorker;

Module["cleanupThread"] = cleanupThread;

Module["addOnPreRun"] = addOnPreRun;

Module["onPreRuns"] = onPreRuns;

Module["callRuntimeCallbacks"] = callRuntimeCallbacks;

Module["addRunDependency"] = addRunDependency;

Module["runDependencies"] = runDependencies;

Module["removeRunDependency"] = removeRunDependency;

Module["dependenciesFulfilled"] = dependenciesFulfilled;

Module["runDependencyTracking"] = runDependencyTracking;

Module["runDependencyWatcher"] = runDependencyWatcher;

Module["spawnThread"] = spawnThread;

Module["_exit"] = _exit;

Module["exitJS"] = exitJS;

Module["_proc_exit"] = _proc_exit;

Module["keepRuntimeAlive"] = keepRuntimeAlive;

Module["runtimeKeepaliveCounter"] = runtimeKeepaliveCounter;

Module["proxyToMainThread"] = proxyToMainThread;

Module["stackSave"] = stackSave;

Module["stackRestore"] = stackRestore;

Module["stackAlloc"] = stackAlloc;

Module["exitOnMainThread"] = exitOnMainThread;

Module["runtimeKeepalivePop"] = runtimeKeepalivePop;

Module["waitAsyncPolyfilled"] = waitAsyncPolyfilled;

Module["ptrToString"] = ptrToString;

Module["addOnPostRun"] = addOnPostRun;

Module["onPostRuns"] = onPostRuns;

Module["establishStackSpace"] = establishStackSpace;

Module["getValue"] = getValue;

Module["invokeEntryPoint"] = invokeEntryPoint;

Module["getWasmTableEntry"] = getWasmTableEntry;

Module["wasmTableMirror"] = wasmTableMirror;

Module["noExitRuntime"] = noExitRuntime;

Module["registerTLSInit"] = registerTLSInit;

Module["runtimeKeepalivePush"] = runtimeKeepalivePush;

Module["setValue"] = setValue;

Module["warnOnce"] = warnOnce;

Module["wasmMemory"] = wasmMemory;

Module["___assert_fail"] = ___assert_fail;

Module["UTF8ToString"] = UTF8ToString;

Module["UTF8ArrayToString"] = UTF8ArrayToString;

Module["UTF8Decoder"] = UTF8Decoder;

Module["findStringEnd"] = findStringEnd;

Module["___call_sighandler"] = ___call_sighandler;

Module["___cxa_begin_catch"] = ___cxa_begin_catch;

Module["exceptionCaught"] = exceptionCaught;

Module["uncaughtExceptionCount"] = uncaughtExceptionCount;

Module["___cxa_end_catch"] = ___cxa_end_catch;

Module["exceptionLast"] = exceptionLast;

Module["___cxa_find_matching_catch_2"] = ___cxa_find_matching_catch_2;

Module["findMatchingCatch"] = findMatchingCatch;

Module["ExceptionInfo"] = ExceptionInfo;

Module["setTempRet0"] = setTempRet0;

Module["___cxa_find_matching_catch_3"] = ___cxa_find_matching_catch_3;

Module["___cxa_find_matching_catch_4"] = ___cxa_find_matching_catch_4;

Module["___cxa_rethrow"] = ___cxa_rethrow;

Module["___cxa_throw"] = ___cxa_throw;

Module["getExceptionMessage"] = getExceptionMessage;

Module["getExceptionMessageCommon"] = getExceptionMessageCommon;

Module["decrementExceptionRefcount"] = decrementExceptionRefcount;

Module["incrementExceptionRefcount"] = incrementExceptionRefcount;

Module["___cxa_uncaught_exceptions"] = ___cxa_uncaught_exceptions;

Module["___pthread_create_js"] = ___pthread_create_js;

Module["pthreadCreateProxied"] = pthreadCreateProxied;

Module["_emscripten_has_threading_support"] = _emscripten_has_threading_support;

Module["___resumeException"] = ___resumeException;

Module["__abort_js"] = __abort_js;

Module["__emscripten_init_main_thread_js"] = __emscripten_init_main_thread_js;

Module["__emscripten_notify_mailbox_postmessage"] = __emscripten_notify_mailbox_postmessage;

Module["checkMailbox"] = checkMailbox;

Module["callUserCallback"] = callUserCallback;

Module["handleException"] = handleException;

Module["maybeExit"] = maybeExit;

Module["__emscripten_thread_mailbox_await"] = __emscripten_thread_mailbox_await;

Module["__emscripten_receive_on_main_thread_js"] = __emscripten_receive_on_main_thread_js;

Module["proxiedJSCallArgs"] = proxiedJSCallArgs;

Module["__emscripten_runtime_keepalive_clear"] = __emscripten_runtime_keepalive_clear;

Module["__emscripten_thread_cleanup"] = __emscripten_thread_cleanup;

Module["__emscripten_thread_set_strongref"] = __emscripten_thread_set_strongref;

Module["__gmtime_js"] = __gmtime_js;

Module["bigintToI53Checked"] = bigintToI53Checked;

Module["INT53_MAX"] = INT53_MAX;

Module["INT53_MIN"] = INT53_MIN;

Module["__localtime_js"] = __localtime_js;

Module["ydayFromDate"] = ydayFromDate;

Module["isLeapYear"] = isLeapYear;

Module["MONTH_DAYS_LEAP_CUMULATIVE"] = MONTH_DAYS_LEAP_CUMULATIVE;

Module["MONTH_DAYS_REGULAR_CUMULATIVE"] = MONTH_DAYS_REGULAR_CUMULATIVE;

Module["__tzset_js"] = __tzset_js;

Module["stringToUTF8"] = stringToUTF8;

Module["stringToUTF8Array"] = stringToUTF8Array;

Module["lengthBytesUTF8"] = lengthBytesUTF8;

Module["__wasmfs_copy_preloaded_file_data"] = __wasmfs_copy_preloaded_file_data;

Module["__wasmfs_get_num_preloaded_dirs"] = __wasmfs_get_num_preloaded_dirs;

Module["wasmFSPreloadedDirs"] = wasmFSPreloadedDirs;

Module["__wasmfs_get_num_preloaded_files"] = __wasmfs_get_num_preloaded_files;

Module["wasmFSPreloadedFiles"] = wasmFSPreloadedFiles;

Module["wasmFSPreloadingFlushed"] = wasmFSPreloadingFlushed;

Module["__wasmfs_get_preloaded_child_path"] = __wasmfs_get_preloaded_child_path;

Module["__wasmfs_get_preloaded_file_mode"] = __wasmfs_get_preloaded_file_mode;

Module["__wasmfs_get_preloaded_file_size"] = __wasmfs_get_preloaded_file_size;

Module["__wasmfs_get_preloaded_parent_path"] = __wasmfs_get_preloaded_parent_path;

Module["__wasmfs_get_preloaded_path_name"] = __wasmfs_get_preloaded_path_name;

Module["__wasmfs_opfs_close_access"] = __wasmfs_opfs_close_access;

Module["wasmfsOPFSAccessHandles"] = wasmfsOPFSAccessHandles;

Module["HandleAllocator"] = HandleAllocator;

Module["wasmfsOPFSProxyFinish"] = wasmfsOPFSProxyFinish;

Module["__wasmfs_opfs_close_blob"] = __wasmfs_opfs_close_blob;

Module["wasmfsOPFSBlobs"] = wasmfsOPFSBlobs;

Module["__wasmfs_opfs_flush_access"] = __wasmfs_opfs_flush_access;

Module["__wasmfs_opfs_free_directory"] = __wasmfs_opfs_free_directory;

Module["wasmfsOPFSDirectoryHandles"] = wasmfsOPFSDirectoryHandles;

Module["__wasmfs_opfs_free_file"] = __wasmfs_opfs_free_file;

Module["wasmfsOPFSFileHandles"] = wasmfsOPFSFileHandles;

Module["__wasmfs_opfs_get_child"] = __wasmfs_opfs_get_child;

Module["wasmfsOPFSGetOrCreateFile"] = wasmfsOPFSGetOrCreateFile;

Module["wasmfsOPFSGetOrCreateDir"] = wasmfsOPFSGetOrCreateDir;

Module["__wasmfs_opfs_get_entries"] = __wasmfs_opfs_get_entries;

Module["__wasmfs_opfs_get_size_access"] = __wasmfs_opfs_get_size_access;

Module["__wasmfs_opfs_get_size_blob"] = __wasmfs_opfs_get_size_blob;

Module["__wasmfs_opfs_get_size_file"] = __wasmfs_opfs_get_size_file;

Module["__wasmfs_opfs_init_root_directory"] = __wasmfs_opfs_init_root_directory;

Module["__wasmfs_opfs_insert_directory"] = __wasmfs_opfs_insert_directory;

Module["__wasmfs_opfs_insert_file"] = __wasmfs_opfs_insert_file;

Module["__wasmfs_opfs_move_file"] = __wasmfs_opfs_move_file;

Module["__wasmfs_opfs_open_access"] = __wasmfs_opfs_open_access;

Module["__wasmfs_opfs_open_blob"] = __wasmfs_opfs_open_blob;

Module["__wasmfs_opfs_read_access"] = __wasmfs_opfs_read_access;

Module["__wasmfs_opfs_read_blob"] = __wasmfs_opfs_read_blob;

Module["__wasmfs_opfs_remove_child"] = __wasmfs_opfs_remove_child;

Module["__wasmfs_opfs_set_size_access"] = __wasmfs_opfs_set_size_access;

Module["__wasmfs_opfs_set_size_file"] = __wasmfs_opfs_set_size_file;

Module["__wasmfs_opfs_write_access"] = __wasmfs_opfs_write_access;

Module["__wasmfs_stdin_get_char"] = __wasmfs_stdin_get_char;

Module["FS_stdin_getChar"] = FS_stdin_getChar;

Module["FS_stdin_getChar_buffer"] = FS_stdin_getChar_buffer;

Module["intArrayFromString"] = intArrayFromString;

Module["__wasmfs_thread_utils_heartbeat"] = __wasmfs_thread_utils_heartbeat;

Module["_clock_time_get"] = _clock_time_get;

Module["_emscripten_get_now"] = _emscripten_get_now;

Module["_emscripten_date_now"] = _emscripten_date_now;

Module["nowIsMonotonic"] = nowIsMonotonic;

Module["checkWasiClock"] = checkWasiClock;

Module["_emscripten_check_blocking_allowed"] = _emscripten_check_blocking_allowed;

Module["_emscripten_err"] = _emscripten_err;

Module["_emscripten_exit_with_live_runtime"] = _emscripten_exit_with_live_runtime;

Module["_emscripten_get_heap_max"] = _emscripten_get_heap_max;

Module["getHeapMax"] = getHeapMax;

Module["_emscripten_has_asyncify"] = _emscripten_has_asyncify;

Module["_emscripten_num_logical_cores"] = _emscripten_num_logical_cores;

Module["_emscripten_out"] = _emscripten_out;

Module["_emscripten_resize_heap"] = _emscripten_resize_heap;

Module["alignMemory"] = alignMemory;

Module["growMemory"] = growMemory;

Module["_emscripten_runtime_keepalive_check"] = _emscripten_runtime_keepalive_check;

Module["_emscripten_unwind_to_js_event_loop"] = _emscripten_unwind_to_js_event_loop;

Module["_emscripten_websocket_close"] = _emscripten_websocket_close;

Module["WS"] = WS;

Module["webSockets"] = webSockets;

Module["_emscripten_websocket_delete"] = _emscripten_websocket_delete;

Module["_emscripten_websocket_new"] = _emscripten_websocket_new;

Module["_emscripten_websocket_send_binary"] = _emscripten_websocket_send_binary;

Module["_emscripten_websocket_set_onclose_callback_on_thread"] = _emscripten_websocket_set_onclose_callback_on_thread;

Module["_emscripten_websocket_set_onerror_callback_on_thread"] = _emscripten_websocket_set_onerror_callback_on_thread;

Module["_emscripten_websocket_set_onmessage_callback_on_thread"] = _emscripten_websocket_set_onmessage_callback_on_thread;

Module["stringToNewUTF8"] = stringToNewUTF8;

Module["_emscripten_websocket_set_onopen_callback_on_thread"] = _emscripten_websocket_set_onopen_callback_on_thread;

Module["_environ_get"] = _environ_get;

Module["getEnvStrings"] = getEnvStrings;

Module["ENV"] = ENV;

Module["getExecutableName"] = getExecutableName;

Module["_environ_sizes_get"] = _environ_sizes_get;

Module["_llvm_eh_typeid_for"] = _llvm_eh_typeid_for;

Module["_onAPIResult"] = _onAPIResult;

Module["virtual_get"] = virtual_get;

Module["VIRTUALSTATE"] = VIRTUALSTATE;

Module["virtual_post"] = virtual_post;

Module["_onChain"] = _onChain;

Module["_onConnect"] = _onConnect;

Module["_onDisconnect"] = _onDisconnect;

Module["_onMempoolAdd"] = _onMempoolAdd;

Module["_onMempoolErase"] = _onMempoolErase;

Module["_onStream"] = _onStream;

Module["stream_control"] = stream_control;

Module["_random_get"] = _random_get;

Module["randomFill"] = randomFill;

Module["initRandomFill"] = initRandomFill;

Module["_rtcCreateDataChannel"] = _rtcCreateDataChannel;

Module["WEBRTC"] = WEBRTC;

Module["_rtcCreatePeerConnection"] = _rtcCreatePeerConnection;

Module["_rtcDeleteDataChannel"] = _rtcDeleteDataChannel;

Module["_rtcDeletePeerConnection"] = _rtcDeletePeerConnection;

Module["_rtcGetBufferedAmount"] = _rtcGetBufferedAmount;

Module["_rtcGetDataChannelLabel"] = _rtcGetDataChannelLabel;

Module["_rtcGetLocalDescription"] = _rtcGetLocalDescription;

Module["_rtcGetLocalDescriptionType"] = _rtcGetLocalDescriptionType;

Module["_rtcSendMessage"] = _rtcSendMessage;

Module["_rtcSetBufferedAmountLowCallback"] = _rtcSetBufferedAmountLowCallback;

Module["_rtcSetBufferedAmountLowThreshold"] = _rtcSetBufferedAmountLowThreshold;

Module["_rtcSetDataChannelCallback"] = _rtcSetDataChannelCallback;

Module["_rtcSetErrorCallback"] = _rtcSetErrorCallback;

Module["_rtcSetGatheringStateChangeCallback"] = _rtcSetGatheringStateChangeCallback;

Module["_rtcSetIceStateChangeCallback"] = _rtcSetIceStateChangeCallback;

Module["_rtcSetLocalCandidateCallback"] = _rtcSetLocalCandidateCallback;

Module["_rtcSetLocalDescriptionCallback"] = _rtcSetLocalDescriptionCallback;

Module["_rtcSetMessageCallback"] = _rtcSetMessageCallback;

Module["_rtcSetOpenCallback"] = _rtcSetOpenCallback;

Module["_rtcSetRemoteDescription"] = _rtcSetRemoteDescription;

Module["_rtcSetSignalingStateChangeCallback"] = _rtcSetSignalingStateChangeCallback;

Module["_rtcSetStateChangeCallback"] = _rtcSetStateChangeCallback;

Module["_rtcSetUserPointer"] = _rtcSetUserPointer;

Module["stringToUTF8OnStack"] = stringToUTF8OnStack;

// End JS library exports
// end include: postlibrary.js
// proxiedFunctionTable specifies the list of functions that can be called
// either synchronously or asynchronously from other threads in postMessage()d
// or internally queued events. This way a pthread in a Worker can synchronously
// access e.g. the DOM on the main thread.
var proxiedFunctionTable = [ _proc_exit, exitOnMainThread, pthreadCreateProxied, _emscripten_websocket_close, _emscripten_websocket_delete, _emscripten_websocket_new, _emscripten_websocket_send_binary, _emscripten_websocket_set_onclose_callback_on_thread, _emscripten_websocket_set_onerror_callback_on_thread, _emscripten_websocket_set_onmessage_callback_on_thread, _emscripten_websocket_set_onopen_callback_on_thread, _environ_get, _environ_sizes_get ];

function checkIncomingModuleAPI() {
  ignoredModuleProp("fetchSettings");
  ignoredModuleProp("logReadFiles");
  ignoredModuleProp("loadSplitModule");
  ignoredModuleProp("onMalloc");
  ignoredModuleProp("onRealloc");
  ignoredModuleProp("onFree");
  ignoredModuleProp("onSbrkGrow");
}

// Imports from the Wasm binary.
var _pthread_self = Module["_pthread_self"] = makeInvalidEarlyAccess("_pthread_self");

var _malloc = Module["_malloc"] = makeInvalidEarlyAccess("_malloc");

var _free = Module["_free"] = makeInvalidEarlyAccess("_free");

var _virtual_get_request = Module["_virtual_get_request"] = makeInvalidEarlyAccess("_virtual_get_request");

var _virtual_post_request = Module["_virtual_post_request"] = makeInvalidEarlyAccess("_virtual_post_request");

var _stream_control = Module["_stream_control"] = makeInvalidEarlyAccess("_stream_control");

var _main = Module["_main"] = makeInvalidEarlyAccess("_main");

var _fflush = Module["_fflush"] = makeInvalidEarlyAccess("_fflush");

var __emscripten_tls_init = Module["__emscripten_tls_init"] = makeInvalidEarlyAccess("__emscripten_tls_init");

var __emscripten_proxy_main = Module["__emscripten_proxy_main"] = makeInvalidEarlyAccess("__emscripten_proxy_main");

var _emscripten_stack_get_base = Module["_emscripten_stack_get_base"] = makeInvalidEarlyAccess("_emscripten_stack_get_base");

var _emscripten_stack_get_end = Module["_emscripten_stack_get_end"] = makeInvalidEarlyAccess("_emscripten_stack_get_end");

var __emscripten_thread_init = Module["__emscripten_thread_init"] = makeInvalidEarlyAccess("__emscripten_thread_init");

var ___set_thread_state = Module["___set_thread_state"] = makeInvalidEarlyAccess("___set_thread_state");

var __emscripten_thread_crashed = Module["__emscripten_thread_crashed"] = makeInvalidEarlyAccess("__emscripten_thread_crashed");

var _emscripten_proxy_execute_queue = Module["_emscripten_proxy_execute_queue"] = makeInvalidEarlyAccess("_emscripten_proxy_execute_queue");

var _emscripten_proxy_finish = Module["_emscripten_proxy_finish"] = makeInvalidEarlyAccess("_emscripten_proxy_finish");

var __emscripten_run_js_on_main_thread_done = Module["__emscripten_run_js_on_main_thread_done"] = makeInvalidEarlyAccess("__emscripten_run_js_on_main_thread_done");

var __emscripten_run_js_on_main_thread = Module["__emscripten_run_js_on_main_thread"] = makeInvalidEarlyAccess("__emscripten_run_js_on_main_thread");

var __emscripten_thread_free_data = Module["__emscripten_thread_free_data"] = makeInvalidEarlyAccess("__emscripten_thread_free_data");

var __emscripten_thread_exit = Module["__emscripten_thread_exit"] = makeInvalidEarlyAccess("__emscripten_thread_exit");

var __emscripten_check_mailbox = Module["__emscripten_check_mailbox"] = makeInvalidEarlyAccess("__emscripten_check_mailbox");

var _setThrew = Module["_setThrew"] = makeInvalidEarlyAccess("_setThrew");

var __emscripten_tempret_set = Module["__emscripten_tempret_set"] = makeInvalidEarlyAccess("__emscripten_tempret_set");

var _emscripten_stack_init = Module["_emscripten_stack_init"] = makeInvalidEarlyAccess("_emscripten_stack_init");

var _emscripten_stack_set_limits = Module["_emscripten_stack_set_limits"] = makeInvalidEarlyAccess("_emscripten_stack_set_limits");

var _emscripten_stack_get_free = Module["_emscripten_stack_get_free"] = makeInvalidEarlyAccess("_emscripten_stack_get_free");

var __emscripten_stack_restore = Module["__emscripten_stack_restore"] = makeInvalidEarlyAccess("__emscripten_stack_restore");

var __emscripten_stack_alloc = Module["__emscripten_stack_alloc"] = makeInvalidEarlyAccess("__emscripten_stack_alloc");

var _emscripten_stack_get_current = Module["_emscripten_stack_get_current"] = makeInvalidEarlyAccess("_emscripten_stack_get_current");

var ___cxa_decrement_exception_refcount = Module["___cxa_decrement_exception_refcount"] = makeInvalidEarlyAccess("___cxa_decrement_exception_refcount");

var ___cxa_increment_exception_refcount = Module["___cxa_increment_exception_refcount"] = makeInvalidEarlyAccess("___cxa_increment_exception_refcount");

var ___get_exception_message = Module["___get_exception_message"] = makeInvalidEarlyAccess("___get_exception_message");

var ___cxa_can_catch = Module["___cxa_can_catch"] = makeInvalidEarlyAccess("___cxa_can_catch");

var ___cxa_get_exception_ptr = Module["___cxa_get_exception_ptr"] = makeInvalidEarlyAccess("___cxa_get_exception_ptr");

var __wasmfs_opfs_record_entry = Module["__wasmfs_opfs_record_entry"] = makeInvalidEarlyAccess("__wasmfs_opfs_record_entry");

var _wasmfs_flush = Module["_wasmfs_flush"] = makeInvalidEarlyAccess("_wasmfs_flush");

var __indirect_function_table = Module["__indirect_function_table"] = makeInvalidEarlyAccess("__indirect_function_table");

var wasmTable = Module["wasmTable"] = makeInvalidEarlyAccess("wasmTable");

function assignWasmExports(wasmExports) {
  assert(typeof wasmExports["pthread_self"] != "undefined", "missing Wasm export: pthread_self");
  assert(typeof wasmExports["malloc"] != "undefined", "missing Wasm export: malloc");
  assert(typeof wasmExports["free"] != "undefined", "missing Wasm export: free");
  assert(typeof wasmExports["virtual_get_request"] != "undefined", "missing Wasm export: virtual_get_request");
  assert(typeof wasmExports["virtual_post_request"] != "undefined", "missing Wasm export: virtual_post_request");
  assert(typeof wasmExports["stream_control"] != "undefined", "missing Wasm export: stream_control");
  assert(typeof wasmExports["__main_argc_argv"] != "undefined", "missing Wasm export: __main_argc_argv");
  assert(typeof wasmExports["fflush"] != "undefined", "missing Wasm export: fflush");
  assert(typeof wasmExports["_emscripten_tls_init"] != "undefined", "missing Wasm export: _emscripten_tls_init");
  assert(typeof wasmExports["_emscripten_proxy_main"] != "undefined", "missing Wasm export: _emscripten_proxy_main");
  assert(typeof wasmExports["emscripten_stack_get_base"] != "undefined", "missing Wasm export: emscripten_stack_get_base");
  assert(typeof wasmExports["emscripten_stack_get_end"] != "undefined", "missing Wasm export: emscripten_stack_get_end");
  assert(typeof wasmExports["_emscripten_thread_init"] != "undefined", "missing Wasm export: _emscripten_thread_init");
  assert(typeof wasmExports["__set_thread_state"] != "undefined", "missing Wasm export: __set_thread_state");
  assert(typeof wasmExports["_emscripten_thread_crashed"] != "undefined", "missing Wasm export: _emscripten_thread_crashed");
  assert(typeof wasmExports["emscripten_proxy_execute_queue"] != "undefined", "missing Wasm export: emscripten_proxy_execute_queue");
  assert(typeof wasmExports["emscripten_proxy_finish"] != "undefined", "missing Wasm export: emscripten_proxy_finish");
  assert(typeof wasmExports["_emscripten_run_js_on_main_thread_done"] != "undefined", "missing Wasm export: _emscripten_run_js_on_main_thread_done");
  assert(typeof wasmExports["_emscripten_run_js_on_main_thread"] != "undefined", "missing Wasm export: _emscripten_run_js_on_main_thread");
  assert(typeof wasmExports["_emscripten_thread_free_data"] != "undefined", "missing Wasm export: _emscripten_thread_free_data");
  assert(typeof wasmExports["_emscripten_thread_exit"] != "undefined", "missing Wasm export: _emscripten_thread_exit");
  assert(typeof wasmExports["_emscripten_check_mailbox"] != "undefined", "missing Wasm export: _emscripten_check_mailbox");
  assert(typeof wasmExports["setThrew"] != "undefined", "missing Wasm export: setThrew");
  assert(typeof wasmExports["_emscripten_tempret_set"] != "undefined", "missing Wasm export: _emscripten_tempret_set");
  assert(typeof wasmExports["emscripten_stack_init"] != "undefined", "missing Wasm export: emscripten_stack_init");
  assert(typeof wasmExports["emscripten_stack_set_limits"] != "undefined", "missing Wasm export: emscripten_stack_set_limits");
  assert(typeof wasmExports["emscripten_stack_get_free"] != "undefined", "missing Wasm export: emscripten_stack_get_free");
  assert(typeof wasmExports["_emscripten_stack_restore"] != "undefined", "missing Wasm export: _emscripten_stack_restore");
  assert(typeof wasmExports["_emscripten_stack_alloc"] != "undefined", "missing Wasm export: _emscripten_stack_alloc");
  assert(typeof wasmExports["emscripten_stack_get_current"] != "undefined", "missing Wasm export: emscripten_stack_get_current");
  assert(typeof wasmExports["__cxa_decrement_exception_refcount"] != "undefined", "missing Wasm export: __cxa_decrement_exception_refcount");
  assert(typeof wasmExports["__cxa_increment_exception_refcount"] != "undefined", "missing Wasm export: __cxa_increment_exception_refcount");
  assert(typeof wasmExports["__get_exception_message"] != "undefined", "missing Wasm export: __get_exception_message");
  assert(typeof wasmExports["__cxa_can_catch"] != "undefined", "missing Wasm export: __cxa_can_catch");
  assert(typeof wasmExports["__cxa_get_exception_ptr"] != "undefined", "missing Wasm export: __cxa_get_exception_ptr");
  assert(typeof wasmExports["_wasmfs_opfs_record_entry"] != "undefined", "missing Wasm export: _wasmfs_opfs_record_entry");
  assert(typeof wasmExports["wasmfs_flush"] != "undefined", "missing Wasm export: wasmfs_flush");
  assert(typeof wasmExports["__indirect_function_table"] != "undefined", "missing Wasm export: __indirect_function_table");
  _pthread_self = Module["_pthread_self"] = wasmExports["pthread_self"];
  _malloc = Module["_malloc"] = createExportWrapper("malloc", 1);
  _free = Module["_free"] = createExportWrapper("free", 1);
  _virtual_get_request = Module["_virtual_get_request"] = createExportWrapper("virtual_get_request", 2);
  _virtual_post_request = Module["_virtual_post_request"] = createExportWrapper("virtual_post_request", 3);
  _stream_control = Module["_stream_control"] = createExportWrapper("stream_control", 1);
  _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
  _fflush = Module["_fflush"] = createExportWrapper("fflush", 1);
  __emscripten_tls_init = Module["__emscripten_tls_init"] = createExportWrapper("_emscripten_tls_init", 0);
  __emscripten_proxy_main = Module["__emscripten_proxy_main"] = createExportWrapper("_emscripten_proxy_main", 2);
  _emscripten_stack_get_base = Module["_emscripten_stack_get_base"] = wasmExports["emscripten_stack_get_base"];
  _emscripten_stack_get_end = Module["_emscripten_stack_get_end"] = wasmExports["emscripten_stack_get_end"];
  __emscripten_thread_init = Module["__emscripten_thread_init"] = createExportWrapper("_emscripten_thread_init", 6);
  ___set_thread_state = Module["___set_thread_state"] = createExportWrapper("__set_thread_state", 4);
  __emscripten_thread_crashed = Module["__emscripten_thread_crashed"] = createExportWrapper("_emscripten_thread_crashed", 0);
  _emscripten_proxy_execute_queue = Module["_emscripten_proxy_execute_queue"] = createExportWrapper("emscripten_proxy_execute_queue", 1);
  _emscripten_proxy_finish = Module["_emscripten_proxy_finish"] = createExportWrapper("emscripten_proxy_finish", 1);
  __emscripten_run_js_on_main_thread_done = Module["__emscripten_run_js_on_main_thread_done"] = createExportWrapper("_emscripten_run_js_on_main_thread_done", 3);
  __emscripten_run_js_on_main_thread = Module["__emscripten_run_js_on_main_thread"] = createExportWrapper("_emscripten_run_js_on_main_thread", 5);
  __emscripten_thread_free_data = Module["__emscripten_thread_free_data"] = createExportWrapper("_emscripten_thread_free_data", 1);
  __emscripten_thread_exit = Module["__emscripten_thread_exit"] = createExportWrapper("_emscripten_thread_exit", 1);
  __emscripten_check_mailbox = Module["__emscripten_check_mailbox"] = createExportWrapper("_emscripten_check_mailbox", 0);
  _setThrew = Module["_setThrew"] = createExportWrapper("setThrew", 2);
  __emscripten_tempret_set = Module["__emscripten_tempret_set"] = createExportWrapper("_emscripten_tempret_set", 1);
  _emscripten_stack_init = Module["_emscripten_stack_init"] = wasmExports["emscripten_stack_init"];
  _emscripten_stack_set_limits = Module["_emscripten_stack_set_limits"] = wasmExports["emscripten_stack_set_limits"];
  _emscripten_stack_get_free = Module["_emscripten_stack_get_free"] = wasmExports["emscripten_stack_get_free"];
  __emscripten_stack_restore = Module["__emscripten_stack_restore"] = wasmExports["_emscripten_stack_restore"];
  __emscripten_stack_alloc = Module["__emscripten_stack_alloc"] = wasmExports["_emscripten_stack_alloc"];
  _emscripten_stack_get_current = Module["_emscripten_stack_get_current"] = wasmExports["emscripten_stack_get_current"];
  ___cxa_decrement_exception_refcount = Module["___cxa_decrement_exception_refcount"] = createExportWrapper("__cxa_decrement_exception_refcount", 1);
  ___cxa_increment_exception_refcount = Module["___cxa_increment_exception_refcount"] = createExportWrapper("__cxa_increment_exception_refcount", 1);
  ___get_exception_message = Module["___get_exception_message"] = createExportWrapper("__get_exception_message", 3);
  ___cxa_can_catch = Module["___cxa_can_catch"] = createExportWrapper("__cxa_can_catch", 3);
  ___cxa_get_exception_ptr = Module["___cxa_get_exception_ptr"] = createExportWrapper("__cxa_get_exception_ptr", 1);
  __wasmfs_opfs_record_entry = Module["__wasmfs_opfs_record_entry"] = createExportWrapper("_wasmfs_opfs_record_entry", 3);
  _wasmfs_flush = Module["_wasmfs_flush"] = createExportWrapper("wasmfs_flush", 0);
  __indirect_function_table = Module["__indirect_function_table"] = wasmTable = wasmExports["__indirect_function_table"];
}

var wasmImports;

function assignWasmImports() {
  wasmImports = {
    /** @export */ __assert_fail: ___assert_fail,
    /** @export */ __call_sighandler: ___call_sighandler,
    /** @export */ __cxa_begin_catch: ___cxa_begin_catch,
    /** @export */ __cxa_end_catch: ___cxa_end_catch,
    /** @export */ __cxa_find_matching_catch_2: ___cxa_find_matching_catch_2,
    /** @export */ __cxa_find_matching_catch_3: ___cxa_find_matching_catch_3,
    /** @export */ __cxa_find_matching_catch_4: ___cxa_find_matching_catch_4,
    /** @export */ __cxa_rethrow: ___cxa_rethrow,
    /** @export */ __cxa_throw: ___cxa_throw,
    /** @export */ __cxa_uncaught_exceptions: ___cxa_uncaught_exceptions,
    /** @export */ __pthread_create_js: ___pthread_create_js,
    /** @export */ __resumeException: ___resumeException,
    /** @export */ _abort_js: __abort_js,
    /** @export */ _emscripten_init_main_thread_js: __emscripten_init_main_thread_js,
    /** @export */ _emscripten_notify_mailbox_postmessage: __emscripten_notify_mailbox_postmessage,
    /** @export */ _emscripten_receive_on_main_thread_js: __emscripten_receive_on_main_thread_js,
    /** @export */ _emscripten_runtime_keepalive_clear: __emscripten_runtime_keepalive_clear,
    /** @export */ _emscripten_thread_cleanup: __emscripten_thread_cleanup,
    /** @export */ _emscripten_thread_mailbox_await: __emscripten_thread_mailbox_await,
    /** @export */ _emscripten_thread_set_strongref: __emscripten_thread_set_strongref,
    /** @export */ _gmtime_js: __gmtime_js,
    /** @export */ _localtime_js: __localtime_js,
    /** @export */ _tzset_js: __tzset_js,
    /** @export */ _wasmfs_copy_preloaded_file_data: __wasmfs_copy_preloaded_file_data,
    /** @export */ _wasmfs_get_num_preloaded_dirs: __wasmfs_get_num_preloaded_dirs,
    /** @export */ _wasmfs_get_num_preloaded_files: __wasmfs_get_num_preloaded_files,
    /** @export */ _wasmfs_get_preloaded_child_path: __wasmfs_get_preloaded_child_path,
    /** @export */ _wasmfs_get_preloaded_file_mode: __wasmfs_get_preloaded_file_mode,
    /** @export */ _wasmfs_get_preloaded_file_size: __wasmfs_get_preloaded_file_size,
    /** @export */ _wasmfs_get_preloaded_parent_path: __wasmfs_get_preloaded_parent_path,
    /** @export */ _wasmfs_get_preloaded_path_name: __wasmfs_get_preloaded_path_name,
    /** @export */ _wasmfs_opfs_close_access: __wasmfs_opfs_close_access,
    /** @export */ _wasmfs_opfs_close_blob: __wasmfs_opfs_close_blob,
    /** @export */ _wasmfs_opfs_flush_access: __wasmfs_opfs_flush_access,
    /** @export */ _wasmfs_opfs_free_directory: __wasmfs_opfs_free_directory,
    /** @export */ _wasmfs_opfs_free_file: __wasmfs_opfs_free_file,
    /** @export */ _wasmfs_opfs_get_child: __wasmfs_opfs_get_child,
    /** @export */ _wasmfs_opfs_get_entries: __wasmfs_opfs_get_entries,
    /** @export */ _wasmfs_opfs_get_size_access: __wasmfs_opfs_get_size_access,
    /** @export */ _wasmfs_opfs_get_size_blob: __wasmfs_opfs_get_size_blob,
    /** @export */ _wasmfs_opfs_get_size_file: __wasmfs_opfs_get_size_file,
    /** @export */ _wasmfs_opfs_init_root_directory: __wasmfs_opfs_init_root_directory,
    /** @export */ _wasmfs_opfs_insert_directory: __wasmfs_opfs_insert_directory,
    /** @export */ _wasmfs_opfs_insert_file: __wasmfs_opfs_insert_file,
    /** @export */ _wasmfs_opfs_move_file: __wasmfs_opfs_move_file,
    /** @export */ _wasmfs_opfs_open_access: __wasmfs_opfs_open_access,
    /** @export */ _wasmfs_opfs_open_blob: __wasmfs_opfs_open_blob,
    /** @export */ _wasmfs_opfs_read_access: __wasmfs_opfs_read_access,
    /** @export */ _wasmfs_opfs_read_blob: __wasmfs_opfs_read_blob,
    /** @export */ _wasmfs_opfs_remove_child: __wasmfs_opfs_remove_child,
    /** @export */ _wasmfs_opfs_set_size_access: __wasmfs_opfs_set_size_access,
    /** @export */ _wasmfs_opfs_set_size_file: __wasmfs_opfs_set_size_file,
    /** @export */ _wasmfs_opfs_write_access: __wasmfs_opfs_write_access,
    /** @export */ _wasmfs_stdin_get_char: __wasmfs_stdin_get_char,
    /** @export */ _wasmfs_thread_utils_heartbeat: __wasmfs_thread_utils_heartbeat,
    /** @export */ clock_time_get: _clock_time_get,
    /** @export */ emscripten_check_blocking_allowed: _emscripten_check_blocking_allowed,
    /** @export */ emscripten_date_now: _emscripten_date_now,
    /** @export */ emscripten_err: _emscripten_err,
    /** @export */ emscripten_exit_with_live_runtime: _emscripten_exit_with_live_runtime,
    /** @export */ emscripten_get_heap_max: _emscripten_get_heap_max,
    /** @export */ emscripten_get_now: _emscripten_get_now,
    /** @export */ emscripten_has_asyncify: _emscripten_has_asyncify,
    /** @export */ emscripten_num_logical_cores: _emscripten_num_logical_cores,
    /** @export */ emscripten_out: _emscripten_out,
    /** @export */ emscripten_resize_heap: _emscripten_resize_heap,
    /** @export */ emscripten_runtime_keepalive_check: _emscripten_runtime_keepalive_check,
    /** @export */ emscripten_unwind_to_js_event_loop: _emscripten_unwind_to_js_event_loop,
    /** @export */ emscripten_websocket_close: _emscripten_websocket_close,
    /** @export */ emscripten_websocket_delete: _emscripten_websocket_delete,
    /** @export */ emscripten_websocket_new: _emscripten_websocket_new,
    /** @export */ emscripten_websocket_send_binary: _emscripten_websocket_send_binary,
    /** @export */ emscripten_websocket_set_onclose_callback_on_thread: _emscripten_websocket_set_onclose_callback_on_thread,
    /** @export */ emscripten_websocket_set_onerror_callback_on_thread: _emscripten_websocket_set_onerror_callback_on_thread,
    /** @export */ emscripten_websocket_set_onmessage_callback_on_thread: _emscripten_websocket_set_onmessage_callback_on_thread,
    /** @export */ emscripten_websocket_set_onopen_callback_on_thread: _emscripten_websocket_set_onopen_callback_on_thread,
    /** @export */ environ_get: _environ_get,
    /** @export */ environ_sizes_get: _environ_sizes_get,
    /** @export */ exit: _exit,
    /** @export */ invoke_dii,
    /** @export */ invoke_diii,
    /** @export */ invoke_fiii,
    /** @export */ invoke_i,
    /** @export */ invoke_ii,
    /** @export */ invoke_iid,
    /** @export */ invoke_iii,
    /** @export */ invoke_iiii,
    /** @export */ invoke_iiiii,
    /** @export */ invoke_iiiiid,
    /** @export */ invoke_iiiiii,
    /** @export */ invoke_iiiiiii,
    /** @export */ invoke_iiiiiiii,
    /** @export */ invoke_iiiiiiiiiii,
    /** @export */ invoke_iiiiiiiiiiii,
    /** @export */ invoke_iiiiiiiiiiiii,
    /** @export */ invoke_iiiiij,
    /** @export */ invoke_iiij,
    /** @export */ invoke_iiijiii,
    /** @export */ invoke_iiijj,
    /** @export */ invoke_iij,
    /** @export */ invoke_iiji,
    /** @export */ invoke_iijiiii,
    /** @export */ invoke_ji,
    /** @export */ invoke_jii,
    /** @export */ invoke_jiii,
    /** @export */ invoke_jiiii,
    /** @export */ invoke_jiiiiiii,
    /** @export */ invoke_jiiiiiiiii,
    /** @export */ invoke_jijj,
    /** @export */ invoke_jjjjj,
    /** @export */ invoke_v,
    /** @export */ invoke_vi,
    /** @export */ invoke_vii,
    /** @export */ invoke_viid,
    /** @export */ invoke_viidiiii,
    /** @export */ invoke_viifiiii,
    /** @export */ invoke_viii,
    /** @export */ invoke_viiidi,
    /** @export */ invoke_viiifi,
    /** @export */ invoke_viiii,
    /** @export */ invoke_viiiii,
    /** @export */ invoke_viiiiii,
    /** @export */ invoke_viiiiiii,
    /** @export */ invoke_viiiiiiii,
    /** @export */ invoke_viiiiiiiiii,
    /** @export */ invoke_viiiiiiiiiiiiiii,
    /** @export */ invoke_viiiij,
    /** @export */ invoke_viiij,
    /** @export */ invoke_viiiji,
    /** @export */ invoke_viiijji,
    /** @export */ invoke_viij,
    /** @export */ invoke_viiji,
    /** @export */ invoke_viijii,
    /** @export */ invoke_viijj,
    /** @export */ invoke_viijji,
    /** @export */ invoke_viijjiiii,
    /** @export */ invoke_viijjj,
    /** @export */ invoke_vij,
    /** @export */ invoke_viji,
    /** @export */ invoke_vijii,
    /** @export */ invoke_vijiii,
    /** @export */ invoke_vijj,
    /** @export */ invoke_vji,
    /** @export */ llvm_eh_typeid_for: _llvm_eh_typeid_for,
    /** @export */ memory: wasmMemory,
    /** @export */ onAPIResult: _onAPIResult,
    /** @export */ onChain: _onChain,
    /** @export */ onConnect: _onConnect,
    /** @export */ onDisconnect: _onDisconnect,
    /** @export */ onMempoolAdd: _onMempoolAdd,
    /** @export */ onMempoolErase: _onMempoolErase,
    /** @export */ onStream: _onStream,
    /** @export */ proc_exit: _proc_exit,
    /** @export */ random_get: _random_get,
    /** @export */ rtcCreateDataChannel: _rtcCreateDataChannel,
    /** @export */ rtcCreatePeerConnection: _rtcCreatePeerConnection,
    /** @export */ rtcDeleteDataChannel: _rtcDeleteDataChannel,
    /** @export */ rtcDeletePeerConnection: _rtcDeletePeerConnection,
    /** @export */ rtcGetBufferedAmount: _rtcGetBufferedAmount,
    /** @export */ rtcGetDataChannelLabel: _rtcGetDataChannelLabel,
    /** @export */ rtcGetLocalDescription: _rtcGetLocalDescription,
    /** @export */ rtcGetLocalDescriptionType: _rtcGetLocalDescriptionType,
    /** @export */ rtcSendMessage: _rtcSendMessage,
    /** @export */ rtcSetBufferedAmountLowCallback: _rtcSetBufferedAmountLowCallback,
    /** @export */ rtcSetBufferedAmountLowThreshold: _rtcSetBufferedAmountLowThreshold,
    /** @export */ rtcSetDataChannelCallback: _rtcSetDataChannelCallback,
    /** @export */ rtcSetErrorCallback: _rtcSetErrorCallback,
    /** @export */ rtcSetGatheringStateChangeCallback: _rtcSetGatheringStateChangeCallback,
    /** @export */ rtcSetIceStateChangeCallback: _rtcSetIceStateChangeCallback,
    /** @export */ rtcSetLocalCandidateCallback: _rtcSetLocalCandidateCallback,
    /** @export */ rtcSetLocalDescriptionCallback: _rtcSetLocalDescriptionCallback,
    /** @export */ rtcSetMessageCallback: _rtcSetMessageCallback,
    /** @export */ rtcSetOpenCallback: _rtcSetOpenCallback,
    /** @export */ rtcSetRemoteDescription: _rtcSetRemoteDescription,
    /** @export */ rtcSetSignalingStateChangeCallback: _rtcSetSignalingStateChangeCallback,
    /** @export */ rtcSetStateChangeCallback: _rtcSetStateChangeCallback,
    /** @export */ rtcSetUserPointer: _rtcSetUserPointer
  };
}

function invoke_vii(index, a1, a2) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_ii(index, a1) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_v(index) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)();
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vi(index, a1) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_dii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_i(index) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)();
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vij(index, a1, a2) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viifiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viidiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viijjiiii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viji(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viij(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_ji(index, a1) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_jii(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_viiji(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiij(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jiiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_jiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_viid(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vijiii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vijii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viijii(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiij(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiji(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viijj(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_viiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iij(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiij(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viijji(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jijj(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_vijj(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viijjj(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiji(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jjjjj(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_iiijj(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iijiiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iid(index, a1, a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiijiii(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiijji(index, a1, a2, a3, a4, a5, a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vji(index, a1, a2) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiifi(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiidi(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiij(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiid(index, a1, a2, a3, a4, a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jiiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_iiiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_fiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_diii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiiiiiiiiiii(index, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15);
  } catch (e) {
    stackRestore(sp);
    if (!(e instanceof EmscriptenEH)) throw e;
    _setThrew(1, 0);
  }
}

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
var calledRun;

function callMain(args = []) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(typeof onPreRuns === "undefined" || onPreRuns.length == 0, "cannot call main when preRun functions remain to be called");
  var entryFunction = __emscripten_proxy_main;
  // With PROXY_TO_PTHREAD make sure we keep the runtime alive until the
  // proxied main calls exit (see exitOnMainThread() for where Pop is called).
  runtimeKeepalivePush();
  args.unshift(thisProgram);
  var argc = args.length;
  var argv = stackAlloc((argc + 1) * 4);
  var argv_ptr = argv;
  for (var arg of args) {
    (growMemViews(), HEAPU32)[((argv_ptr) >> 2)] = stringToUTF8OnStack(arg);
    argv_ptr += 4;
  }
  (growMemViews(), HEAPU32)[((argv_ptr) >> 2)] = 0;
  try {
    var ret = entryFunction(argc, argv);
    // if we're not running an evented main loop, it's time to exit
    exitJS(ret, /* implicit = */ true);
    return ret;
  } catch (e) {
    return handleException(e);
  }
}

function stackCheckInit() {
  // This is normally called automatically during __wasm_call_ctors but need to
  // get these values before even running any of the ctors so we call it redundantly
  // here.
  // See $establishStackSpace for the equivalent code that runs on a thread
  assert(!ENVIRONMENT_IS_PTHREAD);
  _emscripten_stack_init();
  // TODO(sbc): Move writeStackCookie to native to to avoid this.
  writeStackCookie();
}

function run(args = arguments_) {
  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }
  if ((ENVIRONMENT_IS_PTHREAD)) {
    readyPromiseResolve?.(Module);
    initRuntime();
    return;
  }
  stackCheckInit();
  preRun();
  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }
  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    assert(!calledRun);
    calledRun = true;
    Module["calledRun"] = true;
    if (ABORT) return;
    initRuntime();
    preMain();
    readyPromiseResolve?.(Module);
    Module["onRuntimeInitialized"]?.();
    consumedModuleProp("onRuntimeInitialized");
    var noInitialRun = Module["noInitialRun"] || false;
    if (!noInitialRun) callMain(args);
    postRun();
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(() => {
      setTimeout(() => Module["setStatus"](""), 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
  checkStackCookie();
}

function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var oldOut = out;
  var oldErr = err;
  var has = false;
  out = err = x => {
    has = true;
  };
  try {
    // it doesn't matter if it fails
    // In WasmFS we must also flush the WasmFS internal buffers, for this check
    // to work.
    _wasmfs_flush();
  } catch (e) {}
  out = oldOut;
  err = oldErr;
  if (has) {
    warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
    warnOnce("(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)");
  }
}

var wasmExports;

if ((!(ENVIRONMENT_IS_PTHREAD))) {
  // Call createWasm on startup if we are the main thread.
  // Worker threads call this once they receive the module via postMessage
  // In modularize mode the generated code is within a factory function so we
  // can use await here (since it's not top-level-await).
  wasmExports = await (createWasm());
  run();
}

// end include: postamble.js
// include: postamble_modularize.js
// In MODULARIZE mode we wrap the generated code in a factory function
// and return either the Module itself, or a promise of the module.
// We assign to the `moduleRtn` global here and configure closure to see
// this as an extern so it won't get minified.
if (runtimeInitialized) {
  moduleRtn = Module;
} else {
  // Set up the promise that indicates the Module is initialized
  moduleRtn = new Promise((resolve, reject) => {
    readyPromiseResolve = resolve;
    readyPromiseReject = reject;
  });
}

// Assertion for attempting to access module properties on the incoming
// moduleArg.  In the past we used this object as the prototype of the module
// and assigned properties to it, but now we return a distinct object.  This
// keeps the instance private until it is ready (i.e the promise has been
// resolved).
for (const prop of Object.keys(Module)) {
  if (!(prop in moduleArg)) {
    Object.defineProperty(moduleArg, prop, {
      configurable: true,
      get() {
        abort(`Access to module property ('${prop}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
      }
    });
  }
}


  return moduleRtn;
}

// Export using a UMD style export, or ES6 exports if selected
export default Module;

// Create code for detecting if we are running in a pthread.
// Normally this detection is done when the module is itself run but
// when running in MODULARIZE mode we need use this to know if we should
// run the module constructor on startup (true only for pthreads).
var isPthread = globalThis.name?.startsWith('em-pthread');

isPthread && Module();

