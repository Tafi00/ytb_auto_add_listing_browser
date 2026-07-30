from __future__ import annotations

import hashlib
import json
import os
import select
import shlex
import socketserver
import ssl
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi


ADB_LEASE_PATH = "/vcpcloud/api/padApi/adb"
VMOS_API_ROOT = "https://api.vmoscloud.com"
_VMOS_CLOCK_LOCK = threading.RLock()
_VMOS_CLOCK_OFFSET_SECONDS = 0.0


class VmosCloudError(RuntimeError):
    pass


@dataclass(frozen=True)
class VmosLease:
    command: str
    key: str
    adb: str
    expire_time: float


@dataclass(frozen=True)
class SshForward:
    username: str
    hostname: str
    ssh_port: int
    remote_host: str
    remote_port: int


def _parse_expire_time(value: str | None, default_seconds: int = 86400) -> float:
    if value:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
            try:
                return datetime.strptime(value, fmt).timestamp()
            except ValueError:
                continue
    return time.time() + default_seconds


def parse_ssh_forward(command: str) -> SshForward:
    """Parse the temporary VMOS SSH forwarding command.

    The local port in ``-L`` is intentionally ignored. The worker binds its own
    stable local port so the ADB serial never changes after a lease refresh.
    """

    tokens = shlex.split(command, posix=True)
    if not tokens or Path(tokens[0]).name.lower() not in {"ssh", "ssh.exe"}:
        raise VmosCloudError("Lệnh VMOS không phải lệnh SSH hợp lệ")

    ssh_port = 22
    forward_spec = ""
    destination = ""
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "-p" and index + 1 < len(tokens):
            ssh_port = int(tokens[index + 1])
            index += 2
            continue
        if token.startswith("-p") and len(token) > 2:
            ssh_port = int(token[2:])
            index += 1
            continue
        if token == "-L" and index + 1 < len(tokens):
            forward_spec = tokens[index + 1]
            index += 2
            continue
        if token.startswith("-L") and len(token) > 2:
            forward_spec = token[2:]
            index += 1
            continue
        if not token.startswith("-") and "@" in token:
            destination = token
        index += 1

    if not destination or not forward_spec:
        raise VmosCloudError("Lệnh VMOS thiếu địa chỉ SSH hoặc cấu hình -L")
    username, hostname = destination.rsplit("@", 1)
    try:
        _, remote_host, remote_port = forward_spec.rsplit(":", 2)
    except ValueError as error:
        raise VmosCloudError("Cấu hình SSH -L của VMOS không hợp lệ") from error
    return SshForward(
        username=username,
        hostname=hostname,
        ssh_port=ssh_port,
        remote_host=remote_host,
        remote_port=int(remote_port),
    )


class VmosApiClient:
    def __init__(
        self,
        access_key: str,
        secret_key: str,
        api_root: str = VMOS_API_ROOT,
        timeout: float = 20,
        ca_bundle: str = "",
    ):
        self.access_key = access_key.strip()
        self.secret_key = secret_key.strip()
        self.api_root = api_root.rstrip("/")
        self.timeout = timeout
        self.ca_bundle = str(ca_bundle or "").strip()
        if not self.access_key or not self.secret_key:
            raise VmosCloudError("Thiếu VMOS Access Key hoặc Secret Key")
        self.ssl_context = self._create_ssl_context()

    def _create_ssl_context(self) -> ssl.SSLContext:
        # Keep the Windows trust store and augment it with a CA bundle that is
        # always present inside the standalone executable.
        context = ssl.create_default_context()
        context.load_verify_locations(cafile=certifi.where())
        if self.ca_bundle:
            ca_path = Path(self.ca_bundle).expanduser().resolve()
            if not ca_path.is_file():
                raise VmosCloudError(
                    f"Không tìm thấy file chứng chỉ VMOS CA: {ca_path}"
                )
            try:
                context.load_verify_locations(cafile=str(ca_path))
            except ssl.SSLError as pem_error:
                try:
                    der_pem = ssl.DER_cert_to_PEM_cert(ca_path.read_bytes())
                    context.load_verify_locations(cadata=der_pem)
                except (OSError, ValueError, ssl.SSLError) as error:
                    raise VmosCloudError(
                        f"File chứng chỉ VMOS CA không hợp lệ: {ca_path}"
                    ) from error
        return context

    def post(self, path: str, payload: dict) -> dict:
        body = json.dumps(
            payload, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        for attempt in range(2):
            with _VMOS_CLOCK_LOCK:
                adjusted_time = time.time() + _VMOS_CLOCK_OFFSET_SECONDS
            timestamp = str(int(adjusted_time))
            signature = hashlib.sha256(
                self.secret_key.encode("utf-8")
                + timestamp.encode("ascii")
                + path.encode("utf-8")
                + body
            ).hexdigest()
            request = Request(
                self.api_root + path,
                data=body,
                method="POST",
                headers={
                    "X-Access-Key": self.access_key,
                    "X-Timestamp": timestamp,
                    "X-Sign": signature,
                    "Content-Type": "application/json",
                },
            )
            try:
                with urlopen(
                    request,
                    timeout=self.timeout,
                    context=self.ssl_context,
                ) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")
                error.close()
                try:
                    result = json.loads(detail)
                except json.JSONDecodeError:
                    result = {}
                if attempt == 0 and self._apply_server_clock(result):
                    continue
                raise VmosCloudError(
                    f"VMOS OpenAPI trả HTTP {error.code}: {detail[:300]}"
                ) from error
            except (URLError, TimeoutError, json.JSONDecodeError) as error:
                raise VmosCloudError(
                    f"Không gọi được VMOS OpenAPI: {error}"
                ) from error
            if int(result.get("code", -1)) == 200:
                return result
            if attempt == 0 and self._apply_server_clock(result):
                continue
            raise VmosCloudError(
                f"VMOS OpenAPI lỗi {result.get('code')}: "
                f"{result.get('msg') or 'không rõ lỗi'}"
            )
        raise VmosCloudError("VMOS OpenAPI từ chối timestamp sau khi tự đồng bộ")

    @staticmethod
    def _apply_server_clock(result: dict) -> bool:
        if int(result.get("code", -1)) != 2033:
            return False
        try:
            server_time = float(result["ts"])
        except (KeyError, TypeError, ValueError):
            return False
        if server_time > 100_000_000_000:
            server_time /= 1000
        global _VMOS_CLOCK_OFFSET_SECONDS
        with _VMOS_CLOCK_LOCK:
            _VMOS_CLOCK_OFFSET_SECONDS = server_time - time.time()
        return True

    def get_adb_lease(
        self, pad_code: str, expire_minutes: int = 10080
    ) -> VmosLease:
        expire_minutes = max(1440, min(int(expire_minutes), 10080))
        result = self.post(
            ADB_LEASE_PATH,
            {
                "padCode": pad_code,
                "enable": True,
                "expireMinutes": expire_minutes,
            },
        )
        data = result.get("data") or {}
        if isinstance(data, list):
            data = data[0] if data else {}
        command = str(data.get("command", "")).strip()
        key = str(data.get("key", "")).strip()
        adb = str(data.get("adb", "")).strip()
        if not command or not key or not adb:
            raise VmosCloudError(
                "VMOS chưa trả đủ SSH command/key/ADB. Hãy bật ADB cho cloud phone."
            )
        return VmosLease(
            command=command,
            key=key,
            adb=adb,
            expire_time=_parse_expire_time(data.get("expireTime")),
        )


class _ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        server: "_ForwardServer" = self.server  # type: ignore[assignment]
        channel = server.transport.open_channel(
            "direct-tcpip",
            (server.remote_host, server.remote_port),
            self.request.getpeername(),
        )
        if channel is None:
            return
        try:
            while not server.stop_event.is_set():
                readable, _, _ = select.select(
                    [self.request, channel], [], [], 1
                )
                if self.request in readable:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    channel.sendall(data)
                if channel in readable:
                    data = channel.recv(65536)
                    if not data:
                        break
                    self.request.sendall(data)
        finally:
            channel.close()
            self.request.close()


class _ForwardServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, handler, transport, remote_host, remote_port):
        self.transport = transport
        self.remote_host = remote_host
        self.remote_port = remote_port
        self.stop_event = threading.Event()
        super().__init__(address, handler)


class ParamikoTunnel:
    def __init__(self, forward: SshForward, password: str, local_port: int):
        self.forward = forward
        self.password = password
        self.local_port = int(local_port)
        self.client = None
        self.server = None
        self.thread = None

    def start(self):
        try:
            import paramiko
        except ImportError as error:
            raise VmosCloudError(
                "Thiếu thư viện paramiko. Hãy cài requirements-android.txt."
            ) from error
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                self.forward.hostname,
                port=self.forward.ssh_port,
                username=self.forward.username,
                password=self.password,
                look_for_keys=False,
                allow_agent=False,
                timeout=20,
                auth_timeout=20,
                banner_timeout=20,
            )
            transport = client.get_transport()
            if not transport or not transport.is_active():
                raise VmosCloudError("SSH tunnel VMOS không hoạt động")
            server = _ForwardServer(
                ("127.0.0.1", self.local_port),
                _ForwardHandler,
                transport,
                self.forward.remote_host,
                self.forward.remote_port,
            )
        except Exception:
            client.close()
            raise
        self.client = client
        self.server = server
        self.thread = threading.Thread(
            target=server.serve_forever,
            name=f"vmos-adb-{self.local_port}",
            daemon=True,
        )
        self.thread.start()

    def is_alive(self) -> bool:
        transport = self.client.get_transport() if self.client else None
        return bool(
            transport
            and transport.is_active()
            and self.thread
            and self.thread.is_alive()
        )

    def close(self):
        if self.server:
            self.server.stop_event.set()
            self.server.shutdown()
            self.server.server_close()
        if self.client:
            self.client.close()
        self.server = None
        self.client = None
        self.thread = None


class VmosAdbManager:
    def __init__(self, config: dict, adb_path: str | Path):
        self.config = config
        self.settings = dict(config.get("vmos") or {})
        self.adb_path = str(Path(adb_path).resolve())
        self.local_port = int(self.settings.get("local_port", 60733))
        self.serial = f"localhost:{self.local_port}"
        self.expire_minutes = int(
            self.settings.get("expire_minutes", 10080)
        )
        self.refresh_margin = int(
            self.settings.get("refresh_margin_seconds", 3600)
        )
        self.connect_timeout = max(
            10.0, float(self.settings.get("connect_timeout_seconds", 20))
        )
        self.connect_retry_seconds = max(
            0.5, float(self.settings.get("connect_retry_seconds", 2))
        )
        self.tunnel_retry_count = max(
            1, int(self.settings.get("tunnel_retry_count", 3))
        )
        self.tunnel_retry_seconds = max(
            0.5, float(self.settings.get("tunnel_retry_seconds", 2))
        )
        self.tunnel: ParamikoTunnel | None = None
        self.lease: VmosLease | None = None
        self.lock = threading.RLock()

    @property
    def enabled(self) -> bool:
        return bool(self.settings.get("enabled"))

    def _secret(self, env_name: str, config_name: str) -> str:
        return str(
            os.getenv(env_name)
            or self.settings.get(config_name)
            or ""
        ).strip()

    def _api_client(self) -> VmosApiClient | None:
        if str(self.settings.get("auth_mode", "api")).lower() == "manual":
            return None
        access_key = self._secret("VMOS_ACCESS_KEY", "access_key")
        secret_key = self._secret("VMOS_SECRET_KEY", "secret_key")
        if not access_key or not secret_key:
            return None
        return VmosApiClient(
            access_key,
            secret_key,
            api_root=str(
                self.settings.get("api_root") or VMOS_API_ROOT
            ),
            ca_bundle=str(
                os.getenv("VMOS_CA_BUNDLE")
                or self.settings.get("ca_bundle")
                or ""
            ),
        )

    def _acquire_lease(self) -> VmosLease:
        api = self._api_client()
        pad_code = str(
            os.getenv("VMOS_PAD_CODE")
            or self.settings.get("pad_code")
            or ""
        ).strip()
        if api and pad_code:
            return api.get_adb_lease(pad_code, self.expire_minutes)
        if str(self.settings.get("auth_mode", "api")).lower() != "manual":
            raise VmosCloudError(
                "Thiếu VMOS Access Key, Secret Key hoặc Pad Code cho chế độ OpenAPI"
            )

        command = self._secret("VMOS_SSH_COMMAND", "ssh_command")
        key = self._secret("VMOS_SSH_KEY", "ssh_key")
        adb = str(
            os.getenv("VMOS_ADB_COMMAND")
            or self.settings.get("adb_command")
            or f"adb connect {self.serial}"
        ).strip()
        if not command or not key:
            raise VmosCloudError(
                "Thiếu VMOS OpenAPI AK/SK + padCode hoặc SSH command + connection key"
            )
        return VmosLease(
            command=command,
            key=key,
            adb=adb,
            expire_time=time.time() + 86400,
        )

    def _adb(self, *args: str, timeout: float = 20):
        return subprocess.run(
            [self.adb_path, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )

    def _adb_online(self) -> bool:
        result = self._adb("-s", self.serial, "get-state", timeout=8)
        return result.returncode == 0 and result.stdout.strip() == "device"

    def _connect_adb(self):
        deadline = time.monotonic() + self.connect_timeout
        last_detail = ""
        while time.monotonic() < deadline:
            # ADB can retain an offline transport and still answer
            # "already connected". Drop it on every attempt so get-state
            # reflects the current SSH tunnel.
            self._adb("disconnect", self.serial, timeout=8)
            result = self._adb("connect", self.serial, timeout=15)
            last_detail = (
                result.stderr or result.stdout or last_detail
            ).strip()
            if self._adb_online():
                return
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.connect_retry_seconds, remaining))
        detail = f" ({last_detail})" if last_detail else ""
        raise VmosCloudError(
            "ADB VMOS chưa online sau "
            f"{self.connect_timeout:g} giây tự kết nối lại"
            + detail
        )

    def _replace_tunnel(self, lease: VmosLease):
        if self.tunnel:
            self.tunnel.close()
            self.tunnel = None
        forward = parse_ssh_forward(lease.command)
        tunnel = ParamikoTunnel(forward, lease.key, self.local_port)
        tunnel.start()
        try:
            self._connect_adb()
        except Exception:
            tunnel.close()
            raise
        self.tunnel = tunnel
        self.lease = lease

    def _open_fresh_tunnel(self):
        last_error: Exception | None = None
        for attempt in range(self.tunnel_retry_count):
            try:
                self._replace_tunnel(self._acquire_lease())
                return
            except Exception as error:
                last_error = error
                if attempt + 1 < self.tunnel_retry_count:
                    time.sleep(self.tunnel_retry_seconds)
        assert last_error is not None
        raise last_error

    def start(self) -> str:
        if not self.enabled:
            return ""
        with self.lock:
            self._open_fresh_tunnel()
            self.config["adb_path"] = self.adb_path
            devices = self.config.get("devices") or [{"serial": self.serial}]
            normalized = []
            for item in devices:
                value = {"serial": str(item)} if not isinstance(item, dict) else dict(item)
                value["serial"] = self.serial
                normalized.append(value)
            self.config["devices"] = normalized
            return self.serial

    def ensure_connected(self) -> str:
        if not self.enabled:
            return ""
        with self.lock:
            needs_refresh = (
                not self.lease
                or self.lease.expire_time - time.time() <= self.refresh_margin
            )
            if needs_refresh and self._api_client():
                self._open_fresh_tunnel()
            elif (
                not self.tunnel
                or not self.tunnel.is_alive()
                or not self._adb_online()
            ):
                try:
                    if self.lease and self.lease.expire_time > time.time():
                        self._replace_tunnel(self.lease)
                    elif self._api_client():
                        self._open_fresh_tunnel()
                    else:
                        raise VmosCloudError(
                            "ADB VMOS 24 giờ đã hết hạn. "
                            "Hãy cập nhật SSH command/key."
                        )
                except Exception:
                    if self._api_client():
                        self._open_fresh_tunnel()
                    else:
                        raise
            return self.serial

    def close(self):
        with self.lock:
            self._adb("disconnect", self.serial, timeout=8)
            if self.tunnel:
                self.tunnel.close()
            self.tunnel = None
