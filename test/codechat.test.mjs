import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("const CODE_CHAT_DEFAULT_MODEL");
const end = app.indexOf("function paintAiCode");
assert.ok(start > 0 && end > start, "Code chat helpers are in app.js");
const helpers = new Function(`${app.slice(start, end)}\nreturn { codeChatUrl, codeChatModelOptions, codeChatStartCommand };`)();

test("codeChatUrl only allows the loopback Code chat ports", () => {
  assert.equal(helpers.codeChatUrl("http://127.0.0.1:8501"), "http://127.0.0.1:8501/");
  assert.equal(helpers.codeChatUrl("http://127.0.0.1:8504/"), "http://127.0.0.1:8504/");
  assert.equal(helpers.codeChatUrl("http://127.0.0.1:3000"), "");
  assert.equal(helpers.codeChatUrl("https://127.0.0.1:8501"), "");
  assert.equal(helpers.codeChatUrl("http://localhost:8501"), "");
  assert.equal(helpers.codeChatUrl("http://hog.tail314642.ts.net:8501"), "");
  assert.equal(helpers.codeChatUrl("http://127.0.0.1:8501/other"), "");
  assert.equal(helpers.codeChatUrl("http://127.0.0.1:8501/?x=1"), "");
  assert.equal(helpers.codeChatUrl("http://user@127.0.0.1:8501/"), "");
  assert.equal(helpers.codeChatUrl("javascript:alert(1)"), "");
  assert.equal(helpers.codeChatUrl(""), "");
});

test("codeChatModelOptions lists chat models and picks the default", () => {
  const { names, selected } = helpers.codeChatModelOptions({
    models: ["qwen2.5-coder:1.5b", "nomic-embed-text:latest", "qwen2.5-coder:14b", "Bad Name"],
    model: "",
    defaultModel: "qwen2.5-coder:14b",
  });
  assert.deepEqual(names, ["qwen2.5-coder:1.5b", "qwen2.5-coder:14b"]);
  assert.equal(selected, "qwen2.5-coder:14b");
  const remembered = helpers.codeChatModelOptions({ models: ["qwen2.5-coder:14b", "llama3.1:8b"], model: "llama3.1:8b" });
  assert.equal(remembered.selected, "llama3.1:8b");
  const empty = helpers.codeChatModelOptions({ models: [], model: "qwen2.5-coder:14b" });
  assert.deepEqual(empty.names, ["qwen2.5-coder:14b"]);
  const fallback = helpers.codeChatModelOptions({ models: ["mistral"], model: "gone:1b" });
  assert.equal(fallback.selected, "mistral");
});

test("codeChatStartCommand sends JSON with a validated model and folder", () => {
  const command = helpers.codeChatStartCommand("qwen2.5-coder:14b", " ~/webdev/hog-browser ");
  assert.ok(command.startsWith("containers:ai-code-start:"));
  const body = JSON.parse(command.slice("containers:ai-code-start:".length));
  assert.deepEqual(body, { model: "qwen2.5-coder:14b", folder: "~/webdev/hog-browser" });
  const odd = helpers.codeChatStartCommand("qwen2.5-coder:14b", "/home/me/a \"quoted\" dir");
  assert.equal(JSON.parse(odd.slice("containers:ai-code-start:".length)).folder, "/home/me/a \"quoted\" dir");
  assert.equal(helpers.codeChatStartCommand("nomic-embed-text", "~/x"), "");
  assert.equal(helpers.codeChatStartCommand("bad model", "~/x"), "");
  assert.equal(helpers.codeChatStartCommand("qwen2.5-coder:14b", ""), "");
  assert.equal(helpers.codeChatStartCommand("qwen2.5-coder:14b", "relative/dir"), "");
  assert.equal(helpers.codeChatStartCommand("qwen2.5-coder:14b", "~/x\nrm"), "");
});
