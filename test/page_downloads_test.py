import ast
import os
import tempfile
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOG = (ROOT / "hog").read_text(encoding="utf-8")


def load(*names):
    """Plain helpers and constants from the hog script, without GTK."""
    tree = ast.parse(HOG)
    wanted = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            wanted.append(node)
        elif isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "DOWNLOAD_MIME_TYPES" for t in node.targets):
            wanted.append(node)
    space = {"os": os, "urllib": urllib, "PORT": 4188}
    exec(compile(ast.Module(body=wanted, type_ignores=[]), "hog", "exec"), space)
    return space


H = load("download_name", "disposition_is_attachment", "response_wants_download", "page_download_name", "unique_download_path")


def section(start):
    body = HOG[HOG.index(start):]
    return body[: body.index("\n    def ", len(start))]


class ResponsePolicyTest(unittest.TestCase):
    def test_github_release_assets_download(self):
        want = H["response_wants_download"]
        # objects.githubusercontent.com / release-assets answer like this for an APK.
        self.assertTrue(want("application/vnd.android.package-archive", 'attachment; filename=hog-mobile-0.1.35.apk', False))
        self.assertTrue(want("application/octet-stream", "attachment; filename=hog-browser_0.1.35_amd64.deb", False))
        # Even if WebKit claims it could draw it, these types still save.
        for mime in ("application/octet-stream", "application/zip", "application/vnd.android.package-archive",
                     "application/x-debian-package", "application/gzip", "application/x-7z-compressed"):
            self.assertTrue(want(mime, "", True), mime)
        self.assertTrue(want("APPLICATION/ZIP; charset=binary", "", True))

    def test_attachment_wins_over_page_types(self):
        want = H["response_wants_download"]
        self.assertTrue(want("text/html", "attachment", True))
        self.assertTrue(want("text/plain", 'Attachment; filename="notes.txt"', True))
        self.assertTrue(want("text/csv", "attachment;filename=a.csv", True))

    def test_pages_still_show(self):
        want = H["response_wants_download"]
        for mime in ("text/html", "application/xhtml+xml", "image/png", "text/plain", "application/json", "video/mp4"):
            self.assertFalse(want(mime, "", True), mime)
            self.assertFalse(want(mime, "inline", True), mime)
            self.assertFalse(want(mime, 'inline; filename="x.txt"', True), mime)
        self.assertFalse(want("", "", False))
        self.assertFalse(want(None, None, False))

    def test_types_webkit_cannot_show_download(self):
        want = H["response_wants_download"]
        self.assertTrue(want("application/x-something-new", "", False))
        self.assertTrue(want("application/pdf", "", False))

    def test_disposition_parse(self):
        att = H["disposition_is_attachment"]
        self.assertTrue(att("attachment"))
        self.assertTrue(att(" ATTACHMENT ; filename=a"))
        self.assertFalse(att("inline; filename=attachment"))
        self.assertFalse(att(""))
        self.assertFalse(att(None))


class DownloadNameTest(unittest.TestCase):
    def test_names(self):
        name = H["page_download_name"]
        self.assertEqual(name("hog-mobile-0.1.35.apk"), "hog-mobile-0.1.35.apk")
        self.assertEqual(name("../../.bashrc"), "bashrc")
        self.assertEqual(name("", "https://github.com/x/y/releases/download/0.1.35/hog%20mobile.apk"), "hog mobile.apk")
        self.assertEqual(name("", "https://example.com/"), "download")
        self.assertEqual(name("...", ""), "download")

    def test_unique_path_never_clobbers(self):
        unique = H["unique_download_path"]
        with tempfile.TemporaryDirectory() as folder:
            first = unique(folder, "hog.apk")
            self.assertEqual(first, os.path.join(folder, "hog.apk"))
            Path(first).write_bytes(b"x")
            self.assertEqual(unique(folder, "hog.apk"), os.path.join(folder, "hog (1).apk"))
            Path(folder, "hog (1).apk").write_bytes(b"x")
            self.assertEqual(unique(folder, "hog.apk"), os.path.join(folder, "hog (2).apk"))
            # A name another download already holds is skipped too.
            self.assertEqual(unique(folder, "hog.apk", [os.path.join(folder, "hog (2).apk")]),
                             os.path.join(folder, "hog (3).apk"))
            Path(folder, "a.tar.gz").write_bytes(b"x")
            self.assertEqual(unique(folder, "a.tar.gz"), os.path.join(folder, "a (1).tar.gz"))
            Path(folder, "README").write_bytes(b"x")
            self.assertEqual(unique(folder, "README"), os.path.join(folder, "README (1)"))
            # A dangling symlink is still taken.
            os.symlink(os.path.join(folder, "missing"), os.path.join(folder, "link.zip"))
            self.assertEqual(unique(folder, "link.zip"), os.path.join(folder, "link (1).zip"))


class WiringTest(unittest.TestCase):
    def test_response_policy_downloads(self):
        decide = section("    def on_decide(self, view, decision, decision_type, tab_id):")
        self.assertIn("self.response_is_download(view, decision)", decide)
        self.assertIn("decision.download()", decide)
        check = section("    def response_is_download(self, view, decision):")
        self.assertIn("is_main_frame_main_resource()", check)
        self.assertIn("can_show_mime_type", check)
        self.assertIn('get_one("Content-Disposition")', check)

    def test_page_contexts_watch_downloads(self):
        self.assertIn('context.connect("download-started", self.downloads.on_started)', HOG)
        shared = section("    def shared(self):")
        self.assertIn("self.watch_downloads(context)", shared)
        ensure = section("    def ensure(self, tab_id, isolated):")
        self.assertIn("self.watch_downloads(context)", ensure)

    def test_downloads_never_overwrite_or_run(self):
        dest = section("    def on_destination(self, download, suggested, item_id):")
        self.assertIn("download.set_allow_overwrite(False)", dest)
        self.assertIn("unique_download_path(", dest)
        show = HOG[HOG.index("def show_in_folder(path):"):]
        show = show[: show.index("\n\n\nclass ")]
        self.assertIn("ShowItems", show)
        # Only folders open; the saved file itself is never launched.
        self.assertIn("launch_default_for_uri(folder_uri", show)
        self.assertNotIn("launch_default_for_uri(uri", show)

    def test_chrome_commands(self):
        host = HOG[HOG.index("class PageHost:"):]
        command = host[host.index("    def command(self, command):"):]
        command = command[: command.index("\n    def ", 10)]
        self.assertIn('command.startswith("download:")', command)
        app = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
        self.assertIn("window.__hogDownload = ", app)
        self.assertIn("desktopCommand(`download:${action}:${id}`)", app)


if __name__ == "__main__":
    unittest.main()
