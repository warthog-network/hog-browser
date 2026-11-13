"use strict";
// Pure geometry for the overlay views (tested without Electron).

const GRIP_W = 16;
const GRIP_HOT_W = 114;
const GRIP_H = 36;

/** Window-space bounds of a page-edge grip. top is relative to the page. */
function gripBounds(side, page, top, hot) {
  const width = hot ? GRIP_HOT_W : GRIP_W;
  const maxTop = Math.max(8, page.height - GRIP_H - 8);
  const y = Math.round(Math.min(Math.max(8, Number(top) || 0), maxTop));
  const x = side === "wallet" ? page.x + page.width - width : page.x;
  return { x: Math.round(x), y: page.y + y, width, height: GRIP_H, top: y };
}

/** One rectangle that covers the page and every open menu. */
function unionBounds(page, rects, width, height) {
  let x1 = page.x;
  let y1 = page.y;
  let x2 = page.x + page.width;
  let y2 = page.y + page.height;
  for (const r of rects) {
    x1 = Math.min(x1, Math.floor(r.x));
    y1 = Math.min(y1, Math.floor(r.y));
    x2 = Math.max(x2, Math.ceil(r.x + r.w));
    y2 = Math.max(y2, Math.ceil(r.y + r.h));
  }
  x1 = Math.max(0, x1);
  y1 = Math.max(0, y1);
  x2 = Math.min(width, x2);
  y2 = Math.min(height, y2);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/** Bounds around the open menus only, clamped to the window. */
function menuBounds(rects, width, height) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const first = rects[0];
  return unionBounds({ x: Math.floor(first.x), y: Math.floor(first.y), width: 0, height: 0 }, rects, width, height);
}

/** Clean up the menu snapshot the Hog UI preload sends. */
function cleanSurface(raw) {
  const kinds = new Set(["suggestions", "history", "settings"]);
  const out = { menus: [], cover: false, css: [] };
  if (!raw || typeof raw !== "object") return out;
  const word = (v) => (typeof v === "string" ? v.slice(0, 300) : "");
  if (raw.htmlClass) out.htmlClass = word(raw.htmlClass);
  if (raw.bodyClass) out.bodyClass = word(raw.bodyClass);
  if (raw.theme) out.theme = word(raw.theme);
  out.cover = Boolean(raw.cover);
  if (Array.isArray(raw.css)) {
    out.css = raw.css.filter((href) => typeof href === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w./-]+\.css$/.test(href)).slice(0, 8);
  }
  if (Array.isArray(raw.menus)) {
    for (const menu of raw.menus.slice(0, 3)) {
      if (!menu || !kinds.has(menu.kind) || typeof menu.html !== "string" || menu.html.length > 400000) continue;
      const r = menu.rect || {};
      const rect = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
      if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w < 3 || rect.h < 3) continue;
      const chain = (Array.isArray(menu.chain) ? menu.chain : [])
        .slice(-12)
        .filter((c) => c && /^[a-z][a-z0-9-]*$/.test(c.tag))
        .map((c) => ({ tag: c.tag, id: word(c.id), cls: word(c.cls) }));
      out.menus.push({ kind: menu.kind, html: menu.html, chain, rect, scroll: Number(menu.scroll) || 0 });
    }
  }
  return out;
}

module.exports = { GRIP_W, GRIP_HOT_W, GRIP_H, gripBounds, unionBounds, menuBounds, cleanSurface };
