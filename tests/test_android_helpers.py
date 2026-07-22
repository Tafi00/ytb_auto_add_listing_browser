import unittest

from android_worker.affiliate import (
    extract_product_urls, find_new_product, product_identity, product_similarity,
)
from android_worker.youtube_studio import extract_video_id, studio_url


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


if __name__ == "__main__":
    unittest.main()
