import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyMinerProc, createLocalMiner, minerScriptProblem } from "../miner-local.mjs";

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), "hog-miner-")));
}

test("classify only the warthog miner on this stratum port", () => {
  const script = "/home/whitefang/Downloads/bzminer_v100.02b6_linux/start_warthog.sh";
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456", "-w", "secret"], { script, port: 3456 }), "miner");
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456"], { script, port: 39991 }), "");
  assert.equal(classifyMinerProc(["bash", script], { script, port: 3456 }), "launcher");
  assert.equal(classifyMinerProc(["bzminer", "-a", "ergo", "-p", "stratum+tcp://127.0.0.1:3456"], { script, port: 3456 }), "");
});

test("rejects launchers outside home or with the wrong name", () => {
  const home = tempHome();
  assert.match(minerScriptProblem("", home), /no miner launcher/);
  assert.match(minerScriptProblem(join(home, "start.sh"), home), /only starts start_warthog/);
  const outside = tempHome();
  const ext = join(outside, "start_warthog.sh");
  writeFileSync(ext, "#!/bin/sh\nexit 0\n");
  chmodSync(ext, 0o755);
  mkdirSync(join(home, "link"));
  symlinkSync(ext, join(home, "link", "start_warthog.sh"));
  assert.match(minerScriptProblem(join(home, "link", "start_warthog.sh"), home), /home folder/);
  writeFileSync(join(home, "start_warthog.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(home, "start_warthog.sh"), 0o644);
  assert.match(minerScriptProblem(join(home, "start_warthog.sh"), home), /not executable/);
});

test("start and stop only the launcher hog spawned", async () => {
  const home = tempHome();
  const dir = join(home, "Downloads", "bzminer_v100.02b6_linux");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "start_warthog.sh");
  writeFileSync(script, "#!/bin/sh\nsleep 30\n");
  chmodSync(script, 0o755);
  const miner = createLocalMiner({ home, scriptPath: () => script, port: 39991, logFile: join(home, "miner.log"), settleMs: 500 });
  try {
    assert.equal(miner.status().state, "stopped");
    const started = await miner.start();
    assert.equal(started.ok, true);
    assert.equal(started.started, true);
    assert.equal(started.state, "running");
    assert.equal(JSON.stringify(started).includes("sleep"), false);
    const again = await miner.start();
    assert.equal(again.started, false);
    const stopped = await miner.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(miner.status().state, "stopped");
  } finally {
    await miner.stop();
  }
});

test("does not spawn or signal a miner started as another user", async () => {
  const home = tempHome();
  const script = join(home, "start_warthog.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  let spawns = 0;
  const foreign = [{ pid: 4242, ppid: 1, uid: 0, args: ["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456", "-w", "secretwallet"] }];
  const miner = createLocalMiner({
    home,
    scriptPath: () => script,
    port: 3456,
    uid: 1000,
    list: () => foreign,
    spawnImpl: () => { spawns += 1; throw new Error("should not spawn"); },
    logFile: join(home, "miner.log"),
    settleMs: 10,
  });
  const started = await miner.start();
  assert.equal(started.ok, true);
  assert.equal(started.started, false);
  assert.equal(started.state, "running");
  assert.equal(spawns, 0);
  assert.equal(JSON.stringify(started).includes("secretwallet"), false);
  const stopped = await miner.stop();
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /another user/);
});

test("the root helper starts and stops a miner owned by root, and the phone cannot name a program", async () => {
  const home = tempHome();
  const helper = join(home, "hog-miner-ctl");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, 0o755);
  const script = join(home, "start_warthog.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  const calls = [];
  let foreign = [{ pid: 4242, ppid: 1, uid: 0, args: ["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456", "-w", "secretwallet"] }];
  const fake = (code, onExit) => {
    const handlers = {};
    return {
      stderr: { on() {} },
      on(event, fn) {
        handlers[event] = fn;
        if (event === "exit") queueMicrotask(() => { onExit(); fn(code); });
      },
    };
  };
  const miner = createLocalMiner({
    home,
    scriptPath: () => script,
    port: 3456,
    uid: 1000,
    rootHelper: helper,
    list: () => foreign,
    spawnImpl: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[3] === "stop") return fake(0, () => { foreign = []; });
      return fake(0, () => {});
    },
    logFile: join(home, "miner.log"),
    settleMs: 10,
  });
  const stopped = await miner.stop();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.state, "stopped");
  const started = await miner.start();
  assert.equal(started.ok, false);
  assert.match(started.error, /stopped right away/);
  assert.deepEqual(calls, [
    ["sudo", ["-n", "--", helper, "stop"]],
    ["sudo", ["-n", "--", helper, "start"]],
  ]);
  assert.equal(JSON.stringify(calls).includes("secretwallet"), false);
  assert.equal(calls.some((call) => call[1].includes(script)), false);
});
