import unittest

import mobile_guard


class FakeGuard:
    def __init__(self, names):
        self.names = names
        self.calls = []

    def read_names(self):
        return list(self.names)

    def engine_status(self):
        return {
            "ok": True,
            "docker": True,
            "items": [
                {"name": "jellyfin", "state": "running", "image": "jellyfin/jellyfin", "runtime": "engine", "reason": "", "ports": [{"port": 8096}],
                 "links": [{"kind": "tailnet", "label": "Tailnet IP", "url": "http://100.64.0.1:8096", "port": 8096}, {"kind": "x", "url": "javascript:alert(1)"}]},
                {"name": "other", "state": "running", "image": "x", "runtime": "desktop", "reason": ""},
            ],
            "jellyfinUrl": "",
            "media": [{"secret": True}],
            "tailscaleLoginUrl": "https://login.tailscale.com/a/xyz",
        }

    def handle(self, action, name="", image="", progress=None):
        self.calls.append((action, name))
        return {"ok": True, "error": ""}


class MobileGuardTest(unittest.TestCase):
    def test_list_keeps_only_managed_and_safe_fields(self):
        out = mobile_guard.run(FakeGuard(["jellyfin"]), "list")
        self.assertEqual([item["name"] for item in out["items"]], ["jellyfin"])
        self.assertEqual(set(out), {"ok", "error", "docker", "items", "jellyfinUrl"})
        self.assertEqual(out["items"][0]["links"], [{"kind": "tailnet", "label": "Tailnet IP", "url": "http://100.64.0.1:8096", "port": 8096}])
        self.assertEqual(out["jellyfinUrl"], "http://100.64.0.1:8096")

    def test_actions_only_for_managed_names(self):
        guard = FakeGuard(["jellyfin"])
        refused = mobile_guard.run(guard, "stop", "other")
        self.assertFalse(refused["ok"])
        self.assertEqual(guard.calls, [])
        self.assertFalse(mobile_guard.run(guard, "remove", "jellyfin")["ok"])
        self.assertFalse(mobile_guard.run(guard, "start", "../evil")["ok"])
        self.assertEqual(guard.calls, [])
        done = mobile_guard.run(guard, "restart", "jellyfin")
        self.assertTrue(done["ok"])
        self.assertEqual(guard.calls, [("restart", "jellyfin")])


if __name__ == "__main__":
    unittest.main()
