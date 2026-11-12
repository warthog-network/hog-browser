import subprocess
import unittest
from pathlib import Path

from guard import (
    HOG_DESKTOP,
    PRESETS,
    Guard,
    allowed_browser_open_url,
    allowed_tailscale_open_url,
    launch_args,
    valid_desktop_id,
)


def info(**host):
    mounts = host.pop("mounts", [])
    return {
        "Name": "/hog-ubuntu",
        "State": {"Running": True, "Status": "running"},
        "Config": {"Image": "ubuntu:24.04"},
        "HostConfig": {
            "Privileged": False,
            "NetworkMode": "bridge",
            "PidMode": "",
            "IpcMode": "private",
            "CapAdd": None,
            "Binds": None,
            "Devices": None,
            **host,
        },
        "Mounts": mounts,
    }


class ImageSaveTest(unittest.TestCase):
    def test_saved_image_is_preferred_for_a_new_container(self):
        guard = Guard("/tmp", docker="docker")

        def missing(args, timeout=8):
            return subprocess.CompletedProcess(args, 1, "", "No such image")

        guard.run = missing
        self.assertEqual(guard.image_for(PRESETS["ubuntu"]), "ubuntu:24.04")

        def present(args, timeout=8):
            return subprocess.CompletedProcess(args, 0, "sha256:abc\n", "")

        guard.run = present
        self.assertEqual(guard.image_for(PRESETS["ubuntu"]), "hog-ubuntu:local")
        args = launch_args(PRESETS["ubuntu"], guard.image_for(PRESETS["ubuntu"]))
        self.assertIn("hog-ubuntu:local", args)
        self.assertNotIn("ubuntu:24.04", args)
        self.assertLess(args.index("hog-ubuntu:local"), args.index("sleep"))

    def test_commit_uses_only_the_local_tag(self):
        guard = Guard("/tmp", docker="docker")
        guard.read_names = lambda: ["hog-ubuntu"]
        guard.inspect = lambda name: (info(), "")
        guard.items = lambda: [{"name": "hog-ubuntu", "state": "running", "image": "ubuntu:24.04", "reason": ""}]
        calls = []

        def run(args, timeout=8):
            calls.append((list(args), timeout))
            return subprocess.CompletedProcess(args, 0, "sha256:abc\n", "")

        guard.run = run
        saved = guard.handle("commit", "hog-ubuntu")
        self.assertTrue(saved["ok"])
        self.assertEqual(calls, [(["commit", "hog-ubuntu", "hog-ubuntu:local"], 300)])
        self.assertEqual(saved["commit"]["image"], "hog-ubuntu:local")
        self.assertEqual(saved["commit"]["error"], "")
        self.assertNotIn("desktop", saved)

        refused = guard.handle("commit", "hog-ubuntu;id")
        self.assertFalse(refused["ok"])
        self.assertIn("plain", refused["error"])
        self.assertNotIn("desktop", refused)

        calls.clear()
        missing = guard.handle("desktop", "hog-ubuntu")
        self.assertFalse(missing["ok"])
        self.assertIn("not available", missing["error"])
        self.assertFalse(any(args and args[0] == "commit" for args, _timeout in calls))



class ExitNodeGuideTest(unittest.TestCase):
    def test_exit_node_guide_card_exists(self):
        html = (Path(__file__).resolve().parents[1] / "public" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="exit-node-guide"', html)
        self.assertIn("Setting up your exit node", html)
        self.assertIn('id="exit-node-admin"', html)
        self.assertIn("hog-tailscale-state", html)
        containers = html.split('id="settings-containers"', 1)[1].split('id="settings-networks"', 1)[0]
        files = html.split('id="settings-files"', 1)[1].split('id="settings-containers"', 1)[0]
        tailscale = html.split('id="settings-tailscale"', 1)[1]
        self.assertNotIn('id="tailscale-up"', containers)
        self.assertNotIn('id="exit-node-guide"', containers)
        self.assertNotIn('id="exit-node-guide"', files)
        self.assertIn('id="tailscale-up"', tailscale)
        self.assertIn('id="exit-node-guide"', tailscale)
        self.assertLess(tailscale.find('id="jellyfin-host"'), tailscale.find('id="tailscale-up"'))
        self.assertLess(tailscale.find('id="jellyfin-host"'), tailscale.find('id="exit-node-guide"'))
        self.assertIn('id="media-library"', files)
        self.assertIn("Open the running tailscale container, press Sign in", tailscale)




class TailscaleOpenInHogTest(unittest.TestCase):
    def test_allowed_tailscale_open_url_is_strict(self):
        good = "https://login.tailscale.com/a/exampletoken123"
        self.assertEqual(allowed_tailscale_open_url(good), good)
        self.assertEqual(
            allowed_tailscale_open_url("https://login.tailscale.com/admin/machines"),
            "https://login.tailscale.com/admin/machines",
        )
        self.assertEqual(allowed_tailscale_open_url("http://login.tailscale.com/a/exampletoken123"), "")
        self.assertEqual(allowed_tailscale_open_url("https://evil.example/a/exampletoken123"), "")
        self.assertEqual(allowed_tailscale_open_url("https://login.tailscale.com.evil/a/example"), "")
        self.assertEqual(allowed_tailscale_open_url("https://user@login.tailscale.com/a/exampletoken"), "")
        self.assertEqual(allowed_tailscale_open_url("https://login.tailscale.com/a/example#frag"), "")
        self.assertEqual(allowed_tailscale_open_url("https://login.tailscale.com:8443/a/exampletoken"), "")
        self.assertEqual(allowed_tailscale_open_url("not a url"), "")

    def test_open_path_prefers_hog_tab_and_blocks_wallet_on_tailscale(self):
        root = Path(__file__).resolve().parents[1]
        hog = (root / "hog").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        self.assertIn("allowed_tailscale_open_url", hog)
        self.assertIn('"event": "popup"', hog)
        self.assertIn("DAPP_PROVIDER_BLOCK_LIST", hog)
        self.assertIn("https://login.tailscale.com/*", hog)
        self.assertIn("DAPP_PROVIDER_BLOCK_LIST,", hog)
        self.assertIn("function openTailscaleUrl", app)
        self.assertIn("createTab();", app)
        self.assertIn("openUrl(allowed);", app)
        self.assertIn("openTailscaleUrl($(\"tailscale-login-link\").dataset.url", app)
        self.assertIn("openTailscaleUrl(\"https://login.tailscale.com/admin/machines\")", app)
        # OAuth provider popups stay inside Hog via the existing NEW_WINDOW_ACTION path.
        self.assertIn("NEW_WINDOW_ACTION", hog)
        self.assertIn('"event": "popup"', hog)



class BrowserOpenUrlTest(unittest.TestCase):
    def test_allowed_browser_open_url_filters_schemes(self):
        self.assertEqual(
            allowed_browser_open_url("https://example.com/path?q=1"),
            "https://example.com/path?q=1",
        )
        self.assertEqual(
            allowed_browser_open_url("http://example.com"),
            "http://example.com",
        )
        self.assertEqual(allowed_browser_open_url("file:///etc/passwd"), "")
        self.assertEqual(allowed_browser_open_url("javascript:alert(1)"), "")
        self.assertEqual(allowed_browser_open_url("data:text/html,hi"), "")
        self.assertEqual(allowed_browser_open_url("about:blank"), "")
        self.assertEqual(allowed_browser_open_url("https://user:pass@example.com/"), "")
        self.assertEqual(allowed_browser_open_url("https://169.254.169.254/"), "")
        self.assertEqual(allowed_browser_open_url("https://metadata.google.internal/"), "")
        self.assertEqual(allowed_browser_open_url("not a url"), "")
        self.assertEqual(allowed_browser_open_url(""), "")

    def test_desktop_file_registers_as_browser(self):
        script = (Path(__file__).resolve().parents[1] / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        hog = (Path(__file__).resolve().parents[1] / "hog").read_text(encoding="utf-8")
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
        self.assertIn("Exec=hog-browser %U", script)
        self.assertIn("MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;", script)
        self.assertIn("StartupWMClass=hog", script)
        self.assertIn("HANDLES_OPEN", hog)
        self.assertIn("def do_open", hog)
        self.assertIn("allowed_browser_open_url", hog)
        self.assertIn("xdg-settings set default-web-browser org.hog.Browser.desktop", readme)



class OpenHandlerTest(unittest.TestCase):
    """Exercise Hog.do_open without importing GTK, which CI does not install."""

    def hog_methods(self, *names):
        import ast

        tree = ast.parse(
            (Path(__file__).resolve().parents[1] / "hog").read_text(encoding="utf-8")
        )
        hog_class = next(
            node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Hog"
        )
        namespace = {"allowed_browser_open_url": allowed_browser_open_url}
        found = []
        for item in hog_class.body:
            if isinstance(item, ast.FunctionDef) and item.name in names:
                module = ast.Module(body=[item], type_ignores=[])
                ast.fix_missing_locations(module)
                exec(compile(module, "hog", "exec"), namespace)
                found.append(item.name)
        self.assertEqual(sorted(found), sorted(names))
        return namespace

    def bind_handler(self, chrome_ready=False, pages=None):
        import inspect
        import types

        methods = self.hog_methods("open_external_url", "flush_pending_urls", "do_open")
        self.assertEqual(
            list(inspect.signature(methods["do_open"]).parameters),
            ["self", "files", "n_files", "hint"],
        )

        class Window:
            def __init__(self):
                self.presented = 0

            def present(self):
                self.presented += 1

        class App:
            def __init__(self):
                self.pages = pages
                self.chrome_ready = chrome_ready
                self.pending_urls = []
                self.window = Window()
                self.ensured = 0
                self.open_external_url = types.MethodType(methods["open_external_url"], self)
                self.flush_pending_urls = types.MethodType(methods["flush_pending_urls"], self)
                self.do_open = types.MethodType(methods["do_open"], self)

            def ensure_window(self):
                self.ensured += 1

        return App()

    def test_do_open_signature_and_launcher_pass_urls_through(self):
        hog = (Path(__file__).resolve().parents[1] / "hog").read_text(encoding="utf-8")
        script = (Path(__file__).resolve().parents[1] / "packaging" / "build-deb.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("flags=Gio.ApplicationFlags.HANDLES_OPEN,", hog)
        self.assertIn("def do_open(self, files, n_files, hint):", hog)
        self.assertNotIn("def do_open(self, files, hint):", hog)
        self.assertIn('exec /opt/hog-browser/hog "$@"', script)

    def test_do_open_queues_until_chrome_is_ready_and_raises_the_window(self):
        class File:
            def __init__(self, uri):
                self._uri = uri

            def get_uri(self):
                return self._uri

        class Broken:
            def get_uri(self):
                raise RuntimeError("no uri")

        class Pages:
            def __init__(self):
                self.events = []

            def tell(self, payload):
                self.events.append(payload)

        app = self.bind_handler()
        files = [
            File("https://example.com/a"),
            File("http://example.com/b"),
            File("javascript:alert(1)"),
            File("file:///etc/passwd"),
            File("https://user:pass@example.com/"),
            Broken(),
        ]
        # PyGObject calls do_open(self, files, n_files, hint).
        app.do_open(files, len(files), "")
        self.assertEqual(app.ensured, 1)
        self.assertEqual(app.window.presented, 1)
        self.assertEqual(
            app.pending_urls,
            ["https://example.com/a", "http://example.com/b"],
        )

        pages = Pages()
        app.pages = pages
        app.chrome_ready = True
        app.flush_pending_urls()
        self.assertEqual(app.pending_urls, [])
        self.assertEqual(
            pages.events,
            [
                {"event": "popup", "url": "https://example.com/a", "isolated": False},
                {"event": "popup", "url": "http://example.com/b", "isolated": False},
            ],
        )

        # A later open, once chrome is ready, goes straight to a new tab.
        app.do_open([File("https://example.com/c")], 1, "")
        self.assertEqual(app.ensured, 2)
        self.assertEqual(app.window.presented, 2)
        self.assertEqual(app.pending_urls, [])
        self.assertEqual(pages.events[-1]["url"], "https://example.com/c")


class DefaultBrowserToggleTest(unittest.TestCase):
    def test_ui_exposes_default_browser_toggle(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        general = html.split('id="settings-general"', 1)[1].split('id="settings-files"', 1)[0]
        files = html.split('id="settings-files"', 1)[1].split('id="settings-containers"', 1)[0]
        self.assertIn('id="default-browser-card"', general)
        self.assertIn('id="default-browser-toggle"', general)
        self.assertIn("Set as default browser", general)
        self.assertNotIn('id="default-browser-card"', files)
        self.assertNotIn('id="jellyfin-host"', general)
        self.assertIn("function paintDefaultBrowser", app)
        self.assertIn("containers:browser-default-set", app)
        self.assertIn("containers:browser-default-clear", app)
        self.assertIn("containers:browser-default", app)
        self.assertIn("browser-default-set", hog)
        self.assertIn("browser-default-clear", hog)
        self.assertIn("Set as default browser", readme)
        self.assertIn("Settings → General", readme)

    def test_valid_desktop_id_is_strict(self):
        self.assertTrue(valid_desktop_id("brave-browser-beta.desktop"))
        self.assertTrue(valid_desktop_id(HOG_DESKTOP))
        self.assertFalse(valid_desktop_id("../evil.desktop"))
        self.assertFalse(valid_desktop_id("evil;rm.desktop"))
        self.assertFalse(valid_desktop_id("evil desktop.desktop"))
        self.assertFalse(valid_desktop_id("nope"))
        self.assertFalse(valid_desktop_id(""))

    def test_browser_default_set_saves_previous_and_uses_fixed_argv(self):
        import subprocess
        import tempfile
        import guard as guard_mod

        guard = Guard(tempfile.mkdtemp())
        calls = []

        def run_argv(args, timeout=8):
            calls.append(list(args))
            if args[:3] == ["xdg-settings", "get", "default-web-browser"]:
                return subprocess.CompletedProcess(args, 0, "brave-browser-beta.desktop\n", "")
            if args[:3] == ["xdg-settings", "set", "default-web-browser"]:
                self.assertEqual(args[3], HOG_DESKTOP)
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[:2] == ["xdg-mime", "default"]:
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "no")

        guard.run_argv = run_argv
        original = guard_mod.hog_desktop_installed
        guard_mod.hog_desktop_installed = lambda: True
        try:
            payload = guard.handle("browser-default-set")
        finally:
            guard_mod.hog_desktop_installed = original
        self.assertTrue(payload["ok"])
        self.assertEqual(guard.read_previous_default(), "brave-browser-beta.desktop")
        self.assertIn(["xdg-settings", "set", "default-web-browser", HOG_DESKTOP], calls)
        self.assertIn(
            ["xdg-mime", "default", HOG_DESKTOP, "x-scheme-handler/http"],
            calls,
        )
        self.assertIn(
            ["xdg-mime", "default", HOG_DESKTOP, "x-scheme-handler/https"],
            calls,
        )

    def test_browser_default_clear_restores_saved_browser(self):
        import subprocess
        import tempfile
        import guard as guard_mod

        guard = Guard(tempfile.mkdtemp())
        guard.write_previous_default("brave-browser-beta.desktop")
        calls = []

        def run_argv(args, timeout=8):
            calls.append(list(args))
            if args[:3] == ["xdg-settings", "get", "default-web-browser"]:
                return subprocess.CompletedProcess(args, 0, f"{HOG_DESKTOP}\n", "")
            if args[:3] == ["xdg-settings", "set", "default-web-browser"]:
                self.assertEqual(args[3], "brave-browser-beta.desktop")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[:2] == ["xdg-mime", "default"]:
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "no")

        guard.run_argv = run_argv
        original = guard_mod.hog_desktop_installed
        guard_mod.hog_desktop_installed = lambda: True
        try:
            payload = guard.handle("browser-default-clear")
        finally:
            guard_mod.hog_desktop_installed = original
        self.assertTrue(payload["ok"])
        self.assertIn("brave-browser-beta", payload["notice"])
        self.assertIn(
            ["xdg-settings", "set", "default-web-browser", "brave-browser-beta.desktop"],
            calls,
        )

    def test_browser_default_set_requires_desktop_file(self):
        import subprocess
        import tempfile
        import guard as guard_mod

        guard = Guard(tempfile.mkdtemp())
        calls = []
        guard.run_argv = lambda args, timeout=8: calls.append(list(args)) or subprocess.CompletedProcess(args, 0, "", "")
        original = guard_mod.hog_desktop_installed
        guard_mod.hog_desktop_installed = lambda: False
        try:
            payload = guard.handle("browser-default-set")
        finally:
            guard_mod.hog_desktop_installed = original
        self.assertFalse(payload["ok"])
        self.assertIn(".deb", payload["error"])
        self.assertFalse(any(args[:3] == ["xdg-settings", "set", "default-web-browser"] for args in calls))



class JellyfinGpuToggleTest(unittest.TestCase):
    def test_ui_exposes_jellyfin_gpu_toggle(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        docker = html.split('id="settings-containers"', 1)[1].split('id="settings-networks"', 1)[0]
        self.assertIn('id="jellyfin-gpu-card"', docker)
        self.assertIn('id="jellyfin-gpu-toggle"', docker)
        self.assertIn("GPU acceleration (NVIDIA)", docker)
        self.assertIn('id="jellyfin-gpu-checks"', docker)
        self.assertLess(docker.find('data-launch="jellyfin"'), docker.find('id="jellyfin-gpu-card"'))
        self.assertIn("function paintJellyfinGpu", app)
        self.assertIn("containers:jellyfin-gpu-set", app)
        self.assertIn("containers:jellyfin-gpu-clear", app)
        self.assertIn("containers:jellyfin-gpu-install", app)
        self.assertIn("Copy commands", app)
        self.assertIn("Install NVIDIA toolkit", docker)
        self.assertIn("Install NVIDIA toolkit", app)
        self.assertIn('id="jellyfin-gpu-install"', docker)
        self.assertIn("jellyfin-gpu-set", hog)
        self.assertIn("jellyfin-gpu-clear", hog)
        self.assertIn("jellyfin-gpu-install", hog)
        self.assertIn("GPU acceleration (NVIDIA)", readme)
        self.assertIn("NVIDIA NVENC", readme)
        self.assertIn("do not carry over", readme.lower())
        self.assertIn("host.docker.internal", readme)
        self.assertIn("Install NVIDIA toolkit", readme)
        self.assertIn("pkexec", readme)
        script = (root / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn("${APP}/libexec/hog-nvidia-toolkit-install", script)
        self.assertIn("org.hog.Browser.nvidia-toolkit-install.policy", script)







class DockerRuntimeUiTest(unittest.TestCase):
    def test_ui_exposes_runtime_and_network_controls(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        docker = html.split('id="settings-containers"', 1)[1].split('id="settings-ai"', 1)[0]
        networks = html.split('id="settings-networks"', 1)[1].split('id="settings-ai"', 1)[0]
        self.assertIn('id="container-runtime-card"', docker)
        self.assertIn('id="runtime-engine"', docker)
        self.assertIn('id="runtime-desktop"', docker)
        self.assertIn('id="docker-networks-card"', networks)
        self.assertIn('id="network-list"', networks)
        self.assertIn('id="network-create"', networks)
        self.assertIn("macvlan", docker)
        self.assertIn("ipvlan", docker)
        self.assertLess(docker.find('id="container-runtime-card"'), docker.find('id="container-list"'))
        self.assertIn('id="container-list"', docker)
        self.assertTrue(html.find('id="container-list"') < html.find('id="docker-networks-card"'))
        self.assertIn("containers:runtime-set", app)
        self.assertIn("containers:network-list", app)
        self.assertIn("containers:network-create", app)
        self.assertIn("containers:network-remove", app)
        self.assertIn("containers:network-connect", app)
        self.assertIn("containers:network-disconnect", app)
        self.assertIn("runtime-set", hog)
        self.assertIn("network-create", hog)
        self.assertIn("network-remove", hog)
        self.assertIn("Docker Engine or Docker Desktop", readme)
        self.assertIn("127.0.0.1:8096", readme)
        self.assertIn("host.docker.internal", readme)
        self.assertIn("Networks", readme)
        self.assertIn("direct", readme.lower())



class SelfUpdateUiTest(unittest.TestCase):
    def test_ui_exposes_update_controls(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        files = html.split('id="settings-general"', 1)[1].split('id="settings-files"', 1)[0]
        self.assertIn('id="hog-update-card"', files)
        self.assertIn('id="hog-update-check"', files)
        self.assertIn("Check for updates", files)
        self.assertIn('id="hog-update-install"', files)
        self.assertIn(">Update<", files)
        self.assertIn('id="hog-update-restart"', files)
        self.assertIn("Restart hog", files)
        self.assertLess(files.find('id="hog-update-card"'), files.find('id="default-browser-card"'))
        self.assertIn('id="hog-update-menu-badge"', html)
        self.assertIn("function paintUpdate", app)
        self.assertIn("window.__hogUpdate = paintUpdate", app)
        self.assertIn("containers:update-check-now", app)
        self.assertIn("containers:update-install", app)
        self.assertIn("containers:update-restart", app)
        self.assertIn("containers:update-status", app)
        self.assertIn("manualCommand", app)
        self.assertIn("hog-update-command", app)
        self.assertIn("sudo apt install ./", readme)
        self.assertIn("update-status", hog)
        self.assertIn("update-check-now", hog)
        self.assertIn("update-install", hog)
        self.assertIn("update-restart", hog)
        self.assertIn("start_update_check", hog)
        self.assertIn("restart_hog", hog)
        self.assertIn("/usr/bin/hog-browser", hog)
        self.assertIn("window.__hogUpdate", hog)
        self.assertIn("Update Hog from the app", readme)
        self.assertIn("0.1.11", readme)
        self.assertIn("sudo apt install ./hog-browser_0.1.11_amd64.deb", readme)
        self.assertIn("/opt/hog-browser/libexec/hog-self-update", readme)
        self.assertIn("SHA256SUMS", readme)
        script = (root / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn("${APP}/libexec/hog-self-update", script)
        self.assertIn("org.hog.Browser.self-update.policy", script)
        workflow = (root / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertIn("SHA256SUMS", workflow)



class SettingsUiTest(unittest.TestCase):
    def test_solo_mining_pane_has_address_stats_and_stratum_command(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        for el in ("mining-toggle", "mining-address", "mining-address-save", "mining-command",
                   "mining-command-copy", "mining-stat-blocks", "mining-stat-height", "mining-open-node"):
            self.assertIn(f'id="{el}"', html)
        self.assertIn("stratum+tcp://127.0.0.1:3456", html)
        self.assertIn("postMining({ address: value })", app)
        for value in ("auto", "mainnet", "defi"):
            self.assertIn(f'name="mining-network" value="{value}"', html)
        self.assertIn('id="mining-open-mainnet"', html)
        self.assertIn('id="mining-stat-network"', html)
        for el in ("mining-tailnet-allow", "mining-remote-command", "mining-remote-command-windows", "mining-remote-copy", "mining-workers"):
            self.assertIn(f'id="{el}"', html)
        self.assertIn("Allow rigs on my tailnet", html)
        self.assertIn("postMining({ network: radio.value })", app)
        deb = (root / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn('"${HB}/stratum.mjs"', deb)
        self.assertIn('"${HB}/tailnet.mjs"', deb)
        self.assertIn('cp -a "${HB}/node-defi" "${APP}/"', deb)
        self.assertIn('cp -a "${HB}/node-mainnet" "${APP}/"', deb)

    def test_settings_nav_has_no_ai_page(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        css = (root / "public" / "app.css").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        self.assertIn('id="settings-nav"', html)
        for page in ("general", "files", "containers", "networks", "tailscale", "mining"):
            self.assertIn(f'data-settings="{page}"', html)
            self.assertIn(f'id="settings-{page}"', html)
        self.assertNotIn('data-settings="ai"', html)
        self.assertNotIn('id="settings-ai"', html)
        self.assertIn('const SETTINGS_SECTIONS = ["general", "files", "containers", "networks", "tailscale", "mining"];', app)
        # Old links to the AI page land on Containers instead of a blank pane.
        self.assertIn('return SETTINGS_SECTIONS.includes(page) ? page : "containers";', app)
        self.assertLess(html.find('id="hog-update-card"'), html.find('id="settings-files"'))
        self.assertNotIn('id="hog-update-card"', html.split('id="settings-files"', 1)[1].split('id="settings-containers"', 1)[0])
        for text in (html, app, css, hog):
            for word in ("ollama", "open-webui", "aider", "ai-code", "ai-editor", "ai-pull", "continue.continue", "visualstudio"):
                self.assertNotIn(word, text.lower(), word)
        self.assertNotIn("hog-ai", app)
        self.assertNotIn("hog-ai", hog)
        self.assertIn("function showToast", app)
        self.assertIn("restoreAccordions", app)
        self.assertIn("function pruneAccordions", app)
        self.assertIn('id.startsWith("ai-")', app)
        self.assertIn("kebab", app)
        self.assertIn("progress=emit", hog)
        self.assertIn('id="container-images" open', html)
        self.assertIn('id="hog-toasts"', html)
        self.assertIn('id="image-pull-bar"', html)
        images = html.split('id="container-images"', 1)[1].split('id="container-runtime-card"', 1)[0]
        self.assertIn('data-launch="jellyfin"', images)
        self.assertIn('data-launch="tailscale"', images)
        toolbox = html.split('class="toolbox"', 1)[1].split("</div>", 2)[0]
        self.assertNotIn("AI", toolbox)
        self.assertIn("## Container links", readme)
        self.assertNotIn("## Local AI box", readme)

    def test_container_links_are_wired(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        css = (root / "public" / "app.css").read_text(encoding="utf-8")
        tailscale = html.split('id="settings-tailscale"', 1)[1]
        self.assertIn('id="jellyfin-links" class="service-links" hidden', tailscale)
        for name in ("function serviceLinkUrl", "function serviceLinksFor", "function renderServiceLinks", "function paintJellyfinLinks", "function openServiceLink", "function copyServiceLink"):
            self.assertIn(name, app)
        self.assertIn("paintJellyfinLinks(payload.items)", app)
        self.assertIn("renderServiceLinks(links, item.name)", app)
        opener = app.split("function openServiceLink", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("createTab()", opener)
        self.assertIn("openUrl(url)", opener)
        for selector in (".service-links", ".service-link-row", ".service-link ", ".service-link-copy", ".pill.is-lan"):
            self.assertIn(selector, css)


if __name__ == "__main__":
    unittest.main()
