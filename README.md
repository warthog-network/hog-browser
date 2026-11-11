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


## Docker Engine or Docker Desktop

Each container in Hog can run on **Docker Engine** (native docker-ce, `/var/run/docker.sock`) or **Docker Desktop** (the LinuxKit VM). **Settings → Containers** has a compact Engine/Desktop control, and each container in the list shows which runtime it is on. Open the ⋯ menu on a container to start, stop, restart, move, or remove it. Moving a container stops and removes it on the old runtime, then starts it on the new one. Login, libraries, and other files kept in that runtime's Docker volumes do not carry over. Hog does not move an existing container until you click.

If Docker Engine's socket is missing or this user cannot use it, the Engine button is disabled and the reason is shown. If Docker Desktop's socket is missing, the Desktop button is disabled.

On Linux, new Tailscale installs default to Docker Engine when it is available. Engine Tailscale uses `--network host`, `/dev/net/tun`, and `NET_ADMIN`/`NET_RAW`, with `TS_USERSPACE=false` and a persistent `hog-tailscale-state` volume, so it can usually open a direct connection to your phone instead of a DERP relay. It publishes Jellyfin at `127.0.0.1:8096`. Tailscale that stays on Docker Desktop still uses the `hog-tailscale` network and `host.docker.internal:8096`, because `127.0.0.1` inside Desktop is the VM, not this computer. After you move Tailscale to Engine, sign in again, delete the old `hog` or `hog-1` machine in the Tailscale admin console, and approve the new one as an exit node. Confirm a direct path with `docker exec tailscale tailscale status` — peers should say `direct`, not `relay`.

**Settings → Networks** has a **Networks** card. Rows expand for subnet and attached containers, and the create and attach forms stay in dropdowns. It lists networks for the selected runtime (name, driver, subnet, attached containers), creates a bridge, macvlan, or ipvlan network, deletes unused user-defined networks, and can connect or disconnect a Hog-managed container. Built-in networks (`bridge`, `host`, `none`) and networks that still have containers cannot be deleted. A container that already uses the host network, such as Engine Tailscale, cannot join another network.


## Local AI box

**Settings → AI** (also on the home Toolbox) runs a local chat stack on Docker Engine:

1. Press **Run Ollama**. Hog creates the `hog-ai` network if needed, starts `hog-ollama` with the `hog-ollama` volume at `/root/.ollama`, and uses `--gpus all` when the NVIDIA toolkit is ready. If no GPU is available, Ollama runs on the CPU and the page says so. Its API is published only on `127.0.0.1`, never on `0.0.0.0`. Ollama and Open WebUI are listed at the top of **Settings → Containers → Images** and as placeholders in the Containers list until you create them. They are the apps; the model library is separate.
2. Press **Run Open WebUI**. That starts `hog-open-webui` on the same network with `OLLAMA_BASE_URL=http://hog-ollama:11434`, a `hog-open-webui` volume, and a port bound only to `127.0.0.1`. If Tailscale is signed in, Hog serves that port to your tailnet (HTTPS, no funnel).
3. Pull a model from the library. The 9–10 GB group (`qwen2.5:14b`, `qwen2.5-coder:14b`, `deepseek-r1:14b`, `phi4:14b`) is a good fit for 12 GB of video memory. Smaller options include `gemma2:9b`, `llama3.1:8b`, `qwen2.5:7b`, and `mistral`. A collapsed **Larger (partly CPU, slow)** group lists `gemma2:27b`, `qwen2.5:32b`, and `deepseek-r1:32b`. Each row shows a short description, approximate download size, a VRAM fit badge, whether it is already installed, and a one-click **Pull**. You can also type another validated name, or open [ollama.com/library](https://ollama.com/library) in a Hog tab.
4. The first account you create in Open WebUI becomes the admin.
5. The **Code editor** card sets up the [Continue](https://www.continue.dev/) extension for Visual Studio Code (or VSCodium) so it talks to local Ollama. Hog looks for `code`, `codium`, or a Flatpak VS Code install and whether Continue is already present. **Install Continue** runs `code --install-extension Continue.continue` at your user account, or opens the Continue marketplace link if that command cannot run; it never uses `sudo`. If no editor is found, the card links to [code.visualstudio.com](https://code.visualstudio.com/) and does nothing else. **Connect to Ollama** writes `~/.continue/config.yaml` for `qwen2.5-coder:14b` (chat and edit), `qwen2.5-coder:1.5b` (autocomplete), and `nomic-embed-text` (embeddings), all at `http://127.0.0.1:11434`. If that file already exists, Hog saves a `config.yaml.hog-backup-…` copy first. **Pull missing models** uses the same model pull flow as the library.
6. The **Code chat** card is a chat page that edits files. Pick a model from the dropdown (it lists the chat models in Ollama, default `qwen2.5-coder:14b`) and a project folder (type a path or press **Browse…** for a folder picker). Hog remembers the last folder and model. **Start** downloads `paulgauthier/aider-full` the first time (a few GB, with progress), then runs [Aider](https://aider.chat/)'s browser mode as `hog-aider` on the hog-ai network: your uid:gid, every capability dropped, `no-new-privileges`, only the project folder mounted at `/app`, the page bound to `127.0.0.1:8501` (or the next free port up to 8504), and `OLLAMA_API_BASE=http://hog-ollama:11434` with the model as `ollama_chat/<model>`. **Open** loads the chat in a new Hog tab, and **Stop** removes the container while your files and commits stay. Aider commits each edit, so use git to undo. If the folder is not a git repo the card warns you and Aider runs `git init` there; pick a repo's top folder rather than a subfolder. Folders must be inside your home folder, not hidden, and not Hog's wallet folder. The page is not shared to your tailnet. 14B local models follow Aider's edit format reasonably but slower and less reliably than large cloud models; keep requests small and add only the files you need.

Models stay in the Ollama volume. Hog estimates whether a model fits the detected GPU memory and warns when disk space is low before a pull. Progress bars cover model pulls and image downloads, and success or failure is shown as a toast.

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
