import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
const page = browser.contexts()[0].pages()[0];
const productUrl = 'https://s.shopee.vn/5VRtK78tDI';

await page.goto('https://studio.youtube.com/video/IiO_XN86stU/edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);

const btn = page.locator('button:has(div.ytcpButtonShapeImpl__button-text-content)').filter({ hasText: /(Sản phẩm|Products|tagged product|sản phẩm đã gắn)/i }).first();
const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');
await Promise.race([editBtn.waitFor({ state: 'attached', timeout: 15000 }), btn.waitFor({ state: 'attached', timeout: 15000 })]);
if (!(await editBtn.isVisible().catch(() => false))) { await btn.evaluate(b => b.click()).catch(() => { }); await page.waitForTimeout(800); }
await editBtn.evaluate(b => b.click()).catch(() => { });

const si = page.locator('input#search-input.search-input');
await si.waitFor({ state: 'visible', timeout: 10000 });
await si.click(); await si.fill(productUrl); await si.press('Enter');

try { const ap = page.locator('ytshopping-product-picker-selected-product ytshopping-product'); let c = await ap.count().catch(() => 0); while (c > 0) { if (!(await ap.first().isVisible().catch(() => false))) break; await ap.first().hover(); await page.locator('ytcp-icon-button.delete-product-button').first().click(); await page.waitForTimeout(300); c = await ap.count().catch(() => 0); } } catch { }

await page.locator('ytcp-icon-button.tag-product-button').first().waitFor({ state: 'visible', timeout: 10000 });
console.log('Results loaded');

// Check price on the search result card
const cardPrice = await page.evaluate(() => {
    const card = document.querySelector('ytshopping-product-picker-search-result ytshopping-product');
    if (!card) return null;
    const priceEl = card.querySelector('yt-formatted-string[aria-label*="rice"]');
    return priceEl ? priceEl.textContent.trim() : card.textContent.match(/₫[\s]*[0-9.,]+/)?.[0] || null;
});
console.log('Card price:', cardPrice);

// Click title card to open details
await page.locator('div.product-title.style-scope.ytshopping-product[role="button"]').first().click();
await page.waitForTimeout(1000);

// Get price from product details dialog
const detailsPrice = await page.evaluate(() => {
    const details = document.querySelector('ytshopping-product-details');
    if (!details) return null;
    // Try metadata section
    const metadata = details.querySelector('.ytshoppingProductDetailsProductMetadata');
    if (metadata) return metadata.textContent.trim();
    return null;
});
console.log('Details metadata:', detailsPrice);

// Also get all price-like text from details
const allPrices = await page.evaluate(() => {
    const details = document.querySelector('ytshopping-product-details');
    if (!details) return [];
    const text = details.textContent;
    return text.match(/₫[\s]*[0-9.,]+|From\s*₫[\s]*[0-9.,]+/g) || [];
});
console.log('All prices in details:', allPrices);

await browser.close();
