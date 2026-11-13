"use strict";
// "Set as default browser" for the preview: points http/https at
// hog-chromium-preview.desktop with xdg-settings (only when the user clicks),
// remembers the previous browser in the preview's data dir and restores it.
// Answers in the same shape as guard.py's browser_default_payload so the
// existing Settings card works unchanged.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP = "hog-chromium-preview.desktop";
const DESKTOP_DIRS = ["/usr/share/applications", "/usr/local/share/applications", path.join(process.env.HOME || "", ".local/share/applications")];

function validDesktopId(id) {
  return /^[A-Za-z0-9._-]{1,120}\.desktop$/.test(String(id || ""));
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (error, stdout, stderr) => resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

class DefaultBrowser {
  constructor(dataDir, { runner = run, installed } = {}) {
    this.file = path.join(dataDir, "previous-default-browser");
    this.run = runner;
    this.installed = installed || (() => DESKTOP_DIRS.some((dir) => fs.existsSync(path.join(dir, DESKTOP))));
  }

  previous() {
    try {
      const id = fs.readFileSync(this.file, "utf8").trim();
      return validDesktopId(id) && id !== DESKTOP ? id : "";
    } catch {
      return "";
    }
  }

  async current() {
    const r = await this.run("xdg-settings", ["get", "default-web-browser"]);
    if (r.code !== 0) throw new Error((r.stderr || "xdg-settings is not available").trim().split("\n").pop().slice(0, 180));
    return r.stdout.trim();
  }

  async payload(ok = true, error = "", notice = "") {
    let current = "";
    try {
      current = await this.current();
    } catch {
      current = "";
    }
    return {
      ok,
      error,
      notice,
      defaultBrowser: current === DESKTOP,
      defaultBrowserId: current,
      defaultBrowserPrevious: this.previous(),
      defaultBrowserAvailable: this.installed(),
    };
  }

  async status() {
    if (!this.installed()) return this.payload(true, "", "Install the hog-chromium-preview .deb so the preview can register as a browser.");
    return this.payload();
  }

  async set() {
    if (!this.installed()) return this.payload(false, "Install the hog-chromium-preview .deb so the preview can register as a browser.");
    let current;
    try {
      current = await this.current();
    } catch (error) {
      return this.payload(false, error.message);
    }
    if (current && current !== DESKTOP && validDesktopId(current)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${current}\n`, { mode: 0o600 });
    }
    const r = await this.run("xdg-settings", ["set", "default-web-browser", DESKTOP]);
    if (r.code !== 0) return this.payload(false, (r.stderr || "Could not set the default browser.").trim().split("\n").pop().slice(0, 180));
    await this.run("xdg-mime", ["default", DESKTOP, "x-scheme-handler/http", "x-scheme-handler/https", "text/html"]);
    return this.payload(true, "", "The Chromium preview is the default browser for http and https links.");
  }

  async clear() {
    let current;
    try {
      current = await this.current();
    } catch (error) {
      return this.payload(false, error.message);
    }
    if (current !== DESKTOP) return this.payload(true, "", "The preview is already not the default browser.");
    const target = this.previous();
    if (!target) return this.payload(false, "No other browser was saved. Choose one in Settings → Default Apps, then try again.");
    const r = await this.run("xdg-settings", ["set", "default-web-browser", target]);
    if (r.code !== 0) return this.payload(false, (r.stderr || "Could not restore the previous browser.").trim().split("\n").pop().slice(0, 180));
    await this.run("xdg-mime", ["default", target, "x-scheme-handler/http", "x-scheme-handler/https", "text/html"]);
    return this.payload(true, "", `${target.replace(/\.desktop$/, "")} is the default browser again.`);
  }
}

module.exports = { DefaultBrowser, DESKTOP, validDesktopId };
