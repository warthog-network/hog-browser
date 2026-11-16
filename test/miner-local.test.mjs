import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addMinerLauncher, applyMinerLauncher, canonicalMinerPool, classifyMinerProc, createLocalMiner, launcherView, minerScriptProblem, removeMinerLauncher, rewriteMinerPool, selectMinerLauncher } from "../miner-local.mjs";

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), "hog-miner-")));
}

test("classify only the warthog miner on this stratum port", () => {
  const script = "/home/whitefang/Downloads/bzminer_v100.02b6_linux/start_warthog.sh";
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456", "-w", "secret"], { script, port: 3456 }), "miner");
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://127.0.0.1:3456"], { script, port: 39991 }), "");
  assert.equal(classifyMinerProc(["bash", script], { script, port: 3456 }), "launcher");
  assert.equal(classifyMinerProc(["bzminer", "-a", "ergo", "-p", "stratum+tcp://127.0.0.1:3456"], { script, port: 3456 }), "");
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://100.119.132.89:3456"], { script, port: 3456 }), "miner");
  assert.equal(classifyMinerProc(["./bzminer", "-a", "warthog", "-p", "stratum+tcp://pool.example.com:3456"], { script, port: 3456 }), "");
});

test("a rig pool is a tailnet address or this computer, and only the POOL line changes", () => {
  assert.equal(canonicalMinerPool("stratum+tcp://100.119.132.89:3456"), "stratum+tcp://100.119.132.89:3456");
  assert.equal(canonicalMinerPool("stratum+tcp://127.0.0.1:3456"), "stratum+tcp://127.0.0.1:3456");
  assert.equal(canonicalMinerPool("stratum+tcp://hog.tail314642.ts.net:3456"), "stratum+tcp://hog.tail314642.ts.net:3456");
  assert.equal(canonicalMinerPool("stratum+tcp://8.8.8.8:3456"), "");
  assert.equal(canonicalMinerPool("stratum+tcp://127.0.0.1:3456;touch /tmp/x"), "");
  const script = "POOL=\"stratum+tcp://127.0.0.1:3456\"\nWALLET=\"abcd\"\n# POOL=\"stratum+tcp://127.0.0.1:3456\"\n";
  const next = rewriteMinerPool(script, "stratum+tcp://100.72.197.80:3456");
  assert.equal(next.ok, true);
  assert.match(next.text, /^POOL="stratum\+tcp:\/\/100\.72\.197\.80:3456"$/m);
  assert.match(next.text, /WALLET="abcd"/);
  assert.match(next.text, /# POOL="stratum\+tcp:\/\/127\.0\.0\.1:3456"/);
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

test("start writes the node's stratum address into start_warthog.sh", async () => {
  const home = tempHome();
  const script = join(home, "start_warthog.sh");
  writeFileSync(script, "#!/bin/sh\nPOOL=\"stratum+tcp://127.0.0.1:3456\"\nWALLET=\"abcd\"\nsleep 30\n");
  chmodSync(script, 0o755);
  const miner = createLocalMiner({ home, scriptPath: () => script, port: 3456, logFile: join(home, "miner.log"), settleMs: 200 });
  try {
    const started = await miner.start({ pool: "stratum+tcp://100.119.132.89:3456" });
    assert.equal(started.ok, true);
    assert.match(readFileSync(script, "utf8"), /POOL="stratum\+tcp:\/\/100\.119\.132\.89:3456"/);
    assert.match(readFileSync(script, "utf8"), /WALLET="abcd"/);
    const again = await miner.start({ pool: "stratum+tcp://100.72.197.80:3456" });
    assert.equal(again.ok, false);
    assert.match(again.error, /Stop the miner/);
    assert.match(readFileSync(script, "utf8"), /100\.119\.132\.89:3456/);
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

function writeLauncher(home, dir) {
  const folder = join(home, dir);
  mkdirSync(folder, { recursive: true });
  const script = join(folder, "start_warthog.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  return script;
}

test("saved start files are picked by name and show their path", () => {
  const home = tempHome();
  const oc = writeLauncher(home, "mining/oc");
  const quiet = writeLauncher(home, "mining/quiet");
  const empty = launcherView(null, { home });
  assert.equal(empty.launchers[0].id, "default");
  assert.equal(empty.launchers[0].name, "Downloads");
  assert.equal(empty.launchers[0].active, true);
  assert.match(empty.launchers[0].path, /^~\/Downloads\/bzminer_v100\.02b6_linux\/start_warthog\.sh$/);
  assert.match(empty.launchers[0].problem, /could not find/);

  const added = addMinerLauncher(null, { name: "OC lock", script: `~/${oc.slice(home.length + 1)}`, home });
  assert.equal(added.ok, true);
  assert.equal(added.config.script, oc);
  assert.equal(added.config.launchers[0].name, "OC lock");
  const view = launcherView(added.config, { home });
  const picked = view.launchers.find((item) => item.name === "OC lock");
  assert.equal(picked.active, true);
  assert.equal(picked.path, `~/mining/oc/start_warthog.sh`);
  assert.equal(picked.problem, "");
  assert.equal(view.launchers.find((item) => item.id === "default").active, false);

  const again = addMinerLauncher(added.config, { name: "oc lock", script: quiet, home });
  assert.match(again.error, /already used/);
  const samePath = addMinerLauncher(added.config, { name: "Other", script: oc, home });
  assert.match(samePath.error, /already saved/);
  const outside = addMinerLauncher(added.config, { name: "Nope", script: "/tmp/start_warthog.sh", home });
  assert.match(outside.error, /home folder|could not find/);
  const wrong = addMinerLauncher(added.config, { name: "Nope", script: join(home, "start.sh"), home });
  assert.match(wrong.error, /only starts start_warthog/);

  const second = addMinerLauncher(added.config, { name: "Quiet", script: quiet, home });
  assert.equal(second.ok, true);
  assert.equal(second.config.script, quiet);
  const back = selectMinerLauncher(second.config, added.config.launchers[0].id, home);
  assert.equal(back.ok, true);
  assert.equal(back.config.script, oc);
  const removed = removeMinerLauncher(back.config, added.config.launchers[0].id, home);
  assert.equal(removed.ok, true);
  assert.equal(removed.config.script, "");
  assert.equal(removed.config.launchers.length, 1);
  assert.equal(launcherView(removed.config, { home }).launchers.find((item) => item.id === "default").active, true);
  assert.match(removeMinerLauncher(removed.config, "default", home).error, /stays in the list/);
  assert.match(applyMinerLauncher(removed.config, { op: "exec", script: "/tmp/evil.sh" }, home).error, /add, select, or remove/);
});

test("a lone miner.json script shows up by its folder name", () => {
  const home = tempHome();
  const script = writeLauncher(home, "bzminer_custom");
  const view = launcherView({ script }, { home });
  const row = view.launchers.find((item) => item.path.endsWith("/bzminer_custom/start_warthog.sh"));
  assert.equal(row.name, "bzminer_custom");
  assert.equal(row.active, true);
  assert.equal(row.problem, "");
  const pinned = launcherView(null, { home, pinnedScript: script });
  assert.equal(pinned.launcherPinned, true);
  assert.equal(pinned.launchers[0].id, "pinned");
  assert.equal(pinned.launchers[0].active, true);
  assert.match(pinned.launchers[0].path, /^~\/bzminer_custom\/start_warthog\.sh$/);
  assert.equal(pinned.launchers.find((item) => item.id === "default").active, false);
});

test("hog keeps six saved start files", () => {
  const home = tempHome();
  let config = { script: "", launchers: [] };
  for (let i = 0; i < 6; i += 1) {
    const script = writeLauncher(home, `rig-${i}`);
    const added = addMinerLauncher(config, { name: `Rig ${i}`, script, home });
    assert.equal(added.ok, true, added.error);
    config = added.config;
  }
  const extra = writeLauncher(home, "rig-extra");
  const refused = addMinerLauncher(config, { name: "Extra", script: extra, home });
  assert.match(refused.error, /6 start files/);
  assert.equal(launcherView(config, { home }).launchers.filter((item) => item.id !== "default").length, 6);
});
