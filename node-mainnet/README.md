# Bundled mainnet node (WASM)

Hog serves these two files in place of `https://browser-node.netlify.app/node/wart-node.{js,wasm}`
(the node site's "Official1", Warthog mainnet) so the in-tab node can accept solved
blocks from a local miner.

- Source: the browser node's patched core 0.9.6 tree (`0eaafc39` plus the browser patches
  listed in warthog-browser-node `public/node/BUILD_INFO.md`), the same tree as the live
  site's mainnet build, plus one change: `POST /chain/append` is registered on the WASM
  endpoint (`RouterHook::hook_solo_mining_append`). `isPublic` stays true, so debug, peer
  and settings routes stay hidden.
- Toolchain: `emscripten/emsdk:3.1.74` (i64 OPFS offsets, multi-GiB chain.db3), 2048 MB heap,
  `--buildtype=release`, built offline (`--network=none`).
- `wart-node.js` is the glue from the same build; its `virtual_post` already uses `getId()`.
- Chain data stays in the node site's own OPFS folder (mainnet at `/opfs`, DeFi testnet at
  `/opfs/defi`), so the two networks never share a database.
- Set `HOG_MAINNET_NODE_DIR=` (empty) to load the live site's files instead.
