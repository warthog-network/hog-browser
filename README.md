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
