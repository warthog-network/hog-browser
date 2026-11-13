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

After 0.1.11 is installed, **Settings → General** has an **Updates** card that shows the current version and a **Check for updates** button. Hog also checks the latest GitHub release once a day when it starts (quietly, in the background) and puts a small **Update available** mark on the Settings gear when a newer version exists.

**Update** downloads `hog-browser_<version>_amd64.deb` into a private folder (`~/.local/share/hog-browser/updates`, mode 0700). Hog checks that the file name and `dpkg-deb` metadata are a `hog-browser` amd64 build of that version, then verifies the SHA-256 digest from the GitHub release asset (`digest: sha256:…`). If the API does not include a digest, Hog uses the `SHA256SUMS` file published with the release. It will not install a package that has neither. Installation uses the packaged helper `/opt/hog-browser/libexec/hog-self-update` through `pkexec`, so Ubuntu can ask for your password in a system prompt. Hog never stores or types that password. The helper only accepts a regular file from that updates folder, copies it to a root-owned directory, checks that the package is exactly `hog-browser` and newer than the installed version, and runs `apt-get install`. After it finishes, press **Restart hog**.

This updater ships in 0.1.11. To go from 0.1.10 or earlier, install 0.1.11 once by hand:

```bash
sudo apt install ./hog-browser_0.1.11_amd64.deb
```

Later versions can then be installed with the in-app **Update** button.

If you are running Hog from source, or the helper or `pkexec` is missing, the **Update** button is hidden and the card shows the [release page](https://github.com/warthog-network/hog-browser/releases/latest) and `sudo apt install ./hog-browser_<version>_amd64.deb`.

## Set Hog as your default browser

After installing the `.deb`, open **Settings → General** in Hog and turn on **Set as default browser**. That saves your previous default and points http(s) links at Hog. Turn it off to restore the previous browser (or the next installed http handler if none was saved).

You can still do it from a terminal:

```bash
xdg-settings set default-web-browser org.hog.Browser.desktop
```

Or use **Settings → Default Apps** (sometimes labeled Default Applications) and choose **Hog Browser** for Web. Hog only accepts `http` and `https` URLs from the desktop; `file:`, `javascript:`, and other schemes are ignored. Opening a link while Hog is already running sends it to that window as a new tab.


## Bookmarks and favorites

Press **Ctrl+D** (or click ☆) to bookmark the page you are on. A row under the
toolbar lets you pin it to Favorites, pick a folder, edit it, or remove it.

**Ctrl+Shift+O**, the ▤ button, the Bookmarks entry in the ⚙ menu, or typing
`hog://bookmarks` opens the bookmarks page. It has folders (drag a bookmark
onto a folder to move it), a filter box, sorting, add/edit/delete with undo,
and a ⋯ menu to import or export a Netscape HTML bookmarks file (the format
Brave, Chrome, and Firefox use).

Favorites are bookmarks with a star. They show as tiles on the new tab page
(drag or use the arrows to reorder) and as chips in the toolbar. Site icons
come through Hog's own server; sites without one get a letter tile.

Upgrading from 0.1.20 or older turns the old toolbar list into Favorites,
drops only exact duplicates, and keeps a copy of the old list in
`~/.local/share/hog-browser/bookmarks-v1-backup.json`.

## Files (hog://files) and the tailnet network drive

Type `hog://files` in the address bar, or pick Settings → Files. It is a file explorer for `~/hog-shares` (and any extra folders you add in Settings → Files → Files folders): list and grid views with thumbnails, sort, filter and subfolder search, multi-select, drag and drop (drop files from your desktop to upload them, drag items onto folders to move them, hold Ctrl to copy), cut/copy/paste, rename (F2), new folder (Ctrl+Shift+N), a details panel (Ctrl+I), previews for images, video, audio and text, and Delete sends things to a Trash with Restore. Big uploads go up in 8 MB chunks and resume after a dropped connection.

The file API only answers Hog's own page on 127.0.0.1, every path is checked against the folder's real path (no `..`, no absolute paths, no symlinks that lead outside), and files are served with a sandbox CSP so a shared HTML file cannot run in Hog.

**Network drive (Samba), off by default.** Settings → Tailscale → Network drive. Pick a user name and password, press Save sign-in, then Download and turn on. Hog runs `dockurr/samba` on Docker Engine and publishes port 445 only on hog's Tailscale address and 127.0.0.1, never on your LAN. It needs the tailscale container running on Docker Engine (Docker Desktop runs containers in a VM, so its ports cannot reach the tailnet address). Then connect with:

- Phone (iOS Files → Connect to Server, or an Android SMB file manager) or macOS/Linux: `smb://hog.<your-tailnet>.ts.net/hog-shares`
- Windows: `\\hog\hog-shares` (or `\\100.x.y.z\hog-shares`)

The password is kept in `~/.local/share/hog-samba/pass` (mode 600) and mounted into the container as a secret; it is never put in the command line or the container environment.

## Docker Engine or Docker Desktop

Each container in Hog can run on **Docker Engine** (native docker-ce, `/var/run/docker.sock`) or **Docker Desktop** (the LinuxKit VM). **Settings → Containers** has a compact Engine/Desktop control, and each container in the list shows which runtime it is on. Open the ⋯ menu on a container to start, stop, restart, move, or remove it. Moving a container stops and removes it on the old runtime, then starts it on the new one. Login, libraries, and other files kept in that runtime's Docker volumes do not carry over. Hog does not move an existing container until you click.

If Docker Engine's socket is missing or this user cannot use it, the Engine button is disabled and the reason is shown. If Docker Desktop's socket is missing, the Desktop button is disabled.

On Linux, new Tailscale installs default to Docker Engine when it is available. Engine Tailscale uses `--network host`, `/dev/net/tun`, and `NET_ADMIN`/`NET_RAW`, with `TS_USERSPACE=false` and a persistent `hog-tailscale-state` volume, so it can usually open a direct connection to your phone instead of a DERP relay. It publishes Jellyfin at `127.0.0.1:8096`. Tailscale that stays on Docker Desktop still uses the `hog-tailscale` network and `host.docker.internal:8096`, because `127.0.0.1` inside Desktop is the VM, not this computer. After you move Tailscale to Engine, sign in again, delete the old `hog` or `hog-1` machine in the Tailscale admin console, and approve the new one as an exit node. Confirm a direct path with `docker exec tailscale tailscale status` — peers should say `direct`, not `relay`.

**Settings → Networks** has a **Networks** card. Rows expand for subnet and attached containers, and the create and attach forms stay in dropdowns. It lists networks for the selected runtime (name, driver, subnet, attached containers), creates a bridge, macvlan, or ipvlan network, deletes unused user-defined networks, and can connect or disconnect a Hog-managed container. Built-in networks (`bridge`, `host`, `none`) and networks that still have containers cannot be deleted. A container that already uses the host network, such as Engine Tailscale, cannot join another network.


## Container links

Every running container with a published TCP port shows its addresses under its row in **Settings → Containers**, and Jellyfin's also appear on the Tailscale page:

- **This computer**: `http://127.0.0.1:<port>`.
- **Home network**: `http://<LAN IP>:<port>`, only when the port is published on all interfaces (Hog's own presets bind to `127.0.0.1`, so they skip this).
- **Tailnet** and **Tailnet IP**: read from the running Tailscale container's status and `tailscale serve` config, for example `http://hog.<tailnet>.ts.net:8096` and `http://100.x.y.z:8096` for Jellyfin. HTTPS serve entries show the `https://` name.

Click an address to open it in a new Hog tab, or press **Copy**. Ports that are not web pages (SSH, databases, WireGuard) get no link.

Earlier versions had an AI page (Ollama, Open WebUI, Continue, and an Aider Code chat). It was removed in 0.1.20. Hog leaves any `hog-ollama`, `hog-open-webui`, or `hog-aider` containers, their images and volumes, and `~/.continue` alone; remove them from the container ⋯ menu or with `docker rm` and `docker volume rm` if you no longer want them.

## Jellyfin on your home network (TVs without Tailscale)

Roku and some other TVs cannot run Tailscale. **Settings → Containers → Jellyfin → Home network access** (off by default) makes Hog forward this computer's private home-network IPv4 addresses (10/8, 172.16/12 or 192.168/16 on Wi-Fi or Ethernet) on port 8096 to Jellyfin at `127.0.0.1:8096`. The container is not recreated. Hog never listens on `0.0.0.0`, a Docker bridge, a VPN or Tailscale address, and it drops connections from non-private addresses, so a router port forward cannot put Jellyfin on the internet through it. The card shows the address to type into the TV's Jellyfin app, for example `http://192.168.1.50:8096`. Reserve that IP in your router so it stays the same. Hog re-checks the addresses every 15 seconds and remembers the setting across restarts.

If Ubuntu's ufw firewall is on, the card offers **Allow through firewall**. It runs `pkexec /usr/sbin/ufw allow in on <interface> from <home subnet> to any port 8096 proto tcp comment 'Jellyfin on home network (Hog)'`, with the interface and subnet taken from the detected home network. Ubuntu's own polkit dialog asks for your password, and Hog never sees it. Cancelling changes nothing. Hog remembers the rules it added. When home network access is off, the card offers **Remove firewall rule** (`ufw delete allow …`), and it removes nothing unless you click. The same commands are always shown for a terminal, and only those are shown if pkexec is missing. Hog never changes the firewall on its own.

## Jellyfin GPU acceleration (NVIDIA)

Docker Desktop on Linux runs containers inside a small virtual machine, so it cannot pass through an NVIDIA GPU. Hog can instead run Jellyfin on native Docker Engine (`/var/run/docker.sock`, docker-ce) with `--gpus all`. GPU acceleration requires Docker Engine and turns that runtime on for Jellyfin. Turning the GPU off leaves Jellyfin on Engine without the GPU; use the runtime control if you want it back on Docker Desktop. Tailscale can run on either runtime. If Tailscale is on Docker Engine it reaches Jellyfin at `127.0.0.1:8096`; on Docker Desktop it still uses `host.docker.internal:8096`.

On **Settings → Containers**, the **GPU acceleration (NVIDIA)** card checks three things and shows copyable install commands when something is missing:

1. An NVIDIA GPU and driver (`nvidia-smi` works).
2. Native Docker Engine, separate from Docker Desktop, with this user in the `docker` group.
3. The NVIDIA Container Toolkit, configured for that engine (`nvidia-ctk runtime configure --runtime=docker` and a restart of `docker.service`).

If check 3 is missing and you installed the hog-browser `.deb`, press **Install NVIDIA toolkit**. That runs a packaged root helper at `/opt/hog-browser/libexec/hog-nvidia-toolkit-install` through `pkexec`, so Ubuntu can ask for your password in a system prompt. Hog never stores or types that password, and the helper takes no arguments. It installs the toolkit, configures Docker Engine, and restarts `docker.service` only — Docker Desktop is not changed. The same helper is safe to run more than once. If you are running Hog from source, or `pkexec` is missing, the button is hidden and you can copy the commands instead. Installing Docker Engine itself still uses those copyable commands.

When all three are ready, turn the toggle on to recreate Jellyfin on Docker Engine. Named volumes `hog-jellyfin-config` and `hog-jellyfin-cache` hold that engine's login and libraries. Docker Desktop volumes do not carry over. `~/hog-shares` is still mounted at `/media`. After it starts, in Jellyfin go to **Dashboard → Playback → Transcoding** and pick **NVIDIA NVENC**. Turn the toggle off to keep Jellyfin on Docker Engine without the GPU. Use the runtime control to move it back to Docker Desktop and reuse the Desktop volumes if they were kept.

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
