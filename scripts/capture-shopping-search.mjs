import { chromium } from 'playwright';

const endpoint = process.argv[2] || 'http://127.0.0.1:19222';
const productUrl = process.argv[3]
  || 'https://www.lazada.vn/products/moi-2025-dien-thoai-samsung-galaxy-a17-5g-8gb128gb-xam-khoi-i3237396474-s15582798079.html';

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context.pages().find(candidate =>
  /studio\.youtube\.com\/video\/VNa64icfGAg\/edit/.test(candidate.url()),
) || context.pages()[0];
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });

const captures = [];
const responseMatches = [];
let captureEnabled = false;

page.on('request', request => {
  if (!captureEnabled) return;
  const raw = request.postData();
  let body = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw?.slice(0, 20_000) || null;
  }
  captures.push({
    method: request.method(),
    resourceType: request.resourceType(),
    url: request.url(),
    body,
  });
});

page.on('response', async response => {
  if (
    !captureEnabled
    || !response.url().includes('/monetization/get_shopping_settings')
  ) return;
  try {
    const body = await response.json();
    const matches = [];
    const visit = (value, path = '$') => {
      if (matches.length >= 80 || value == null) return;
      if (Array.isArray(value)) {
        value.slice(0, 100).forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (
          /productClusterMid|shoppingItemId|itemId|productSearchNonce/i.test(key)
          || (typeof child === 'string' && child.includes('6853547794971194620'))
        ) {
          matches.push({ path: childPath, value: child });
        }
        visit(child, childPath);
      }
    };
    visit(body);
    responseMatches.push({ status: response.status(), matches });
  } catch {
    // Ignore non-JSON responses.
  }
});

const search = page.locator('input#search-input.search-input');
if (!await search.isVisible({ timeout: 500 }).catch(() => false)) {
  const edit = page.locator('ytcp-icon-button#shopping-toolbar-edit');
  if (!await edit.isVisible({ timeout: 700 }).catch(() => false)) {
    const products = page.locator(
      'button:has(div.ytcpButtonShapeImpl__button-text-content)',
    ).filter({ hasText: /Products|Sản phẩm|tagged product/i }).first();
    await products.waitFor({ state: 'visible', timeout: 10_000 });
    await products.click({ force: true });
  }
  await edit.waitFor({ state: 'visible', timeout: 8_000 });
  await edit.click({ force: true });
}

await search.waitFor({ state: 'visible', timeout: 8_000 });
captureEnabled = true;
const searchResponsePromise = page.waitForResponse(response =>
  response.url().includes('/monetization/get_shopping_settings')
  && (response.request().postData() || '').includes(productUrl),
  { timeout: 15_000 },
);
await search.fill('');
await search.fill(productUrl);
await search.press('Enter');
const searchResponse = await searchResponsePromise;
const searchResponseBody = await searchResponse.json();
const result = page.locator(
  'ytshopping-product-picker-search-result[ve-sibling-key]',
).first();
await result.waitFor({ state: 'visible', timeout: 15_000 });
await page.waitForTimeout(500);
captureEnabled = false;

const veSiblingKey = await result.getAttribute('ve-sibling-key');
const directResponseMatches = [];
const visitResponse = (value, path = '$') => {
  if (directResponseMatches.length >= 100 || value == null) return;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item, index) => visitResponse(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      /productClusterMid|shoppingItemId|itemId|productSearchNonce/i.test(key)
      || (typeof child === 'string' && child.includes('6853547794971194620'))
    ) {
      directResponseMatches.push({ path: childPath, value: child });
    }
    visitResponse(child, childPath);
  }
};
visitResponse(searchResponseBody);
const relevant = captures.filter(item => {
  const body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
  return body?.includes(productUrl)
    || /shopping|product|catalog|merchant|search/i.test(item.url)
    || /shopping|product|catalog|merchant/i.test(body || '');
});

await page.keyboard.press('Escape').catch(() => {});
console.log(JSON.stringify({
  veSiblingKey,
  requestCount: captures.length,
  relevant,
  responseMatches,
  directResponseMatches,
}, null, 2));

await browser.close();
