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

1. Start the helper: `./warthog-mining-helper.sh` (Linux/macOS) or
   double-click `Warthog-Mining-Helper.cmd` (Windows). Needs Node.js 18+.
   It opens the control page.
2. Click **Open DeFi testnet node** (or mainnet) and press **Start node** in
   that tab. Keep the tab open; wait until it is synced.
3. In the control page: paste your address, pick the network, **Save**, **Turn on**.
4. Run the command it shows from your BzMiner v24.0.1 folder, e.g.
   `./bzminer -a warthog -p stratum+tcp://127.0.0.1:3456 -w <address> -r brave-defi`
   Don't use `--nvidia` alone: Warthog (Janushash) needs the CPU half too.

Options: `--page-port`, `--control-port`, `--stratum-port`, `--no-open`.
If Hog's own solo mining is on, it already holds port 3456: turn one off or
pass `--stratum-port`.

## Build

`node helper/build.mjs` writes `dist/warthog-mining-helper/` (one bundled
`.mjs`, the two node builds, launchers). Tests: `node --test test/helper.test.mjs`.

A Windows single `.exe` can be made with Node's single executable application
support (`node --experimental-sea-config` + `postject`, or `node --build-sea`
on Node 25+) from the bundled file; the node builds stay beside it.
