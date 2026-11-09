# Hog Browser

A small local Ubuntu browser with a Warthog wallet in the sidebar. It is its own GTK window (WebKitGTK), not a Chrome or Firefox tab.

## Install from a release (.deb)

1. Open the [Releases](../../releases) page and download the latest `hog-browser_*_amd64.deb`.
2. Install it:

```bash
sudo apt install ./hog-browser_*.deb
```

`apt` will pull in Python GI, WebKitGTK, and Node.js if they are missing. The package also installs `/etc/sysctl.d/99-hog-tailscale.conf` so Hog can use Tailscale as an IPv6 exit node without dropping this computer's router IPv6 route. Apply it once (or reboot):

```bash
sudo sysctl --system
```

Then confirm the default IPv6 route is still present (`ip -6 route show default`). Start Hog from the app menu (**Hog Browser**) or run:

```bash
hog-browser
```

User data (wallet, cache, shares) stays in `~/.local/share/hog-browser` and is not touched by package upgrades or removals.

## Update Hog from the app

After 0.1.11 is installed, **Settings → File manager** has an **Updates** card that shows the current version and a **Check for updates** button. Hog also checks the latest GitHub release once a day when it starts (quietly, in the background) and puts a small **Update available** mark on the Settings gear when a newer version exists.

**Update** downloads `hog-browser_<version>_amd64.deb` into a private folder (`~/.local/share/hog-browser/updates`, mode 0700). Hog checks that the file name and `dpkg-deb` metadata are a `hog-browser` amd64 build of that version, then verifies the SHA-256 digest from the GitHub release asset (`digest: sha256:…`). If the API does not include a digest, Hog uses the `SHA256SUMS` file published with the release. It will not install a package that has neither. Installation uses the packaged helper `/opt/hog-browser/libexec/hog-self-update` through `pkexec`, so Ubuntu can ask for your password in a system prompt. Hog never stores or types that password. The helper only accepts a regular file from that updates folder, copies it to a root-owned directory, checks that the package is exactly `hog-browser` and newer than the installed version, and runs `apt-get install`. After it finishes, press **Restart hog**.

This updater ships in 0.1.11. To go from 0.1.10 or earlier, install 0.1.11 once by hand:

```bash
sudo apt install ./hog-browser_0.1.11_amd64.deb
```

Later versions can then be installed with the in-app **Update** button.

If you are running Hog from source, or the helper or `pkexec` is missing, the **Update** button is hidden and the card shows the [release page](https://github.com/warthog-network/hog-browser/releases/latest) and `sudo apt install ./hog-browser_<version>_amd64.deb`.

## Set Hog as your default browser

After installing the `.deb`, open **Settings → File manager** in Hog and turn on **Set as default browser**. That saves your previous default and points http(s) links at Hog. Turn it off to restore the previous browser (or the next installed http handler if none was saved).

You can still do it from a terminal:

```bash
xdg-settings set default-web-browser org.hog.Browser.desktop
```

Or use **Settings → Default Apps** (sometimes labeled Default Applications) and choose **Hog Browser** for Web. Hog only accepts `http` and `https` URLs from the desktop; `file:`, `javascript:`, and other schemes are ignored. Opening a link while Hog is already running sends it to that window as a new tab.


## Jellyfin GPU acceleration (NVIDIA)

Docker Desktop on Linux runs containers inside a small virtual machine, so it cannot pass through an NVIDIA GPU. Hog can instead run Jellyfin on native Docker Engine (`/var/run/docker.sock`, docker-ce) with `--gpus all`, while the Tailscale container stays on Docker Desktop and still publishes port 8096 to `host.docker.internal:8096`. That hostname already reaches this computer's loopback, which is how folder shares work today, so Jellyfin bound to `127.0.0.1:8096` on the host stays reachable from the phone.

On the Docker page, the **GPU acceleration (NVIDIA)** card checks three things and shows copyable install commands when something is missing:

1. An NVIDIA GPU and driver (`nvidia-smi` works).
2. Native Docker Engine, separate from Docker Desktop, with this user in the `docker` group.
3. The NVIDIA Container Toolkit, configured for that engine (`nvidia-ctk runtime configure --runtime=docker` and a restart of `docker.service`).

If check 3 is missing and you installed the hog-browser `.deb`, press **Install NVIDIA toolkit**. That runs a packaged root helper at `/opt/hog-browser/libexec/hog-nvidia-toolkit-install` through `pkexec`, so Ubuntu can ask for your password in a system prompt. Hog never stores or types that password, and the helper takes no arguments. It installs the toolkit, configures Docker Engine, and restarts `docker.service` only — Docker Desktop is not changed. The same helper is safe to run more than once. If you are running Hog from source, or `pkexec` is missing, the button is hidden and you can copy the commands instead. Installing Docker Engine itself still uses those copyable commands.

When all three are ready, turn the toggle on to recreate Jellyfin on Docker Engine. Named volumes `hog-jellyfin-config` and `hog-jellyfin-cache` hold that engine's login and libraries. Docker Desktop volumes do not carry over. `~/hog-shares` is still mounted at `/media`. After it starts, in Jellyfin go to **Dashboard → Playback → Transcoding** and pick **NVIDIA NVENC**. Turn the toggle off to return Jellyfin to Docker Desktop (CPU) and reuse the Desktop volumes if they were kept.

## Run from source

Needs Ubuntu packages for the GTK shell, plus Node 18+. `warthog-js` is pulled from GitHub by `npm ci` (pinned in `package.json`).

```bash
sudo apt install python3-gi python3-gi-cairo python3-cairo \
  gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-pango-1.0 nodejs npm
git clone https://github.com/warthog-network/hog-browser.git
cd hog-browser
npm ci
npm run build
./hog
```

If `public/*-bundle.js` are already present you can skip `npm run build` and run `./hog` after `npm ci`.

## Build a .deb locally

```bash
./packaging/build-deb.sh
# writes dist/hog-browser_<version>_<arch>.deb
```

No root is required for the build. Installing the package still needs `sudo apt install ./…`.

## Development

```bash
npm test          # Node tests
python3 -m unittest discover -s test -p '*_test.py'
npm run build     # rebuild public/*-bundle.js via esbuild
```

Pushing to `main` builds the `.deb` on GitHub Actions and publishes a release tagged with the `package.json` version (skipped if that tag already exists).
