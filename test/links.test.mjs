import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("const SERVICE_LINK_KINDS");
const end = app.indexOf("function openServiceLink");
assert.ok(start > 0 && end > start, "Service link helpers are in app.js");
const helpers = new Function(`${app.slice(start, end)}\nreturn { serviceLinkUrl, serviceLinksFor };`)();

test("serviceLinkUrl allows loopback, LAN, tailnet IPs, and ts.net names", () => {
  assert.equal(helpers.serviceLinkUrl("http://127.0.0.1:8096"), "http://127.0.0.1:8096/");
  assert.equal(helpers.serviceLinkUrl("http://192.168.1.223:8080/"), "http://192.168.1.223:8080/");
  assert.equal(helpers.serviceLinkUrl("http://10.0.0.5:8080"), "http://10.0.0.5:8080/");
  assert.equal(helpers.serviceLinkUrl("http://172.20.1.2:8080"), "http://172.20.1.2:8080/");
  assert.equal(helpers.serviceLinkUrl("http://100.119.132.89:8096"), "http://100.119.132.89:8096/");
  assert.equal(helpers.serviceLinkUrl("http://hog.tail314642.ts.net:8096"), "http://hog.tail314642.ts.net:8096/");
  assert.equal(helpers.serviceLinkUrl("https://hog.tail314642.ts.net:3000"), "https://hog.tail314642.ts.net:3000/");
});

test("serviceLinkUrl rejects anything else", () => {
  for (const bad of [
    "",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://8.8.8.8:80",
    "http://100.200.1.1:8096",
    "http://172.40.1.1:8096",
    "http://example.com:8096",
    "http://evil.ts.net.example.com:8096",
    "http://localhost:8096",
    "http://127.0.0.1",
    "http://127.0.0.1:8096/admin",
    "http://127.0.0.1:8096/?x=1",
    "http://127.0.0.1:8096/#x",
    "http://user@127.0.0.1:8096/",
    "ftp://127.0.0.1:21",
  ]) {
    assert.equal(helpers.serviceLinkUrl(bad), "", bad);
  }
});

test("serviceLinksFor cleans, labels, and dedupes backend links", () => {
  const links = helpers.serviceLinksFor({
    name: "jellyfin",
    links: [
      { kind: "local", label: "This computer", url: "http://127.0.0.1:8096" },
      { kind: "local", label: "Again", url: "http://127.0.0.1:8096/" },
      { kind: "tailnet", label: "Tailnet", url: "http://hog.tail314642.ts.net:8096" },
      { kind: "tailnet", label: "Tailnet IP", url: "http://100.119.132.89:8096" },
      { kind: "lan", label: "", url: "http://192.168.1.223:8096" },
      { kind: "weird", label: "Odd", url: "http://127.0.0.1:9000" },
      { kind: "local", label: "Bad", url: "javascript:alert(1)" },
      null,
    ],
  });
  assert.deepEqual(links.map((link) => [link.kind, link.label, link.text]), [
    ["local", "This computer", "127.0.0.1:8096"],
    ["tailnet", "Tailnet", "hog.tail314642.ts.net:8096"],
    ["tailnet", "Tailnet IP", "100.119.132.89:8096"],
    ["lan", "Home network", "192.168.1.223:8096"],
    ["local", "Odd", "127.0.0.1:9000"],
  ]);
  assert.equal(links[0].url, "http://127.0.0.1:8096/");
  assert.deepEqual(helpers.serviceLinksFor({ name: "x" }), []);
  assert.deepEqual(helpers.serviceLinksFor(null), []);
});
