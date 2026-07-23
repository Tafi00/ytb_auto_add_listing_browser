from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Callable


STUDIO_PACKAGE = "com.google.android.apps.youtube.creator"
SAVE_BUTTON_ID = f"{STUDIO_PACKAGE}:id/primary_action_button"
OLD_ANDROID_CANCEL_ID = f"{STUDIO_PACKAGE}:id/dialog_cancel_button"
EDITOR_LIST_ID = f"{STUDIO_PACKAGE}:id/mde_content_view"
BOTTOM_SHEET_ID = f"{STUDIO_PACKAGE}:id/design_bottom_sheet"


def extract_video_id(url: str) -> str:
    patterns = (
        r"studio\.youtube\.com/video/([A-Za-z0-9_-]{6,})",
        r"youtu\.be/([A-Za-z0-9_-]{6,})",
        r"[?&]v=([A-Za-z0-9_-]{6,})",
        r"youtube\.com/(?:shorts|live)/([A-Za-z0-9_-]{6,})",
    )
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{6,}", url.strip()):
        return url.strip()
    raise ValueError(f"Không lấy được videoId từ URL: {url}")


def studio_url(video_id: str) -> str:
    return f"https://studio.youtube.com/video/{video_id}/edit"


class StudioAutomation:
    def __init__(
        self,
        device,
        serial: str,
        artifact_dir: str | Path,
        logger: Callable[[str], None],
        ui_timeout: float = 30,
    ):
        self.d = device
        self.serial = serial
        self.artifact_dir = Path(artifact_dir)
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        self.log = logger
        self.ui_timeout = ui_timeout
        self.mutation_started = False
        self.current_video_id: str | None = None

    def _exists(self, timeout: float = 0, **selector) -> bool:
        return bool(self.d(**selector).exists(timeout=timeout))

    def _wait_any(self, selectors: list[dict], timeout: float | None = None):
        end = time.time() + (timeout or self.ui_timeout)
        while time.time() < end:
            self._dismiss_known_dialogs()
            for selector in selectors:
                obj = self.d(**selector)
                if obj.exists:
                    return obj
            time.sleep(0.4)
        return None

    def _dismiss_known_dialogs(self):
        button = self.d(resourceId=OLD_ANDROID_CANCEL_ID)
        if button.exists:
            button.click()

    def capture(self, job_id: str, label: str):
        safe_label = re.sub(r"[^A-Za-z0-9_-]+", "-", label)
        try:
            self.d.screenshot(str(self.artifact_dir / f"{job_id}-{self.serial}-{safe_label}.png"))
            hierarchy = self.d.dump_hierarchy(compressed=False)
            (self.artifact_dir / f"{job_id}-{self.serial}-{safe_label}.xml").write_text(
                hierarchy, encoding="utf-8"
            )
        except Exception as error:  # diagnostics must never hide the original error
            self.log(f"[{self.serial}] Không lưu được ảnh chẩn đoán: {error}")

    def open_editor(self, video_id: str):
        target = studio_url(video_id)
        if self.current_video_id == video_id:
            if self._exists(resourceId=SAVE_BUTTON_ID):
                self.log(f"[{self.serial}] Dùng lại màn hình video {video_id}")
                return

            # A failed search can leave Studio inside Tag products. Return to
            # the already-open editor instead of launching the same deep-link.
            done = self.d(description="Done")
            if not done.exists:
                done = self.d(text="Done")
            if done.exists:
                done.click()
                editor = self._wait_any(
                    [{"text": "Edit video"}, {"resourceId": SAVE_BUTTON_ID}], timeout=8
                )
                if editor is not None:
                    self.log(f"[{self.serial}] Quay lại editor video {video_id}")
                    return

            for _ in range(2):
                self.d.press("back")
                editor = self._wait_any(
                    [{"text": "Edit video"}, {"resourceId": SAVE_BUTTON_ID}], timeout=4
                )
                if editor is not None:
                    self.log(f"[{self.serial}] Quay lại editor video {video_id}")
                    return

        self.log(f"[{self.serial}] Mở Studio video {video_id}")
        for attempt in range(2):
            if attempt:
                # A clean restart is only a fallback when direct navigation
                # cannot recover the editor.
                self.d.app_stop(STUDIO_PACKAGE)
                time.sleep(0.35)
            self.d.shell(
                [
                    "am", "start", "-W",
                    "-a", "android.intent.action.VIEW",
                    "-c", "android.intent.category.BROWSABLE",
                    "-d", target,
                    STUDIO_PACKAGE,
                ]
            )
            editor = self._wait_any(
                [{"text": "Edit video"}, {"resourceId": SAVE_BUTTON_ID}],
                timeout=20 if attempt == 0 else 40,
            )
            if editor is not None:
                self.current_video_id = video_id
                return
        raise RuntimeError("YouTube Studio không mở được trang Edit video")

    def _open_tag_products(self):
        if self._exists(text="Tag products") or self._exists(
            text="Search products", className="android.widget.EditText"
        ):
            return

        # Tagged products is near the bottom of Edit video. One long, targeted
        # swipe is sufficient on the current Studio layout and avoids the old
        # 12-fling + 6-swipe loop.
        width, height = self.d.window_size()
        self.d.swipe(width // 2, int(height * 0.84), width // 2, int(height * 0.18), 0.25)
        time.sleep(0.35)

        # Some Studio releases expose this label, while Compose-only releases
        # draw it without accessibility text.
        for selector in (
            {"textContains": "Tagged product"},
            {"textContains": "Tagged products"},
            {"descriptionContains": "Tagged product"},
        ):
            obj = self.d(**selector)
            if obj.exists:
                obj.click()
                break
        else:
            # Compose draws the label but omits it from accessibility. At the
            # end of Edit video, Tagged products is the lowest full-width
            # clickable ViewGroup. Pick it from hierarchy instead of relying on
            # one fixed coordinate (which can hit More options on another DPI).
            candidates = []
            hierarchy = ET.fromstring(self.d.dump_hierarchy(compressed=False))
            for node in hierarchy.iter("node"):
                if node.attrib.get("clickable") != "true":
                    continue
                if node.attrib.get("class") != "android.view.ViewGroup":
                    continue
                match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
                if not match:
                    continue
                left, top, right, bottom = map(int, match.groups())
                if right - left >= width * 0.8 and top >= height * 0.65:
                    candidates.append((bottom, left, top, right, bottom))
            if not candidates:
                raise RuntimeError("Không xác định được hàng Tagged products")
            _, left, top, right, bottom = max(candidates)
            self.d.click((left + right) // 2, (top + bottom) // 2)

        time.sleep(1)
        if self._exists(resourceId=BOTTOM_SHEET_ID):
            # A tap during the Compose transition can land on the previously
            # selected product. Close only the modal; stay on Tag products.
            self.d.press("back")
            time.sleep(0.5)

        if self._wait_any(
            [
                {"text": "Tag products"},
                {"text": "Search products", "className": "android.widget.EditText"},
            ],
            timeout=15,
        ) is None:
            raise RuntimeError("Không mở được màn hình Tag products")

    def _search(self, product_url: str):
        search = self._wait_any(
            [
                {"text": "Search products", "className": "android.widget.EditText"},
                {"className": "android.widget.EditText"},
            ],
            timeout=15,
        )
        if search is None:
            raise RuntimeError("Không tìm thấy ô Search products")
        search.click()
        search.clear_text()
        search.set_text(product_url)
        # Compose updates the field visually on set_text but does not issue the
        # search request until it receives the IME action.
        self.d.press("enter")
        # Until Compose swaps the Recently tagged feed for search results, an
        # old product's Select/Deselect button is still present. Never consume
        # those stale controls as the URL result.
        time.sleep(1)

    def _selected_product_count(self) -> int:
        view = self._wait_any(
            [{"description": "View selected products"}, {"text": "View"}], timeout=10
        )
        if view is None:
            raise RuntimeError("Không tìm thấy nút View selected products")
        view.click()
        if self._wait_any([{"resourceId": BOTTOM_SHEET_ID}], timeout=10) is None:
            raise RuntimeError("Không mở được danh sách sản phẩm đã chọn")
        time.sleep(0.5)
        count = self.d(description="Deselect product").count
        outside = self.d(resourceId=f"{STUDIO_PACKAGE}:id/touch_outside")
        if outside.exists:
            outside.click()
        else:
            width, height = self.d.window_size()
            self.d.click(width // 2, int(height * 0.25))
        time.sleep(0.5)
        return count

    def _save_editor(self, allow_already_saved: bool = False):
        # Compose can expose an enabled Save before the transition overlay is
        # gone, causing the first click to be silently dropped. Re-query and
        # retry instead of waiting 30 seconds on the stale enabled state.
        time.sleep(0.35)
        for attempt in range(1, 4):
            save = self._wait_any(
                [{"resourceId": SAVE_BUTTON_ID, "enabled": True}], timeout=8
            )
            if save is None:
                if allow_already_saved and self._exists(resourceId=SAVE_BUTTON_ID):
                    self.log(
                        f"[{self.serial}] Save đang tắt; Studio có thể đã tự lưu ở bước Done"
                    )
                    return False
                if not self._exists(resourceId=SAVE_BUTTON_ID):
                    return True
                continue
            try:
                save.click()
            except Exception as error:
                if "StaleObjectException" not in str(error):
                    raise

            end = time.time() + 8
            while time.time() < end:
                try:
                    current = self.d(resourceId=SAVE_BUTTON_ID)
                    if not current.exists or not current.info.get("enabled", False):
                        return True
                except Exception as error:
                    if "StaleObjectException" not in str(error):
                        raise
                time.sleep(0.35)
            self.log(f"[{self.serial}] Save chưa nhận click, thử lại {attempt}/3")
        raise RuntimeError("YouTube Studio không xác nhận Save")

    def add_product(self, video_id: str, product_url: str, job_id: str, on_mutation=None):
        self.mutation_started = False
        self.open_editor(video_id)
        self._open_tag_products()
        self._search(product_url)

        selected = self._wait_any([{"description": "Select product"}], timeout=30)
        if selected is None:
            self.capture(job_id, "product-not-found")
            if self._exists(description="Deselect product"):
                raise RuntimeError("Sản phẩm đã được gắn sẵn trên video; worker sẽ không tự ý xóa")
            if self._exists(textContains="No results"):
                raise RuntimeError("YouTube Studio báo No results found cho URL sản phẩm")
            raise RuntimeError("Không tìm thấy sản phẩm sau khi nhập URL")

        selected.click()
        # After a URL search the Recently tagged list is replaced, so this
        # Deselect button belongs to the exact result we just clicked. Opening
        # View selected products here cancels the pending Compose mutation on
        # this Studio build, therefore count verification happens during
        # cleanup instead.
        if self._wait_any([{"description": "Deselect product"}], timeout=10) is None:
            raise RuntimeError("Không xác nhận được sản phẩm đã được chọn")
        self.mutation_started = True
        if on_mutation:
            on_mutation(None)
        done = self._wait_any([{"text": "Done"}, {"description": "Done"}], timeout=10)
        if done is None:
            raise RuntimeError("Không tìm thấy nút Done")
        done.click()
        if self._wait_any([{"text": "Edit video"}], timeout=15) is None:
            raise RuntimeError("Không quay lại được màn hình Edit video")
        self._save_editor()
        return None

    def remove_product(
        self,
        video_id: str,
        product_url: str,
        job_id: str,
        baseline_selected_count: int | None = None,
    ) -> bool:
        self.open_editor(video_id)
        self._open_tag_products()
        self._search(product_url)
        selected = self._wait_any(
            [{"description": "Deselect product"}, {"description": "Select product"}], timeout=30
        )
        if selected is None:
            self.capture(job_id, "cleanup-product-not-found")
            raise RuntimeError("Cleanup không tìm thấy kết quả sản phẩm")
        if selected.info.get("contentDescription") == "Select product":
            self.log(f"[{self.serial}] Sản phẩm đã được gỡ trước đó")
            self.mutation_started = False
            return False

        selected.click()
        if self._wait_any([{"description": "Select product"}], timeout=10) is None:
            raise RuntimeError("Không xác nhận được thao tác bỏ chọn sản phẩm")
        done = self._wait_any([{"text": "Done"}, {"description": "Done"}], timeout=10)
        if done is None:
            raise RuntimeError("Cleanup không tìm thấy nút Done")
        done.click()
        if self._wait_any([{"text": "Edit video"}], timeout=15) is None:
            raise RuntimeError("Cleanup không quay lại được màn hình Edit video")
        self._save_editor()
        self.mutation_started = False
        return True
