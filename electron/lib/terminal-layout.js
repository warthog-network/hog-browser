"use strict";
// Pure geometry for the bottom terminal panel (tested without Electron).

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 80;
const MAX_RATIO = 0.7;

function clampHeight(height, contentHeight, { min = MIN_HEIGHT, maxRatio = MAX_RATIO, fallback = DEFAULT_HEIGHT } = {}) {
  const area = Math.max(0, Math.round(Number(contentHeight) || 0));
  const floor = Math.max(24, Math.round(Number(min) || MIN_HEIGHT));
  const max = Math.max(floor, Math.floor(area * (Number(maxRatio) || MAX_RATIO)));
  const n = Number(height);
  const wanted = Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  if (area < floor) return Math.max(0, area);
  return Math.max(floor, Math.min(max, wanted));
}

/** Window-space bounds of the docked panel (full content width, bottom edge). */
function panelBounds(width, contentHeight, height) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const area = Math.max(0, Math.round(Number(contentHeight) || 0));
  const h = clampHeight(height, area);
  return { x: 0, y: Math.max(0, area - h), width: w, height: h };
}

/** Shrink a page-view rectangle so it stops above a reserved bottom strip. */
function panelInset(bounds, reserved) {
  if (!bounds) return { x: 0, y: 0, width: 0, height: 0 };
  const take = Math.max(0, Math.round(Number(reserved) || 0));
  if (!take) return bounds;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(0, bounds.height - Math.min(bounds.height, take)) };
}

function reservedHeight(open, height, contentHeight) {
  return open ? clampHeight(height, contentHeight) : 0;
}

/** Safe container names accepted by guard.py / shell.py. */
function validContainerName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name);
}

const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

const VALID_TYPES = new Set(["ready", "input", "resize", "close", "open", "select", "drag", "hide", "list"]);

/** Running containers the panel may offer as SSH tabs. */
function runningContainers(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || !validContainerName(item.name)) continue;
    if (item.state !== "running" || item.reason) continue;
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push({ name: item.name, image: typeof item.image === "string" ? item.image.slice(0, 120) : "" });
  }
  return out;
}

module.exports = {
  DEFAULT_HEIGHT,
  MIN_HEIGHT,
  MAX_RATIO,
  clampHeight,
  panelBounds,
  panelInset,
  reservedHeight,
  validContainerName,
  CONTAINER_NAME_RE,
  VALID_TYPES,
  runningContainers,
};
