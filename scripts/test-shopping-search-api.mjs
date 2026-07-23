import { chromium } from 'playwright';
import { StudioInternalApi } from '../src/studio-internal-api.js';

const productUrl = process.argv[2];
const videoId = process.argv[3] || 'VNa64icfGAg';
if (!productUrl) {
    console.error('Usage: node scripts/test-shopping-search-api.mjs <product-url> [video-id]');
    process.exit(2);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
const contexts = browser.contexts();
const pages = contexts.flatMap(context => context.pages());
const page = pages.find(candidate => candidate.url().includes(`/video/${videoId}/`));
if (!page) {
    console.error(`No open Studio tab found for video ${videoId}`);
    process.exit(3);
}

const api = new StudioInternalApi(page).start();
try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await api.waitUntilReady(10_000);
    const startedAt = Date.now();
    const { shoppingItemId } = await api.searchProduct(videoId, productUrl);
    console.log(JSON.stringify({
        ok: true,
        videoId,
        shoppingItemId,
        elapsedMs: Date.now() - startedAt,
    }));
} catch (error) {
    console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
} finally {
    api.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit();
}
