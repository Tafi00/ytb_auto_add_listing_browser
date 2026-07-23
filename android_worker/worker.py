from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets

from android_worker.affiliate import fetch_public_products, find_new_product, product_similarity
from android_worker.journal import JobJournal
from android_worker.youtube_studio import StudioAutomation, extract_video_id


for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


@dataclass
class DeviceSlot:
    serial: str
    automation: StudioAutomation
    allowed_video_ids: set[str] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def accepts(self, video_id: str) -> bool:
        return not self.allowed_video_ids or video_id in self.allowed_video_ids


class AndroidWorker:
    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.server_url = os.getenv("WORKER_SERVER_URL", config.get("server_url", "ws://localhost:3002"))
        self.token = os.getenv("WORKER_AUTH_TOKEN", config.get("worker_auth_token", "default-worker-token"))
        self.poll_seconds = float(config.get("affiliate_poll_seconds", 6))
        self.poll_timeout = float(config.get("affiliate_poll_timeout", 120))
        self.cleanup_verify_timeout = float(config.get("cleanup_verify_timeout", 90))
        self.journal = JobJournal(config.get("journal_dir", "data/android-jobs"))
        self.devices: list[DeviceSlot] = []
        self.current_urls: list[str] = [
            str(url).strip()
            for url in config.get("video_urls", [])
            if str(url).strip()
        ]
        self.video_locks: dict[str, asyncio.Lock] = {}
        self.ws = None

    def log(self, message: str):
        line = f"[AndroidWorker {time.strftime('%H:%M:%S')}] {message}"
        print(line, flush=True)

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
        if adb_path:
            os.environ["ADBUTILS_ADB_PATH"] = str(Path(adb_path).resolve())
        # Import only after ADBUTILS_ADB_PATH is set; adbutils resolves its adb
        # executable while importing on Windows.
        import uiautomator2 as u2
        artifacts = self.config.get("artifact_dir", "data/android-artifacts")
        for item in self.config.get("devices", []):
            serial = item["serial"] if isinstance(item, dict) else str(item)
            allowed = item.get("video_ids", []) if isinstance(item, dict) else []
            self.log(f"Kết nối LDPlayer {serial}...")
            device = u2.connect(serial)
            info = device.info
            self.log(f"Đã kết nối {serial}: {info.get('productName') or info.get('model', 'Android')}")
            automation = StudioAutomation(
                device=device,
                serial=serial,
                artifact_dir=artifacts,
                logger=self.log,
                ui_timeout=float(self.config.get("ui_timeout", 30)),
            )
            self.devices.append(DeviceSlot(serial, automation, set(allowed)))
        if not self.devices:
            raise RuntimeError("Chưa cấu hình LDPlayer nào trong devices")

    async def acquire_device(self, video_id: str, timeout: float = 60) -> DeviceSlot:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for device in self.devices:
                if device.accepts(video_id) and not device.lock.locked():
                    await device.lock.acquire()
                    return device
            await asyncio.sleep(0.25)
        raise RuntimeError(f"Không có LDPlayer rảnh cho video {video_id}")

    async def poll_new_affiliate(self, video_id: str, baseline: dict[str, str], product_url: str):
        end = time.monotonic() + self.poll_timeout
        last: dict[str, str] = {}
        while time.monotonic() < end:
            last = await asyncio.to_thread(fetch_public_products, video_id)
            result = find_new_product(baseline, last, product_url)
            if result:
                return result
            await asyncio.sleep(self.poll_seconds)
        raise RuntimeError(
            f"Hết thời gian chờ sản phẩm xuất hiện trên public shelf; đang thấy {len(last)} sản phẩm"
        )

    async def verify_removed(self, video_id: str, product_url: str):
        end = time.monotonic() + self.cleanup_verify_timeout
        while time.monotonic() < end:
            current = await asyncio.to_thread(fetch_public_products, video_id)
            if not any(product_similarity(url, product_url) >= 0.45 for url in current.values()):
                return
            await asyncio.sleep(self.poll_seconds)
        raise RuntimeError("Đã bấm gỡ nhưng public shelf vẫn còn sản phẩm")

    async def cleanup_with_retries(
        self,
        device: DeviceSlot,
        video_id: str,
        product_url: str,
        job_id: str,
        baseline_selected_count: int | None,
        attempts: int = 3,
    ):
        last_error = None
        for attempt in range(1, attempts + 1):
            try:
                await asyncio.to_thread(
                    device.automation.remove_product,
                    video_id,
                    product_url,
                    job_id,
                    baseline_selected_count,
                )
                await self.verify_removed(video_id, product_url)
                return
            except Exception as error:
                last_error = error
                self.log(
                    f"{job_id}: cleanup lần {attempt}/{attempts} lỗi: {error}"
                )
                if attempt < attempts:
                    await asyncio.sleep(2)
        raise RuntimeError(str(last_error or "Cleanup thất bại"))

    async def execute_job(self, message: dict[str, Any]) -> dict[str, Any]:
        job_id = str(message["jobId"])
        target_url = str(message["targetUrl"])
        product_url = str(message["productUrl"])
        video_id = extract_video_id(target_url)
        video_lock = self.video_locks.setdefault(video_id, asyncio.Lock())

        async with video_lock:
            device = await self.acquire_device(video_id)
            added = False
            new_identity = None
            baseline_selected_count = None
            try:
                self.journal.write(
                    job_id, "RECEIVED", target_url=target_url, product_url=product_url,
                    video_id=video_id, device_serial=device.serial,
                )
                await self.log_remote(f"{job_id}: snapshot video {video_id} trên {device.serial}")
                before = await asyncio.to_thread(fetch_public_products, video_id)
                self.journal.write(job_id, "ADDING", baseline=list(before))

                baseline_selected_count = await asyncio.to_thread(
                    device.automation.add_product, video_id, product_url, job_id,
                    lambda count: self.journal.write(
                        job_id, "CLEANUP_PENDING", baseline_selected_count=count
                    ),
                )
                added = True
                self.journal.write(job_id, "ADD_SAVED")

                result = await self.poll_new_affiliate(video_id, before, product_url)
                new_identity = result.identity
                self.journal.write(
                    job_id, "AFFILIATE_FOUND", affiliate_url=result.url,
                    product_identity=result.identity,
                )
                return_payload = {
                    "success": True,
                    "affiliateUrl": result.url,
                    "metadata": {"videoId": video_id, "deviceSerial": device.serial},
                }
            except Exception as error:
                added = added or device.automation.mutation_started
                device.automation.capture(job_id, "job-error")
                self.journal.write(
                    job_id,
                    "CLEANUP_PENDING" if added else "FAILED",
                    original_error=str(error),
                )
                return_payload = {"success": False, "error": str(error)}
            finally:
                if added:
                    self.journal.write(job_id, "CLEANUP_PENDING")
                    try:
                        await self.cleanup_with_retries(
                            device, video_id, product_url, job_id, baseline_selected_count
                        )
                        self.journal.write(job_id, "VERIFIED_CLEAN")
                    except Exception as cleanup_error:
                        device.automation.capture(job_id, "cleanup-error")
                        self.journal.write(job_id, "CLEANUP_PENDING", cleanup_error=str(cleanup_error))
                        return_payload = {
                            "success": False,
                            "error": f"Đã xử lý sản phẩm nhưng cleanup chưa hoàn tất: {cleanup_error}",
                        }
                device.lock.release()
            return return_payload

    async def recover_pending_cleanup(self):
        for item in self.journal.pending_cleanup():
            job_id = item.get("job_id")
            video_id = item.get("video_id")
            product_url = item.get("product_url")
            if not all((job_id, video_id, product_url)):
                continue
            try:
                device = await self.acquire_device(str(video_id), timeout=10)
            except Exception as error:
                self.log(f"Chưa thể phục hồi cleanup {job_id}: {error}")
                continue
            try:
                self.log(f"Phục hồi cleanup job {job_id} trên {device.serial}")
                await self.cleanup_with_retries(
                    device,
                    str(video_id),
                    str(product_url),
                    str(job_id),
                    item.get("baseline_selected_count"),
                )
                self.journal.write(str(job_id), "VERIFIED_CLEAN", recovered=True)
            except Exception as error:
                self.journal.write(str(job_id), "CLEANUP_PENDING", cleanup_error=str(error))
                self.log(f"Cleanup {job_id} vẫn lỗi: {error}")
            finally:
                device.lock.release()

    async def register(self):
        await self.send({
            "type": "register",
            "workerType": "android",
            "urls": self.current_urls,
            "hostname": socket.gethostname(),
            "devices": [device.serial for device in self.devices],
            "capabilities": [
                "studio-deeplink",
                "add",
                "affiliate-diff",
                "cleanup",
                "local-video-pool",
            ],
        })

    async def handle_job(self, message: dict[str, Any]):
        job_id = message.get("jobId", "unknown")
        try:
            result = await self.execute_job(message)
        except Exception as error:
            result = {"success": False, "error": str(error)}
        await self.send({"type": "job-result", "jobId": job_id, **result})

    async def run_connection(self):
        ws_url = f"{self.server_url.rstrip('/')}/ws/worker?token={self.token}"
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
            self.ws = ws
            await self.register()
            self.log(f"Đã kết nối relay {self.server_url}")
            async for raw in ws:
                message = json.loads(raw)
                if message.get("type") == "config-update":
                    # Android workers own their video pool locally. Server-side
                    # config updates are only retained for legacy browser workers.
                    continue
                elif message.get("type") == "execute-job":
                    asyncio.create_task(self.handle_job(message))
                elif message.get("type") == "heartbeat-ack":
                    pass

    async def run(self):
        self.connect_devices()
        await self.recover_pending_cleanup()
        delay = 1
        while True:
            try:
                await self.run_connection()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.log(f"Mất kết nối relay: {error}; thử lại sau {delay}s")
                self.ws = None
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)


def load_config(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_dotenv_file(path: str | Path = ".env"):
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value and value[0:1] == value[-1:] and value.startswith(("'", '"')):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def main():
    parser = argparse.ArgumentParser(description="YouTube Studio Android worker")
    parser.add_argument("--config", default="android-worker.json")
    args = parser.parse_args()
    load_dotenv_file()
    try:
        asyncio.run(AndroidWorker(load_config(args.config)).run())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"Android worker không khởi động được: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
