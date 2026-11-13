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

## Hog UI above pages

Sites cannot cover Hog's controls. The WebKit shell drew the edge grips and
menus inside each page, which YouTube (Trusted Types, its own stacking) and
fullscreen-style players could hide. Here they live in separate transparent
views stacked above the page view:

- grips: one small view per edge (16x36, 114 wide while hovered), click opens
  Tabs / Wallet, drag moves it, same as before;
- menus: `chrome-preload.js` sends a copy of the open suggestions, history or
  settings menu; the overlay draws it with Hog's own CSS exactly where Hog's
  UI has it, and clicks go back as the usual `menu:` commands. A click on the
  page closes the menu;
- any other Hog panel that overlaps the page (narrow-window wallet, dialogs)
  shows over a still picture of the page until it closes;
- HTML fullscreen hides all of it.

## What maps to what

| WebKit Hog (`hog`)                     | Chromium preview (`main.js`)                       |
|----------------------------------------|----------------------------------------------------|
| chrome WebView + `hogwin` handler      | BrowserWindow + `chrome-preload.js` (same commands) |
| `PageHost` WebKit views in a Gtk.Stack | `WebContentsView` per tab, laid out from `view:`    |
| `EDGE_GRIP_SCRIPT` (grips + menu copies drawn inside the page) | Transparent overlay `WebContentsView`s kept above every page (`overlay.html`): edge grips and the suggestions / history / settings menus. They only cover what they draw, so the page keeps its input. Other Hog panels over the page area get a still picture of the page underneath while open |
| `dapp-provider.js`                     | Same script, read from `public/` at start, injected by `page-preload.js` |
| shared / ephemeral WebsiteDataManager  | `persist:pages` / in-memory partition per Iso tab   |
| Wallet UI data dir                     | `persist:hog` partition                             |
| `PageDownloads` -> ~/Downloads         | `will-download` -> ~/Downloads, never overwrites    |
| Gtk.FileChooserDialog                  | `dialog.showOpenDialog` / `showSaveDialog`          |
| GTK share drop target                  | `webUtils.getPathForFile` on drop in `#share-drop`  |
| OPFS polyfill over HTTP                | Native OPFS (the polyfill steps aside in Chromium)  |
| ITP                                    | Ghostery ad + tracker lists, Global Privacy Control |
