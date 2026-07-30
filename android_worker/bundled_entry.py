from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


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


def run_worker(config_path: str) -> int:
    from android_worker.collection_worker import CollectionApiWorker

    load_dotenv_file()
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    asyncio.run(CollectionApiWorker(config).run())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Bundled Android collection worker")
    parser.add_argument("command", choices=("worker", "verify"))
    parser.add_argument("--config", default="android-worker.json")
    args = parser.parse_args()
    if args.command == "verify":
        from android_worker.verify_session import verify

        try:
            result = verify(args.config)
        except Exception as error:
            result = {"ok": False, "results": [], "error": str(error)}
        print(
            "SESSION_VERIFY_RESULT="
            + json.dumps(result, ensure_ascii=False),
            flush=True,
        )
        return 0 if result["ok"] else 1
    try:
        return run_worker(args.config)
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        print(
            f"Android worker không khởi động được: {error}",
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
