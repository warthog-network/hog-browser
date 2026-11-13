"use strict";
// Third-party cookie blocking for page sessions (WebKit Hog never sends or
// stores cookies for sites other than the one in the address bar). Chromium
// has no switch for this in Electron, so the webRequest hooks strip Cookie
// and Set-Cookie on cross-site subresource requests.
const { getDomain } = require("tldts-experimental");

function site(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IP addresses
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

/** True when a request to requestUrl, made by a page whose address bar shows
 *  topUrl, is cross-site. Top-level navigations are never third-party. */
function isThirdParty(requestUrl, topUrl, resourceType) {
  if (resourceType === "mainFrame") return false;
  const top = site(topUrl);
  const target = site(requestUrl);
  if (!top || !target) return false;
  return top !== target;
}

function stripHeader(headers, name) {
  const out = {};
  const lower = name.toLowerCase();
  let removed = false;
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) removed = true;
    else out[key] = value;
  }
  return { headers: out, removed };
}

module.exports = { site, isThirdParty, stripHeader };
