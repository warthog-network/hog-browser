"""Docker allowlist for the Hog shell.

Pages never call this. The shell starts, stops, and reads logs only for
container names the user added, and only when the container stays off
privileged mode, host namespaces, and the wallet files.
"""

import base64
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
QR_PATH_RE = re.compile(r"^/config/peer[A-Za-z0-9_-]{0,32}/[A-Za-z0-9_.-]{1,40}\.png$")
PEER_CONF_RE = re.compile(r"^/config/peer[A-Za-z0-9_-]{0,32}/[A-Za-z0-9_.-]{1,40}\.conf$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,200}$")
ENGINE_START = ["systemctl", "--user", "start", "docker-desktop.service"]
PRESETS = {
    "ubuntu": {"name": "hog-ubuntu", "image": "ubuntu:24.04", "label": "Ubuntu 24.04"},
    "fedora": {"name": "hog-fedora", "image": "fedora:latest", "label": "Fedora"},
}
SSH_CAPS = (
    "SETUID",
    "SETGID",
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "NET_BIND_SERVICE",
    "SYS_CHROOT",
    "AUDIT_WRITE",
    "KILL",
)
BAD_CAPS = {
    "ALL",
    "DAC_READ_SEARCH",
    "SYS_ADMIN",
    "SYS_BOOT",
    "SYS_MODULE",
    "SYS_PTRACE",
    "SYS_RAWIO",
}
PUBLISH_RE = re.compile(
    r"^(?:(?P<bind>(?:\d{1,3}\.){3}\d{1,3}):)?(?P<host>\d{1,5}):(?P<dest>\d{1,5})(?:/(?P<proto>tcp|udp))?$"
)
COMMAND_RE = re.compile(r"^[A-Za-z0-9_./:-]+$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}=[A-Za-z0-9_.:/+@,-]{1,80}$")
SYSCTLS = {
    "net.ipv4.conf.all.src_valid_mark=1",
    "net.ipv4.ip_forward=1",
    "net.ipv6.conf.all.forwarding=1",
}
MAX_PORTS = 8
MAX_ENV = 16
MAX_COMMAND = 4000
SOCK_MARKERS = ("docker.sock", "containerd.sock", "podman.sock")
HOST_MODES = ("host",)
TAILSCALE_NETWORK = "hog-tailscale"
TAILSCALE_IPV6_SUBNET = "fd00:686f:6700:1::/64"
TAILSCALE_STATE_MOUNT = "hog-tailscale-state:/var/lib/tailscale"

ENGINE_DOCKER_SOCK = Path("/var/run/docker.sock")
DESKTOP_DOCKER_SOCK = Path.home() / ".docker" / "desktop" / "docker.sock"
JELLYFIN_CONFIG_VOLUME = "hog-jellyfin-config"
JELLYFIN_CACHE_VOLUME = "hog-jellyfin-cache"
NVIDIA_VISIBLE_ENV = "NVIDIA_VISIBLE_DEVICES=all"
NVIDIA_CAPS_ENV = "NVIDIA_DRIVER_CAPABILITIES=compute,video,utility"
NVIDIA_DEV_RE = re.compile(r"^/dev/nvidia[A-Za-z0-9_/-]*$")
NVIDIA_TOOLKIT_HELPER = Path("/opt/hog-browser/libexec/hog-nvidia-toolkit-install")
NVIDIA_TOOLKIT_INSTALL_TIMEOUT = 600


def docker_host_env(sock):
    env = os.environ.copy()
    env["DOCKER_HOST"] = f"unix://{sock}"
    env.pop("DOCKER_CONTEXT", None)
    env.pop("DOCKER_MACHINE_NAME", None)
    return env


def nvidia_device_path(text):
    path = str(text or "")
    if ".." in path or "//" in path:
        return False
    return bool(NVIDIA_DEV_RE.fullmatch(path))


def is_desktop_engine(info):
    if not isinstance(info, dict):
        return False
    operating = str(info.get("OperatingSystem") or "")
    name = str(info.get("Name") or "")
    return operating == "Docker Desktop" or name == "docker-desktop"


def nvidia_runtime_configured(info):
    if not isinstance(info, dict):
        return False
    if str(info.get("DefaultRuntime") or "") == "nvidia":
        return True
    runtimes = info.get("Runtimes")
    if isinstance(runtimes, dict) and "nvidia" in runtimes:
        return True
    blob = json.dumps(info)
    return "nvidia.com/gpu" in blob or "nvidia.com/gpu=" in blob


def parse_nvidia_gpu_name(text):
    match = re.search(
        r"NVIDIA(?:\s+GeForce)?\s+(RTX|GTX|Quadro|Tesla|TITAN|Iris)\s+[A-Z0-9][A-Za-z0-9 -]*",
        str(text or ""),
        re.IGNORECASE,
    )
    if not match:
        match = re.search(r"NVIDIA\s+[A-Za-z0-9][A-Za-z0-9 -]{2,40}", str(text or ""))
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(0)).strip(" -")


def os_release_fields():
    fields = {}
    try:
        raw = Path("/etc/os-release").read_text(encoding="utf-8")
    except OSError:
        return fields
    for line in raw.splitlines():
        if "=" not in line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        fields[key] = value.strip().strip("\"'")
    return fields


def docker_engine_install_commands():
    fields = os_release_fields()
    ident = str(fields.get("ID") or "ubuntu").lower()
    distro = "debian" if ident == "debian" else "ubuntu"
    codename_expr = '${UBUNTU_CODENAME:-$VERSION_CODENAME}' if distro == "ubuntu" else "$VERSION_CODENAME"
    return [
        "sudo apt-get update",
        "sudo apt-get install -y ca-certificates curl",
        "sudo install -m 0755 -d /etc/apt/keyrings",
        f"sudo curl -fsSL https://download.docker.com/linux/{distro}/gpg -o /etc/apt/keyrings/docker.asc",
        "sudo chmod a+r /etc/apt/keyrings/docker.asc",
        (
            'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] '
            f'https://download.docker.com/linux/{distro} $(. /etc/os-release && echo "'
            f'{codename_expr}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null'
        ),
        "sudo apt-get update",
        "sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
        "sudo systemctl enable --now docker",
        'sudo usermod -aG docker "$USER"',
    ]


def nvidia_driver_install_commands():
    return [
        "sudo apt-get update",
        "sudo apt-get install -y ubuntu-drivers-common",
        "sudo ubuntu-drivers autoinstall",
    ]


def nvidia_toolkit_install_commands(configure_only=False):
    configure = [
        "sudo nvidia-ctk runtime configure --runtime=docker",
        "sudo systemctl restart docker",
    ]
    if configure_only:
        return configure
    return [
        "sudo apt-get update && sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg2",
        (
            "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | "
            "sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && "
            "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | "
            "sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | "
            "sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list"
        ),
        "sudo apt-get update",
        "sudo apt-get install -y nvidia-container-toolkit",
        *configure,
    ]


def docker_group_commands():
    return ['sudo usermod -aG docker "$USER"']


def nvidia_toolkit_helper_status(path=None, pkexec_path=None):
    helper = Path(path) if path is not None else NVIDIA_TOOLKIT_HELPER
    if not helper.is_file():
        return False, (
            "Install the hog-browser .deb to install the toolkit from this button. "
            "Until then, copy the commands below."
        )
    pkexec = pkexec_path if pkexec_path is not None else shutil.which("pkexec")
    if not pkexec:
        return False, (
            "pkexec is not installed, so Hog cannot open a password prompt. "
            "Copy the commands below, or install pkexec (policykit-1)."
        )
    try:
        st = helper.stat()
    except OSError:
        return False, "The toolkit installer could not be read. Copy the commands below."
    if st.st_uid != 0:
        return False, "The toolkit installer is not the packaged root helper. Copy the commands below."
    if st.st_mode & 0o022:
        return False, "The toolkit installer is writable and will not be run. Copy the commands below."
    if not os.access(helper, os.X_OK):
        return False, "The toolkit installer is not executable. Copy the commands below."
    return True, ""


VOLUME_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$")


def valid_volume_name(name):
    text = str(name or "")
    return bool(VOLUME_NAME_RE.fullmatch(text)) and ".." not in text


def jellyfin_volume_map(info):
    found = {}
    if not isinstance(info, dict):
        return found
    for mount in info.get("Mounts") or []:
        if not isinstance(mount, dict):
            continue
        dest = str(mount.get("Destination") or "")
        name = str(mount.get("Name") or "")
        if dest in {"/config", "/cache"} and valid_volume_name(name):
            found[dest[1:]] = name
    return found


def container_image(info, fallback="jellyfin/jellyfin:latest"):
    config = info.get("Config") if isinstance(info, dict) and isinstance(info.get("Config"), dict) else {}
    return str(config.get("Image") or fallback) or fallback


HOG_DESKTOP = "org.hog.Browser.desktop"
DESKTOP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.desktop$")


def wallet_dir(path=None):
    if path is not None:
        return Path(path).resolve()
    return Path(os.environ.get("HOG_DATA", Path.home() / ".local" / "share" / "hog-browser")).resolve()


def valid_name(name):
    return bool(NAME_RE.fullmatch(str(name or "")))


def valid_image(image):
    text = str(image or "")
    return bool(IMAGE_RE.fullmatch(text)) and ".." not in text and not text.startswith("-")


def valid_desktop_id(value):
    text = str(value or "").strip()
    return bool(DESKTOP_ID_RE.fullmatch(text)) and ".." not in text and "/" not in text and "\\" not in text


def hog_desktop_paths():
    home = Path.home() / ".local" / "share" / "applications" / HOG_DESKTOP
    return (
        Path("/usr/share/applications") / HOG_DESKTOP,
        home,
    )


def hog_desktop_installed():
    return any(path.is_file() for path in hog_desktop_paths())



def image_brings_command(image):
    text = str(image or "").lower()
    return "wireguard" in text or "tailscale" in text or "cartesi" in text or "jellyfin" in text


SHARE_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,24}$")
SHARE_PORTS = range(8101, 8117)
SERVE_ENABLE_RE = re.compile(r"https://login\.tailscale\.com/[A-Za-z0-9_./?=&%-]+")
GRO_WARNING_RE = re.compile(
    r"Warning: UDP GRO forwarding is suboptimally configured on \S+, "
    r"UDP forwarding throughput capability will increase with a configuration change\. "
    r"See https://tailscale\.com/s/ethtool-config-udp-gro\s*",
    re.IGNORECASE,
)
LOGGED_IN_STATES = {"Running", "NeedsMachineAuth"}


def scrub_tailscale_output(text):
    return GRO_WARNING_RE.sub("", str(text or "")).strip()


def tailscale_auth_url(*parts):
    for part in parts:
        if not part:
            continue
        match = SERVE_ENABLE_RE.search(str(part))
        if not match:
            continue
        url = match.group(0)
        if len(url) < 30 or len(url) >= 300 or any(ch.isspace() for ch in url):
            continue
        return url
    return ""


def allowed_tailscale_open_url(url):
    """Return a login.tailscale.com https URL hog may open, else empty."""
    text = str(url or "").strip()
    if not text or len(text) < 30 or len(text) >= 300 or any(ch.isspace() for ch in text):
        return ""
    parsed = urllib.parse.urlparse(text)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host != "login.tailscale.com":
        return ""
    if parsed.username or parsed.password or parsed.fragment or parsed.port not in (None, 443):
        return ""
    return text


def allowed_browser_open_url(url):
    """Return an http(s) URL Hog may open from the desktop or CLI, else empty.

    Rejects file:, javascript:, data:, and other schemes so Hog can register as
    a default browser without opening local files or script URLs from argv.
    """
    text = str(url or "").strip()
    if not text or len(text) < 8 or len(text) >= 2000 or any(ch.isspace() for ch in text):
        return ""
    parsed = urllib.parse.urlparse(text)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return ""
    host = (parsed.hostname or "").strip("[]").lower()
    if not host:
        return ""
    if parsed.username or parsed.password:
        return ""
    if host in ("metadata.google.internal", "169.254.169.254"):
        return ""
    return text


def shares_root():
    return Path.home() / "hog-shares"


def assign_share_port(used):
    taken = {int(port) for port in used}
    for port in SHARE_PORTS:
        if port not in taken:
            return port
    return 0


def folder_problem(path, data, home=None):
    home = (home or Path.home()).resolve()
    if path is None:
        return "Choose a folder on this computer."
    try:
        path = path.resolve()
    except OSError:
        return "Choose a folder on this computer."
    if not path.is_dir():
        return "Choose a folder on this computer."
    if path in {home, Path("/")}:
        return "Pick one folder, not your whole home."
    media_root = Path("/run/media")
    if path in {Path("/mnt"), Path("/media"), media_root}:
        return "Pick one folder on that drive."
    under_run_media = media_root in path.parents
    if not under_run_media and mount_problem(str(path), data):
        return "That folder cannot be shared."
    roots = (home, Path("/mnt"), Path("/media"), media_root)
    if not any(root in path.parents for root in roots):
        return "Pick a folder inside your home, or a drive under /mnt or /media."
    try:
        if _inside(path, data) or _inside(data, path):
            return "That folder cannot be shared."
    except OSError:
        return "That folder cannot be shared."
    return ""


def drop_file_path(uri):
    text = str(uri or "").strip()
    if not text or len(text) > 500 or any(ch in text for ch in ("\x00", "\n", "\r")):
        return None
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or parsed.fragment:
        return None
    path = urllib.parse.unquote(parsed.path)
    if not path.startswith("/") or "\x00" in path:
        return None
    return Path(path)


def safe_drop_name(name):
    text = str(name or "")
    if not text or text in {".", ".."} or "/" in text or "\\" in text or "\x00" in text or len(text) > 180:
        return ""
    return text


def drop_destination(root, name):
    clean = safe_drop_name(name)
    if not clean:
        return None
    root = root.resolve()
    candidate = root / clean
    if candidate.exists():
        stem = Path(clean).stem
        suffix = Path(clean).suffix
        candidate = None
        for number in range(2, 500):
            nxt = root / f"{stem}-{number}{suffix}"
            if not nxt.exists():
                candidate = nxt
                break
        if candidate is None:
            return None
    if candidate.parent.resolve() != root:
        return None
    return candidate


def drop_source_problem(path, data, home=None, root=None):
    if path.is_symlink():
        return "That file cannot be added."
    try:
        path = path.resolve()
    except OSError:
        return "That file cannot be added."
    if not path.exists():
        return "That file cannot be added."
    try:
        root = (root or shares_root()).resolve()
    except OSError:
        return "That file cannot be added."
    if path == root or root in path.parents:
        return "That file is already in the Jellyfin folder."
    if path.is_dir():
        return folder_problem(path, data, home=home)
    if not path.is_file():
        return "That file cannot be added."
    # One file copied out of the home folder is not a share of the whole home.
    home = (home or Path.home()).resolve()
    if path.parent == home:
        try:
            if _inside(path, data) or _inside(data, path):
                return "That file cannot be added."
        except OSError:
            return "That file cannot be added."
        return ""
    return folder_problem(path.parent, data, home=home)


def format_bytes(size):
    size = max(0, int(size))
    if size < 1024:
        return f"{size} B"
    value = float(size)
    for unit in ("KB", "MB", "GB", "TB"):
        value /= 1024
        if value < 1024 or unit == "TB":
            text = f"{value:.1f}".rstrip("0").rstrip(".")
            return f"{text} {unit}"
    return f"{size} B"


def library_folder(root, relative):
    try:
        base = Path(root)
        base = base.resolve() if base.exists() else base.absolute()
    except OSError:
        return None
    text = str(relative or "").strip().strip("/")
    if not text:
        return base
    if text.startswith("/") or "\\" in text or "\x00" in text or len(text) > 500 or not base.is_dir():
        return None
    current = base
    for part in text.split("/"):
        if part != safe_drop_name(part) or part.startswith("."):
            return None
        nxt = current / part
        try:
            if nxt.is_symlink() or not nxt.is_dir():
                return None
            resolved = nxt.resolve()
        except OSError:
            return None
        if resolved.parent != current:
            return None
        current = resolved
    return current


def library_entry(root, relative):
    text = str(relative or "").strip().strip("/")
    if not text or "\\" in text or "\x00" in text or len(text) > 500:
        return None
    parent_rel, _, name = text.rpartition("/")
    if name != safe_drop_name(name) or name.startswith("."):
        return None
    parent = library_folder(root, parent_rel)
    if parent is None or not parent.is_dir():
        return None
    target = parent / name
    try:
        if target.is_symlink() or not target.exists():
            return None
        resolved = target.resolve()
    except OSError:
        return None
    if resolved.parent != parent:
        return None
    return parent_rel, resolved


def folder_item_count(path):
    count = 0
    try:
        for child in path.iterdir():
            if child.name.startswith(".") or child.is_symlink():
                continue
            count += 1
            if count >= 100:
                break
    except OSError:
        return 0
    return count


def media_listing(root):
    try:
        root = Path(root).resolve()
    except OSError:
        return []
    if not root.is_dir():
        return []
    rows = []
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    for child in children:
        if child.name.startswith(".") or child.is_symlink():
            continue
        try:
            info = child.stat()
            if child.is_dir():
                rows.append({
                    "name": child.name,
                    "kind": "folder",
                    "bytes": 0,
                    "size": "Folder",
                    "items": folder_item_count(child),
                })
            elif child.is_file():
                rows.append({
                    "name": child.name,
                    "kind": "file",
                    "bytes": info.st_size,
                    "size": format_bytes(info.st_size),
                })
        except OSError:
            continue
        if len(rows) >= 300:
            break
    rows.sort(key=lambda row: (row["kind"] != "folder", row["name"].casefold()))
    return rows


def remove_media_entry(root, relative):
    found = library_entry(root, relative)
    if found is None:
        return "That file is not in the library."
    _parent, target = found
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError:
        return "That file could not be removed."
    return ""


def copy_dropped_item(source, dest):
    if source.is_symlink():
        return False
    if source.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            if dest.parent.stat().st_dev == source.stat().st_dev:
                os.link(source, dest)
                return True
        except OSError:
            pass
        shutil.copy2(source, dest, follow_symlinks=False)
        return True
    if not source.is_dir():
        return False
    dest.mkdir()
    try:
        os.chmod(dest, 0o755)
    except OSError:
        pass
    for child in source.iterdir():
        if child.name.startswith(".") or child.is_symlink():
            continue
        copy_dropped_item(child, dest / child.name)
    return True


def take_drop(blob, root, data, home=None):
    copied = []
    skipped = 0
    reason = ""
    lines = [line.strip() for line in str(blob or "").splitlines() if line.strip()]
    if len(lines) > 200:
        return copied, skipped, "Drop fewer files at once."
    root.mkdir(parents=True, exist_ok=True)
    for line in lines:
        path = drop_file_path(line)
        if path is None:
            skipped += 1
            reason = reason or "Drop files from this computer."
            continue
        problem = drop_source_problem(path, data, home=home, root=root)
        if problem:
            skipped += 1
            reason = reason or problem
            continue
        dest = drop_destination(root, path.name)
        if dest is None:
            skipped += 1
            reason = reason or "That file cannot be added."
            continue
        try:
            if not copy_dropped_item(path, dest):
                skipped += 1
                reason = reason or "That file cannot be added."
                continue
        except OSError:
            skipped += 1
            reason = reason or "That file cannot be added."
            continue
        copied.append(dest.name)
    if copied:
        return copied, skipped, ""
    return copied, skipped, reason


def clean_share_path(text):
    raw = str(text or "").strip()
    if not raw.startswith("/") or "\x00" in raw or ".." in Path(raw).parts:
        return None
    try:
        return Path(raw).resolve()
    except OSError:
        return None


def ipv4_parts(text):
    if not re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", str(text or "")):
        return None
    parts = tuple(int(part) for part in str(text).split("."))
    if any(part > 255 for part in parts):
        return None
    return parts


def private_ipv4(text):
    parts = ipv4_parts(text)
    if not parts:
        return False
    first, second = parts[0], parts[1]
    if first == 10:
        return True
    if first == 172 and 16 <= second <= 31:
        return True
    return first == 192 and second == 168


def public_ipv4(text):
    parts = ipv4_parts(text)
    if not parts or private_ipv4(text):
        return False
    return parts[0] not in {0, 127, 169, 255}


def endpoint_value(text):
    host, sep, port = str(text or "").partition(":")
    if sep != ":" or port != "51820" or not ipv4_parts(host):
        return ""
    return f"{host}:51820"


def replace_endpoint(text, endpoint):
    endpoint = endpoint_value(endpoint)
    if not endpoint or not isinstance(text, str) or "\x00" in text or len(text) > 100_000:
        return None
    if not re.search(r"^PrivateKey\s*=", text, re.M):
        return None
    found = False
    out = []
    for line in text.splitlines():
        if re.match(r"^Endpoint\s*=", line):
            if found:
                return None
            out.append(f"Endpoint = {endpoint}")
            found = True
        else:
            out.append(line)
    if not found:
        return None
    body = "\n".join(out)
    if text.endswith("\n"):
        body += "\n"
    return body


def format_publish(port):
    bind, host, dest, proto = port
    spec = f"{host}:{dest}/{proto}"
    if bind:
        spec = f"{bind}:{spec}"
    return spec


def compose_run(name, image, ports=(), vpn=False, command=("sleep", "infinity"), env=(), sysctls=(), mounts=(), network="", gpus=False):
    args = ["run", "-d", "--name", name, "--cap-drop=ALL"]
    args.extend(f"--cap-add={cap}" for cap in SSH_CAPS)
    if vpn:
        args.append("--cap-add=NET_ADMIN")
        args.extend(["--device", "/dev/net/tun"])
    args.extend(["--pids-limit", "1024", "--memory", "2g", "--memory-swap", "2g"])
    if gpus:
        args.extend(["--gpus", "all"])
    if network:
        args.extend(["--network", network])
    if network not in HOST_MODES:
        for port in ports:
            args.extend(["-p", format_publish(port)])
        for item in sysctls:
            args.extend(["--sysctl", item])
    for item in env:
        args.extend(["-e", item])
    for mount in mounts:
        args.extend(["-v", mount])
    args.append(image)
    if command is None:
        command = ("sleep", "infinity")
    args.extend(command)
    return args


def canonical_command(name, image, ports, vpn, command, env=(), sysctls=(), mounts=(), network=""):
    return shlex.join(["docker", *compose_run(name, image, ports, vpn, command, env, sysctls, mounts, network)])


def launch_args(preset, image=""):
    return compose_run(preset["name"], image or preset["image"])


class CommandError(Exception):
    pass


def _port_number(value):
    number = int(value)
    if number < 1 or number > 65535:
        raise CommandError("Use a port from 1 to 65535.")
    return str(number)


def _ipv4(value):
    parts = str(value).split(".")
    if len(parts) != 4:
        raise CommandError("Use a port like 51820:51820/udp.")
    numbers = []
    for part in parts:
        if not part.isdigit() or int(part) > 255:
            raise CommandError("Use a port like 51820:51820/udp.")
        numbers.append(str(int(part)))
    return ".".join(numbers)


def parse_publish(text):
    match = PUBLISH_RE.fullmatch(str(text or "").strip())
    if match is None:
        raise CommandError("Use a port like 51820:51820/udp.")
    bind = _ipv4(match.group("bind")) if match.group("bind") else ""
    proto = match.group("proto") or "tcp"
    return bind, _port_number(match.group("host")), _port_number(match.group("dest")), proto


def parse_run(cmdline):
    if len(str(cmdline or "")) > MAX_COMMAND:
        raise CommandError("That command is too long.")
    try:
        tokens = shlex.split(str(cmdline or ""))
    except ValueError as exc:
        raise CommandError("That command could not be read.") from exc
    if len(tokens) < 3 or tokens[0] != "docker" or tokens[1] != "run":
        raise CommandError("The command has to start with docker run.")
    name = ""
    ports = []
    env = []
    sysctls = []
    vpn = False
    tun = False
    network = ""
    positional = []
    index = 2
    while index < len(tokens):
        token = tokens[index]
        if token in {"-d", "--detach"}:
            index += 1
            continue
        if token in {"--privileged", "-v", "--volume", "--mount", "--volumes-from"}:
            raise CommandError("That flag is not available.")
        if token.startswith(("-v", "--volume=", "--mount=", "--volumes-from=")):
            raise CommandError("Mounts are not available from this launcher.")
        if token in {"--pid", "--ipc"}:
            raise CommandError("That flag is not available.")
        if token.startswith(("--pid=", "--ipc=")):
            raise CommandError("That flag is not available.")
        if token in {"--network", "--net"} or token.startswith(("--network=", "--net=")):
            if token in {"--network", "--net"}:
                if index + 1 >= len(tokens):
                    raise CommandError("That flag is not available.")
                mode = tokens[index + 1]
                index += 2
            else:
                mode = token.split("=", 1)[1]
                index += 1
            if mode != TAILSCALE_NETWORK or network:
                raise CommandError("That flag is not available.")
            network = mode
            continue
        if token in {"--cap-add"}:
            if index + 1 >= len(tokens):
                raise CommandError("That capability is not available.")
            cap = tokens[index + 1].upper().removeprefix("CAP_")
            if cap == "NET_ADMIN":
                vpn = True
            elif cap not in SSH_CAPS:
                raise CommandError(f"{cap} is not available.")
            index += 2
            continue
        if token.startswith("--cap-add="):
            cap = token.split("=", 1)[1].upper().removeprefix("CAP_")
            if cap == "NET_ADMIN":
                vpn = True
            elif cap not in SSH_CAPS:
                raise CommandError(f"{cap} is not available.")
            index += 1
            continue
        if token in {"--cap-drop"}:
            if index + 1 >= len(tokens) or tokens[index + 1].upper() not in {"ALL", "CAP_ALL"}:
                raise CommandError("That flag is not available.")
            index += 2
            continue
        if token.startswith("--cap-drop=") and token.split("=", 1)[1].upper() in {"ALL", "CAP_ALL"}:
            index += 1
            continue
        if token == "--device":
            if index + 1 >= len(tokens) or tokens[index + 1] != "/dev/net/tun":
                raise CommandError("The only device available is /dev/net/tun.")
            tun = True
            index += 2
            continue
        if token.startswith("--device="):
            if token.split("=", 1)[1] != "/dev/net/tun":
                raise CommandError("The only device available is /dev/net/tun.")
            tun = True
            index += 1
            continue
        if token in {"-p", "--publish"}:
            if index + 1 >= len(tokens):
                raise CommandError("Use a port like 51820:51820/udp.")
            ports.append(parse_publish(tokens[index + 1]))
            index += 2
            continue
        if token.startswith("--publish="):
            ports.append(parse_publish(token.split("=", 1)[1]))
            index += 1
            continue
        if token.startswith("-p") and token != "-p":
            ports.append(parse_publish(token[2:]))
            index += 1
            continue
        if positional:
            positional.append(token)
            index += 1
            continue
        if token == "--name":
            if index + 1 >= len(tokens):
                raise CommandError("Use a plain container name.")
            name = tokens[index + 1]
            index += 2
            continue
        if token.startswith("--name="):
            name = token.split("=", 1)[1]
            index += 1
            continue
        if token in {"--pids-limit", "--memory", "--memory-swap"}:
            if index + 1 >= len(tokens):
                raise CommandError("That flag is not available.")
            index += 2
            continue
        if token.startswith(("--pids-limit=", "--memory=", "--memory-swap=")):
            index += 1
            continue
        if token in {"-e", "--env"} or token.startswith("--env="):
            if token in {"-e", "--env"}:
                if index + 1 >= len(tokens):
                    raise CommandError("That environment value is not available.")
                value = tokens[index + 1]
                index += 2
            else:
                value = token.split("=", 1)[1]
                index += 1
            if not ENV_RE.fullmatch(value or ""):
                raise CommandError("That environment value is not available.")
            env.append(value)
            continue
        if token == "--sysctl" or token.startswith("--sysctl="):
            if token == "--sysctl":
                if index + 1 >= len(tokens):
                    raise CommandError("That sysctl is not available.")
                value = tokens[index + 1]
                index += 2
            else:
                value = token.split("=", 1)[1]
                index += 1
            if value not in SYSCTLS:
                raise CommandError("That sysctl is not available.")
            sysctls.append(value)
            continue
        if token.startswith("-"):
            raise CommandError(f"{token} is not available.")
        positional.append(token)
        index += 1
    if not positional:
        raise CommandError("The command needs an image.")
    image = positional[0]
    command = positional[1:]
    if not command and not image_brings_command(image):
        command = ["sleep", "infinity"]
    if not valid_name(name):
        raise CommandError("Use a plain container name.")
    if not valid_image(image):
        raise CommandError("Use an image like ubuntu:24.04.")
    if len(ports) > MAX_PORTS:
        raise CommandError("Eight ports is the limit.")
    if len(env) > MAX_ENV:
        raise CommandError("That command has too many environment values.")
    if any(not COMMAND_RE.fullmatch(part) for part in command):
        raise CommandError("The container command can only be plain words.")
    if tun and not vpn:
        raise CommandError("The tun device needs NET_ADMIN.")
    if network:
        if name != "tailscale" or "tailscale" not in image.lower() or network != TAILSCALE_NETWORK:
            raise CommandError("That flag is not available.")
    return name, image, tuple(ports), vpn, tuple(command), tuple(env), tuple(sysctls), (), network


def strip_ascii_qr(text):
    plain = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", str(text or ""))
    blocks = set("█▀▄▌▐░▒▓ ═║╔╗╚╝─│┌┐└┘")
    kept = []
    for line in plain.splitlines():
        body = line.strip()
        if len(body) >= 20 and set(body) <= blocks:
            continue
        kept.append(line)
    return "\n".join(kept)


def docker_offline(text):
    lowered = str(text or "").lower()
    marks = ("cannot connect", "failed to connect", "dial unix", "is the docker daemon running")
    return any(mark in lowered for mark in marks)


def _inside(outer, inner):
    outer = outer.resolve()
    inner = inner.resolve()
    return outer == inner or outer in inner.parents or inner in outer.parents


def docker_volume_data(text):
    prefix = "/var/lib/docker/volumes/"
    suffix = "/_data"
    if not text.startswith(prefix) or not text.endswith(suffix):
        return False
    name = text[len(prefix):-len(suffix)]
    if not name or "/" in name or name in {".", ".."} or name.startswith("."):
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}", name))


def mount_problem(source, data):
    text = str(source or "")
    lowered = text.lower()
    if any(mark in lowered for mark in SOCK_MARKERS):
        return "It mounts a container socket."
    # Jellyfin's own /config and /cache volumes live here. One volume's data
    # directory is not the Docker store. The store itself stays blocked.
    if docker_volume_data(text):
        return ""
    if "/var/lib/docker" in lowered or lowered.rstrip("/") in {"/var/lib/docker", "/var/lib/containerd"}:
        return "It mounts the Docker data directory."
    if not text.startswith("/"):
        return ""
    path = Path(text)
    if nvidia_device_path(text):
        return ""
    if path == Path("/") or path.parts[1:2] and path.parts[1] in {"proc", "sys", "dev", "run"}:
        return "It mounts a host system directory."
    if str(path) in {"/var/run", "/run"}:
        return "It mounts a host system directory."
    try:
        if _inside(path, data):
            return "It can see the wallet files."
    except OSError:
        return "It has a mount Hog cannot check."
    return ""


def bind_source(bind):
    text = str(bind or "")
    if not text.startswith("/"):
        return text
    rest = text[1:]
    if ":" in rest:
        return "/" + rest.split(":", 1)[0]
    return text


def assess(info, name, data):
    if not valid_name(name):
        return "Use a plain container name."
    if not isinstance(info, dict):
        return "Docker did not describe that container."
    reported = str(info.get("Name") or "").lstrip("/")
    if reported and reported != name:
        return "That name does not match the container."
    host = info.get("HostConfig") if isinstance(info.get("HostConfig"), dict) else {}
    if host.get("Privileged") is True:
        return "That container is privileged."
    for key in ("NetworkMode", "PidMode", "IpcMode", "UTSMode", "CgroupnsMode", "UsernsMode"):
        mode = str(host.get(key) or "")
        if mode == "host" or mode.startswith("container:"):
            return "That container shares the host or another container."
    caps = host.get("CapAdd") or []
    if isinstance(caps, list) and any(str(cap).upper() in BAD_CAPS for cap in caps):
        return "That container adds a powerful capability."
    sources = []
    for bind in host.get("Binds") or []:
        sources.append(bind_source(bind))
    for mount in info.get("Mounts") or []:
        if isinstance(mount, dict):
            blob = " ".join(str(mount.get(key) or "") for key in ("Source", "Destination", "Name"))
            if any(mark in blob.lower() for mark in SOCK_MARKERS):
                return "It mounts a container socket."
            sources.append(str(mount.get("Source") or ""))
    for device in host.get("Devices") or []:
        if isinstance(device, dict):
            source = str(device.get("PathOnHost") or "")
            if source == "/dev/net/tun" or nvidia_device_path(source):
                continue
            sources.append(source)
    for source in sources:
        problem = mount_problem(source, data)
        if problem:
            return problem
    return ""


class Guard:
    def __init__(self, data_dir, docker="docker", engine_cmd=None, origin="http://127.0.0.1:4188"):
        self.data = wallet_dir(data_dir)
        self.docker = docker
        self.engine_cmd = list(engine_cmd or ENGINE_START)
        self.path = self.data / "containers.json"
        from shell import ShellHost
        self.shell = ShellHost(self.data, docker=self.docker, origin=origin)

    def read_names(self):
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        names = raw.get("names") if isinstance(raw, dict) else None
        if not isinstance(names, list):
            return []
        return [name for name in names if valid_name(name)]

    def write_names(self, names):
        self.data.mkdir(parents=True, exist_ok=True)
        blob = json.dumps({"names": names}, indent=2) + "\n"
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(blob, encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)
        os.chmod(self.path, 0o600)

    def run(self, args, timeout=8):
        try:
            return self.run_argv([self.docker, *args], timeout=timeout)
        except FileNotFoundError as exc:
            raise RuntimeError("Docker is not installed.") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Docker took too long.") from exc

    def run_argv(self, args, timeout=8, env=None):
        kwargs = {
            "capture_output": True,
            "text": True,
            "timeout": timeout,
            "check": False,
        }
        if env is not None:
            kwargs["env"] = env
        return subprocess.run(list(args), **kwargs)

    def run_on(self, args, timeout=8, sock=None):
        argv = [self.docker, *args]
        if sock:
            try:
                return self.run_argv(argv, timeout=timeout, env=docker_host_env(sock))
            except FileNotFoundError as exc:
                raise RuntimeError("Docker is not installed.") from exc
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("Docker took too long.") from exc
        return self.run(args, timeout=timeout)

    def gpu_state_path(self):
        return self.data / "jellyfin-gpu.json"

    def read_gpu_state(self):
        try:
            raw = json.loads(self.gpu_state_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        desktop = raw.get("desktopVolumes") if isinstance(raw.get("desktopVolumes"), dict) else {}
        engine = raw.get("engineVolumes") if isinstance(raw.get("engineVolumes"), dict) else {}
        return {
            "enabled": bool(raw.get("enabled")),
            "desktopVolumes": {
                "config": str(desktop.get("config") or ""),
                "cache": str(desktop.get("cache") or ""),
            },
            "engineVolumes": {
                "config": str(engine.get("config") or ""),
                "cache": str(engine.get("cache") or ""),
            },
        }

    def write_gpu_state(self, enabled=None, desktop_volumes=None, engine_volumes=None):
        state = self.read_gpu_state()
        if enabled is not None:
            state["enabled"] = bool(enabled)
        if desktop_volumes:
            state["desktopVolumes"].update({key: value for key, value in desktop_volumes.items() if value})
        if engine_volumes:
            state["engineVolumes"].update({key: value for key, value in engine_volumes.items() if value})
        self.data.mkdir(parents=True, exist_ok=True)
        path = self.gpu_state_path()
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        os.chmod(path, 0o600)
        return state

    def gpu_enabled(self):
        return self.read_gpu_state()["enabled"]

    def engine_sock(self):
        return ENGINE_DOCKER_SOCK

    def desktop_sock(self):
        return DESKTOP_DOCKER_SOCK if DESKTOP_DOCKER_SOCK.exists() else None

    def container_sock(self, name=""):
        if str(name or "") == "jellyfin" and self.gpu_enabled():
            return self.engine_sock()
        return None

    def docker_info_on(self, sock, timeout=4):
        if not sock:
            return None
        try:
            result = self.run_on(["info", "--format", "{{json .}}"], timeout=timeout, sock=sock)
        except RuntimeError:
            return None
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0 or docker_offline(blob):
            return None
        try:
            payload = json.loads((result.stdout or "").strip() or "null")
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def _socket_usable(self, path):
        try:
            return Path(path).exists() and Path(path).is_socket()
        except OSError:
            return False

    def _same_socket(self, first, second):
        if not first or not second:
            return False
        try:
            return os.path.samefile(first, second)
        except OSError:
            return False

    def _nvidia_smi(self):
        try:
            result = subprocess.run(
                ["nvidia-smi"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return False, ""
        if result.returncode != 0:
            return False, ""
        return True, parse_nvidia_gpu_name(result.stdout or "")

    def _nvidia_ctk_installed(self):
        return bool(shutil.which("nvidia-ctk"))

    def _native_engine_status(self):
        sock = self.engine_sock()
        desktop = self.desktop_sock()
        status = {
            "ok": False,
            "installed": False,
            "running": False,
            "permission": True,
            "info": None,
        }
        if not self._socket_usable(sock) or self._same_socket(sock, desktop):
            return status
        status["installed"] = True
        try:
            result = self.run_on(["info", "--format", "{{json .}}"], timeout=4, sock=sock)
        except RuntimeError:
            return status
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        lowered = blob.lower()
        if "permission denied" in lowered:
            status["permission"] = False
            return status
        if result.returncode != 0 or docker_offline(blob):
            return status
        try:
            info = json.loads((result.stdout or "").strip() or "null")
        except json.JSONDecodeError:
            info = None
        if not isinstance(info, dict) or is_desktop_engine(info):
            return status
        status["running"] = True
        status["ok"] = True
        status["info"] = info
        return status

    def gpu_is_ready(self):
        return all(item.get("ok") for item in self.gpu_readiness())

    def gpu_readiness(self):
        nvidia_ok, gpu_name = self._nvidia_smi()
        engine = self._native_engine_status()
        toolkit_installed = self._nvidia_ctk_installed()
        toolkit_configured = bool(engine.get("ok") and nvidia_runtime_configured(engine.get("info")))
        in_group = engine.get("permission", True)
        nvidia_detail = "NVIDIA GPU and driver are ready"
        if nvidia_ok and gpu_name:
            nvidia_detail = f"NVIDIA GPU and driver are ready ({gpu_name})"
        elif nvidia_ok:
            nvidia_detail = "NVIDIA GPU and driver are ready (nvidia-smi works)"
        else:
            nvidia_detail = "Install an NVIDIA driver, then reboot if the installer asks you to."
        if engine.get("ok"):
            engine_detail = "Native Docker Engine is installed and running (separate from Docker Desktop)."
            engine_commands = []
        elif engine.get("installed") and not in_group:
            engine_detail = "Docker Engine is installed, but this user cannot use /var/run/docker.sock. Add the user to the docker group, then log out and back in."
            engine_commands = docker_group_commands()
        elif engine.get("installed"):
            engine_detail = "Docker Engine is installed but not running, or it is Docker Desktop's socket rather than docker-ce."
            engine_commands = ["sudo systemctl enable --now docker"]
        else:
            engine_detail = "Install Docker Engine (docker-ce) next to Docker Desktop, then add this user to the docker group and log out and back in."
            engine_commands = docker_engine_install_commands()
        if toolkit_installed and toolkit_configured:
            toolkit_detail = "NVIDIA Container Toolkit is installed and configured for Docker Engine."
            toolkit_commands = []
        elif toolkit_installed:
            toolkit_detail = "NVIDIA Container Toolkit is installed, but Docker Engine does not have the NVIDIA runtime yet."
            toolkit_commands = nvidia_toolkit_install_commands(configure_only=True)
        else:
            toolkit_detail = "Install the NVIDIA Container Toolkit and configure the Docker Engine runtime. Restarting docker-ce does not stop Docker Desktop containers."
            toolkit_commands = nvidia_toolkit_install_commands()
        return [
            {
                "id": "nvidia",
                "label": "NVIDIA GPU and driver",
                "ok": bool(nvidia_ok),
                "detail": nvidia_detail,
                "commands": [] if nvidia_ok else nvidia_driver_install_commands(),
            },
            {
                "id": "engine",
                "label": "Native Docker Engine",
                "ok": bool(engine.get("ok")),
                "detail": engine_detail,
                "commands": engine_commands,
            },
            {
                "id": "toolkit",
                "label": "NVIDIA Container Toolkit",
                "ok": bool(toolkit_installed and toolkit_configured),
                "detail": toolkit_detail,
                "commands": toolkit_commands,
            },
        ]

    def jellyfin_gpu_fields(self):
        checks = self.gpu_readiness()
        can_install, _reason = self.toolkit_helper_status()
        return {
            "jellyfinGpu": self.gpu_enabled(),
            "jellyfinGpuReady": all(item.get("ok") for item in checks),
            "jellyfinGpuChecks": checks,
            "jellyfinGpuCanInstall": bool(can_install),
        }

    def toolkit_helper_status(self):
        return nvidia_toolkit_helper_status()

    def install_nvidia_toolkit(self):
        can_install, reason = self.toolkit_helper_status()
        if not can_install:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = reason
            payload["jellyfinGpuInstallLog"] = ""
            payload["jellyfinGpuCanInstall"] = False
            return payload
        checks = {item.get("id"): item for item in self.gpu_readiness()}
        toolkit = checks.get("toolkit") or {}
        if toolkit.get("ok"):
            payload = self.engine_status()
            payload["notice"] = "The NVIDIA Container Toolkit is already installed and configured."
            payload["jellyfinGpuInstallLog"] = ""
            return payload
        try:
            result = self.run_argv(
                ["pkexec", str(NVIDIA_TOOLKIT_HELPER)],
                timeout=NVIDIA_TOOLKIT_INSTALL_TIMEOUT,
            )
        except FileNotFoundError:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = (
                "pkexec is not installed, so Hog cannot open a password prompt. "
                "Copy the commands below, or install pkexec (policykit-1)."
            )
            payload["jellyfinGpuInstallLog"] = ""
            payload["jellyfinGpuCanInstall"] = False
            return payload
        except subprocess.TimeoutExpired as exc:
            output = f"{getattr(exc, 'stdout', '') or ''}{getattr(exc, 'stderr', '') or ''}".strip()
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "The toolkit install took too long. Copy the commands below, or try again."
            payload["jellyfinGpuInstallLog"] = output[-8000:]
            return payload
        log = f"{result.stdout or ''}{result.stderr or ''}".strip()
        payload = self.engine_status()
        payload["jellyfinGpuInstallLog"] = log[-8000:]
        ready = any(item.get("id") == "toolkit" and item.get("ok") for item in payload.get("jellyfinGpuChecks") or [])
        if result.returncode == 0 and ready:
            payload["notice"] = (
                "NVIDIA Container Toolkit is installed and configured for Docker Engine. "
                "You can turn on GPU acceleration."
            )
            payload["error"] = ""
            return payload
        if result.returncode in {126, 127}:
            payload["ok"] = False
            payload["error"] = (
                "The password prompt was dismissed or pkexec could not start the installer. "
                "Try again, or copy the commands below."
            )
            return payload
        payload["ok"] = False
        if result.returncode == 0 and not ready:
            payload["error"] = (
                "The installer finished, but the toolkit check is still not ready. "
                "See the log, or copy the commands below."
            )
        else:
            detail = log.strip().splitlines()
            message = detail[-1][:180] if detail else "The toolkit install did not finish."
            payload["error"] = f"{message} See the log, or copy the commands below."
        return payload

    def _attach_gpu(self, payload):
        if not isinstance(payload, dict):
            return payload
        try:
            payload.update(self.jellyfin_gpu_fields())
        except Exception:
            payload.setdefault("jellyfinGpu", self.gpu_enabled())
            payload.setdefault("jellyfinGpuReady", False)
            payload.setdefault("jellyfinGpuChecks", [])
        return payload

    def inspect_on(self, name, sock=None):
        try:
            result = self.run_on(["inspect", name], sock=sock)
        except RuntimeError as exc:
            return None, str(exc)
        if result.returncode != 0:
            blob = f"{result.stderr or ''}\n{result.stdout or ''}"
            if docker_offline(blob):
                return None, "Docker is not running."
            detail = blob.strip().splitlines()
            return None, detail[-1][:180] if detail else "Docker did not find that container."
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return None, "Docker returned an unreadable description."
        if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
            return None, "Docker returned an unreadable description."
        return payload[0], ""

    def container_run(self, name, args, timeout=8):
        sock = self.container_sock(name)
        if sock is not None:
            return self.run_on(args, timeout=timeout, sock=sock)
        return self.run(args, timeout=timeout)

    def jellyfin_volume_names(self, info=None, side="desktop"):
        state = self.read_gpu_state()
        saved = state["desktopVolumes" if side == "desktop" else "engineVolumes"]
        config = saved.get("config") or JELLYFIN_CONFIG_VOLUME
        cache = saved.get("cache") or JELLYFIN_CACHE_VOLUME
        found = jellyfin_volume_map(info)
        if found.get("config"):
            config = found["config"]
        if found.get("cache"):
            cache = found["cache"]
        return {"config": config, "cache": cache}

    def save_jellyfin_volumes(self, info, side="desktop"):
        found = jellyfin_volume_map(info)
        if not found:
            return
        if side == "engine":
            self.write_gpu_state(engine_volumes=found)
        else:
            self.write_gpu_state(desktop_volumes=found)

    def jellyfin_mounts(self, info=None, side="desktop"):
        root = shares_root()
        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o755)
        volumes = self.jellyfin_volume_names(info, side=side)
        return (
            f"{root.resolve()}:/media:ro",
            f"{volumes['config']}:/config",
            f"{volumes['cache']}:/cache",
        )

    def _stop_rm_keep_volumes(self, name, sock=None):
        info, error = self.inspect_on(name, sock=sock)
        if info is None:
            if error == "Docker is not running.":
                return error
            return ""
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        runner = (lambda args, timeout=30: self.run_on(args, timeout=timeout, sock=sock)) if sock is not None else (
            lambda args, timeout=30: self.run(args, timeout=timeout)
        )
        if state.get("Running") is True:
            stopped = runner(["stop", name], 40)
            if stopped.returncode != 0:
                detail = f"{stopped.stderr or ''}\n{stopped.stdout or ''}".strip().splitlines()
                return detail[-1][:180] if detail else "Docker did not stop that container."
        removed = runner(["rm", name], 30)
        if removed.returncode != 0:
            detail = f"{removed.stderr or ''}\n{removed.stdout or ''}".strip().splitlines()
            return detail[-1][:180] if detail else "Docker did not remove that container."
        return ""

    def _start_jellyfin_on(self, side, image="jellyfin/jellyfin:latest"):
        sock = self.engine_sock() if side == "engine" else None
        info, _error = self.inspect_on("jellyfin", sock=sock)
        if info is not None:
            config = info.get("Config") if isinstance(info.get("Config"), dict) else {}
            image = str(config.get("Image") or image) or image
            self.save_jellyfin_volumes(info, side=side)
        mounts = self.jellyfin_mounts(info, side=side)
        env = ()
        gpus = side == "engine"
        if gpus:
            env = (NVIDIA_VISIBLE_ENV, NVIDIA_CAPS_ENV)
        volumes = self.jellyfin_volume_names(info, side=side)
        if side == "engine":
            self.write_gpu_state(engine_volumes=volumes)
        else:
            self.write_gpu_state(desktop_volumes=volumes)
        args = compose_run(
            "jellyfin",
            image,
            (("127.0.0.1", "8096", "8096", "tcp"),),
            False,
            (),
            env,
            (),
            mounts,
            "",
            gpus=gpus,
        )
        result = self.run_on(args, timeout=300, sock=sock) if sock is not None else self.run(args, timeout=300)
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                return None, "Docker is not running."
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            return None, detail[-1][:180] if detail else "Docker did not start Jellyfin."
        started, error = self.inspect_on("jellyfin", sock=sock)
        reason = assess(started, "jellyfin", self.data) if started else (error or "Docker did not describe that container.")
        if reason:
            if sock is not None:
                self.run_on(["rm", "-f", "jellyfin"], timeout=20, sock=sock)
            else:
                self.run(["rm", "-f", "jellyfin"], timeout=20)
            return None, reason
        self.remember("jellyfin")
        return started, ""

    def set_jellyfin_gpu(self, enabled):
        enabled = bool(enabled)
        if enabled and not self.gpu_is_ready():
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "GPU acceleration needs the checks below to be ready first. Copy the install commands, then try again."
            return payload
        currently = self.gpu_enabled()
        if enabled == currently:
            payload = self.engine_status()
            payload["notice"] = (
                "Jellyfin is already using the NVIDIA GPU on Docker Engine."
                if enabled
                else "Jellyfin is already on Docker Desktop (CPU)."
            )
            return payload
        desktop_info, _desktop_error = self.inspect_on("jellyfin", sock=None)
        engine_info, _engine_error = self.inspect_on("jellyfin", sock=self.engine_sock())
        started = False
        if enabled:
            if desktop_info:
                self.save_jellyfin_volumes(desktop_info, side="desktop")
                problem = self._stop_rm_keep_volumes("jellyfin", sock=None)
                if problem:
                    payload = self.engine_status()
                    payload["ok"] = False
                    payload["error"] = problem
                    return payload
            self.write_gpu_state(enabled=True)
            if desktop_info or engine_info:
                _info, error = self._start_jellyfin_on(
                    "engine",
                    image=container_image(engine_info) if engine_info else container_image(desktop_info),
                )
                if error:
                    self.write_gpu_state(enabled=False)
                    payload = self.engine_status()
                    payload["ok"] = False
                    payload["error"] = error
                    return payload
                started = True
                notice = (
                    "Jellyfin is running on Docker Engine with the NVIDIA GPU. "
                    "In Jellyfin Dashboard → Playback → Transcoding, pick NVIDIA NVENC. "
                    "Login and libraries from Docker Desktop do not carry over; this engine has its own config volume. "
                    "~/hog-shares is the same folder. Tailscale stays on Docker Desktop and still reaches Jellyfin at host.docker.internal:8096."
                )
            else:
                notice = (
                    "GPU acceleration is on. Start Jellyfin and it will run on Docker Engine with the NVIDIA GPU. "
                    "Login and libraries from Docker Desktop do not carry over. "
                    "After it starts, in Dashboard → Playback → Transcoding pick NVIDIA NVENC."
                )
        else:
            if engine_info:
                self.save_jellyfin_volumes(engine_info, side="engine")
                problem = self._stop_rm_keep_volumes("jellyfin", sock=self.engine_sock())
                if problem:
                    payload = self.engine_status()
                    payload["ok"] = False
                    payload["error"] = problem
                    return payload
            self.write_gpu_state(enabled=False)
            if desktop_info or engine_info:
                _info, error = self._start_jellyfin_on(
                    "desktop",
                    image=container_image(desktop_info) if desktop_info else container_image(engine_info),
                )
                if error:
                    self.write_gpu_state(enabled=True)
                    payload = self.engine_status()
                    payload["ok"] = False
                    payload["error"] = error
                    return payload
                started = True
                notice = (
                    "Jellyfin is back on Docker Desktop (CPU). "
                    "Settings from this Desktop engine are reused when those volumes were kept. "
                    "GPU Engine settings stay on Docker Engine's volumes."
                )
            else:
                notice = "GPU acceleration is off. Start Jellyfin and it will run on Docker Desktop (CPU)."
        payload = self.engine_status()
        payload["notice"] = notice
        if started:
            dns, live = self.tailscale_dns()
            if live:
                problem, enable = self.publish_port(8096)
                if enable:
                    payload["enableUrl"] = enable
                elif problem:
                    payload["notice"] = f"{notice} {problem}"
        return payload

    def jellyfin_gpu_status(self):
        return self.engine_status()

    def docker_running(self):
        try:
            result = self.run(["info", "--format", "{{.ServerVersion}}"], timeout=4)
        except RuntimeError:
            return False
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0 or docker_offline(blob):
            return False
        return bool((result.stdout or "").strip())

    def _offline_items(self):
        return [
            {"name": name, "state": "unknown", "image": "", "reason": ""}
            for name in self.read_names()
        ]

    def engine_status(self):
        running = self.docker_running()
        items = self.items() if running else self._offline_items()
        jellyfin_up = any(
            isinstance(item, dict) and item.get("name") == "jellyfin" and item.get("state") == "running" and not item.get("reason")
            for item in items
        )
        url = ""
        ts_ip = ""
        ts_state = ""
        ts_login = ""
        ts_up = any(
            isinstance(item, dict) and item.get("name") == "tailscale" and item.get("state") == "running" and not item.get("reason")
            for item in items
        )
        if running and ts_up:
            try:
                ts_ip = self.tailscale_ipv4()
            except (RuntimeError, OSError):
                ts_ip = ""
            backend = self.tailscale_backend()
            ts_state = backend.get("state") or ""
            if ts_state == "NeedsLogin":
                ts_login = backend.get("loginUrl") or ""
            if jellyfin_up and ts_ip:
                try:
                    url = self.jellyfin_phone_url(ts_ip)
                except (RuntimeError, OSError):
                    url = ""
        media_path, media_rows = self.media_view()
        return self._attach_gpu({
            "ok": True,
            "error": "",
            "docker": running,
            "items": items,
            "wireguard": self.wireguard_module_loaded(),
            "jellyfinUrl": url,
            "tailscaleIp": ts_ip,
            "tailscaleState": ts_state,
            "tailscaleLoginUrl": ts_login,
            "media": media_rows,
            "mediaPath": media_path,
        })

    def start_engine(self, wait=90, pause=1.0):
        if self.docker_running():
            return self.engine_status()
        try:
            result = self.run_argv(self.engine_cmd, timeout=75)
        except FileNotFoundError:
            return {
                "ok": False,
                "error": "Docker Desktop is not installed.",
                "docker": False,
                "items": self._offline_items(),
            }
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "error": "Docker Desktop took too long to start.",
                "docker": False,
                "items": self._offline_items(),
            }
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Docker Desktop did not start.").strip().splitlines()
            message = detail[-1][:180] if detail else "Docker Desktop did not start."
            return {"ok": False, "error": message, "docker": False, "items": self._offline_items()}
        deadline = time.monotonic() + wait
        while True:
            if self.docker_running():
                return self.engine_status()
            if time.monotonic() >= deadline:
                break
            time.sleep(pause)
        return {
            "ok": False,
            "error": "Docker Desktop is starting. Try Ubuntu again in a moment.",
            "docker": False,
            "items": self._offline_items(),
        }

    def jellyfin_phone_url(self, ip=None):
        ip = ip or self.tailscale_ipv4()
        if not ip:
            return ""
        info, _error = self.inspect("jellyfin")
        state = info.get("State") if isinstance(info, dict) and isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True:
            return ""
        return f"http://{ip}:8096"

    def _mark_docker(self, payload):
        if "docker" not in payload:
            if payload.get("error") == "Docker is not running.":
                payload["docker"] = False
            elif payload.get("ok"):
                payload["docker"] = True
            else:
                payload["docker"] = self.docker_running()
        return self._attach_gpu(payload)

    def inspect(self, name):
        return self.inspect_on(name, sock=self.container_sock(name))

    def snapshot(self, name):
        info, error = self.inspect(name)
        if info is None:
            return {"name": name, "state": "missing", "image": "", "reason": error}
        reason = assess(info, name, self.data)
        state = ""
        if isinstance(info.get("State"), dict):
            state = str(info["State"].get("Status") or "")
        image = ""
        if isinstance(info.get("Config"), dict):
            image = str(info["Config"].get("Image") or "")
        return {"name": name, "state": state or "unknown", "image": image, "reason": reason}

    def remember(self, name):
        names = self.read_names()
        if name not in names:
            names.append(name)
            self.write_names(names)

    def forget(self, name):
        names = self.read_names()
        if name in names:
            self.write_names([item for item in names if item != name])

    def _ps_names(self, sock=None):
        try:
            if sock is not None:
                result = self.run_on(["ps", "-a", "--format", "{{.Names}}"], timeout=15, sock=sock)
            else:
                result = self.run(["ps", "-a", "--format", "{{.Names}}"], timeout=15)
        except RuntimeError:
            return None
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                return None
            return []
        names = []
        for line in (result.stdout or "").splitlines():
            name = line.strip().split(",")[0]
            if valid_name(name) and name not in names:
                names.append(name)
        return names

    def listed_names(self):
        names = self._ps_names()
        if names is None:
            return None
        if self.gpu_enabled():
            names = [name for name in names if name != "jellyfin"]
            engine_names = self._ps_names(sock=self.engine_sock())
            if engine_names:
                for name in engine_names:
                    if name == "jellyfin" and name not in names:
                        names.append(name)
        for name in self.read_names():
            if name not in names:
                names.append(name)
        return names

    def items(self):
        names = self.listed_names()
        if names is None:
            return self._offline_items()
        return [self.snapshot(name) for name in names]

    def capture(self, args, timeout=8):
        proc = subprocess.Popen(
            [self.docker, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        try:
            out, _ = proc.communicate(timeout=timeout)
            return out or "", proc.returncode or 0
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                out, _ = proc.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                out, _ = proc.communicate(timeout=2)
            return out or "", 124

    def shares_path(self):
        return self.data / "shares.json"

    def read_shares(self):
        try:
            raw = json.loads(self.shares_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        items = raw.get("shares") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            return []
        shares = []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            path = clean_share_path(item.get("path"))
            try:
                port = int(item.get("port") or 0)
            except (TypeError, ValueError):
                continue
            kind = item.get("kind") if item.get("kind") in {"computer", "network"} else ""
            if not SHARE_NAME_RE.fullmatch(name) or path is None or port not in SHARE_PORTS or not kind:
                continue
            shares.append({
                "name": name,
                "path": str(path),
                "port": port,
                "kind": kind,
                "pid": int(item.get("pid") or 0),
                "published": bool(item.get("published")),
            })
        return shares

    def write_shares(self, shares):
        self.data.mkdir(parents=True, exist_ok=True)
        blob = json.dumps({"shares": shares}, indent=2) + "\n"
        temporary = self.shares_path().with_suffix(".json.tmp")
        temporary.write_text(blob, encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.shares_path())
        os.chmod(self.shares_path(), 0o600)

    def tailscale_status_payload(self):
        try:
            result = self.run(["exec", "tailscale", "tailscale", "status", "--json"], timeout=15)
        except RuntimeError:
            return {}, ""
        blob = (result.stdout or "") + (result.stderr or "")
        try:
            raw = json.loads(result.stdout or "")
        except json.JSONDecodeError:
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        return raw, blob

    def tailscale_backend(self):
        raw, blob = self.tailscale_status_payload()
        return {
            "state": str(raw.get("BackendState") or ""),
            "loginUrl": tailscale_auth_url(raw.get("AuthURL") or "", blob),
        }

    def tailscale_dns(self):
        info, _error = self.inspect("tailscale")
        state = info.get("State") if isinstance(info, dict) and isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True:
            return "", False
        raw, _blob = self.tailscale_status_payload()
        if not raw:
            return "", True
        self_info = raw.get("Self") if isinstance(raw.get("Self"), dict) else None
        dns = str((self_info or {}).get("DNSName") or "").rstrip(".")
        if not dns or " " in dns or "/" in dns:
            return "", True
        return dns, True

    def tailscale_ipv4(self):
        info, _error = self.inspect("tailscale")
        state = info.get("State") if isinstance(info, dict) and isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True:
            return ""
        try:
            result = self.run(["exec", "tailscale", "tailscale", "ip", "-4"], timeout=8)
        except RuntimeError:
            return ""
        text = (result.stdout or "").strip()
        parts = ipv4_parts(text)
        if result.returncode != 0 or not parts or parts[0] != 100 or not 64 <= parts[1] <= 127:
            return ""
        return text

    def publish_port(self, port):
        # host.docker.internal reaches share_page.py and Jellyfin on this
        # computer from both a bridge container and Docker Desktop
        # --network host. Under Desktop, 127.0.0.1 is the engine VM, so
        # folder shares bound to the computer's loopback would miss it.
        port = int(port)
        host = "host.docker.internal"
        if port == 8096:
            self.capture(["exec", "tailscale", "tailscale", "serve", "--https=8096", "off"], timeout=10)
            args = ["exec", "tailscale", "tailscale", "serve", "--bg", "--yes", "--tcp=8096", f"tcp://{host}:8096"]
        else:
            args = ["exec", "tailscale", "tailscale", "serve", "--bg", f"--https={port}", f"http://{host}:{port}"]
        text, code = self.capture(args, timeout=8)
        match = SERVE_ENABLE_RE.search(text)
        if match:
            return "", match.group(0)
        if code != 0:
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            return (lines[-1][:180] if lines else "Tailscale did not publish that folder."), ""
        return "", ""

    def unpublish_port(self, port):
        port = int(port)
        if port == 8096:
            self.capture(["exec", "tailscale", "tailscale", "serve", "--tcp=8096", "off"], timeout=10)
        self.capture(
            ["exec", "tailscale", "tailscale", "serve", f"--https={port}", "off"],
            timeout=10,
        )

    def port_open(self, port):
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=0.3):
                return True
        except OSError:
            return False

    def share_server_alive(self, item):
        try:
            pid = int(item.get("pid") or 0)
        except (TypeError, ValueError):
            return False
        if pid <= 1 or not self.port_open(item.get("port")):
            return False
        return self.share_cmdline_matches(pid, item)

    def share_cmdline_matches(self, pid, item):
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            return False
        parts = raw.split(b"\x00")
        port = str(item.get("port") or "").encode()
        path = str(item.get("path") or "").encode()
        page = any(part.endswith(b"share_page.py") for part in parts)
        plain = b"http.server" in parts and b"127.0.0.1" in parts
        return (page or plain) and port in parts and path in parts

    def find_share_pid(self, item):
        try:
            names = os.listdir("/proc")
        except OSError:
            return 0
        for name in names:
            if not name.isdigit():
                continue
            pid = int(name)
            if pid <= 1:
                continue
            if self.share_cmdline_matches(pid, item):
                return pid
        return 0

    def share_server_kind(self, item):
        try:
            pid = int(item.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        if pid <= 1 or not self.share_cmdline_matches(pid, item):
            pid = self.find_share_pid(item)
        if pid <= 1:
            return ""
        try:
            parts = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\x00")
        except OSError:
            return ""
        item["pid"] = pid
        if any(part.endswith(b"share_page.py") for part in parts):
            return "page"
        return "plain"

    def start_share_server(self, item):
        kind = self.share_server_kind(item)
        if kind == "page" and self.port_open(item["port"]):
            return ""
        if kind == "plain":
            self.stop_share_server(item)
            for _ in range(10):
                if not self.port_open(item["port"]):
                    break
                time.sleep(0.1)
            if self.port_open(item["port"]):
                return "That folder port is already in use."
        elif self.port_open(item["port"]):
            return "That folder port is already in use."
        path = clean_share_path(item.get("path"))
        if folder_problem(path, self.data):
            return "That folder cannot be shared."
        script = Path(__file__).resolve().parent / "share_page.py"
        proc = subprocess.Popen(
            [sys.executable, str(script), str(item["port"]), str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        item["pid"] = proc.pid
        time.sleep(0.2)
        if not self.port_open(item["port"]):
            return "The folder server did not start."
        return ""

    def stop_share_server(self, item):
        try:
            pid = int(item.get("pid") or 0)
        except (TypeError, ValueError):
            return
        if pid <= 1:
            return
        if not self.share_cmdline_matches(pid, item):
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def public_shares(self, shares, dns):
        shown = []
        for item in shares:
            url = f"https://{dns}:{item['port']}/" if dns and item.get("published") else ""
            shown.append({
                "name": item["name"],
                "kind": item["kind"],
                "path": item["path"],
                "url": url,
            })
        return shown

    def share_payload(self, shares, dns, live, error="", enable="", notice=""):
        jellyfin = ""
        ip = self.tailscale_ipv4()
        if ip:
            info, _error = self.inspect("jellyfin")
            state = info.get("State") if isinstance(info, dict) and isinstance(info.get("State"), dict) else {}
            if state.get("Running") is True:
                jellyfin = f"http://{ip}:8096"
        backend = self.tailscale_backend() if live else {"state": "", "loginUrl": ""}
        ts_state = backend.get("state") or ""
        ts_login = backend.get("loginUrl") or "" if ts_state == "NeedsLogin" else ""
        media_path, media_rows = self.media_view()
        return {
            "ok": not error,
            "error": error,
            "notice": notice,
            "items": self.items(),
            "shares": self.public_shares(shares, dns),
            "dns": dns,
            "tailscale": live,
            "enableUrl": enable,
            "jellyfinUrl": jellyfin,
            "tailscaleIp": ip,
            "tailscaleState": ts_state,
            "tailscaleLoginUrl": ts_login,
            "media": media_rows,
            "mediaPath": media_path,
        }

    def media_view(self):
        rel = str(getattr(self, "drop_folder", "") or "").strip().strip("/")
        folder = library_folder(shares_root(), rel)
        if folder is None or (rel and not folder.is_dir()):
            self.drop_folder = ""
            rel = ""
            folder = library_folder(shares_root(), "")
        rows = media_listing(folder) if folder is not None else []
        shared = set()
        for item in self.read_shares():
            try:
                shared.add(Path(item["path"]).resolve())
            except OSError:
                continue
        for row in rows:
            try:
                row["shared"] = folder is not None and (folder / row["name"]).resolve() in shared
            except OSError:
                row["shared"] = False
        return rel, rows

    def use_library(self, relative):
        rel = str(relative or "").strip().strip("/")
        folder = library_folder(shares_root(), rel)
        if folder is None or (rel and not folder.is_dir()):
            return False
        self.drop_folder = rel
        return True

    def _media_error(self, shares, message):
        dns, live = self.tailscale_dns()
        payload = self.share_payload(shares, dns, live, error=message)
        payload["mediaNote"] = message
        return payload

    def media_open(self, relative):
        shares = self.read_shares()
        if not self.use_library(relative):
            return self._media_error(shares, "That folder is not in the library.")
        dns, live = self.tailscale_dns()
        return self.share_payload(shares, dns, live)

    def media_mkdir(self, relative):
        text = str(relative or "").strip().strip("/")
        parent_rel, _, name = text.rpartition("/")
        shares = self.read_shares()
        if not text or name != safe_drop_name(name) or name.startswith("."):
            return self._media_error(shares, "Use a folder name without slashes.")
        parent = library_folder(shares_root(), parent_rel)
        if parent is None:
            return self._media_error(shares, "That folder is not in the library.")
        try:
            missing = not parent.exists()
            parent.mkdir(parents=True, exist_ok=True)
            if missing:
                os.chmod(parent, 0o755)
            target = parent / name
            if target.exists() or target.is_symlink():
                return self._media_error(shares, "That folder already exists.")
            target.mkdir()
            os.chmod(target, 0o755)
        except OSError:
            return self._media_error(shares, "That folder could not be created.")
        self.drop_folder = parent_rel
        dns, live = self.tailscale_dns()
        payload = self.share_payload(shares, dns, live, notice=f"Created {name}.")
        payload["mediaNote"] = payload["notice"]
        return payload

    def media_remove(self, relative):
        shares = self.read_shares()
        found = library_entry(shares_root(), relative)
        if found is None:
            return self._media_error(shares, "That file is not in the library.")
        parent_rel, target = found
        blocked = False
        stopping = []
        for item in shares:
            try:
                path = Path(item["path"]).resolve()
            except OSError:
                continue
            if path == target or target in path.parents:
                if item.get("kind") == "network":
                    blocked = True
                    break
                stopping.append(item)
        if blocked:
            return self._media_error(
                shares,
                "Stop sharing that folder from Phone folders. It stays on this computer.",
            )
        for item in stopping:
            stopped = self.share_remove(item["name"])
            if not stopped.get("ok"):
                stopped["mediaNote"] = stopped.get("error") or "That folder could not be removed."
                return stopped
        problem = remove_media_entry(shares_root(), relative)
        self.drop_folder = parent_rel
        dns, live = self.tailscale_dns()
        notice = "" if problem else f"Removed {target.name} from the library."
        payload = self.share_payload(self.read_shares(), dns, live, error=problem, notice=notice)
        payload["mediaNote"] = problem or notice
        return payload

    def share_list(self, publish_missing=True):
        shares = self.read_shares()
        error = ""
        for item in shares:
            problem = self.start_share_server(item)
            if problem and not error:
                error = problem
        dns, live = self.tailscale_dns()
        enable = ""
        if live and publish_missing and not error:
            for item in shares:
                if item.get("published"):
                    continue
                problem, found = self.publish_port(item["port"])
                if found:
                    enable = found
                    break
                if problem:
                    error = problem
                    break
                item["published"] = True
        notice = "Allow folder sharing once, then press Publish to the phone." if enable else ""
        self.write_shares(shares)
        return self.share_payload(shares, dns, live, error=error, enable=enable, notice=notice)

    def share_status(self):
        shares = self.read_shares()
        dns, live = self.tailscale_dns()
        return self.share_payload(shares, dns, live)

    def share_computer(self, name):
        if not SHARE_NAME_RE.fullmatch(str(name or "")):
            return self.share_payload(self.read_shares(), "", False, error="Use a short name like photos.")
        shares = self.read_shares()
        if any(item["name"] == name for item in shares):
            return self.share_payload(shares, "", False, error="That folder is already shared.")
        port = assign_share_port(item["port"] for item in shares)
        if not port:
            return self.share_payload(shares, "", False, error="Sixteen folders is the limit.")
        root = shares_root()
        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o755)
        folder = root / name
        folder.mkdir(parents=True, exist_ok=True)
        os.chmod(folder, 0o755)
        item = {"name": name, "path": str(folder.resolve()), "port": port, "kind": "computer", "pid": 0, "published": False}
        problem = self.start_share_server(item)
        if problem:
            return self.share_payload(shares, "", False, error=problem)
        shares.append(item)
        dns, live = self.tailscale_dns()
        enable = ""
        notice = f"Created {folder}."
        if live:
            publish_error, enable = self.publish_port(port)
            if enable:
                notice = f"Created {folder}. Allow folder sharing once, then press Publish to the phone."
            elif publish_error:
                notice = f"Created {folder}. {publish_error}"
            else:
                item["published"] = True
                notice = f"Created {folder}. On the phone, open the link while Tailscale is connected."
        else:
            notice = f"Created {folder}. Start tailscale, then press Publish to the phone."
        self.write_shares(shares)
        return self.share_payload(shares, dns, live, enable=enable, notice=notice)

    def share_network(self, text):
        path = clean_share_path(text)
        problem = folder_problem(path, self.data)
        if problem:
            return self.share_payload(self.read_shares(), "", False, error=problem)
        shares = self.read_shares()
        if any(Path(item["path"]).resolve() == path for item in shares):
            return self.share_payload(shares, "", False, error="That folder is already shared.")
        base = path.name.lower().replace("_", "-")
        base = "".join(ch for ch in base if ch.isalnum() or ch == "-")
        if not base or not base[0].isalpha():
            base = "share"
        name = base[:25]
        taken = {item["name"] for item in shares}
        if name in taken:
            suffix = 2
            while f"{name[:20]}-{suffix}" in taken:
                suffix += 1
            name = f"{name[:20]}-{suffix}"
        port = assign_share_port(item["port"] for item in shares)
        if not port:
            return self.share_payload(shares, "", False, error="Sixteen folders is the limit.")
        item = {"name": name, "path": str(path), "port": port, "kind": "network", "pid": 0, "published": False}
        start_problem = self.start_share_server(item)
        if start_problem:
            return self.share_payload(shares, "", False, error=start_problem)
        shares.append(item)
        dns, live = self.tailscale_dns()
        enable = ""
        notice = f"Sharing {path}."
        if live:
            publish_error, enable = self.publish_port(port)
            if not enable and not publish_error:
                item["published"] = True
                notice = f"Sharing {path}. On the phone, open the link while Tailscale is connected."
            elif publish_error:
                notice = f"Sharing {path}. {publish_error}"
        self.write_shares(shares)
        return self.share_payload(shares, dns, live, enable=enable, notice=notice)

    def share_remove(self, name):
        if not SHARE_NAME_RE.fullmatch(str(name or "")):
            return self.share_payload(self.read_shares(), "", False, error="Use a short name like photos.")
        shares = self.read_shares()
        kept = []
        removed = None
        for item in shares:
            if item["name"] == name:
                removed = item
            else:
                kept.append(item)
        if removed is None:
            return self.share_payload(shares, "", False, error="That folder is not shared.")
        self.stop_share_server(removed)
        dns, live = self.tailscale_dns()
        if live:
            self.unpublish_port(removed["port"])
        self.write_shares(kept)
        return self.share_payload(kept, dns, live, notice=f"Stopped sharing {name}. The folder is still on this computer.")

    def share_drop(self, blob):
        shares = self.read_shares()
        dns, live = self.tailscale_dns()
        if len(str(blob or "")) > 100000:
            payload = self.share_payload(shares, dns, live, error="Drop fewer files at once.")
            payload["mediaNote"] = payload["error"]
            return payload
        rel = str(getattr(self, "drop_folder", "") or "").strip().strip("/")
        folder = library_folder(shares_root(), rel)
        if folder is None or (rel and not folder.is_dir()):
            rel = ""
            self.drop_folder = ""
            folder = library_folder(shares_root(), "")
        copied, skipped, problem = take_drop(blob, folder, self.data, home=getattr(self, "drop_home", None))
        if problem:
            payload = self.share_payload(shares, dns, live, error=problem)
            payload["mediaNote"] = problem
            return payload
        if not copied:
            message = problem or "Nothing was added. Drop files from this computer."
            payload = self.share_payload(shares, dns, live, error=message)
            payload["mediaNote"] = message
            return payload
        where = "/media" if not rel else f"/media/{rel}"
        if len(copied) == 1:
            notice = f"Added {copied[0]}. Jellyfin reads it from {where}."
        else:
            notice = f"Added {len(copied)} items. Jellyfin reads them from {where}."
        if skipped:
            notice = f"{notice} {skipped} were left out."
        payload = self.share_payload(shares, dns, live, notice=notice)
        payload["mediaNote"] = notice
        return payload

    def share_publish(self):
        shares = self.read_shares()
        for item in shares:
            item["published"] = False
            self.start_share_server(item)
        dns, live = self.tailscale_dns()
        if not live:
            self.write_shares(shares)
            return self.share_payload(shares, dns, live, error="Start the tailscale container first.")
        enable = ""
        error = ""
        for item in shares:
            problem, found = self.publish_port(item["port"])
            if found:
                enable = found
                break
            if problem:
                error = problem
                break
            item["published"] = True
        info, _error = self.inspect("jellyfin")
        state = info.get("State") if isinstance(info, dict) and isinstance(info.get("State"), dict) else {}
        if state.get("Running") is True and not enable and not error:
            problem, found = self.publish_port(8096)
            if found:
                enable = found
            elif problem:
                error = problem
        self.write_shares(shares)
        notice = "The phone can open the links while Tailscale is connected." if not error and not enable else ""
        return self.share_payload(shares, dns, live, error=error, enable=enable, notice=notice)


    def previous_default_path(self):
        return self.data / "previous-default-browser"

    def read_previous_default(self):
        try:
            raw = self.previous_default_path().read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        return raw if valid_desktop_id(raw) and raw != HOG_DESKTOP else ""

    def write_previous_default(self, desktop_id):
        if not valid_desktop_id(desktop_id) or desktop_id == HOG_DESKTOP:
            return
        self.data.mkdir(parents=True, exist_ok=True)
        path = self.previous_default_path()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(desktop_id + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        os.chmod(path, 0o600)

    def clear_previous_default(self):
        try:
            self.previous_default_path().unlink()
        except OSError:
            pass

    def _xdg(self, args, timeout=5):
        try:
            return self.run_argv(["xdg-settings", *args], timeout=timeout)
        except FileNotFoundError as exc:
            raise RuntimeError("xdg-settings is not installed.") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("xdg-settings took too long.") from exc

    def _xdg_mime_default(self, desktop_id):
        if not valid_desktop_id(desktop_id):
            return
        for mime in ("x-scheme-handler/http", "x-scheme-handler/https"):
            try:
                self.run_argv(["xdg-mime", "default", desktop_id, mime], timeout=5)
            except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
                pass

    def current_default_browser(self):
        try:
            result = self._xdg(["get", "default-web-browser"])
        except RuntimeError:
            return ""
        value = (result.stdout or "").strip()
        if result.returncode != 0 or not valid_desktop_id(value):
            return ""
        return value

    def list_http_browsers(self):
        found = []
        try:
            result = self.run_argv(["gio", "mime", "x-scheme-handler/http"], timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            result = None
        if result and result.returncode == 0:
            for line in (result.stdout or "").splitlines():
                text = line.strip()
                lower = text.lower()
                if lower.startswith("default application for"):
                    continue
                if ":" in text and not text.endswith(".desktop"):
                    # "Default application for …: foo.desktop"
                    maybe = text.rsplit(":", 1)[-1].strip()
                    if valid_desktop_id(maybe):
                        found.append(maybe)
                    continue
                if valid_desktop_id(text):
                    found.append(text)
        # Also ask xdg-mime for the current default as a candidate.
        try:
            mime = self.run_argv(["xdg-mime", "query", "default", "x-scheme-handler/http"], timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            mime = None
        if mime and mime.returncode == 0:
            value = (mime.stdout or "").strip()
            if valid_desktop_id(value):
                found.append(value)
        ordered = []
        seen = set()
        for item in found:
            if item in seen or item == HOG_DESKTOP:
                continue
            seen.add(item)
            ordered.append(item)
        return ordered

    def fallback_default_browser(self):
        previous = self.read_previous_default()
        if previous:
            return previous
        browsers = self.list_http_browsers()
        return browsers[0] if browsers else ""

    def browser_default_payload(self, ok=True, error="", notice=""):
        current = ""
        try:
            current = self.current_default_browser()
        except Exception:
            current = ""
        available = hog_desktop_installed()
        is_default = current == HOG_DESKTOP
        previous = self.read_previous_default()
        return {
            "ok": ok,
            "error": error,
            "notice": notice,
            "defaultBrowser": is_default,
            "defaultBrowserId": current,
            "defaultBrowserPrevious": previous,
            "defaultBrowserAvailable": available,
        }

    def browser_default_status(self):
        if not hog_desktop_installed():
            return self.browser_default_payload(
                ok=True,
                notice="Install the hog-browser .deb first so Hog can register as a browser.",
            )
        try:
            return self.browser_default_payload()
        except RuntimeError as exc:
            return self.browser_default_payload(ok=False, error=str(exc))

    def browser_default_set(self):
        if not hog_desktop_installed():
            return self.browser_default_payload(
                ok=False,
                error="Install the hog-browser .deb first so Hog can register as a browser.",
            )
        try:
            current = self.current_default_browser()
        except RuntimeError as exc:
            return self.browser_default_payload(ok=False, error=str(exc))
        if current and current != HOG_DESKTOP:
            self.write_previous_default(current)
        try:
            result = self._xdg(["set", "default-web-browser", HOG_DESKTOP])
        except RuntimeError as exc:
            return self.browser_default_payload(ok=False, error=str(exc))
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Could not set the default browser.").strip().splitlines()
            message = detail[-1][:180] if detail else "Could not set the default browser."
            return self.browser_default_payload(ok=False, error=message)
        self._xdg_mime_default(HOG_DESKTOP)
        return self.browser_default_payload(notice="Hog is the default browser for http and https links.")

    def browser_default_clear(self):
        try:
            current = self.current_default_browser()
        except RuntimeError as exc:
            return self.browser_default_payload(ok=False, error=str(exc))
        if current != HOG_DESKTOP:
            return self.browser_default_payload(notice="Hog is already not the default browser.")
        target = self.fallback_default_browser()
        if not target or target == HOG_DESKTOP:
            return self.browser_default_payload(
                ok=False,
                error="No other browser was saved. Choose one in Settings → Default Apps, then try again.",
            )
        try:
            result = self._xdg(["set", "default-web-browser", target])
        except RuntimeError as exc:
            return self.browser_default_payload(ok=False, error=str(exc))
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Could not restore the previous browser.").strip().splitlines()
            message = detail[-1][:180] if detail else "Could not restore the previous browser."
            return self.browser_default_payload(ok=False, error=message)
        self._xdg_mime_default(target)
        label = target.removesuffix(".desktop") if hasattr(target, "removesuffix") else target[:-8]
        return self.browser_default_payload(
            notice=f"Default browser restored to {label}.",
        )

    def handle(self, action, name="", image=""):
        if action == "browser-default":
            return self.browser_default_status()
        if action == "browser-default-set":
            return self.browser_default_set()
        if action == "browser-default-clear":
            return self.browser_default_clear()
        if action == "jellyfin-gpu":
            return self.jellyfin_gpu_status()
        if action == "jellyfin-gpu-set":
            return self._mark_docker(self.set_jellyfin_gpu(True))
        if action == "jellyfin-gpu-clear":
            return self._mark_docker(self.set_jellyfin_gpu(False))
        if action == "jellyfin-gpu-install":
            return self._mark_docker(self.install_nvidia_toolkit())
        if action == "engine":
            return self.engine_status()
        if action == "share-list":
            return self._mark_docker(self.share_list())
        if action == "share-status":
            return self._mark_docker(self.share_status())
        if action == "share-computer":
            return self._mark_docker(self.share_computer(name))
        if action == "share-network":
            return self._mark_docker(self.share_network(name))
        if action == "share-remove":
            return self._mark_docker(self.share_remove(name))
        if action == "share-publish":
            return self._mark_docker(self.share_publish())
        if action == "share-drop":
            return self._mark_docker(self.share_drop(name))
        if action == "media-open":
            return self._mark_docker(self.media_open(name))
        if action == "media-mkdir":
            return self._mark_docker(self.media_mkdir(name))
        if action == "media-remove":
            return self._mark_docker(self.media_remove(name))
        if action == "engine-start":
            return self.start_engine()
        if action == "shell":
            return self.open_shell(name)
        if action == "shell-close":
            return self.close_shell(name)
        if action == "commit":
            return self.commit_image(name)
        if action == "modprobe":
            return self._mark_docker(self.prompt_wireguard_module())
        if action == "endpoint":
            return self._mark_docker(self.set_peer_endpoint(name))
        if action == "tailscale-up":
            return self._mark_docker(self.tailscale_up())
        if action in {"run", "recreate"}:
            return self._mark_docker(self.apply_command(name, replace=action == "recreate"))
        return self._mark_docker(self._act(action, name, image))

    def _act(self, action, name="", image=""):
        if action == "launch":
            return self.launch(name)
        if action == "create":
            return self.create(name, image)
        if action == "list":
            return self.engine_status()
        if not valid_name(name):
            return {"ok": False, "error": "Use a plain container name.", "items": self.items()}
        if action == "remove":
            return self.remove_container(name)
        if action == "add":
            info, error = self.inspect(name)
            if info is None:
                return {"ok": False, "error": error, "items": self.items()}
            reason = assess(info, name, self.data)
            if reason:
                return {"ok": False, "error": reason, "items": self.items()}
            self.remember(name)
            return {"ok": True, "error": "", "items": self.items()}
        info, error = self.inspect(name)
        if info is None:
            return {"ok": False, "error": error, "items": self.items()}
        if action == "logs":
            result = self.container_run(name, ["logs", "--tail", "150", name])
            text = (result.stdout or "") + (result.stderr or "")
            if result.returncode != 0 and not text.strip():
                return {"ok": False, "error": "Docker did not return logs.", "items": self.items()}
            codes = self.peer_codes(name, info)
            if codes:
                text = strip_ascii_qr(text)
            return {"ok": True, "error": "", "logs": text[-12000:], "qr": codes, "items": self.items()}
        if action in {"start", "stop"}:
            result = self.container_run(name, [action, name])
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "Docker refused.").strip().splitlines()
                return {"ok": False, "error": detail[-1][:180], "items": self.items()}
            if action == "start" and not assess(info, name, self.data):
                self.remember(name)
                problem = self.prepare_tailscale_firewall(name, info)
                if problem:
                    return {"ok": False, "error": problem, "items": self.items()}
            return {"ok": True, "error": "", "items": self.items()}
        reason = assess(info, name, self.data)
        if reason:
            return {"ok": False, "error": reason, "items": self.items()}
        return {"ok": False, "error": "That container action is not available.", "items": self.items()}

    def create(self, name, image):
        if not valid_name(name):
            return {"ok": False, "error": "Use a plain container name.", "items": self.items()}
        if not valid_image(image):
            return {"ok": False, "error": "Use an image like ubuntu:24.04.", "items": self.items()}
        info, error = self.inspect(name)
        if error == "Docker is not running.":
            return {"ok": False, "error": error, "items": self.items()}
        created = False
        if info is None:
            result = self.run(launch_args({"name": name, "image": image}, image), timeout=180)
            blob = f"{result.stderr or ''}\n{result.stdout or ''}"
            if result.returncode != 0:
                if docker_offline(blob):
                    return {"ok": False, "error": "Docker is not running.", "items": self.items()}
                detail = [line.strip() for line in blob.splitlines() if line.strip()]
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not start that image.",
                    "items": self.items(),
                }
            created = True
            info, error = self.inspect(name)
        reason = assess(info, name, self.data) if info else (error or "Docker did not describe that container.")
        if reason:
            if created:
                self.run(["rm", "-f", name], timeout=20)
            return {"ok": False, "error": reason, "items": self.items()}
        running = isinstance(info.get("State"), dict) and info["State"].get("Running") is True
        if not running:
            started = self.run(["start", name])
            if started.returncode != 0:
                detail = f"{started.stderr or ''}\n{started.stdout or ''}".strip().splitlines()
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not start that container.",
                    "items": self.items(),
                }
        self.remember(name)
        return {"ok": True, "error": "", "items": self.items()}

    def apply_command(self, cmdline, replace=False):
        try:
            name, image, ports, vpn, command, env, sysctls, _mounts, network = parse_run(cmdline)
        except CommandError as exc:
            return {"ok": False, "error": str(exc), "items": self.items()}
        command_text = canonical_command(name, image, ports, vpn, command, env, sysctls, (), network)
        if "wireguard" in image.lower():
            problem = self.load_wireguard_module()
            if problem:
                return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        jellyfin = "jellyfin" in image.lower() or name == "jellyfin"
        if jellyfin and self.gpu_enabled() and not self.gpu_is_ready():
            return {
                "ok": False,
                "error": "GPU acceleration is on, but this computer is not ready yet. Use the checklist in the Jellyfin GPU card.",
                "items": self.items(),
                "command": command_text,
            }
        info, error = self.inspect(name)
        if error == "Docker is not running.":
            return {"ok": False, "error": error, "items": self.items(), "command": command_text}
        if info is not None:
            if not replace:
                return {
                    "ok": False,
                    "error": f"{name} already exists. Recreate replaces it and deletes its files.",
                    "items": self.items(),
                    "command": command_text,
                }
            if jellyfin:
                self.save_jellyfin_volumes(info, side="engine" if self.gpu_enabled() else "desktop")
            state = info.get("State") if isinstance(info.get("State"), dict) else {}
            if state.get("Running") is True:
                stopped = self.container_run(name, ["stop", name], timeout=40)
                if stopped.returncode != 0:
                    detail = f"{stopped.stderr or ''}\n{stopped.stdout or ''}".strip().splitlines()
                    return {
                        "ok": False,
                        "error": detail[-1][:180] if detail else "Docker did not stop that container.",
                        "items": self.items(),
                        "command": command_text,
                    }
            removed = self.container_run(name, ["rm", name], timeout=30)
            if removed.returncode != 0:
                detail = f"{removed.stderr or ''}\n{removed.stdout or ''}".strip().splitlines()
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not remove that container.",
                    "items": self.items(),
                    "command": command_text,
                }
        mounts = ()
        gpus = False
        if jellyfin:
            mounts = self.jellyfin_mounts(info, side="engine" if self.gpu_enabled() else "desktop")
            if self.gpu_enabled():
                gpus = True
                extra = []
                if NVIDIA_VISIBLE_ENV not in env:
                    extra.append(NVIDIA_VISIBLE_ENV)
                if NVIDIA_CAPS_ENV not in env:
                    extra.append(NVIDIA_CAPS_ENV)
                env = tuple(env) + tuple(extra)
        if "tailscale" in image.lower():
            mounts = (*mounts, TAILSCALE_STATE_MOUNT)
            network = TAILSCALE_NETWORK
            problem = self.ensure_tailscale_network()
            if problem:
                return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        run_args = compose_run(name, image, ports, vpn, command, env, sysctls, mounts, network, gpus=gpus)
        result = self.container_run(name, run_args, timeout=300 if mounts else 180)
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                return {"ok": False, "error": "Docker is not running.", "items": self.items(), "command": command_text}
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            return {
                "ok": False,
                "error": detail[-1][:180] if detail else "Docker did not start that image.",
                "items": self.items(),
                "command": command_text,
            }
        info, error = self.inspect(name)
        reason = assess(info, name, self.data) if info else (error or "Docker did not describe that container.")
        if reason:
            self.container_run(name, ["rm", "-f", name], timeout=20)
            return {"ok": False, "error": reason, "items": self.items(), "command": command_text}
        self.remember(name)
        problem = self.prepare_tailscale_firewall(name, info)
        if problem:
            return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        verb = "Recreated" if replace else "Started"
        notice = f"{verb} {name}."
        enable = ""
        if "jellyfin" in image.lower():
            dns, live = self.tailscale_dns()
            if live:
                problem, enable = self.publish_port(8096)
                if enable:
                    notice = f"{verb} {name}. Allow folder sharing once from the Tailscale card. In Jellyfin, add a library at /media."
                elif problem:
                    notice = f"{verb} {name}. {problem}"
                elif self.tailscale_ipv4():
                    notice = f"{verb} {name}. On this computer open http://127.0.0.1:8096. In the phone app, the host is http://{self.tailscale_ipv4()}:8096. In Jellyfin, add a library at /media."
            else:
                notice = f"{verb} {name}. Start tailscale, open its card, and press Publish to the phone. In Jellyfin, add a library at /media."
            if self.gpu_enabled():
                notice = f"{notice} In Dashboard → Playback → Transcoding, pick NVIDIA NVENC. Docker Desktop settings do not carry over to Docker Engine."
        return {
            "ok": True,
            "error": "",
            "notice": notice,
            "enableUrl": enable,
            "command": command_text,
            "items": self.items(),
        }

    def ensure_tailscale_network(self):
        inspected = self.run(["network", "inspect", TAILSCALE_NETWORK], timeout=10)
        if inspected.returncode == 0:
            return ""
        created = self.run(
            ["network", "create", "--ipv6", "--subnet", TAILSCALE_IPV6_SUBNET, TAILSCALE_NETWORK],
            timeout=20,
        )
        if created.returncode != 0:
            detail = f"{created.stderr or ''}\n{created.stdout or ''}".strip().splitlines()
            return detail[-1][:180] if detail else "Docker could not create the tailscale network."
        return ""

    def prepare_tailscale_firewall(self, name, info):
        config = info.get("Config") if isinstance(info, dict) and isinstance(info.get("Config"), dict) else {}
        if "tailscale" not in str(config.get("Image") or "").lower():
            return ""
        listed = self.run(["exec", name, "ls", "-l", "/usr/sbin/iptables", "/usr/sbin/ip6tables"], timeout=15)
        text = f"{listed.stdout or ''}\n{listed.stderr or ''}"
        if listed.returncode != 0:
            return "Tailscale did not show its firewall command."
        if text.count("xtables-nft-multi") >= 2 and "legacy" not in text:
            return ""
        for path in ("/usr/sbin/iptables", "/usr/sbin/ip6tables"):
            linked = self.run(["exec", name, "ln", "-sfn", "xtables-nft-multi", path], timeout=15)
            if linked.returncode != 0:
                return "Tailscale could not switch its firewall command."
        restarted = self.run(["restart", name], timeout=40)
        if restarted.returncode != 0:
            return "Tailscale did not restart after the firewall change."
        return ""

    def copy_bytes(self, name, path):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / "peer.png"
            try:
                result = subprocess.run(
                    [self.docker, "cp", f"{name}:{path}", str(dest)],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                return b""
            if result.returncode != 0 or not dest.is_file():
                return b""
            return dest.read_bytes()

    def peer_codes(self, name, info):
        if assess(info, name, self.data):
            return []
        try:
            listed = self.run(["exec", name, "find", "/config", "-maxdepth", "3", "-name", "*.png"], timeout=15)
        except RuntimeError:
            return []
        if listed.returncode != 0:
            return []
        codes = []
        for line in (listed.stdout or "").splitlines():
            path = line.strip()
            if not QR_PATH_RE.fullmatch(path) or len(codes) >= 3:
                continue
            raw = self.copy_bytes(name, path)
            if not raw.startswith(PNG_MAGIC) or len(raw) > 200_000:
                continue
            code = {
                "label": Path(path).parent.name,
                "png": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
            }
            endpoint = self.peer_endpoint(name, str(Path(path).with_suffix(".conf")))
            if endpoint:
                code["endpoint"] = endpoint
            codes.append(code)
        return codes

    def peer_endpoint(self, name, path):
        if not valid_name(name) or not PEER_CONF_RE.fullmatch(path):
            return ""
        try:
            result = self.run(
                ["exec", name, "grep", "-m", "1", "-E", r"^Endpoint[[:space:]]*=", path],
                timeout=10,
            )
        except RuntimeError:
            return ""
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        if result.returncode != 0 or len(lines) != 1 or "=" not in lines[0]:
            return ""
        return endpoint_value(lines[0].split("=", 1)[1].strip())

    def lan_address(self):
        try:
            result = self.run_argv(["ip", "-4", "route", "get", "1.1.1.1"], timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        match = re.search(r"\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b", result.stdout or "")
        if not match or not private_ipv4(match.group(1)):
            return ""
        return match.group(1)

    def public_address(self):
        try:
            result = self.run_argv(
                ["curl", "-4", "-fsS", "--max-time", "8", "https://ifconfig.me"],
                timeout=12,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        address = (result.stdout or "").strip()
        if result.returncode != 0 or not public_ipv4(address):
            return ""
        return address

    def write_bytes(self, name, path, data):
        if not valid_name(name) or not PEER_CONF_RE.fullmatch(path):
            return False
        if not isinstance(data, bytes) or len(data) > 100_000:
            return False
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / "peer.conf"
            dest.write_bytes(data)
            try:
                result = subprocess.run(
                    [self.docker, "cp", str(dest), f"{name}:{path}"],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                return False
            return result.returncode == 0

    def set_peer_endpoint(self, mode):
        mode = str(mode or "")
        if mode not in {"lan", "public"}:
            return {"ok": False, "error": "Choose this Wi-Fi or the public address.", "items": self.items()}
        name = "wireguard"
        info, error = self.inspect(name)
        if info is None:
            return {"ok": False, "error": error or "The wireguard container is not running.", "items": self.items()}
        reason = assess(info, name, self.data)
        if reason:
            return {"ok": False, "error": reason, "items": self.items()}
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True and str(state.get("Status") or "") != "running":
            return {"ok": False, "error": "Start the wireguard container first.", "items": self.items()}
        config = info.get("Config") if isinstance(info.get("Config"), dict) else {}
        if "wireguard" not in str(config.get("Image") or "").lower():
            return {"ok": False, "error": "That container is not the WireGuard image.", "items": self.items()}
        address = self.lan_address() if mode == "lan" else self.public_address()
        if not address:
            missing = "This computer has no home Wi-Fi address." if mode == "lan" else "This computer has no public address right now."
            return {"ok": False, "error": missing, "items": self.items()}
        endpoint = f"{address}:51820"
        try:
            listed = self.run(["exec", name, "find", "/config", "-maxdepth", "3", "-name", "*.conf"], timeout=15)
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc), "items": self.items()}
        if listed.returncode != 0:
            return {"ok": False, "error": "The container has no peer setup file.", "items": self.items()}
        paths = []
        for line in (listed.stdout or "").splitlines():
            path = line.strip()
            if PEER_CONF_RE.fullmatch(path):
                paths.append(path)
            if len(paths) >= 3:
                break
        if not paths:
            return {"ok": False, "error": "The container has no peer setup file.", "items": self.items()}
        for path in paths:
            raw = self.copy_bytes(name, path)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                return {"ok": False, "error": "The peer setup file could not be read.", "items": self.items()}
            updated = replace_endpoint(text, endpoint)
            if updated is None:
                return {"ok": False, "error": "The peer setup file has no endpoint line.", "items": self.items()}
            png = str(Path(path).with_suffix(".png"))
            if not QR_PATH_RE.fullmatch(png):
                return {"ok": False, "error": "The peer setup file has no endpoint line.", "items": self.items()}
            encoded = updated.encode("utf-8")
            if not self.write_bytes(name, path, encoded):
                return {"ok": False, "error": "The peer setup file could not be saved.", "items": self.items()}
            try:
                drawn = self.run(
                    ["exec", name, "qrencode", "-t", "PNG", "-o", png, "-r", path],
                    timeout=20,
                )
            except RuntimeError as exc:
                self.write_bytes(name, path, raw)
                return {"ok": False, "error": str(exc), "items": self.items()}
            if drawn.returncode != 0:
                self.write_bytes(name, path, raw)
                return {"ok": False, "error": "The new square could not be drawn.", "items": self.items()}
        where = "this Wi-Fi" if mode == "lan" else "the public address"
        return {
            "ok": True,
            "error": "",
            "notice": f"New square for {where}, {endpoint}. Remove the old tunnel on the phone, then scan this square.",
            "qr": self.peer_codes(name, info),
            "items": self.items(),
        }

    def _tailscale_signed_in_payload(self, state, items=None):
        if state == "NeedsMachineAuth":
            notice = "Tailscale is signed in. Waiting for admin approval."
        else:
            notice = "Tailscale is signed in. On the phone, choose hog as the exit node."
        return {
            "ok": True,
            "error": "",
            "notice": notice,
            "items": items if items is not None else self.items(),
            "tailscaleState": state,
            "tailscaleLoginUrl": "",
            "openLogin": False,
        }

    def _tailscale_login_payload(self, url, state, items=None, open_login=False):
        return {
            "ok": True,
            "error": "",
            "notice": f"Open this link to sign in:\n{url}",
            "items": items if items is not None else self.items(),
            "tailscaleState": state,
            "tailscaleLoginUrl": url,
            "openLogin": bool(open_login),
        }

    def tailscale_up(self):
        name = "tailscale"
        info, error = self.inspect(name)
        if info is None:
            return {"ok": False, "error": error or "The tailscale container is not running.", "items": self.items()}
        reason = assess(info, name, self.data)
        if reason:
            return {"ok": False, "error": reason, "items": self.items()}
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True and str(state.get("Status") or "") != "running":
            return {"ok": False, "error": "Start the tailscale container first.", "items": self.items()}
        config = info.get("Config") if isinstance(info.get("Config"), dict) else {}
        if "tailscale" not in str(config.get("Image") or "").lower():
            return {"ok": False, "error": "That container is not the Tailscale image.", "items": self.items()}
        backend = self.tailscale_backend()
        backend_state = backend.get("state") or ""
        url = backend.get("loginUrl") or ""
        if backend_state in LOGGED_IN_STATES:
            return self._tailscale_signed_in_payload(backend_state)
        if url:
            return self._tailscale_login_payload(url, backend_state, open_login=True)
        try:
            result = self.run(
                ["exec", name, "tailscale", "login", "--timeout=90s"],
                timeout=100,
            )
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc), "items": self.items(), "tailscaleState": backend_state, "tailscaleLoginUrl": "", "openLogin": False}
        text = scrub_tailscale_output((result.stdout or "") + (result.stderr or ""))
        backend = self.tailscale_backend()
        backend_state = backend.get("state") or backend_state
        url = backend.get("loginUrl") or tailscale_auth_url(text)
        if backend_state in LOGGED_IN_STATES:
            return self._tailscale_signed_in_payload(backend_state)
        if url:
            return self._tailscale_login_payload(url, backend_state, open_login=True)
        if result.returncode != 0:
            return {
                "ok": False,
                "error": text[-2000:] or "Tailscale did not return a sign-in link.",
                "notice": "",
                "items": self.items(),
                "tailscaleState": backend_state,
                "tailscaleLoginUrl": "",
                "openLogin": False,
            }
        return {
            "ok": True,
            "error": "",
            "notice": text[-4000:] or "Tailscale is signed in. On the phone, choose hog as the exit node.",
            "items": self.items(),
            "tailscaleState": backend_state or "Running",
            "tailscaleLoginUrl": "",
            "openLogin": False,
        }

    def prompt_wireguard_module(self):
        problem = self.load_wireguard_module(interactive=True)
        loaded = self.wireguard_module_loaded()
        if problem:
            return {"ok": False, "error": problem, "items": self.items(), "wireguard": loaded}
        return {
            "ok": True,
            "error": "",
            "notice": "WireGuard kernel module is loaded.",
            "items": self.items(),
            "wireguard": True,
        }

    def load_wireguard_module(self, interactive=False):
        if self.wireguard_module_loaded():
            return ""
        commands = [["modprobe", "wireguard"], ["sudo", "-n", "modprobe", "wireguard"]]
        if interactive:
            commands.append(["pkexec", "modprobe", "wireguard"])
        for cmd in commands:
            try:
                result = self.run_argv(cmd, timeout=120 if cmd[0] == "pkexec" else 20)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and self.wireguard_module_loaded():
                return ""
        if interactive:
            return "The kernel module was not loaded. Approve sudo modprobe wireguard in the password prompt, then press the button again."
        return "This computer needs the WireGuard kernel module. Press Load kernel module. That runs sudo modprobe wireguard."

    def wireguard_module_loaded(self):
        try:
            listed = self.run_argv(["lsmod"], timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return any(line.split()[:1] == ["wireguard"] for line in (listed.stdout or "").splitlines())

    def remove_container(self, name):
        info, error = self.inspect(name)
        if error == "Docker is not running.":
            return {"ok": False, "error": error, "items": self.items()}
        if info is None:
            self.forget(name)
            return {"ok": True, "error": "", "items": self.items()}
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        if state.get("Running") is True:
            return {"ok": False, "error": "Stop the container first.", "items": self.items()}
        result = self.container_run(name, ["rm", name], timeout=30)
        if result.returncode != 0:
            detail = f"{result.stderr or ''}\n{result.stdout or ''}".strip().splitlines()
            return {
                "ok": False,
                "error": detail[-1][:180] if detail else "Docker did not remove that container.",
                "items": self.items(),
            }
        self.forget(name)
        return {"ok": True, "error": "", "items": self.items()}

    def launch(self, preset_id):
        preset = PRESETS.get(str(preset_id or ""))
        if preset is None:
            return {"ok": False, "error": "That distro is not available.", "items": self.items()}
        name = preset["name"]
        info, error = self.inspect(name)
        if error == "Docker is not running.":
            return {"ok": False, "error": error, "items": self.items()}
        created = False
        if info is None:
            result = self.run(launch_args(preset, self.image_for(preset)), timeout=180)
            blob = f"{result.stderr or ''}\n{result.stdout or ''}"
            if result.returncode != 0:
                if docker_offline(blob):
                    return {"ok": False, "error": "Docker is not running.", "items": self.items()}
                detail = blob.strip().splitlines()
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not start that distro.",
                    "items": self.items(),
                }
            created = True
            info, error = self.inspect(name)
        reason = assess(info, name, self.data) if info else (error or "Docker did not describe that container.")
        if reason:
            if created:
                self.run(["rm", "-f", name], timeout=20)
            return {"ok": False, "error": reason, "items": self.items()}
        running = isinstance(info.get("State"), dict) and info["State"].get("Running") is True
        if not running:
            started = self.run(["start", name])
            if started.returncode != 0:
                detail = f"{started.stderr or ''}\n{started.stdout or ''}".strip().splitlines()
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not start that distro.",
                    "items": self.items(),
                }
        names = self.read_names()
        if name not in names:
            names.append(name)
            self.write_names(names)
        return {"ok": True, "error": "", "items": self.items()}

    def _cap_names(self, values):
        names = []
        for item in values or []:
            text = str(item).upper()
            if text.startswith("CAP_"):
                text = text[4:]
            names.append(text)
        return names

    def _refresh_preset(self, name, info):
        preset = next((item for item in PRESETS.values() if item["name"] == name), None)
        if preset is None or not isinstance(info, dict):
            return info, ""
        command = (info.get("Config") or {}).get("Cmd")
        if command != ["sleep", "infinity"]:
            return info, ""
        host = info.get("HostConfig") if isinstance(info.get("HostConfig"), dict) else {}
        drops = self._cap_names(host.get("CapDrop"))
        adds = self._cap_names(host.get("CapAdd"))
        if "ALL" not in drops or ("SETUID" in adds and "SYS_CHROOT" in adds):
            return info, ""
        removed = self.run(["rm", "-f", name], timeout=30)
        if removed.returncode != 0:
            return None, "Hog could not replace that container."
        started = self.run(launch_args(preset, self.image_for(preset)), timeout=180)
        if started.returncode != 0:
            blob = f"{started.stderr or ''}\n{started.stdout or ''}"
            if docker_offline(blob):
                return None, "Docker is not running."
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            return None, detail[-1][:180] if detail else "Hog could not start that container again."
        return self.inspect(name)

    def _shell_fail(self, name, message):
        down = message == "Docker is not running."
        return {
            "ok": False,
            "error": message,
            "docker": not down,
            "items": self._offline_items() if down else self.items(),
            "shell": {"name": name, "error": message},
        }

    def open_shell(self, name):
        from shell import ShellError
        if not valid_name(name):
            return self._shell_fail(name, "Use a plain container name.")
        info, error = self.inspect(name)
        if info is None:
            return self._shell_fail(name, error or "Docker did not find that container.")
        reason = assess(info, name, self.data)
        if reason:
            return self._shell_fail(name, reason)
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True:
            return self._shell_fail(name, "Start the container first.")
        try:
            info, error = self._refresh_preset(name, info)
            if info is None:
                return self._shell_fail(name, error or "Hog could not prepare that container.")
            reason = assess(info, name, self.data)
            if reason:
                return self._shell_fail(name, reason)
            self.shell.prepare(name)
            session = self.shell.mint(name)
        except ShellError as exc:
            return self._shell_fail(name, str(exc))
        self.remember(name)
        return {
            "ok": True,
            "error": "",
            "docker": True,
            "items": self.items(),
            "shell": session,
        }

    def close_shell(self, token):
        from shell import TOKEN_RE
        if not TOKEN_RE.fullmatch(str(token or "")):
            return {"ok": False, "error": "That session is not open.", "items": self.items()}
        self.shell.close(token)
        return {"ok": True, "error": "", "docker": True, "items": self.items()}

    def image_for(self, preset):
        tag = f"{preset['name']}:local"
        if not valid_name(preset["name"]):
            return preset["image"]
        try:
            result = self.run(["image", "inspect", "--format", "{{.Id}}", tag], timeout=15)
        except RuntimeError:
            return preset["image"]
        if result.returncode == 0 and (result.stdout or "").strip():
            return tag
        return preset["image"]

    def _container_fail(self, name, message):
        down = message == "Docker is not running."
        return {
            "ok": False,
            "error": message,
            "docker": not down,
            "items": self._offline_items() if down else self.items(),
        }

    def _ready_container(self, name, fail):
        if not valid_name(name):
            return None, fail(name, "Use a plain container name.")
        info, error = self.inspect(name)
        if info is None:
            return None, fail(name, error or "Docker did not find that container.")
        reason = assess(info, name, self.data)
        if reason:
            return None, fail(name, reason)
        state = info.get("State") if isinstance(info.get("State"), dict) else {}
        if state.get("Running") is not True:
            return None, fail(name, "Start the container first.")
        return info, None

    def _commit_result(self, name):
        tag = f"{name}:local"
        try:
            result = self.run(["commit", name, tag], timeout=300)
        except RuntimeError as exc:
            return {"name": name, "image": tag, "error": str(exc)}
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                return {"name": name, "image": tag, "error": "Docker is not running."}
            lines = [line.strip() for line in blob.splitlines() if line.strip()]
            return {
                "name": name,
                "image": tag,
                "error": lines[-1][:180] if lines else "Docker did not save that image.",
            }
        return {"name": name, "image": tag, "error": ""}

    def commit_image(self, name):
        _info, failed = self._ready_container(name, self._container_fail)
        if failed:
            failed["commit"] = {"name": name, "image": "", "error": failed["error"]}
            return failed
        saved = self._commit_result(name)
        down = saved["error"] == "Docker is not running."
        return {
            "ok": not saved["error"],
            "error": saved["error"],
            "docker": not down,
            "items": self._offline_items() if down else self.items(),
            "commit": saved,
        }
