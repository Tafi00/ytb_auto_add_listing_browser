import { chromium } from 'playwright';
import { StudioInternalApi } from '../src/studio-internal-api.js';

const productUrl = process.argv[2];
const videoId = process.argv[3] || 'VNa64icfGAg';
if (!productUrl) {
    console.error('Usage: node scripts/test-shopping-mutation-api.mjs <product-url> [video-id]');
    process.exit(2);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
const page = browser.contexts()
    .flatMap(context => context.pages())
    .find(candidate => candidate.url().includes(`/video/${videoId}/`));
if (!page) {
    console.error(`No open Studio tab found for video ${videoId}`);
    process.exit(3);
}

const api = new StudioInternalApi(page).start();
let added = false;
const timings = {};
try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await api.waitUntilReady(10_000);

    let startedAt = Date.now();
    const { shoppingItemId } = await api.searchProduct(videoId, productUrl);
    timings.searchMs = Date.now() - startedAt;

    startedAt = Date.now();
    await api.updateProducts(videoId, [shoppingItemId]);
    added = true;
    timings.addMs = Date.now() - startedAt;

    startedAt = Date.now();
    await api.updateProducts(videoId, []);
    added = false;
    timings.removeMs = Date.now() - startedAt;

    console.log(JSON.stringify({
        ok: true,
        videoId,
        shoppingItemId,
        timings,
        totalApiMs: timings.searchMs + timings.addMs + timings.removeMs,
    }));
} catch (error) {
    console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        timings,
    }));
    process.exitCode = 1;
} finally {
    if (added) await api.updateProducts(videoId, []).catch(() => {});
    api.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit();
}
