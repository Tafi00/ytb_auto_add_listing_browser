from __future__ import annotations

import base64
import json
import random
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from android_worker.protobuf_wire import (
    WireField,
    iter_length_fields,
    nested_length_values,
    parse_message,
    replace_bytes_at_path,
    serialize_message,
)


STUDIO_PACKAGE = "com.google.android.apps.youtube.creator"
SHOPPING_API_ROOT = "https://youtubei.googleapis.com/youtubei/v1/monetization"
TOKEN_SQL = (
    "SELECT a.authtoken, COALESCE(("
    "SELECT e.value FROM extras e "
    "WHERE e.accounts_id=a.accounts_id AND e.key='GoogleUserId' LIMIT 1"
    "), '') FROM authtokens a "
    "WHERE a.authtoken IS NOT NULL "
    "AND a.type LIKE 'com.google.android.apps.youtube.creator:%oauth2:%' "
    "AND a.type LIKE '%youtube.force-ssl%' "
    "ORDER BY a._id DESC;"
)
COLLECTION_RE = re.compile(r"/shopcollection/([A-Za-z0-9_-]+)")
SHOPEE_LISTING_RE = re.compile(
    r"/(?:product|opaanlp)/(\d+)/(\d+)|-i\.(\d+)\.(\d+)",
    re.I,
)
LAZADA_PRODUCT_RE = re.compile(r"-i(\d+)-s(\d+)\.html", re.I)
SHOPEE_SHORT_HOSTS = ("s.shopee.vn", "shp.ee", "vn.shp.ee")


class StudioLoginError(RuntimeError):
    pass


class StudioApiError(RuntimeError):
    pass


class _AuthRejected(RuntimeError):
    pass


@dataclass(frozen=True)
class ProductRecord:
    offer_id: str
    protobuf: bytes
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class OAuthCredential:
    token: str
    google_user_id: str = ""


_TOKEN_CACHE_LOCK = threading.RLock()
_TOKEN_CACHE: dict[
    tuple[str, str], tuple[float, tuple[OAuthCredential, ...]]
] = {}
_TOKEN_REFRESH_LOCKS: dict[tuple[str, str], threading.RLock] = {}


def _device_refresh_lock(key: tuple[str, str]) -> threading.RLock:
    with _TOKEN_CACHE_LOCK:
        return _TOKEN_REFRESH_LOCKS.setdefault(key, threading.RLock())


def extract_collection_id(value: str) -> str:
    match = COLLECTION_RE.search(value)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", value.strip()):
        return value.strip()
    raise ValueError(f"Collection URL/ID không hợp lệ: {value}")


def extract_shopee_offer_id(url: str) -> str:
    match = SHOPEE_LISTING_RE.search(url)
    if not match:
        raise ValueError(
            "API collection chỉ hỗ trợ link sản phẩm Shopee hợp lệ"
        )
    return match.group(2) or match.group(4)


def normalize_product_url(url: str, timeout: float = 20) -> str:
    """Resolve marketplace short links and remove disposable tracking data."""
    value = str(url or "").strip()
    try:
        parsed = urlsplit(value)
    except ValueError:
        return value
    host = (parsed.hostname or "").lower()
    if any(host == item or host.endswith("." + item) for item in SHOPEE_SHORT_HOSTS):
        request = Request(
            value,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
                ),
                "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                value = response.geturl()
        except (HTTPError, URLError, TimeoutError) as error:
            raise ValueError(
                "Không thể mở link rút gọn Shopee để lấy sản phẩm gốc"
            ) from error

    match = SHOPEE_LISTING_RE.search(value)
    try:
        resolved_host = (urlsplit(value).hostname or "").lower()
    except ValueError:
        resolved_host = ""
    if match and (
        resolved_host == "shopee.vn"
        or resolved_host.endswith(".shopee.vn")
    ):
        shop_id = match.group(1) or match.group(3)
        offer_id = match.group(2) or match.group(4)
        return f"https://shopee.vn/product/{shop_id}/{offer_id}"
    return value


def extract_product_catalog_id(url: str) -> str:
    """Return the exact ID stored in YouTube's selected-product protobuf.

    Shopee stores the offer ID in field 2. Lazada stores the seller SKU ID in
    that same field; the Lazada item ID is not returned by the Studio API.
    """
    shopee = SHOPEE_LISTING_RE.search(url)
    if shopee:
        return shopee.group(2) or shopee.group(4)
    lazada = LAZADA_PRODUCT_RE.search(url)
    if lazada:
        return lazada.group(2)
    raise ValueError(
        "API collection chỉ hỗ trợ URL sản phẩm Shopee "
        "hoặc Lazada ...-iITEM-sSKU.html"
    )


class AdbStudioSession:
    def __init__(self, adb_path: str | Path, serial: str):
        self.adb_path = str(Path(adb_path).resolve())
        self.serial = serial

    def _run(self, *args: str, timeout: float = 20) -> str:
        completed = subprocess.run(
            [self.adb_path, "-s", self.serial, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        if completed.returncode:
            detail = (completed.stderr or completed.stdout).strip()
            raise RuntimeError(detail or f"ADB lỗi ({completed.returncode})")
        return completed.stdout

    def _run_bytes(self, *args: str, timeout: float = 20) -> bytes:
        completed = subprocess.run(
            [self.adb_path, "-s", self.serial, *args],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if completed.returncode:
            detail = (completed.stderr or completed.stdout).decode(
                "utf-8", errors="replace"
            ).strip()
            raise RuntimeError(detail or f"ADB lỗi ({completed.returncode})")
        return completed.stdout

    def _root_identity(self) -> str:
        for args in (
            ("shell", "id"),
            ("shell", "su", "-c", "id"),
            ("shell", "vu", "-c", "id"),
        ):
            try:
                identity = self._run(*args).strip()
            except RuntimeError:
                continue
            if "uid=0(" in identity:
                return identity
        return ""

    def validate(self):
        state = self._run("get-state").strip()
        if state != "device":
            raise RuntimeError(f"LDPlayer {self.serial} chưa online (state={state or 'unknown'})")
        if not self._root_identity():
            raise RuntimeError(f"LDPlayer {self.serial} chưa bật quyền root")
        package = self._run(
            "shell", "pm", "path", STUDIO_PACKAGE
        ).strip()
        if not package.startswith("package:"):
            raise RuntimeError("LDPlayer chưa cài YouTube Studio")

    def _legacy_remote_oauth_credentials(self) -> list[OAuthCredential]:
        # Passing SQL as one subprocess argument keeps the token out of shell quoting
        # and avoids copying the Android accounts database to Windows.
        output = self._run(
            "shell",
            "su",
            "0",
            "sqlite3",
            "/data/system_ce/0/accounts_ce.db",
            f'"{TOKEN_SQL}"',
        )
        credentials = []
        for value in output.splitlines():
            token, _, google_user_id = value.strip().partition("|")
            credential = OAuthCredential(token, google_user_id)
            if token and credential not in credentials:
                credentials.append(credential)
        if not credentials:
            raise StudioLoginError(
                "YouTube Studio chưa đăng nhập hoặc chưa cấp OAuth. "
                "Hãy mở Studio trong LDPlayer và đăng nhập một lần."
            )
        return credentials

    @staticmethod
    def _parse_oauth_rows(rows) -> list[OAuthCredential]:
        credentials = []
        for token, google_user_id in rows:
            credential = OAuthCredential(
                str(token or ""), str(google_user_id or "")
            )
            if credential.token and credential not in credentials:
                credentials.append(credential)
        return credentials

    def _remote_sqlite_credentials(self) -> list[OAuthCredential]:
        try:
            sqlite_path = self._run("shell", "which", "sqlite3").strip()
        except RuntimeError:
            return []
        if not sqlite_path:
            return []
        try:
            return self._legacy_remote_oauth_credentials()
        except RuntimeError:
            return []

    def _local_sqlite_credentials(self) -> list[OAuthCredential]:
        # VMOS images do not include sqlite3. Copy the root-readable Android
        # account database to a private temporary directory, query it locally,
        # then remove it immediately.
        temp_dir = Path(tempfile.mkdtemp(prefix="yt-studio-session-"))
        db_path = temp_dir / "accounts_ce.db"
        try:
            for suffix in ("", "-wal", "-shm"):
                remote = f"/data/system_ce/0/accounts_ce.db{suffix}"
                try:
                    payload = self._run_bytes(
                        "exec-out", "cat", remote, timeout=30
                    )
                except RuntimeError:
                    if not suffix:
                        raise
                    continue
                if payload:
                    (temp_dir / f"accounts_ce.db{suffix}").write_bytes(
                        payload
                    )
            connection = sqlite3.connect(str(db_path))
            try:
                rows = connection.execute(TOKEN_SQL).fetchall()
            finally:
                connection.close()
            return self._parse_oauth_rows(rows)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def oauth_credentials(self) -> list[OAuthCredential]:
        credentials = self._remote_sqlite_credentials()
        if not credentials:
            credentials = self._local_sqlite_credentials()
        if not credentials:
            raise StudioLoginError(
                "YouTube Studio chưa đăng nhập hoặc chưa cấp OAuth. "
                "Hãy mở Studio trên thiết bị Android và đăng nhập một lần."
            )
        return credentials

    def wake_studio(self, wait_seconds: float = 3):
        self._run(
            "shell", "monkey", "-p", STUDIO_PACKAGE, "1", timeout=30
        )
        if wait_seconds > 0:
            time.sleep(wait_seconds)

    @staticmethod
    def _node_center(node: ET.Element) -> tuple[int, int] | None:
        match = re.fullmatch(
            r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",
            node.attrib.get("bounds", ""),
        )
        if not match:
            return None
        left, top, right, bottom = map(int, match.groups())
        return ((left + right) // 2, (top + bottom) // 2)

    def _ui_nodes(self) -> list[ET.Element]:
        remote = "/sdcard/yt_worker_window.xml"
        self._run("shell", "uiautomator", "dump", remote, timeout=20)
        xml = self._run("shell", "cat", remote, timeout=20)
        return list(ET.fromstring(xml).iter("node"))

    @staticmethod
    def _node_label(node: ET.Element) -> str:
        return " ".join(
            value for value in (
                node.attrib.get("text", ""),
                node.attrib.get("content-desc", ""),
            ) if value
        ).strip().casefold()

    def _tap_label(self, aliases: tuple[str, ...]) -> bool:
        return self._tap_nodes(self._ui_nodes(), aliases)

    def _tap_nodes(
        self, nodes: list[ET.Element], aliases: tuple[str, ...]
    ) -> bool:
        aliases = tuple(value.casefold() for value in aliases)
        for node in nodes:
            label = self._node_label(node)
            if not label or not any(
                label == alias or alias in label for alias in aliases
            ):
                continue
            center = self._node_center(node)
            if center:
                self._run(
                    "shell", "input", "tap",
                    str(center[0]), str(center[1]),
                )
                time.sleep(2)
                return True
        return False

    def _open_collections_screen(self):
        # Start from a fresh process so the heap contains the current account's
        # collections, not stale IDs from a previous Studio navigation session.
        self._run("shell", "am", "force-stop", STUDIO_PACKAGE)
        self.wake_studio()
        size_output = self._run("shell", "wm", "size")
        size_match = re.search(r"(\d+)x(\d+)", size_output)
        width, height = (
            (int(size_match.group(1)), int(size_match.group(2)))
            if size_match else (1080, 1920)
        )

        def point(x: int, y: int) -> tuple[str, str]:
            return (
                str(round(x * width / 1080)),
                str(round(y * height / 1920)),
            )

        # Studio's Compose screen exposes only the bottom navigation to
        # uiautomator. Use resolution-scaled positions for this one-time
        # account discovery path: Earn -> Shopping -> Collections.
        self._run("shell", "input", "tap", *point(970, 1840))
        time.sleep(2)
        self._run("shell", "input", "tap", *point(350, 1100))
        time.sleep(2)
        self._run(
            "shell", "input", "swipe",
            *point(540, 1650), *point(540, 450), "500",
        )
        time.sleep(2)
        self._run("shell", "input", "tap", *point(350, 1700))
        time.sleep(3)
        labels = [self._node_label(node) for node in self._ui_nodes()]
        if any(
            "create collection" in label
            or "tạo bộ sưu tập" in label
            for label in labels
        ):
            return
        raise RuntimeError(
            "Không tự mở được màn hình Collections trong YouTube Studio"
        )

    def discover_collection_ids(self) -> list[str]:
        self.validate()
        self._open_collections_screen()
        heap_path = "/sdcard/yt_worker_collections.hprof"
        self._run("shell", "rm", "-f", heap_path)
        output = ""
        try:
            self._run(
                "shell", "am", "dumpheap", STUDIO_PACKAGE, heap_path,
                timeout=60,
            )
            previous_size = -1
            stable_reads = 0
            for _ in range(30):
                output = self._run(
                    "shell", "stat", "-c", "%s", heap_path, timeout=10
                ).strip()
                size = int(output) if output.isdigit() else 0
                if size > 0 and size == previous_size:
                    stable_reads += 1
                    if stable_reads >= 2:
                        break
                else:
                    stable_reads = 0
                previous_size = size
                time.sleep(0.5)
            output = self._run(
                "shell", "grep", "-aoE",
                r"SCUC[A-Za-z0-9_-]{33}",
                heap_path,
                timeout=60,
            )
        finally:
            try:
                self._run("shell", "rm", "-f", heap_path)
            except Exception:
                pass
        collection_ids = sorted(set(re.findall(
            r"SCUC[A-Za-z0-9_-]{33}", output
        )))
        if not collection_ids:
            raise RuntimeError(
                "Studio không trả về collection nào cho tài khoản đang đăng nhập"
            )
        return collection_ids


class MobileStudioApi:
    def __init__(
        self,
        adb_path: str | Path,
        serial: str,
        collection: str,
        template_path: str | Path,
        timeout: float = 30,
    ):
        self.session = AdbStudioSession(adb_path, serial)
        self.collection_id = extract_collection_id(collection)
        self.template_path = Path(template_path)
        self.timeout = timeout
        self.credentials: list[OAuthCredential] = []
        self.token_index = 0
        self.tokens_loaded_at = 0.0

        template = json.loads(self.template_path.read_text(encoding="utf-8"))
        self.headers = {
            str(key): str(value) for key, value in template["headers"].items()
        }
        self.search_template = base64.b64decode(template["search_body_base64"])
        self.baseline_update_template = base64.b64decode(
            template["baseline_update_body_base64"]
        )

    def check_login(self):
        self.session.validate()
        self._reload_tokens()
        # A harmless exact collection search verifies both OAuth and collection access.
        body = replace_bytes_at_path(
            self.search_template, (17, 4, 1, 4), self.collection_id.encode()
        )
        self._post("get_shopping_settings", body)

    @property
    def _token_cache_key(self) -> tuple[str, str]:
        return (self.session.adb_path, self.session.serial)

    @staticmethod
    def _token_values(
        credentials: list[OAuthCredential] | tuple[OAuthCredential, ...],
    ) -> tuple[str, ...]:
        return tuple(item.token for item in credentials)

    def _publish_tokens(self, credentials: list[OAuthCredential]):
        loaded_at = time.monotonic()
        with _TOKEN_CACHE_LOCK:
            _TOKEN_CACHE[self._token_cache_key] = (
                loaded_at, tuple(credentials)
            )
        self.credentials = list(credentials)
        self.tokens_loaded_at = loaded_at
        self.token_index = 0

    def _sync_cached_tokens(self):
        with _TOKEN_CACHE_LOCK:
            cached = _TOKEN_CACHE.get(self._token_cache_key)
        if cached and cached[0] > self.tokens_loaded_at:
            self.tokens_loaded_at = cached[0]
            self.credentials = list(cached[1])
            self.token_index = 0

    def _reload_tokens(self):
        self._sync_cached_tokens()
        if self.credentials:
            return
        with _TOKEN_CACHE_LOCK:
            self._sync_cached_tokens()
            if not self.credentials:
                self._publish_tokens(self.session.oauth_credentials())

    def _read_refreshed_tokens(
        self,
        previous: list[OAuthCredential],
        wait_seconds: float = 30,
    ) -> list[OAuthCredential]:
        previous_values = self._token_values(previous)
        self.session.wake_studio(wait_seconds=0)
        deadline = time.monotonic() + wait_seconds
        latest = list(previous)
        while True:
            try:
                latest = self.session.oauth_credentials()
            except (RuntimeError, StudioLoginError):
                latest = list(previous)
            if self._token_values(latest) != previous_values:
                return latest
            if time.monotonic() >= deadline:
                return latest
            time.sleep(2)

    def _post_candidates(
        self,
        endpoint: str,
        body: bytes,
        credentials: list[OAuthCredential],
    ) -> tuple[bytes, int]:
        last_error: Exception | None = None
        for index, credential in enumerate(credentials):
            headers = dict(self.headers)
            headers["Authorization"] = f"Bearer {credential.token}"
            body_variants = [body]
            if credential.google_user_id:
                try:
                    personalized_body = replace_bytes_at_path(
                        body,
                        (1, 3, 3),
                        credential.google_user_id.encode("utf-8"),
                    )
                    if personalized_body != body:
                        body_variants.append(personalized_body)
                except KeyError:
                    pass
            for request_body in body_variants:
                request = Request(
                    f"{SHOPPING_API_ROOT}/{endpoint}",
                    data=request_body,
                    headers=headers,
                    method="POST",
                )
                try:
                    with urlopen(request, timeout=self.timeout) as response:
                        return response.read(), index
                except HTTPError as error:
                    last_error = error
                    error.close()
                    if error.code not in (401, 403):
                        raise StudioApiError(
                            f"YouTube Shopping API trả HTTP {error.code}"
                        ) from error
                except (URLError, TimeoutError) as error:
                    raise StudioApiError(
                        f"Không kết nối được YouTube Shopping API: {error}"
                    ) from error
        raise _AuthRejected("OAuth token bị YouTube từ chối") from last_error

    def _validation_body(self) -> bytes:
        return replace_bytes_at_path(
            self.search_template,
            (17, 4, 1, 4),
            self.collection_id.encode(),
        )

    def refresh_credentials_proactively(
        self, wait_seconds: float = 30
    ) -> bool:
        self._reload_tokens()
        with _device_refresh_lock(self._token_cache_key):
            self._sync_cached_tokens()
            previous = list(self.credentials)
            candidates = self._read_refreshed_tokens(
                previous, wait_seconds=wait_seconds
            )
            if self._token_values(candidates) == self._token_values(previous):
                return False
            try:
                _, token_index = self._post_candidates(
                    "get_shopping_settings",
                    self._validation_body(),
                    candidates,
                )
            except (StudioApiError, _AuthRejected):
                return False
            self._publish_tokens(candidates)
            self.token_index = token_index
            return True

    def _post(self, endpoint: str, body: bytes) -> bytes:
        self._reload_tokens()
        self._sync_cached_tokens()
        try:
            payload, token_index = self._post_candidates(
                endpoint, body, self.credentials
            )
        except _AuthRejected:
            previous = list(self.credentials)
            with _device_refresh_lock(self._token_cache_key):
                self._sync_cached_tokens()
                if self._token_values(self.credentials) == self._token_values(
                    previous
                ):
                    candidates = self._read_refreshed_tokens(previous)
                    if self._token_values(candidates) != self._token_values(
                        previous
                    ):
                        retry_credentials = candidates
                        should_publish = True
                    else:
                        retry_credentials = list(self.credentials)
                        should_publish = False
                else:
                    retry_credentials = list(self.credentials)
                    should_publish = False
                try:
                    payload, token_index = self._post_candidates(
                        endpoint, body, retry_credentials
                    )
                except _AuthRejected as final_error:
                    raise StudioLoginError(
                        "Phiên YouTube Studio không thể cấp access token mới. "
                        "Hãy mở Studio trên Android và đăng nhập lại."
                    ) from final_error
                if should_publish:
                    self._publish_tokens(retry_credentials)
        self.token_index = token_index
        return payload

    def search_product(self, product_url: str) -> ProductRecord:
        product_url = normalize_product_url(product_url, timeout=self.timeout)
        offer_id = extract_product_catalog_id(product_url)
        body = replace_bytes_at_path(
            self.search_template, (17, 3, 1), product_url.encode("utf-8")
        )
        body = replace_bytes_at_path(
            body, (17, 4, 1, 4), self.collection_id.encode("utf-8")
        )
        response = self._post("get_shopping_settings", body)

        result_items = nested_length_values(
            response, (777, 1, 1, 3, 562, 2)
        )
        metadata_by_record: dict[bytes, dict[str, str]] = {}
        for item in result_items:
            metadata = self._record_metadata(item)
            for record in nested_length_values(item, (1001,)):
                metadata_by_record[record] = metadata

        exact = nested_length_values(
            response, (777, 1, 1, 3, 562, 2, 1001)
        )
        for record in exact:
            if self._record_offer_id(record) == offer_id:
                return ProductRecord(
                    offer_id,
                    self._prepare_selected_record(record),
                    metadata_by_record.get(record, {}),
                )

        # Schema fallback: only accept a direct product record with the exact
        # offer ID; never fall back to title or image similarity.
        candidates = []
        for path, _, raw in iter_length_fields(response):
            if path and path[-1] == 1001 and self._record_offer_id(raw) == offer_id:
                candidates.append(raw)
        unique = list(dict.fromkeys(candidates))
        if len(unique) == 1:
            return ProductRecord(
                offer_id,
                self._prepare_selected_record(unique[0]),
                metadata_by_record.get(unique[0], {}),
            )
        if not unique:
            raise StudioApiError(
                f"YouTube Shopping không trả đúng offer ID {offer_id} cho URL này"
            )
        raise StudioApiError(
            f"YouTube Shopping trả nhiều record cho offer ID {offer_id}; "
            "worker từ chối chọn mơ hồ"
        )

    @staticmethod
    def _record_metadata(item: bytes) -> dict[str, str]:
        """Read display fields from the exact YouTube Shopping result item."""

        def text_at(*path: int) -> str:
            try:
                values = nested_length_values(item, path)
            except Exception:
                return ""
            for value in values:
                try:
                    decoded = value.decode("utf-8").strip()
                except UnicodeDecodeError:
                    continue
                if decoded:
                    return decoded
            return ""

        metadata = {
            "title": text_at(2, 1880, 2, 1),
            "price": text_at(8, 22546, 6, 1),
            "image": text_at(2, 1880, 1, 1, 1),
            "seller": text_at(2, 1880, 3, 1),
        }
        return {key: value for key, value in metadata.items() if value}

    @staticmethod
    def _record_offer_id(record: bytes) -> str | None:
        try:
            values = nested_length_values(record, (2,))
        except Exception:
            return None
        if len(values) != 1:
            return None
        try:
            return values[0].decode("utf-8")
        except UnicodeDecodeError:
            return None

    @staticmethod
    def _prepare_selected_record(record: bytes) -> bytes:
        # Studio writes a fresh selection/event ID into field 14.1 before
        # publishing. It is not product identity; the exact offer remains field 2.
        selection_id = str(random.randint(10**18, 10**19 - 1)).encode()
        try:
            return replace_bytes_at_path(record, (14, 1), selection_id)
        except KeyError:
            fields = parse_message(record)
            fields.append(
                WireField(
                    14,
                    2,
                    serialize_message([WireField(1, 2, selection_id)]),
                )
            )
            return serialize_message(fields)

    def baseline_offer_ids(self) -> list[str]:
        records = nested_length_values(
            self.baseline_update_template, (17, 6, 1, 1)
        )
        return [
            offer for record in records
            if (offer := self._record_offer_id(record)) is not None
        ]

    def publish_with_product(self, product: ProductRecord):
        if product.offer_id in self.baseline_offer_ids():
            raise StudioApiError(
                f"Offer {product.offer_id} đã nằm trong baseline collection"
            )
        container_values = nested_length_values(
            self.baseline_update_template, (17, 6)
        )
        if len(container_values) != 1:
            raise StudioApiError("Template update không có product container hợp lệ")
        container = parse_message(container_values[0])
        wrapper = serialize_message([WireField(1, 2, product.protobuf)])
        container.append(WireField(1, 2, wrapper))
        body = replace_bytes_at_path(
            self.baseline_update_template,
            (17, 6),
            serialize_message(container),
        )
        body = replace_bytes_at_path(
            body, (17, 1), self.collection_id.encode("utf-8")
        )
        self._post("update_shopping_settings", body)

    def restore_baseline(self):
        body = replace_bytes_at_path(
            self.baseline_update_template,
            (17, 1),
            self.collection_id.encode("utf-8"),
        )
        self._post("update_shopping_settings", body)
