import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import guard as guard_module
from share_page import listing_page, safe_target
from guard import drop_destination, drop_file_path, format_bytes, library_folder, media_listing, remove_media_entry, take_drop
from guard import (
    ENGINE_START,
    JELLYFIN_CACHE_VOLUME,
    JELLYFIN_CONFIG_VOLUME,
    NVIDIA_CAPS_ENV,
    NVIDIA_VISIBLE_ENV,
    PRESETS,
    SHARE_NAME_RE,
    CommandError,
    Guard,
    assess,
    assign_share_port,
    canonical_command,
    compose_run,
    NVIDIA_TOOLKIT_HELPER,
    docker_engine_install_commands,
    docker_offline,
    docker_volume_data,
    folder_problem,
    launch_args,
    mount_problem,
    nvidia_device_path,
    nvidia_toolkit_helper_status,
    nvidia_toolkit_install_commands,
    parse_nvidia_gpu_name,
    parse_run,
    network_delete_problem,
    tailscale_serve_host,
    valid_cidr,
    valid_gateway,
    valid_name,
    valid_network_driver,
    valid_network_name,
    valid_runtime,
    RUNTIME_ENGINE,
    RUNTIME_DESKTOP,
    BUILTIN_NETWORKS,
    SELF_UPDATE_HELPER,
    allowed_update_url,
    allowed_update_redirect_url,
    canonical_update_path,
    deb_field,
    file_sha256,
    hog_version,
    parse_latest_release,
    parse_sha256_digest,
    parse_sha256sums,
    parse_version,
    version_newer,
)


DATA = Path("/home/whitefang/.local/share/hog-browser")


def info(**host):
    mounts = host.pop("mounts", [])
    return {
        "Name": "/demo",
        "State": {"Status": "created"},
        "Config": {"Image": "busybox"},
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
        "Mounts": mounts,
    }


class PolicyTest(unittest.TestCase):
    def test_plain_bridge_container_is_allowed(self):
        self.assertEqual(assess(info(), "demo", DATA), "")

    def test_rejects_names_flags_and_paths(self):
        self.assertFalse(valid_name("-rf"))
        self.assertFalse(valid_name("../wallet"))
        self.assertTrue(valid_name("hog.node_1"))

    def test_rejects_privileged_host_and_caps(self):
        self.assertIn("privileged", assess(info(Privileged=True), "demo", DATA))
        self.assertIn("host", assess(info(NetworkMode="host"), "demo", DATA))
        self.assertIn("host", assess(info(PidMode="host"), "demo", DATA))
        self.assertIn("capability", assess(info(CapAdd=["SYS_ADMIN"]), "demo", DATA))
        tailscale = info(NetworkMode="host")
        tailscale["Name"] = "/tailscale"
        tailscale["Config"] = {"Image": "tailscale/tailscale:latest"}
        self.assertEqual(assess(tailscale, "tailscale", DATA), "")
        busybox = info(NetworkMode="host")
        busybox["Name"] = "/tailscale"
        busybox["Config"] = {"Image": "busybox"}
        self.assertIn("host", assess(busybox, "tailscale", DATA))

    def test_rejects_socket_wallet_and_system_mounts(self):
        sock = info(Binds=["/var/run/docker.sock:/var/run/docker.sock"])
        self.assertIn("socket", assess(sock, "demo", DATA))
        home = info(Binds=["/home/whitefang:/data"])
        self.assertIn("wallet", assess(home, "demo", DATA))
        inner = info(mounts=[{"Source": str(DATA / "opfs"), "Destination": "/opfs", "Type": "bind"}])
        self.assertIn("wallet", assess(inner, "demo", DATA))
        proc = info(Binds=["/proc:/host/proc"])
        self.assertIn("system", assess(proc, "demo", DATA))
        volume = "/var/lib/docker/volumes/abc123/_data"
        self.assertTrue(docker_volume_data(volume))
        self.assertEqual(mount_problem(volume, DATA), "")
        self.assertFalse(docker_volume_data("/var/lib/docker/volumes/../_data"))
        self.assertIn("Docker", mount_problem("/var/lib/docker", DATA))
        self.assertIn("Docker", mount_problem("/var/lib/docker/volumes", DATA))
        self.assertIn("Docker", mount_problem("/var/lib/docker/overlay2/abc", DATA))
        self.assertIn("Docker", assess(info(Binds=["/var/lib/docker:/var/lib/docker"]), "demo", DATA))

    def test_distro_launch_stays_locked_down(self):
        self.assertEqual(set(PRESETS), {"ubuntu", "fedora"})
        for preset in PRESETS.values():
            args = launch_args(preset)
            self.assertNotIn("--privileged", args)
            self.assertNotIn("no-new-privileges", args)
            self.assertNotIn("-v", args)
            self.assertNotIn("--network", args)
            self.assertNotIn("--cap-add=SYS_ADMIN", args)
            self.assertNotIn("--cap-add=NET_ADMIN", args)
            self.assertIn("--cap-drop=ALL", args)
            self.assertIn("--cap-add=SETUID", args)
            self.assertIn("--cap-add=SYS_CHROOT", args)
            self.assertIn("--memory", args)
            self.assertIn("2g", args)
            self.assertIn("--pids-limit", args)
            self.assertIn("1024", args)
            self.assertNotIn("512m", args)
            self.assertIn(preset["image"], args)
            self.assertTrue(valid_name(preset["name"]))

    def test_offline_daemon_message(self):
        self.assertTrue(docker_offline("failed to connect to the docker API at unix:///home/whitefang/.docker/desktop/docker.sock"))
        self.assertFalse(docker_offline("No such container: demo"))

    def test_allowlist_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="false")
            guard.write_names(["alpha"])
            self.assertEqual(json.loads(Path(folder, "containers.json").read_text())["names"], ["alpha"])
            self.assertEqual(Path(folder, "containers.json").stat().st_mode & 0o777, 0o600)
            guard.inspect = lambda name: (None, "Docker did not find that container.")
            refused = guard.handle("start", "nope")
            self.assertFalse(refused["ok"])
            self.assertIn("did not find", refused["error"])

    def test_engine_start_uses_desktop_service_only(self):
        self.assertEqual(
            ENGINE_START,
            ["systemctl", "--user", "start", "docker-desktop.service"],
        )
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []

            def run_argv(args, timeout=8):
                calls.append((list(args), timeout))
                return subprocess.CompletedProcess(args, 0, "", "")

            seen = {"n": 0}

            def running():
                seen["n"] += 1
                return seen["n"] > 1

            guard.run_argv = run_argv
            guard.docker_running = running
            guard.items = lambda: []
            result = guard.handle("engine-start", "ubuntu && rm -rf /")
            self.assertEqual(calls[0], (ENGINE_START, 75))
            self.assertEqual([item[0] for item in calls if item[0] != ["lsmod"]], [ENGINE_START])
            self.assertTrue(result["ok"])
            self.assertTrue(result["docker"])
            self.assertEqual(result["items"], [])

    def test_engine_start_skips_service_when_docker_is_up(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.docker_running = lambda: True
            guard.wireguard_module_loaded = lambda: True
            guard.items = lambda: [{"name": "hog-ubuntu", "state": "running", "image": "", "reason": ""}]

            def run_argv(args, timeout=8):
                raise AssertionError(args)

            guard.run_argv = run_argv
            result = guard.handle("engine-start", "nope")
            self.assertTrue(result["docker"])
            self.assertEqual(result["items"][0]["name"], "hog-ubuntu")

    def test_engine_start_reports_service_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.docker_running = lambda: False
            guard.read_names = lambda: ["hog-ubuntu"]

            def run_argv(args, timeout=8):
                return subprocess.CompletedProcess(args, 1, "", "Failed to start docker-desktop.service.")

            guard.run_argv = run_argv
            result = guard.start_engine(wait=0, pause=0)
            self.assertFalse(result["ok"])
            self.assertFalse(result["docker"])
            self.assertIn("Failed to start", result["error"])
            self.assertEqual(result["items"][0]["name"], "hog-ubuntu")
            self.assertEqual(result["items"][0]["reason"], "")

    def test_list_when_docker_is_down_keeps_names(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.write_names(["hog-ubuntu"])
            guard.docker_running = lambda: False
            result = guard.handle("list")
            self.assertTrue(result["ok"])
            self.assertFalse(result["docker"])
            self.assertEqual(result["items"][0]["name"], "hog-ubuntu")
            self.assertEqual(result["items"][0]["reason"], "")

    def test_list_reads_engine_containers_when_desktop_context_is_down(self):
        # Default context = Docker Desktop (stopped), containers live on Engine.
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.write_names(["jellyfin", "tailscale"])
            guard.save_runtime("jellyfin", "engine")
            guard.save_runtime("tailscale", "engine")
            guard.docker_running = lambda: False
            guard._native_engine_status = lambda: {"ok": True, "installed": True, "running": True, "permission": True, "info": {}}
            guard.items = lambda: [
                {"name": "jellyfin", "state": "running", "image": "", "reason": "", "runtime": "engine"},
                {"name": "tailscale", "state": "running", "image": "", "reason": "", "runtime": "engine"},
            ]
            guard.tailscale_ipv4 = lambda: ""
            guard.tailscale_backend = lambda: {"state": "", "loginUrl": ""}
            result = guard.handle("list")
            self.assertTrue(result["ok"])
            self.assertFalse(result["docker"])
            self.assertEqual([item["state"] for item in result["items"]], ["running", "running"])

    def test_list_skips_engine_probe_without_engine_containers(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.write_names(["hog-ubuntu"])
            guard.docker_running = lambda: False

            def probe():
                raise AssertionError("engine probed")

            guard._native_engine_status = probe
            result = guard.handle("list")
            self.assertEqual(result["items"][0]["state"], "unknown")

    def test_snapshot_marks_offline_desktop_container_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.inspect = lambda name: (None, "Docker is not running.")
            row = guard.snapshot("hog-ubuntu")
            self.assertEqual(row["state"], "unknown")
            self.assertEqual(row["reason"], "")
            guard.inspect = lambda name: (None, "Error: No such object: hog-ubuntu")
            self.assertEqual(guard.snapshot("hog-ubuntu")["state"], "missing")

    def test_create_starts_the_typed_image(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            seen = {"n": 0}

            def inspect(name):
                seen["n"] += 1
                if seen["n"] == 1:
                    return None, "Docker did not find that container."
                return {
                    "Name": "/ubuntu",
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
                    },
                    "Mounts": [],
                }, ""

            def run(args, timeout=8):
                calls.append((list(args), timeout))
                return subprocess.CompletedProcess(args, 0, "id\n", "")

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: [{"name": "ubuntu", "state": "running", "image": "ubuntu:24.04", "reason": ""}]
            created = guard.handle("create", "ubuntu", "ubuntu:24.04")
            self.assertTrue(created["ok"], created["error"])
            self.assertEqual(calls[0][0][0], "run")
            self.assertIn("ubuntu:24.04", calls[0][0])
            self.assertNotIn("hog-ubuntu:local", calls[0][0])
            self.assertNotIn("--cap-add=NET_ADMIN", calls[0][0])
            self.assertNotIn("-p", calls[0][0])
            self.assertEqual(calls[0][0][-3:], ["ubuntu:24.04", "sleep", "infinity"])
            refused = guard.handle("create", "ubuntu", "ubuntu:24.04;rm")
            self.assertFalse(refused["ok"])
            self.assertIn("ubuntu:24.04", refused["error"])

    def test_flat_command_has_no_port_or_vpn(self):
        text = canonical_command("ubuntu", "ubuntu:24.04", (), False, ("sleep", "infinity"))
        self.assertNotIn(" -p ", f" {text} ")
        self.assertNotIn("NET_ADMIN", text)
        self.assertNotIn("/dev/net/tun", text)
        self.assertIn("--cap-drop=ALL", text)
        self.assertIn("--cap-add=SETUID", text)
        self.assertIn("--memory 2g", text)
        self.assertTrue(text.endswith("ubuntu:24.04 sleep infinity"))
        self.assertEqual(parse_run(text), ("ubuntu", "ubuntu:24.04", (), False, ("sleep", "infinity"), (), (), (), ""))

    def test_command_accepts_port_vpn_and_local_bind(self):
        parsed = parse_run(
            "docker run --name vpnbox -p 51820:51820/udp -p 127.0.0.1:8080:80 "
            "--cap-add NET_ADMIN --device /dev/net/tun ubuntu:24.04 bash -lc true"
        )
        self.assertEqual(parsed[0], "vpnbox")
        self.assertEqual(
            parsed[2],
            (("", "51820", "51820", "udp"), ("127.0.0.1", "8080", "80", "tcp")),
        )
        self.assertTrue(parsed[3])
        self.assertEqual(parsed[4], ("bash", "-lc", "true"))
        args = compose_run(*parsed)
        self.assertIn("51820:51820/udp", args)
        self.assertIn("127.0.0.1:8080:80/tcp", args)
        self.assertIn("--cap-add=NET_ADMIN", args)
        self.assertIn("/dev/net/tun", args)
        self.assertIn("--cap-add=SETUID", args)
        self.assertNotIn("--privileged", args)
        self.assertNotIn("--cap-add=SYS_MODULE", args)
        self.assertNotIn("-v", args)
        again = parse_run(canonical_command(*parsed))
        self.assertEqual(again, parsed)

    def test_command_rejects_privileged_mounts_host_and_modules(self):
        refused = [
            "docker run --privileged --name ubuntu ubuntu:24.04",
            "docker run --name ubuntu -v /:/host ubuntu:24.04",
            "docker run --name ubuntu --mount type=bind,source=/,target=/host ubuntu:24.04",
            "docker run --name ubuntu --network host ubuntu:24.04",
            "docker run --name ubuntu --cap-add SYS_MODULE ubuntu:24.04",
            "docker run --name ubuntu --device /dev/sda ubuntu:24.04",
            "docker run --name ubuntu --device /dev/net/tun ubuntu:24.04",
            "docker run --name ubuntu -p 999.1.1.1:80:80 ubuntu:24.04",
        ]
        for line in refused:
            with self.assertRaises(CommandError):
                parse_run(line)

    def test_assess_allows_tun_and_rejects_sys_module(self):
        allowed = info(CapAdd=["NET_ADMIN", "SETUID"], Devices=[{"PathOnHost": "/dev/net/tun"}])
        self.assertEqual(assess(allowed, "demo", DATA), "")
        blocked = info(CapAdd=["SYS_MODULE"])
        self.assertIn("capability", assess(blocked, "demo", DATA))
        other = info(Devices=[{"PathOnHost": "/dev/sda"}])
        self.assertIn("system", assess(other, "demo", DATA))

    def test_run_refuses_existing_and_recreate_replaces(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            state = {"exists": True, "running": True, "created": False}

            def good(running):
                return {
                    "Name": "/ubuntu",
                    "State": {"Status": "running" if running else "exited", "Running": running},
                    "Config": {"Image": "ubuntu:24.04"},
                    "HostConfig": {
                        "Privileged": False,
                        "NetworkMode": "bridge",
                        "PidMode": "",
                        "IpcMode": "private",
                        "CapAdd": ["NET_BIND_SERVICE"],
                        "Binds": None,
                        "Devices": None,
                    },
                    "Mounts": [],
                }

            def inspect(name):
                self.assertEqual(name, "ubuntu")
                if not state["exists"]:
                    if state["created"]:
                        return good(True), ""
                    return None, "Docker did not find that container."
                return good(state["running"]), ""

            def run(args, timeout=8):
                calls.append(list(args))
                if args[0] == "stop":
                    state["running"] = False
                elif args[0] == "rm":
                    state["exists"] = False
                elif args[0] == "run":
                    state["exists"] = True
                    state["running"] = True
                    state["created"] = True
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: []
            guard.docker_running = lambda: True
            line = "docker run --name ubuntu -p 51820:51820/udp ubuntu:24.04"
            refused = guard.handle("run", line)
            self.assertFalse(refused["ok"])
            self.assertIn("Recreate", refused["error"])
            self.assertIn("51820:51820/udp", refused["command"])
            self.assertEqual(calls, [])
            created = guard.handle("recreate", line)
            self.assertTrue(created["ok"], created.get("error"))
            self.assertEqual(created["notice"], "Recreated ubuntu.")
            self.assertEqual(calls[0][0], "stop")
            self.assertEqual(calls[1][:2], ["rm", "ubuntu"])
            run_args = next(item for item in calls if item and item[0] == "run")
            self.assertIn("51820:51820/udp", run_args)
            self.assertIn("--cap-add=SETUID", run_args)
            self.assertNotIn("--cap-add=NET_ADMIN", run_args)
            self.assertEqual(json.loads(Path(folder, "containers.json").read_text())["names"], ["ubuntu"])

    def test_wireguard_image_keeps_tunnel_port_and_image_command(self):
        text = canonical_command(
            "wireguard",
            "lscr.io/linuxserver/wireguard:latest",
            (("", "51820", "51820", "udp"),),
            True,
            (),
            ("PEERS=1", "SERVERURL=auto", "TZ=Etc/UTC", "ALLOWEDIPS=0.0.0.0/0"),
            ("net.ipv4.conf.all.src_valid_mark=1", "net.ipv4.ip_forward=1"),
        )
        self.assertNotIn("sleep", text)
        self.assertNotIn("SYS_MODULE", text)
        self.assertNotIn("/lib/modules", text)
        self.assertIn("--cap-add=NET_ADMIN", text)
        self.assertIn("/dev/net/tun", text)
        self.assertIn("51820:51820/udp", text)
        self.assertIn("-e PEERS=1", text)
        self.assertTrue(text.endswith("lscr.io/linuxserver/wireguard:latest"))
        parsed = parse_run(text)
        self.assertEqual(parsed[4], ())
        self.assertIn("PEERS=1", parsed[5])
        self.assertEqual(parsed[6], ("net.ipv4.conf.all.src_valid_mark=1", "net.ipv4.ip_forward=1"))
        self.assertEqual(parse_run(canonical_command(*parsed)), parsed)
        for line in (
            "docker run --name wireguard --cap-add SYS_MODULE lscr.io/linuxserver/wireguard:latest",
            "docker run --name wireguard -v /lib/modules:/lib/modules lscr.io/linuxserver/wireguard:latest",
            "docker run --name wireguard --sysctl kernel.core_pattern=core lscr.io/linuxserver/wireguard:latest",
        ):
            with self.assertRaises(CommandError):
                parse_run(line)

    def test_wireguard_run_does_not_replace_when_the_module_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []

            def run_argv(args, timeout=8):
                calls.append(list(args))
                return subprocess.CompletedProcess(args, 1 if args != ["lsmod"] else 0, "Module Size\n", "not permitted")

            guard.run_argv = run_argv
            guard.run = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("docker was called"))
            guard.items = lambda: []
            guard.docker_running = lambda: True
            guard.inspect = lambda name: (_ for _ in ()).throw(AssertionError("inspect was called"))
            line = "docker run --name wireguard --cap-add NET_ADMIN --device /dev/net/tun -p 51820:51820/udp lscr.io/linuxserver/wireguard:latest"
            result = guard.handle("recreate", line)
            self.assertFalse(result["ok"])
            self.assertIn("kernel module", result["error"])
            self.assertNotIn(["rm", "wireguard"], calls)
            self.assertIn(["modprobe", "wireguard"], calls)
            self.assertIn(["sudo", "-n", "modprobe", "wireguard"], calls)
            self.assertNotIn(["pkexec", "modprobe", "wireguard"], calls)

    def test_modprobe_button_asks_with_pkexec_and_ignores_extra_text(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            state = {"loaded": False}

            def run_argv(args, timeout=8):
                calls.append((list(args), timeout))
                if args == ["lsmod"]:
                    text = "wireguard 1 0\n" if state["loaded"] else "Module Size\n"
                    return subprocess.CompletedProcess(args, 0, text, "")
                if args == ["pkexec", "modprobe", "wireguard"]:
                    state["loaded"] = True
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 1, "", "a password is required")

            guard.run_argv = run_argv
            guard.items = lambda: []
            guard.docker_running = lambda: True
            result = guard.handle("modprobe", "wireguard; rm -rf /")
            self.assertTrue(result["ok"], result.get("error"))
            self.assertTrue(result["wireguard"])
            self.assertEqual(result["notice"], "WireGuard kernel module is loaded.")
            self.assertIn((["pkexec", "modprobe", "wireguard"], 120), calls)
            joined = " ".join(" ".join(item[0]) for item in calls)
            self.assertNotIn("rm", joined)
            self.assertNotIn(";", joined)

    def test_logs_show_the_peer_png_and_drop_the_ascii_block(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            png = b"\x89PNG\r\n\x1a\n" + b"0123456789"
            copied = []

            def inspect(name):
                body = info()
                body["Name"] = f"/{name}"
                return body, ""

            def run(args, timeout=8):
                if args[0] == "logs":
                    block = "█" * 64
                    framed = "\x1b[37m" + ("═" * 30) + "\x1b[0m"
                    return subprocess.CompletedProcess(args, 0, f"server ready\n{block}\n{framed}\n", "")
                if args[:2] == ["exec", "wireguard"]:
                    return subprocess.CompletedProcess(
                        args, 0, "/config/peer1/peer1.png\n/config/peer1/../../etc/passwd.png\n", "",
                    )
                raise AssertionError(args)

            guard.inspect = inspect
            guard.run = run
            guard.copy_bytes = lambda name, path: copied.append((name, path)) or png
            guard.items = lambda: []
            guard.docker_running = lambda: True
            result = guard.handle("logs", "wireguard")
            self.assertTrue(result["ok"], result.get("error"))
            self.assertEqual(copied, [("wireguard", "/config/peer1/peer1.png")])
            self.assertNotIn("█", result["logs"])
            self.assertIn("server ready", result["logs"])
            self.assertEqual(result["qr"][0]["label"], "peer1")
            self.assertTrue(result["qr"][0]["png"].startswith("data:image/png;base64,"))

    def test_wifi_button_rewrites_only_the_endpoint_and_draws_a_square(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            conf = (
                "[Interface]\n"
                "PrivateKey = placeholder\n"
                "Address = 10.13.13.2\n"
                "Endpoint = 67.241.0.143:51820\n"
                "AllowedIPs = 0.0.0.0/0\n"
            )
            stored = {"conf": conf.encode()}
            png = b"\x89PNG\r\n\x1a\n" + b"0123456789"
            calls = []

            def inspect(name):
                body = info()
                body["Name"] = f"/{name}"
                body["State"] = {"Running": True, "Status": "running"}
                body["Config"] = {"Image": "lscr.io/linuxserver/wireguard:latest"}
                return body, ""

            def run(args, timeout=8):
                calls.append(list(args))
                if args[:4] == ["exec", "wireguard", "find", "/config"] and args[-1] == "*.conf":
                    return subprocess.CompletedProcess(
                        args, 0, "/config/peer1/peer1.conf\n/config/wg_confs/wg0.conf\n/config/peer1/../../etc/passwd.conf\n", "",
                    )
                if args[:4] == ["exec", "wireguard", "find", "/config"] and args[-1] == "*.png":
                    return subprocess.CompletedProcess(args, 0, "/config/peer1/peer1.png\n", "")
                if args[:3] == ["exec", "wireguard", "grep"]:
                    line = next(item for item in stored["conf"].decode().splitlines() if item.startswith("Endpoint"))
                    return subprocess.CompletedProcess(args, 0, line + "\n", "")
                if args[:3] == ["exec", "wireguard", "qrencode"]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                raise AssertionError(args)

            def run_argv(args, timeout=8):
                calls.append(list(args))
                if args[:3] == ["ip", "-4", "route"]:
                    return subprocess.CompletedProcess(args, 0, "1.1.1.1 via 192.168.1.1 dev wlp4s0 src 192.168.1.223 uid 1000\n", "")
                raise AssertionError(args)

            def copy_bytes(name, path):
                if path.endswith(".png"):
                    return png
                self.assertEqual((name, path), ("wireguard", "/config/peer1/peer1.conf"))
                return stored["conf"]

            def write_bytes(name, path, data):
                self.assertEqual((name, path), ("wireguard", "/config/peer1/peer1.conf"))
                stored["conf"] = data
                return True

            guard.inspect = inspect
            guard.run = run
            guard.run_argv = run_argv
            guard.copy_bytes = copy_bytes
            guard.write_bytes = write_bytes
            guard.items = lambda: []
            guard.docker_running = lambda: True
            result = guard.handle("endpoint", "lan")
            text = stored["conf"].decode()
            self.assertTrue(result["ok"], result.get("error"))
            self.assertIn("Endpoint = 192.168.1.223:51820", text)
            self.assertNotIn("67.241.0.143", text)
            self.assertIn("PrivateKey = placeholder", text)
            self.assertIn("AllowedIPs = 0.0.0.0/0", text)
            self.assertEqual(
                ["exec", "wireguard", "qrencode", "-t", "PNG", "-o", "/config/peer1/peer1.png", "-r", "/config/peer1/peer1.conf"],
                next(item for item in calls if item[:3] == ["exec", "wireguard", "qrencode"]),
            )
            self.assertEqual(result["qr"][0]["endpoint"], "192.168.1.223:51820")
            self.assertIn("192.168.1.223:51820", result["notice"])
            joined = " ".join(" ".join(item) for item in calls)
            self.assertNotIn(";", joined)
            self.assertNotIn(" sh ", f" {joined} ")
            before = len(calls)
            refused = guard.handle("endpoint", "lan;rm")
            self.assertFalse(refused["ok"])
            self.assertEqual(calls[before:], [])

    def test_cartesi_database_publishes_only_localhost(self):
        text = canonical_command(
            "cartesi-db",
            "cartesi-v2-db:r10",
            (("127.0.0.1", "5433", "5432", "tcp"),),
            False,
            (),
            ("POSTGRES_PASSWORD=password", "POSTGRES_DB=rollupsdb"),
        )
        self.assertNotIn("sleep", text)
        self.assertIn("-p 127.0.0.1:5433:5432/tcp", text)
        self.assertNotIn("0.0.0.0", text)
        self.assertNotIn("NET_ADMIN", text)
        self.assertNotIn("NET_RAW", text)
        self.assertIn("-e POSTGRES_DB=rollupsdb", text)
        self.assertTrue(text.endswith("cartesi-v2-db:r10"))
        parsed = parse_run(text)
        self.assertEqual(parsed[4], ())
        self.assertEqual(parse_run(canonical_command(*parsed)), parsed)

    def test_cartesi_v2_follows_without_a_key_or_a_mount(self):
        env = (
            "CARTESI_BLOCKCHAIN_HTTP_ENDPOINT=https://cartesi-bridge.duckdns.org/rpc",
            "CARTESI_BLOCKCHAIN_ID=31337",
            "CARTESI_BLOCKCHAIN_DEFAULT_BLOCK=latest",
            "CARTESI_FEATURE_CLAIM_SUBMISSION_ENABLED=false",
            "CARTESI_FEATURE_INPUT_READER_ENABLED=true",
            "CARTESI_FEATURE_INSPECT_ENABLED=true",
            "CARTESI_FEATURE_JSONRPC_API_ENABLED=true",
            "CARTESI_LOG_LEVEL=info",
            "CARTESI_CONTRACTS_INPUT_BOX_ADDRESS=0x346B3df038FE9f8380071eC6514D5a83aD143939",
            "CARTESI_CONTRACTS_SELF_HOSTED_APPLICATION_FACTORY_ADDRESS=0x6145C5996a71a379E030aEb0440df79D60833418",
            "CARTESI_DATABASE_CONNECTION=postgres://postgres:password@host.docker.internal:5433/rollupsdb",
            "CARTESI_SNAPSHOTS_DIR=/var/lib/cartesi-rollups-node/snapshots",
        )
        text = canonical_command(
            "cartesi-bridge",
            "cartesi-v2-follow:r10",
            (("127.0.0.1", "10011", "10011", "tcp"), ("127.0.0.1", "10012", "10012", "tcp")),
            False,
            ("cartesi-rollups-node",),
            env,
        )
        self.assertLess(len(text), 4000)
        self.assertNotIn("sleep", text)
        self.assertNotIn("MNEMONIC", text)
        self.assertNotIn("NET_ADMIN", text)
        self.assertNotIn("NET_RAW", text)
        self.assertNotIn("--device", text)
        self.assertNotIn("-v ", f"{text} ")
        self.assertIn("-e CARTESI_FEATURE_CLAIM_SUBMISSION_ENABLED=false", text)
        self.assertIn("-e CARTESI_DATABASE_CONNECTION=postgres://postgres:password@host.docker.internal:5433/rollupsdb", text)
        self.assertIn("-p 127.0.0.1:10011:10011/tcp", text)
        self.assertTrue(text.endswith("cartesi-v2-follow:r10 cartesi-rollups-node"))
        parsed = parse_run(text)
        self.assertEqual(parsed[4], ("cartesi-rollups-node",))
        self.assertEqual(parsed[5], env)
        self.assertEqual(parse_run(canonical_command(*parsed)), parsed)
        for line in (
            "docker run --name cartesi-bridge --cap-add NET_RAW cartesi-v2-follow:r10 cartesi-rollups-node",
            "docker run --name cartesi-bridge --network host cartesi-v2-follow:r10 cartesi-rollups-node",
            "docker run --name cartesi-bridge -v /opt/cartesi:/opt/cartesi cartesi-v2-follow:r10 cartesi-rollups-node",
            "docker run --name cartesi-bridge -e CARTESI_DATABASE_CONNECTION=postgres://postgres:password@host/db?sslmode=disable cartesi-v2-follow:r10",
            "docker run --name cartesi-bridge -e " + ("A" * 81) + "=ok cartesi-v2-follow:r10",
        ):
            with self.assertRaises(CommandError):
                parse_run(line)

    def test_tailscale_image_skips_sleep_and_rejects_raw_and_mounts(self):
        text = canonical_command(
            "tailscale",
            "tailscale/tailscale:latest",
            (),
            True,
            (),
            ("TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"),
            ("net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1", "net.ipv6.conf.all.forwarding=1"),
            (),
            "hog-tailscale",
        )
        self.assertNotIn("sleep", text)
        self.assertNotIn("-p ", f"{text} ")
        self.assertNotIn("NET_RAW", text)
        self.assertIn("--cap-add=NET_ADMIN", text)
        self.assertIn("/dev/net/tun", text)
        self.assertIn("-e TS_USERSPACE=false", text)
        self.assertIn("-e TS_EXTRA_ARGS=--advertise-exit-node", text)
        self.assertIn("-e TS_BOOT_TIMEOUT=10m", text)
        self.assertIn("-e TS_DEBUG_FIREWALL_MODE=nftables", text)
        self.assertIn("--network hog-tailscale", text)
        self.assertIn("--sysctl net.ipv6.conf.all.forwarding=1", text)
        self.assertNotIn(" -v ", f" {text} ")
        self.assertNotIn("--network host", text)
        self.assertTrue(text.endswith("tailscale/tailscale:latest"))
        parsed = parse_run(text)
        self.assertEqual(parsed[4], ())
        self.assertEqual(parsed[8], "hog-tailscale")
        self.assertEqual(parse_run(canonical_command(*parsed)), parsed)
        # Volume and NET_RAW stay blocked in the typed command. Host
        # networking is allowed only for the Tailscale image. The state
        # volume and NET_RAW are attached outside the command when Hog
        # starts Tailscale on Docker Engine.
        for line in (
            "docker run --name tailscale --cap-add NET_RAW tailscale/tailscale:latest",
            "docker run --name tailscale -v tailscale:/var/lib/tailscale tailscale/tailscale:latest",
            "docker run --name tailscale --network hog-tailscale ubuntu:24.04",
            "docker run --name demo --network hog-tailscale tailscale/tailscale:latest",
            "docker run --name demo --network host ubuntu:24.04",
        ):
            with self.assertRaises(CommandError):
                parse_run(line)
        allowed = parse_run("docker run --name tailscale --network hog-tailscale tailscale/tailscale:latest")
        self.assertEqual(allowed[8], "hog-tailscale")
        host_cmd = parse_run("docker run --name tailscale --network host tailscale/tailscale:latest")
        self.assertEqual(host_cmd[8], "host")
        host_text = canonical_command(
            "tailscale",
            "tailscale/tailscale:latest",
            (),
            True,
            (),
            ("TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"),
            (),
            (),
            "host",
        )
        self.assertIn("--network host", host_text)
        self.assertNotIn("NET_RAW", host_text)
        self.assertNotIn("-p ", f"{host_text} ")
        self.assertNotIn("--sysctl", host_text)
        self.assertEqual(parse_run(host_text)[8], "host")

    def test_tailscale_run_switches_the_firewall_command_once(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            state = {"exists": False}
            links = {"text": "/usr/sbin/iptables -> /usr/sbin/iptables-legacy\n/usr/sbin/ip6tables -> /usr/sbin/ip6tables-legacy\n"}

            def info(running=True):
                return {
                    "Name": "/tailscale",
                    "State": {"Status": "running" if running else "exited", "Running": running},
                    "Config": {"Image": "tailscale/tailscale:latest"},
                    "HostConfig": {
                        "Privileged": False,
                        "NetworkMode": "hog-tailscale",
                        "PidMode": "",
                        "IpcMode": "private",
                        "CapAdd": ["NET_ADMIN"],
                        "Binds": ["hog-tailscale-state:/var/lib/tailscale"],
                        "Devices": [{"PathOnHost": "/dev/net/tun"}],
                    },
                    "Mounts": [
                        {"Name": "hog-tailscale-state", "Source": "/var/lib/docker/volumes/hog-tailscale-state/_data", "Destination": "/var/lib/tailscale", "Type": "volume"},
                    ],
                }

            def inspect(name):
                self.assertEqual(name, "tailscale")
                if not state["exists"]:
                    return None, "Docker did not find that container."
                return info(), ""

            def run(args, timeout=8):
                calls.append((list(args), timeout))
                if args[0] == "run":
                    state["exists"] = True
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[:3] == ["exec", "tailscale", "ls"]:
                    return subprocess.CompletedProcess(args, 0, links["text"], "")
                if args[:3] == ["exec", "tailscale", "ln"]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "restart":
                    links["text"] = "/usr/sbin/iptables -> xtables-nft-multi\n/usr/sbin/ip6tables -> xtables-nft-multi\n"
                    return subprocess.CompletedProcess(args, 0, "tailscale\n", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: []
            guard.docker_running = lambda: True
            line = canonical_command(
                "tailscale",
                "tailscale/tailscale:latest",
                (),
                True,
                (),
                ("TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"),
                ("net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1", "net.ipv6.conf.all.forwarding=1"),
                (),
                "hog-tailscale",
            )
            created = guard.handle("run", line)
            self.assertTrue(created["ok"], created.get("error"))
            run_args = next(item[0] for item in calls if item[0][0] == "run")
            self.assertIn("--network", run_args)
            self.assertIn("hog-tailscale", run_args)
            self.assertIn("-v", run_args)
            self.assertIn("hog-tailscale-state:/var/lib/tailscale", run_args)
            self.assertIn("net.ipv6.conf.all.forwarding=1", run_args)
            self.assertNotIn("-v", created["command"])
            self.assertIn("--network hog-tailscale", created["command"])
            self.assertTrue(any(item[0][:2] == ["network", "inspect"] or item[0][:2] == ["network", "create"] for item in calls))
            self.assertEqual(
                [item[0][:3] for item in calls if item[0][0] == "exec"],
                [
                    ["exec", "tailscale", "ls"],
                    ["exec", "tailscale", "ln"],
                    ["exec", "tailscale", "ln"],
                ],
            )
            self.assertEqual(calls[-1][0], ["restart", "tailscale"])
            self.assertEqual(calls[-1][1], 40)
            again = guard.handle("start", "tailscale")
            self.assertTrue(again["ok"], again.get("error"))
            self.assertEqual(calls[-1][0][:3], ["exec", "tailscale", "ls"])

    def _running_tailscale_guard(self, run):
        folder_cm = tempfile.TemporaryDirectory()
        folder = folder_cm.__enter__()
        self.addCleanup(folder_cm.cleanup)
        guard = Guard(folder, docker="docker")

        def inspect(name):
            body = info()
            body["Name"] = f"/{name}"
            body["State"] = {"Running": True, "Status": "running"}
            body["Config"] = {"Image": "tailscale/tailscale:latest"}
            return body, ""

        guard.inspect = inspect
        guard.run = run
        guard.items = lambda: []
        guard.docker_running = lambda: True
        return guard

    def test_tailscale_sign_in_uses_existing_auth_url(self):
        calls = []

        def run(args, timeout=8):
            calls.append((list(args), timeout))
            if args == ["exec", "tailscale", "tailscale", "status", "--json"]:
                body = '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/example"}\n'
                return subprocess.CompletedProcess(args, 0, body, "")
            raise AssertionError(args)

        guard = self._running_tailscale_guard(run)
        result = guard.handle("tailscale-up", "tailscale; rm -rf /")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["error"], "")
        self.assertEqual(result["tailscaleLoginUrl"], "https://login.tailscale.com/a/example")
        self.assertTrue(result["openLogin"])
        self.assertIn("https://login.tailscale.com/a/example", result["notice"])
        self.assertEqual(calls, [(["exec", "tailscale", "tailscale", "status", "--json"], 15)])
        self.assertFalse(any("up" in item[0] for item in calls))

    def test_tailscale_sign_in_reports_already_logged_in(self):
        calls = []

        def run(args, timeout=8):
            calls.append((list(args), timeout))
            if args == ["exec", "tailscale", "tailscale", "status", "--json"]:
                body = '{"BackendState":"Running","AuthURL":""}\n'
                return subprocess.CompletedProcess(args, 0, body, "")
            raise AssertionError(args)

        guard = self._running_tailscale_guard(run)
        result = guard.handle("tailscale-up", "tailscale")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["error"], "")
        self.assertFalse(result["openLogin"])
        self.assertEqual(result["tailscaleLoginUrl"], "")
        self.assertIn("signed in", result["notice"].lower())
        self.assertEqual(calls, [(["exec", "tailscale", "tailscale", "status", "--json"], 15)])

    def test_tailscale_sign_in_runs_login_when_status_has_no_url(self):
        calls = []

        def run(args, timeout=8):
            calls.append((list(args), timeout))
            if args == ["exec", "tailscale", "tailscale", "status", "--json"]:
                if any(item[0][:5] == ["exec", "tailscale", "tailscale", "login", "--timeout=90s"] for item in calls):
                    body = '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/after-login"}\n'
                else:
                    body = '{"BackendState":"NeedsLogin","AuthURL":""}\n'
                return subprocess.CompletedProcess(args, 0, body, "")
            if args == ["exec", "tailscale", "tailscale", "login", "--timeout=90s"]:
                warning = (
                    "Warning: UDP GRO forwarding is suboptimally configured on eth0, "
                    "UDP forwarding throughput capability will increase with a configuration change. "
                    "See https://tailscale.com/s/ethtool-config-udp-gro "
                )
                return subprocess.CompletedProcess(
                    args,
                    1,
                    "",
                    warning + "https://login.tailscale.com/a/after-login\n",
                )
            raise AssertionError(args)

        guard = self._running_tailscale_guard(run)
        result = guard.handle("tailscale-up", "tailscale")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["error"], "")
        self.assertEqual(result["tailscaleLoginUrl"], "https://login.tailscale.com/a/after-login")
        self.assertTrue(result["openLogin"])
        self.assertIn("https://login.tailscale.com/a/after-login", result["notice"])
        self.assertNotIn("UDP GRO", result["error"])
        self.assertNotIn("UDP GRO", result["notice"])
        self.assertEqual(
            calls[1],
            (["exec", "tailscale", "tailscale", "login", "--timeout=90s"], 100),
        )
        self.assertFalse(any(item[0][3] == "up" for item in calls if len(item[0]) > 3))

    def test_tailscale_sign_in_strips_udp_gro_warning_from_errors(self):
        calls = []

        def run(args, timeout=8):
            calls.append((list(args), timeout))
            if args == ["exec", "tailscale", "tailscale", "status", "--json"]:
                return subprocess.CompletedProcess(args, 0, '{"BackendState":"NeedsLogin","AuthURL":""}\n', "")
            if args == ["exec", "tailscale", "tailscale", "login", "--timeout=90s"]:
                warning = (
                    "Warning: UDP GRO forwarding is suboptimally configured on eth0, "
                    "UDP forwarding throughput capability will increase with a configuration change. "
                    "See https://tailscale.com/s/ethtool-config-udp-gro "
                )
                return subprocess.CompletedProcess(args, 1, "", warning + "login server was unreachable\n")
            raise AssertionError(args)

        guard = self._running_tailscale_guard(run)
        result = guard.handle("tailscale-up", "tailscale")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "login server was unreachable")
        self.assertNotIn("UDP GRO", result["error"])

    def test_drop_lands_in_the_jellyfin_folder(self):
        self.assertIsNone(drop_file_path("http://example.com/a.jpg"))
        self.assertIsNone(drop_file_path("file:///tmp/a\n.jpg"))
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            wallet = home / "wallet"
            shares = home / "hog-shares"
            photos = home / "photos"
            wallet.mkdir()
            photos.mkdir()
            picture = photos / "pic.txt"
            picture.write_text("hello", encoding="utf-8")
            secret = wallet / "secret.txt"
            secret.write_text("no", encoding="utf-8")
            link = photos / "linked.txt"
            link.symlink_to(secret)
            copied, skipped, problem = take_drop(
                "\n".join([picture.as_uri(), secret.as_uri(), link.as_uri(), "http://example.com/nope"]),
                shares,
                wallet,
                home=home,
            )
            self.assertEqual(problem, "")
            self.assertEqual(copied, ["pic.txt"])
            self.assertEqual((shares / "pic.txt").read_text(encoding="utf-8"), "hello")
            self.assertFalse((shares / "secret.txt").exists())
            self.assertFalse((shares / "linked.txt").exists())
            self.assertGreaterEqual(skipped, 3)
            again, _, _ = take_drop(picture.as_uri(), shares, wallet, home=home)
            self.assertEqual(again, ["pic-2.txt"])
            self.assertIsNone(drop_destination(shares, "../wallet"))
            movie = home / "clip.mp4"
            movie.write_bytes(b"mp4")
            copied, skipped, problem = take_drop(movie.as_uri(), shares, wallet, home=home)
            self.assertEqual((problem, skipped, copied), ("", 0, ["clip.mp4"]))
            self.assertEqual((shares / "clip.mp4").read_bytes(), b"mp4")
            home_drop, _, home_problem = take_drop(home.as_uri(), shares, wallet, home=home)
            self.assertEqual(home_drop, [])
            self.assertIn("whole home", home_problem)

    def test_share_folder_rules_and_names(self):
        self.assertTrue(SHARE_NAME_RE.fullmatch("photos"))
        self.assertTrue(SHARE_NAME_RE.fullmatch("a"))
        self.assertFalse(SHARE_NAME_RE.fullmatch("Photos"))
        self.assertFalse(SHARE_NAME_RE.fullmatch(""))
        self.assertFalse(SHARE_NAME_RE.fullmatch("a" * 26))
        self.assertEqual(assign_share_port([]), 8101)
        self.assertEqual(assign_share_port([8101, 8102]), 8103)
        self.assertEqual(assign_share_port(range(8101, 8117)), 0)
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            photos = home / "hog-shares" / "photos"
            videos = home / "Videos"
            wallet = home / "wallet"
            photos.mkdir(parents=True)
            videos.mkdir()
            wallet.mkdir()
            self.assertEqual(folder_problem(photos, wallet, home=home), "")
            self.assertEqual(folder_problem(videos, wallet, home=home), "")
            self.assertIn("whole home", folder_problem(home, wallet, home=home))
            self.assertIn("cannot", folder_problem(wallet, wallet, home=home))
            self.assertIn("whole home", folder_problem(Path("/"), wallet, home=home))
            self.assertIn("home", folder_problem(Path("/usr"), wallet, home=home))
            guard = Guard(folder, docker="docker")
            guard.items = lambda: []
            guard.inspect = lambda name: (None, "")
            guard.docker_running = lambda: True
            refused = guard.handle("share-computer", "Photos")
            self.assertFalse(refused["ok"])
            self.assertEqual(refused["error"], "Use a short name like photos.")
            self.assertEqual(refused["shares"], [])
            outside = home / "outside.txt"
            outside.write_text("nope", encoding="utf-8")
            link = photos / "escape"
            link.symlink_to(outside)
            self.assertIsNone(safe_target(photos, "/escape/../outside.txt"))
            self.assertIsNone(safe_target(photos, "/%2e%2e/outside.txt"))
            self.assertEqual(safe_target(photos, "/"), photos.resolve())
            page = listing_page(photos, photos)
            self.assertIn("width=device-width", page)
            self.assertIn("font-size: 26px", page)
            (photos / "hello.txt").write_text("hi", encoding="utf-8")
            page = listing_page(photos, photos)
            self.assertIn("hello.txt", page)
            self.assertNotIn("escape", page)

    def test_publish_returns_the_enable_page_and_does_not_use_funnel(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            seen = []

            def capture(args, timeout=8, sock=None):
                seen.append((list(args), timeout))
                return "Serve is not enabled\nhttps://login.tailscale.com/f/serve?node=example\n", 124

            guard.capture = capture
            problem, url = guard.publish_port(8101)
            self.assertEqual(problem, "")
            self.assertTrue(url.startswith("https://login.tailscale.com/"))
            self.assertNotIn("funnel", seen[0][0])
            self.assertEqual(seen[0][0][-2:], ["--https=8101", "http://host.docker.internal:8101"])
            seen.clear()

            def capture_jellyfin(args, timeout=8, sock=None):
                seen.append(list(args))
                return "ok", 0

            guard.capture = capture_jellyfin
            problem, url = guard.publish_port(8096)
            self.assertEqual((problem, url), ("", ""))
            self.assertIn("--https=8096", seen[0])
            self.assertEqual(seen[0][-1], "off")
            self.assertIn("--tcp=8096", seen[1])
            self.assertEqual(seen[1][-1], "tcp://host.docker.internal:8096")
            self.assertNotIn("--https=8096", seen[1])

    def test_jellyfin_mounts_the_share_folder_outside_the_command(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder) / "data"
            shares = Path(folder) / "hog-shares"
            guard = Guard(data, docker="docker")
            calls = []
            state = {"up": False}
            old_root = guard_module.shares_root
            guard_module.shares_root = lambda: shares

            def inspect(name):
                if name != "jellyfin" or not state["up"]:
                    return None, "missing"
                root = str(shares.resolve())
                return {
                    "Name": "/jellyfin",
                    "State": {"Status": "running", "Running": True},
                    "Config": {"Image": "jellyfin/jellyfin:latest"},
                    "HostConfig": {
                        "Privileged": False,
                        "NetworkMode": "bridge",
                        "PidMode": "",
                        "IpcMode": "private",
                        "CapAdd": None,
                        "Binds": [f"{root}:/media:ro"],
                        "Devices": None,
                    },
                    "Mounts": [
                        {"Source": root, "Destination": "/media", "Type": "bind"},
                        {"Source": "/var/lib/docker/volumes/abc123/_data", "Destination": "/config", "Type": "volume", "Name": "abc123"},
                    ],
                }, ""

            def run(args, timeout=8):
                calls.append(list(args))
                if args[0] == "run":
                    state["up"] = True
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: []
            guard.docker_running = lambda: True
            try:
                line = canonical_command(
                    "jellyfin",
                    "jellyfin/jellyfin:latest",
                    (("127.0.0.1", "8096", "8096", "tcp"),),
                    False,
                    (),
                )
                self.assertNotIn("sleep", line)
                self.assertNotIn(" -v ", f" {line} ")
                self.assertIn("-p 127.0.0.1:8096:8096/tcp", line)
                self.assertEqual(parse_run(line)[4], ())
                with self.assertRaises(CommandError):
                    parse_run("docker run --name jellyfin -v /tmp/hog-shares:/media jellyfin/jellyfin:latest")
                mounted = compose_run(
                    "jellyfin",
                    "jellyfin/jellyfin:latest",
                    mounts=(f"{shares}:/media:ro",),
                )
                self.assertLess(mounted.index("-v"), mounted.index("jellyfin/jellyfin:latest"))
                self.assertNotIn("-v", launch_args({"name": "ubuntu", "image": "ubuntu:24.04"}))
                result = guard.handle("run", line)
            finally:
                guard_module.shares_root = old_root
            self.assertTrue(result["ok"], result.get("error"))
            self.assertNotIn("-v", result["command"])
            self.assertIn("/media", result["notice"])
            run_args = next(item for item in calls if item and item[0] == "run")
            self.assertLess(run_args.index("-v"), run_args.index("jellyfin/jellyfin:latest"))
            self.assertTrue(run_args[run_args.index("-v") + 1].endswith(":/media:ro"))
            self.assertNotIn("rm", [item[0] for item in calls])

    def test_library_folders_list_link_and_remove(self):
        self.assertEqual(format_bytes(0), "0 B")
        self.assertEqual(format_bytes(1536), "1.5 KB")
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            shares = home / "hog-shares"
            wallet = home / "wallet"
            shares.mkdir()
            wallet.mkdir()
            (shares / ".hidden").write_text("no", encoding="utf-8")
            (shares / "zeta.txt").write_text("z", encoding="utf-8")
            (shares / "Alpha").mkdir()
            (shares / "link.txt").symlink_to(shares / "zeta.txt")
            rows = media_listing(shares)
            self.assertEqual([row["name"] for row in rows], ["Alpha", "zeta.txt"])
            self.assertEqual(rows[0]["items"], 0)
            movie = home / "clip.mp4"
            movie.write_bytes(b"mp4")
            copied, skipped, problem = take_drop(movie.as_uri(), shares, wallet, home=home)
            self.assertEqual((problem, skipped, copied), ("", 0, ["clip.mp4"]))
            saved = shares / "clip.mp4"
            self.assertEqual(saved.stat().st_ino, movie.stat().st_ino)
            self.assertEqual(remove_media_entry(shares, "clip.mp4"), "")
            self.assertFalse(saved.exists())
            self.assertEqual(movie.read_bytes(), b"mp4")
            self.assertIn("not in the library", remove_media_entry(shares, "../clip.mp4"))
            self.assertTrue(movie.exists())
            linkdir = shares / "escape"
            linkdir.symlink_to(home)
            self.assertIsNone(library_folder(shares, "escape"))
            self.assertIn("not in the library", remove_media_entry(shares, "escape"))
            self.assertTrue(linkdir.is_symlink())

            films = shares / "films"
            films.mkdir()
            (films / "a.mp4").write_bytes(b"a")
            guard = Guard(home / "data", docker="docker")
            guard.items = lambda: []
            guard.inspect = lambda name: (None, "")
            guard.docker_running = lambda: True
            guard.drop_home = home
            old_root = guard_module.shares_root
            guard_module.shares_root = lambda: shares
            try:
                opened = guard.handle("media-open", "films")
                self.assertTrue(opened["ok"], opened)
                self.assertEqual(opened["mediaPath"], "films")
                self.assertEqual([row["name"] for row in opened["media"]], ["a.mp4"])
                missing = guard.handle("media-open", "nope")
                self.assertFalse(missing["ok"])
                self.assertEqual(missing["mediaPath"], "films")
                made = guard.handle("media-mkdir", "films/rolls")
                self.assertTrue(made["ok"], made)
                self.assertTrue((films / "rolls").is_dir())
                self.assertEqual(made["mediaPath"], "films")
                self.assertIn("rolls", [row["name"] for row in made["media"]])
                escaped = guard.handle("media-mkdir", "films/../../nope")
                self.assertFalse(escaped["ok"])
                self.assertFalse((home / "nope").exists())
                self.assertFalse((shares / "nope").exists())
                dropped = guard.handle("share-drop", movie.as_uri())
                self.assertTrue(dropped["ok"], dropped)
                self.assertEqual(dropped["mediaPath"], "films")
                self.assertEqual((films / "clip.mp4").stat().st_ino, movie.stat().st_ino)
                self.assertIn("/media/films", dropped["mediaNote"])
                removed = guard.handle("media-remove", "films/clip.mp4")
                self.assertTrue(removed["ok"], removed)
                self.assertFalse((films / "clip.mp4").exists())
                self.assertTrue(movie.exists())
                guard.write_shares([{
                    "name": "films",
                    "path": str(films.resolve()),
                    "port": 8101,
                    "kind": "network",
                    "pid": 0,
                    "published": False,
                }])
                blocked = guard.handle("media-remove", "films")
                self.assertFalse(blocked["ok"])
                self.assertIn("Phone folders", blocked["error"])
                self.assertTrue(films.is_dir())
                guard.write_shares([{
                    "name": "films",
                    "path": str(films.resolve()),
                    "port": 8101,
                    "kind": "computer",
                    "pid": 0,
                    "published": False,
                }])
                gone = guard.handle("media-remove", "films")
                self.assertTrue(gone["ok"], gone)
                self.assertFalse(films.exists())
                self.assertEqual(gone["shares"], [])
                self.assertEqual(gone["mediaPath"], "")
            finally:
                guard_module.shares_root = old_root

    def test_share_status_reads_the_phone_page_without_starting_it(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            shares = home / "hog-shares"
            films = shares / "films"
            films.mkdir(parents=True)
            guard = Guard(home / "data", docker="docker")
            guard.items = lambda: []
            guard.inspect = lambda name: (None, "")
            guard.docker_running = lambda: True

            def fail_start(_item):
                raise AssertionError("share status started a server")

            guard.start_share_server = fail_start
            guard.write_shares([{
                "name": "films",
                "path": str(films.resolve()),
                "port": 8101,
                "kind": "computer",
                "pid": 0,
                "published": True,
            }])
            old_root = guard_module.shares_root
            guard_module.shares_root = lambda: shares
            try:
                result = guard.handle("share-status", "")
            finally:
                guard_module.shares_root = old_root
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["shares"][0]["name"], "films")
            self.assertEqual(result["shares"][0]["url"], "")
            self.assertEqual(result["mediaPath"], "")

class JellyfinGpuTest(unittest.TestCase):
    def test_nvidia_paths_and_compose_flag(self):
        self.assertTrue(nvidia_device_path("/dev/nvidia0"))
        self.assertTrue(nvidia_device_path("/dev/nvidiactl"))
        self.assertTrue(nvidia_device_path("/dev/nvidia-uvm"))
        self.assertTrue(nvidia_device_path("/dev/nvidia-caps/nvidia-cap1"))
        self.assertFalse(nvidia_device_path("/dev/nvidia/../sda"))
        self.assertFalse(nvidia_device_path("/dev/sda"))
        self.assertEqual(mount_problem("/dev/nvidia0", Path("/tmp/data")), "")
        args = compose_run("jellyfin", "jellyfin/jellyfin:latest", gpus=True)
        self.assertIn("--gpus", args)
        self.assertEqual(args[args.index("--gpus") + 1], "all")
        self.assertNotIn("--gpus", compose_run("jellyfin", "jellyfin/jellyfin:latest"))
        self.assertIn("RTX 3060", parse_nvidia_gpu_name("NVIDIA GeForce RTX 3060        Off"))

    def test_install_commands_are_official(self):
        engine = "\n".join(docker_engine_install_commands())
        self.assertIn("download.docker.com/linux/", engine)
        self.assertIn("docker-ce", engine)
        self.assertIn('usermod -aG docker "$USER"', engine)
        toolkit = "\n".join(nvidia_toolkit_install_commands())
        self.assertIn("nvidia.github.io/libnvidia-container", toolkit)
        self.assertIn("nvidia-container-toolkit", toolkit)
        self.assertIn("sudo nvidia-ctk runtime configure --runtime=docker", toolkit)
        self.assertIn("sudo systemctl restart docker", toolkit)
        configure = nvidia_toolkit_install_commands(configure_only=True)
        self.assertEqual(
            configure,
            [
                "sudo nvidia-ctk runtime configure --runtime=docker",
                "sudo systemctl restart docker",
            ],
        )

    def test_assess_allows_nvidia_devices(self):
        payload = {
            "Name": "/jellyfin",
            "State": {"Status": "running", "Running": True},
            "Config": {"Image": "jellyfin/jellyfin:latest"},
            "HostConfig": {
                "Privileged": False,
                "NetworkMode": "bridge",
                "PidMode": "",
                "IpcMode": "private",
                "CapAdd": None,
                "Binds": [],
                "Devices": [{"PathOnHost": "/dev/nvidia0"}],
            },
            "Mounts": [],
        }
        self.assertEqual(assess(payload, "jellyfin", Path("/tmp/data")), "")

    def _ready_checks(self, ready=True):
        def check(label, ok=ready):
            return {"id": label, "label": label, "ok": ok, "detail": "x", "commands": [] if ok else ["sudo true"]}
        return [check("nvidia"), check("engine"), check("toolkit")]

    def _jellyfin_info(self, running=True, config="abcconfig", cache="abccache", image="jellyfin/jellyfin:latest"):
        return {
            "Name": "/jellyfin",
            "State": {"Status": "running" if running else "exited", "Running": running},
            "Config": {"Image": image},
            "HostConfig": {
                "Privileged": False,
                "NetworkMode": "bridge",
                "PidMode": "",
                "IpcMode": "private",
                "CapAdd": None,
                "Binds": ["/media-host:/media:ro"],
                "Devices": None,
            },
            "Mounts": [
                {"Source": "/media-host", "Destination": "/media", "Type": "bind"},
                {"Source": f"/var/lib/docker/volumes/{config}/_data", "Destination": "/config", "Type": "volume", "Name": config},
                {"Source": f"/var/lib/docker/volumes/{cache}/_data", "Destination": "/cache", "Type": "volume", "Name": cache},
            ],
        }

    def test_readiness_reports_missing_toolkit(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard._nvidia_smi = lambda: (True, "NVIDIA GeForce RTX 3060")
            guard._native_engine_status = lambda: {
                "ok": True,
                "installed": True,
                "running": True,
                "permission": True,
                "info": {"OperatingSystem": "Ubuntu 26.04.1 LTS", "Name": "whitefang", "Runtimes": {"runc": {}}},
            }
            guard._nvidia_ctk_installed = lambda: False
            checks = {item["id"]: item for item in guard.gpu_readiness()}
            self.assertTrue(checks["nvidia"]["ok"])
            self.assertIn("RTX 3060", checks["nvidia"]["detail"])
            self.assertTrue(checks["engine"]["ok"])
            self.assertFalse(checks["toolkit"]["ok"])
            self.assertIn("sudo nvidia-ctk runtime configure --runtime=docker", "\n".join(checks["toolkit"]["commands"]))
            self.assertFalse(guard.gpu_is_ready())

    def test_enable_refuses_when_not_ready_and_does_not_touch_docker(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            guard.gpu_readiness = lambda: self._ready_checks(False)
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.inspect_on = lambda name, sock=None: calls.append(("inspect", name, sock)) or (None, "missing")
            guard.run = lambda args, timeout=8: calls.append(("run", args)) or subprocess.CompletedProcess(args, 0, "", "")
            guard.run_on = lambda args, timeout=8, sock=None: calls.append(("run_on", args, sock)) or subprocess.CompletedProcess(args, 0, "", "")
            payload = guard.handle("jellyfin-gpu-set")
            self.assertFalse(payload["ok"])
            self.assertIn("ready", payload["error"].lower())
            self.assertFalse(guard.gpu_enabled())
            def mutated(item):
                args = item[1] if item[0] in {"run", "run_on"} and len(item) > 1 else None
                return bool(args) and args[0] in {"run", "stop", "rm", "start"}
            self.assertFalse(any(mutated(item) for item in calls))

    def test_enable_recreates_jellyfin_on_engine_with_gpu(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            desktop = self._jellyfin_info(config="deskcfg", cache="deskcache")
            boxes = {"desktop": desktop, "engine": None}
            calls = []

            def inspect_on(name, sock=None):
                if name != "jellyfin":
                    return None, "missing"
                if sock is None:
                    info = boxes["desktop"]
                else:
                    info = boxes["engine"]
                if info is None:
                    return None, "missing"
                return info, ""

            def run_on(args, timeout=8, sock=None):
                calls.append((list(args), sock, timeout))
                if args and args[0] == "run":
                    boxes["engine"] = self._jellyfin_info(config=JELLYFIN_CONFIG_VOLUME, cache=JELLYFIN_CACHE_VOLUME)
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[:1] == ["stop"] or args[:1] == ["rm"]:
                    if sock is None:
                        boxes["desktop"] = None
                    else:
                        boxes["engine"] = None
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[:1] == ["inspect"]:
                    info, error = inspect_on("jellyfin", sock=sock)
                    if info is None:
                        return subprocess.CompletedProcess(args, 1, "", error)
                    return subprocess.CompletedProcess(args, 0, json.dumps([info]), "")
                return subprocess.CompletedProcess(args, 0, "", "")

            def run(args, timeout=8):
                return run_on(args, timeout=timeout, sock=None)

            guard.gpu_readiness = lambda: self._ready_checks(True)
            guard.docker_running = lambda: True
            guard.items = lambda: [{"name": "jellyfin", "state": "running", "image": "jellyfin/jellyfin:latest", "reason": ""}]
            guard.media_view = lambda: ("", [])
            guard.tailscale_dns = lambda: ("", False)
            guard.inspect_on = inspect_on
            guard.run_on = run_on
            guard.run = run
            payload = guard.handle("jellyfin-gpu-set")
            self.assertTrue(payload["ok"], payload)
            self.assertTrue(guard.gpu_enabled())
            self.assertIn("NVENC", payload["notice"])
            self.assertIn("do not carry over", payload["notice"].lower())
            stop = next(item for item in calls if item[0][:1] == ["stop"] and item[1] is None)
            remove = next(item for item in calls if item[0][:1] == ["rm"] and item[1] is None)
            self.assertNotIn("-v", remove[0])
            created = next(item for item in calls if item[0][:1] == ["run"])
            args, sock, _timeout = created
            self.assertTrue(str(sock).endswith("docker.sock") or sock == guard.engine_sock())
            self.assertIn("--gpus", args)
            self.assertEqual(args[args.index("--gpus") + 1], "all")
            self.assertIn(NVIDIA_VISIBLE_ENV, args)
            self.assertIn(NVIDIA_CAPS_ENV, args)
            self.assertIn("-p", args)
            self.assertIn("127.0.0.1:8096:8096/tcp", args)
            volumes = [args[i + 1] for i, token in enumerate(args) if token == "-v"]
            self.assertTrue(any(item.endswith(":/media:ro") for item in volumes))
            self.assertIn(f"{JELLYFIN_CONFIG_VOLUME}:/config", volumes)
            self.assertIn(f"{JELLYFIN_CACHE_VOLUME}:/cache", volumes)
            self.assertEqual(guard.read_gpu_state()["desktopVolumes"]["config"], "deskcfg")

    def test_disable_keeps_jellyfin_on_engine_without_gpu(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.write_gpu_state(
                enabled=True,
                desktop_volumes={"config": "deskcfg", "cache": "deskcache"},
                engine_volumes={"config": JELLYFIN_CONFIG_VOLUME, "cache": JELLYFIN_CACHE_VOLUME},
            )
            boxes = {
                "desktop": None,
                "engine": self._jellyfin_info(config=JELLYFIN_CONFIG_VOLUME, cache=JELLYFIN_CACHE_VOLUME),
            }
            calls = []

            def inspect_on(name, sock=None):
                if name != "jellyfin":
                    return None, "missing"
                info = boxes["desktop"] if sock is None else boxes["engine"]
                if info is None:
                    return None, "missing"
                return info, ""

            def run_on(args, timeout=8, sock=None):
                calls.append((list(args), sock))
                if args and args[0] == "run":
                    boxes["engine"] = self._jellyfin_info(config=JELLYFIN_CONFIG_VOLUME, cache=JELLYFIN_CACHE_VOLUME)
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[:1] in (["stop"], ["rm"]):
                    if sock is None:
                        boxes["desktop"] = None
                    else:
                        boxes["engine"] = None
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.gpu_readiness = lambda: self._ready_checks(True)
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.tailscale_dns = lambda: ("", False)
            guard.inspect_on = inspect_on
            guard.run_on = run_on
            guard.run = lambda args, timeout=8: run_on(args, timeout=timeout, sock=None)
            payload = guard.handle("jellyfin-gpu-clear")
            self.assertTrue(payload["ok"], payload)
            self.assertFalse(guard.gpu_enabled())
            created = next(item for item in calls if item[0][:1] == ["run"])
            args, sock = created
            self.assertTrue(str(sock).endswith("docker.sock") or sock == guard.engine_sock())
            self.assertNotIn("--gpus", args)
            volumes = [args[i + 1] for i, token in enumerate(args) if token == "-v"]
            self.assertIn(f"{JELLYFIN_CONFIG_VOLUME}:/config", volumes)
            self.assertIn(f"{JELLYFIN_CACHE_VOLUME}:/cache", volumes)
            self.assertEqual(guard.read_runtimes().get("jellyfin"), "engine")

    def test_apply_command_adds_named_volumes_without_putting_them_in_the_command(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder) / "data"
            shares = Path(folder) / "hog-shares"
            guard = Guard(data, docker="docker")
            calls = []
            state = {"up": False}
            old_root = guard_module.shares_root
            guard_module.shares_root = lambda: shares

            def inspect(name):
                if name != "jellyfin" or not state["up"]:
                    return None, "missing"
                return self._jellyfin_info(), ""

            def run(args, timeout=8):
                calls.append(list(args))
                if args[0] == "run":
                    state["up"] = True
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: []
            guard.docker_running = lambda: True
            guard.gpu_readiness = lambda: self._ready_checks(False)
            try:
                line = canonical_command(
                    "jellyfin",
                    "jellyfin/jellyfin:latest",
                    (("127.0.0.1", "8096", "8096", "tcp"),),
                    False,
                    (),
                )
                result = guard.handle("run", line)
            finally:
                guard_module.shares_root = old_root
            self.assertTrue(result["ok"], result.get("error"))
            self.assertNotIn("-v", result["command"])
            self.assertNotIn("--gpus", result["command"])
            run_args = next(item for item in calls if item and item[0] == "run")
            volumes = [run_args[i + 1] for i, token in enumerate(run_args) if token == "-v"]
            self.assertTrue(volumes[0].endswith(":/media:ro"))
            self.assertIn(f"{JELLYFIN_CONFIG_VOLUME}:/config", volumes)
            self.assertIn(f"{JELLYFIN_CACHE_VOLUME}:/cache", volumes)


class ToolkitInstallTest(unittest.TestCase):
    def test_helper_script_is_fixed_and_refuses_args(self):
        root = Path(__file__).resolve().parents[1]
        script = (root / "packaging" / "hog-nvidia-toolkit-install").read_text(encoding="utf-8")
        self.assertIn("#!/bin/sh", script)
        self.assertIn("This helper takes no arguments", script)
        self.assertIn("must run as root via pkexec", script)
        self.assertIn("nvidia-container-toolkit", script)
        self.assertIn("nvidia-ctk runtime configure --runtime=docker", script)
        self.assertIn("systemctl restart docker.service", script)
        self.assertNotIn("docker-desktop", script)
        self.assertNotIn("sudo", script)
        policy = (root / "packaging" / "org.hog.Browser.nvidia-toolkit-install.policy").read_text(encoding="utf-8")
        self.assertIn("/opt/hog-browser/libexec/hog-nvidia-toolkit-install", policy)
        self.assertIn("org.freedesktop.policykit.exec.path", policy)
        deb = (root / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn('install -m 755 "${ROOT}/packaging/hog-nvidia-toolkit-install"', deb)
        self.assertIn("${APP}/libexec/hog-nvidia-toolkit-install", deb)
        self.assertIn("org.hog.Browser.nvidia-toolkit-install.policy", deb)
        self.assertEqual(str(NVIDIA_TOOLKIT_HELPER), "/opt/hog-browser/libexec/hog-nvidia-toolkit-install")
        result = subprocess.run(
            [str(root / "packaging" / "hog-nvidia-toolkit-install"), "extra"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("no arguments", result.stderr)
        result = subprocess.run(
            [str(root / "packaging" / "hog-nvidia-toolkit-install")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("pkexec", result.stderr)

    def test_helper_status_rejects_missing_untrusted_and_no_pkexec(self):
        ok, reason = nvidia_toolkit_helper_status(path="/tmp/hog-missing-nvidia-helper")
        self.assertFalse(ok)
        self.assertIn(".deb", reason)
        with tempfile.TemporaryDirectory() as folder:
            helper = Path(folder) / "hog-nvidia-toolkit-install"
            helper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            helper.chmod(0o755)
            ok, reason = nvidia_toolkit_helper_status(path=helper, pkexec_path="")
            self.assertFalse(ok)
            self.assertIn("pkexec", reason)
            ok, reason = nvidia_toolkit_helper_status(path=helper, pkexec_path="/usr/bin/pkexec")
            self.assertFalse(ok)
            self.assertIn("root helper", reason)
            helper.chmod(0o777)
            ok, reason = nvidia_toolkit_helper_status(path=helper, pkexec_path="/usr/bin/pkexec")
            self.assertFalse(ok)

    def test_install_falls_back_without_calling_pkexec(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.gpu_readiness = lambda: [
                {"id": "nvidia", "label": "NVIDIA GPU and driver", "ok": True, "detail": "ok", "commands": []},
                {"id": "engine", "label": "Native Docker Engine", "ok": True, "detail": "ok", "commands": []},
                {"id": "toolkit", "label": "NVIDIA Container Toolkit", "ok": False, "detail": "missing", "commands": ["sudo true"]},
            ]
            guard.toolkit_helper_status = lambda: (False, "Install the hog-browser .deb to install the toolkit from this button. Until then, copy the commands below.")
            guard.run_argv = lambda args, timeout=8: calls.append((list(args), timeout)) or subprocess.CompletedProcess(args, 0, "", "")
            payload = guard.handle("jellyfin-gpu-install")
            self.assertFalse(payload["ok"])
            self.assertIn(".deb", payload["error"])
            self.assertFalse(payload.get("jellyfinGpuCanInstall"))
            self.assertFalse(any(item[0] and item[0][0] == "pkexec" for item in calls))

    def test_install_runs_fixed_pkexec_path_and_rechecks(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            state = {"ready": False}

            def readiness():
                return [
                    {"id": "nvidia", "label": "NVIDIA GPU and driver", "ok": True, "detail": "ok", "commands": []},
                    {"id": "engine", "label": "Native Docker Engine", "ok": True, "detail": "ok", "commands": []},
                    {
                        "id": "toolkit",
                        "label": "NVIDIA Container Toolkit",
                        "ok": state["ready"],
                        "detail": "ok" if state["ready"] else "missing",
                        "commands": [] if state["ready"] else ["sudo true"],
                    },
                ]

            def run_argv(args, timeout=8):
                calls.append((list(args), timeout))
                state["ready"] = True
                return subprocess.CompletedProcess(args, 0, "NVIDIA Container Toolkit is installed and configured.\n", "")

            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.gpu_readiness = readiness
            guard.toolkit_helper_status = lambda: (True, "")
            guard.run_argv = run_argv
            payload = guard.handle("jellyfin-gpu-install")
            self.assertTrue(payload["ok"], payload)
            self.assertIn((["pkexec", "/opt/hog-browser/libexec/hog-nvidia-toolkit-install"], 600), calls)
            self.assertEqual(sum(1 for item in calls if item[0][:1] == ["pkexec"]), 1)
            self.assertIn("installed and configured", payload["notice"])
            self.assertIn("NVIDIA Container Toolkit is installed", payload["jellyfinGpuInstallLog"])
            self.assertTrue(any(item["id"] == "toolkit" and item["ok"] for item in payload["jellyfinGpuChecks"]))

    def test_install_reports_dismissed_pkexec_prompt(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.gpu_readiness = lambda: [
                {"id": "toolkit", "label": "NVIDIA Container Toolkit", "ok": False, "detail": "missing", "commands": []},
            ]
            guard.toolkit_helper_status = lambda: (True, "")
            guard.run_argv = lambda args, timeout=8: subprocess.CompletedProcess(
                args, 126, "", "Error executing command as another user: Request dismissed\n"
            )
            payload = guard.handle("jellyfin-gpu-install")
            self.assertFalse(payload["ok"])
            self.assertIn("dismissed", payload["error"].lower())
            self.assertIn("Request dismissed", payload["jellyfinGpuInstallLog"])





def make_test_deb(folder, version="9.9.9", package="hog-browser", architecture="amd64"):
    src = Path(folder) / "pkg"
    control = src / "DEBIAN"
    control.mkdir(parents=True)
    (control / "control").write_text(
        f"Package: {package}\nVersion: {version}\nArchitecture: {architecture}\n"
        "Maintainer: Hog Tests <hog@localhost>\nDescription: test package\n",
        encoding="utf-8",
    )
    (src / "usr").mkdir(exist_ok=True)
    out = Path(folder) / f"{package}_{version}_{architecture}.deb"
    result = subprocess.run(
        ["dpkg-deb", "-b", str(src), str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout or "dpkg-deb failed")
    return out


class SelfUpdateTest(unittest.TestCase):
    def setUp(self):
        self._hog_version = guard_module.hog_version
        guard_module.hog_version = lambda root=None: "0.1.10"

    def tearDown(self):
        guard_module.hog_version = self._hog_version

    def test_semver_and_release_parsing(self):
        self.assertEqual(parse_version("0.1.10"), (0, 1, 10))
        self.assertEqual(parse_version("v0.1.9"), (0, 1, 9))
        self.assertIsNone(parse_version("0.1"))
        self.assertIsNone(parse_version("0.1.10-beta"))
        self.assertTrue(version_newer("0.1.10", "0.1.9"))
        self.assertTrue(version_newer("v0.1.11", "0.1.10"))
        self.assertFalse(version_newer("0.1.9", "0.1.10"))
        self.assertFalse(version_newer("0.1.10", "0.1.10"))
        self.assertTrue(version_newer("1.0.0", "0.9.10"))
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(hog_version(root), json.loads((root / "package.json").read_text())["version"])
        self.assertEqual(
            allowed_update_url("https://api.github.com/repos/warthog-network/hog-browser/releases/latest"),
            "https://api.github.com/repos/warthog-network/hog-browser/releases/latest",
        )
        self.assertEqual(
            allowed_update_url("https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb"),
            "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb",
        )
        self.assertEqual(allowed_update_url("http://api.github.com/repos/warthog-network/hog-browser/releases/latest"), "")
        self.assertEqual(allowed_update_url("https://evil.example/hog-browser_0.1.11_amd64.deb"), "")
        self.assertEqual(allowed_update_url("https://api.github.com/../evil"), "")
        self.assertEqual(allowed_update_url("https://user@api.github.com/repos/warthog-network/hog-browser/releases/latest"), "")
        signed = (
            "https://release-assets.githubusercontent.com/github-production-release-asset/1451429308/"
            "7108586b-a9b3-4439-8e2a-3b14b8817625?sp=r&sv=2018-11-09&sr=b&se=2026-11-10T22%3A55%3A26Z"
            "&rscd=attachment%3B+filename%3Dhog-browser_0.1.13_amd64.deb&jwt=" + "a" * 600
            + "&response-content-type=application%2Foctet-stream"
        )
        self.assertEqual(allowed_update_redirect_url(signed), signed)
        self.assertEqual(allowed_update_redirect_url("https://evil.example/x?sig=1"), "")
        self.assertEqual(allowed_update_redirect_url("https://api.github.com/repos/x?sig=1"), "")
        self.assertEqual(allowed_update_redirect_url("http://release-assets.githubusercontent.com/a?sig=1"), "")
        self.assertEqual(allowed_update_redirect_url("https://u@release-assets.githubusercontent.com/a?sig=1"), "")
        self.assertEqual(
            allowed_update_redirect_url("https://github.com/warthog-network/hog-browser/releases/download/0.1.14/SHA256SUMS"),
            "https://github.com/warthog-network/hog-browser/releases/download/0.1.14/SHA256SUMS",
        )
        self.assertEqual(
            parse_sha256_digest("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        self.assertEqual(parse_sha256_digest("md5:deadbeef"), "")
        digest = "a" * 64
        self.assertEqual(parse_sha256sums(f"{digest}  hog-browser_0.1.11_amd64.deb\n", "hog-browser_0.1.11_amd64.deb"), digest)
        self.assertEqual(parse_sha256sums(f"{digest} *hog-browser_0.1.11_amd64.deb\n", "hog-browser_0.1.11_amd64.deb"), digest)
        self.assertEqual(parse_sha256sums(f"{digest}  other.deb\n", "hog-browser_0.1.11_amd64.deb"), "")
        release = parse_latest_release(
            {
                "tag_name": "v0.1.11",
                "draft": False,
                "prerelease": False,
                "html_url": "https://github.com/warthog-network/hog-browser/releases/tag/0.1.11",
                "assets": [
                    {
                        "name": "hog-browser_0.1.11_amd64.deb",
                        "browser_download_url": "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb",
                        "size": 5000,
                        "digest": "sha256:" + digest,
                    },
                    {
                        "name": "SHA256SUMS",
                        "browser_download_url": "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/SHA256SUMS",
                    },
                ],
            },
            "0.1.10",
        )
        self.assertEqual(release["version"], "0.1.11")
        self.assertTrue(release["newer"])
        self.assertEqual(release["digest"], digest)
        self.assertTrue(release["sha256sumsUrl"].endswith("/SHA256SUMS"))
        missing = parse_latest_release(
            {
                "tag_name": "0.1.11",
                "html_url": "https://github.com/warthog-network/hog-browser/releases/tag/0.1.11",
                "assets": [
                    {
                        "name": "hog-browser_0.1.11_amd64.deb",
                        "browser_download_url": "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb",
                        "size": 5000,
                    }
                ],
            },
            "0.1.10",
        )
        self.assertEqual(missing["digest"], "")
        self.assertEqual(missing["sha256sumsUrl"], "")
        with self.assertRaises(ValueError):
            parse_latest_release({"tag_name": "0.1.11", "assets": []}, "0.1.10")

    def test_helper_script_policy_and_workflow(self):
        root = Path(__file__).resolve().parents[1]
        script = (root / "packaging" / "hog-self-update").read_text(encoding="utf-8")
        self.assertIn("#!/bin/sh", script)
        self.assertIn("must run as root via pkexec", script)
        self.assertIn("apt-get install -y --", script)
        self.assertIn("/var/lib/hog-browser/update", script)
        self.assertIn("dpkg --compare-versions", script)
        self.assertIn("Package", script)
        self.assertIn("hog-browser", script)
        self.assertIn("/home/", script)
        self.assertIn(".local/share/hog-browser/updates", script)
        self.assertNotIn("sudo", script)
        self.assertNotIn("eval ", script)
        self.assertNotIn("GH_TOKEN", script)
        self.assertIn("*[2367]*)", script)
        policy = (root / "packaging" / "org.hog.Browser.self-update.policy").read_text(encoding="utf-8")
        self.assertIn("/opt/hog-browser/libexec/hog-self-update", policy)
        self.assertIn("org.freedesktop.policykit.exec.path", policy)
        self.assertIn("org.hog.Browser.self-update", policy)
        deb = (root / "packaging" / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn('install -m 755 "${ROOT}/packaging/hog-self-update"', deb)
        self.assertIn("${APP}/libexec/hog-self-update", deb)
        self.assertIn("org.hog.Browser.self-update.policy", deb)
        workflow = (root / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertIn("sha256sum", workflow)
        self.assertIn("SHA256SUMS", workflow)
        self.assertIn("dist/SHA256SUMS", workflow)
        self.assertEqual(str(SELF_UPDATE_HELPER), "/opt/hog-browser/libexec/hog-self-update")
        source = (root / "guard.py").read_text(encoding="utf-8")
        self.assertNotIn("GH_TOKEN", source)
        result = subprocess.run(
            [str(root / "packaging" / "hog-self-update")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        result = subprocess.run(
            [str(root / "packaging" / "hog-self-update"), "/tmp/x.deb"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("expected updates folder", result.stderr)
        result = subprocess.run(
            [str(root / "packaging" / "hog-self-update"), "/home/whitefang/.local/share/hog-browser/updates/hog-browser_9.9.9_amd64.deb"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("pkexec", result.stderr)

    def test_cache_and_check_never_hit_the_network(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []

            def boom(*args, **kwargs):
                calls.append((args, kwargs))
                raise AssertionError("tests must not call GitHub")

            guard.update_http_get = boom
            payload = guard.handle("update-status")
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["currentVersion"], "0.1.10")
            self.assertFalse(payload["updateAvailable"])
            self.assertFalse(calls)
            release = {
                "version": "0.1.11",
                "current": "0.1.10",
                "newer": True,
                "htmlUrl": "https://github.com/warthog-network/hog-browser/releases/tag/0.1.11",
                "assetName": "hog-browser_0.1.11_amd64.deb",
                "assetUrl": "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb",
                "assetSize": 5000,
                "digest": "a" * 64,
                "sha256sumsUrl": "",
            }
            guard.write_update_cache({"checkedAt": time.time(), "release": release})
            cached = guard.handle("update-check")
            self.assertTrue(cached["ok"])
            self.assertTrue(cached["updateAvailable"])
            self.assertEqual(cached["latestVersion"], "0.1.11")
            self.assertIn("0.1.11", cached["notice"])
            self.assertFalse(calls)
            forced = []

            def fake_get(url, timeout=20, dest=None, limit=0):
                forced.append(url)
                body = json.dumps({
                    "tag_name": "0.1.11",
                    "html_url": "https://github.com/warthog-network/hog-browser/releases/tag/0.1.11",
                    "assets": [{
                        "name": "hog-browser_0.1.11_amd64.deb",
                        "browser_download_url": "https://github.com/warthog-network/hog-browser/releases/download/0.1.11/hog-browser_0.1.11_amd64.deb",
                        "size": 5000,
                        "digest": "sha256:" + "b" * 64,
                    }],
                }).encode("utf-8")
                return body

            guard.update_http_get = fake_get
            fresh = guard.handle("update-check-now")
            self.assertTrue(fresh["ok"], fresh)
            self.assertEqual(forced, ["https://api.github.com/repos/warthog-network/hog-browser/releases/latest"])
            self.assertEqual(fresh["latestVersion"], "0.1.11")

    def test_install_verifies_deb_and_checksum_then_calls_pkexec(self):
        with tempfile.TemporaryDirectory() as folder:
            deb = make_test_deb(folder, "9.9.9")
            digest = file_sha256(deb)
            self.assertEqual(deb_field(deb, "Package"), "hog-browser")
            self.assertEqual(deb_field(deb, "Version"), "9.9.9")
            self.assertEqual(deb_field(deb, "Architecture"), "amd64")
            dest = canonical_update_path("9.9.9")
            self.assertIsNotNone(dest)
            self.assertTrue(str(dest).endswith("hog-browser_9.9.9_amd64.deb"))
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            calls = []
            try:
                guard_module.hog_version = lambda root=None: "0.1.10"
                guard = Guard(folder, docker="docker")
                release = {
                    "version": "9.9.9",
                    "current": "0.1.10",
                    "newer": True,
                    "htmlUrl": "https://github.com/warthog-network/hog-browser/releases/tag/9.9.9",
                    "assetName": "hog-browser_9.9.9_amd64.deb",
                    "assetUrl": "https://github.com/warthog-network/hog-browser/releases/download/9.9.9/hog-browser_9.9.9_amd64.deb",
                    "assetSize": deb.stat().st_size,
                    "digest": digest,
                    "sha256sumsUrl": "",
                }
                guard.write_update_cache({"checkedAt": time.time(), "release": release})

                def fake_get(url, timeout=20, dest=None, limit=0):
                    self.assertEqual(url, release["assetUrl"])
                    self.assertIsNotNone(dest)
                    Path(dest).write_bytes(deb.read_bytes())
                    return Path(dest).stat().st_size

                def run_argv(args, timeout=8):
                    calls.append((list(args), timeout))
                    guard_module.hog_version = lambda root=None: "9.9.9"
                    return subprocess.CompletedProcess(args, 0, "Installed hog-browser 9.9.9. Restart Hog to finish.\n", "")

                guard.update_http_get = fake_get
                guard.self_update_helper_status = lambda: (True, "")
                guard.run_argv = run_argv
                payload = guard.handle("update-install")
                self.assertTrue(payload["ok"], payload)
                self.assertTrue(payload["updateRestart"])
                self.assertFalse(payload["updateAvailable"])
                self.assertIn((["pkexec", "/opt/hog-browser/libexec/hog-self-update", str(dest)], 600), calls)
                self.assertEqual(sum(1 for item in calls if item[0][:1] == ["pkexec"]), 1)
                self.assertEqual(os.stat(dest.parent).st_mode & 0o777, 0o700)
                self.assertEqual(os.stat(dest).st_mode & 0o777, 0o600)
                self.assertEqual(file_sha256(dest), digest)
            finally:
                if dest is not None and dest.exists():
                    dest.unlink()

    def test_install_falls_back_without_helper_and_rejects_bad_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            deb = make_test_deb(folder, "9.9.8")
            dest = canonical_update_path("9.9.8")
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            calls = []
            try:
                guard = Guard(folder, docker="docker")
                release = {
                    "version": "9.9.8",
                    "current": "0.1.10",
                    "newer": True,
                    "htmlUrl": "https://github.com/warthog-network/hog-browser/releases/tag/9.9.8",
                    "assetName": "hog-browser_9.9.8_amd64.deb",
                    "assetUrl": "https://github.com/warthog-network/hog-browser/releases/download/9.9.8/hog-browser_9.9.8_amd64.deb",
                    "assetSize": deb.stat().st_size,
                    "digest": file_sha256(deb),
                    "sha256sumsUrl": "",
                }
                guard.write_update_cache({"checkedAt": time.time(), "release": release})
                guard.update_http_get = lambda url, timeout=20, dest=None, limit=0: Path(dest).write_bytes(deb.read_bytes()) or Path(dest).stat().st_size
                guard.self_update_helper_status = lambda: (False, "Install the hog-browser .deb to update from this window. Until then, download the release and install it by hand.")
                guard.run_argv = lambda args, timeout=8: calls.append((list(args), timeout)) or subprocess.CompletedProcess(args, 0, "", "")
                payload = guard.handle("update-install")
                self.assertTrue(payload["ok"], payload)
                self.assertFalse(payload["updateCanInstall"])
                self.assertIn("sudo apt install ./hog-browser_9.9.8_amd64.deb", payload["manualCommand"])
                self.assertIn(".deb", payload["notice"])
                self.assertFalse(calls)
                # bad digest
                release["digest"] = "c" * 64
                release["version"] = "9.9.8"
                guard.write_update_cache({"checkedAt": time.time(), "release": release})
                guard.self_update_helper_status = lambda: (True, "")
                bad = guard.handle("update-install")
                self.assertFalse(bad["ok"])
                self.assertIn("checksum", bad["error"])
                self.assertFalse(dest.exists())
                self.assertFalse(calls)
            finally:
                if dest is not None and dest.exists():
                    dest.unlink()

    def test_install_refuses_without_digest_or_sums(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            release = {
                "version": "9.9.7",
                "current": "0.1.10",
                "newer": True,
                "htmlUrl": "https://github.com/warthog-network/hog-browser/releases/tag/9.9.7",
                "assetName": "hog-browser_9.9.7_amd64.deb",
                "assetUrl": "https://github.com/warthog-network/hog-browser/releases/download/9.9.7/hog-browser_9.9.7_amd64.deb",
                "assetSize": 5000,
                "digest": "",
                "sha256sumsUrl": "",
            }
            guard.write_update_cache({"checkedAt": time.time(), "release": release})
            calls = []
            guard.update_http_get = lambda *a, **k: calls.append((a, k)) or b""
            guard.self_update_helper_status = lambda: (True, "")
            payload = guard.handle("update-install")
            self.assertFalse(payload["ok"])
            self.assertIn("SHA256SUMS", payload["error"])
            self.assertFalse(calls)



class RuntimeAndNetworkTest(unittest.TestCase):
    def test_network_name_cidr_and_builtin_delete_rules(self):
        self.assertTrue(valid_runtime(RUNTIME_ENGINE))
        self.assertTrue(valid_runtime(RUNTIME_DESKTOP))
        self.assertFalse(valid_runtime("podman"))
        self.assertTrue(valid_network_name("hog-app"))
        self.assertTrue(valid_network_name("hog.app_1"))
        self.assertFalse(valid_network_name("bridge"))
        self.assertFalse(valid_network_name("host"))
        self.assertFalse(valid_network_name("none"))
        self.assertTrue(valid_network_name("bridge", allow_builtin=True))
        self.assertFalse(valid_network_name("../x"))
        self.assertFalse(valid_network_name("has space"))
        self.assertTrue(valid_network_driver("bridge"))
        self.assertTrue(valid_network_driver("macvlan"))
        self.assertTrue(valid_network_driver("ipvlan"))
        self.assertFalse(valid_network_driver("overlay"))
        self.assertTrue(valid_cidr("172.28.0.0/16"))
        self.assertTrue(valid_cidr("10.0.0.0/8"))
        self.assertTrue(valid_cidr("fd00:686f:6700:1::/64"))
        self.assertFalse(valid_cidr("172.28.0.0"))
        self.assertFalse(valid_cidr("172.28.0.0/99"))
        self.assertFalse(valid_cidr("999.0.0.0/16"))
        self.assertFalse(valid_cidr("172.28.0.0/16; rm -rf /"))
        self.assertTrue(valid_gateway("172.28.0.1"))
        self.assertFalse(valid_gateway("172.28.0.1/16"))
        self.assertEqual(network_delete_problem("bridge"), "Built-in Docker networks cannot be deleted.")
        self.assertEqual(network_delete_problem("host"), "Built-in Docker networks cannot be deleted.")
        self.assertEqual(network_delete_problem("none"), "Built-in Docker networks cannot be deleted.")
        self.assertIn("attached", network_delete_problem("hog-app", ["jellyfin"]))
        self.assertEqual(network_delete_problem("hog-app"), "")
        self.assertIn("plain", network_delete_problem(".."))
        self.assertEqual(set(BUILTIN_NETWORKS), {"bridge", "host", "none"})

    def test_tailscale_serve_host_depends_on_runtime(self):
        self.assertEqual(tailscale_serve_host("desktop"), "host.docker.internal")
        self.assertEqual(tailscale_serve_host("engine"), "127.0.0.1")
        self.assertEqual(tailscale_serve_host(""), "host.docker.internal")

    def test_publish_port_uses_loopback_for_engine_tailscale(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.save_runtime("tailscale", "engine")
            seen = []

            def capture(args, timeout=8, sock=None):
                seen.append((list(args), sock))
                return "ok", 0

            guard.capture = capture
            problem, url = guard.publish_port(8096)
            self.assertEqual((problem, url), ("", ""))
            self.assertEqual(seen[1][0][-1], "tcp://127.0.0.1:8096")
            self.assertEqual(seen[1][1], guard.engine_sock())
            seen.clear()
            guard.save_runtime("tailscale", "desktop")
            problem, url = guard.publish_port(8101)
            self.assertEqual(problem, "")
            self.assertEqual(seen[0][0][-1], "http://host.docker.internal:8101")
            self.assertIsNone(seen[0][1])

    def test_apply_command_uses_host_network_on_engine_tailscale(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            state = {"exists": False}

            def info(running=True, network="host"):
                return {
                    "Name": "/tailscale",
                    "State": {"Status": "running" if running else "exited", "Running": running},
                    "Config": {"Image": "tailscale/tailscale:latest"},
                    "HostConfig": {
                        "Privileged": False,
                        "NetworkMode": network,
                        "PidMode": "",
                        "IpcMode": "private",
                        "CapAdd": ["NET_ADMIN", "NET_RAW"],
                        "Binds": ["hog-tailscale-state:/var/lib/tailscale"],
                        "Devices": [{"PathOnHost": "/dev/net/tun"}],
                    },
                    "Mounts": [
                        {"Name": "hog-tailscale-state", "Source": "/var/lib/docker/volumes/hog-tailscale-state/_data", "Destination": "/var/lib/tailscale", "Type": "volume"},
                    ],
                }

            def inspect(name):
                if name != "tailscale" or not state["exists"]:
                    return None, "Docker did not find that container."
                return info(), ""

            def run_on(args, timeout=8, sock=None):
                calls.append((list(args), sock, timeout))
                if args and args[0] == "run":
                    state["exists"] = True
                if args[:3] == ["exec", "tailscale", "ls"]:
                    return subprocess.CompletedProcess(args, 0, "/usr/sbin/iptables -> xtables-nft-multi\n/usr/sbin/ip6tables -> xtables-nft-multi\n", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.inspect_on = lambda name, sock=None: inspect(name)
            guard.run_on = run_on
            guard.run = lambda args, timeout=8: run_on(args, timeout=timeout, sock=None)
            guard.container_run = lambda name, args, timeout=8: run_on(args, timeout=timeout, sock=guard.container_sock(name))
            guard.items = lambda: []
            guard.docker_running = lambda: True
            guard.runtime_available = lambda side: side == "engine"
            line = canonical_command(
                "tailscale",
                "tailscale/tailscale:latest",
                (),
                True,
                (),
                ("TS_HOSTNAME=hog", "TS_USERSPACE=false", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale", "TS_EXTRA_ARGS=--advertise-exit-node", "TS_BOOT_TIMEOUT=10m", "TS_DEBUG_FIREWALL_MODE=nftables"),
                (),
                (),
                "host",
            )
            created = guard.apply_command(line, runtime="engine")
            self.assertTrue(created["ok"], created.get("error"))
            run_args, sock, _timeout = next(item for item in calls if item[0][0] == "run")
            self.assertEqual(sock, guard.engine_sock())
            self.assertIn("--network", run_args)
            self.assertIn("host", run_args)
            self.assertIn("--cap-add=NET_RAW", run_args)
            self.assertIn("hog-tailscale-state:/var/lib/tailscale", run_args)
            self.assertNotIn("hog-tailscale-state", created["command"])
            self.assertEqual(guard.read_runtimes().get("tailscale"), "engine")
            self.assertFalse(any(item[0][:2] == ["network", "create"] for item in calls))

    def test_create_network_validates_and_uses_argv(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []

            def run_on(args, timeout=8, sock=None):
                calls.append(list(args))
                if args[:2] == ["network", "ls"]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 0, "id\n", "")

            guard.run_on = run_on
            guard.run = lambda args, timeout=8: run_on(args, timeout=timeout, sock=None)
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard._runtime_or_error = lambda side: (guard.engine_sock() if side == "engine" else None, "")
            refused = guard.create_network({"runtime": "engine", "name": "bridge", "driver": "bridge"})
            self.assertFalse(refused["ok"])
            self.assertIn("plain", refused["error"].lower())
            bad = guard.create_network({"runtime": "engine", "name": "hog-app", "driver": "bridge", "subnet": "172.28.0.0"})
            self.assertFalse(bad["ok"])
            self.assertIn("subnet", bad["error"].lower())
            ok = guard.create_network({
                "runtime": "engine",
                "name": "hog-app",
                "driver": "bridge",
                "subnet": "172.28.0.0/16",
                "gateway": "172.28.0.1",
                "internal": True,
            })
            self.assertTrue(ok["ok"], ok)
            created = next(item for item in calls if item[:2] == ["network", "create"])
            self.assertEqual(created, [
                "network", "create", "--driver", "bridge",
                "--subnet", "172.28.0.0/16",
                "--gateway", "172.28.0.1",
                "--internal",
                "hog-app",
            ])

    def test_remove_network_refuses_builtins_and_attached(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard._runtime_or_error = lambda side: (None, "")
            guard.list_networks = lambda side="": {"ok": True, "error": "", "items": [], "networks": []}
            for name in ("bridge", "host", "none"):
                result = guard.remove_network(f"desktop:{name}")
                self.assertFalse(result["ok"])
                self.assertIn("Built-in", result["error"])
            inspect_body = [{
                "Name": "hog-app",
                "Driver": "bridge",
                "Containers": {"abc": {"Name": "jellyfin"}},
            }]

            def run(args, timeout=8):
                if args[:2] == ["network", "inspect"]:
                    return subprocess.CompletedProcess(args, 0, json.dumps(inspect_body), "")
                raise AssertionError(args)

            guard.run = run
            attached = guard.remove_network("desktop:hog-app")
            self.assertFalse(attached["ok"])
            self.assertIn("attached", attached["error"])

    def test_recommended_runtime_keeps_existing_desktop_tailscale(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            boxes = {"desktop": True, "engine": False}

            def inspect_on(name, sock=None):
                if name != "tailscale":
                    return None, "missing"
                if sock is None and boxes["desktop"]:
                    return {"Name": "/tailscale", "Config": {"Image": "tailscale/tailscale:latest"}}, ""
                return None, "missing"

            guard.inspect_on = inspect_on
            guard.runtime_available = lambda side: True
            self.assertEqual(guard.recommended_runtime("tailscale", "tailscale/tailscale:latest"), "desktop")
            boxes["desktop"] = False
            self.assertEqual(guard.recommended_runtime("tailscale", "tailscale/tailscale:latest"), "engine")
            guard.save_runtime("tailscale", "desktop")
            self.assertEqual(guard.recommended_runtime("tailscale", "tailscale/tailscale:latest"), "desktop")
            self.assertEqual(guard.container_runtime("ubuntu"), "desktop")

    def test_set_container_runtime_moves_and_warns(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            boxes = {"desktop": {
                "Name": "/ubuntu",
                "State": {"Status": "running", "Running": True},
                "Config": {"Image": "ubuntu:24.04", "Cmd": ["sleep", "infinity"], "Env": []},
                "HostConfig": {
                    "Privileged": False,
                    "NetworkMode": "bridge",
                    "PidMode": "",
                    "IpcMode": "private",
                    "CapAdd": None,
                    "PortBindings": {},
                    "Sysctls": {},
                    "Binds": None,
                    "Devices": None,
                },
                "Mounts": [],
            }, "engine": None}
            calls = []

            def inspect_on(name, sock=None):
                if name != "ubuntu":
                    return None, "missing"
                info = boxes["desktop"] if sock is None else boxes["engine"]
                if info is None:
                    return None, "missing"
                return info, ""

            template = dict(boxes["desktop"])

            def run_on(args, timeout=8, sock=None):
                calls.append((list(args), sock))
                if args and args[0] == "run":
                    started = dict(template)
                    if sock is None:
                        boxes["desktop"] = started
                    else:
                        boxes["engine"] = started
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[:1] in (["stop"], ["rm"]):
                    if sock is None:
                        boxes["desktop"] = None
                    else:
                        boxes["engine"] = None
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect_on = inspect_on
            guard.run_on = run_on
            guard.run = lambda args, timeout=8: run_on(args, timeout=timeout, sock=None)
            guard.docker_running = lambda: True
            guard.items = lambda: []
            guard.runtime_fields = lambda: {"dockerRuntimes": {"engine": {"ok": True, "detail": ""}, "desktop": {"ok": True, "detail": ""}}, "runtimeDefaults": {}}
            guard.tailscale_dns = lambda: ("", False)
            guard.media_view = lambda: ("", [])
            payload = guard.set_container_runtime("ubuntu", "engine")
            self.assertTrue(payload["ok"], payload)
            self.assertIn("do not carry over", payload["notice"].lower())
            self.assertEqual(guard.read_runtimes()["ubuntu"], "engine")
            self.assertTrue(any(item[0][:1] == ["stop"] and item[1] is None for item in calls))
            created = next(item for item in calls if item[0][:1] == ["run"])
            self.assertEqual(created[1], guard.engine_sock())


class ContainerPullAndServeTest(unittest.TestCase):
    def test_apply_command_pulls_missing_image_before_run(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []
            pulled = []
            state = {"up": False}
            events = []

            def inspect(name):
                if name != "box" or not state["up"]:
                    return None, "missing"
                return {
                    "Name": "/box",
                    "State": {"Status": "running", "Running": True},
                    "Config": {"Image": "ubuntu:24.04"},
                    "HostConfig": {"Privileged": False, "NetworkMode": "bridge", "PidMode": "", "IpcMode": "private"},
                    "Mounts": [],
                }, ""

            def run(args, timeout=8):
                calls.append(list(args))
                if args and args[0] == "run":
                    state["up"] = True
                return subprocess.CompletedProcess(args, 0, "", "")

            guard.inspect = inspect
            guard.run = run
            guard.run_on = lambda args, timeout=8, sock=None: run(args, timeout)
            guard.container_run = lambda name, args, timeout=8: run(args, timeout)
            guard.items = lambda: []
            guard.docker_running = lambda: True
            guard.runtime_available = lambda side: True
            guard.container_runtime = lambda name="": "engine"
            guard.container_sock = lambda name="": None
            guard.prepare_tailscale_firewall = lambda name, info: ""
            guard._attach_gpu = lambda payload: payload
            guard.image_exists = lambda image, sock=None: False

            def pull(image, sock=None, progress=None):
                pulled.append(image)
                if progress:
                    progress({"ok": True, "imagePull": {"image": image, "status": "Downloading image…", "percent": None}})
                return ""

            guard.pull_image = pull
            line = canonical_command("box", "ubuntu:24.04", (), False, ("sleep", "infinity"))
            result = guard.handle("run", line, "engine", progress=events.append)
            self.assertTrue(result["ok"], result.get("error"))
            self.assertEqual(pulled, ["ubuntu:24.04"])
            self.assertTrue(any(item and item.get("imagePull") for item in events))
            self.assertTrue(any(item and item[0] == "run" for item in calls))
            self.assertFalse(any(item and item[0] == "pull" for item in calls))

    def test_publish_port_keeps_other_services(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            seen = []

            def capture(args, timeout=8, sock=None):
                seen.append(list(args))
                return "ok", 0

            guard.capture = capture
            problem, url = guard.publish_services(({"port": 8096, "kind": "tcp"}, {"port": 8101, "kind": "https"}))
            self.assertEqual((problem, url), ("", ""))
            text = " ".join(" ".join(item) for item in seen)
            self.assertIn("--tcp=8096", text)
            self.assertIn("--https=8101", text)
            self.assertNotIn("funnel", text)
            self.assertTrue(any(item[-1] == "tcp://host.docker.internal:8096" for item in seen))
            self.assertTrue(any(item[-1] == "http://host.docker.internal:8101" for item in seen))
            # Publishing a shared folder must not turn off Jellyfin's tcp serve.
            off_calls = [item for item in seen if item and item[-1] == "off"]
            self.assertTrue(any("--https=8096" in item for item in off_calls))
            self.assertFalse(any("--tcp=8096" in item and item[-1] == "off" for item in seen))
            self.assertFalse(any("--https=8101" in item and item[-1] == "off" for item in seen))

    def test_publish_port_engine_uses_loopback(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.container_runtime = lambda name="": "engine"
            seen = []

            def capture(args, timeout=8, sock=None):
                seen.append(list(args))
                return "ok", 0

            guard.capture = capture
            problem, url = guard.publish_port(8101, kind="https")
            self.assertEqual((problem, url), ("", ""))
            self.assertEqual(seen[0][-1], "http://127.0.0.1:8101")
            self.assertNotIn("funnel", seen[0])


SERVE_STATUS = {
    "TCP": {
        "3000": {"HTTPS": True},
        "8096": {"TCPForward": "127.0.0.1:8096"},
    },
    "Web": {
        "hog.tail314642.ts.net:3000": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
    },
}


def running_info(ports, running=True):
    return {
        "Name": "/svc",
        "State": {"Status": "running" if running else "exited", "Running": running},
        "Config": {"Image": "example/web:latest"},
        "HostConfig": {"Privileged": False, "NetworkMode": "bridge"},
        "NetworkSettings": {"Ports": ports},
        "Mounts": [],
    }


class ServiceLinksTest(unittest.TestCase):
    def test_published_ports_reads_tcp_bindings(self):
        from guard import published_ports

        info = running_info({
            "8096/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8096"}],
            "80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}, {"HostIp": "::", "HostPort": "8080"}],
            "51820/udp": [{"HostIp": "0.0.0.0", "HostPort": "51820"}],
            "9000/tcp": None,
            "7000/tcp": [{"HostIp": "evil host", "HostPort": "7000"}, {"HostIp": "", "HostPort": "abc"}],
        })
        self.assertEqual(
            published_ports(info),
            [
                {"bind": "0.0.0.0", "port": 8080, "containerPort": 80},
                {"bind": "127.0.0.1", "port": 8096, "containerPort": 8096},
            ],
        )
        self.assertEqual(published_ports(running_info({"80/tcp": [{"HostPort": "8080"}]}, running=False)), [])
        self.assertEqual(published_ports(None), [])
        self.assertEqual(published_ports({"State": {"Running": True}}), [])

    def test_serve_ports_maps_local_ports(self):
        from guard import serve_ports

        self.assertEqual(
            serve_ports(SERVE_STATUS),
            {8096: {"kind": "tcp", "port": 8096}, 3000: {"kind": "https", "port": 3000}},
        )
        mapped = serve_ports({
            "TCP": {"443": {"HTTPS": True}},
            "Web": {"hog.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://host.docker.internal:8101"}}}},
        })
        self.assertEqual(mapped, {8101: {"kind": "https", "port": 443}})
        self.assertEqual(serve_ports(None), {})
        self.assertEqual(serve_ports({"TCP": "bad", "Web": []}), {})

    def test_links_for_jellyfin_on_loopback_with_tailscale_tcp(self):
        from guard import service_links

        hosts = {
            "lan": "192.168.1.223",
            "tailscaleIp": "100.119.132.89",
            "tailscaleDns": "hog.tail314642.ts.net.",
            "serve": {8096: {"kind": "tcp", "port": 8096}},
            "hostNetwork": True,
        }
        links = service_links([{"bind": "127.0.0.1", "port": 8096, "containerPort": 8096}], hosts)
        self.assertEqual(
            [(item["kind"], item["label"], item["url"]) for item in links],
            [
                ("local", "This computer", "http://127.0.0.1:8096"),
                ("tailnet", "Tailnet", "http://hog.tail314642.ts.net:8096"),
                ("tailnet", "Tailnet IP", "http://100.119.132.89:8096"),
            ],
        )
        # A loopback-only port is not offered on the home network.
        self.assertFalse(any(item["kind"] == "lan" for item in links))

    def test_links_for_wildcard_bind_and_https_serve(self):
        from guard import service_links

        hosts = {
            "lan": "192.168.1.223",
            "tailscaleIp": "100.119.132.89",
            "tailscaleDns": "hog.tail314642.ts.net",
            "serve": {3000: {"kind": "https", "port": 3000}},
            "hostNetwork": True,
        }
        wide = service_links([{"bind": "0.0.0.0", "port": 8080, "containerPort": 80}], hosts)
        self.assertEqual(
            [item["url"] for item in wide],
            ["http://127.0.0.1:8080", "http://192.168.1.223:8080", "http://100.119.132.89:8080"],
        )
        self.assertEqual([item["kind"] for item in wide], ["local", "lan", "tailnet"])
        served = service_links([{"bind": "127.0.0.1", "port": 3000, "containerPort": 8080}], hosts)
        self.assertEqual([item["url"] for item in served], ["http://127.0.0.1:3000", "https://hog.tail314642.ts.net:3000"])
        # Without host networking a wildcard port is not assumed to be on the tailnet.
        desktop = service_links([{"bind": "0.0.0.0", "port": 8080, "containerPort": 80}], dict(hosts, hostNetwork=False))
        self.assertEqual([item["kind"] for item in desktop], ["local", "lan"])

    def test_links_skip_non_web_ports_and_bad_hosts(self):
        from guard import service_links

        self.assertEqual(service_links([{"bind": "127.0.0.1", "port": 5433, "containerPort": 5432}], {}), [])
        self.assertEqual(service_links([{"bind": "0.0.0.0", "port": 2222, "containerPort": 22}], {}), [])
        bad = service_links(
            [{"bind": "0.0.0.0", "port": 8096, "containerPort": 8096}],
            {
                "lan": "8.8.8.8",
                "tailscaleIp": "1.2.3.4",
                "tailscaleDns": "evil.example.com",
                "serve": {8096: {"kind": "tcp", "port": 8096}},
                "hostNetwork": True,
            },
        )
        self.assertEqual([item["url"] for item in bad], ["http://127.0.0.1:8096"])
        self.assertEqual(service_links([{"port": "x"}, None, {"port": 70000}], {}), [])
        self.assertEqual(service_links(None, None), [])

    def test_snapshot_reports_ports_and_payload_gets_links(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            info = running_info({"8096/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8096"}]})
            info["Name"] = "/jellyfin"
            guard.inspect = lambda name: (info, "")
            guard.container_runtime = lambda name="": "engine"
            row = guard.snapshot("jellyfin")
            self.assertEqual(row["ports"], [{"bind": "127.0.0.1", "port": 8096, "containerPort": 8096}])
            calls = []

            def hosts(items=None, force=False):
                calls.append(items)
                return {
                    "tailscaleIp": "100.119.132.89",
                    "tailscaleDns": "hog.tail314642.ts.net",
                    "serve": {8096: {"kind": "tcp", "port": 8096}},
                }

            guard.link_hosts = hosts
            guard.jellyfin_gpu_fields = lambda: {}
            guard.runtime_fields = lambda: {}
            stopped = {"name": "old", "state": "exited", "ports": [{"bind": "127.0.0.1", "port": 9000, "containerPort": 80}]}
            payload = guard._mark_docker({"ok": True, "docker": True, "items": [row, stopped]})
            self.assertEqual(
                [item["url"] for item in payload["items"][0]["links"]],
                ["http://127.0.0.1:8096", "http://hog.tail314642.ts.net:8096", "http://100.119.132.89:8096"],
            )
            self.assertEqual(payload["items"][1]["links"], [])
            self.assertEqual(len(calls), 1)
            self.assertNotIn("ai", payload)

    def test_link_hosts_skips_tailscale_when_not_running_and_caches(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            guard.lan_address = lambda: "192.168.1.5"
            asked = []

            def status():
                asked.append("status")
                return {"Self": {"DNSName": "hog.tail314642.ts.net.", "TailscaleIPs": ["100.119.132.89", "fd7a::1"]}}, ""

            def container_run(name, args, timeout=8):
                asked.append(args[-2])
                return subprocess.CompletedProcess(args, 0, json.dumps(SERVE_STATUS), "")

            guard.tailscale_status_payload = status
            guard.container_run = container_run
            guard.container_runtime = lambda name="": "engine"
            off = guard.link_hosts([{"name": "jellyfin", "state": "running"}])
            self.assertEqual(off["lan"], "192.168.1.5")
            self.assertEqual(off["tailscaleIp"], "")
            self.assertEqual(asked, [])
            on = guard.link_hosts([{"name": "tailscale", "state": "running"}], force=True)
            self.assertEqual(on["tailscaleIp"], "100.119.132.89")
            self.assertEqual(on["tailscaleDns"], "hog.tail314642.ts.net")
            self.assertEqual(on["serve"][8096], {"kind": "tcp", "port": 8096})
            self.assertTrue(on["hostNetwork"])
            count = len(asked)
            again = guard.link_hosts([{"name": "tailscale", "state": "running"}])
            self.assertEqual(again["tailscaleIp"], "100.119.132.89")
            self.assertEqual(len(asked), count)


class LegacyAiSettingsTest(unittest.TestCase):
    def test_old_ai_state_files_and_actions_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "ai.json").write_text(json.dumps({"ollamaPort": 11434, "openWebuiPort": 3000}), encoding="utf-8")
            Path(folder, "ai-code.json").write_text(json.dumps({"folder": "~/proj", "model": "qwen2.5-coder:14b"}), encoding="utf-8")
            guard = Guard(folder, docker="docker")
            guard.docker_running = lambda: True
            guard.items = lambda: [{"name": "hog-ollama", "state": "running", "image": "ollama/ollama:latest", "reason": "", "runtime": "engine", "ports": []}]
            guard._offline_items = lambda: []
            guard.media_view = lambda: ("", [])
            guard.wireguard_module_loaded = lambda: True
            guard.jellyfin_gpu_fields = lambda: {}
            guard.runtime_fields = lambda: {}
            listed = guard.handle("list")
            self.assertTrue(listed["ok"])
            self.assertNotIn("ai", listed)
            self.assertEqual(listed["items"][0]["links"], [])
            for action in ("ai-models", "ai-pull", "ai-code-start", "ai-editor-connect"):
                payload = guard.handle(action, "qwen2.5-coder:14b")
                self.assertFalse(payload.get("ok"), action)
                self.assertNotIn("ai", payload)
            self.assertFalse(hasattr(guard, "start_code_chat"))
            self.assertFalse(hasattr(guard_module, "OLLAMA_NAME"))


if __name__ == "__main__":
    unittest.main()
