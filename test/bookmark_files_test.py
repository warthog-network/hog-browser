import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from bookmark_files import (
    BOOKMARK_FILE_MAX,
    bookmark_backup_path,
    read_bookmark_file,
    write_bookmark_backup,
    write_bookmark_file,
)


class BookmarkBackupTest(unittest.TestCase):
    def test_backup_is_written_once_and_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bookmark_backup_path(tmp)
            first = json.dumps([{"title": "A", "url": "https://a.example/"}])
            self.assertTrue(write_bookmark_backup(path, first))
            self.assertEqual(path.read_text(encoding="utf-8"), first)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertFalse(write_bookmark_backup(path, "[]"), "an existing backup is never overwritten")
            self.assertEqual(path.read_text(encoding="utf-8"), first)

    def test_empty_backup_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bookmark_backup_path(tmp)
            self.assertFalse(write_bookmark_backup(path, ""))
            self.assertFalse(path.exists())


class BookmarkFileTest(unittest.TestCase):
    def test_export_adds_html_suffix_and_import_reads_it_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = write_bookmark_file(Path(tmp) / "marks", "<DL><p></DL>")
            self.assertTrue(result["ok"])
            self.assertTrue(result["path"].endswith("marks.html"))
            back = read_bookmark_file(result["path"])
            self.assertEqual(back, {"kind": "import", "ok": True, "text": "<DL><p></DL>", "name": "marks.html"})

    def test_import_refuses_missing_and_huge_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = read_bookmark_file(Path(tmp) / "nope.html")
            self.assertFalse(missing["ok"])
            big = Path(tmp) / "big.html"
            with open(big, "wb") as handle:
                handle.truncate(BOOKMARK_FILE_MAX + 1)
            self.assertFalse(read_bookmark_file(big)["ok"])

    def test_import_tolerates_bad_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.html"
            path.write_bytes(b"<A HREF=\"https://a.example/\">\xff\xfeA</A>")
            result = read_bookmark_file(path)
            self.assertTrue(result["ok"])
            self.assertIn("https://a.example/", result["text"])


if __name__ == "__main__":
    unittest.main()
