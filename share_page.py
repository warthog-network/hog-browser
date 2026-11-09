#!/usr/bin/env python3
"""Phone-sized read-only listing for one Hog folder. Binds to localhost only."""

import html
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ margin: 0; background: #141416; color: #f4f4f5; font: 18px/1.35 system-ui, sans-serif; }}
  header {{ padding: 18px 16px 8px; }}
  h1 {{ margin: 0; font-size: 26px; }}
  p {{ margin: 8px 0 0; color: #a1a1aa; font-size: 16px; }}
  a {{ color: inherit; text-decoration: none; }}
  .up, .file {{ display: block; margin: 10px 12px; padding: 16px; border-radius: 14px; background: #18181b; }}
  .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; }}
  .photo {{ display: block; }}
  .photo img {{ width: 100%; height: 180px; object-fit: cover; border-radius: 14px; background: #000; }}
  .photo span {{ display: block; margin-top: 6px; font-size: 15px; word-break: break-word; }}
</style>
</head>
<body>
<header><h1>{title}</h1><p>{note}</p></header>
{up}
{photos}
{files}
</body>
</html>
"""


def safe_target(root, url_path):
    root = root.resolve()
    raw = unquote(urlsplit(url_path).path)
    if "\x00" in raw:
        return None
    parts = [part for part in Path(raw).parts if part not in ("/", "")]
    if any(part in {".", ".."} for part in parts):
        return None
    try:
        target = root.joinpath(*parts).resolve()
    except OSError:
        return None
    if target != root and root not in target.parents:
        return None
    return target


def listing_page(root, folder):
    root = root.resolve()
    folder = folder.resolve()
    title = folder.name or "Folder"
    photos = []
    files = []
    try:
        children = sorted(folder.iterdir(), key=lambda item: item.name.casefold())
    except OSError:
        children = []
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            resolved = child.resolve()
        except OSError:
            continue
        if resolved != root and root not in resolved.parents:
            continue
        label = html.escape(child.name)
        href = quote(child.name)
        if child.is_dir():
            files.append(f'<a class="file" href="{href}/">{label}</a>')
        elif child.suffix.casefold() in IMAGE_SUFFIXES and child.is_file():
            photos.append(f'<a class="photo" href="{href}"><img src="{href}" alt="{label}" loading="lazy"><span>{label}</span></a>')
        elif child.is_file():
            files.append(f'<a class="file" href="{href}">{label}</a>')
    up = ""
    if folder != root:
        up = '<a class="up" href="../">Up</a>'
    photo_html = f'<div class="grid">{"".join(photos)}</div>' if photos else ""
    note = "Tap a photo to open it full size." if photos else "Tap a file to open it."
    return PAGE.format(
        title=html.escape(title),
        note=note,
        up=up,
        photos=photo_html,
        files="".join(files),
    )


class ShareHandler(BaseHTTPRequestHandler):
    root = None

    def do_GET(self):
        self._send(head=False)

    def do_HEAD(self):
        self._send(head=True)

    def log_message(self, fmt, *args):
        return

    def _send(self, head):
        target = safe_target(self.root, self.path)
        if target is None or not target.exists():
            self.send_error(404)
            return
        if target.is_dir():
            body = listing_page(self.root, target).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        if not target.is_file():
            self.send_error(404)
            return
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        try:
            size = target.stat().st_size
            handle = target.open("rb")
        except OSError:
            self.send_error(404)
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if head:
                return
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        finally:
            handle.close()


def serve(port, directory):
    if port < 8101 or port > 8116:
        raise SystemExit("That port is not a Hog share port.")
    root = Path(directory).resolve()
    if not root.is_dir():
        raise SystemExit("Choose a folder on this computer.")
    ShareHandler.root = root
    server = ThreadingHTTPServer(("127.0.0.1", port), ShareHandler)
    server.serve_forever()


def main(argv):
    if len(argv) != 3:
        raise SystemExit("Usage: share_page.py PORT DIRECTORY")
    serve(int(argv[1]), argv[2])


if __name__ == "__main__":
    main(sys.argv)
