import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { downloadPageHtml, isDownloadResponse } from "../server.mjs";

test("isDownloadResponse catches release assets and attachments", () => {
  assert.equal(isDownloadResponse("application/vnd.android.package-archive", "attachment; filename=hog-mobile-0.1.35.apk"), true);
  assert.equal(isDownloadResponse("application/octet-stream", ""), true);
  assert.equal(isDownloadResponse("application/zip; charset=binary", null), true);
  assert.equal(isDownloadResponse("text/html", "Attachment; filename=a.html"), true);
  assert.equal(isDownloadResponse("text/html; charset=utf-8", ""), false);
  assert.equal(isDownloadResponse("text/html", "inline"), false);
  assert.equal(isDownloadResponse("image/png", undefined), false);
  assert.equal(isDownloadResponse("", ""), false);
});

test("downloadPageHtml links the original URL, escaped", () => {
  const html = downloadPageHtml(
    "https://github.com/warthog-network/hog-browser/releases/download/0.1.35/hog-mobile-0.1.35.apk",
    "https://objects.githubusercontent.com/x?sig=1&response-content-disposition=attachment",
  );
  assert.match(html, /hog-mobile-0\.1\.35\.apk is a file, not a page/);
  assert.match(html, /href="https:\/\/github\.com\/warthog-network\/hog-browser\/releases\/download\/0\.1\.35\/hog-mobile-0\.1\.35\.apk"/);
  const evil = downloadPageHtml('https://e.example/%3Cscript%3E"x.zip', "https://e.example/");
  assert.doesNotMatch(evil, /<script>/);
});

test("the browse proxy checks for downloads before reading text", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const body = server.slice(server.indexOf("async function fetchPage("));
  assert.ok(body.indexOf("isDownloadResponse(") > 0);
  assert.ok(body.indexOf("isDownloadResponse(") < body.indexOf("await response.text()"));
});

test("app.js shows page download progress with Show in folder", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("const DOWNLOAD_STATES");
  const end = app.indexOf("window.__hogDownload = ");
  const h = new Function(`${app.slice(start, end)}\nreturn { downloadText, downloadSizeText };`)();
  assert.equal(h.downloadText({ state: "progress", name: "a.apk", progress: 0.5, received: 2 * 1024 * 1024 }), "Downloading a.apk… 50% · 2.0 MB");
  assert.equal(h.downloadText({ state: "done", name: "a.apk", received: 1536 }), "Saved a.apk to Downloads (2 KB).");
  assert.match(h.downloadText({ state: "failed", name: "a.apk", error: "Network" }), /a\.apk did not download\. Network/);
  assert.match(app, /Show in folder/);
});
