from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

from mitmproxy import io

from android_worker.protobuf_wire import nested_length_values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture")
    parser.add_argument("output")
    args = parser.parse_args()

    with open(args.capture, "rb") as handle:
        flows = [
            flow for flow in io.FlowReader(handle).stream()
            if "shopping_settings" in flow.request.path
        ]

    searches = [
        flow for flow in flows
        if flow.request.path.endswith("/get_shopping_settings")
        and b"/product/" in (flow.request.raw_content or b"")
    ]
    updates = [
        flow for flow in flows
        if flow.request.path.endswith("/update_shopping_settings")
    ]
    if not searches or not updates:
        raise RuntimeError("Capture không có đủ search/update Shopping API")

    search = searches[-1]
    # The last/largest update is the collection state restored after capture.
    baseline_update = max(updates, key=lambda flow: len(flow.request.raw_content or b""))
    collection_values = nested_length_values(
        baseline_update.request.raw_content or b"", (17, 1)
    )
    if len(collection_values) != 1:
        raise RuntimeError("Không đọc được collection ID từ update request")

    allowed_headers = {
        "content-type",
        "user-agent",
        "x-goog-api-format-version",
        "x-goog-visitor-id",
        "x-youtube-cold-config-data",
        "x-youtube-cold-hash-data",
        "x-youtube-hot-hash-data",
    }
    headers = {
        key.lower(): value for key, value in search.request.headers.items()
        if key.lower() in allowed_headers
    }
    template = {
        "version": 1,
        "collection_id": collection_values[0].decode("utf-8"),
        "headers": headers,
        "search_body_base64": base64.b64encode(
            search.request.raw_content or b""
        ).decode("ascii"),
        "baseline_update_body_base64": base64.b64encode(
            baseline_update.request.raw_content or b""
        ).decode("ascii"),
    }
    Path(args.output).write_text(
        json.dumps(template, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
