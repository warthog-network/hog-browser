import io
import json
import os
import signal
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server_guard import (
    app_version,
    is_own_server,
    listening_inodes,
    pids_for_inodes,
    replace_stale_server,
    running_server_version,
)

HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"


def tcp_line(local, state, inode):
    return f"   0: {local} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000  1000        0 {inode} 1 0000000000000000 100 0 0 10 0\n"


class FakeProc:
    def __init__(self, base):
        self.base = Path(base)
        (self.base / "net").mkdir(parents=True)
        self.tcp = HEADER
        self.write_tcp()

    def write_tcp(self):
        (self.base / "net" / "tcp").write_text(self.tcp)

    def listen(self, port, inode):
        self.tcp += tcp_line(f"0100007F:{port:04X}", "0A", inode)
        self.write_tcp()

    def process(self, pid, argv, cwd, inode=None, uid=None):
        root = self.base / str(pid)
        (root / "fd").mkdir(parents=True)
        (root / "cmdline").write_bytes(b"\0".join(part.encode() for part in argv) + b"\0")
        os.symlink(cwd, root / "cwd")
        (root / "status").write_text(f"Name:\tnode\nUid:\t{os.getuid() if uid is None else uid}\t0\t0\t0\n")
        os.symlink("/dev/null", root / "fd" / "0")
        if inode is not None:
            os.symlink(f"socket:[{inode}]", root / "fd" / "21")


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class ServerGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Path(self.tmp.name) / "app"
        self.app.mkdir()
        (self.app / "package.json").write_text(json.dumps({"name": "hog-browser", "version": "0.1.28"}))
        self.proc = FakeProc(Path(self.tmp.name) / "proc")

    def test_app_version_reads_package_json(self):
        self.assertEqual(app_version(self.app), "0.1.28")
        self.assertEqual(app_version(Path(self.tmp.name) / "missing"), "")

    def test_running_version_parses_reply_and_old_servers(self):
        reply = json.dumps({"app": "hog-browser", "version": "0.1.28"}).encode()
        self.assertEqual(running_server_version(4188, opener=lambda url, timeout: Response(reply)), "0.1.28")
        other = json.dumps({"app": "something-else", "version": "9"}).encode()
        self.assertEqual(running_server_version(4188, opener=lambda url, timeout: Response(other)), "")

        def not_found(url, timeout):
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        self.assertEqual(running_server_version(4188, opener=not_found), "")

        def refused(url, timeout):
            raise ConnectionRefusedError()

        self.assertIsNone(running_server_version(4188, opener=refused))

    def test_finds_the_listener_pid(self):
        self.proc.listen(4188, 777)
        self.proc.tcp += tcp_line("0100007F:1F90", "01", 888)
        self.proc.write_tcp()
        self.proc.process(58693, ["/usr/local/bin/node", "server.mjs"], str(self.app), inode=777)
        self.proc.process(1234, ["/usr/bin/bash"], "/tmp")
        self.assertEqual(listening_inodes(4188, self.proc.base), {"777"})
        self.assertEqual(pids_for_inodes({"777"}, self.proc.base), [58693])

    def test_only_this_installs_node_server_counts_as_own(self):
        self.proc.process(10, ["/usr/local/bin/node", "server.mjs"], str(self.app))
        self.proc.process(11, ["/usr/local/bin/node", "server.mjs"], "/home/someone/other-app")
        self.proc.process(12, ["/usr/bin/python3", "server.mjs"], str(self.app))
        self.proc.process(13, ["/usr/local/bin/node", "evil.mjs"], str(self.app))
        self.proc.process(14, ["/usr/local/bin/node", "server.mjs"], str(self.app), uid=os.getuid() + 1)
        self.proc.process(15, ["node", "server.mjs"], f"{self.app} (deleted)")
        self.assertTrue(is_own_server(10, self.app, self.proc.base))
        self.assertFalse(is_own_server(11, self.app, self.proc.base))
        self.assertFalse(is_own_server(12, self.app, self.proc.base))
        self.assertFalse(is_own_server(13, self.app, self.proc.base))
        self.assertFalse(is_own_server(14, self.app, self.proc.base))
        self.assertTrue(is_own_server(15, self.app, self.proc.base))
        self.assertFalse(is_own_server(99, self.app, self.proc.base))

    def run_replace(self, running, argv=None, cwd=None):
        self.proc.listen(4188, 777)
        self.proc.process(58693, argv or ["/usr/local/bin/node", "server.mjs"], cwd or str(self.app), inode=777)
        state = {"open": True, "signals": []}

        def kill(pid, sig):
            state["signals"].append((pid, sig))
            state["open"] = False

        result = replace_stale_server(
            4188,
            self.app,
            port_open=lambda port: state["open"],
            proc=self.proc.base,
            version_of=lambda port, **_: running,
            kill=kill,
            sleep=lambda _: None,
        )
        return result, state["signals"]

    def test_same_version_is_reused(self):
        self.assertEqual(self.run_replace("0.1.28"), ("current", []))

    def test_old_server_without_version_route_is_replaced(self):
        self.assertEqual(self.run_replace(""), ("replaced", [(58693, signal.SIGTERM)]))

    def test_different_version_is_replaced(self):
        self.assertEqual(self.run_replace("0.1.27"), ("replaced", [(58693, signal.SIGTERM)]))

    def test_another_apps_node_server_is_left_alone(self):
        self.assertEqual(self.run_replace("", cwd="/srv/other"), ("foreign", []))

    def test_a_non_hog_listener_is_left_alone(self):
        self.assertEqual(self.run_replace(None, argv=["/usr/bin/python3", "-m", "http.server"]), ("foreign", []))

    def test_nothing_listening(self):
        result = replace_stale_server(4188, self.app, port_open=lambda port: False, proc=self.proc.base)
        self.assertEqual(result, "none")


if __name__ == "__main__":
    unittest.main()
