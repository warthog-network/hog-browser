"use strict";
// Small JSON files in the preview's data dir: preview-only settings and
// remembered site permissions. Never touches the WebKit Hog's data.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  blockThirdPartyCookies: true, // WebKit Hog's default (no third-party cookies)
  previewUpdateChecks: false, // needs published preview pre-releases; off until there are some
});

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class PreviewSettings {
  constructor(dir) {
    this.file = path.join(dir, "preview-settings.json");
    this.data = { ...DEFAULTS, ...readJson(this.file, {}) };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key) || typeof value !== typeof DEFAULTS[key]) return false;
    this.data[key] = value;
    writeJson(this.file, this.data);
    return true;
  }

  all() {
    return { ...this.data };
  }
}

const REMEMBERED = new Set(["notifications", "geolocation", "media"]);

/** Remembered "Allow" / "Block" answers per origin, for persistent sessions only. */
class SitePermissions {
  constructor(dir) {
    this.file = dir ? path.join(dir, "site-permissions.json") : null; // null: memory only
    const raw = this.file ? readJson(this.file, {}) : {};
    this.saved = new Map(Object.entries(raw).filter(([k, v]) => typeof v === "boolean" && SitePermissions.validKey(k)));
    this.session = new Map(); // answers without "remember", until the preview quits
  }

  static key(origin, permission, mediaTypes = []) {
    const kinds = permission === "media" ? `:${[...new Set(mediaTypes)].filter((t) => t === "audio" || t === "video").sort().join("+") || "audio+video"}` : "";
    return `${origin} ${permission}${kinds}`;
  }

  static validKey(key) {
    return /^https?:\/\/[^\s]+ (notifications|geolocation|media:(audio|video|audio\+video))$/.test(key);
  }

  /** true / false if answered, undefined if Hog must ask. */
  lookup(key) {
    if (this.session.has(key)) return this.session.get(key);
    return this.saved.get(key);
  }

  /** For permission checks: media is allowed if every asked kind was allowed. */
  allows(origin, permission, mediaTypes = []) {
    if (permission !== "media") return this.lookup(SitePermissions.key(origin, permission)) === true;
    const kinds = mediaTypes.length ? mediaTypes : ["audio", "video"];
    return kinds.every((kind) =>
      [SitePermissions.key(origin, "media", [kind]), SitePermissions.key(origin, "media", ["audio", "video"])].some((k) => this.lookup(k) === true),
    );
  }

  answer(key, allow, remember) {
    if (!SitePermissions.validKey(key)) return;
    if (remember) {
      this.session.delete(key);
      this.saved.set(key, Boolean(allow));
      this.flush();
    } else {
      this.session.set(key, Boolean(allow));
    }
  }

  forgetAll() {
    this.saved.clear();
    this.session.clear();
    this.flush();
  }

  count() {
    return this.saved.size;
  }

  flush() {
    if (this.file) writeJson(this.file, Object.fromEntries(this.saved));
  }
}

module.exports = { PreviewSettings, SitePermissions, DEFAULTS, REMEMBERED, readJson, writeJson };
