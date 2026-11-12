// Smoke test for the built helper .exe (or any helper binary): start it with
// solo mining on, check the control page, the embedded node build and the
// stratum port, then quit it through the control API.
//   node helper/smoke-exe.mjs dist/Warthog-Mining-Helper.exe
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = resolve(process.argv[2] || join(root, "dist", "Warthog-Mining-Helper.exe"));
const ADDRESS = "56ed966df64571675f38be3b4219862dbbec8f0e69140de3";
const [PAGE, CONTROL, STRATUM] = [43280, 43281, 3476];
const tmp = mkdtempSync(join(tmpdir(), "helper-smoke-"));
const cfg = join(tmp, "config");
mkdirSync(cfg);
writeFileSync(join(cfg, "config.json"), JSON.stringify({ enabled: true, address: ADDRESS, network: "defi", tailnet: false }));
const env = { ...process.env, WARTHOG_HELPER_CONFIG_DIR: cfg, WARTHOG_HELPER_RUNTIME_DIR: join(tmp, "runtime") };

const help = execFileSync(exe, ["--help"], { env, encoding: "utf8", timeout: 30_000 });
if (!/warthog-mining-helper/.test(help)) throw new Error(`--help said: ${help}`);
console.log("ok --help");

const child = spawn(exe, ["--no-open", "--page-port", String(PAGE), "--control-port", String(CONTROL), "--stratum-port", String(STRATUM)], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (d) => { output += d; });
child.stderr.on("data", (d) => { output += d; });
const exited = new Promise((r) => child.on("exit", (code) => r(code)));
const fail = (msg) => { console.error(output); child.kill(); throw new Error(msg); };

let html = "";
for (let i = 0; i < 60 && !html; i++) {
  await new Promise((r) => setTimeout(r, 500));
  html = await fetch(`http://127.0.0.1:${CONTROL}/`).then((r) => (r.ok ? r.text() : ""), () => "");
}
if (!html.includes("<title>Warthog mining helper</title>")) fail("control page did not come up");
console.log("ok control page");
const token = /[0-9a-f]{48}/.exec(html)?.[0];
const headers = { "x-helper-token": token, "content-type": "application/json" };
const status = await (await fetch(`http://127.0.0.1:${CONTROL}/api/status`, { headers })).json();
if (!status.stratumListening) fail(`stratum not listening: ${JSON.stringify(status)}`);
const want = process.platform === "win32" ? /^bzminer\.exe -a warthog -p stratum\+tcp:\/\/127\.0\.0\.1:3476 / : /^\.\/bzminer /;
if (!want.test(status.command)) fail(`command: ${status.command}`);
console.log(`ok status: ${status.command}`);

for (const [path, dir] of [["/node/defi/wart-node.wasm", "node-defi"], ["/node/wart-node.wasm", "node-mainnet"]]) {
  const body = Buffer.from(await (await fetch(`http://127.0.0.1:${PAGE}${path}`)).arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  const sums = readFileSync(join(root, dir, "SHA256SUMS"), "utf8");
  if (!sums.includes(got)) fail(`${path} sha256 ${got} not in ${dir}/SHA256SUMS`);
  console.log(`ok ${path} ${body.length} bytes, sha256 matches ${dir}`);
}

const reply = await new Promise((res, rej) => {
  const sock = connect(STRATUM, "127.0.0.1", () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
  sock.setEncoding("utf8");
  sock.once("data", (d) => { res(JSON.parse(d.split("\n")[0])); sock.destroy(); });
  sock.on("error", rej);
  setTimeout(() => rej(new Error("stratum timeout")), 10_000);
});
if (reply.id !== 1) fail(`stratum reply ${JSON.stringify(reply)}`);
console.log(`ok stratum 127.0.0.1:${STRATUM} answered mining.subscribe`);

await fetch(`http://127.0.0.1:${CONTROL}/api/quit`, { method: "POST", headers, body: "{}" });
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
if (code !== 0) fail(`quit: exit ${code}`);
console.log("ok quit, exit 0");
