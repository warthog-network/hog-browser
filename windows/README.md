# Hog for Windows (v1, Electron)

The Linux app is a GTK/WebKitGTK shell (`hog`) around Hog's local server
(`server.mjs`) and web UI (`public/`). Hog for Windows keeps the server and UI
as they are and swaps the shell for Electron:

| Linux (`hog`)                              | Windows (`windows/`)                                   |
|--------------------------------------------|--------------------------------------------------------|
| chrome WebKit view on 127.0.0.1:4188       | frameless `BrowserWindow`, `preload-chrome.cjs`        |
| `window.webkit.messageHandlers.hogwin`     | same name, bridged to `ipcMain` (`main.cjs`)           |
| `PageHost` WebKit views per tab            | one `WebContentsView` per tab, placed by `view:` cmds  |
| isolated tabs: ephemeral WebKit context    | isolated tabs: in-memory session per tab               |
| page user scripts (edge grips, menus, dapp)| `gen/preload-page.cjs`, scripts copied from `hog` and `public/dapp-provider.js` at stage time |
| decide-policy / allowed()                  | `will-navigate`, `will-redirect`, `setWindowOpenHandler` (`lib/rules.cjs`) |
| Ctrl+D, Ctrl+Shift+O over pages            | `before-input-event`                                   |
| bookmark import/export (GTK dialogs)       | Electron file dialogs, same payloads                   |
| node tab (WASM, OPFS through Hog's disk)   | same; SharedArrayBuffer switched on for the node frame |
| solo mining stratum 127.0.0.1:3456, tailnet| same server code; tailnet = the "Tailscale" adapter    |
| update check + pkexec install              | GitHub check only (counts releases with a `.exe`)      |
| Docker, Tailscale, Jellyfin, library, default browser (`guard.py`) | **Linux only**: hidden on Windows |

Data: `%APPDATA%\hog-browser\` (wallet UI profile in `electron\`, chain data
in `opfs\`, `mining.json`).

## Build

```
npm ci && npm run build          # repo root: wallet bundles
cd windows && npm ci
node stage.mjs                   # server bundle + UI + node builds -> stage/hog, gen/preload-page.cjs
node --test test/*.test.cjs
npx electron-builder --win nsis --x64 --publish never   # on Windows -> dist/Hog-Setup-<v>-x64.exe
```

`npx electron . --smoke` (or `HOG_SMOKE=1`) runs the self-test in `smoke.cjs`:
chrome bridge, Linux-only pages hidden, hog://bookmarks, a web tab with Hog's
page scripts and navigation rules, solo mining on/off with a stratum reply,
the node tab with SharedArrayBuffer, and (unless `HOG_SMOKE_NODE=0`) a DeFi
testnet sync in the node tab until the stratum server hands out a real job.
CI (`.github/workflows/windows.yml`) builds the installer on `windows-latest`,
installs it silently and runs that self-test against the installed app.

For a dev run next to an installed Hog, give it other ports:
`HOG_PORT=4288 HOG_NODE_PORT=43200 HOG_STRATUM_PORT=3496 HOG_MINING_PORT=3196 HOG_DATA=<tmp> npx electron .`
