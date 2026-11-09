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
        docker = html.split('id="settings-docker"', 1)[1].split('id="settings-files"', 1)[0]
        files = html.split('id="settings-files"', 1)[1]
        self.assertNotIn('id="tailscale-up"', docker)
        self.assertNotIn('id="exit-node-guide"', docker)
        self.assertIn('id="tailscale-up"', files)
        self.assertIn('id="exit-node-guide"', files)
        self.assertLess(files.find('id="jellyfin-host"'), files.find('id="tailscale-up"'))
        self.assertLess(files.find('id="jellyfin-host"'), files.find('id="exit-node-guide"'))
        self.assertLess(files.find('id="exit-node-guide"'), files.find('id="media-library"'))
        self.assertIn("Open the running tailscale container, press Sign in", files)




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



class DefaultBrowserToggleTest(unittest.TestCase):
    def test_ui_exposes_default_browser_toggle(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        files = html.split('id="settings-files"', 1)[1]
        self.assertIn('id="default-browser-card"', files)
        self.assertIn('id="default-browser-toggle"', files)
        self.assertIn("Set as default browser", files)
        self.assertLess(files.find('id="default-browser-card"'), files.find('id="jellyfin-host"'))
        self.assertIn("function paintDefaultBrowser", app)
        self.assertIn("containers:browser-default-set", app)
        self.assertIn("containers:browser-default-clear", app)
        self.assertIn("containers:browser-default", app)
        self.assertIn("browser-default-set", hog)
        self.assertIn("browser-default-clear", hog)
        self.assertIn("Set as default browser", readme)
        self.assertIn("File manager", readme)

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
        docker = html.split('id="settings-docker"', 1)[1].split('id="settings-files"', 1)[0]
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






class SelfUpdateUiTest(unittest.TestCase):
    def test_ui_exposes_update_controls(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "public" / "index.html").read_text(encoding="utf-8")
        app = (root / "public" / "app.js").read_text(encoding="utf-8")
        hog = (root / "hog").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        files = html.split('id="settings-files"', 1)[1]
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


if __name__ == "__main__":
    unittest.main()
