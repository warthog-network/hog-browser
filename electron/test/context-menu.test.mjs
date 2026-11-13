import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTemplate, searchUrl } = require("../lib/context-menu.js");
const policy = require("../lib/policy.js");
const allowed = (u) => policy.allowedBrowserOpenUrl(u);

function recorder() {
  const calls = [];
  const handler = { get: (_t, name) => (name === "canBack" || name === "canForward" ? true : (...args) => calls.push([name, ...args])) };
  return { calls, actions: new Proxy({}, handler) };
}
const labels = (t) => t.map((i) => i.label || i.role || i.type);

test("links get open, Iso, copy and save; javascript: links get nothing", () => {
  const { calls, actions } = recorder();
  const t = buildTemplate({ linkURL: "https://example.com/a", x: 1, y: 2 }, actions, { allowed });
  assert.deepEqual(labels(t).slice(0, 4), ["Open link in new tab", "Open link in Iso tab", "Copy link address", "Save link to Downloads"]);
  t[1].click();
  assert.deepEqual(calls[0], ["openTab", "https://example.com/a", true]);
  assert.ok(labels(t).includes("Inspect"));
  const bad = buildTemplate({ linkURL: "javascript:alert(1)" }, actions, { allowed });
  assert.ok(!labels(bad).includes("Open link in new tab"));
  assert.ok(labels(bad).includes("Back"));
});

test("images, selections and spelling", () => {
  const { calls, actions } = recorder();
  const img = buildTemplate({ mediaType: "image", srcURL: "https://example.com/i.png", x: 5, y: 6 }, actions, { allowed });
  img.find((i) => i.label === "Copy image").click();
  assert.deepEqual(calls.pop(), ["copyImage", 5, 6]);
  const sel = buildTemplate({ selectionText: "  hello   world " }, actions, { allowed });
  const search = sel.find((i) => i.label && i.label.startsWith("Search"));
  search.click();
  assert.deepEqual(calls.pop(), ["search", "hello   world"]);
  const spell = buildTemplate({ isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello", "help"], editFlags: {} }, actions, { allowed });
  assert.deepEqual(labels(spell).slice(0, 3), ["hello", "help", "Add to dictionary"]);
  spell[0].click();
  assert.deepEqual(calls.pop(), ["replaceMisspelling", "hello"]);
  assert.ok(labels(spell).includes("paste"));
});

test("the Hog UI only gets edit items", () => {
  const { actions } = recorder();
  const t = buildTemplate({ isEditable: true, linkURL: "https://example.com", editFlags: {} }, actions, { page: false, allowed });
  assert.ok(!labels(t).includes("Inspect"));
  assert.ok(!labels(t).includes("Open link in new tab"));
  assert.equal(buildTemplate({}, actions, { page: false }).length, 0);
  assert.equal(searchUrl("a b"), "https://duckduckgo.com/?q=a%20b");
});
