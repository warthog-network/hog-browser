import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import guard as guard_module
from guard import (
    SAMBA_IMAGE,
    SAMBA_NAME,
    Guard,
    assess,
    samba_binding_problem,
    samba_config,
    samba_password_problem,
    samba_publishes,
    samba_run_args,
    samba_user_problem,
    tailnet_ipv4,
)

SECRET = "correct horse battery"


class SambaPolicyTest(unittest.TestCase):
    def test_user_and_password_rules(self):
        self.assertEqual(samba_user_problem("hog"), "")
        self.assertEqual(samba_user_problem("media_1"), "")
        for bad in ("", "Hog", "1hog", "root", "smb", "a b", "x" * 33, "hog;rm", "../x"):
            self.assertTrue(samba_user_problem(bad), bad)
        self.assertEqual(samba_password_problem("12345678"), "")
        for bad in (None, "", "short", "x" * 129, "line\nbreak", "nul\0x"):
            self.assertTrue(samba_password_problem(bad), repr(bad))

    def test_tailnet_addresses_only(self):
        self.assertEqual(tailnet_ipv4("100.119.132.89"), "100.119.132.89")
        for bad in ("0.0.0.0", "192.168.1.5", "100.63.0.1", "100.128.0.1", "127.0.0.1", "", "100.119.132"):
            self.assertEqual(tailnet_ipv4(bad), "", bad)

    def test_publishes_tailscale_ip_and_loopback_only(self):
        self.assertEqual(
            samba_publishes("100.119.132.89"),
            (("100.119.132.89", "445", "445", "tcp"), ("127.0.0.1", "445", "445", "tcp")),
        )
        for bad in ("0.0.0.0", "", "192.168.0.10", "10.0.0.1"):
            with self.assertRaises(ValueError):
                samba_publishes(bad)

    def test_config(self):
        text = samba_config("hog", "172.17.0.1")
        self.assertIn("[hog-shares]", text)
        self.assertIn("path = /shared", text)
        self.assertIn("valid users = hog", text)
        self.assertIn("force user = hog", text)
        self.assertIn("map to guest = Never", text)
        self.assertIn("guest ok = no", text)
        self.assertIn("server min protocol = SMB2_10", text)
        self.assertIn("hosts allow = 127.0.0.1 100.64.0.0/10 fd7a:115c:a1e0::/48 172.17.0.1", text)
        self.assertIn("hosts deny = ALL", text)
        self.assertIn("wide links = no", text)
        self.assertIn("veto files = /.hog-trash/.hog-upload-*/", text)
        self.assertNotIn("0.0.0.0", text)
        self.assertNotIn("192.168.", text)
        # A bad gateway is dropped rather than written.
        self.assertIn("hosts allow = 127.0.0.1 100.64.0.0/10 fd7a:115c:a1e0::/48\n", samba_config("hog", "nope; x"))
        with self.assertRaises(ValueError):
            samba_config("bad user\n[evil]")

    def test_run_args_keep_password_out(self):
        with tempfile.TemporaryDirectory() as folder:
            args = samba_run_args("hog", "100.119.132.89", Path(folder) / "shares", Path(folder) / "samba", 1000, 1000)
        text = " ".join(args)
        self.assertNotIn("PASS", text)
        publishes = [args[i + 1] for i, token in enumerate(args) if token == "-p"]
        self.assertEqual(publishes, ["100.119.132.89:445:445/tcp", "127.0.0.1:445:445/tcp"])
        self.assertNotIn("--network", args)
        self.assertNotIn("--privileged", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertNotIn("--cap-add=SYS_ADMIN", args)
        image_at = args.index(SAMBA_IMAGE)
        self.assertEqual(args[image_at + 1:], [])
        self.assertIn("--no-healthcheck", args[:image_at])
        volumes = [args[i + 1] for i, token in enumerate(args) if token == "-v"]
        self.assertTrue(any(item.endswith(":/shared") for item in volumes))
        self.assertTrue(any(item.endswith("/smb.conf:/etc/samba/smb.conf:ro") for item in volumes))
        self.assertTrue(any(item.endswith("/pass:/run/secrets/pass:ro") for item in volumes))
        envs = [args[i + 1] for i, token in enumerate(args) if token == "-e"]
        self.assertIn("USER=hog", envs)
        self.assertIn("UID=1000", envs)

    def test_binding_problem(self):
        def info(*ips):
            return {"HostConfig": {"PortBindings": {"445/tcp": [{"HostIp": ip, "HostPort": "445"} for ip in ips]}}}

        self.assertEqual(samba_binding_problem(info("100.119.132.89", "127.0.0.1")), "")
        self.assertTrue(samba_binding_problem(info("0.0.0.0")))
        self.assertTrue(samba_binding_problem(info("")))
        self.assertTrue(samba_binding_problem(info("192.168.1.2")))
        self.assertTrue(samba_binding_problem({}))


class SambaGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.data = base / "data"
        self.samba = base / "samba"
        self.shares = base / "shares"
        self.env = mock.patch.dict(os.environ, {"HOG_SAMBA_DIR": str(self.samba)})
        self.env.start()
        self.roots = mock.patch.object(guard_module, "shares_root", lambda: self.shares)
        self.roots.start()
        self.guard = Guard(self.data, docker="docker")
        self.calls = []
        self.boxes = {}
        self.image_present = False
        self.bind_ip = None
        guard = self.guard

        def inspect_on(name, sock=None):
            info = self.boxes.get(name)
            return (info, "") if info else (None, "No such object")

        def run_on(args, timeout=8, sock=None):
            self.calls.append(list(args))
            if args[:1] == ["run"]:
                publishes = [args[i + 1] for i, token in enumerate(args) if token == "-p"]
                bindings = [{"HostIp": self.bind_ip if self.bind_ip is not None else p.split(":")[0], "HostPort": "445"} for p in publishes]
                self.boxes[SAMBA_NAME] = {
                    "Name": f"/{SAMBA_NAME}",
                    "State": {"Running": True},
                    "Config": {"Image": SAMBA_IMAGE},
                    "HostConfig": {"PortBindings": {"445/tcp": bindings}, "CapAdd": [], "Binds": [args[i + 1] for i, t in enumerate(args) if t == "-v"]},
                    "Mounts": [],
                }
            if args[:2] == ["rm", "-f"] or args[:1] == ["rm"]:
                self.boxes.pop(args[-1], None)
            if args[:2] == ["network", "inspect"]:
                return subprocess.CompletedProcess(args, 0, "172.17.0.1 \n", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        def pull_image(image, sock=None, progress=None):
            self.calls.append(["pull", image])
            self.image_present = True
            return ""

        guard.inspect_on = inspect_on
        guard.run_on = run_on
        guard.run = lambda args, timeout=8: run_on(args, timeout)
        guard.image_exists = lambda image, sock=None: self.image_present
        guard.pull_image = pull_image
        guard.tailscale_dns = lambda: ("hog.tail314642.ts.net", True)
        guard.tailscale_ipv4 = lambda: "100.119.132.89"
        guard.container_runtime = lambda name="": "engine"
        guard.save_runtime = lambda name, side: None
        guard.forget_runtime = lambda name: None

    def tearDown(self):
        self.roots.stop()
        self.env.stop()
        self.temp.cleanup()

    def pulled(self):
        return [call for call in self.calls if call[:1] == ["pull"]]

    def test_status_never_pulls_and_is_off_by_default(self):
        payload = self.guard.handle("samba-status")
        samba = payload["samba"]
        self.assertFalse(samba["enabled"])
        self.assertFalse(samba["running"])
        self.assertFalse(samba["passwordSet"])
        self.assertEqual(samba["share"], "hog-shares")
        self.assertEqual(samba["dns"], "hog.tail314642.ts.net")
        self.assertEqual(self.pulled(), [])
        self.assertFalse(any(call[:1] == ["run"] for call in self.calls))

    def test_save_stores_password_privately_and_never_echoes_it(self):
        payload = self.guard.handle("samba-save", json.dumps({"user": "hog", "password": SECRET}))
        self.assertTrue(payload["ok"], payload)
        self.assertNotIn(SECRET, json.dumps(payload))
        self.assertTrue(payload["samba"]["passwordSet"])
        self.assertEqual(payload["samba"]["user"], "hog")
        secret = self.samba / "pass"
        self.assertEqual(secret.read_text(), SECRET)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.samba.stat().st_mode), 0o700)
        state = (self.data / "samba.json").read_text()
        self.assertNotIn(SECRET, state)
        self.assertEqual(self.pulled(), [])
        # The user can change without retyping the password.
        again = self.guard.handle("samba-save", json.dumps({"user": "media"}))
        self.assertTrue(again["ok"], again)
        self.assertEqual(secret.read_text(), SECRET)

    def test_save_rejects_bad_input_without_echo(self):
        for raw in ("not json", json.dumps({"user": "root", "password": SECRET}), json.dumps({"user": "hog", "password": "short"})):
            payload = self.guard.handle("samba-save", raw)
            self.assertFalse(payload["ok"])
            self.assertNotIn(SECRET, json.dumps(payload))
        self.assertFalse((self.samba / "pass").exists())

    def test_on_needs_sign_in_and_tailscale_engine(self):
        payload = self.guard.handle("samba-on")
        self.assertFalse(payload["ok"])
        self.assertIn("user and password", payload["error"])
        self.guard.handle("samba-save", json.dumps({"user": "hog", "password": SECRET}))
        self.guard.container_runtime = lambda name="": "desktop"
        payload = self.guard.handle("samba-on")
        self.assertFalse(payload["ok"])
        self.assertIn("Docker Engine", payload["error"])
        self.guard.container_runtime = lambda name="": "engine"
        self.guard.tailscale_ipv4 = lambda: ""
        payload = self.guard.handle("samba-on")
        self.assertFalse(payload["ok"])
        self.assertIn("Tailscale", payload["error"])
        self.assertEqual(self.pulled(), [])

    def test_on_pulls_runs_on_tailnet_and_off_removes(self):
        self.guard.handle("samba-save", json.dumps({"user": "hog", "password": SECRET}))
        payload = self.guard.handle("samba-on")
        self.assertTrue(payload["ok"], payload)
        self.assertNotIn(SECRET, json.dumps(payload))
        self.assertEqual(self.pulled(), [["pull", SAMBA_IMAGE]])
        run = next(call for call in self.calls if call[:1] == ["run"])
        self.assertNotIn(SECRET, " ".join(run))
        publishes = [run[i + 1] for i, token in enumerate(run) if token == "-p"]
        self.assertEqual(publishes, ["100.119.132.89:445:445/tcp", "127.0.0.1:445:445/tcp"])
        conf = (self.samba / "smb.conf").read_text()
        self.assertIn("valid users = hog", conf)
        self.assertEqual(stat.S_IMODE((self.samba / "smb.conf").stat().st_mode), 0o600)
        self.assertTrue(payload["samba"]["running"])
        self.assertTrue(payload["samba"]["enabled"])
        self.assertEqual(payload["samba"]["ip"], "100.119.132.89")
        self.assertIn(SAMBA_NAME, self.guard.read_names())
        self.assertEqual(assess(self.boxes[SAMBA_NAME], SAMBA_NAME, self.guard.data), "")
        # Second start reuses the image.
        self.guard.handle("samba-on")
        self.assertEqual(len(self.pulled()), 1)
        off = self.guard.handle("samba-off")
        self.assertTrue(off["ok"], off)
        self.assertFalse(off["samba"]["running"])
        self.assertFalse(off["samba"]["enabled"])
        self.assertNotIn(SAMBA_NAME, self.guard.read_names())

    def test_wrong_binding_is_removed(self):
        self.guard.handle("samba-save", json.dumps({"user": "hog", "password": SECRET}))
        self.bind_ip = "0.0.0.0"
        payload = self.guard.handle("samba-on")
        self.assertFalse(payload["ok"])
        self.assertIn("beyond the tailnet", payload["error"])
        self.assertNotIn(SAMBA_NAME, self.boxes)

    def test_samba_folder_may_not_overlap_wallet(self):
        with mock.patch.dict(os.environ, {"HOG_SAMBA_DIR": str(self.data / "samba")}):
            payload = self.guard.handle("samba-save", json.dumps({"user": "hog", "password": SECRET}))
        self.assertFalse(payload["ok"])

    def test_hog_routes_samba_actions(self):
        text = (Path(__file__).resolve().parent.parent / "hog").read_text(encoding="utf-8")
        for action in ("samba-status", "samba-save", "samba-on", "samba-off"):
            self.assertIn(f'"{action}"', text)
        self.assertIn("window.__hogSamba", text)


if __name__ == "__main__":
    unittest.main()
