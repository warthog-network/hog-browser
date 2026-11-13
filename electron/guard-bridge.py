#!/usr/bin/env python3
"""guard.py for the Chromium (Electron) Hog shell.

The WebKitGTK shell calls Guard.handle() in-process. Electron runs this file
as a child process instead and talks JSON lines over stdin/stdout:

  in : {"id": 1, "action": "list", "name": "", "image": "", "progress": false}
       {"id": 2, "op": "use_library", "rel": "Movies"}
  out: {"id": 1, "payload": {...}, "done": true}
       {"id": 1, "payload": {...}, "done": false}   (progress for run/recreate/samba-on)

Nothing here listens on a socket. It exits when stdin closes.
"""

import json
import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from guard import Guard  # noqa: E402

DATA = Path(os.environ.get("HOG_DATA", Path.home() / ".local" / "share" / "hog-browser"))
ORIGIN = os.environ.get("HOG_ORIGIN", "http://127.0.0.1:4188")
PROGRESS_ACTIONS = {"run", "recreate", "samba-on"}

_out = threading.Lock()


def send(obj):
    line = json.dumps(obj)
    with _out:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    guard = Guard(DATA, origin=ORIGIN)
    send({"ready": True})

    def work(req):
        req_id = req.get("id")
        if req.get("op") == "use_library":
            try:
                guard.use_library(str(req.get("rel") or ""))
            except Exception:
                pass
            send({"id": req_id, "payload": {"ok": True}, "done": True})
            return
        action = str(req.get("action") or "")
        name = str(req.get("name") or "")
        image = str(req.get("image") or "")
        try:
            if action in PROGRESS_ACTIONS:
                payload = guard.handle(
                    action, name, image,
                    progress=lambda p: send({"id": req_id, "payload": p, "done": False}),
                )
            else:
                payload = guard.handle(action, name, image)
        except RuntimeError as exc:
            payload = {"ok": False, "error": str(exc), "items": []}
        except Exception as exc:  # keep the bridge alive
            payload = {"ok": False, "error": f"Hog could not do that: {exc}", "items": []}
        send({"id": req_id, "payload": payload, "done": True})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(req, dict):
            continue
        threading.Thread(target=work, args=(req,), daemon=True).start()


if __name__ == "__main__":
    main()
