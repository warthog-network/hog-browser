import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
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

const SURFACES = ["home", "bookmarks-view", "files-view", "browser-settings", "status", "shell-view"];

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

test("the palette is Warthog's: gold primary, brand blue and navy secondary, black surfaces", () => {
  assert.equal(rootVar("accent"), "#fdb913");
  assert.equal(rootVar("accent-press"), "#e79300");
  assert.equal(rootVar("brand-gold"), "#fdb913");
  assert.equal(rootVar("blue"), "#035aa6");
  assert.equal(rootVar("navy"), "#033298");
  assert.equal(rootVar("blue-ink"), "#7fb2e5");
  assert.equal(rootVar("deep"), "#050505");
  assert.equal(rootVar("bg"), "#0b0b0d");
  assert.equal(rootVar("panel"), "#111214");
  assert.equal(rootVar("raised"), "#17181b");
  for (const off of ["#ff4fd8", "#3ef0ff", "#ff5ca8", "#ff8ae6", "62, 240, 255", "255, 79, 216", "#070a18", "#0d1326", "#111b2e", "#01030a"]) {
    assert.ok(!retro.toLowerCase().includes(off), `retro.css drops ${off}`);
  }
  const tiles = appJs.match(/const BM_TILE_COLORS = \[([^\]]*)\]/);
  assert.ok(tiles, "letter tile colors are declared");
  const allowed = new Set(["#fdb913", "#7fb2e5", "#e9e9e9"]);
  for (const color of tiles[1].match(/#[0-9a-f]{6}/gi)) assert.ok(allowed.has(color.toLowerCase()), `${color} is a theme color`);
});

test("purple is only a rare accent, never the primary accent", () => {
  const body = css(retro);
  assert.equal(rootVar("accent-rgb").replace(/\s+/g, ""), "253,185,19", "--accent-rgb is Warthog gold");
  for (const name of ["accent", "gold", "amber", "hover", "line", "line-strong", "glow", "glow-soft", "glow-text"]) {
    const value = rootVar(name);
    assert.ok(!/purple|c084fc|192,\s*132,\s*252/.test(value), `--${name} is not purple`);
  }
  assert.doesNotMatch(body, /--(gold|accent|amber)\s*:\s*var\(--purple\)/, "no rule remaps the accent to purple");
  assert.doesNotMatch(body, /192,\s*132,\s*252/, "no purple tints for borders or glows");
  assert.match(body, /\.primary\s*\{[^}]*background:\s*var\(--accent\)/, "primary buttons are gold");
  assert.match(body, /\.primary\s*\{[^}]*color:\s*var\(--accent-ink\)/, "gold buttons carry dark text");
  assert.match(body, /:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--accent\)/, "focus ring is gold");
  assert.match(body, /\.tab-wrap\.is-active\s*\{[^}]*inset 2px 0 0 var\(--accent\)/, "active tab is gold");
  const uses = body.match(/var\(--purple\)/g) || [];
  assert.ok(uses.length <= 2, `purple is used at most twice (found ${uses.length})`);
});

function luminance(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("theme colors keep readable contrast", () => {
  assert.ok(contrast(rootVar("accent-ink"), rootVar("accent")) >= 7, "dark text on gold buttons");
  assert.ok(contrast(rootVar("accent-ink"), rootVar("accent-press")) >= 4.5, "dark text on pressed buttons");
  assert.ok(contrast(rootVar("text"), rootVar("panel")) >= 7, "body text on panels");
  assert.ok(contrast(rootVar("muted"), rootVar("panel")) >= 4.5, "muted text on panels");
  assert.ok(contrast(rootVar("blue-ink"), rootVar("bg")) >= 4.5, "blue links on the page");
  assert.ok(contrast(rootVar("accent"), rootVar("bg")) >= 4.5, "gold labels on the page");
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

// The running-logo clips have their background flattened to one surface color.
// The CSS around each clip must paint that same color, or the clip shows as a square.
const ruleBody = (text, selector) => (rules(text).find((rule) => rule.selector === selector) || {}).body || "";
const bgOf = (body) => ((body.match(/background(?:-color)?:\s*(#[0-9a-f]{6})\b/i) || [])[1] || "").toLowerCase();

test("the intro flash paints the page background, which the intro clip is encoded on", () => {
  assert.equal(bgOf(ruleBody(appCss, ".boot-flash")), rootVar("bg"));
  assert.equal(bgOf(ruleBody(appCss, ".boot-flash video")), rootVar("bg"));
  assert.match(html, /id="boot-video" src="wartlogorun\.mp4"/);
  assert.match(html, /__hogChromium.*wartlogorun\.webm/);
});

test("the wallet clip paints the wallet panel color, which its own encode uses", () => {
  assert.equal(bgOf(ruleBody(appCss, ".brand-run")), rootVar("wallet"));
  assert.match(appJs, /function brandClip/);
  assert.match(appJs, /__hogChromium \? "webm" : "mp4"/);
  assert.match(appJs, /brandClip\("wartlogorun-wallet"/);
});

test("Chromium gets alpha WebM clips; WebKit keeps the flattened mp4s", () => {
  for (const stem of ["wartlogorun", "wartlogorun-wallet"]) {
    const mp4 = new URL(`../public/${stem}.mp4`, import.meta.url);
    const webm = new URL(`../public/${stem}.webm`, import.meta.url);
    assert.ok(!lstatSync(mp4).isSymbolicLink(), `${stem}.mp4 is its own file`);
    assert.ok(!lstatSync(webm).isSymbolicLink(), `${stem}.webm is its own file`);
    const data = readFileSync(webm);
    assert.deepEqual([...data.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], `${stem}.webm is EBML`);
    // VP9 alpha is stored as WebM BlockAdditions (EBML 0x75A1), not a second stream.
    assert.ok(data.includes(Buffer.from([0x75, 0xa1])), `${stem}.webm has BlockAdditions (alpha)`);
  }
});

test("the running-logo clips are separate full-range BT.709 files", () => {
  for (const name of ["wartlogorun.mp4", "wartlogorun-wallet.mp4"]) {
    const url = new URL(`../public/${name}`, import.meta.url);
    assert.ok(!lstatSync(url).isSymbolicLink(), `${name} is its own encode, not a link`);
    const data = readFileSync(url);
    const at = data.indexOf("colrnclx");
    assert.ok(at > 0, `${name} carries an nclx color box`);
    // primaries 1, transfer 1, matrix 1 (BT.709), then the full-range bit.
    assert.deepEqual([...data.subarray(at + 8, at + 14)], [0, 1, 0, 1, 0, 1], `${name} is BT.709`);
    assert.equal(data[at + 14] & 0x80, 0x80, `${name} is tagged full range`);
  }
});
