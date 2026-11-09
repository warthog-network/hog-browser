import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import guard as guard_module
from share_page import listing_page, safe_target
from guard import drop_destination, drop_file_path, format_bytes, library_folder, media_listing, remove_media_entry, take_drop
from guard import (
    ENGINE_START,
    PRESETS,
    SHARE_NAME_RE,
    CommandError,
    Guard,
    assess,
    assign_share_port,
    canonical_command,
    compose_run,
    docker_offline,
    docker_volume_data,
    folder_problem,
    launch_args,
    mount_problem,
    parse_run,
    valid_name,
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
        self.assertEqual(parse_run(text), ("ubuntu", "ubuntu:24.04", (), False, ("sleep", "infinity"), (), ()))

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
            self.assertEqual(calls[2][0], "run")
            self.assertIn("51820:51820/udp", calls[2])
            self.assertIn("--cap-add=SETUID", calls[2])
            self.assertNotIn("--cap-add=NET_ADMIN", calls[2])
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
            ("net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1"),
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
        self.assertIn("--sysctl net.ipv4.conf.all.src_valid_mark=1", text)
        self.assertTrue(text.endswith("tailscale/tailscale:latest"))
        parsed = parse_run(text)
        self.assertEqual(parsed[4], ())
        self.assertEqual(parse_run(canonical_command(*parsed)), parsed)
        for line in (
            "docker run --name tailscale --cap-add NET_RAW tailscale/tailscale:latest",
            "docker run --name tailscale -v tailscale:/var/lib/tailscale tailscale/tailscale:latest",
            "docker run --name tailscale --network host tailscale/tailscale:latest",
        ):
            with self.assertRaises(CommandError):
                parse_run(line)

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
                        "NetworkMode": "bridge",
                        "PidMode": "",
                        "IpcMode": "private",
                        "CapAdd": ["NET_ADMIN"],
                        "Binds": None,
                        "Devices": [{"PathOnHost": "/dev/net/tun"}],
                    },
                    "Mounts": [],
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
                ("net.ipv4.ip_forward=1", "net.ipv4.conf.all.src_valid_mark=1"),
            )
            created = guard.handle("run", line)
            self.assertTrue(created["ok"], created.get("error"))
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

    def test_tailscale_sign_in_runs_only_the_fixed_command(self):
        with tempfile.TemporaryDirectory() as folder:
            guard = Guard(folder, docker="docker")
            calls = []

            def inspect(name):
                body = info()
                body["Name"] = f"/{name}"
                body["State"] = {"Running": True, "Status": "running"}
                body["Config"] = {"Image": "tailscale/tailscale:latest"}
                return body, ""

            def run(args, timeout=8):
                calls.append((list(args), timeout))
                if args[:3] == ["exec", "tailscale", "tailscale"]:
                    return subprocess.CompletedProcess(args, 0, "https://login.tailscale.com/a/example\n", "")
                raise AssertionError(args)

            guard.inspect = inspect
            guard.run = run
            guard.items = lambda: []
            guard.docker_running = lambda: True
            result = guard.handle("tailscale-up", "tailscale; rm -rf /")
            self.assertTrue(result["ok"], result.get("error"))
            self.assertEqual(
                calls[0],
                (["exec", "tailscale", "tailscale", "up", "--advertise-exit-node", "--timeout=90s"], 100),
            )
            self.assertIn("https://login.tailscale.com/a/example", result["notice"])
            self.assertEqual(len(calls), 1)

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

            def capture(args, timeout=8):
                seen.append((list(args), timeout))
                return "Serve is not enabled\nhttps://login.tailscale.com/f/serve?node=example\n", 124

            guard.capture = capture
            problem, url = guard.publish_port(8101)
            self.assertEqual(problem, "")
            self.assertTrue(url.startswith("https://login.tailscale.com/"))
            self.assertNotIn("funnel", seen[0][0])
            self.assertEqual(seen[0][0][-2:], ["--https=8101", "http://host.docker.internal:8101"])
            seen.clear()

            def capture_jellyfin(args, timeout=8):
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
            run_args = calls[0]
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


if __name__ == "__main__":
    unittest.main()
