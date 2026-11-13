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

- grips: one small view per edge, click opens Tabs / Wallet, drag moves it;
  the floating "Tabs" / "Wallet" label shows in its own view above the grip and
  the page is inset by the gold rail line so the line stays visible;
- toasts (download finished, copied, updates) are copied into their own view,
  buttons included ("Show in folder" etc.);
- Ctrl+F opens a find bar over the page's top right (Enter / F3 / Ctrl+G next,
  Shift for previous, Esc closes);
- menus: `chrome-preload.js` sends a copy of the open suggestions, history or
  settings menu; the overlay draws it with Hog's own CSS exactly where Hog's
  UI has it, and clicks go back as the usual `menu:` commands. A click on the
  page closes the menu;
- any other Hog panel that overlaps the page (narrow-window wallet, dialogs)
  shows over a still picture of the page until it closes;
- HTML fullscreen hides all of it.

## Settings -> General -> Chromium preview

- **Import from Hog** reads bookmarks, favorites, history and settings
  (display size, auto-lock, panel positions, Files view, network) from the
  WebKit Hog's localStorage (`~/.local/share/hog-browser/localstorage`).
  `webkit-import.py` copies the SQLite file to a private temp dir and reads only
  those keys; the WebKit Hog's files are never written. A dialog shows the
  counts, then the preview merges (a fresh preview takes Hog's bookmarks as they
  are; otherwise missing ones are added, folders matched by name) and restarts.
- **Import wallet** is a separate button with its own warning dialog (Cancel is
  the default). It copies the encrypted wallet record, account name, chain and
  connected sites; nothing is decrypted, and it refuses if the preview already
  has a wallet.
- **Third-party cookies** are blocked by default (Cookie and Set-Cookie are
  removed from requests to another site than the one in the address bar).
  This works on HTTP headers; script `document.cookie` inside third-party
  frames still works, as with WebKit's ITP.
- **Site permissions**: notifications, location, camera and microphone ask with
  a "Remember for this site" box; "Forget all" clears the answers
  (`site-permissions.json`). Iso tabs remember only until they close. Location
  needs a Google API key in Electron, so sites usually get "position
  unavailable" even when allowed.
- **Preview updates** check GitHub pre-releases tagged `preview-*` that carry a
  `hog-chromium-preview_<version>_amd64.deb`, and only link the release page.
  The WebKit Hog's updater reads `/releases/latest`, which never includes
  pre-releases, so it cannot be affected. Checks are off by default; nothing is
  found until a preview pre-release is published.
- **Default browser** (the Browser card) points http/https at
  `hog-chromium-preview.desktop` with `xdg-settings`, saves the previous
  browser in the preview's data dir and restores it.

Right-click gives open in new / Iso tab, copy link, save link or image to
Downloads, copy image, spelling suggestions, search for the selection, back /
forward / reload, print and Inspect. Ctrl+P prints (GTK dialog; without a
printer set up it saves `<title>.pdf` in Downloads).

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
