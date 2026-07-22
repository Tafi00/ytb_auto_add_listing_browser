from __future__ import annotations

import html
import json
import re
import time
from dataclasses import dataclass
from collections.abc import Iterable, Mapping
from urllib.parse import unquote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


URL_RE = re.compile(r"https?[^\"'<>\s{}]+", re.IGNORECASE)
SUPPORTED_HOSTS = ("lazada.vn", "lzd.co", "shopee.vn", "shp.ee")
AFFILIATE_MARKERS = (
    "sub_aff_id=",
    "exlaz=",
    "laz_trackid=",
    "aff_id=",
    "affiliate_id=",
    "utm_source=youtube",
    "utm_medium=affiliate",
)


def _decode_url(value: str) -> str:
    value = html.unescape(value).replace("\\u0026", "&").replace("\\/", "/")
    value = value.replace("\\u003d", "=").replace("\\u003f", "?")
    for _ in range(2):
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    return value.rstrip("\\,]")


def _supported(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
        return any(host == item or host.endswith("." + item) for item in SUPPORTED_HOSTS)
    except ValueError:
        return False


def product_identity(url: str) -> str:
    """Return a stable identity while ignoring rotating affiliate query tokens."""
    decoded = _decode_url(url)
    parts = urlsplit(decoded)
    host = (parts.hostname or "").lower().removeprefix("www.")
    path = re.sub(r"/+", "/", parts.path).rstrip("/").lower()

    lazada = re.search(r"-i(\d+)(?:-s(\d+))?\.html", path)
    if lazada:
        # YouTube may map a submitted SKU to another seller SKU, but the catalog
        # product id in the public shelf is stable for subsequent polls.
        return f"lazada:{lazada.group(1)}:{lazada.group(2) or ''}"

    shopee = re.search(r"(?:-i\.|/product/)(\d+)[./](\d+)", path)
    if shopee:
        return f"shopee:{shopee.group(1)}:{shopee.group(2)}"

    return urlunsplit((host, "", path, "", ""))


def product_tokens(url: str) -> set[str]:
    """Tokens used to match a catalog product even when YouTube rotates SKU."""
    path = urlsplit(_decode_url(url)).path.lower()
    path = re.sub(r"-i\d+(?:-s\d+)?\.html.*$", "", path)
    tokens = set(re.findall(r"[a-z]+|\d+", path))
    return tokens - {
        "products", "product", "html", "www", "moi", "new", "chinh", "hang",
        "from", "gmc", "dien", "thoai",
    }


def product_similarity(first: str, second: str) -> float:
    a, b = product_tokens(first), product_tokens(second)
    if not a or not b:
        return 0.0
    # Containment is more useful than Jaccard here: a YouTube catalog URL often
    # appends seller copy/specifications to the shorter submitted URL.
    return len(a & b) / min(len(a), len(b))


def extract_product_urls(page: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for raw in URL_RE.findall(page):
        url = _decode_url(raw)
        if not _supported(url):
            continue
        identity = product_identity(url)
        current = found.get(identity)
        # Prefer the decorated URL over a plain canonical product URL.
        if current is None or (
            any(marker in url.lower() for marker in AFFILIATE_MARKERS)
            and not any(marker in current.lower() for marker in AFFILIATE_MARKERS)
        ):
            found[identity] = url
    return found


def fetch_public_products(video_id: str, timeout: float = 20) -> dict[str, str]:
    url = f"https://www.youtube.com/watch?v={video_id}&hl=vi&gl=VN&_={int(time.time() * 1000)}"
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
            "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
    return extract_product_urls(body)


@dataclass(frozen=True)
class AffiliateResult:
    identity: str
    url: str


def find_new_product(
    before: Mapping[str, str] | Iterable[str],
    current: dict[str, str],
    expected_url: str | None = None,
) -> AffiliateResult | None:
    if isinstance(before, Mapping):
        baseline_ids = set(before)
        baseline_urls = list(before.values())
    else:
        baseline_ids = set(before)
        baseline_urls = []

    candidates = []
    for identity, url in current.items():
        if identity in baseline_ids:
            continue
        if any(product_similarity(url, old) >= 0.55 for old in baseline_urls):
            continue
        score = product_similarity(url, expected_url) if expected_url else 0.0
        candidates.append((score, identity, url))
    if candidates:
        score, identity, url = max(candidates)
        if expected_url and score < 0.45:
            return None
        return AffiliateResult(identity=identity, url=url)
    return None
