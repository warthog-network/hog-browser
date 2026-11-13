"use strict";
// Location for web pages without Google's network location service (which
// Electron can only use with a Google API key). Providers:
//   "system"   GeoClue, the desktop's location service (geoclue-locate.py);
//              GNOME's Location Services switch and its sources apply.
//   "beacondb" BeaconDB (https://beacondb.net), an open, Mozilla Location
//              Service-style API; without Wi-Fi scans it locates by IP.
//   "off"      Pages get "position unavailable".
const { execFile } = require("node:child_process");

const PROVIDERS = ["system", "beacondb", "off"];
const BEACONDB_URL = "https://api.beacondb.net/v1/geolocate";
const CACHE_MS = 60_000;

function validProvider(name) {
  return PROVIDERS.includes(name);
}

function cleanFix(raw, now = Date.now()) {
  const lat = Number(raw && raw.latitude);
  const lon = Number(raw && raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && Number(v) > -1e9 ? Number(v) : null);
  const acc = num(raw.accuracy);
  return {
    latitude: lat,
    longitude: lon,
    accuracy: acc !== null && acc > 0 ? acc : 5000,
    altitude: num(raw.altitude) !== null && Math.abs(raw.altitude) < 1e6 ? Number(raw.altitude) : null,
    altitudeAccuracy: null,
    heading: num(raw.heading) !== null && raw.heading >= 0 ? Number(raw.heading) : null,
    speed: num(raw.speed) !== null && raw.speed >= 0 ? Number(raw.speed) : null,
    timestamp: Number.isFinite(Number(raw.timestamp)) && Number(raw.timestamp) > 0 ? Number(raw.timestamp) : now,
  };
}

/** BeaconDB / MLS / Google-style answer -> fix. */
function parseBeaconDb(body, now = Date.now()) {
  if (!body || !body.location) return null;
  return cleanFix({ latitude: body.location.lat, longitude: body.location.lng, accuracy: body.accuracy, timestamp: now }, now);
}

class Locator {
  constructor({ helper, python = "python3", fetchImpl = (...a) => fetch(...a), runner } = {}) {
    this.helper = helper;
    this.python = python;
    this.fetch = fetchImpl;
    this.run = runner || ((args) => new Promise((resolve) => {
      execFile(this.python, args, { timeout: 30000 }, (error, stdout) => {
        try {
          resolve(JSON.parse(String(stdout).trim().split("\n").pop()));
        } catch {
          resolve({ ok: false, error: error ? error.message.split("\n")[0] : "no answer" });
        }
      });
    }));
    this.cache = new Map(); // provider -> { at, fix }
    this.pending = new Map();
  }

  /** -> { ok: true, fix } | { ok: false, error } */
  async locate(provider, { high = false, now = Date.now() } = {}) {
    if (!validProvider(provider) || provider === "off") return { ok: false, error: "Location is off for the preview (Settings -> General)." };
    const cached = this.cache.get(provider);
    if (cached && now - cached.at < CACHE_MS) return { ok: true, fix: cached.fix };
    if (this.pending.has(provider)) return this.pending.get(provider);
    const job = (provider === "system" ? this.fromGeoClue(high) : this.fromBeaconDb()).then((answer) => {
      this.pending.delete(provider);
      if (answer.ok) this.cache.set(provider, { at: Date.now(), fix: answer.fix });
      return answer;
    });
    this.pending.set(provider, job);
    return job;
  }

  async fromGeoClue(high) {
    const out = await this.run([this.helper, ...(high ? ["--high"] : [])]);
    if (!out || !out.ok) return { ok: false, error: (out && out.error) || "GeoClue gave no location." };
    const fix = cleanFix(out);
    return fix ? { ok: true, fix } : { ok: false, error: "GeoClue gave an invalid location." };
  }

  async fromBeaconDb() {
    try {
      const res = await this.fetch(BEACONDB_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "hog-chromium-preview" },
        body: JSON.stringify({ considerIp: true }),
      });
      if (!res.ok) return { ok: false, error: `BeaconDB answered ${res.status}.` };
      const fix = parseBeaconDb(await res.json());
      return fix ? { ok: true, fix } : { ok: false, error: "BeaconDB gave no location." };
    } catch (error) {
      return { ok: false, error: `BeaconDB: ${error.message}` };
    }
  }
}

/** Main-world script that routes navigator.geolocation to Hog (page-preload). */
const GEO_SHIM = `(() => {
  const ask = window.__hogGeo;
  if (typeof ask !== "function" || !window.Geolocation) return;
  try { delete window.__hogGeo; } catch (e) {}
  const err = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  const pos = (f) => ({ coords: { latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy, altitude: f.altitude, altitudeAccuracy: f.altitudeAccuracy, heading: f.heading, speed: f.speed, toJSON() { return { ...this }; } }, timestamp: f.timestamp, toJSON() { return { coords: this.coords.toJSON(), timestamp: this.timestamp }; } });
  const once = (ok, fail, opts) => {
    const timeout = opts && Number.isFinite(opts.timeout) ? opts.timeout : Infinity;
    let done = false;
    let timer = null;
    if (timeout !== Infinity) timer = setTimeout(() => { if (!done) { done = true; if (fail) fail(err(3, "Timeout expired")); } }, Math.max(0, timeout));
    ask(Boolean(opts && opts.enableHighAccuracy)).then((r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (r && r.ok) ok(pos(r.fix)); else if (fail) fail(err(r && r.code === 1 ? 1 : 2, (r && r.error) || "Position unavailable"));
    }, () => { if (!done) { done = true; clearTimeout(timer); if (fail) fail(err(2, "Position unavailable")); } });
  };
  const watches = new Map();
  let next = 1;
  const proto = Geolocation.prototype;
  const def = (name, fn) => Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn });
  def("getCurrentPosition", function getCurrentPosition(ok, fail, opts) { if (typeof ok !== "function") throw new TypeError("callback required"); once(ok, fail, opts); });
  def("watchPosition", function watchPosition(ok, fail, opts) {
    if (typeof ok !== "function") throw new TypeError("callback required");
    const id = next++;
    once(ok, fail, opts);
    watches.set(id, setInterval(() => once(ok, fail, opts), 30000));
    return id;
  });
  def("clearWatch", function clearWatch(id) { clearInterval(watches.get(id)); watches.delete(id); });
})();`;

module.exports = { PROVIDERS, BEACONDB_URL, validProvider, cleanFix, parseBeaconDb, Locator, GEO_SHIM };
