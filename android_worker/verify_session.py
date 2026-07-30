from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import time
from pathlib import Path

from android_worker.collection_worker import CollectionApiWorker
from android_worker.mobile_studio_api import AdbStudioSession
from android_worker.vmos_cloud import VmosAdbManager


RESULT_PREFIX = "SESSION_VERIFY_RESULT="


def discover_and_save_collections(
    config: dict, config_path: Path
) -> list[dict]:
    adb_path = str(config.get("adb_path", "")).strip()
    if not adb_path:
        raise ValueError("Thiếu adb_path của LDPlayer")
    device_output = subprocess.run(
        [adb_path, "devices"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    online = [
        line.split()[0]
        for line in device_output.stdout.splitlines()[1:]
        if len(line.split()) >= 2 and line.split()[1] == "device"
    ]
    if not online:
        raise RuntimeError("Không có LDPlayer nào online qua ADB")

    configured = config.get("devices", [])
    if not configured:
        configured = [{"serial": "auto"}]
    updated_devices = []
    all_urls = []
    discoveries = []
    for index, raw_item in enumerate(configured):
        item = {"serial": str(raw_item)} if not isinstance(raw_item, dict) else dict(raw_item)
        requested = str(item.get("serial", "auto")).strip()
        if requested in online:
            serial = requested
        elif index < len(online):
            serial = online[index]
        elif len(online) == 1:
            serial = online[0]
        else:
            raise RuntimeError(f"LDPlayer {requested} không online")

        started = time.monotonic()
        ids = AdbStudioSession(adb_path, serial).discover_collection_ids()
        urls = [
            f"https://www.youtube.com/shopcollection/{collection_id}"
            for collection_id in ids
        ]
        item["serial"] = serial
        item["collection_urls"] = urls
        item["collection_url"] = urls[0]
        updated_devices.append(item)
        all_urls.extend(url for url in urls if url not in all_urls)
        discoveries.append({
            "serial": serial,
            "collectionUrls": urls,
            "seconds": round(time.monotonic() - started, 3),
        })

    config["mode"] = "collection-api"
    config["auto_discover_collections"] = True
    config["collection_urls"] = all_urls
    config["collection_url"] = all_urls[0]
    config["devices"] = updated_devices
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return discoveries


def verify(config_path: str | Path) -> dict:
    started_at = time.monotonic()
    path = Path(config_path)
    config = json.loads(path.read_text(encoding="utf-8"))
    manager = None
    try:
        vmos_settings = config.get("vmos") or {}
        reuse_vmos_tunnel = (
            os.getenv("VMOS_REUSE_EXISTING_TUNNEL", "").strip() == "1"
        )
        if vmos_settings.get("enabled") and reuse_vmos_tunnel:
            # The running worker owns the SSH tunnel. Verification must reuse
            # it instead of killing the worker or binding the same port again.
            config = copy.deepcopy(config)
            local_port = int(vmos_settings.get("local_port", 60733))
            serial = f"localhost:{local_port}"
            config["vmos"]["enabled"] = False
            devices = config.get("devices") or [{"serial": serial}]
            config["devices"] = [
                {
                    **(
                        item
                        if isinstance(item, dict)
                        else {"serial": str(item)}
                    ),
                    "serial": serial,
                }
                for item in devices
            ]
        elif vmos_settings.get("enabled"):
            manager = VmosAdbManager(config, str(config.get("adb_path", "")))
            manager.start()

        discoveries = []
        # Fixed collection pools are the normal path. Older launcher configs
        # do not contain this key, so missing must not trigger fragile UI
        # navigation inside YouTube Studio.
        if config.get("auto_discover_collections", False):
            discoveries = discover_and_save_collections(config, path)
        worker = CollectionApiWorker(config, vmos_manager=manager)
        worker.connect_devices()
        results = []

        for slot in worker.slots:
            device_started_at = time.monotonic()
            try:
                slot.client.check_login()
            except Exception as error:
                results.append(
                    {
                        "serial": slot.serial,
                        "collectionUrl": slot.collection_url,
                        "ok": False,
                        "error": str(error),
                        "seconds": round(time.monotonic() - device_started_at, 3),
                    }
                )
            else:
                results.append(
                    {
                        "serial": slot.serial,
                        "collectionUrl": slot.collection_url,
                        "ok": True,
                        "sessionCount": len(slot.client.credentials),
                        "seconds": round(time.monotonic() - device_started_at, 3),
                    }
                )

        return {
            "ok": bool(results) and all(item["ok"] for item in results),
            "results": results,
            "discoveries": discoveries,
            "seconds": round(time.monotonic() - started_at, 3),
        }
    finally:
        if manager is not None:
            manager.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify saved YouTube Studio sessions in LDPlayer"
    )
    parser.add_argument("--config", default="android-worker.json")
    args = parser.parse_args()
    try:
        result = verify(args.config)
    except Exception as error:
        result = {"ok": False, "results": [], "error": str(error)}
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
