# Hog phone app (Android)

A small companion app for hog over Tailscale: container status and
start/stop/restart, Jellyfin, mining stats, start/stop of this computer's
BzMiner (`start_warthog.sh`), and Files. One phone pairs up to 8 computers.
Tap the hog name at the top to switch which computer start and stop talk to.
On Mining, one hog can be marked as the node. Start on the other computers
writes that node's stratum address into the chosen `start_warthog.sh`.
BzMiner 100.81 keeps the address on the live `./bzminer -p` line. Older
launchers such as v100.02b6 use a `POOL="stratum+tcp://..."` line. Start on
the node itself uses `127.0.0.1`.
Hog keeps up to 6 saved start files in `~/.local/share/hog-browser/miner.json`.
Each one has a name and shows its path underneath. The Downloads copy
(`~/Downloads/bzminer_v100.02b6_linux/start_warthog.sh`) is always in the
list. A saved file has to be named `start_warthog.sh`, be executable, and
stay inside the home folder. The phone picks one of those saved files. It
cannot start a different program.
Pairing the same address again keeps one entry on the phone and stores the new token.

- Kotlin + one WebView. The UI is bundled in `app/src/main/assets/web/`
  (plain HTML/CSS/JS, no build step) and served from
  `https://appassets.androidplatform.net/assets/web/`.
- GET requests from the UI to `/hog/<route>` are forwarded by the app to
  hog's phone API (`http://<hog>.ts.net:4189/m/v1/<route>`) with the device
  token. Changes, pairing, QR scan, uploads, downloads and sharing go through
  the `HogNative` JavaScript bridge. The page never sees the token.
- Each hog's token is encrypted with an Android Keystore AES-GCM key
  (`TokenStore.kt`). The phone stores the list and which hog is selected.
  An older single pairing is copied into that list on first open. Backups
  exclude it.
- Plain HTTP is allowed only to `*.ts.net` names
  (`res/xml/network_security_config.xml`); Tailscale's WireGuard tunnel
  encrypts the traffic.
- QR scanning: zxing-android-embedded. A camera app that scans hog's QR
  (`hogpair://pair?...`) also opens the app.

## Build

CI builds a debug-signed APK on every push to `feature/android-companion`
(`.github/workflows/android.yml`) and uploads it as the
`hog-mobile-debug-apk` artifact. Locally: Android SDK 34, JDK 17, Gradle
8.9, then `gradle assembleDebug` in this folder.

## Preview the UI on a desktop

Open `app/src/main/assets/web/index.html` through any static server. Without
the Android bridge it runs a demo with sample data (`?demo=pair` shows the
pairing screen, `?tab=files` opens a tab).
