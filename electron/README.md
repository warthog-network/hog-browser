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
  starts its own copy of `server.mjs` with Electron's built-in Node, and the
  package ships hog-app's production `node_modules` (the same set the WebKit
  .deb ships) so that works without the WebKit Hog installed. If the
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
- **Third-party cookies** are blocked by default: Cookie and Set-Cookie are
  removed from requests to another site than the one in the address bar, and
  frames from another site get an empty `document.cookie` that ignores writes
  and no `cookieStore` (`frame-preload.js`, run in every iframe through
  `nodeIntegrationInSubFrames` with the sandbox still on, so no Node there).
- **Site permissions**: notifications, location, camera and microphone ask with
  a "Remember for this site" box; "Forget all" clears the answers
  (`site-permissions.json`). Iso tabs remember only until they close.
- **Location for sites** never uses Google's service (Electron would need a
  Google API key). `navigator.geolocation` in pages goes through Hog, asks like
  other permissions, then uses the chosen provider: **System** (GeoClue, the
  desktop location service; GNOME Settings → Privacy → Location Services
  decides, `geoclue-locate.py` via python3-gi), **BeaconDB** (beacondb.net,
  open; locates by IP address, about city level) or **Off**.
- **Preview updates** check GitHub pre-releases tagged `preview-*` that carry a
  `hog-chromium-preview_<version>_amd64.deb` and a `SHA256SUMS`. **Install
  update** (installed .deb only) downloads both, checks the hash and the
  package name and version, then runs `pkexec apt-get install` on the file,
  which shows the system password prompt; **Restart now** relaunches. The
  WebKit Hog's updater reads `/releases/latest`, which never includes
  pre-releases, so it cannot be affected. Checks are off by default; nothing is
  found until a preview pre-release is published.
- **Default browser** (the Browser card) points http/https at
  `hog-chromium-preview.desktop` with `xdg-settings`, saves the previous
  browser in the preview's data dir and restores it.

Right-click gives open in new / Iso tab, copy link, save link or image to
Downloads, copy image, spelling suggestions, search for the selection, back /
forward / reload, Save page as (Ctrl+S: complete HTML or one .mhtml file),
print and Inspect. Ctrl+P prints (GTK dialog; without a printer set up it
saves `<title>.pdf` in Downloads).

Pop-ups: a page can only open something right after a click or key press.
`window.open` with a size or `popup` (sign-in windows: Google, GitHub, wallets)
gets a small window that keeps `window.opener`, shows the site's address in
its title and follows the same navigation rules as tabs; other new windows
open as Hog tabs; anything without a click is blocked.

Window: the top bar's empty space and the ⋮⋮ grip move the window; the edges
resize it (a 5 px band inside the edge on X11; on Wayland, where Electron 45
runs natively by default, GTK draws a shadow with a resize border outside).

Windows: CI also builds an unsigned NSIS installer and zip (artifact only,
untested; Containers, Samba and Tailscale need Linux).

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
