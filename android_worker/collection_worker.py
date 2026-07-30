from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets

from android_worker.affiliate import (
    AFFILIATE_MARKERS,
    fetch_public_products_url,
    product_identity,
)
from android_worker.mobile_studio_api import (
    MobileStudioApi,
    normalize_product_url,
)
from android_worker.vmos_cloud import VmosAdbManager


for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


@dataclass
class CollectionSlot:
    serial: str
    collection_url: str
    client: MobileStudioApi
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class CollectionApiWorker:
    def __init__(
        self,
        config: dict[str, Any],
        vmos_manager: VmosAdbManager | None = None,
    ):
        self.config = config
        self.server_url = os.getenv(
            "WORKER_SERVER_URL", config.get("server_url", "ws://localhost:3002")
        )
        self.token = os.getenv(
            "WORKER_AUTH_TOKEN",
            config.get("worker_auth_token", "default-worker-token"),
        )
        self.poll_seconds = float(config.get("affiliate_poll_seconds", 1))
        self.poll_timeout = float(config.get("affiliate_poll_timeout", 90))
        self.cleanup_verify_timeout = float(
            config.get("cleanup_verify_timeout", 45)
        )
        # A result is returned before cleanup finishes. The next relay job may
        # therefore already be waiting on this slot while the previous job is
        # restoring/verifying the collection.
        self.slot_acquire_timeout = float(
            config.get("slot_acquire_timeout", 180)
        )
        self.oauth_refresh_seconds = max(
            60.0, float(config.get("oauth_refresh_seconds", 3000))
        )
        self.oauth_refresh_retry_seconds = max(
            30.0, float(config.get("oauth_refresh_retry_seconds", 300))
        )
        self.oauth_refresh_wait_seconds = max(
            5.0, float(config.get("oauth_refresh_wait_seconds", 30))
        )
        self.slots: list[CollectionSlot] = []
        self.ws = None
        self.vmos_manager = vmos_manager

    def log(self, message: str):
        print(
            f"[CollectionAPI {time.strftime('%H:%M:%S')}] {message}",
            flush=True,
        )

    async def send(self, payload: dict[str, Any]):
        if self.ws:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))

    async def log_remote(self, message: str):
        self.log(message)
        try:
            await self.send({"type": "log", "message": message})
        except Exception:
            pass

    def connect_devices(self):
        adb_path = self.config.get("adb_path")
        if not adb_path:
            raise ValueError("Thiếu adb_path của LDPlayer trong android-worker.json")
        if (self.config.get("vmos") or {}).get("enabled"):
            if self.vmos_manager is None:
                self.vmos_manager = VmosAdbManager(self.config, adb_path)
                serial = self.vmos_manager.start()
            else:
                serial = self.vmos_manager.ensure_connected()
            self.log(f"VMOS Cloud ADB đã sẵn sàng tại {serial}")
        device_output = subprocess.run(
            [str(adb_path), "devices"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
        online_serials = [
            line.split()[0]
            for line in device_output.stdout.splitlines()[1:]
            if len(line.split()) >= 2 and line.split()[1] == "device"
        ]
        template_path = Path(
            self.config.get(
                "mobile_api_template",
                Path(__file__).with_name("mobile-api-template.json"),
            )
        )
        pool_size = max(1, int(self.config.get("collection_pool_size", 5)))
        fallback_urls = [
            str(value).strip()
            for value in self.config.get("collection_urls", [])
            if str(value).strip()
        ][:pool_size]
        default_url = str(self.config.get("collection_url", "")).strip()

        configured_devices = self.config.get("devices", [])
        seen_collections: set[str] = set()
        for index, item in enumerate(configured_devices):
            if not isinstance(item, dict):
                item = {"serial": str(item)}
            configured_serial = str(item.get("serial", "auto")).strip()
            serial = configured_serial
            if configured_serial == "auto" or configured_serial not in online_serials:
                if index < len(online_serials):
                    serial = online_serials[index]
                elif len(online_serials) == 1:
                    serial = online_serials[0]
            if serial != configured_serial:
                self.log(f"Tự nhận LDPlayer {configured_serial} → {serial}")
            item_urls = [
                str(value).strip()
                for value in item.get("collection_urls", [])
                if str(value).strip()
            ][:pool_size]
            item_url = str(item.get("collection_url", "")).strip()
            if item_url and item_url not in item_urls:
                item_urls.append(item_url)
            if not item_urls:
                if len(configured_devices) == 1:
                    item_urls = list(fallback_urls)
                elif index < len(fallback_urls):
                    item_urls = [fallback_urls[index]]
            if not item_urls and index == 0 and default_url:
                item_urls = [default_url]
            if not item_urls:
                raise ValueError(f"Thiếu collection_url cho LDPlayer {serial}")

            self.log(f"Nạp LDPlayer {serial} và phiên YouTube Studio đã lưu...")
            added = 0
            for collection_url in item_urls:
                if collection_url in seen_collections:
                    continue
                client = MobileStudioApi(
                    adb_path=adb_path,
                    serial=serial,
                    collection=collection_url,
                    template_path=template_path,
                    timeout=float(self.config.get("api_timeout", 30)),
                )
                self.slots.append(
                    CollectionSlot(serial, collection_url, client)
                )
                seen_collections.add(collection_url)
                added += 1
            # Skip a separate login probe. The first real API request uses the
            # OAuth session saved by Studio and refreshes it only if rejected.
            self.log(
                f"{serial}: sẵn sàng dùng phiên đã lưu cho {added} collection"
            )

        if not self.slots:
            raise RuntimeError("Chưa cấu hình LDPlayer nào")

    @property
    def current_urls(self) -> list[str]:
        return [slot.collection_url for slot in self.slots]

    async def acquire(self, target_url: str, timeout: float = 60) -> CollectionSlot:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for slot in self.slots:
                if slot.collection_url == target_url and not slot.lock.locked():
                    await slot.lock.acquire()
                    return slot
            await asyncio.sleep(0.2)
        raise RuntimeError("Collection đang bận, vui lòng thử lại")

    async def poll_affiliate(
        self, slot: CollectionSlot, product_url: str
    ) -> str:
        identity = product_identity(product_url)
        end = time.monotonic() + self.poll_timeout
        while time.monotonic() < end:
            products = await asyncio.to_thread(
                fetch_public_products_url, slot.collection_url
            )
            affiliate_url = products.get(identity)
            if affiliate_url and any(
                marker in affiliate_url.lower() for marker in AFFILIATE_MARKERS
            ):
                return affiliate_url
            await asyncio.sleep(self.poll_seconds)
        raise RuntimeError(
            "Đã publish đúng offer nhưng chưa thấy affiliate link trên collection công khai"
        )

    @staticmethod
    def _offer_ids(products: dict[str, str]) -> set[str]:
        offer_ids = set()
        for identity in products:
            if identity.startswith(("shopee:", "lazada:")):
                offer_id = identity.rsplit(":", 1)[-1]
                if offer_id:
                    offer_ids.add(offer_id)
        return offer_ids

    async def verify_clean_baseline(self, slot: CollectionSlot):
        expected = set(slot.client.baseline_offer_ids())
        end = time.monotonic() + self.cleanup_verify_timeout
        last_extras: set[str] = set()
        while time.monotonic() < end:
            products = await asyncio.to_thread(
                fetch_public_products_url, slot.collection_url
            )
            last_extras = self._offer_ids(products) - expected
            if not last_extras:
                return
            await asyncio.sleep(self.poll_seconds)
        raise RuntimeError(
            "Collection còn sản phẩm tạm sau khi restore baseline: "
            + ", ".join(sorted(last_extras))
        )

    async def restore_slot_baseline(self, slot: CollectionSlot):
        await asyncio.to_thread(slot.client.restore_baseline)
        await self.verify_clean_baseline(slot)

    async def restore_all_baselines(self):
        if not self.slots:
            return
        self.log("Đang khôi phục baseline cho toàn bộ collection...")
        # Submit the five small update requests first, then verify propagation
        # concurrently so startup costs one propagation window instead of five.
        for slot in self.slots:
            await asyncio.to_thread(slot.client.restore_baseline)
        await asyncio.gather(
            *(self.verify_clean_baseline(slot) for slot in self.slots)
        )
        self.log("Toàn bộ collection đã sạch và sẵn sàng nhận request")

    async def execute_job(self, message: dict[str, Any], early_result=None) -> dict[str, Any]:
        job_id = str(message["jobId"])
        target_url = str(message["targetUrl"])
        product_url = await asyncio.to_thread(
            normalize_product_url,
            str(message["productUrl"]),
            float(self.config.get("api_timeout", 30)),
        )
        started_at = time.monotonic()
        slot = await self.acquire(target_url, self.slot_acquire_timeout)
        published = False
        result_sent = False
        affiliate_url = None
        try:
            if self.vmos_manager is not None:
                await asyncio.to_thread(
                    self.vmos_manager.ensure_connected
                )
            await self.restore_slot_baseline(slot)
            await self.log_remote(
                f"{job_id}: tìm chính xác offer bằng URL trên {slot.serial}"
            )
            product = await asyncio.to_thread(
                slot.client.search_product, product_url
            )
            await self.log_remote(
                f"{job_id}: đã match chính xác offer ID {product.offer_id}"
            )
            if product.offer_id in slot.client.baseline_offer_ids():
                await self.log_remote(
                    f"{job_id}: offer đã có sẵn trong baseline collection"
                )
            else:
                await asyncio.to_thread(slot.client.publish_with_product, product)
                published = True
            affiliate_url = await self.poll_affiliate(slot, product_url)
        except Exception as error:
            return_payload = {
                "success": False,
                "error": str(error),
                "errorCode": "COLLECTION_API_ERROR",
                "errorStage": "mobile-api",
                "retryable": True,
                "browserFallbackAllowed": True,
            }
        else:
            return_payload = {
                "success": True,
                "affiliateUrl": affiliate_url,
                "metadata": {
                    **product.metadata,
                    "deviceSerial": slot.serial,
                    "collectionUrl": slot.collection_url,
                    "offerMatch": "exact-id",
                    "browserUsed": False,
                    "sessionSource": (
                        "vmos-cloud"
                        if self.vmos_manager is not None
                        else "local-android"
                    ),
                    "affiliateReadySeconds": round(
                        time.monotonic() - started_at, 3
                    ),
                    "cleanupPending": published,
                },
            }
            if early_result is not None:
                await early_result(return_payload)
                result_sent = True
        finally:
            cleanup_error = None
            if published:
                try:
                    await self.restore_slot_baseline(slot)
                except Exception as error:
                    cleanup_error = error
            slot.lock.release()

            if cleanup_error:
                if result_sent:
                    await self.log_remote(
                        f"{job_id}: đã trả affiliate nhưng cleanup nền lỗi: "
                        f"{cleanup_error}"
                    )
                else:
                    return_payload = {
                        "success": False,
                        "error": (
                            "Đã lấy được link nhưng chưa restore collection: "
                            f"{cleanup_error}"
                        ),
                        "errorCode": "COLLECTION_CLEANUP_ERROR",
                        "errorStage": "cleanup",
                        "retryable": True,
                        "cleanupSucceeded": False,
                        "cleanupError": str(cleanup_error),
                    }
            elif published:
                return_payload.setdefault("metadata", {})[
                    "cleanupSucceeded"
                ] = True
                return_payload["metadata"]["cleanupPending"] = False
        return return_payload

    async def register(self):
        await self.send(
            {
                "type": "register",
                "workerType": "android-api",
                "urls": self.current_urls,
                "hostname": socket.gethostname(),
                "devices": [slot.serial for slot in self.slots],
                "capabilities": [
                    "local-video-pool",
                    "mobile-shopping-protobuf",
                    "exact-offer-id",
                    "collection-affiliate",
                    "no-browser",
                    "cleanup",
                ],
            }
        )

    async def handle_job(self, message: dict[str, Any]):
        job_id = message.get("jobId", "unknown")
        sent = False

        async def send_result(payload):
            nonlocal sent
            if sent:
                return
            await self.send({"type": "job-result", "jobId": job_id, **payload})
            sent = True

        try:
            result = await self.execute_job(message, early_result=send_result)
        except Exception as error:
            result = {
                "success": False,
                "error": str(error),
                "errorCode": "COLLECTION_WORKER_ERROR",
                "errorStage": "worker",
            }
        if not sent:
            await send_result(result)

    async def run_connection(self):
        ws_url = f"{self.server_url.rstrip('/')}/ws/worker?token={self.token}"
        async with websockets.connect(
            ws_url, ping_interval=20, ping_timeout=20
        ) as ws:
            self.ws = ws
            await self.register()
            self.log(f"Đã kết nối relay {self.server_url}")
            async for raw in ws:
                message = json.loads(raw)
                if message.get("type") == "execute-job":
                    asyncio.create_task(self.handle_job(message))
                elif message.get("type") == "heartbeat-ack":
                    pass

    async def refresh_oauth_sessions(self):
        clients = {}
        for slot in self.slots:
            clients.setdefault(slot.serial, slot.client)
        next_refresh = {
            serial: time.monotonic() + self.oauth_refresh_seconds
            for serial in clients
        }
        while True:
            now = time.monotonic()
            due_at = min(next_refresh.values())
            await asyncio.sleep(max(1.0, due_at - now))
            now = time.monotonic()
            for serial, client in clients.items():
                if next_refresh[serial] > now:
                    continue
                try:
                    refreshed = await asyncio.to_thread(
                        client.refresh_credentials_proactively,
                        self.oauth_refresh_wait_seconds,
                    )
                except Exception as error:
                    refreshed = False
                    self.log(
                        f"{serial}: refresh OAuth nền chưa thành công: {error}"
                    )
                if refreshed:
                    self.log(
                        f"{serial}: đã cấp access token mới và chia sẻ cho pool"
                    )
                    delay = self.oauth_refresh_seconds
                else:
                    self.log(
                        f"{serial}: token chưa đổi, giữ token hiện tại và thử lại sau"
                    )
                    delay = self.oauth_refresh_retry_seconds
                next_refresh[serial] = time.monotonic() + delay

    async def run(self):
        self.connect_devices()
        await self.restore_all_baselines()
        refresh_task = asyncio.create_task(self.refresh_oauth_sessions())
        try:
            delay = 1
            while True:
                try:
                    await self.run_connection()
                    delay = 1
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.log(
                        f"Mất kết nối relay: {error}; thử lại sau {delay}s"
                    )
                    self.ws = None
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 30)
        finally:
            refresh_task.cancel()
            await asyncio.gather(refresh_task, return_exceptions=True)
