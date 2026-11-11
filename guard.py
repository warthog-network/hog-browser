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
import urllib.error
import urllib.parse
import urllib.request
import hashlib
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

AI_NETWORK = "hog-ai"
OLLAMA_NAME = "hog-ollama"
OLLAMA_IMAGE = "ollama/ollama:latest"
OLLAMA_VOLUME = "hog-ollama"
OLLAMA_MOUNT = "hog-ollama:/root/.ollama"
OLLAMA_CONTAINER_PORT = "11434"
OLLAMA_HOST_PORTS = (11434, 11435, 11436, 11437)
OPENWEBUI_NAME = "hog-open-webui"
OPENWEBUI_IMAGE = "ghcr.io/open-webui/open-webui:main"
OPENWEBUI_VOLUME = "hog-open-webui"
OPENWEBUI_MOUNT = "hog-open-webui:/app/backend/data"
OPENWEBUI_CONTAINER_PORT = "8080"
OPENWEBUI_HOST_PORTS = (3000, 8080, 3001, 8081, 8082, 8083)
OLLAMA_BASE_ENV = "OLLAMA_BASE_URL=http://hog-ollama:11434"
AI_MEMORY = "16g"
MODEL_NAME_RE = re.compile(
    r"^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/){0,2}[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-z0-9]+(?:[._-][a-z0-9]+)*)?$"
)
MODEL_NAME_MAX = 80
AI_DISK_WARN_BYTES = 15 * 1024 * 1024 * 1024
AI_MODEL_GROUPS = (
    ("mid", "Around 9–10 GB", "A good fit for 12 GB of video memory."),
    ("small", "Smaller and faster", "Lighter models that leave more room for context."),
    ("large", "Larger (partly CPU, slow)", "These usually spill into system RAM on a 12 GB card and run slowly."),
)
AI_MODEL_SUGGESTIONS = (
    {"name": "qwen2.5:14b", "label": "Qwen 2.5 14B", "blurb": "Best all-rounder", "disk": "9.0 GB", "vramMb": 11000, "group": "mid", "category": "General"},
    {"name": "qwen2.5-coder:14b", "label": "Qwen 2.5 Coder 14B", "blurb": "Coding", "disk": "9.0 GB", "vramMb": 11000, "group": "mid", "category": "Coding"},
    {"name": "deepseek-r1:14b", "label": "DeepSeek R1 14B", "blurb": "Step-by-step reasoning, slower", "disk": "9.0 GB", "vramMb": 11000, "group": "mid", "category": "Reasoning"},
    {"name": "phi4:14b", "label": "Phi-4 14B", "blurb": "Reasoning", "disk": "9.1 GB", "vramMb": 11000, "group": "mid", "category": "Reasoning"},
    {"name": "gemma2:9b", "label": "Gemma 2 9B", "blurb": "Fast middle option", "disk": "5.4 GB", "vramMb": 7500, "group": "small", "category": "General"},
    {"name": "llama3.1:8b", "label": "Llama 3.1 8B", "blurb": "Fast and capable", "disk": "4.9 GB", "vramMb": 6500, "group": "small", "category": "General"},
    {"name": "qwen2.5:7b", "label": "Qwen 2.5 7B", "blurb": "Small and quick", "disk": "4.7 GB", "vramMb": 6200, "group": "small", "category": "General"},
    {"name": "mistral", "label": "Mistral 7B", "blurb": "Small and quick", "disk": "4.1 GB", "vramMb": 5800, "group": "small", "category": "General"},
    {"name": "gemma2:27b", "label": "Gemma 2 27B", "blurb": "Higher quality, mostly off the GPU", "disk": "16 GB", "vramMb": 20000, "group": "large", "category": "General"},
    {"name": "qwen2.5:32b", "label": "Qwen 2.5 32B", "blurb": "Higher quality, mostly off the GPU", "disk": "20 GB", "vramMb": 24000, "group": "large", "category": "General"},
    {"name": "deepseek-r1:32b", "label": "DeepSeek R1 32B", "blurb": "Heavy reasoning, slow on 12 GB", "disk": "20 GB", "vramMb": 24000, "group": "large", "category": "Reasoning"},
)
OLLAMA_LIBRARY_URL = "https://ollama.com/library"
OLLAMA_LIBRARY_HOSTS = frozenset({"ollama.com", "www.ollama.com"})

VSCODE_DOWNLOAD_URL = "https://code.visualstudio.com/"
VSCODE_DOWNLOAD_HOSTS = frozenset({"code.visualstudio.com", "www.code.visualstudio.com"})
CONTINUE_EXTENSION_ID = "Continue.continue"
CONTINUE_MARKETPLACE_URI = "vscode:extension/Continue.continue"
CONTINUE_CONFIG_RELATIVE = Path(".continue") / "config.yaml"
CONTINUE_CHAT_MODEL = "qwen2.5-coder:14b"
CONTINUE_AUTOCOMPLETE_MODEL = "qwen2.5-coder:1.5b"
CONTINUE_EMBED_MODEL = "nomic-embed-text"
CONTINUE_MODELS = (
    {"name": CONTINUE_CHAT_MODEL, "role": "chat", "label": "Chat and edit"},
    {"name": CONTINUE_AUTOCOMPLETE_MODEL, "role": "autocomplete", "label": "Autocomplete"},
    {"name": CONTINUE_EMBED_MODEL, "role": "embed", "label": "Embeddings"},
)
EDITOR_COMMANDS = ("code", "codium")
EDITOR_LABELS = {
    "code": "Visual Studio Code",
    "codium": "VSCodium",
}
FLATPAK_EDITOR_IDS = {
    "com.visualstudio.code": "Visual Studio Code",
    "com.visualstudio.code-oss": "Code OSS",
    "com.vscodium.codium": "VSCodium",
}


def _model_is_installed(name, installed_names):
    """True when Ollama already has this suggested tag (or a default latest)."""
    if name in installed_names:
        return True
    if ":" not in name:
        return any(existing == name or existing.startswith(f"{name}:") for existing in installed_names)
    if name.endswith(":latest"):
        bare = name.rsplit(":", 1)[0]
        return bare in installed_names
    return False


ENGINE_DOCKER_SOCK = Path("/var/run/docker.sock")
DESKTOP_DOCKER_SOCK = Path.home() / ".docker" / "desktop" / "docker.sock"
JELLYFIN_CONFIG_VOLUME = "hog-jellyfin-config"
JELLYFIN_CACHE_VOLUME = "hog-jellyfin-cache"
NVIDIA_VISIBLE_ENV = "NVIDIA_VISIBLE_DEVICES=all"
NVIDIA_CAPS_ENV = "NVIDIA_DRIVER_CAPABILITIES=compute,video,utility"
NVIDIA_DEV_RE = re.compile(r"^/dev/nvidia[A-Za-z0-9_/-]*$")
NVIDIA_TOOLKIT_HELPER = Path("/opt/hog-browser/libexec/hog-nvidia-toolkit-install")
NVIDIA_TOOLKIT_INSTALL_TIMEOUT = 600
SELF_UPDATE_HELPER = Path("/opt/hog-browser/libexec/hog-self-update")
SELF_UPDATE_TIMEOUT = 600
UPDATE_CACHE_TTL = 24 * 60 * 60
UPDATE_MAX_BYTES = 200 * 1024 * 1024
RELEASES_API_URL = "https://api.github.com/repos/warthog-network/hog-browser/releases/latest"
RELEASES_PAGE_URL = "https://github.com/warthog-network/hog-browser/releases/latest"
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
DEB_NAME_RE = re.compile(r"^hog-browser_(\d+\.\d+\.\d+)_amd64\.deb$")
UPDATE_PATH_RE = re.compile(
    r"^/home/[A-Za-z0-9._][A-Za-z0-9._-]{0,31}/\.local/share/hog-browser/updates/hog-browser_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb$"
)
UPDATE_HOSTS = {
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "media.githubusercontent.com",
}
RUNTIME_ENGINE = "engine"
RUNTIME_DESKTOP = "desktop"
RUNTIMES = (RUNTIME_ENGINE, RUNTIME_DESKTOP)
BUILTIN_NETWORKS = frozenset({"bridge", "host", "none"})
NETWORK_DRIVERS = frozenset({"bridge", "macvlan", "ipvlan"})
IFACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,15}$")


def docker_host_env(sock):
    env = os.environ.copy()
    env["DOCKER_HOST"] = f"unix://{sock}"
    env.pop("DOCKER_CONTEXT", None)
    env.pop("DOCKER_MACHINE_NAME", None)
    return env


def valid_runtime(value):
    return str(value or "") in RUNTIMES


def runtime_label(value):
    if str(value or "") == RUNTIME_ENGINE:
        return "Docker Engine"
    return "Docker Desktop"


def valid_network_name(name, allow_builtin=False):
    text = str(name or "")
    if not NAME_RE.fullmatch(text):
        return False
    if not allow_builtin and text in BUILTIN_NETWORKS:
        return False
    return True


def valid_network_driver(driver):
    return str(driver or "") in NETWORK_DRIVERS


def valid_iface(name):
    return bool(IFACE_RE.fullmatch(str(name or "")))


def _ipv4_ok(text):
    parts = str(text or "").split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit() or int(part) > 255:
            return False
    return True


def valid_cidr(text):
    raw = str(text or "").strip()
    if raw.count("/") != 1:
        return False
    addr, prefix = raw.split("/", 1)
    if not prefix.isdigit():
        return False
    number = int(prefix)
    if _ipv4_ok(addr):
        return 0 <= number <= 32
    try:
        socket.inet_pton(socket.AF_INET6, addr)
    except (OSError, ValueError):
        return False
    return 0 <= number <= 128


def valid_gateway(text):
    raw = str(text or "").strip()
    if _ipv4_ok(raw):
        return True
    try:
        socket.inet_pton(socket.AF_INET6, raw)
    except (OSError, ValueError):
        return False
    return True


def network_delete_problem(name, containers=()):
    text = str(name or "")
    if text in BUILTIN_NETWORKS:
        return "Built-in Docker networks cannot be deleted."
    if not valid_network_name(text):
        return "Use a plain network name."
    attached = [item for item in containers or () if str(item or "").strip()]
    if attached:
        return "That network still has containers attached."
    return ""


def tailscale_serve_host(runtime):
    if str(runtime or "") == RUNTIME_ENGINE:
        return "127.0.0.1"
    return "host.docker.internal"


def is_tailscale_image(name, image=""):
    return str(name or "") == "tailscale" and "tailscale" in str(image or "").lower()


def is_ollama_image(name, image=""):
    text = str(image or "").lower()
    return str(name or "") == OLLAMA_NAME and text.startswith("ollama/ollama")


def is_open_webui_image(name, image=""):
    text = str(image or "").lower()
    return str(name or "") == OPENWEBUI_NAME and "open-webui/open-webui" in text


def is_ai_image(name, image=""):
    return is_ollama_image(name, image) or is_open_webui_image(name, image)


def valid_model_name(name):
    text = str(name or "").strip().lower()
    if not text or len(text) > MODEL_NAME_MAX:
        return False
    if ".." in text or text.startswith("-") or "//" in text:
        return False
    return bool(MODEL_NAME_RE.fullmatch(text))


def estimate_model_vram_mb(size_bytes=0, hint_mb=0):
    try:
        hint = int(hint_mb or 0)
    except (TypeError, ValueError):
        hint = 0
    if hint > 0:
        return hint
    try:
        size = int(size_bytes or 0)
    except (TypeError, ValueError):
        size = 0
    if size <= 0:
        return 0
    return int(size / (1024 * 1024) * 1.2) + 512


def allowed_run_network(name, image, network):
    mode = str(network or "")
    if not mode:
        return True
    if mode in {TAILSCALE_NETWORK, "host"}:
        return is_tailscale_image(name, image)
    if mode == AI_NETWORK:
        return is_ai_image(name, image)
    return False


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


def nvidia_toolkit_helper_status(path=None, pkexec_path=None, missing=None):
    helper = Path(path) if path is not None else NVIDIA_TOOLKIT_HELPER
    if not helper.is_file():
        return False, missing or (
            "Install the hog-browser .deb to install the toolkit from this button. "
            "Until then, copy the commands below."
        )
    pkexec = pkexec_path if pkexec_path is not None else shutil.which("pkexec")
    if not pkexec:
        return False, (
            "pkexec is not installed, so Hog cannot open a password prompt. "
            "Install pkexec (policykit-1), or use the command below."
        )
    try:
        st = helper.stat()
    except OSError:
        return False, "The packaged helper could not be read. Use the command below."
    if st.st_uid != 0:
        return False, "The packaged helper is not the root helper from the hog-browser .deb. Use the command below."
    if st.st_mode & 0o022:
        return False, "The packaged helper is writable and will not be run. Use the command below."
    if not os.access(helper, os.X_OK):
        return False, "The packaged helper is not executable. Use the command below."
    return True, ""


def hog_version(root=None):
    path = Path(root or Path(__file__).resolve().parent) / "package.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(raw, dict):
        return ""
    parsed = parse_version(raw.get("version"))
    return format_version(parsed) if parsed else ""


def parse_version(text):
    match = VERSION_RE.fullmatch(str(text or "").strip())
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def format_version(parts):
    if not parts:
        return ""
    return ".".join(str(part) for part in parts)


def version_newer(candidate, current):
    left = parse_version(candidate)
    right = parse_version(current)
    if not left or not right:
        return False
    return left > right


def allowed_update_url(url):
    text = str(url or "").strip()
    if not text or len(text) > 500 or any(ch.isspace() for ch in text):
        return ""
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.params:
        # allow query on API? latest has no query. asset urls usually no query. be strict, no query unless needed.
        if parsed.scheme != "https" or parsed.username or parsed.password:
            return ""
        if parsed.params:
            return ""
        # github API might not need query; asset download shouldn't need it
        if parsed.query:
            return ""
    host = (parsed.hostname or "").lower()
    if host not in UPDATE_HOSTS:
        return ""
    if ".." in parsed.path or "//" in parsed.path:
        return ""
    if not parsed.path.startswith("/"):
        return ""
    return urllib.parse.urlunparse((
        "https",
        host,
        parsed.path,
        "",
        "",
        "",
    ))


UPDATE_SIGNED_HOSTS = {
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
}


def allowed_update_redirect_url(url):
    """GitHub sends release downloads to its CDN with a long signed query.

    Only those CDN hosts may carry a query (it is the signature); everything
    else goes through allowed_update_url. The download is still checked
    against the release sha256 afterwards."""
    text = str(url or "").strip()
    if not text or len(text) > 8192 or any(ch.isspace() for ch in text):
        return ""
    parsed = urllib.parse.urlparse(text)
    host = (parsed.hostname or "").lower()
    if host not in UPDATE_SIGNED_HOSTS or not parsed.query:
        return allowed_update_url(text)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.params or parsed.port:
        return ""
    if ".." in parsed.path or "//" in parsed.path or not parsed.path.startswith("/"):
        return ""
    return urllib.parse.urlunparse(("https", host, parsed.path, "", parsed.query, ""))


def parse_sha256_digest(value):
    text = str(value or "").strip()
    if text.lower().startswith("sha256:"):
        text = text[7:]
    text = text.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", text):
        return ""
    return text


def parse_sha256sums(text, filename):
    name = str(filename or "")
    if not DEB_NAME_RE.fullmatch(name):
        return ""
    for line in str(text or "").splitlines():
        body = line.strip()
        if not body or body.startswith("#"):
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{64})  [ *]?" + re.escape(name), body)
        # official sha256sum is "HASH  filename" (two spaces) or "HASH *filename"
        if not match:
            match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?" + re.escape(name) + r"$", body)
        if match:
            return parse_sha256_digest(match.group(1))
    return ""


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_update_dir():
    return Path.home() / ".local" / "share" / "hog-browser" / "updates"


def canonical_update_path(version):
    parsed = parse_version(version)
    if not parsed:
        return None
    name = f"hog-browser_{format_version(parsed)}_amd64.deb"
    path = canonical_update_dir() / name
    if not UPDATE_PATH_RE.fullmatch(str(path)):
        return None
    return path


def deb_field(path, field, timeout=10):
    if field not in {"Package", "Version", "Architecture"}:
        return ""
    try:
        result = subprocess.run(
            ["dpkg-deb", "-f", "--", str(path), field],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def parse_latest_release(payload, current):
    if not isinstance(payload, dict):
        raise ValueError("GitHub returned an unreadable release.")
    if payload.get("draft") or payload.get("prerelease"):
        raise ValueError("The latest GitHub release is not a stable build.")
    tag = str(payload.get("tag_name") or "").strip()
    version = format_version(parse_version(tag))
    if not version:
        raise ValueError("The latest GitHub release has no version tag.")
    name = f"hog-browser_{version}_amd64.deb"
    asset = None
    sums = None
    for item in payload.get("assets") or []:
        if not isinstance(item, dict):
            continue
        item_name = str(item.get("name") or "")
        if item_name == name:
            asset = item
        elif item_name == "SHA256SUMS":
            sums = item
    if asset is None:
        raise ValueError(f"The latest release does not include {name}.")
    asset_url = allowed_update_url(asset.get("browser_download_url"))
    if not asset_url:
        raise ValueError("The release asset URL is not valid.")
    try:
        size = int(asset.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size < 1024 or size > UPDATE_MAX_BYTES:
        raise ValueError("The release asset size is not valid.")
    digest = parse_sha256_digest(asset.get("digest"))
    sums_url = allowed_update_url(sums.get("browser_download_url")) if sums else ""
    html = allowed_update_url(payload.get("html_url")) or f"https://github.com/warthog-network/hog-browser/releases/tag/{version}"
    if not allowed_update_url(html):
        html = f"https://github.com/warthog-network/hog-browser/releases/tag/{version}"
    return {
        "version": version,
        "current": format_version(parse_version(current)) or str(current or ""),
        "newer": version_newer(version, current),
        "htmlUrl": html,
        "assetName": name,
        "assetUrl": asset_url,
        "assetSize": size,
        "digest": digest,
        "sha256sumsUrl": sums_url,
    }


class SafeUpdateRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_update_redirect_url(newurl):
            raise urllib.error.URLError("Unexpected redirect host for a Hog update.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def update_http_get(url, timeout=20, dest=None, limit=UPDATE_MAX_BYTES):
    target = allowed_update_url(url)
    if not target:
        raise ValueError("That update address is not allowed.")
    request = urllib.request.Request(
        target,
        headers={
            "User-Agent": f"hog-browser/{hog_version() or '0'}",
            "Accept": "application/vnd.github+json, application/octet-stream",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(SafeUpdateRedirect)
    with opener.open(request, timeout=timeout) as response:
        final = allowed_update_redirect_url(response.geturl())
        if not final:
            raise ValueError("Unexpected redirect host for a Hog update.")
        if dest is None:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("The download is too large.")
            return data
        written = 0
        temporary = Path(str(dest) + ".part")
        with open(temporary, "wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > limit:
                    handle.close()
                    temporary.unlink(missing_ok=True)
                    raise ValueError("The download is too large.")
                handle.write(chunk)
        temporary.replace(dest)
        return written

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
    return (
        "wireguard" in text
        or "tailscale" in text
        or "cartesi" in text
        or "jellyfin" in text
        or "ollama" in text
        or "open-webui" in text
    )


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


def allowed_ollama_library_url(url):
    """Return an https://ollama.com/library URL Hog may open, else empty."""
    text = allowed_browser_open_url(url)
    if not text:
        return ""
    parsed = urllib.parse.urlparse(text)
    host = (parsed.hostname or "").strip("[]").lower()
    if parsed.scheme != "https" or host not in OLLAMA_LIBRARY_HOSTS:
        return ""
    path = parsed.path or "/"
    if path != "/library" and not path.startswith("/library/"):
        return ""
    if parsed.params or parsed.query or parsed.fragment or parsed.port:
        return ""
    return text




def allowed_vscode_download_url(url):
    """Return the Visual Studio Code homepage Hog may open, else empty."""
    text = allowed_browser_open_url(url)
    if not text:
        return ""
    parsed = urllib.parse.urlparse(text)
    host = (parsed.hostname or "").strip("[]").lower()
    if parsed.scheme != "https" or host not in VSCODE_DOWNLOAD_HOSTS:
        return ""
    path = parsed.path or "/"
    if path not in ("", "/"):
        return ""
    if parsed.params or parsed.query or parsed.fragment or parsed.port:
        return ""
    return f"https://{host}/"


def allowed_continue_marketplace_uri(url):
    """Return the Continue marketplace URI Hog may open, else empty."""
    text = str(url or "").strip()
    if text == CONTINUE_MARKETPLACE_URI:
        return CONTINUE_MARKETPLACE_URI
    return ""


def continue_extension_roots(home=None):
    base = Path(home or Path.home())
    return (
        base / ".vscode" / "extensions",
        base / ".vscode-oss" / "extensions",
        base / ".vscode-insiders" / "extensions",
        base / ".var" / "app" / "com.visualstudio.code" / "data" / "vscode" / "extensions",
        base / ".var" / "app" / "com.visualstudio.code-oss" / "data" / "vscode" / "extensions",
        base / ".var" / "app" / "com.vscodium.codium" / "data" / "vscode" / "extensions",
    )


def continue_extension_installed(home=None):
    prefix = CONTINUE_EXTENSION_ID.lower()
    for root in continue_extension_roots(home):
        try:
            if not root.is_dir():
                continue
            for entry in root.iterdir():
                name = entry.name.lower()
                if name == prefix or name.startswith(f"{prefix}-"):
                    return True
        except OSError:
            continue
    return False


def _editor_command_path(name, which=None):
    if name not in EDITOR_COMMANDS:
        return ""
    finder = which or shutil.which
    found = finder(name)
    return str(found) if found else ""


def _list_flatpak_editors(which=None, runner=None):
    finder = which or shutil.which
    flatpak = finder("flatpak")
    if not flatpak:
        return ()
    run = runner or (
        lambda args, timeout=8: subprocess.run(
            list(args),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    )
    try:
        result = run([flatpak, "list", "--app", "--columns=application"], timeout=8)
    except (OSError, subprocess.TimeoutExpired, TypeError):
        return ()
    if getattr(result, "returncode", 1) != 0:
        return ()
    found = []
    for line in (result.stdout or "").splitlines():
        app_id = line.strip()
        if app_id in FLATPAK_EDITOR_IDS:
            found.append(app_id)
    return tuple(found)


def detect_code_editor(home=None, which=None, runner=None):
    """Describe a user-level VS Code, VSCodium, or Flatpak editor, if present."""
    for name in EDITOR_COMMANDS:
        path = _editor_command_path(name, which=which)
        if path:
            return {
                "found": True,
                "command": name,
                "path": path,
                "appId": "",
                "label": EDITOR_LABELS[name],
                "kind": name,
            }
    apps = _list_flatpak_editors(which=which, runner=runner)
    if apps:
        app_id = apps[0]
        finder = which or shutil.which
        flatpak = finder("flatpak")
        return {
            "found": True,
            "command": "flatpak",
            "path": str(flatpak) if flatpak else "",
            "appId": app_id,
            "label": f"{FLATPAK_EDITOR_IDS[app_id]} (Flatpak)",
            "kind": "flatpak",
        }
    return {
        "found": False,
        "command": "",
        "path": "",
        "appId": "",
        "label": "",
        "kind": "",
    }


def continue_install_argv(editor=None, which=None, runner=None, home=None):
    info = editor if editor is not None else detect_code_editor(home=home, which=which, runner=runner)
    if not info or not info.get("found"):
        return ()
    if info.get("kind") == "flatpak":
        path = str(info.get("path") or "")
        app_id = str(info.get("appId") or "")
        if not path or app_id not in FLATPAK_EDITOR_IDS:
            return ()
        return (path, "run", app_id, "--install-extension", CONTINUE_EXTENSION_ID)
    path = str(info.get("path") or "")
    if info.get("command") not in EDITOR_COMMANDS or not path:
        return ()
    return (path, "--install-extension", CONTINUE_EXTENSION_ID)


def continue_marketplace_argv(which=None):
    opener = (which or shutil.which)("xdg-open")
    if not opener:
        return ()
    return (str(opener), CONTINUE_MARKETPLACE_URI)


def continue_config_path(home=None):
    return Path(home or Path.home()) / CONTINUE_CONFIG_RELATIVE


def continue_config_yaml(api_base="http://127.0.0.1:11434"):
    allowed = {f"http://127.0.0.1:{port}" for port in OLLAMA_HOST_PORTS}
    if api_base not in allowed:
        api_base = "http://127.0.0.1:11434"
    return (
        "name: Hog local\n"
        "version: 0.0.1\n"
        "schema: v1\n"
        "\n"
        "models:\n"
        "  - name: Qwen2.5-Coder 14B\n"
        "    provider: ollama\n"
        f"    model: {CONTINUE_CHAT_MODEL}\n"
        f"    apiBase: {api_base}\n"
        "    roles:\n"
        "      - chat\n"
        "      - edit\n"
        "      - apply\n"
        "  - name: Qwen2.5-Coder 1.5B\n"
        "    provider: ollama\n"
        f"    model: {CONTINUE_AUTOCOMPLETE_MODEL}\n"
        f"    apiBase: {api_base}\n"
        "    roles:\n"
        "      - autocomplete\n"
        "  - name: Nomic Embed\n"
        "    provider: ollama\n"
        f"    model: {CONTINUE_EMBED_MODEL}\n"
        f"    apiBase: {api_base}\n"
        "    roles:\n"
        "      - embed\n"
    )


def continue_backup_path(path, now=None):
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() if now is None else now))
    candidate = path.with_name(f"config.yaml.hog-backup-{stamp}")
    if not candidate.exists():
        return candidate
    suffix = 2
    while suffix <= 99:
        extra = path.with_name(f"config.yaml.hog-backup-{stamp}-{suffix}")
        if not extra.exists():
            return extra
        suffix += 1
    raise OSError("Could not choose a backup name for ~/.continue/config.yaml.")


def write_continue_config_file(home=None, api_base="http://127.0.0.1:11434"):
    """Write ~/.continue/config.yaml, backing up an existing file first."""
    home_root = Path(home or Path.home())
    path = continue_config_path(home_root)
    parent = path.parent
    try:
        home_root = home_root.resolve()
        parent.mkdir(mode=0o700, exist_ok=True)
        resolved_parent = parent.resolve()
    except OSError as exc:
        raise OSError("Could not open ~/.continue.") from exc
    if resolved_parent.name != ".continue" or home_root not in resolved_parent.parents:
        raise OSError("Refusing to write outside ~/.continue.")
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise OSError("Refusing to overwrite a symlink or special file.")
    backup = None
    if path.is_file():
        backup = continue_backup_path(path)
        if backup.is_symlink() or backup.exists():
            raise OSError("Could not choose a backup name for ~/.continue/config.yaml.")
        shutil.copy2(path, backup)
    path.write_text(continue_config_yaml(api_base), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path, backup

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


def _memory_limit(value, default="2g"):
    text = str(value or "").strip().lower()
    if re.fullmatch(r"[1-9][0-9]{0,2}[gm]", text):
        return text
    return default


def compose_run(name, image, ports=(), vpn=False, command=("sleep", "infinity"), env=(), sysctls=(), mounts=(), network="", gpus=False, memory="2g"):
    args = ["run", "-d", "--name", name, "--cap-drop=ALL"]
    args.extend(f"--cap-add={cap}" for cap in SSH_CAPS)
    if vpn:
        args.append("--cap-add=NET_ADMIN")
        args.extend(["--device", "/dev/net/tun"])
    mem = _memory_limit(memory)
    args.extend(["--pids-limit", "1024", "--memory", mem, "--memory-swap", mem])
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
            if network or mode not in {TAILSCALE_NETWORK, "host", AI_NETWORK}:
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
    if network and not allowed_run_network(name, image, network):
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
    config = info.get("Config") if isinstance(info.get("Config"), dict) else {}
    image = str((config or {}).get("Image") or "")
    for key in ("NetworkMode", "PidMode", "IpcMode", "UTSMode", "CgroupnsMode", "UsernsMode"):
        mode = str(host.get(key) or "")
        if mode == "host" and key == "NetworkMode" and is_tailscale_image(name, image):
            continue
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

    def runtimes_path(self):
        return self.data / "runtimes.json"

    def read_runtimes(self):
        try:
            raw = json.loads(self.runtimes_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        items = raw.get("runtimes") if isinstance(raw, dict) else None
        if not isinstance(items, dict):
            return {}
        saved = {}
        for name, side in items.items():
            if valid_name(name) and valid_runtime(side):
                saved[name] = side
        return saved

    def write_runtimes(self, mapping):
        payload = {
            "runtimes": {
                name: side
                for name, side in (mapping or {}).items()
                if valid_name(name) and valid_runtime(side)
            }
        }
        self.data.mkdir(parents=True, exist_ok=True)
        path = self.runtimes_path()
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        os.chmod(path, 0o600)
        return payload["runtimes"]

    def save_runtime(self, name, side):
        if not valid_name(name) or not valid_runtime(side):
            return self.read_runtimes()
        mapping = self.read_runtimes()
        mapping[name] = side
        return self.write_runtimes(mapping)

    def forget_runtime(self, name):
        mapping = self.read_runtimes()
        if name in mapping:
            del mapping[name]
            self.write_runtimes(mapping)

    def runtime_sock(self, side):
        if side == RUNTIME_ENGINE:
            return self.engine_sock()
        return None

    def desktop_status(self):
        status = {
            "id": RUNTIME_DESKTOP,
            "label": "Docker Desktop",
            "ok": False,
            "available": False,
            "detail": "Docker Desktop is not installed, or its socket is missing.",
        }
        sock = self.desktop_sock()
        if sock is None and not self._socket_usable(self.engine_sock()):
            if self.docker_running():
                status["available"] = True
                status["ok"] = True
                status["detail"] = "The default Docker context is running."
            return status
        if sock is None:
            if self.docker_running() and not self._same_socket(self.engine_sock(), DESKTOP_DOCKER_SOCK):
                # Default context may still be Desktop even if the usual socket path is missing.
                if self.docker_running():
                    status["available"] = True
                    status["ok"] = True
                    status["detail"] = "The default Docker context is running."
            return status
        status["available"] = True
        if not self._socket_usable(sock):
            status["detail"] = "Docker Desktop is installed, but its socket is not reachable."
            return status
        info = self.docker_info_on(sock)
        if info is None:
            if self.docker_running():
                status["ok"] = True
                status["detail"] = "Docker Desktop is running."
                return status
            status["detail"] = "Docker Desktop is installed, but it is not running. Press Start Docker."
            return status
        status["ok"] = True
        status["detail"] = "Docker Desktop is running."
        return status

    def engine_runtime_status(self):
        engine = self._native_engine_status()
        status = {
            "id": RUNTIME_ENGINE,
            "label": "Docker Engine",
            "ok": bool(engine.get("ok")),
            "available": bool(engine.get("installed") or engine.get("ok")),
            "permission": bool(engine.get("permission", True)),
            "detail": "",
        }
        if engine.get("ok"):
            status["detail"] = "Native Docker Engine is installed and running."
        elif engine.get("installed") and not engine.get("permission", True):
            status["available"] = True
            status["detail"] = (
                "Docker Engine is installed, but this user cannot use /var/run/docker.sock. "
                "Add the user to the docker group, then log out and back in."
            )
        elif engine.get("installed"):
            status["detail"] = "Docker Engine is installed but not running."
        else:
            status["detail"] = (
                "Install Docker Engine (docker-ce) next to Docker Desktop, then add this user "
                "to the docker group and log out and back in."
            )
        return status

    def runtime_fields(self):
        engine = self.engine_runtime_status()
        desktop = self.desktop_status()
        return {
            "dockerRuntimes": {
                RUNTIME_ENGINE: engine,
                RUNTIME_DESKTOP: desktop,
            },
            "runtimeDefaults": {
                "tailscale": RUNTIME_ENGINE if engine.get("ok") else RUNTIME_DESKTOP,
            },
        }

    def runtime_available(self, side):
        fields = self.runtime_fields()["dockerRuntimes"].get(side) or {}
        return bool(fields.get("ok"))

    def _name_on_runtime(self, name, side):
        if not valid_name(name):
            return False
        info, _error = self.inspect_on(name, sock=self.runtime_sock(side))
        return info is not None

    def container_runtime(self, name=""):
        name = str(name or "")
        if name == "jellyfin" and self.gpu_enabled():
            return RUNTIME_ENGINE
        saved = self.read_runtimes().get(name)
        if valid_runtime(saved):
            return saved
        return RUNTIME_DESKTOP

    def recommended_runtime(self, name="", image=""):
        name = str(name or "")
        image = str(image or "")
        if name == "jellyfin" and self.gpu_enabled():
            return RUNTIME_ENGINE
        saved = self.read_runtimes().get(name)
        if valid_runtime(saved):
            return saved
        if name and self._name_on_runtime(name, RUNTIME_DESKTOP) and not self._name_on_runtime(name, RUNTIME_ENGINE):
            return RUNTIME_DESKTOP
        if name and self._name_on_runtime(name, RUNTIME_ENGINE) and not self._name_on_runtime(name, RUNTIME_DESKTOP):
            return RUNTIME_ENGINE
        if (name == "tailscale" or "tailscale" in image.lower()) and self.runtime_available(RUNTIME_ENGINE):
            return RUNTIME_ENGINE
        if (is_ai_image(name, image) or name in {OLLAMA_NAME, OPENWEBUI_NAME}) and self.runtime_available(RUNTIME_ENGINE):
            return RUNTIME_ENGINE
        return RUNTIME_DESKTOP

    def container_sock(self, name=""):
        if self.container_runtime(name) == RUNTIME_ENGINE:
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
        try:
            payload.update(self.runtime_fields())
        except Exception:
            payload.setdefault("dockerRuntimes", {})
            payload.setdefault("runtimeDefaults", {})
        if "ai" not in payload:
            try:
                payload.update(self.ai_status_fields(models=False, items=payload.get("items")))
            except Exception:
                payload.setdefault("ai", {})
        return payload

    def update_cache_path(self):
        return self.data / "update-check.json"

    def read_update_cache(self):
        try:
            raw = json.loads(self.update_cache_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def write_update_cache(self, payload):
        self.data.mkdir(parents=True, exist_ok=True)
        path = self.update_cache_path()
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        os.chmod(path, 0o600)

    def self_update_helper_status(self):
        return nvidia_toolkit_helper_status(
            path=SELF_UPDATE_HELPER,
            missing=(
                "Install the hog-browser .deb to update from this window. "
                "Until then, download the release and install it by hand."
            ),
        )

    def _update_payload(self, release=None, ok=True, error="", notice="", log="", restart=False):
        current = hog_version()
        can_install, reason = self.self_update_helper_status()
        latest = (release or {}).get("version") or ""
        newer = version_newer(latest, current) if latest and current else False
        html = (release or {}).get("htmlUrl") or RELEASES_PAGE_URL
        asset = (release or {}).get("assetName") or ""
        manual = f"sudo apt install ./{asset}" if asset else ""
        if not can_install and newer and not notice and not error:
            notice = reason
        return {
            "ok": ok,
            "error": error,
            "notice": notice,
            "currentVersion": current,
            "latestVersion": latest,
            "updateAvailable": newer,
            "releaseUrl": html,
            "assetName": asset,
            "manualCommand": manual,
            "updateCanInstall": bool(can_install and newer),
            "updateHelperReady": bool(can_install),
            "updateHelperReason": "" if can_install else reason,
            "updateLog": log,
            "updateRestart": bool(restart),
        }

    def update_status(self):
        cache = self.read_update_cache()
        release = cache.get("release") if isinstance(cache.get("release"), dict) else None
        if release:
            current = hog_version()
            if release.get("current") != current:
                release = dict(release)
                release["current"] = current
                release["newer"] = version_newer(release.get("version"), current)
        return self._update_payload(release)

    def update_check(self, force=False):
        current = hog_version()
        if not current:
            return self._update_payload(ok=False, error="Hog could not read its current version.")
        cache = self.read_update_cache()
        checked = cache.get("checkedAt")
        try:
            checked = float(checked)
        except (TypeError, ValueError):
            checked = 0
        release = cache.get("release") if isinstance(cache.get("release"), dict) else None
        fresh = (not force) and release and (time.time() - checked) < UPDATE_CACHE_TTL
        if fresh:
            release = dict(release)
            release["current"] = current
            release["newer"] = version_newer(release.get("version"), current)
            payload = self._update_payload(release)
            if release.get("newer"):
                payload["notice"] = f"Hog {release.get('version')} is available."
            else:
                payload["notice"] = f"Hog {current} is the latest release."
            return payload
        try:
            raw = self.update_http_get(RELEASES_API_URL, timeout=20)
            payload = json.loads(raw.decode("utf-8"))
            release = parse_latest_release(payload, current)
        except json.JSONDecodeError as exc:
            return self._update_payload(ok=False, error="GitHub returned an unreadable release list.")
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as exc:
            return self._update_payload(ok=False, error=str(exc) or "Hog could not check GitHub for updates.")
        self.write_update_cache({"checkedAt": time.time(), "release": release})
        result = self._update_payload(release)
        if release.get("newer"):
            result["notice"] = f"Hog {release.get('version')} is available."
        else:
            result["notice"] = f"Hog {current} is the latest release."
        return result

    def update_http_get(self, url, timeout=20, dest=None, limit=UPDATE_MAX_BYTES):
        return update_http_get(url, timeout=timeout, dest=dest, limit=limit)

    def _resolve_update_digest(self, release, timeout=20):
        digest = parse_sha256_digest((release or {}).get("digest"))
        if digest:
            return digest, "GitHub asset digest"
        sums_url = (release or {}).get("sha256sumsUrl") or ""
        if not sums_url:
            return "", ""
        raw = self.update_http_get(sums_url, timeout=timeout, limit=64 * 1024)
        digest = parse_sha256sums(raw.decode("utf-8", errors="replace"), release.get("assetName"))
        if digest:
            return digest, "SHA256SUMS"
        return "", ""

    def _verify_deb(self, path, version):
        name = path.name
        match = DEB_NAME_RE.fullmatch(name)
        if not match or match.group(1) != version:
            return "The downloaded file name does not match the release."
        package = deb_field(path, "Package")
        found = deb_field(path, "Version")
        arch = deb_field(path, "Architecture")
        if package != "hog-browser" or arch != "amd64" or found != version:
            return "The package metadata is not a hog-browser amd64 build of that version."
        return ""

    def _ensure_canonical_deb(self, source, version):
        dest = canonical_update_path(version)
        if dest is None:
            raise ValueError("Hog could not choose a private folder for the update.")
        folder = dest.parent
        folder.mkdir(parents=True, exist_ok=True)
        os.chmod(folder, 0o700)
        if Path(source).resolve() != dest.resolve():
            dest.write_bytes(Path(source).read_bytes())
        os.chmod(dest, 0o600)
        return dest

    def install_update(self):
        status = self.update_check(force=False)
        if not status.get("ok"):
            return status
        if not status.get("updateAvailable"):
            status["notice"] = status.get("notice") or f"Hog {status.get('currentVersion')} is already the latest release."
            return status
        cache = self.read_update_cache()
        release = cache.get("release") if isinstance(cache.get("release"), dict) else None
        if not release or not release.get("newer"):
            return self._update_payload(ok=False, error="Hog could not find a newer release to install.")
        version = release.get("version")
        dest = canonical_update_path(version)
        if dest is None:
            return self._update_payload(release, ok=False, error="Hog could not choose a private folder for the update.")
        try:
            digest, source = self._resolve_update_digest(release)
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as exc:
            return self._update_payload(release, ok=False, error=str(exc) or "Hog could not read the release checksum.")
        if not digest:
            return self._update_payload(
                release,
                ok=False,
                error="The release has no SHA-256 digest or SHA256SUMS file, so Hog will not install it.",
            )
        folder = dest.parent
        folder.mkdir(parents=True, exist_ok=True)
        os.chmod(folder, 0o700)
        try:
            if dest.exists() or dest.is_symlink():
                dest.unlink()
        except OSError:
            return self._update_payload(release, ok=False, error="Hog could not replace the previous download.")
        try:
            try:
                size = int(release.get("assetSize") or 0)
            except (TypeError, ValueError):
                size = 0
            limit = UPDATE_MAX_BYTES
            if size >= 1024:
                limit = min(UPDATE_MAX_BYTES, size + 4096)
            self.update_http_get(release.get("assetUrl"), timeout=120, dest=dest, limit=limit)
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as exc:
            try:
                dest.unlink()
            except OSError:
                pass
            return self._update_payload(release, ok=False, error=str(exc) or "Hog could not download the update.")
        os.chmod(dest, 0o600)
        problem = self._verify_deb(dest, version)
        if problem:
            dest.unlink(missing_ok=True)
            return self._update_payload(release, ok=False, error=problem)
        actual = file_sha256(dest)
        if actual != digest:
            dest.unlink(missing_ok=True)
            return self._update_payload(release, ok=False, error="The download did not match the release checksum.")
        can_install, reason = self.self_update_helper_status()
        if not can_install:
            return self._update_payload(
                release,
                ok=True,
                notice=(
                    f"{reason} The file is saved at {dest}. "
                    f"Install it with: sudo apt install ./{dest.name}"
                ),
                log=f"Verified {dest.name} against the {source}.",
            )
        try:
            result = self.run_argv(
                ["pkexec", str(SELF_UPDATE_HELPER), str(dest)],
                timeout=SELF_UPDATE_TIMEOUT,
            )
        except FileNotFoundError:
            return self._update_payload(
                release,
                ok=False,
                error="pkexec is not installed, so Hog cannot open a password prompt. Install it by hand with the command below.",
                log="",
            )
        except subprocess.TimeoutExpired as exc:
            output = f"{getattr(exc, 'stdout', '') or ''}{getattr(exc, 'stderr', '') or ''}".strip()
            return self._update_payload(
                release,
                ok=False,
                error="The update took too long. Try again, or install the package by hand.",
                log=output[-8000:],
            )
        log = f"{result.stdout or ''}{result.stderr or ''}".strip()
        if result.returncode == 0:
            return self._update_payload(
                release,
                notice=f"Hog {version} is installed. Restart Hog to finish.",
                log=log[-8000:],
                restart=True,
            )
        if result.returncode in {126, 127}:
            return self._update_payload(
                release,
                ok=False,
                error="The password prompt was dismissed or pkexec could not start the installer. Try again, or install the package by hand.",
                log=log[-8000:],
            )
        detail = log.strip().splitlines()
        message = detail[-1][:180] if detail else "The update did not finish."
        return self._update_payload(
            release,
            ok=False,
            error=f"{message} See the log, or install the package by hand.",
            log=log[-8000:],
        )

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

    def _start_jellyfin_on(self, side, image="jellyfin/jellyfin:latest", gpus=None):
        sock = self.engine_sock() if side == "engine" else None
        info, _error = self.inspect_on("jellyfin", sock=sock)
        if info is not None:
            config = info.get("Config") if isinstance(info.get("Config"), dict) else {}
            image = str(config.get("Image") or image) or image
            self.save_jellyfin_volumes(info, side=side)
        mounts = self.jellyfin_mounts(info, side=side)
        env = ()
        if gpus is None:
            gpus = side == "engine" and self.gpu_enabled()
        gpus = bool(gpus) and side == "engine"
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
            self.save_runtime("jellyfin", RUNTIME_ENGINE)
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
                    "~/hog-shares is the same folder. If Tailscale is on Docker Engine, it reaches Jellyfin at 127.0.0.1:8096; on Docker Desktop it uses host.docker.internal:8096."
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
            self.save_runtime("jellyfin", RUNTIME_ENGINE)
            if desktop_info or engine_info:
                _info, error = self._start_jellyfin_on(
                    "engine",
                    image=container_image(engine_info) if engine_info else container_image(desktop_info),
                    gpus=False,
                )
                if error:
                    self.write_gpu_state(enabled=True)
                    payload = self.engine_status()
                    payload["ok"] = False
                    payload["error"] = error
                    return payload
                started = True
                notice = (
                    "GPU acceleration is off. Jellyfin is still on Docker Engine, now without the NVIDIA GPU. "
                    "Use the runtime control if you want to move it back to Docker Desktop. "
                    "Desktop settings stay on Docker Desktop's volumes."
                )
            else:
                notice = "GPU acceleration is off. Start Jellyfin and it will run on Docker Engine without the GPU, unless you move it to Docker Desktop."
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
            {"name": name, "state": "unknown", "image": "", "reason": "", "runtime": self.container_runtime(name)}
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
        if "items" in payload and "ai" not in payload:
            try:
                payload.update(self.ai_status_fields(models=False, items=payload.get("items")))
            except Exception:
                pass
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
        return {
            "name": name,
            "state": state or "unknown",
            "image": image,
            "reason": reason,
            "runtime": self.container_runtime(name),
        }

    def remember(self, name):
        names = self.read_names()
        if name not in names:
            names.append(name)
            self.write_names(names)

    def forget(self, name):
        names = self.read_names()
        if name in names:
            self.write_names([item for item in names if item != name])
        self.forget_runtime(name)

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
        desktop = self._ps_names()
        engine = None
        saved = self.read_runtimes()
        scan_engine = bool(self.gpu_enabled() or RUNTIME_ENGINE in saved.values())
        if not scan_engine:
            # Still scan Engine when its socket is usable and Desktop did not
            # answer, so Engine-only containers stay visible.
            scan_engine = desktop is None and self._socket_usable(self.engine_sock())
        if scan_engine and not self._same_socket(self.engine_sock(), self.desktop_sock()):
            engine = self._ps_names(sock=self.engine_sock())
        if desktop is None and engine is None:
            return None
        names = list(desktop or [])
        seen = set(names)
        # Prefer the saved or GPU runtime when the same name exists on both.
        for name in list(names):
            if name in saved and saved[name] == RUNTIME_ENGINE:
                names.remove(name)
                seen.discard(name)
        if self.gpu_enabled() and "jellyfin" in seen:
            names = [name for name in names if name != "jellyfin"]
            seen.discard("jellyfin")
        for name in engine or []:
            if name not in seen:
                names.append(name)
                seen.add(name)
        for name in self.read_names():
            if name not in seen:
                names.append(name)
                seen.add(name)
        # Remember where Engine-only names live so later sock lookups work.
        for name in engine or []:
            if name not in saved and name not in (desktop or []):
                if not (name == "jellyfin" and self.gpu_enabled()):
                    self.save_runtime(name, RUNTIME_ENGINE)
        return names

    def items(self):
        names = self.listed_names()
        if names is None:
            return self._offline_items()
        return [self.snapshot(name) for name in names]

    def capture(self, args, timeout=8, sock=None):
        proc = subprocess.Popen(
            [self.docker, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
            env=docker_host_env(sock) if sock else None,
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
            result = self.container_run("tailscale", ["exec", "tailscale", "tailscale", "status", "--json"], timeout=15)
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
            result = self.container_run("tailscale", ["exec", "tailscale", "tailscale", "ip", "-4"], timeout=8)
        except RuntimeError:
            return ""
        text = (result.stdout or "").strip()
        parts = ipv4_parts(text)
        if result.returncode != 0 or not parts or parts[0] != 100 or not 64 <= parts[1] <= 127:
            return ""
        return text

    def publish_port(self, port, kind=""):
        # Docker Desktop Tailscale runs in a VM, so 127.0.0.1 is that VM.
        # host.docker.internal reaches this computer, including Jellyfin and
        # share_page.py bound to the host loopback. Engine Tailscale uses
        # host networking, so 127.0.0.1 is this computer.
        # kind "tcp" is used for Jellyfin so the phone app can keep
        # http://100.x.x.x:8096. Other services, including Open WebUI and
        # shared folders, use https serve. One call never turns off the
        # other services, and funnel stays off.
        port = int(port)
        mode = str(kind or ("tcp" if port == 8096 else "https"))
        if mode not in {"tcp", "https"}:
            mode = "https"
        host = tailscale_serve_host(self.container_runtime("tailscale"))
        sock = self.container_sock("tailscale")
        if mode == "tcp":
            self.capture(["exec", "tailscale", "tailscale", "serve", f"--https={port}", "off"], timeout=10, sock=sock)
            args = ["exec", "tailscale", "tailscale", "serve", "--bg", "--yes", f"--tcp={port}", f"tcp://{host}:{port}"]
        else:
            args = ["exec", "tailscale", "tailscale", "serve", "--bg", f"--https={port}", f"http://{host}:{port}"]
        text, code = self.capture(args, timeout=8, sock=sock)
        match = SERVE_ENABLE_RE.search(text)
        if match:
            return "", match.group(0)
        if code != 0:
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            return (lines[-1][:180] if lines else "Tailscale did not publish that folder."), ""
        return "", ""

    def publish_services(self, services):
        enable = ""
        problems = []
        for item in services or ():
            if isinstance(item, dict):
                port = item.get("port")
                kind = item.get("kind") or ""
            else:
                port, kind = item, ""
            try:
                port = int(port)
            except (TypeError, ValueError):
                continue
            problem, found = self.publish_port(port, kind=kind)
            if found and not enable:
                enable = found
            elif problem:
                problems.append(problem)
        return (problems[0] if problems else ""), enable

    def unpublish_port(self, port):
        port = int(port)
        sock = self.container_sock("tailscale")
        if port == 8096:
            self.capture(["exec", "tailscale", "tailscale", "serve", "--tcp=8096", "off"], timeout=10, sock=sock)
        self.capture(
            ["exec", "tailscale", "tailscale", "serve", f"--https={port}", "off"],
            timeout=10,
            sock=sock,
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

    def _runtime_or_error(self, side):
        if not valid_runtime(side):
            return None, "Choose Docker Engine or Docker Desktop."
        fields = (self.runtime_fields().get("dockerRuntimes") or {}).get(side) or {}
        if not fields.get("ok"):
            return None, fields.get("detail") or f"{runtime_label(side)} is not available."
        return self.runtime_sock(side), ""

    def _spec_from_info(self, name, info, fallback_image=""):
        config = info.get("Config") if isinstance(info, dict) and isinstance(info.get("Config"), dict) else {}
        host = info.get("HostConfig") if isinstance(info, dict) and isinstance(info.get("HostConfig"), dict) else {}
        image = str(config.get("Image") or fallback_image or "")
        command = tuple(part for part in (config.get("Cmd") or ()) if isinstance(part, str))
        if image_brings_command(image) and (not command or command == ("sleep", "infinity")):
            command = ()
        env = []
        for item in config.get("Env") or []:
            text = str(item)
            if ENV_RE.fullmatch(text) and text not in env:
                env.append(text)
        ports = []
        bindings = host.get("PortBindings") or {}
        if isinstance(bindings, dict):
            for dest, maps in bindings.items():
                dest_text = str(dest or "")
                dest_port, _, proto = dest_text.partition("/")
                proto = proto or "tcp"
                if proto not in {"tcp", "udp"}:
                    continue
                try:
                    dest_num = str(int(dest_port))
                except (TypeError, ValueError):
                    continue
                if not isinstance(maps, list) or not maps:
                    ports.append(("", dest_num, dest_num, proto))
                    continue
                for item in maps:
                    if not isinstance(item, dict):
                        continue
                    bind = str(item.get("HostIp") or "")
                    if bind and not _ipv4_ok(bind):
                        bind = ""
                    try:
                        host_num = str(int(item.get("HostPort") or dest_num))
                    except (TypeError, ValueError):
                        host_num = dest_num
                    ports.append((bind, host_num, dest_num, proto))
        caps = self._cap_names(host.get("CapAdd"))
        vpn = "NET_ADMIN" in caps
        sysctls = []
        raw = host.get("Sysctls") or {}
        if isinstance(raw, dict):
            for key, value in raw.items():
                item = f"{key}={value}"
                if item in SYSCTLS and item not in sysctls:
                    sysctls.append(item)
        return image, tuple(ports[:MAX_PORTS]), vpn, command, tuple(env[:MAX_ENV]), tuple(sysctls)

    def _start_managed_on(self, name, side, info=None, image=""):
        image, ports, vpn, command, env, sysctls = self._spec_from_info(name, info or {}, fallback_image=image)
        if not valid_image(image):
            return None, "Use an image like ubuntu:24.04."
        mounts = ()
        gpus = False
        network = ""
        jellyfin = "jellyfin" in image.lower() or name == "jellyfin"
        tailscale = "tailscale" in image.lower() or name == "tailscale"
        memory = "2g"
        if jellyfin:
            mounts = self.jellyfin_mounts(info, side=side)
            if side == RUNTIME_ENGINE and self.gpu_enabled():
                gpus = True
                extra = []
                if NVIDIA_VISIBLE_ENV not in env:
                    extra.append(NVIDIA_VISIBLE_ENV)
                if NVIDIA_CAPS_ENV not in env:
                    extra.append(NVIDIA_CAPS_ENV)
                env = tuple(env) + tuple(extra)
        if is_ai_image(name, image) or name in {OLLAMA_NAME, OPENWEBUI_NAME}:
            prepared, problem = self._prepare_ai_container(name, image, ports, env, side)
            if problem:
                return None, problem
            mounts, env, ports, network, gpus, memory = prepared
        if tailscale:
            mounts = (*mounts, TAILSCALE_STATE_MOUNT)
            vpn = True
            if side == RUNTIME_ENGINE:
                network = "host"
            else:
                network = TAILSCALE_NETWORK
                problem = self.ensure_tailscale_network(sock=self.runtime_sock(side))
                if problem:
                    return None, problem
        sock = self.runtime_sock(side)
        problem = self.ensure_image(image, sock=sock)
        if problem:
            return None, problem
        run_args = compose_run(name, image, ports, vpn, command, env, sysctls, mounts, network, gpus=gpus, memory=memory)
        if tailscale and network == "host":
            if "--cap-add=NET_ADMIN" in run_args and "--cap-add=NET_RAW" not in run_args:
                run_args = list(run_args)
                run_args.insert(run_args.index("--cap-add=NET_ADMIN") + 1, "--cap-add=NET_RAW")
        result = self.run_on(run_args, timeout=300 if mounts else 180, sock=sock) if sock is not None else self.run(run_args, timeout=300 if mounts else 180)
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            if docker_offline(blob):
                return None, "Docker is not running."
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            return None, detail[-1][:180] if detail else "Docker did not start that container."
        started, error = self.inspect_on(name, sock=sock)
        reason = assess(started, name, self.data) if started else (error or "Docker did not describe that container.")
        if reason:
            if sock is not None:
                self.run_on(["rm", "-f", name], timeout=20, sock=sock)
            else:
                self.run(["rm", "-f", name], timeout=20)
            return None, reason
        self.remember(name)
        if is_ai_image(name, image) or name in {OLLAMA_NAME, OPENWEBUI_NAME}:
            self.save_runtime(name, side)
        problem = self.prepare_tailscale_firewall(name, started)
        if problem:
            return None, problem
        if is_open_webui_image(name, image) or name == OPENWEBUI_NAME:
            self._publish_open_webui()
        return started, ""

    def set_container_runtime(self, name, side):
        name = str(name or "")
        side = str(side or "")
        if not valid_name(name):
            return {"ok": False, "error": "Use a plain container name.", "items": self.items()}
        if not valid_runtime(side):
            return {"ok": False, "error": "Choose Docker Engine or Docker Desktop.", "items": self.items()}
        _sock, unavailable = self._runtime_or_error(side)
        if unavailable:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = unavailable
            return payload
        if name == "jellyfin" and side == RUNTIME_DESKTOP and self.gpu_enabled():
            clear_gpu = True
        else:
            clear_gpu = False
        current = self.container_runtime(name)
        current_info, _current_error = self.inspect_on(name, sock=self.runtime_sock(current))
        other = RUNTIME_ENGINE if current == RUNTIME_DESKTOP else RUNTIME_DESKTOP
        other_info, _other_error = self.inspect_on(name, sock=self.runtime_sock(other))
        exists = current_info or other_info
        if not exists:
            self.save_runtime(name, side)
            if name == "jellyfin" and side == RUNTIME_DESKTOP and self.gpu_enabled():
                self.write_gpu_state(enabled=False)
            payload = self.engine_status()
            payload["notice"] = f"New {name} containers will use {runtime_label(side)}."
            return payload
        if current == side and current_info and not other_info:
            self.save_runtime(name, side)
            payload = self.engine_status()
            payload["notice"] = f"{name} is already on {runtime_label(side)}."
            return payload
        source_info = current_info or other_info
        source_side = current if current_info else other
        if name == "jellyfin" and source_info:
            self.save_jellyfin_volumes(source_info, side=source_side)
        problem = self._stop_rm_keep_volumes(name, sock=self.runtime_sock(source_side))
        if problem:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = problem
            return payload
        if other_info and other != source_side:
            leftover = self._stop_rm_keep_volumes(name, sock=self.runtime_sock(other))
            if leftover:
                payload = self.engine_status()
                payload["ok"] = False
                payload["error"] = leftover
                return payload
        if clear_gpu:
            self.write_gpu_state(enabled=False)
        self.save_runtime(name, side)
        started, error = self._start_managed_on(
            name,
            side,
            info=source_info,
            image=container_image(source_info),
        )
        if error:
            self.save_runtime(name, source_side)
            if clear_gpu:
                self.write_gpu_state(enabled=True)
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = error
            return payload
        notice = (
            f"{name} is now on {runtime_label(side)}. "
            "Login, libraries, and other files kept in that runtime's Docker volumes do not carry over."
        )
        if name == "tailscale" and side == RUNTIME_ENGINE:
            notice += (
                " Tailscale now uses this computer's network, so your phone can usually connect directly. "
                "Sign in again. In the Tailscale admin page, delete the old hog or hog-1 machine, "
                "then approve the new one as an exit node."
            )
        elif name == "tailscale":
            notice += " Sign in again if Docker Desktop does not already have hog's Tailscale login volume."
        if clear_gpu:
            notice += " GPU acceleration was turned off because it needs Docker Engine."
        payload = self.engine_status()
        payload["notice"] = notice
        dns, live = self.tailscale_dns()
        if live and (name == "jellyfin" or name == "tailscale"):
            problem, enable = self.publish_port(8096)
            if enable:
                payload["enableUrl"] = enable
            elif problem:
                payload["notice"] = f"{notice} {problem}"
        return payload

    def _parse_network_inspect(self, payload, side):
        if not isinstance(payload, dict):
            return None
        name = str(payload.get("Name") or "")
        if not valid_network_name(name, allow_builtin=True):
            return None
        ipam = payload.get("IPAM") if isinstance(payload.get("IPAM"), dict) else {}
        configs = ipam.get("Config") if isinstance(ipam.get("Config"), list) else []
        subnets = []
        gateways = []
        for item in configs:
            if not isinstance(item, dict):
                continue
            subnet = str(item.get("Subnet") or "")
            gateway = str(item.get("Gateway") or "")
            if subnet:
                subnets.append(subnet)
            if gateway:
                gateways.append(gateway)
        attached = []
        containers = payload.get("Containers") if isinstance(payload.get("Containers"), dict) else {}
        for container in containers.values():
            if not isinstance(container, dict):
                continue
            label = str(container.get("Name") or "")
            if valid_name(label) and label not in attached:
                attached.append(label)
        options = payload.get("Options") if isinstance(payload.get("Options"), dict) else {}
        parent = str(options.get("parent") or options.get("com.docker.network.bridge.name") or "")
        return {
            "name": name,
            "runtime": side,
            "driver": str(payload.get("Driver") or ""),
            "scope": str(payload.get("Scope") or ""),
            "internal": bool(payload.get("Internal")),
            "builtin": name in BUILTIN_NETWORKS,
            "subnet": subnets[0] if subnets else "",
            "subnets": subnets,
            "gateway": gateways[0] if gateways else "",
            "containers": attached,
            "parent": parent if valid_iface(parent) else "",
        }

    def list_networks(self, side=""):
        sides = [side] if valid_runtime(side) else list(RUNTIMES)
        networks = []
        for item in sides:
            sock, error = self._runtime_or_error(item)
            if error:
                continue
            try:
                listed = self.run_on(["network", "ls", "--format", "{{json .}}"], timeout=15, sock=sock) if sock is not None else self.run(["network", "ls", "--format", "{{json .}}"], timeout=15)
            except RuntimeError as exc:
                payload = self.engine_status()
                payload["ok"] = False
                payload["error"] = str(exc)
                payload["networks"] = networks
                return payload
            blob = f"{listed.stderr or ''}\n{listed.stdout or ''}"
            if listed.returncode != 0:
                if docker_offline(blob):
                    continue
                continue
            names = []
            for line in (listed.stdout or "").splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                label = str(row.get("Name") or "")
                if valid_network_name(label, allow_builtin=True) and label not in names:
                    names.append(label)
            if names:
                try:
                    inspected = self.run_on(["network", "inspect", *names], timeout=20, sock=sock) if sock is not None else self.run(["network", "inspect", *names], timeout=20)
                except RuntimeError:
                    inspected = None
                payload_rows = []
                if inspected is not None and inspected.returncode == 0:
                    try:
                        raw = json.loads(inspected.stdout or "[]")
                    except json.JSONDecodeError:
                        raw = []
                    if isinstance(raw, list):
                        payload_rows = raw
                found = {item.get("name"): item for item in (self._parse_network_inspect(row, item) for row in payload_rows) if item}
                for label in names:
                    networks.append(found.get(label) or {
                        "name": label,
                        "runtime": item,
                        "driver": "",
                        "scope": "",
                        "internal": False,
                        "builtin": label in BUILTIN_NETWORKS,
                        "subnet": "",
                        "subnets": [],
                        "gateway": "",
                        "containers": [],
                        "parent": "",
                    })
        payload = self.engine_status()
        payload["networks"] = networks
        payload["networkRuntime"] = side if valid_runtime(side) else ""
        return payload

    def _network_request(self, blob):
        if isinstance(blob, dict):
            raw = blob
        else:
            text = str(blob or "").strip()
            if not text:
                return None, "That network request could not be read."
            if text.startswith("{"):
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError:
                    return None, "That network request could not be read."
            else:
                return None, "That network request could not be read."
        if not isinstance(raw, dict):
            return None, "That network request could not be read."
        return raw, ""

    def create_network(self, blob):
        raw, error = self._network_request(blob)
        if error:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = error
            return payload
        side = str(raw.get("runtime") or raw.get("side") or "")
        name = str(raw.get("name") or "")
        driver = str(raw.get("driver") or "bridge")
        subnet = str(raw.get("subnet") or "").strip()
        gateway = str(raw.get("gateway") or "").strip()
        parent = str(raw.get("parent") or "").strip()
        internal = bool(raw.get("internal"))
        sock, unavailable = self._runtime_or_error(side)
        if unavailable:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = unavailable
            return payload
        if not valid_network_name(name):
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "Use a plain network name. Built-in names such as bridge, host, and none cannot be created."
            return payload
        if not valid_network_driver(driver):
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "Use the bridge, macvlan, or ipvlan driver."
            return payload
        if subnet and not valid_cidr(subnet):
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "Use a subnet like 172.28.0.0/16."
            return payload
        if gateway and not valid_gateway(gateway):
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "Use a gateway address like 172.28.0.1."
            return payload
        if gateway and not subnet:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "A gateway needs a subnet."
            return payload
        if parent and not valid_iface(parent):
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "Use a plain parent interface name."
            return payload
        if parent and driver == "bridge":
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = "A parent interface is only used with macvlan or ipvlan."
            return payload
        args = ["network", "create", "--driver", driver]
        if subnet:
            args.extend(["--subnet", subnet])
        if gateway:
            args.extend(["--gateway", gateway])
        if internal:
            args.append("--internal")
        if parent:
            args.extend(["--opt", f"parent={parent}"])
        args.append(name)
        try:
            result = self.run_on(args, timeout=20, sock=sock) if sock is not None else self.run(args, timeout=20)
        except RuntimeError as exc:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = str(exc)
            return payload
        blob = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode != 0:
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = detail[-1][:180] if detail else "Docker could not create that network."
            return payload
        payload = self.list_networks(side)
        payload["notice"] = f"Created {name} on {runtime_label(side)}."
        return payload

    def remove_network(self, blob):
        raw, error = self._network_request(blob) if str(blob or "").startswith("{") else (None, "")
        if raw is None and not error:
            text = str(blob or "")
            side, _, name = text.partition(":")
            raw = {"runtime": side, "name": name}
        if error:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = error
            return payload
        side = str(raw.get("runtime") or raw.get("side") or "")
        name = str(raw.get("name") or "")
        sock, unavailable = self._runtime_or_error(side)
        if unavailable:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = unavailable
            return payload
        if name in BUILTIN_NETWORKS or not valid_network_name(name, allow_builtin=True):
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = network_delete_problem(name)
            return payload
        try:
            inspected = self.run_on(["network", "inspect", name], timeout=15, sock=sock) if sock is not None else self.run(["network", "inspect", name], timeout=15)
        except RuntimeError as exc:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = str(exc)
            return payload
        attached = []
        if inspected.returncode == 0:
            try:
                rows = json.loads(inspected.stdout or "[]")
            except json.JSONDecodeError:
                rows = []
            parsed = self._parse_network_inspect(rows[0], side) if isinstance(rows, list) and rows else None
            if parsed:
                attached = parsed.get("containers") or []
        problem = network_delete_problem(name, attached)
        if problem:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = problem
            return payload
        try:
            result = self.run_on(["network", "rm", name], timeout=20, sock=sock) if sock is not None else self.run(["network", "rm", name], timeout=20)
        except RuntimeError as exc:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = str(exc)
            return payload
        if result.returncode != 0:
            detail = f"{result.stderr or ''}\n{result.stdout or ''}".strip().splitlines()
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = detail[-1][:180] if detail else "Docker could not delete that network."
            return payload
        payload = self.list_networks(side)
        payload["notice"] = f"Deleted {name}."
        return payload

    def _network_membership(self, blob, action):
        raw, error = self._network_request(blob) if str(blob or "").startswith("{") else (None, "")
        if raw is None and not error:
            parts = str(blob or "").split(":")
            if len(parts) >= 3:
                raw = {"runtime": parts[0], "name": parts[1], "container": parts[2]}
            else:
                error = "Choose a runtime, a network, and a container."
        if error:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = error
            return payload
        side = str(raw.get("runtime") or raw.get("side") or "")
        net = str(raw.get("name") or raw.get("network") or "")
        container = str(raw.get("container") or "")
        sock, unavailable = self._runtime_or_error(side)
        if unavailable:
            payload = self.engine_status()
            payload["ok"] = False
            payload["error"] = unavailable
            return payload
        if not valid_network_name(net, allow_builtin=True) or net in {"host", "none"}:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = "Choose a user-defined Docker network."
            return payload
        if not valid_name(container):
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = "Use a plain container name."
            return payload
        remembered = set(self.read_names()) | set(self.listed_names() or [])
        if container not in remembered:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = "Hog can only attach containers it already manages."
            return payload
        if self.container_runtime(container) != side:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = f"{container} is not on {runtime_label(side)}."
            return payload
        info, inspect_error = self.inspect(container)
        if info is None:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = inspect_error or "Docker did not find that container."
            return payload
        host = info.get("HostConfig") if isinstance(info.get("HostConfig"), dict) else {}
        if str(host.get("NetworkMode") or "") == "host":
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = "A container on the host network cannot join another network."
            return payload
        args = ["network", action, net, container]
        try:
            result = self.container_run(container, args, timeout=20)
        except RuntimeError as exc:
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = str(exc)
            return payload
        if result.returncode != 0:
            detail = f"{result.stderr or ''}\n{result.stdout or ''}".strip().splitlines()
            payload = self.list_networks(side)
            payload["ok"] = False
            payload["error"] = detail[-1][:180] if detail else f"Docker could not {action} that network."
            return payload
        payload = self.list_networks(side)
        verb = "Connected" if action == "connect" else "Disconnected"
        payload["notice"] = f"{verb} {container} {'to' if action == 'connect' else 'from'} {net}."
        return payload

    def connect_network(self, blob):
        return self._network_membership(blob, "connect")

    def disconnect_network(self, blob):
        return self._network_membership(blob, "disconnect")


    def ai_state_path(self):
        return self.data / "ai.json"

    def read_ai_state(self):
        try:
            raw = json.loads(self.ai_state_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        ollama_port = raw.get("ollamaPort")
        webui_port = raw.get("openWebuiPort")
        try:
            ollama_port = int(ollama_port) if ollama_port else 0
        except (TypeError, ValueError):
            ollama_port = 0
        try:
            webui_port = int(webui_port) if webui_port else 0
        except (TypeError, ValueError):
            webui_port = 0
        return {
            "ollamaPort": ollama_port if ollama_port in OLLAMA_HOST_PORTS else 0,
            "openWebuiPort": webui_port if webui_port in OPENWEBUI_HOST_PORTS else 0,
        }

    def write_ai_state(self, ollama_port=None, open_webui_port=None):
        state = self.read_ai_state()
        if ollama_port is not None:
            try:
                value = int(ollama_port)
            except (TypeError, ValueError):
                value = 0
            state["ollamaPort"] = value if value in OLLAMA_HOST_PORTS else 0
        if open_webui_port is not None:
            try:
                value = int(open_webui_port)
            except (TypeError, ValueError):
                value = 0
            state["openWebuiPort"] = value if value in OPENWEBUI_HOST_PORTS else 0
        path = self.ai_state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state), encoding="utf-8")
        return state

    def _published_loopback_port(self, ports, dest):
        dest = str(dest)
        for bind, host, target, proto in ports or ():
            if str(target) == dest and str(proto or "tcp") == "tcp" and str(bind) == "127.0.0.1":
                try:
                    return int(host)
                except (TypeError, ValueError):
                    continue
        return 0

    def _pick_loopback_port(self, preferred, candidates, exclude=()):
        chosen = []
        if preferred and preferred in candidates:
            chosen.append(preferred)
        for port in candidates:
            if port not in chosen:
                chosen.append(port)
        blocked = {int(item) for item in exclude or () if str(item).isdigit() or isinstance(item, int)}
        for port in chosen:
            if port in blocked:
                continue
            if not self.port_open(port):
                return port
        for port in chosen:
            if port not in blocked:
                return port
        return chosen[0] if chosen else 0

    def ollama_host_port(self, ports=()):
        found = self._published_loopback_port(ports, OLLAMA_CONTAINER_PORT)
        if found:
            return found
        return self.read_ai_state().get("ollamaPort") or 0

    def openwebui_host_port(self, ports=()):
        found = self._published_loopback_port(ports, OPENWEBUI_CONTAINER_PORT)
        if found:
            return found
        return self.read_ai_state().get("openWebuiPort") or 0

    def ensure_ai_network(self, sock=None):
        runner = (lambda args, timeout=20: self.run_on(args, timeout=timeout, sock=sock)) if sock is not None else (
            lambda args, timeout=20: self.run(args, timeout=timeout)
        )
        inspected = runner(["network", "inspect", AI_NETWORK], 10)
        if inspected.returncode == 0:
            return ""
        created = runner(["network", "create", AI_NETWORK], 20)
        blob = f"{created.stderr or ''}\n{created.stdout or ''}"
        if created.returncode == 0:
            return ""
        inspected = runner(["network", "inspect", AI_NETWORK], 10)
        if inspected.returncode == 0:
            return ""
        detail = [line.strip() for line in blob.splitlines() if line.strip()]
        return detail[-1][:180] if detail else "Docker could not create the hog-ai network."

    def _gpu_memory_mb(self):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return 0
        if result.returncode != 0:
            return 0
        for line in (result.stdout or "").splitlines():
            text = line.strip().split(",")[0].strip()
            if text.replace(".", "", 1).isdigit():
                try:
                    return int(float(text))
                except (TypeError, ValueError):
                    continue
        return 0

    def ai_gpu_fields(self):
        ready = False
        name = ""
        try:
            ok, name = self._nvidia_smi()
        except (RuntimeError, OSError, TypeError, ValueError):
            ok, name = False, ""
        memory = self._gpu_memory_mb() if ok else 0
        engine_ok = bool(((self.runtime_fields().get("dockerRuntimes") or {}).get(RUNTIME_ENGINE) or {}).get("ok"))
        toolkit = False
        try:
            toolkit = bool(engine_ok and self.gpu_is_ready())
        except (RuntimeError, OSError, TypeError, ValueError):
            toolkit = False
        ready = bool(ok and toolkit)
        notice = ""
        if not ok:
            notice = "No NVIDIA GPU was detected. Ollama will run on the CPU, which is slower."
        elif not engine_ok:
            notice = "Docker Engine is not available, so Ollama cannot use the NVIDIA GPU."
        elif not toolkit:
            notice = "The NVIDIA Container Toolkit is not ready, so Ollama will run on the CPU. Use the GPU card on Containers to install it."
        elif memory:
            notice = f"NVIDIA GPU is ready ({name or 'NVIDIA'}, {memory} MB). Ollama will use it on Docker Engine."
        else:
            notice = f"NVIDIA GPU is ready ({name or 'NVIDIA'}). Ollama will use it on Docker Engine."
        return {
            "ready": ready,
            "name": name,
            "memoryMb": memory,
            "notice": notice,
        }

    def ai_disk_fields(self, needed=0):
        try:
            usage = shutil.disk_usage(str(self.data))
            free = int(usage.free)
        except (OSError, TypeError, ValueError):
            free = 0
        warning = ""
        if free and free < AI_DISK_WARN_BYTES:
            warning = f"This computer has {format_bytes(free)} free. Model downloads are several gigabytes each."
        try:
            need = int(needed or 0)
        except (TypeError, ValueError):
            need = 0
        if free and need and free < need + 2 * 1024 * 1024 * 1024:
            warning = f"This computer has {format_bytes(free)} free, which may not be enough for that download."
        return {"freeBytes": free, "warning": warning}

    def _prepare_ai_container(self, name, image, ports, env, side):
        sock = self.runtime_sock(side)
        problem = self.ensure_ai_network(sock=sock)
        if problem:
            return None, problem
        env = tuple(item for item in env or () if ENV_RE.fullmatch(str(item)))
        gpus = False
        if is_ollama_image(name, image) or name == OLLAMA_NAME:
            mounts = (OLLAMA_MOUNT,)
            existing = self._published_loopback_port(ports, OLLAMA_CONTAINER_PORT)
            host_port = self._pick_loopback_port(existing or self.ollama_host_port(), OLLAMA_HOST_PORTS)
            ports = (("127.0.0.1", str(host_port), OLLAMA_CONTAINER_PORT, "tcp"),)
            self.write_ai_state(ollama_port=host_port)
            gpu = self.ai_gpu_fields()
            if side == RUNTIME_ENGINE and gpu.get("ready"):
                gpus = True
                extra = []
                if NVIDIA_VISIBLE_ENV not in env:
                    extra.append(NVIDIA_VISIBLE_ENV)
                if NVIDIA_CAPS_ENV not in env:
                    extra.append(NVIDIA_CAPS_ENV)
                env = tuple(env) + tuple(extra)
            return (mounts, env, ports, AI_NETWORK, gpus, AI_MEMORY), ""
        if is_open_webui_image(name, image) or name == OPENWEBUI_NAME:
            mounts = (OPENWEBUI_MOUNT,)
            existing = self._published_loopback_port(ports, OPENWEBUI_CONTAINER_PORT)
            host_port = self._pick_loopback_port(existing or self.openwebui_host_port(), OPENWEBUI_HOST_PORTS)
            ports = (("127.0.0.1", str(host_port), OPENWEBUI_CONTAINER_PORT, "tcp"),)
            if OLLAMA_BASE_ENV not in env:
                env = tuple(env) + (OLLAMA_BASE_ENV,)
            self.write_ai_state(open_webui_port=host_port)
            return (mounts, env, ports, AI_NETWORK, False, AI_MEMORY), ""
        return None, "That AI image is not available."

    def _item_state(self, name, items=None):
        rows = items if items is not None else self.items()
        for item in rows or ():
            if isinstance(item, dict) and item.get("name") == name:
                return item
        return {"name": name, "state": "missing", "runtime": self.container_runtime(name), "reason": "", "image": ""}

    def _publish_open_webui(self, port=None):
        port = int(port or self.openwebui_host_port() or 0)
        if not port:
            return "Open WebUI does not have a local port yet.", ""
        return self.publish_port(port, kind="https")

    def openwebui_phone_url(self, ip=None, port=None):
        ip = ip or self.tailscale_ipv4()
        port = int(port or self.openwebui_host_port() or 0)
        if not ip or not port:
            return ""
        return f"https://{ip}:{port}"

    def _ollama_base_url(self):
        port = self.ollama_host_port()
        if not port:
            return ""
        return f"http://127.0.0.1:{port}"

    def ollama_http(self, method, path, body=None, timeout=20):
        base = self._ollama_base_url()
        if not base:
            return None, "Start Ollama first."
        if not str(path or "").startswith("/"):
            return None, "That request is not available."
        url = base + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=str(method or "GET").upper(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if len(raw) > 4 * 1024 * 1024:
                    return None, "That Ollama response was too large."
                if not raw:
                    return {}, ""
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None, "Ollama did not return JSON."
                return parsed, ""
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:180]
            except OSError:
                detail = ""
            return None, detail or f"Ollama returned HTTP {exc.code}."
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            return None, str(exc)[:180] or "Ollama did not answer."

    def _model_row(self, item, gpu_mb=0):
        if not isinstance(item, dict):
            return None
        name = str(item.get("name") or item.get("model") or "").strip()
        if not valid_model_name(name):
            return None
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        details = item.get("details") if isinstance(item.get("details"), dict) else {}
        parameter = str(details.get("parameter_size") or item.get("parameter_size") or "")
        quantization = str(details.get("quantization_level") or item.get("quantization_level") or "")
        vram = estimate_model_vram_mb(size)
        fit = "unknown"
        if gpu_mb and vram:
            fit = "fits" if vram <= gpu_mb else "tight" if vram <= gpu_mb + 1024 else "over"
        elif not gpu_mb:
            fit = "cpu"
        return {
            "name": name,
            "size": size,
            "sizeLabel": format_bytes(size) if size else "",
            "vramMb": vram,
            "parameter": parameter,
            "quantization": quantization,
            "fit": fit,
        }

    def list_ai_models(self):
        payload, error = self.ollama_http("GET", "/api/tags", timeout=15)
        if error:
            return [], error
        models = []
        gpu_mb = self.ai_gpu_fields().get("memoryMb") or 0
        for item in (payload or {}).get("models") or []:
            row = self._model_row(item, gpu_mb)
            if row:
                models.append(row)
        return models, ""

    def ai_status_fields(self, models=False, items=None):
        rows = items if items is not None else (self.items() if self.docker_running() else self._offline_items())
        ollama = self._item_state(OLLAMA_NAME, rows)
        webui = self._item_state(OPENWEBUI_NAME, rows)
        gpu = self.ai_gpu_fields()
        disk = self.ai_disk_fields()
        ollama_port = self.ollama_host_port()
        webui_port = self.openwebui_host_port()
        ts_ip = ""
        try:
            if any(isinstance(item, dict) and item.get("name") == "tailscale" and item.get("state") == "running" for item in rows):
                ts_ip = self.tailscale_ipv4()
        except (RuntimeError, OSError):
            ts_ip = ""
        phone = self.openwebui_phone_url(ts_ip, webui_port) if webui.get("state") == "running" and ts_ip and webui_port else ""
        installed, model_error = ([], "")
        if models and ollama.get("state") == "running":
            installed, model_error = self.list_ai_models()
        installed_names = {str(row.get("name") or "") for row in installed}
        suggestions = []
        for item in AI_MODEL_SUGGESTIONS:
            vram = int(item["vramMb"])
            fit = "cpu"
            if gpu.get("memoryMb"):
                memory = int(gpu["memoryMb"])
                fit = "fits" if vram <= memory else "tight" if vram <= memory + 1024 else "over"
            suggestions.append({**item, "fit": fit, "installed": _model_is_installed(item["name"], installed_names)})
        return {
            "ai": {
                "network": AI_NETWORK,
                "ollama": {
                    "name": OLLAMA_NAME,
                    "image": OLLAMA_IMAGE,
                    "state": ollama.get("state") or "missing",
                    "runtime": ollama.get("runtime") or self.container_runtime(OLLAMA_NAME),
                    "reason": ollama.get("reason") or "",
                    "gpu": bool(gpu.get("ready") and (ollama.get("runtime") or "") == RUNTIME_ENGINE and ollama.get("state") == "running"),
                    "port": ollama_port,
                    "localUrl": f"http://127.0.0.1:{ollama_port}" if ollama_port and ollama.get("state") == "running" else "",
                },
                "openWebui": {
                    "name": OPENWEBUI_NAME,
                    "image": OPENWEBUI_IMAGE,
                    "state": webui.get("state") or "missing",
                    "runtime": webui.get("runtime") or self.container_runtime(OPENWEBUI_NAME),
                    "reason": webui.get("reason") or "",
                    "port": webui_port,
                    "localUrl": f"http://127.0.0.1:{webui_port}" if webui_port and webui.get("state") == "running" else "",
                    "phoneUrl": phone,
                },
                "gpu": gpu,
                "disk": disk,
                "models": installed,
                "modelsError": model_error,
                "suggestions": suggestions,
                "groups": [{"id": item[0], "title": item[1], "blurb": item[2]} for item in AI_MODEL_GROUPS],
                "libraryUrl": OLLAMA_LIBRARY_URL,
                "editor": self.editor_status_fields(
                    installed_names if models else None,
                    ollama.get("state") or "missing",
                ),
            }
        }

    def ai_status(self, models=False):
        payload = self.engine_status()
        payload.update(self.ai_status_fields(models=models, items=payload.get("items")))
        return payload

    def pull_ai_model(self, name, progress=None):
        model = str(name or "").strip().lower()
        if not valid_model_name(model):
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = "Use a model name like llama3.1:8b."
            return payload
        disk = self.ai_disk_fields()
        if disk.get("warning") and disk.get("freeBytes") and disk["freeBytes"] < 3 * 1024 * 1024 * 1024:
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = disk["warning"]
            return payload
        base = self._ollama_base_url()
        if not base:
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = "Start Ollama first."
            return payload
        body = json.dumps({"name": model, "stream": True}).encode("utf-8")
        request = urllib.request.Request(
            base + "/api/pull",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        last = {"name": model, "status": "Starting download…", "percent": None, "error": ""}
        if callable(progress):
            try:
                progress({"ok": True, "error": "", "aiPull": last, **self.ai_status_fields(models=False)})
            except Exception:
                pass
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                for raw in response:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    status = str(event.get("status") or event.get("error") or "Downloading…")[:160]
                    completed = event.get("completed")
                    total = event.get("total")
                    percent = None
                    try:
                        if total and completed is not None and int(total) > 0:
                            percent = max(0, min(100, int(int(completed) * 100 / int(total))))
                    except (TypeError, ValueError):
                        percent = None
                    last = {
                        "name": model,
                        "status": status,
                        "percent": percent,
                        "error": str(event.get("error") or ""),
                    }
                    if callable(progress):
                        try:
                            progress({"ok": not last["error"], "error": last["error"], "aiPull": last, **self.ai_status_fields(models=False)})
                        except Exception:
                            pass
                    if event.get("error"):
                        break
        except urllib.error.HTTPError as exc:
            last["error"] = f"Ollama returned HTTP {exc.code}."
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last["error"] = str(exc)[:180] or "Ollama did not finish that download."
        payload = self.ai_status(models=True)
        payload["aiPull"] = last
        if last.get("error"):
            payload["ok"] = False
            payload["error"] = last["error"]
        else:
            payload["notice"] = f"Downloaded {model}."
        return payload

    def delete_ai_model(self, name):
        model = str(name or "").strip().lower()
        if not valid_model_name(model):
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = "Use a model name like llama3.1:8b."
            return payload
        _payload, error = self.ollama_http("DELETE", "/api/delete", {"name": model}, timeout=30)
        payload = self.ai_status(models=True)
        if error:
            payload["ok"] = False
            payload["error"] = error
            return payload
        payload["notice"] = f"Deleted {model}."
        return payload


    def _user_home(self):
        return Path.home()

    def _which(self, name):
        return shutil.which(name)

    def editor_status_fields(self, installed_names=None, ollama_state=""):
        editor = detect_code_editor(home=self._user_home(), which=self._which, runner=self.run_argv)
        known = installed_names is not None
        names = set(installed_names or ())
        running = ollama_state == "running"
        models = []
        missing = []
        for item in CONTINUE_MODELS:
            installed = bool(known and running and _model_is_installed(item["name"], names))
            models.append({**item, "installed": installed})
            if known and running and not installed:
                missing.append(item["name"])
        return {
            "found": bool(editor.get("found")),
            "command": editor.get("command") or "",
            "appId": editor.get("appId") or "",
            "label": editor.get("label") or "",
            "continueInstalled": continue_extension_installed(self._user_home()),
            "configExists": continue_config_path(self._user_home()).is_file(),
            "configPath": "~/.continue/config.yaml",
            "downloadUrl": VSCODE_DOWNLOAD_URL,
            "marketplaceUrl": CONTINUE_MARKETPLACE_URI,
            "models": models,
            "missingModels": missing,
            "ollamaRunning": running,
            "modelsKnown": bool(known and running),
        }

    def install_continue_extension(self):
        editor = detect_code_editor(home=self._user_home(), which=self._which, runner=self.run_argv)
        if not editor.get("found"):
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = "Install Visual Studio Code first. Use the link on this card."
            return payload
        argv = continue_install_argv(editor)
        if not argv or argv[-2:] != ("--install-extension", CONTINUE_EXTENSION_ID):
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = "Could not build the Continue install command."
            return payload
        error = ""
        try:
            result = self.run_argv(argv, timeout=120)
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
            result = None
            error = str(exc)[:180] or "Could not start the editor."
        else:
            if result.returncode != 0:
                error = ((result.stderr or result.stdout or "The editor did not install Continue.").strip())[:180]
            else:
                payload = self.ai_status(models=True)
                payload["notice"] = f"Installed Continue in {editor.get('label') or 'the editor'}."
                return payload
        opened = self.open_continue_marketplace()
        payload = self.ai_status(models=True)
        if opened:
            payload["notice"] = "Could not install from the command line, so Hog opened the Continue extension in your editor."
            return payload
        payload["ok"] = False
        payload["error"] = error or "Could not install Continue."
        return payload

    def open_continue_marketplace(self):
        argv = continue_marketplace_argv(which=self._which)
        if not argv or allowed_continue_marketplace_uri(argv[-1]) != CONTINUE_MARKETPLACE_URI:
            return False
        try:
            result = self.run_argv(argv, timeout=8)
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            return False
        return result.returncode == 0

    def write_continue_config(self):
        port = self.ollama_host_port() or 11434
        if port not in OLLAMA_HOST_PORTS:
            port = 11434
        api_base = f"http://127.0.0.1:{port}"
        try:
            _path, backup = write_continue_config_file(home=self._user_home(), api_base=api_base)
        except OSError as exc:
            payload = self.ai_status(models=True)
            payload["ok"] = False
            payload["error"] = str(exc)[:180] or "Could not write ~/.continue/config.yaml."
            return payload
        payload = self.ai_status(models=True)
        if backup is not None:
            payload["notice"] = f"Wrote ~/.continue/config.yaml. Previous file saved as {backup.name}."
        else:
            payload["notice"] = "Wrote ~/.continue/config.yaml for local Ollama."
        return payload

    def pull_continue_models(self, progress=None):
        status = self.ai_status(models=True)
        editor = (status.get("ai") or {}).get("editor") or {}
        if not editor.get("ollamaRunning"):
            status["ok"] = False
            status["error"] = "Start Ollama first."
            return status
        missing = [name for name in (editor.get("missingModels") or []) if valid_model_name(name)]
        if not missing:
            status["notice"] = "The Continue models are already installed."
            return status
        downloaded = []
        last = status
        for name in missing:
            last = self.pull_ai_model(name, progress=progress)
            if last.get("ok") is False or (last.get("aiPull") or {}).get("error"):
                if downloaded:
                    detail = last.get("error") or "Ollama did not finish that download."
                    last["error"] = f"Downloaded {', '.join(downloaded)}, but failed on {name}. {detail}"
                return last
            downloaded.append(name)
        last["notice"] = "Downloaded " + ", ".join(downloaded) + "."
        return last

    def handle(self, action, name="", image="", progress=None):
        if action == "update-status":
            return self.update_status()
        if action == "update-check":
            return self.update_check(force=False)
        if action == "update-check-now":
            return self.update_check(force=True)
        if action == "update-install":
            return self.install_update()
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
        if action == "runtime-set":
            return self._mark_docker(self.set_container_runtime(name, image))
        if action == "network-list":
            return self._mark_docker(self.list_networks(name))
        if action == "network-create":
            return self._mark_docker(self.create_network(name))
        if action == "network-remove":
            return self._mark_docker(self.remove_network(name))
        if action == "network-connect":
            return self._mark_docker(self.connect_network(name))
        if action == "network-disconnect":
            return self._mark_docker(self.disconnect_network(name))
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
        if action == "ai-models":
            return self._mark_docker(self.ai_status(models=True))
        if action == "ai-pull":
            return self._mark_docker(self.pull_ai_model(name, progress=progress))
        if action == "ai-delete":
            return self._mark_docker(self.delete_ai_model(name))
        if action == "ai-editor-install":
            return self._mark_docker(self.install_continue_extension())
        if action == "ai-editor-connect":
            return self._mark_docker(self.write_continue_config())
        if action == "ai-editor-pull":
            return self._mark_docker(self.pull_continue_models(progress=progress))
        if action in {"run", "recreate"}:
            return self._mark_docker(self.apply_command(name, replace=action == "recreate", runtime=image, progress=progress))
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
        if action in {"start", "stop", "restart"}:
            result = self.container_run(name, [action, name], timeout=40 if action == "restart" else 8)
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "Docker refused.").strip().splitlines()
                return {"ok": False, "error": detail[-1][:180], "items": self.items()}
            if action in {"start", "restart"} and not assess(info, name, self.data):
                self.remember(name)
                problem = self.prepare_tailscale_firewall(name, info)
                if problem:
                    return {"ok": False, "error": problem, "items": self.items()}
                if name == OPENWEBUI_NAME or is_open_webui_image(name, container_image(info, fallback="")):
                    self._publish_open_webui()
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
            result = self.container_run(name, launch_args({"name": name, "image": image}, image), timeout=180)
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
                self.container_run(name, ["rm", "-f", name], timeout=20)
            return {"ok": False, "error": reason, "items": self.items()}
        running = isinstance(info.get("State"), dict) and info["State"].get("Running") is True
        if not running:
            started = self.container_run(name, ["start", name])
            if started.returncode != 0:
                detail = f"{started.stderr or ''}\n{started.stdout or ''}".strip().splitlines()
                return {
                    "ok": False,
                    "error": detail[-1][:180] if detail else "Docker did not start that container.",
                    "items": self.items(),
                }
        self.remember(name)
        return {"ok": True, "error": "", "items": self.items()}

    def _docker_runner(self, sock=None):
        if sock is not None:
            return lambda args, timeout=10: self.run_on(args, timeout=timeout, sock=sock)
        return lambda args, timeout=10: self.run(args, timeout=timeout)

    def image_exists(self, image, sock=None):
        if not valid_image(image):
            return False
        try:
            result = self._docker_runner(sock)(["image", "inspect", "--format", "{{.Id}}", image], timeout=20)
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    def pull_image(self, image, sock=None, progress=None):
        if not valid_image(image):
            return "That image name is not allowed."
        if callable(progress):
            try:
                progress({
                    "ok": True,
                    "error": "",
                    "notice": f"Downloading {image}…",
                    "imagePull": {"image": image, "status": "Downloading image…", "percent": None},
                })
            except Exception:
                pass
        try:
            result = self._docker_runner(sock)(["pull", image], timeout=600)
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            return "Docker did not finish downloading that image."
        if result.returncode != 0:
            blob = f"{result.stderr or ''}\n{result.stdout or ''}"
            if docker_offline(blob):
                return "Docker is not running."
            detail = [line.strip() for line in blob.splitlines() if line.strip()]
            return detail[-1][:180] if detail else "Docker did not download that image."
        if callable(progress):
            try:
                progress({
                    "ok": True,
                    "error": "",
                    "notice": f"Downloaded {image}.",
                    "imagePull": {"image": image, "status": "Downloaded", "percent": 100},
                })
            except Exception:
                pass
        return ""

    def ensure_image(self, image, sock=None, progress=None):
        if self.image_exists(image, sock=sock):
            return ""
        return self.pull_image(image, sock=sock, progress=progress)

    def apply_command(self, cmdline, replace=False, runtime="", progress=None):
        try:
            name, image, ports, vpn, command, env, sysctls, _mounts, network = parse_run(cmdline)
        except CommandError as exc:
            return {"ok": False, "error": str(exc), "items": self.items()}
        if valid_runtime(runtime):
            if name == "jellyfin" and runtime == RUNTIME_DESKTOP and self.gpu_enabled():
                return {
                    "ok": False,
                    "error": "GPU acceleration needs Docker Engine. Turn off the NVIDIA GPU toggle first, or keep Jellyfin on Docker Engine.",
                    "items": self.items(),
                }
            self.save_runtime(name, runtime)
        elif is_ai_image(name, image) and self.runtime_available(RUNTIME_ENGINE):
            self.save_runtime(name, RUNTIME_ENGINE)
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
        memory = "2g"
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
        if is_ai_image(name, image):
            prepared, problem = self._prepare_ai_container(name, image, ports, env, self.container_runtime(name))
            if problem:
                return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
            mounts, env, ports, network, gpus, memory = prepared
        if "tailscale" in image.lower() or name == "tailscale":
            mounts = (*mounts, TAILSCALE_STATE_MOUNT)
            side = self.container_runtime(name)
            if side == RUNTIME_ENGINE:
                network = "host"
            else:
                network = TAILSCALE_NETWORK
                problem = self.ensure_tailscale_network(sock=self.container_sock(name))
                if problem:
                    return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        problem = self.ensure_image(image, sock=self.container_sock(name), progress=progress)
        if problem:
            return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        run_args = compose_run(name, image, ports, vpn, command, env, sysctls, mounts, network, gpus=gpus, memory=memory)
        if ("tailscale" in image.lower() or name == "tailscale") and network == "host":
            if "--cap-add=NET_ADMIN" in run_args and "--cap-add=NET_RAW" not in run_args:
                run_args = list(run_args)
                run_args.insert(run_args.index("--cap-add=NET_ADMIN") + 1, "--cap-add=NET_RAW")
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
        if "tailscale" in image.lower() or name == "tailscale":
            self.save_runtime(name, self.container_runtime(name))
        elif jellyfin:
            self.save_runtime(name, RUNTIME_ENGINE if self.gpu_enabled() else self.container_runtime(name))
        elif is_ai_image(name, image):
            self.save_runtime(name, self.container_runtime(name))
        problem = self.prepare_tailscale_firewall(name, info)
        if problem:
            return {"ok": False, "error": problem, "items": self.items(), "command": command_text}
        verb = "Recreated" if replace else "Started"
        notice = f"{verb} {name}."
        enable = ""
        if is_open_webui_image(name, image):
            dns, live = self.tailscale_dns()
            problem, enable = self._publish_open_webui() if live else ("", "")
            port = self.openwebui_host_port()
            if enable:
                notice = (
                    f"{verb} {name}. Allow Tailscale serve once from the AI or Tailscale page. "
                    "The first account you create in Open WebUI becomes the admin."
                )
            elif problem:
                notice = f"{verb} {name}. {problem}"
            elif live and port and self.tailscale_ipv4():
                notice = (
                    f"{verb} {name}. On this computer open http://127.0.0.1:{port}. "
                    f"On your phone open https://{self.tailscale_ipv4()}:{port}. "
                    "The first account you create in Open WebUI becomes the admin."
                )
            elif port:
                notice = (
                    f"{verb} {name}. On this computer open http://127.0.0.1:{port}. "
                    "Start Tailscale and sign in to reach it from your phone. "
                    "The first account you create in Open WebUI becomes the admin."
                )
            if not any(item.get("name") == OLLAMA_NAME and item.get("state") == "running" for item in self.items() if isinstance(item, dict)):
                notice = f"{notice} Start Ollama too so the chat page can reach models."
        if is_ollama_image(name, image):
            if gpus:
                notice = f"{verb} {name}. Ollama is using the NVIDIA GPU on Docker Engine."
            else:
                notice = (
                    f"{verb} {name}. No NVIDIA GPU is available to this runtime, so Ollama will run on the CPU. "
                    "That is slower, especially for larger models."
                )
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

    def ensure_tailscale_network(self, sock=None):
        runner = (lambda args, timeout=10: self.run_on(args, timeout=timeout, sock=sock)) if sock is not None else (
            lambda args, timeout=10: self.run(args, timeout=timeout)
        )
        inspected = runner(["network", "inspect", TAILSCALE_NETWORK], 10)
        if inspected.returncode == 0:
            return ""
        created = runner(
            ["network", "create", "--ipv6", "--subnet", TAILSCALE_IPV6_SUBNET, TAILSCALE_NETWORK],
            20,
        )
        if created.returncode != 0:
            detail = f"{created.stderr or ''}\n{created.stdout or ''}".strip().splitlines()
            return detail[-1][:180] if detail else "Docker could not create the tailscale network."
        return ""

    def prepare_tailscale_firewall(self, name, info):
        config = info.get("Config") if isinstance(info, dict) and isinstance(info.get("Config"), dict) else {}
        if "tailscale" not in str(config.get("Image") or "").lower():
            return ""
        listed = self.container_run(name, ["exec", name, "ls", "-l", "/usr/sbin/iptables", "/usr/sbin/ip6tables"], timeout=15)
        text = f"{listed.stdout or ''}\n{listed.stderr or ''}"
        if listed.returncode != 0:
            return "Tailscale did not show its firewall command."
        if text.count("xtables-nft-multi") >= 2 and "legacy" not in text:
            return ""
        for path in ("/usr/sbin/iptables", "/usr/sbin/ip6tables"):
            linked = self.container_run(name, ["exec", name, "ln", "-sfn", "xtables-nft-multi", path], timeout=15)
            if linked.returncode != 0:
                return "Tailscale could not switch its firewall command."
        restarted = self.container_run(name, ["restart", name], timeout=40)
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
                    env=docker_host_env(self.container_sock(name)) if self.container_sock(name) else None,
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
            listed = self.container_run(name, ["exec", name, "find", "/config", "-maxdepth", "3", "-name", "*.png"], timeout=15)
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
            result = self.container_run(
                name,
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
                    env=docker_host_env(self.container_sock(name)) if self.container_sock(name) else None,
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
            listed = self.container_run(name, ["exec", name, "find", "/config", "-maxdepth", "3", "-name", "*.conf"], timeout=15)
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
            result = self.container_run(
                name,
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
            result = self.container_run(name, launch_args(preset, self.image_for(preset)), timeout=180)
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
                self.container_run(name, ["rm", "-f", name], timeout=20)
            return {"ok": False, "error": reason, "items": self.items()}
        running = isinstance(info.get("State"), dict) and info["State"].get("Running") is True
        if not running:
            started = self.container_run(name, ["start", name])
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
        removed = self.container_run(name, ["rm", "-f", name], timeout=30)
        if removed.returncode != 0:
            return None, "Hog could not replace that container."
        started = self.container_run(name, launch_args(preset, self.image_for(preset)), timeout=180)
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
            self.shell.docker_sock = self.container_sock(name)
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
            result = self.container_run(preset["name"], ["image", "inspect", "--format", "{{.Id}}", tag], timeout=15)
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
            result = self.container_run(name, ["commit", name, tag], timeout=300)
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
