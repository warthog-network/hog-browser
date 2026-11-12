import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const retro = read("retro.css");
const appCss = read("app.css");
const html = read("index.html");
const appJs = read("app.js");

// Strip comments so prose about gradients does not count as CSS.
const css = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

function rules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css(text)))) {
    out.push({ selector: match[1].trim(), body: match[2] });
  }
  return out;
}

function rootVar(name) {
  const root = rules(retro).find((rule) => rule.selector === ":root");
  assert.ok(root, "retro.css has a :root block");
  const found = root.body.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return found ? found[1].trim().toLowerCase() : "";
}

const SURFACES = ["home", "bookmarks-view", "browser-settings", "status", "shell-view"];

test("every Hog page section exists in index.html", () => {
  for (const id of SURFACES) assert.match(html, new RegExp(`id="${id}"`), `#${id} is in index.html`);
});

test("every Hog page sits on a solid background color, not gradient-only layers", () => {
  const solid = rules(retro).find((rule) => /background-color:\s*var\(--bg\)/.test(rule.body) && /\bhtml\b/.test(rule.selector));
  assert.ok(solid, "retro.css paints html and the page surfaces with var(--bg)");
  const selectors = solid.selector.split(",").map((part) => part.trim());
  for (const name of ["html", "body", ".home", ".status", ".view"]) assert.ok(selectors.includes(name), `${name} gets the solid color`);
  for (const id of SURFACES) {
    assert.ok(selectors.includes(`#${id}`) || selectors.includes(`.${id}`), `#${id} gets the solid color`);
  }
  assert.match(rootVar("bg"), /^#[0-9a-f]{6}$/, "--bg is a solid hex color");
});

test("no rule resets a page surface to a transparent gradient background", () => {
  const surface = /(^|[\s,])(html|body|\.home|\.status|\.view|#home|#bookmarks-view|#browser-settings|\.bm-page)(?=$|[\s,:.{[])/;
  for (const { selector, body } of [...rules(appCss), ...rules(retro)]) {
    if (!surface.test(selector)) continue;
    const shorthand = body.match(/(?:^|;)\s*background:\s*([^;]+)/);
    if (!shorthand) continue;
    const value = shorthand[1];
    if (!/gradient\(/.test(value)) continue;
    // A gradient shorthand must end on a real color layer.
    assert.match(value, /(#[0-9a-f]{3,8}|var\(--[a-z-]+\))\s*$/i, `${selector} keeps a solid color under its gradient`);
  }
});

test("the theme is matte: no scanlines, horizon grid or big gradients", () => {
  const body = css(retro);
  assert.doesNotMatch(body, /repeating-linear-gradient/, "no scanlines");
  assert.doesNotMatch(body, /radial-gradient/, "no radial glows behind pages");
  assert.doesNotMatch(body, /#home::after/, "no horizon grid");
  assert.doesNotMatch(body, /perspective\(/, "no 3D grid transform");
  for (const line of body.split("\n")) {
    if (/linear-gradient\(/.test(line)) assert.match(line, /mask-image/, `only fade masks use gradients: ${line.trim()}`);
  }
});

test("the palette is Warthog's: brand blue and navy, site purple, gold kept for accents", () => {
  assert.equal(rootVar("purple"), "#c084fc");
  assert.equal(rootVar("blue"), "#035aa6");
  assert.equal(rootVar("navy"), "#033298");
  assert.equal(rootVar("brand-gold"), "#fdb913");
  assert.equal(rootVar("deep"), "#01030a");
  assert.equal(rootVar("raised"), "#111b2e");
  for (const off of ["#ff4fd8", "#3ef0ff", "#ff5ca8", "#ff8ae6", "62, 240, 255", "255, 79, 216"]) {
    assert.ok(!retro.toLowerCase().includes(off), `retro.css drops the off-brand ${off}`);
  }
  const tiles = appJs.match(/const BM_TILE_COLORS = \[([^\]]*)\]/);
  assert.ok(tiles, "letter tile colors are declared");
  const allowed = new Set(["#c084fc", "#7fb2e5", "#e9e9e9", "#fdb913"]);
  for (const color of tiles[1].match(/#[0-9a-f]{6}/gi)) assert.ok(allowed.has(color.toLowerCase()), `${color} is a theme color`);
});

test("one shape and rhythm: shared radius and control height tokens", () => {
  for (const name of ["r-sm", "r", "r-lg", "pill", "ctl-h"]) assert.ok(rootVar(name), `--${name} is defined`);
  assert.match(retro, /\.primary\s*\{[^}]*border-radius:\s*var\(--pill\)/);
  assert.match(retro, /\.shortcuts button\s*\{[^}]*border-radius:\s*var\(--pill\)/);
});

test("glow is reserved for focus, hover and active states", () => {
  for (const { selector, body } of rules(retro)) {
    if (!/var\(--glow(-soft)?\)/.test(body)) continue;
    assert.match(selector, /:hover|:focus|focus-within|focus-visible|is-drop|\[aria-current|is-active/, `${selector} glows only when interacted with`);
  }
});

test("index.html declares a dark color scheme and loads the theme after app.css", () => {
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  const app = html.indexOf('href="app.css"');
  const theme = html.indexOf('href="retro.css"');
  assert.ok(app > 0 && theme > app, "retro.css loads after app.css");
  assert.match(retro, /prefers-reduced-motion:\s*reduce/);
});
