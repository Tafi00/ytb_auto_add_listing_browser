import { chromium } from 'playwright';
console.log('SCRIPT START');
try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
    const page = browser.contexts()[0].pages()[0];
    const videoUrl = 'https://studio.youtube.com/video/IiO_XN86stU/edit';
    const productUrl = 'https://shopee.vn/product/645499489/29629325768';
    // This is the same Samsung Galaxy A56 product from the short URL test
    const title = 'Samsung Galaxy A56 5G 8GB/128GB Chính Hãng';
    console.log('Product URL:', productUrl);
    console.log('Expected title:', title);

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

    const tagBtn = page.locator('ytcp-icon-button.tag-product-button').first();
    try { await tagBtn.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { console.log('❌ No results'); await browser.close(); process.exit(0); }
    console.log('Results loaded');

    const ol = page.locator('ytshopping-product yt-formatted-string').filter({ hasText: /\d+\+?\s*options?/i }).first();
    const hasOptions = await ol.isVisible({ timeout: 2000 }).catch(() => false);
    console.log('hasOptions:', hasOptions);
    if (hasOptions) console.log('Options:', await ol.textContent());

    // Card title from YouTube
    const cardTitle = await page.evaluate(() => {
        const el = document.querySelector('ytshopping-product-picker-search-result .product-title');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
    console.log('YouTube card title:', cardTitle);

    if (hasOptions) {
        await page.locator('div.product-title.style-scope.ytshopping-product[role="button"]').first().click();
        console.log('Clicked title card');
        await page.waitForTimeout(800);

        const offerGroup = page.locator('.ytshoppingProductDetailsOfferGroupLabelContent').first();
        const offerVisible = await offerGroup.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('Offer group visible:', offerVisible);

        if (offerVisible) {
            await offerGroup.click();
            await page.locator('ytshopping-variant-selection').waitFor({ state: 'visible', timeout: 5000 });
            await page.waitForTimeout(500);
            const sw = page.locator('ytshopping-variant-selection .widgetsYtcpSwitchTrack.widgetsYtcpSwitchTrackActive').first();
            if (await sw.isVisible({ timeout: 2000 }).catch(() => false)) { await sw.click(); await page.waitForTimeout(500); }

            const allVariants = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('ytshopping-variant-selection-product')).map(c => ({
                    title: (c.querySelector('.ytshoppingVariantSelectionProductProductTitle')?.textContent || '').trim(),
                    price: (c.querySelector('yt-formatted-string[aria-label*="rice"]')?.textContent || '').trim(),
                }));
            });
            console.log(`${allVariants.length} variants`);

            const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
            const nT = norm(title);
            const eWords = new Set(nT.split(/\s+/).filter(w => w.length > 1));
            let bestIdx = -1, bestScore = -1;
            for (let i = 0; i < allVariants.length; i++) {
                const nV = norm(allVariants[i].title);
                let score = 0;
                if (nV === nT) score += 10;
                else if (nV.startsWith(nT) || nT.startsWith(nV)) score += 8;
                else if (nV.includes(nT) || nT.includes(nV)) score += 5;
                else {
                    const vWords = new Set(nV.split(/\s+/).filter(w => w.length > 1));
                    const common = [...eWords].filter(w => vWords.has(w)).length;
                    const overlap = eWords.size > 0 ? common / eWords.size : 0;
                    if (overlap >= 0.6) score += Math.round(overlap * 5);
                }
                if (score > 0) console.log(`  [${i}] score=${score} "${allVariants[i].title}"`);
                if (score > bestScore) { bestScore = score; bestIdx = i; }
            }
            if (bestIdx >= 0 && bestScore > 0) console.log(`\n✅ Best: [${bestIdx}] score=${bestScore}: "${allVariants[bestIdx].title}"`);
            else console.log('\n❌ No match — fallback first');
        } else {
            console.log('→ No offer group — fallback tag');
        }
    } else {
        console.log('→ No variants — normal tag');
    }

    await browser.close();
} catch (e) { console.error('ERROR:', e.message); }
