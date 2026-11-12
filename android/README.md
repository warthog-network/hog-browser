# Hog phone app (Android)

A small companion app for hog over Tailscale: container status and
start/stop/restart, Jellyfin, mining stats (read-only) and Files.

- Kotlin + one WebView. The UI is bundled in `app/src/main/assets/web/`
  (plain HTML/CSS/JS, no build step) and served from
  `https://appassets.androidplatform.net/assets/web/`.
- GET requests from the UI to `/hog/<route>` are forwarded by the app to
  hog's phone API (`http://<hog>.ts.net:4189/m/v1/<route>`) with the device
  token. Changes, pairing, QR scan, uploads, downloads and sharing go through
  the `HogNative` JavaScript bridge. The page never sees the token.
- The token is encrypted with an Android Keystore AES-GCM key
  (`TokenStore.kt`). Backups exclude it.
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
