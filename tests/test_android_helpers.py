import unittest
import asyncio
from unittest.mock import patch
from urllib.error import HTTPError

from android_worker.affiliate import (
    extract_product_urls, fetch_public_products, find_new_product, product_identity,
    product_similarity,
)
from android_worker.youtube_studio import extract_video_id, studio_url
from android_worker.worker import AndroidWorker


class AndroidHelperTests(unittest.TestCase):
    def test_video_urls(self):
        expected = "VNa64icfGAg"
        self.assertEqual(extract_video_id(f"https://studio.youtube.com/video/{expected}/edit"), expected)
        self.assertEqual(extract_video_id(f"https://youtu.be/{expected}"), expected)
        self.assertEqual(extract_video_id(f"https://www.youtube.com/watch?v={expected}"), expected)
        self.assertEqual(studio_url(expected), f"https://studio.youtube.com/video/{expected}/edit")

    def test_lazada_identity_ignores_affiliate_tokens(self):
        first = "https://www.lazada.vn/products/a-i3286548952-s15928610862.html?sub_aff_id=one"
        second = "https://www.lazada.vn/products/a-i3286548952-s15928610862.html?sub_aff_id=two"
        self.assertEqual(product_identity(first), product_identity(second))

    def test_extracts_json_escaped_affiliate_url(self):
        body = (
            '"https://www.lazada.vn/products/a-i3286548952-s15928610862.html'
            '?from_gmc=1\\u0026sub_aff_id=YT3-test\\u0026exlaz=value"'
        )
        products = extract_product_urls(body)
        self.assertEqual(len(products), 1)
        self.assertIn("sub_aff_id=YT3-test", next(iter(products.values())))

    def test_set_difference(self):
        current = {
            "lazada:1:2": "https://lazada.vn/old-i1-s2.html?sub_aff_id=old",
            "lazada:3:4": "https://lazada.vn/new-i3-s4.html?sub_aff_id=new",
        }
        result = find_new_product({"lazada:1:2"}, current)
        self.assertIsNotNone(result)
        self.assertEqual(result.identity, "lazada:3:4")

    def test_new_similar_variant_is_detected_when_shelf_grows(self):
        baseline_url = (
            "https://www.lazada.vn/products/samsung-galaxy-a17-5g-4-128gb-"
            "i3332640654-s16333304915.html?sub_aff_id=old"
        )
        submitted = (
            "https://www.lazada.vn/products/samsung-galaxy-a17-5g-8gb128gb-"
            "i3237396474-s15582798079.html"
        )
        affiliate = (
            "https://www.lazada.vn/products/samsung-galaxy-a17-5g-8gb128gb-"
            "i3189247573-s15178609101.html?sub_aff_id=YT3-new"
        )
        result = find_new_product(
            {"lazada:3332640654:16333304915": baseline_url},
            {
                "lazada:3332640654:16333304915": baseline_url,
                "lazada:3189247573:15178609101": affiliate,
            },
            submitted,
        )
        self.assertIsNotNone(result)
        self.assertEqual(result.url, affiliate)

    def test_catalog_sku_rotation_matches_same_product_family(self):
        submitted = (
            "https://www.lazada.vn/products/moi-2025-dien-thoai-samsung-galaxy-a17-"
            "5g-8gb128gb-xam-khoi-i3237396474-s15582798079.html"
        )
        rotated = (
            "https://www.lazada.vn/products/dien-thoai-samsung-galaxy-a17-5g-8gb-"
            "128gb-hang-chinh-hang-i13353061159-s116783232118.html?sub_aff_id=YT3"
        )
        flower = "https://www.lazada.vn/products/flower-knows-bot-highlight-i1-s2.html"
        self.assertGreaterEqual(product_similarity(submitted, rotated), 0.45)
        self.assertLess(product_similarity(submitted, flower), 0.45)

    @patch("android_worker.affiliate.time.sleep")
    @patch("android_worker.affiliate.urlopen")
    def test_public_product_fetch_retries_bad_gateway(self, urlopen_mock, sleep_mock):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return b'"https://www.lazada.vn/products/a-i1-s2.html?sub_aff_id=ok"'

        urlopen_mock.side_effect = [
            HTTPError("https://youtube.test", 502, "Bad Gateway", {}, None),
            Response(),
        ]
        products = fetch_public_products("VNa64icfGAg", attempts=2)
        self.assertEqual(len(products), 1)
        self.assertEqual(urlopen_mock.call_count, 2)
        sleep_mock.assert_called_once()

    @patch("android_worker.worker.fetch_public_products")
    def test_cleanup_verification_uses_exact_identity(self, fetch_mock):
        fetch_mock.return_value = {
            "lazada:3332640654:16333304915": "https://lazada.vn/another-a17-i3332640654-s16333304915.html"
        }
        worker = AndroidWorker({"cleanup_verify_timeout": 1})
        asyncio.run(
            worker.verify_removed(
                "VNa64icfGAg",
                "https://lazada.vn/original-a17-i3237396474-s15582798079.html",
                baseline_count=0,
                expected_identity="lazada:3189247573:15178609102",
            )
        )
        fetch_mock.assert_called_once()

    def test_worker_pairs_each_device_with_one_local_video(self):
        first = "https://studio.youtube.com/video/VNa64icfGAg/edit"
        second = "https://studio.youtube.com/video/oCi1sPzCSc4/edit"
        worker = AndroidWorker({
            "video_urls": [first, second],
            "devices": [
                {"serial": "emulator-5554"},
                {"serial": "emulator-5556"},
            ],
        })
        self.assertEqual(worker.current_urls, [first, second])

    def test_worker_rejects_more_videos_than_devices(self):
        with self.assertRaisesRegex(ValueError, "2 video.*1 LDPlayer"):
            AndroidWorker({
                "video_urls": [
                    "https://studio.youtube.com/video/VNa64icfGAg/edit",
                    "https://studio.youtube.com/video/oCi1sPzCSc4/edit",
                ],
                "devices": [{"serial": "emulator-5554"}],
            })


if __name__ == "__main__":
    unittest.main()
