from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class JobJournal:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path(self, job_id: str) -> Path:
        safe = "".join(c for c in job_id if c.isalnum() or c in "-_")
        if not safe:
            raise ValueError("Invalid job id")
        return self.directory / f"{safe}.json"

    def write(self, job_id: str, state: str, **values: Any) -> dict[str, Any]:
        path = self._path(job_id)
        current: dict[str, Any] = {}
        if path.exists():
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                current = {}
        current.update(values)
        current.update({"job_id": job_id, "state": state})
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
        return current

    def pending_cleanup(self) -> list[dict[str, Any]]:
        result = []
        for path in self.directory.glob("*.json"):
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if item.get("state") in {"ADD_SAVED", "AFFILIATE_FOUND", "CLEANUP_PENDING"}:
                result.append(item)
        return result

