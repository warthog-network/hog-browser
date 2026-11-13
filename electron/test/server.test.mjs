import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HogServer } = require("../lib/server.js");

function exitingChild(stderrText) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  setImmediate(() => {
    child.stderr.write(stderrText);
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  return child;
}

test("launch error includes the server's last lines", async () => {
  const child = exitingChild(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws' imported from /opt/Hog (Chromium preview)/resources/hog-app/server.mjs\n",
  );
  const server = new HogServer({
    root: "/tmp/hog-app",
    execPath: "/opt/Hog (Chromium preview)/hog-chromium-preview",
    spawnImpl: (cmd, args, opts) => {
      assert.equal(cmd, "/opt/Hog (Chromium preview)/hog-chromium-preview");
      assert.deepEqual(args, ["server.mjs"]);
      assert.equal(opts.env.ELECTRON_RUN_AS_NODE, "1");
      return child;
    },
    log: () => {},
  });
  await assert.rejects(
    () => server.start(1, 43100),
    (err) => {
      assert.match(err.message, /stopped before the window opened/);
      assert.match(err.message, /ERR_MODULE_NOT_FOUND/);
      assert.match(err.message, /Cannot find package 'ws'/);
      return true;
    },
  );
});

test("launch error stays generic when the server printed nothing", async () => {
  const child = exitingChild("");
  const server = new HogServer({
    root: "/tmp/hog-app",
    execPath: "/opt/Hog (Chromium preview)/hog-chromium-preview",
    spawnImpl: () => child,
    log: () => {},
  });
  await assert.rejects(() => server.start(1, 43100), { message: "Hog's local server stopped before the window opened." });
});
