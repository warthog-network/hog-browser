// Read BzMiner's local dashboard. It listens on 127.0.0.1:4014 with no
// password, so this never dials any other address. The snapshot's pool
// user is a wallet plus a rig name; only the rig name leaves this module.
import { request as httpRequest } from "node:http";

const MAX_BODY = 262_144;

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** @returns {null | { ok: true, hashrate: number, avgHashrate: number | null, powerW: number | null, worker: string, devices: object[] }} */
export function parseBzminerSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !raw.summary || typeof raw.summary !== "object") return null;
  const hashrate = finiteOrNull(raw.summary.total_hashrate);
  if (hashrate == null) return null;
  const devices = [];
  if (Array.isArray(raw.devices)) {
    for (const device of raw.devices.slice(0, 16)) {
      if (!device || typeof device !== "object") continue;
      devices.push({
        name: String(device.name || "Device").replace(/\s+/g, " ").trim().slice(0, 80) || "Device",
        hashrate: finiteOrNull(device.hashrate),
        tempC: finiteOrNull(device.temp_c),
        powerW: finiteOrNull(device.power_w),
        accepted: finiteOrNull(device.accepted),
        rejected: finiteOrNull(device.rejected),
        stale: finiteOrNull(device.stale),
      });
    }
  }
  let worker = "";
  if (Array.isArray(raw.pools)) {
    for (const pool of raw.pools) {
      const match = String(pool?.user || "").match(/^[0-9a-f]{48}\.(.+)$/i);
      if (match) {
        worker = match[1].replace(/\s+/g, " ").trim().slice(0, 64);
        break;
      }
    }
  }
  return {
    ok: true,
    hashrate,
    avgHashrate: finiteOrNull(raw.summary.avg_hashrate),
    powerW: finiteOrNull(raw.summary.power_w),
    worker,
    devices,
  };
}

/**
 * GET 127.0.0.1:4014/api/snapshot. Failure, a timeout, or a body that is
 * not a snapshot resolves to null. A hashrate of 0 is a real reading.
 */
export function readBzminerSnapshot({
  port = 4014,
  timeoutMs = 800,
  requestImpl = httpRequest,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = requestImpl(
      { host: "127.0.0.1", port, path: "/api/snapshot", method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(null);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            finish(parseBzminerSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => finish(null));
    req.end();
  });
}
