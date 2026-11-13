# Hog (Chromium preview)

An experimental Hog shell on Electron (Chromium) instead of GTK3 + WebKitGTK.
It runs **next to** the installed Hog Browser and does not replace it.

- App name **Hog (Chromium preview)**, app id `org.hog.BrowserChromiumPreview`,
  command `hog-chromium-preview`, window class `hog-chromium-preview`.
- Its own browser profile in `~/.local/share/hog-chromium-preview` (cookies,
  site data, the wallet page's storage, the node tab's chain, history).
  The WebKit Hog's `~/.local/share/hog-browser/pages` is never touched.
- `server.mjs` and `public/` are used unchanged. If the WebKit Hog is already
  running, the preview attaches to its server on `127.0.0.1:4188` (mining,
  Tailscale, Files, phone app keep working and nothing starts twice). If not, it
  starts its own copy of `server.mjs` with Electron's built-in Node. If the
  WebKit Hog quits and takes its server with it, the preview starts its own and
  reloads. If you quit the preview while the WebKit Hog is using the preview's
  server, the server stays up.
- Settings -> Containers, Tailscale, Samba, Jellyfin, SSH tabs use `guard.py`
  through `guard-bridge.py` (JSON lines over a pipe, no socket).

## Try it

From a CI build (Actions -> "Chromium preview (Electron)" -> artifact):

```bash
sudo apt install ./hog-chromium-preview_*_amd64.deb   # recommended
hog-chromium-preview
```

The .deb installs an AppArmor profile so Chromium's sandbox works on Ubuntu
24.04+ (which blocks unprivileged user namespaces). Remove it with
`sudo apt remove hog-chromium-preview`; Hog Browser is a different package.

The AppImage needs no install, but on Ubuntu 24.04+ Chromium's sandbox cannot
start from an AppImage without an AppArmor profile, so it only runs with
`--no-sandbox`. Use that only for a quick look, not for daily browsing.

## Develop

```bash
npm ci && npm run build          # repo root: bundles + ws
cd electron && npm ci
npm start                        # stages ../ into electron/hog-app and runs Electron
npm test
npm run dist                     # dist/*.deb and dist/*.AppImage
```

`HOG_PREVIEW_DATA` moves the profile, `HOG_NO_ADBLOCK=1` turns off ad and
tracker blocking, `HOG_PREVIEW_DEBUG=1` logs popups and gestures, and F12
(or Ctrl+Shift+I) opens DevTools for the focused page.

## What maps to what

| WebKit Hog (`hog`)                     | Chromium preview (`main.js`)                       |
|----------------------------------------|----------------------------------------------------|
| chrome WebView + `hogwin` handler      | BrowserWindow + `chrome-preload.js` (same commands) |
| `PageHost` WebKit views in a Gtk.Stack | `WebContentsView` per tab, laid out from `view:`    |
| `EDGE_GRIP_SCRIPT`, `dapp-provider.js` | Same scripts, read from `hog` / `public/` at start, injected by `page-preload.js` |
| shared / ephemeral WebsiteDataManager  | `persist:pages` / in-memory partition per Iso tab   |
| Wallet UI data dir                     | `persist:hog` partition                             |
| `PageDownloads` -> ~/Downloads         | `will-download` -> ~/Downloads, never overwrites    |
| Gtk.FileChooserDialog                  | `dialog.showOpenDialog` / `showSaveDialog`          |
| GTK share drop target                  | `webUtils.getPathForFile` on drop in `#share-drop`  |
| OPFS polyfill over HTTP                | Native OPFS (the polyfill steps aside in Chromium)  |
| ITP                                    | Ghostery ad + tracker lists, Global Privacy Control |
