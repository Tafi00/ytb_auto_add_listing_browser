import argparse
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")


DEFAULT_PRODUCT = (
    "https://www.lazada.vn/products/moi-2025-dien-thoai-samsung-galaxy-a17-"
    "5g-8gb128gb-xam-khoi-i3237396474-s15582798079.html"
)


def request_affiliate(endpoint: str, product_url: str, index: int) -> dict:
    payload = json.dumps(
        {
            "productUrl": product_url,
            "clientId": f"android-benchmark-{uuid.uuid4().hex}",
            "bypassRateLimit": True,
        }
    ).encode()
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=420) as response:
            text = response.read().decode("utf-8", errors="replace").strip()
            return {
                "index": index,
                "ok": True,
                "status": response.status,
                "elapsed_seconds": round(time.monotonic() - started, 2),
                "response": json.loads(text),
            }
    except Exception as error:
        body = (
            error.read().decode("utf-8", errors="replace").strip()
            if isinstance(error, urllib.error.HTTPError)
            else ""
        )
        try:
            parsed_body = json.loads(body) if body else None
        except json.JSONDecodeError:
            parsed_body = body[:500]
        return {
            "index": index,
            "ok": False,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "error": str(error),
            "response": parsed_body,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--endpoint",
        default="https://voucheryoutube.vn/api/get-affiliate",
    )
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--product-url", default=DEFAULT_PRODUCT)
    args = parser.parse_args()

    wall_started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.count) as executor:
        futures = [
            executor.submit(
                request_affiliate,
                args.endpoint,
                args.product_url,
                index,
            )
            for index in range(1, args.count + 1)
        ]
        results = [future.result() for future in futures]

    output = {
        "request_count": args.count,
        "wall_seconds": round(time.monotonic() - wall_started, 2),
        "results": sorted(results, key=lambda item: item["index"]),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    if not all(item["ok"] for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
