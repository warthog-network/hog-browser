import base64
import socket
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

from guard import Guard
from shell import ShellHost, setup_script


PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForHogBrowserTestOnly000 hog-browser"
ORIGIN = "http://127.0.0.1:4188"


def info(**host):
    return {
        "Name": "/demo",
        "State": {"Status": "running", "Running": True},
        "Config": {"Image": "ubuntu:24.04"},
        "HostConfig": {
            "Privileged": False,
            "NetworkMode": "bridge",
            "PidMode": "",
            "IpcMode": "private",
            "CapAdd": None,
            "Binds": None,
            "Devices": None,
            **host,
        },
        "Mounts": [],
    }


def handshake(port, token, origin):
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    key = base64.b64encode(b"0123456789abcdef").decode()
    req = (
        f"GET /ssh?token={token} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Origin: {origin}\r\n"
        "\r\n"
    )
    sock.sendall(req.encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(1024)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    return sock, head.split(b"\r\n", 1)[0], rest


def send_frame(sock, opcode, payload):
    mask = b"\x01\x02\x03\x04"
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    header = bytearray([0x80 | opcode, 0x80 | len(payload)])
    header.extend(mask)
    sock.sendall(bytes(header) + masked)


def read_frame(sock, pending=b""):
    buf = pending
    while len(buf) < 2:
        buf += sock.recv(1024)
    length = buf[1] & 0x7F
    need = 2 + length
    while len(buf) < need:
        buf += sock.recv(1024)
    return buf[0] & 0x0F, buf[2:need], buf[need:]


class ShellPolicyTest(unittest.TestCase):
    def test_setup_script_stays_inside_the_container(self):
        script = setup_script(PUBKEY)
        self.assertIn("ListenAddress 127.0.0.1", script)
        self.assertIn("PasswordAuthentication no", script)
        self.assertIn("AllowTcpForwarding no", script)
        self.assertIn("PermitRootLogin no", script)
        self.assertIn("apt-get install -y sudo", script)
        self.assertIn("hog ALL=(ALL) NOPASSWD:ALL", script)
        self.assertIn(PUBKEY, script)
        self.assertNotIn("--privileged", script)
        self.assertNotIn("docker.sock", script)
        self.assertNotIn("/home/whitefang", script)
        with self.assertRaises(Exception):
            setup_script("ssh-ed25519 not a key")

    def test_ssh_command_does_not_interpolate_the_name(self):
        with tempfile.TemporaryDirectory() as folder:
            host = ShellHost(folder, origin=ORIGIN)
            host.ensure_key()
            argv = host.ssh_argv("hog-ubuntu")
            proxy = next(item for item in argv if item.startswith("ProxyCommand="))
            self.assertNotIn("hog-ubuntu", proxy)
            self.assertNotIn(";", proxy)
            self.assertNotIn("docker exec", proxy)
            self.assertNotIn("-v", argv)
            self.assertNotIn("--privileged", argv)
            self.assertTrue((Path(folder) / "shell" / "id_ed25519").stat().st_mode & 0o777 == 0o600)

    def test_shell_requires_a_trusted_running_container(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.items = lambda: []
            guard.inspect = lambda name: (None, "Docker did not find that container.")
            guard.shell.prepare = lambda name: (_ for _ in ()).throw(AssertionError(name))
            refused = guard.handle("shell", "hog-ubuntu")
            self.assertFalse(refused["ok"])
            self.assertIn("did not find", refused["error"])
            injected = guard.handle("shell", "hog-ubuntu;id")
            self.assertIn("plain", injected["error"])
            guard.read_names = lambda: ["demo"]
            guard.inspect = lambda name: (info(Privileged=True), "")
            blocked = guard.handle("shell", "demo")
            self.assertIn("privileged", blocked["error"])
            guard.inspect = lambda name: (info(), "")
            guard.shell.prepare = lambda name: None
            guard.shell.mint = lambda name: {"token": "ab" * 32, "port": 9, "name": name, "user": "hog"}
            opened = guard.handle("shell", "demo")
            self.assertTrue(opened["ok"])
            self.assertEqual(opened["shell"]["user"], "hog")
            self.assertNotIn("private", str(opened["shell"]))

    def test_websocket_rejects_the_wrong_origin_and_relays_a_pty(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / "fake-ssh"
            fake.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import sys
                sys.stdout.buffer.write(b"ready\\n")
                sys.stdout.buffer.flush()
                while True:
                    data = sys.stdin.buffer.read(1)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
            """))
            fake.chmod(0o700)
            host = ShellHost(folder, origin=ORIGIN, ssh_bin=str(fake))
            host.raw = True
            host.ensure_key()
            try:
                session = host.mint("hog-ubuntu")
                denied, status, _rest = handshake(session["port"], "0" * 64, ORIGIN)
                self.assertIn(b"403", status)
                denied.close()
                wrong, status, _rest = handshake(session["port"], session["token"], "https://evil.example")
                self.assertIn(b"403", status)
                wrong.close()
                sock, status, pending = handshake(session["port"], session["token"], ORIGIN)
                self.assertIn(b"101", status)
                sock.settimeout(3)
                opcode, payload, pending = read_frame(sock, pending)
                self.assertEqual(opcode, 2)
                self.assertIn(b"ready", payload)
                send_frame(sock, 2, b"Z")
                found = payload
                deadline = time.monotonic() + 3
                while b"Z" not in found and time.monotonic() < deadline:
                    _op, more, pending = read_frame(sock, pending)
                    found += more
                self.assertIn(b"Z", found)
                sock.close()
            finally:
                host.stop()


if __name__ == "__main__":
    unittest.main()
