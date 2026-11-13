# Warthog mining helper

Solo mine with BzMiner to a Warthog browser node running in an ordinary
browser tab: Brave, Chrome, Edge (Firefox should work but is untested).
It is Hog's solo-mining plumbing without the rest of Hog.

## Why a helper is needed

A web page cannot open a port, so BzMiner has nothing to connect to, and the
stock browser node has no `POST /chain/append` to accept a solved block.
The helper fixes both, on this computer only:

| Listener | Address | What it is |
|---|---|---|
| Node page | `http://127.0.0.1:43180` | The official browser node site (browser-node.netlify.app), served through the helper with Hog's patched node WASM (`node-defi/`, `node-mainnet/`: only `POST /chain/append` added) and Hog's mining relay script. Its peer sockets (`/ws-defi`, `/ws-bridge`) are piped to the public Warthog node sockets. |
| Control page | `http://127.0.0.1:43181` | Payout address, network, on/off, stats, BzMiner command. |
| Stratum | `stratum+tcp://127.0.0.1:3456` | Off until you turn it on. Hog's stratum server (`stratum.mjs`). |

Security: everything binds 127.0.0.1; requests with a non-loopback Host are
refused (DNS rebinding). The relay WebSocket accepts only the node page origin
and a random per-launch token injected into that page. The peer bridge accepts
only the node page origin. The control API needs its own per-launch token and
the control page origin. No keys are handled: the helper only needs a payout
address.

The node page runs on its own origin, so its chain data (browser OPFS) is
separate from browser-node.netlify.app: the first start syncs from scratch
(DeFi testnet: about 2 minutes).

## Use

1. Start the helper: `./warthog-mining-helper.sh` (Linux/macOS), or on
   Windows double-click `Warthog-Mining-Helper.exe` (Node is inside; no
   install). Windows may show a SmartScreen "unknown publisher" prompt: the
   .exe is not code-signed (More info -> Run anyway). A console window stays
   open while it runs; closing it (or **Quit helper**) stops the helper.
   It opens the control page. Windows settings live in
   `%APPDATA%\warthog-mining-helper\`, the unpacked node builds in
   `%LOCALAPPDATA%\warthog-mining-helper\runtime\`.
2. Click **Open DeFi testnet node** (or mainnet) and press **Start node** in
   that tab. Keep the tab open; wait until it is synced.
3. In the control page: paste your address, pick the network, **Save**, **Turn on**.
4. Run the command it shows from your BzMiner v24.0.1 folder, e.g.
   `./bzminer -a warthog -p stratum+tcp://127.0.0.1:3456 -w <address> -r brave-defi`
   (on Windows: `bzminer.exe -a warthog -p stratum+tcp://127.0.0.1:3456 -w <address> -r brave-defi`)
   Don't use `--nvidia` alone: Warthog (Janushash) needs the CPU half too.

### Rigs on your tailnet (opt-in)

Tick **Allow rigs on my tailnet** in the control page to let other computers on
your Tailscale network mine here too. The helper then also listens on this
computer's Tailscale address(es) (100.64.0.0/10, fd7a:115c:a1e0::/48), never
on 0.0.0.0, a LAN or a public address, and drops any connection that is not
loopback or from the tailnet. The page shows the command for the other rig with
this computer's MagicDNS name (and the IP as a fallback), e.g.
`./bzminer -a warthog -p stratum+tcp://<name>.<tailnet>.ts.net:3456 -w <address> -r rig2-defi`
(`bzminer.exe ...` on Windows). Give each rig its own `-r` name; the control
page lists every rig with its shares, blocks and rejects.

### Fewer stale blocks (early next job)

A node in a browser tab takes about half a second to save each block it is
given. Without help BzMiner would keep hashing the old height during that time
and many of its next solutions would come back stale ("block already found").
As in Hog 0.1.38, when BzMiner submits a block the helper sends the next-height
job straight away, built from the solved header, before the tab has saved it.
It only does this when the block holds just the reward and the next target and
reward are certain (not across a retarget or halving). If the tab refuses the
block, that job is taken back; if a block on such a job is refused for another
reason, early jobs turn off until the helper restarts. The control page shows
the count under **Early next jobs**. `--no-optimistic-work` turns it off.

Options: `--page-port`, `--control-port`, `--stratum-port`, `--no-open`, `--no-optimistic-work`.
If Hog's own solo mining is on, it already holds port 3456: turn one off or
pass `--stratum-port`.

## Linux AppImage (Node inside)

`helper/build-appimage.sh` writes `dist/Warthog_Mining_Helper-x86_64.AppImage`
(and a `.sha256`). It bundles the helper as above, then puts the official
Node linux-x64 binary inside (default v22.23.1, `NODE_VERSION=` to change),
checked against nodejs.org's SHASUMS256.txt, and packs it with appimagetool,
fetched the same way as browser-wallet's forwarder AppImage build. Downloads
are cached in `~/.cache/warthog-mining-helper-build/`; nothing is installed.

The AppImage needs no system Node. Double-click it (or run it): it starts the
helper and opens the control page in the default browser. Launching it again
just reopens the control page. Stop it with **Quit helper** on the control
page. The same options work: `./Warthog_Mining_Helper-x86_64.AppImage --stratum-port 3466 --no-open`.
To add it to the app menu, use AppImageLauncher or Gear Lever, or copy the
`.desktop` from `--appimage-extract`.

## Build

`node helper/build.mjs` writes `dist/warthog-mining-helper/` (one bundled
`.mjs`, the two node builds, launchers). Tests: `node --test test/helper.test.mjs`.

Windows `.exe`: `node helper/build-sea.mjs` on Windows writes
`dist/Warthog-Mining-Helper.exe`, a Node single executable application. It
bundles the helper into one CommonJS file (`helper/sea-entry.cjs`), embeds it
and both patched node builds as SEA assets, and injects that into a copy of
the official `node.exe` (nodejs.org zip, checked against SHASUMS256.txt) with
postject run from a cache folder. CI builds it on `windows-latest`
(`.github/workflows/helper-windows.yml`) and runs `helper/smoke-exe.mjs`
against it (control page, embedded node builds, stratum port, quit).
