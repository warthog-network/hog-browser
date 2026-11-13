#!/usr/bin/env python3
"""Read chosen keys from the WebKit Hog's localStorage (read-only).

Usage: webkit-import.py <file.localstorage> <key> [<key> ...]
Prints {"ok": true, "items": {key: value}} as one JSON line.

WebKitGTK keeps the Hog UI's localStorage in an SQLite file (with -wal and
-shm next to it while Hog runs). The files are copied into a private temp
dir first, so the WebKit Hog's own files are never opened for writing and a
running Hog is not disturbed. Only the keys named on the command line are
read; the wallet keys are only passed when the user asked for the wallet.
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile

MAX_VALUE = 20_000_000


def decode(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-16-le")
        except UnicodeDecodeError:
            return raw.decode("utf-8", "replace")
    return None


def read(path, keys):
    with tempfile.TemporaryDirectory(prefix="hog-import-") as tmp:
        os.chmod(tmp, 0o700)
        copy = os.path.join(tmp, "ls.sqlite")
        shutil.copyfile(path, copy)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(path + suffix):
                shutil.copyfile(path + suffix, copy + suffix)
        conn = sqlite3.connect(copy)
        try:
            items = {}
            marks = ",".join("?" for _ in keys)
            for key, value in conn.execute(f"SELECT key, value FROM ItemTable WHERE key IN ({marks})", list(keys)):
                text = decode(value)
                if text is not None and len(text) <= MAX_VALUE:
                    items[str(key)] = text
            return items
        finally:
            conn.close()


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: webkit-import.py FILE KEY..."}))
        return 2
    path, keys = argv[1], [k for k in argv[2:] if k.startswith("hog-") and len(k) < 80]
    try:
        items = read(path, keys)
    except Exception as exc:  # noqa: BLE001 - report any read problem to the UI
        print(json.dumps({"ok": False, "error": f"Could not read Hog's saved data: {exc}"}))
        return 1
    print(json.dumps({"ok": True, "items": items}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
