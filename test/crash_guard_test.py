import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CrashGuardTest(unittest.TestCase):
    """YouTube watch pages segfaulted the whole Hog window on Ubuntu's
    WebKitGTK 2.52 with NVIDIA (view transition -> compositing with no
    backing store). These keep the guards wired in."""

    def setUp(self):
        self.hog = (ROOT / "hog").read_text()

    def test_view_transitions_are_turned_off(self):
        self.assertIn('CRASHY_FEATURES = ("ViewTransitions", "CrossDocumentViewTransitions")', self.hog)
        # Page views (tune) and Hog's own UI view both apply it.
        self.assertGreaterEqual(self.hog.count("disable_crashy_features(settings)"), 2)
        tune = self.hog[self.hog.index("    def tune(self, view):"):]
        tune = tune[: tune.index("\n    def ", 10)]
        self.assertIn("disable_crashy_features(settings)", tune)

    def test_a_page_crash_only_fails_its_tab(self):
        ensure = self.hog[self.hog.index("    def ensure(self, tab_id, isolated):"):]
        ensure = ensure[: ensure.index("\n    def ", 10)]
        self.assertIn('view.connect("web-process-terminated", self.on_crash, tab_id)', ensure)
        crash = self.hog[self.hog.index("    def on_crash(self, view, reason, tab_id):"):]
        crash = crash[: crash.index("\n    def ", 10)]
        self.assertIn('"fail"', crash)
        self.assertNotRegex(crash, r"quit|destroy|sys\.exit|main_quit")
        self.assertIn('view.connect("web-process-terminated", on_chrome_crash)', self.hog)

    def test_launch_replaces_an_older_server(self):
        ensure = self.hog[self.hog.index("    def ensure_server(self):"):]
        ensure = ensure[: ensure.index("\n    def ", 10)]
        self.assertIn("replace_stale_server(", ensure)
        self.assertRegex(ensure, r'state in \("current", "foreign"\)')

    def test_server_guard_ships_in_the_deb(self):
        deb = (ROOT / "packaging" / "build-deb.sh").read_text()
        self.assertIn('"${HB}/server_guard.py"', deb)


if __name__ == "__main__":
    unittest.main()
