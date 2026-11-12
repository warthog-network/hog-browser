# Bundled DeFi testnet node (WASM)

Hog serves these two files in place of `https://browser-node.netlify.app/node/defi/wart-node.{js,wasm}`
so the in-tab node can accept solved blocks from a local miner.

- Source: warthog-browser-node commit `17481da` ("DeFi WASM 0.10.38: expose POST /chain/append for local solo mining").
- Core: `f5e4e152` (0.10.38), same as the DeFi testnet nodes, plus one route: `POST /chain/append`.
  `isPublic` stays true, so debug, peer and settings routes stay hidden.
- `wart-node.js` is byte-identical to the live site's DeFi glue; only the `.wasm` differs.
- Set `HOG_DEFI_NODE_DIR=` (empty) to load the live site's files instead, or point it at another build.
