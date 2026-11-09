import subprocess
import unittest

from guard import PRESETS, Guard, launch_args


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


if __name__ == "__main__":
    unittest.main()
