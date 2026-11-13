import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PKEXEC, UFW, canPrompt, changeFirewall, createLanState, firewallStatus, runUfw, ufwArgs, ufwCommandText, ufwRulesFor, validUfwRule } from "../jellyfin-lan.mjs";
import { firewallView } from "../public/jellyfin-lan.js";

const wifi = { name: "wlp4s0", address: "192.168.1.223", subnet: "192.168.1.0/24" };
const rule = { iface: "wlp4s0", subnet: "192.168.1.0/24", port: 8096 };

test("firewall rules are validated strictly", () => {
  assert.ok(validUfwRule(rule));
  assert.ok(validUfwRule({ iface: "enp3s0", subnet: "10.0.0.0/8", port: 8096 }));
  for (const bad of [
    { ...rule, iface: "wlp4s0; rm -rf /" },
    { ...rule, iface: "-wlp" },
    { ...rule, iface: "docker0" },
    { ...rule, iface: "tailscale0" },
    { ...rule, iface: "averyveryverylongname" },
    { ...rule, subnet: "192.168.1.223/24" },
    { ...rule, subnet: "0.0.0.0/0" },
    { ...rule, subnet: "8.8.8.0/24" },
    { ...rule, subnet: "192.168.1.0/4" },
    { ...rule, subnet: "192.168.1.0/24 any" },
    { ...rule, port: "8096" },
    { ...rule, port: 0 },
    null,
  ]) assert.equal(validUfwRule(bad), false, JSON.stringify(bad));
  assert.deepEqual(ufwRulesFor([wifi, { name: "docker0", address: "172.17.0.1", subnet: "172.17.0.0/16" }, { name: "eth0", address: "10.0.0.2", subnet: "" }]), [rule]);
});

test("ufw argv is fixed; delete matches the allow", () => {
  assert.deepEqual(ufwArgs(rule), ["allow", "in", "on", "wlp4s0", "from", "192.168.1.0/24", "to", "any", "port", "8096", "proto", "tcp", "comment", "Jellyfin on home network (Hog)"]);
  assert.deepEqual(ufwArgs(rule, true), ["delete", "allow", "in", "on", "wlp4s0", "from", "192.168.1.0/24", "to", "any", "port", "8096", "proto", "tcp"]);
  assert.equal(ufwCommandText(rule), "sudo ufw allow in on wlp4s0 from 192.168.1.0/24 to any port 8096 proto tcp comment 'Jellyfin on home network (Hog)'");
  assert.equal(ufwCommandText(rule, true), "sudo ufw delete allow in on wlp4s0 from 192.168.1.0/24 to any port 8096 proto tcp");
  assert.throws(() => ufwArgs({ ...rule, iface: "a b" }));
});

function fakeExec(result) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(result.error || null, result.stdout || "", result.stderr || ""));
  };
  return { calls, execFile };
}

test("runUfw goes through pkexec with no shell and reads the outcome", async () => {
  const ok = fakeExec({ stdout: "Rule added\n" });
  const added = await runUfw(rule, { execFile: ok.execFile });
  assert.equal(added.ok, true);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].file, PKEXEC);
  assert.deepEqual(ok.calls[0].args, [UFW, ...ufwArgs(rule)]);
  assert.ok(!ok.calls[0].opts.shell, "never a shell");

  for (const code of [126, 127]) {
    const r = await runUfw(rule, { execFile: fakeExec({ error: Object.assign(new Error("x"), { code }) }).execFile });
    assert.equal(r.ok, false);
    assert.equal(r.cancelled, true);
    assert.match(r.error, /cancelled or not authorised/);
  }
  const timeout = await runUfw(rule, { execFile: fakeExec({ error: Object.assign(new Error("x"), { killed: true, code: null }) }).execFile });
  assert.match(timeout.error, /timed out/);
  const missing = await runUfw(rule, { execFile: fakeExec({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }).execFile });
  assert.match(missing.error, /pkexec is not available/);
  const failed = await runUfw(rule, { execFile: fakeExec({ error: Object.assign(new Error("x"), { code: 1 }), stderr: "ERROR: Bad port\n" }).execFile });
  assert.equal(failed.cancelled, false);
  assert.match(failed.error, /Bad port/);
  const bad = fakeExec({});
  const refused = await runUfw({ ...rule, iface: "x;y" }, { execFile: bad.execFile });
  assert.equal(refused.ok, false);
  assert.equal(bad.calls.length, 0, "invalid rules never reach pkexec");
});

test("canPrompt needs pkexec and ufw", () => {
  assert.equal(canPrompt({ exists: () => true }), true);
  assert.equal(canPrompt({ exists: (p) => p !== PKEXEC }), false);
  assert.equal(canPrompt({ exists: (p) => p !== UFW }), false);
});

test("allow records the rule, remove drops it, cancel changes nothing", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "hog-fw-")), "jellyfin-lan.json");
  const state = createLanState({ file });
  state.setEnabled(true);
  const seen = [];
  const run = async (r, { remove }) => { seen.push({ r, remove }); return { ok: true }; };
  const cancel = async () => ({ ok: false, cancelled: true, error: "cancelled" });

  assert.equal((await changeFirewall(state, { addresses: [wifi], run: cancel })).cancelled, true);
  assert.deepEqual(state.rules, []);
  const on = await changeFirewall(state, { addresses: [wifi], run });
  assert.equal(on.ok, true);
  assert.deepEqual(state.rules, [rule]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: true, rules: [rule] });
  assert.equal(createLanState({ file }).rules.length, 1, "remembered across restarts");
  state.setEnabled(false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rules, [rule], "turning access off never removes the rule");
  // Hog moved to another network, but still offers to remove what it added.
  const off = await changeFirewall(state, { remove: true, addresses: [], run });
  assert.equal(off.ok, true);
  assert.deepEqual(seen.at(-1), { r: rule, remove: true });
  assert.deepEqual(state.rules, []);
  assert.equal((await changeFirewall(state, { remove: true, addresses: [], run })).ok, false);
  assert.equal((await changeFirewall(state, { addresses: [], run })).ok, false);
});

test("card: allow button, manual fallback, and remove only when off", () => {
  const state = (enabled, rules = []) => ({ enabled, rules });
  const status = (st, opts) => firewallStatus(st, [wifi], 8096, opts);
  const needed = status(state(true), { firewall: () => true, prompt: () => true });
  assert.equal(needed.needed, true);
  let view = firewallView({ enabled: true, ufw: needed });
  assert.equal(view.allow, true);
  assert.equal(view.remove, false);
  assert.match(view.commands[0], /^sudo ufw allow in on wlp4s0/, "manual command still offered");
  view = firewallView({ enabled: true, ufw: status(state(true), { firewall: () => true, prompt: () => false }) });
  assert.equal(view.allow, false, "no pkexec: no button");
  assert.equal(view.manualOpen, true);
  assert.equal(view.commands.length, 1);
  view = firewallView({ enabled: true, ufw: status(state(true, [rule]), { firewall: () => true, prompt: () => true }) });
  assert.equal(view.allow, false);
  assert.match(view.text, /added by Hog/);
  view = firewallView({ enabled: false, ufw: status(state(false, [rule]), { firewall: () => true, prompt: () => true }) });
  assert.equal(view.remove, true);
  assert.match(view.commands[0], /^sudo ufw delete allow/);
  view = firewallView({ enabled: false, ufw: status(state(false), { firewall: () => true, prompt: () => true }) });
  assert.equal(view.show, false);
  view = firewallView({ enabled: true, ufw: status(state(true), { firewall: () => false, prompt: () => true }) });
  assert.equal(view.show, false, "ufw off: nothing to do");
});
