import ast
import os
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_functions(*names):
    """Pull plain helper functions out of the hog script without importing GTK."""
    tree = ast.parse((ROOT / "hog").read_text(encoding="utf-8"))
    wanted = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    module = ast.Module(body=wanted, type_ignores=[])
    space = {"os": os, "urllib": urllib, "PORT": 4188}
    exec(compile(module, "hog", "exec"), space)
    return [space[name] for name in names]


files_download_uri, download_name = load_functions("files_download_uri", "download_name")


class FilesDesktopTest(unittest.TestCase):
    def test_download_filter(self):
        good = "http://127.0.0.1:4188/api/files/raw?root=shares&path=a%2Fb.mkv&download=1"
        self.assertTrue(files_download_uri(good))
        for bad in (
            "http://127.0.0.1:4188/api/files/raw?root=shares&path=a.mkv",
            "http://127.0.0.1:4189/api/files/raw?root=shares&path=a&download=1",
            "http://localhost:4188/api/files/raw?root=shares&path=a&download=1",
            "https://127.0.0.1:4188/api/files/raw?root=shares&path=a&download=1",
            "http://evil.example/api/files/raw?root=shares&download=1",
            "http://user:pw@127.0.0.1:4188/api/files/raw?root=shares&download=1",
            "http://127.0.0.1:4188/api/files/list?root=shares&download=1",
            "",
            None,
        ):
            self.assertFalse(files_download_uri(bad), bad)

    def test_download_name(self):
        self.assertEqual(download_name("film.mkv"), "film.mkv")
        self.assertEqual(download_name("../../etc/passwd"), "passwd")
        self.assertEqual(download_name("a\\b\\c.txt"), "c.txt")
        self.assertEqual(download_name(""), "download")
        self.assertEqual(download_name(".."), "download")
        self.assertEqual(download_name("bad\nname"), "badname")

    def test_hog_wires_files_commands(self):
        text = (ROOT / "hog").read_text(encoding="utf-8")
        self.assertIn('command == "files:pick-root"', text)
        self.assertIn('context.connect("download-started", self.on_chrome_download)', text)
        self.assertIn("window.__hogFilesRoot", text)


if __name__ == "__main__":
    unittest.main()
