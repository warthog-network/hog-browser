"""Find out whether the Hog server already on our port is this install's own
and the same version. A Hog window left over from before an update can leave
its old server running; a new window would otherwise attach to it and miss
every feature the update added."""

import json
import os
import signal
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION_PATH = "/__hog/version"
LISTEN = "0A"


def app_version(root):
    try:
        data = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    value = data.get("version") if isinstance(data, dict) else ""
    return value if isinstance(value, str) else ""


def running_server_version(port, timeout=1.5, opener=None):
    """Version the server on 127.0.0.1:port reports, "" for an older Hog
    server that has no version route, None when nothing answered."""
    url = f"http://127.0.0.1:{int(port)}{VERSION_PATH}"
    open_url = opener or urllib.request.urlopen
    try:
        with open_url(url, timeout=timeout) as response:
            raw = response.read(4096)
    except urllib.error.HTTPError:
        return ""
    except (OSError, ValueError):
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return ""
    if not isinstance(data, dict) or data.get("app") != "hog-browser":
        return ""
    value = data.get("version")
    return value if isinstance(value, str) else ""


def _loopback_hex_v4(port):
    return f"0100007F:{int(port):04X}"


def _loopback_hex_v6(port):
    # ::ffff:127.0.0.1 as /proc/net/tcp6 prints it.
    return f"0000000000000000FFFF00000100007F:{int(port):04X}"


def listening_inodes(port, proc="/proc"):
    """Socket inodes listening on 127.0.0.1:port."""
    wanted = {_loopback_hex_v4(port), _loopback_hex_v6(port)}
    found = set()
    for name in ("net/tcp", "net/tcp6"):
        try:
            lines = Path(proc, name).read_text(encoding="ascii", errors="replace").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10:
                continue
            if fields[1].upper() in wanted and fields[3].upper() == LISTEN and fields[9] != "0":
                found.add(fields[9])
    return found


def pids_for_inodes(inodes, proc="/proc"):
    targets = {f"socket:[{inode}]" for inode in inodes}
    pids = []
    if not targets:
        return pids
    try:
        entries = os.listdir(proc)
    except OSError:
        return pids
    for entry in entries:
        if not entry.isdigit():
            continue
        fd_dir = Path(proc, entry, "fd")
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(fd_dir / fd) in targets:
                    pids.append(int(entry))
                    break
            except OSError:
                continue
    return sorted(pids)


def is_own_server(pid, root, proc="/proc", uid=None):
    """Only a node process running this install's server.mjs, as this user."""
    base = Path(proc, str(pid))
    try:
        argv = (base / "cmdline").read_bytes().split(b"\0")
        cwd = os.readlink(base / "cwd")
        owner = (base / "status").read_text(encoding="ascii", errors="replace")
    except OSError:
        return False
    argv = [part.decode("utf-8", "replace") for part in argv if part]
    if len(argv) < 2 or os.path.basename(argv[0]) not in ("node", "nodejs"):
        return False
    script = argv[1]
    if os.path.basename(script) != "server.mjs":
        return False
    if cwd.endswith(" (deleted)"):
        cwd = cwd[: -len(" (deleted)")]
    try:
        root_real = os.path.realpath(root)
    except OSError:
        return False
    if os.path.realpath(cwd) != root_real:
        return False
    if os.path.isabs(script) and os.path.realpath(os.path.dirname(script)) != root_real:
        return False
    want_uid = os.getuid() if uid is None else uid
    for line in owner.splitlines():
        if line.startswith("Uid:"):
            parts = line.split()
            return len(parts) > 1 and parts[1] == str(want_uid)
    return False


def stop_server(pid, port_open, port, kill=os.kill, sleep=time.sleep, wait=5.0):
    try:
        kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    steps = max(1, int(wait / 0.1))
    for _ in range(steps):
        if not port_open(port):
            return True
        sleep(0.1)
    try:
        kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    for _ in range(20):
        if not port_open(port):
            return True
        sleep(0.1)
    return not port_open(port)


def replace_stale_server(port, root, port_open, proc="/proc", version_of=None, kill=os.kill, sleep=time.sleep, log=None):
    """Returns "none" (nothing on the port), "current" (same version, reuse it),
    "replaced" (an older server of this install was stopped), or "foreign"
    (something else holds the port; leave it alone)."""
    if not port_open(port):
        return "none"
    expected = app_version(root)
    ask = version_of or running_server_version
    running = ask(port)
    if running is None:
        # A busy server can be slow; give it one longer try before judging it.
        running = ask(port, timeout=4) if version_of is None else ask(port)
    if running is not None and running and running == expected:
        return "current"
    pids = [pid for pid in pids_for_inodes(listening_inodes(port, proc), proc) if is_own_server(pid, root, proc)]
    if not pids:
        return "foreign"
    for pid in pids:
        if log:
            log(f"Hog: stopping an older Hog server (pid {pid}, version {running or 'unknown'}) so version {expected or 'unknown'} can start.")
        if not stop_server(pid, port_open, port, kill=kill, sleep=sleep):
            return "foreign"
    return "replaced" if not port_open(port) else "foreign"
