"""SSH into a trusted Hog container and relay the session to the Hog window.

Pages never call this. The private key stays on disk. The container SSH
server listens only on 127.0.0.1 inside the container, and Hog reaches it
through docker exec. No port is published on the host.
"""

import base64
import hashlib
import json
import os
import pty
import re
import secrets
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import tty
from pathlib import Path

from guard import docker_host_env, docker_offline, valid_name, wallet_dir

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PUBKEY_RE = re.compile(r"^ssh-ed25519 [A-Za-z0-9+/=]+ hog-browser$")
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
PROXY_SOURCE = """import os, re, sys
name = os.environ.get("HOG_SSH_CONTAINER", "")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}", name or ""):
    sys.exit(1)
host = os.environ.get("HOG_DOCKER_HOST", "")
if host:
    if not re.fullmatch(r"unix:///var/run/docker.sock|unix:///home/[A-Za-z0-9._][A-Za-z0-9._-]{0,31}/\\.docker/desktop/docker.sock", host):
        sys.exit(1)
    os.environ["DOCKER_HOST"] = host
    os.environ.pop("DOCKER_CONTEXT", None)
    os.environ.pop("DOCKER_MACHINE_NAME", None)
os.execvp("docker", ["docker", "exec", "-i", name, "socat", "STDIO", "TCP:127.0.0.1:22"])
"""


class ShellError(Exception):
    pass


def _failure_line(blob, fallback):
    lines = [line.strip() for line in str(blob or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("E:") or line.startswith("ssh:") or line.lower().startswith("error"):
            return line[:180]
    return lines[-1][:180] if lines else fallback


def setup_script(pubkey):
    text = str(pubkey or "").strip()
    if not PUBKEY_RE.fullmatch(text) or "'" in text:
        raise ShellError("Hog could not prepare an SSH key.")
    return f"""set -eu
export DEBIAN_FRONTEND=noninteractive
if ! command -v sshd >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y openssh-server socat
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openssh-server socat
  else
    echo "This image has no apt-get or dnf." >&2
    exit 1
  fi
fi
if ! id -u hog >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash hog
fi
mkdir -p /home/hog/.ssh /run/sshd
printf '%s\\n' '{text}' > /home/hog/.ssh/authorized_keys
chown -R hog:hog /home/hog/.ssh
chmod 700 /home/hog/.ssh
chmod 600 /home/hog/.ssh/authorized_keys
if ! command -v sudo >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y sudo
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y sudo
  fi
fi
if command -v sudo >/dev/null 2>&1; then
  usermod -aG sudo hog 2>/dev/null || usermod -aG wheel hog 2>/dev/null || true
  printf '%s\\n' 'hog ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hog
  chmod 440 /etc/sudoers.d/hog
fi
ssh-keygen -A
cat > /etc/ssh/hog-sshd.conf <<'EOF'
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PermitRootLogin no
AllowUsers hog
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
PidFile /run/hog-sshd.pid
UsePAM yes
PrintMotd no
ClientAliveInterval 30
Subsystem sftp internal-sftp
EOF
if [ -f /run/hog-sshd.pid ] && kill -0 "$(cat /run/hog-sshd.pid)" 2>/dev/null; then
  exit 0
fi
rm -f /run/hog-sshd.pid
/usr/sbin/sshd -f /etc/ssh/hog-sshd.conf
"""


def _read_exact(conn, count):
    buf = b""
    while len(buf) < count:
        chunk = conn.recv(count - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def read_frame(conn):
    first, second = _read_exact(conn, 2)
    opcode = first & 0x0F
    masked = (second & 0x80) != 0
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(conn, 8))[0]
    if length > 262144:
        raise ConnectionError("frame too large")
    mask = _read_exact(conn, 4) if masked else b""
    payload = _read_exact(conn, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def write_frame(conn, opcode, payload):
    header = bytearray([0x80 | (opcode & 0x0F)])
    size = len(payload)
    if size < 126:
        header.append(size)
    elif size < 65536:
        header.append(126)
        header.extend(struct.pack("!H", size))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", size))
    conn.sendall(bytes(header) + payload)


def apply_resize(fd, payload, pid):
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    if not isinstance(message, dict) or message.get("type") != "resize":
        return
    try:
        cols = int(message.get("cols"))
        rows = int(message.get("rows"))
    except (TypeError, ValueError):
        return
    if not (1 <= cols <= 400 and 1 <= rows <= 200):
        return
    try:
        import fcntl
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.killpg(pid, signal.SIGWINCH)
    except OSError:
        return


class ShellHost:
    def __init__(self, data_dir, docker="docker", origin="http://127.0.0.1:4188", ssh_bin="ssh"):
        self.root = wallet_dir(data_dir) / "shell"
        self.docker_bin = docker
        self.origin = origin
        self.ssh_bin = ssh_bin
        self.docker_sock = None
        self.key = self.root / "id_ed25519"
        self.proxy_path = self.root / "proxy.py"
        self.known_dir = self.root / "known"
        self.raw = False
        self.lock = threading.Lock()
        self.pending = {}
        self.active = {}
        self.sock = None
        self.port = 0

    def ensure_key(self):
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.known_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.known_dir, 0o700)
        if not self.proxy_path.is_file():
            self.proxy_path.write_text(PROXY_SOURCE, encoding="utf-8")
            os.chmod(self.proxy_path, 0o700)
        if self.key.is_file():
            os.chmod(self.key, 0o600)
            return
        try:
            result = subprocess.run(
                ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.key), "-C", "hog-browser"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            raise ShellError("Hog could not create an SSH key.") from exc
        if result.returncode != 0 or not self.key.is_file():
            raise ShellError("Hog could not create an SSH key.")
        os.chmod(self.key, 0o600)
        pub = self.key.with_suffix(".pub")
        if pub.is_file():
            os.chmod(pub, 0o644)

    def pubkey(self):
        self.ensure_key()
        text = self.key.with_suffix(".pub").read_text(encoding="utf-8").strip()
        if not PUBKEY_RE.fullmatch(text):
            raise ShellError("Hog could not prepare an SSH key.")
        return text

    def ssh_argv(self, name):
        if not valid_name(name):
            raise ShellError("Use a plain container name.")
        known = self.known_dir / name
        proxy = f"ProxyCommand={shlex.quote(sys.executable)} {shlex.quote(str(self.proxy_path))}"
        return [
            self.ssh_bin,
            "-tt",
            "-i", str(self.key),
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={known}",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "UpdateHostKeys=no",
            "-o", "CheckHostIP=no",
            "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ConnectTimeout=10",
            "-o", proxy,
            "-l", "hog",
            name,
        ]

    def _docker(self, args, timeout, text=""):
        try:
            return subprocess.run(
                [self.docker_bin, *args],
                input=text,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
                env=docker_host_env(self.docker_sock) if self.docker_sock else None,
            )
        except FileNotFoundError as exc:
            raise ShellError("Docker is not installed.") from exc
        except subprocess.TimeoutExpired as exc:
            raise ShellError("Installing SSH took too long.") from exc

    def prepare(self, name):
        if not valid_name(name):
            raise ShellError("Use a plain container name.")
        script = setup_script(self.pubkey())
        with self.lock:
            result = self._docker(["exec", "-i", name, "bash", "-s"], 300, script)
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                raise ShellError("Docker is not running.")
            raise ShellError(_failure_line(blob, "SSH could not be installed in that container."))
        return True

    def listen(self):
        with self.lock:
            if self.sock is not None:
                return self.port
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", 0))
            sock.listen(4)
            sock.settimeout(1.0)
            self.sock = sock
            self.port = sock.getsockname()[1]
            threading.Thread(target=self._serve, daemon=True).start()
            return self.port

    def mint(self, name):
        if not valid_name(name):
            raise ShellError("Use a plain container name.")
        self.ensure_key()
        port = self.listen()
        token = secrets.token_hex(32)
        with self.lock:
            if len(self.pending) + len(self.active) >= 4:
                raise ShellError("Close an SSH tab before opening another.")
            self.pending[token] = {"name": name, "born": time.monotonic()}
        return {"token": token, "port": port, "name": name, "user": "hog"}

    def close(self, token):
        if not TOKEN_RE.fullmatch(str(token or "")):
            return
        with self.lock:
            self.pending.pop(token, None)
            active = self.active.get(token)
        proc = active.get("proc") if active else None
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass

    def stop(self):
        with self.lock:
            sock = self.sock
            self.sock = None
            tokens = list(self.active)
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        for token in tokens:
            self.close(token)

    def _serve(self):
        while True:
            sock = self.sock
            if sock is None:
                return
            try:
                conn, addr = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if addr[0] != "127.0.0.1":
                conn.close()
                continue
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        try:
            conn.settimeout(10)
            header = b""
            while b"\r\n\r\n" not in header:
                chunk = conn.recv(1024)
                if not chunk:
                    return
                header += chunk
                if len(header) > 8192:
                    return
            head, _rest = header.split(b"\r\n\r\n", 1)
            lines = head.decode("latin1").split("\r\n")
            request = lines[0]
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            token = ""
            if request.startswith("GET /ssh?"):
                target = request.split(" ", 2)[1]
                for part in target.split("?", 1)[-1].split("&"):
                    if part.startswith("token="):
                        token = part.split("=", 1)[1]
            origin = headers.get("origin", "")
            if origin != self.origin or not TOKEN_RE.fullmatch(token) or "sec-websocket-key" not in headers:
                self._reject(conn)
                return
            with self.lock:
                session = self.pending.get(token)
                fresh = session is not None and time.monotonic() - session["born"] < 120
                if fresh:
                    self.pending.pop(token, None)
            if not fresh:
                self._reject(conn)
                return
            accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
            conn.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n"
                    "\r\n"
                ).encode()
            )
            conn.settimeout(None)
            self._relay(conn, token, session["name"])
        except Exception:
            try:
                conn.close()
            except OSError:
                pass

    def _reject(self, conn):
        try:
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass

    def _relay(self, conn, token, name):
        master = None
        proc = None
        try:
            env = os.environ.copy()
            env["HOG_SSH_CONTAINER"] = name
            if self.docker_sock:
                env["HOG_DOCKER_HOST"] = f"unix://{self.docker_sock}"
            else:
                env.pop("HOG_DOCKER_HOST", None)
            master, slave = pty.openpty()
            if self.raw:
                tty.setraw(slave)
            proc = subprocess.Popen(
                self.ssh_argv(name),
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=env,
                start_new_session=True,
                close_fds=True,
            )
            os.close(slave)
            slave = -1
            with self.lock:
                self.active[token] = {"proc": proc, "master": master}
            stop = threading.Event()
            send_lock = threading.Lock()

            def pump():
                try:
                    while not stop.is_set():
                        ready, _, _ = select.select([master], [], [], 0.3)
                        if proc.poll() is not None and not ready:
                            break
                        if not ready:
                            continue
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            break
                        if not data:
                            break
                        with send_lock:
                            write_frame(conn, 2, data)
                finally:
                    stop.set()

            threading.Thread(target=pump, daemon=True).start()
            while not stop.is_set():
                try:
                    opcode, payload = read_frame(conn)
                except (ConnectionError, OSError, TimeoutError):
                    break
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with send_lock:
                        write_frame(conn, 0xA, payload)
                    continue
                if opcode == 0x1:
                    apply_resize(master, payload, proc.pid)
                    continue
                if opcode == 0x2 and payload:
                    try:
                        os.write(master, payload)
                    except OSError:
                        break
        finally:
            with self.lock:
                self.active.pop(token, None)
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
            if master is not None:
                try:
                    os.close(master)
                except OSError:
                    pass
            try:
                conn.close()
            except OSError:
                pass
