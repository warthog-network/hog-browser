import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(electronDir, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const themeBg = ((read("public/retro.css").match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1] || "").toLowerCase();
const ruleBody = (text, selector) => {
  const match = text.match(new RegExp(selector.replace(/[.]/g, "\\.") + "\\s*\\{([^}]+)\\}"));
  return match ? match[1] : "";
};
const bgOf = (body) => ((body.match(/background(?:-color)?:\s*(#[0-9a-f]{6})\b/i) || [])[1] || "").toLowerCase();
const appCss = read("public/app.css");
const main = read("electron/main.js");
const chromeBg = ((main.match(/const CHROME_BG = "(#[0-9a-fA-F]{6})"/) || [])[1] || "").toLowerCase();

test("the Electron chrome view paints the same black as the intro flash and theme", () => {
  assert.equal(themeBg, "#0b0b0d");
  assert.equal(bgOf(ruleBody(appCss, ".boot-flash")), themeBg);
  assert.equal(bgOf(ruleBody(appCss, ".boot-flash video")), themeBg);
  assert.equal(chromeBg, themeBg);
  assert.match(main, /backgroundColor:\s*CHROME_BG/);
  assert.match(main, /function paintChromeBackground/);
  assert.match(main, /setBackgroundColor\(PAGE_BG\)/);
  assert.match(main, /ready-to-show[\s\S]*paintChromeBackground/);
});

test("web pages still get a white view; overlays stay transparent", () => {
  assert.match(main, /const PAGE_BG = "#ffffff"/);
  assert.match(main, /setBackgroundColor\("#00000000"\)/);
});
