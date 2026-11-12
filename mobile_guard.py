#!/usr/bin/env python3
"""Container status and start/stop/restart for the Hog phone app.

server.mjs runs this as `python3 mobile_guard.py <action> [name]` and reads
one JSON object from stdout. Only hog-managed containers (the names the user
added in Containers) can be started, stopped or restarted, and every action
goes through the same Guard checks as the desktop dashboard. The output keeps
only what the phone shows: name, state, image, runtime and links.
"""

import json
import os
import sys
from pathlib import Path

from guard import Guard, valid_name

ACTIONS = {"list", "start", "stop", "restart"}
LINK_KINDS = {"local", "lan", "tailnet"}


def safe_links(links):
    out = []
    for link in links or []:
        if not isinstance(link, dict):
            continue
        url = str(link.get("url") or "")
        if not (url.startswith("http://") or url.startswith("https://")):
            continue
        kind = str(link.get("kind") or "")
        out.append({
            "kind": kind if kind in LINK_KINDS else "",
            "label": str(link.get("label") or "")[:40],
            "url": url[:300],
            "port": link.get("port") if isinstance(link.get("port"), int) else 0,
        })
    return out[:12]


def safe_item(item):
    return {
        "name": str(item.get("name") or ""),
        "state": str(item.get("state") or "unknown"),
        "image": str(item.get("image") or "")[:200],
        "runtime": str(item.get("runtime") or ""),
        "blocked": bool(item.get("reason")),
        "reason": str(item.get("reason") or "")[:200],
        "links": safe_links(item.get("links")),
    }


def view(payload, managed, ok=None, error=None):
    payload = payload if isinstance(payload, dict) else {}
    items = [
        safe_item(item)
        for item in payload.get("items") or []
        if isinstance(item, dict) and item.get("name") in managed
    ]
    jellyfin = str(payload.get("jellyfinUrl") or "")
    if not jellyfin:
        for item in items:
            if item["name"] == "jellyfin" and item["state"] == "running":
                tail = [link["url"] for link in item["links"] if link["kind"] == "tailnet"]
                if tail:
                    jellyfin = tail[0]
                    break
    return {
        "ok": bool(payload.get("ok")) if ok is None else ok,
        "error": str(payload.get("error") or "") if error is None else error,
        "docker": bool(payload.get("docker")),
        "items": items,
        "jellyfinUrl": jellyfin if jellyfin.startswith("http") else "",
    }


def run(guard, action, name=""):
    if action not in ACTIONS:
        return {"ok": False, "error": "That container action is not available.", "items": [], "docker": False, "jellyfinUrl": ""}
    managed = set(guard.read_names())
    if action != "list":
        if not valid_name(name) or name not in managed:
            listing = guard.engine_status()
            return view(listing, managed, ok=False, error="Hog does not manage that container.")
        if action == "stop" and name == "tailscale":
            # The phone reaches hog through this container; stopping it from
            # the phone would cut the phone off until someone is at the computer.
            listing = guard.engine_status()
            return view(listing, managed, ok=False, error="Stop Tailscale on the computer: the phone talks to hog through it. Restart works from here.")
        result = guard.handle(action, name)
        listing = guard.engine_status()
        return view(listing, managed, ok=bool(result.get("ok")), error=str(result.get("error") or ""))
    return view(guard.engine_status(), managed)


def main(argv):
    action = argv[1] if len(argv) > 1 else "list"
    name = argv[2] if len(argv) > 2 else ""
    data = Path(os.environ.get("HOG_DATA") or (Path.home() / ".local" / "share" / "hog-browser"))
    try:
        payload = run(Guard(data), action, name)
    except Exception as exc:  # noqa: BLE001 - report, never crash the API
        payload = {"ok": False, "error": str(exc)[:200] or "Containers are not available.", "items": [], "docker": False, "jellyfinUrl": ""}
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
