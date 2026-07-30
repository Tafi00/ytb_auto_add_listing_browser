import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from android_worker.affiliate import product_identity
from android_worker.collection_worker import CollectionApiWorker, CollectionSlot
from android_worker.mobile_studio_api import (
    MobileStudioApi,
    OAuthCredential,
    _AuthRejected,
    _TOKEN_CACHE,
    extract_collection_id,
    extract_product_catalog_id,
    extract_shopee_offer_id,
    normalize_product_url,
)
from android_worker.protobuf_wire import (
    WireField,
    nested_length_values,
    parse_message,
    replace_bytes_at_path,
    serialize_message,
)


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "android_worker" / "mobile-api-template.json"


class ProtobufWireTests(unittest.TestCase):
    def test_nested_replace_preserves_other_fields(self):
        inner = serialize_message(
            [WireField(1, 2, b"old"), WireField(2, 0, 7)]
        )
        body = serialize_message(
            [WireField(17, 2, inner), WireField(99, 2, b"keep")]
        )
        changed = replace_bytes_at_path(body, (17, 1), b"new-value")
        self.assertEqual(
            nested_length_values(changed, (17, 1)), [b"new-value"]
        )
        self.assertEqual(nested_length_values(changed, (99,)), [b"keep"])
        self.assertEqual(parse_message(changed)[0].number, 17)


class MobileApiTests(unittest.TestCase):
    def make_client(self):
        return MobileStudioApi(
            adb_path=ROOT / "fake-adb.exe",
            serial="127.0.0.1:5555",
            collection=(
                "https://www.youtube.com/shopcollection/"
                "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ?scp=EAE%3D"
            ),
            template_path=TEMPLATE,
        )

    def test_extracts_ids(self):
        self.assertEqual(
            extract_collection_id(
                "https://www.youtube.com/shopcollection/"
                "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ?scp=EAE%3D"
            ),
            "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ",
        )
        self.assertEqual(
            extract_shopee_offer_id(
                "https://shopee.vn/product/1668757188/41429607892"
            ),
            "41429607892",
        )
        self.assertEqual(
            extract_shopee_offer_id(
                "https://shopee.vn/example-i.1668757188.41429607892"
            ),
            "41429607892",
        )
        self.assertEqual(
            extract_product_catalog_id(
                "https://www.lazada.vn/products/samsung-a17"
                "-i3237396474-s15582798079.html"
            ),
            "15582798079",
        )
        self.assertEqual(
            extract_shopee_offer_id(
                "https://shopee.vn/opaanlp/723523606/29201881549"
            ),
            "29201881549",
        )

    def test_normalizes_shopee_opaanlp_and_short_redirect(self):
        canonical = "https://shopee.vn/product/723523606/29201881549"
        redirected = (
            "https://shopee.vn/opaanlp/723523606/29201881549"
            "?credential_token=temporary&utm_source=affiliate"
        )

        class RedirectResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def geturl(self):
                return redirected

        with patch(
            "android_worker.mobile_studio_api.urlopen",
            return_value=RedirectResponse(),
        ):
            result = normalize_product_url(
                "https://s.shopee.vn/2qTFuGbZM9"
            )

        self.assertEqual(result, canonical)
        self.assertEqual(normalize_product_url(redirected), canonical)

    def test_template_has_restored_four_product_baseline(self):
        client = self.make_client()
        self.assertEqual(
            client.baseline_offer_ids(),
            [
                "23065259662",
                "45108475147",
                "54458801415",
                "41429607892",
            ],
        )

    def test_selected_record_keeps_exact_offer(self):
        record = serialize_message(
            [
                WireField(2, 2, b"41429607892"),
                WireField(
                    14,
                    2,
                    serialize_message([WireField(1, 2, b"old-event")]),
                ),
            ]
        )
        selected = self.make_client()._prepare_selected_record(record)
        self.assertEqual(
            self.make_client()._record_offer_id(selected), "41429607892"
        )
        self.assertNotEqual(
            nested_length_values(selected, (14, 1)), [b"old-event"]
        )

    def test_search_product_returns_metadata_for_the_exact_offer(self):
        def message(number, payload):
            return serialize_message([WireField(number, 2, payload)])

        record = serialize_message(
            [
                WireField(2, 2, b"15582798079"),
                WireField(
                    14,
                    2,
                    serialize_message([WireField(1, 2, b"old-event")]),
                ),
            ]
        )
        image = message(
            1,
            message(1, message(1, b"https://example.com/product.jpg")),
        )
        title = message(2, message(1, "Galaxy A17 5G".encode()))
        seller = message(3, message(1, b"Lazada Vietnam"))
        display = message(1880, image + title + seller)
        price = message(
            8,
            message(
                22546,
                message(6, message(1, "₫5,820,000".encode())),
            ),
        )
        item = message(2, display) + price + message(1001, record)
        response = message(
            777,
            message(
                1,
                message(
                    1,
                    message(3, message(562, message(2, item))),
                ),
            ),
        )
        client = self.make_client()

        with patch.object(client, "_post", return_value=response):
            product = client.search_product(
                "https://www.lazada.vn/products/samsung-a17"
                "-i3237396474-s15582798079.html"
            )

        self.assertEqual(product.offer_id, "15582798079")
        self.assertEqual(product.metadata["title"], "Galaxy A17 5G")
        self.assertEqual(product.metadata["price"], "₫5,820,000")
        self.assertEqual(
            product.metadata["image"], "https://example.com/product.jpg"
        )
        self.assertEqual(product.metadata["seller"], "Lazada Vietnam")

    def test_affiliate_redirect_identity_uses_origin_link(self):
        url = (
            "https://s.shopee.vn/an_redir?affiliate_id=17104820001"
            "&origin_link=https%3A%2F%2Fshopee.vn%2Fproduct%2F"
            "1668757188%2F41429607892%3Fgads_t_sig%3Dabc"
            "&sub_id=YT3-test"
        )
        self.assertEqual(
            product_identity(url), "shopee:1668757188:41429607892"
        )
        self.assertEqual(
            product_identity(
                "https://shopee.vn/opaanlp/723523606/29201881549"
            ),
            "shopee:723523606:29201881549",
        )

    def test_template_does_not_contain_authorization(self):
        template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        self.assertNotIn("authorization", template["headers"])
        self.assertNotIn("cookie", template["headers"])

    @patch("android_worker.collection_worker.MobileStudioApi")
    @patch("android_worker.collection_worker.subprocess.run")
    def test_one_ldplayer_can_own_multiple_collections(
        self, run_mock, client_mock
    ):
        run_mock.return_value = SimpleNamespace(
            stdout="List of devices attached\n127.0.0.1:5555\tdevice\n"
        )
        urls = [
            f"https://www.youtube.com/shopcollection/SC{'A' * 30}{index}"
            for index in range(3)
        ]
        worker = CollectionApiWorker(
            {
                "adb_path": "fake-adb.exe",
                "collection_urls": urls,
                "devices": [{"serial": "127.0.0.1:5555"}],
            }
        )
        worker.connect_devices()
        self.assertEqual([slot.collection_url for slot in worker.slots], urls)
        self.assertEqual(
            {slot.serial for slot in worker.slots}, {"127.0.0.1:5555"}
        )
        self.assertEqual(client_mock.call_count, 3)


class CollectionRoutingTests(unittest.IsolatedAsyncioTestCase):
    @patch("android_worker.collection_worker.fetch_public_products_url")
    async def test_affiliate_is_fetched_from_the_assigned_collection_only(
        self, fetch_mock
    ):
        collection_url = (
            "https://www.youtube.com/shopcollection/"
            "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ"
        )
        product_url = "https://shopee.vn/product/1668757188/41429607892"
        fetch_mock.return_value = {
            "shopee:1668757188:41429607892": (
                "https://shopee.vn/product/1668757188/41429607892"
                "?affiliate_id=17104820001"
            )
        }
        worker = CollectionApiWorker(
            {"affiliate_poll_timeout": 1, "affiliate_poll_seconds": 0.01}
        )
        slot = CollectionSlot(
            serial="localhost:60733",
            collection_url=collection_url,
            client=SimpleNamespace(),
        )

        result = await worker.poll_affiliate(slot, product_url)

        self.assertIn("affiliate_id=17104820001", result)
        fetch_mock.assert_called_once_with(collection_url)

    @patch("android_worker.collection_worker.fetch_public_products_url")
    async def test_stale_product_is_removed_before_slot_is_reused(
        self, fetch_mock
    ):
        collection_url = (
            "https://www.youtube.com/shopcollection/"
            "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ"
        )
        restore_calls = []
        client = SimpleNamespace(
            baseline_offer_ids=lambda: ["41429607892"],
            restore_baseline=lambda: restore_calls.append(True),
        )
        slot = CollectionSlot(
            serial="localhost:60733",
            collection_url=collection_url,
            client=client,
        )
        fetch_mock.side_effect = [
            {
                "shopee:1668757188:41429607892": "baseline",
                "shopee:645499489:29629325768": "stale",
            },
            {"shopee:1668757188:41429607892": "baseline"},
        ]
        worker = CollectionApiWorker(
            {"cleanup_verify_timeout": 1, "affiliate_poll_seconds": 0.01}
        )

        await worker.restore_slot_baseline(slot)

        self.assertEqual(restore_calls, [True])
        self.assertEqual(fetch_mock.call_count, 2)

    @patch(
        "android_worker.collection_worker.normalize_product_url",
        return_value="https://shopee.vn/product/645499489/29629325768",
    )
    async def test_short_url_uses_canonical_identity_for_collection_poll(
        self, normalize_mock
    ):
        collection_url = (
            "https://www.youtube.com/shopcollection/"
            "SCUCAoEyHrIDj0w7srJBor_mXDSpiBg_lMIjQ"
        )
        searched = []
        client = SimpleNamespace(
            search_product=lambda url: (
                searched.append(url)
                or SimpleNamespace(
                    offer_id="29629325768",
                    metadata={"title": "Product"},
                )
            ),
            baseline_offer_ids=lambda: ["29629325768"],
        )
        slot = CollectionSlot(
            serial="localhost:60733",
            collection_url=collection_url,
            client=client,
        )
        worker = CollectionApiWorker({})
        worker.slots = [slot]
        worker.restore_slot_baseline = AsyncMock()
        worker.poll_affiliate = AsyncMock(
            return_value=(
                "https://s.shopee.vn/an_redir?affiliate_id=17104820001"
            )
        )

        result = await worker.execute_job({
            "jobId": "short-link-job",
            "targetUrl": collection_url,
            "productUrl": "https://s.shopee.vn/5VRtK78tDI",
        })

        canonical = "https://shopee.vn/product/645499489/29629325768"
        self.assertTrue(result["success"])
        self.assertEqual(searched, [canonical])
        worker.poll_affiliate.assert_awaited_once_with(slot, canonical)
        normalize_mock.assert_called_once()


class OAuthRefreshTests(unittest.TestCase):
    def setUp(self):
        _TOKEN_CACHE.clear()

    def make_client(self, collection_suffix="A"):
        return MobileStudioApi(
            adb_path=ROOT / "fake-adb.exe",
            serial="localhost:60733",
            collection=(
                "https://www.youtube.com/shopcollection/"
                f"SCUC{'A' * 30}{collection_suffix}"
            ),
            template_path=TEMPLATE,
        )

    def test_new_token_is_validated_then_shared_with_all_collections(self):
        first = self.make_client("1")
        second = self.make_client("2")
        old = OAuthCredential("old-token", "user")
        new = OAuthCredential("new-token", "user")
        first._publish_tokens([old])
        second._sync_cached_tokens()

        with patch.object(first.session, "wake_studio") as wake_mock, \
                patch.object(
                    first.session, "oauth_credentials", return_value=[new]
                ), patch.object(
                    first,
                    "_post_candidates",
                    return_value=(b"settings", 0),
                ):
            refreshed = first.refresh_credentials_proactively(wait_seconds=0)

        second._sync_cached_tokens()
        self.assertTrue(refreshed)
        self.assertEqual(first.credentials, [new])
        self.assertEqual(second.credentials, [new])
        wake_mock.assert_called_once_with(wait_seconds=0)

    def test_unchanged_token_is_retained_for_retry(self):
        client = self.make_client("3")
        old = OAuthCredential("old-token", "user")
        client._publish_tokens([old])

        with patch.object(client.session, "wake_studio"), patch.object(
            client.session, "oauth_credentials", return_value=[old]
        ):
            refreshed = client.refresh_credentials_proactively(wait_seconds=0)

        self.assertFalse(refreshed)
        self.assertEqual(client.credentials, [old])

    def test_rejected_new_token_does_not_replace_working_cache(self):
        first = self.make_client("4")
        second = self.make_client("5")
        old = OAuthCredential("old-token", "user")
        rejected = OAuthCredential("rejected-token", "user")
        first._publish_tokens([old])
        second._sync_cached_tokens()

        with patch.object(
            first, "_read_refreshed_tokens", return_value=[rejected]
        ), patch.object(
            first,
            "_post_candidates",
            side_effect=_AuthRejected("invalid candidate"),
        ):
            refreshed = first.refresh_credentials_proactively(wait_seconds=0)

        second._sync_cached_tokens()
        self.assertFalse(refreshed)
        self.assertEqual(first.credentials, [old])
        self.assertEqual(second.credentials, [old])


if __name__ == "__main__":
    unittest.main()
