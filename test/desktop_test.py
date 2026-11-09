import subprocess
import unittest
from pathlib import Path

from guard import PRESETS, Guard, allowed_tailscale_open_url, launch_args


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



if __name__ == "__main__":
    unittest.main()
