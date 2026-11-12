"""Bookmark files for Hog: import, export, and the one-time backup of the old favorites list.

No GTK here, so the tests can import it.
"""

import os
from pathlib import Path

BOOKMARK_FILE_MAX = 20_000_000


def bookmark_backup_path(data_dir):
    return Path(data_dir) / "bookmarks-v1-backup.json"


def write_bookmark_backup(path, raw):
    """Keeps the pre-0.1.21 favorites list on disk once. Never overwrites."""
    path = Path(path)
    if not raw or len(raw) > BOOKMARK_FILE_MAX or path.exists():
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(raw)
        return True
    except OSError:
        return False


def read_bookmark_file(path):
    path = Path(path)
    try:
        size = path.stat().st_size
    except OSError as exc:
        return {"kind": "import", "ok": False, "error": f"Could not open that file: {exc.strerror or exc}"}
    if size > BOOKMARK_FILE_MAX:
        return {"kind": "import", "ok": False, "error": "That file is too large for a bookmarks file."}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"kind": "import", "ok": False, "error": f"Could not read that file: {exc.strerror or exc}"}
    return {"kind": "import", "ok": True, "text": text, "name": path.name}


def write_bookmark_file(path, html):
    path = Path(path)
    if path.suffix.lower() not in {".html", ".htm"}:
        path = path.with_name(path.name + ".html")
    try:
        path.write_text(html, encoding="utf-8")
    except OSError as exc:
        return {"kind": "export", "ok": False, "error": f"Could not save: {exc.strerror or exc}"}
    return {"kind": "export", "ok": True, "path": str(path)}
