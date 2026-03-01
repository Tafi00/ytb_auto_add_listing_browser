// Windows Worker - Connects to Linux server via WebSocket
// Run on Windows machine: npm run worker

import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const SERVER_URL = process.env.WORKER_SERVER_URL || 'ws://localhost:3002';
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'default-worker-token';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

// State
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let currentUrls = [];
let activeWorkers = []; // Chrome process workers
let _playwrightChromium = null;

// ==================== Playwright & Chrome ====================

async function getPlaywright() {
    if (!_playwrightChromium) {
        const pw = await import('playwright');
        _playwrightChromium = pw.chromium;
    }
    return _playwrightChromium;
}

function findChrome() {
    const paths = [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ].filter(Boolean);

    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function cleanLockFiles(dir) {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch { }
    }
}

async function launchBrowser(url, port, sessionDir) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH env var.');

    const userDataDir = path.join(sessionDir, 'browser-data');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    cleanLockFiles(userDataDir);

    const args = [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
        '--disable-infobars',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-component-update',
        '--disable-dev-shm-usage',
        '--disable-logging',
        '--disable-extensions',
        '--window-size=1200,800',
    ];

    const child = spawn(chromePath, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr.on('data', () => { });
    child.stdout.on('data', () => { });

    // Wait for debug port
    const start = Date.now();
    while (Date.now() - start < 15000) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) break;
        } catch { }
        await new Promise(r => setTimeout(r, 300));
    }

    // Navigate to URL
    if (url && url !== 'about:blank') {
        try {
            await new Promise(r => setTimeout(r, 500));
            const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
            const targets = await targetsRes.json();
            const pageTarget = targets.find(t => t.type === 'page');

            if (pageTarget) {
                const navWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
                await new Promise((resolve, reject) => {
                    navWs.on('open', () => {
                        navWs.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
                        navWs.on('message', (data) => {
                            const msg = JSON.parse(data.toString());
                            if (msg.id === 1) { navWs.close(); resolve(); }
                        });
                    });
                    navWs.on('error', reject);
                    setTimeout(() => { navWs.close(); resolve(); }, 10000);
                });
            }
        } catch (e) {
            log(`Could not navigate to URL: ${e.message}`);
        }
    }

    return child;
}

async function getChromePage(targetUrl) {
    const chromium = await getPlaywright();
    const targetBase = targetUrl ? targetUrl.split('?')[0] : null;
    let worker = targetUrl ? activeWorkers.find(w => w.url === targetUrl || w.url.startsWith(targetBase)) : null;

    if (!worker) {
        if (activeWorkers.length === 0) throw new Error('No browser running.');
        worker = activeWorkers[0];
    }

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${worker.port}`);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
        await browser.close();
        throw new Error(`No browser context found on port ${worker.port}.`);
    }
    const context = contexts[0];
    const pages = context.pages();

    let page;
    if (targetUrl) {
        page = pages.find(p => p.url() === targetUrl || p.url().startsWith(targetBase));
    }
    if (!page) {
        page = pages[0];
    }
    return { browser, context, page };
}

// ==================== Browser Automation ====================

async function addProduct(page, productUrl) {
    const btn = page.locator('button:has(div.ytcpButtonShapeImpl__button-text-content)').filter({
        hasText: /(Sản phẩm|Products|tagged product|sản phẩm đã gắn)/i
    }).first();

    const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');

    try {
        await Promise.race([
            editBtn.waitFor({ state: 'attached', timeout: 8000 }),
            btn.waitFor({ state: 'attached', timeout: 8000 })
        ]);
    } catch (e) { }

    const editVisible = await editBtn.isVisible().catch(() => false);
    if (!editVisible) {
        await btn.waitFor({ state: 'attached', timeout: 15000 });
        await btn.evaluate(b => b.click()).catch(async () => {
            await btn.click({ force: true }).catch(() => { });
        });
        log('Clicked Products row');
        await page.waitForTimeout(800);
    }

    await editBtn.waitFor({ state: 'attached', timeout: 10000 });
    await editBtn.evaluate(b => b.click()).catch(async () => {
        await editBtn.click({ force: true }).catch(() => { });
    });
    log('Clicked edit button');

    const searchInput = page.locator('input#search-input.search-input');
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });

    await searchInput.click();
    await searchInput.fill(productUrl);
    log(`Filled product URL: ${productUrl}`);

    await searchInput.press('Enter');
    log('Pressed Enter to search');

    // Remove existing products while search loads
    try {
        const allProducts = page.locator('ytshopping-product-picker-selected-product ytshopping-product');
        let productCount = await allProducts.count().catch(() => 0);
        if (productCount > 0) {
            log(`Found ${productCount} existing product(s), removing...`);
            while (productCount > 0) {
                const product = allProducts.first();
                const isVisible = await product.isVisible().catch(() => false);
                if (!isVisible) break;
                await product.hover();
                const deleteBtn = page.locator('ytcp-icon-button.delete-product-button[aria-label="Delete"]').first();
                await deleteBtn.waitFor({ state: 'visible', timeout: 10000 });
                await deleteBtn.click();
                await page.waitForTimeout(300);
                productCount = await allProducts.count().catch(() => 0);
            }
            log('All existing products removed');
        }
    } catch (e) {
        log(`Warning: could not remove existing products: ${e.message}`);
    }

    // Wait for search results
    const tagBtn = page.locator('ytcp-icon-button.tag-product-button[aria-label="Tag"]').first();
    try {
        await tagBtn.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
        log('Product not found within 8s, reloading page...');
        await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
        throw new Error('Sản phẩm này không gắn giỏ được.');
    }

    // Check banner error
    const bannerText = await page.evaluate(() => {
        const el = document.querySelector(".banner-title > ytcp-msg");
        return el ? el.textContent : null;
    }).catch(() => null);

    if (bannerText !== null) {
        log(`Banner message: "${bannerText}", product cannot be added. Reloading...`);
        await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
        throw new Error('Sản phẩm này không gắn giỏ được.');
    }

    await tagBtn.click();
    log('Clicked Tag button');

    const nextBtn = page.locator('ytcp-button#picker-next-button button').first();
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await nextBtn.click();
    log('Clicked Next button');

    const doneBtn = page.locator('button[aria-label="Done"]:has(div.ytcpButtonShapeImpl__button-text-content:text("Done"))').first();
    await doneBtn.waitFor({ state: 'visible', timeout: 10000 });
    await doneBtn.click();
    log('Clicked Done button');

    const saveBtn = page.locator('ytcp-button#save button').first();
    await saveBtn.waitFor({ state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    const isDisabled = await saveBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);

    if (isDisabled) {
        log('Save button is disabled (no changes). Proceeding directly.');
    } else {
        await saveBtn.evaluate(b => b.scrollIntoView()).catch(() => { });
        await saveBtn.click({ force: true }).catch(async () => {
            await saveBtn.evaluate(b => b.click());
        });
        log('Clicked Save button');
        await page.waitForTimeout(1500);
        log('Save clicked, proceeding to fetch after 1.5s');
    }
}

const decodeUnicode = (str) => str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

async function fetchAffiliateUrl(videoUrl) {
    const videoIdMatch = videoUrl.match(/\/video\/([^/]+)\//);
    if (!videoIdMatch) throw new Error('Could not extract video ID from URL');
    const videoId = videoIdMatch[1];
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    log(`Fetching public video: ${publicUrl}`);

    let affiliateUrl = null;
    let metadata = { title: '', price: '', image: '' };

    for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
            log(`Attempt ${attempt} fetchAffiliateUrl retrying after 200ms...`);
            await new Promise(r => setTimeout(r, 200));
        }

        const fetchStart = Date.now();
        const response = await fetch(publicUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html',
            }
        });
        const pageContent = await response.text();
        log(`Fetched page in ${Date.now() - fetchStart}ms (${(pageContent.length / 1024).toFixed(0)}KB)`);

        const allUrlMatches = [...pageContent.matchAll(/"url"\s*:\s*"(https:\/\/[^"]*(shopee\.vn|shp\.ee|lazada\.vn)[^"]*)"/g)];
        const urlMatch = allUrlMatches.length > 0 ? allUrlMatches[0] : null;
        if (urlMatch) {
            affiliateUrl = decodeUnicode(urlMatch[1]);

            const blockMarker = 'productListItemRenderer":{"title"';
            const blockStart = pageContent.indexOf(blockMarker);
            if (blockStart !== -1) {
                const block = pageContent.substring(blockStart, blockStart + 5000);

                const titleMatch = block.match(/simpleText":"([^"]+)"/);
                if (titleMatch) metadata.title = decodeUnicode(titleMatch[1]);

                const priceMatch = block.match(/([0-9][0-9.,]+)\s*₫/) || block.match(/₫\s*([0-9][0-9,.]+)/);
                if (priceMatch) metadata.price = decodeUnicode(priceMatch[1]) + ' ₫';

                const thumbUrls = [...block.matchAll(/(https?:\/\/encrypted-tbn\d+\.gstatic\.com\/shopping\?q=tbn:[A-Za-z0-9_-]+)/g)]
                    .map(m => decodeUnicode(m[1]));
                if (thumbUrls.length > 0) metadata.image = thumbUrls[0];
            }
            break;
        }

        log(`Attempt ${attempt} fetchAffiliateUrl failed to find affiliate link`);
    }

    log('Extracted metadata: ' + JSON.stringify(metadata));
    return { affiliateUrl, metadata };
}

// ==================== Job Execution ====================

async function executeJob(jobId, targetUrl, productUrl) {
    const jobStart = Date.now();
    log(`Job START: ${productUrl} on tab: ${targetUrl}`);

    const { browser, page } = await getChromePage(targetUrl);
    try {
        await page.bringToFront().catch(() => { });
        await page.waitForTimeout(300);

        await addProduct(page, productUrl);
        const addProductTime = Date.now() - jobStart;
        log(`addProduct took ${addProductTime}ms`);

        const fetchStart = Date.now();
        const data = await fetchAffiliateUrl(targetUrl);
        log(`fetchAffiliateUrl took ${Date.now() - fetchStart}ms`);
        log(`Total job time: ${Date.now() - jobStart}ms`);
        log(`Affiliate URL: ${data.affiliateUrl}`);

        await browser.close().catch(() => { });
        return { success: true, affiliateUrl: data.affiliateUrl, metadata: data.metadata };
    } catch (e) {
        log(`Error during job: ${e.message}`);
        try {
            await page.reload({ waitUntil: 'commit', timeout: 15000 });
            log('Page reloaded after error');
        } catch (reloadErr) {
            log(`Failed to reload page: ${reloadErr.message}`);
        }
        await browser.close().catch(() => { });
        return { success: false, error: e.message };
    }
}

// ==================== Browser Management ====================

async function openBrowsers(urls) {
    // Kill existing workers
    for (const w of activeWorkers) {
        try { w.process.kill(); } catch { }
    }
    activeWorkers = [];

    await new Promise(r => setTimeout(r, 500));

    const sessionsDir = path.resolve(__dirname, '..', SESSIONS_DIR);
    let startPort = 19222;

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const port = startPort + i;
        const sessionDir = path.join(sessionsDir, `worker-${i}`);

        // Prepare session directory
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        try {
            const child = await launchBrowser(url, port, sessionDir);
            activeWorkers.push({ process: child, port, url });
            log(`Browser ${i} opened on port ${port} for URL: ${url}`);
        } catch (e) {
            log(`Failed to launch browser ${i}: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 500));
    }
}

// ==================== WebSocket Connection ====================

function log(msg) {
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`[Worker ${timestamp}] ${msg}`);

    // Also send log to server
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'log', message: msg }));
        } catch { }
    }
}

function connect() {
    const wsUrl = `${SERVER_URL}/ws/worker?token=${encodeURIComponent(WORKER_AUTH_TOKEN)}`;
    log(`Đang kết nối đến server: ${SERVER_URL}...`);

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        log('✅ Đã kết nối đến server!');
        reconnectDelay = 1000;

        // Register with server
        ws.send(JSON.stringify({
            type: 'register',
            urls: activeWorkers.map(w => w.url),
            hostname: os.hostname(),
        }));
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'config-update') {
                // Server sends updated URLs
                const newUrls = msg.urls || [];
                log(`Nhận cấu hình mới: ${newUrls.length} URLs`);

                // Check if URLs changed
                const urlsChanged = JSON.stringify(newUrls.sort()) !== JSON.stringify(currentUrls.sort());
                if (urlsChanged && newUrls.length > 0) {
                    currentUrls = newUrls;
                    await openBrowsers(newUrls);

                    // Re-register with new URLs
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'register',
                            urls: activeWorkers.map(w => w.url),
                            hostname: os.hostname(),
                        }));
                    }
                } else if (newUrls.length > 0 && activeWorkers.length === 0) {
                    // First config, open browsers
                    currentUrls = newUrls;
                    await openBrowsers(newUrls);

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'register',
                            urls: activeWorkers.map(w => w.url),
                            hostname: os.hostname(),
                        }));
                    }
                }

            } else if (msg.type === 'execute-job') {
                // Execute job
                const { jobId, targetUrl, productUrl } = msg;
                log(`Nhận job: ${jobId} - ${productUrl}`);

                const result = await executeJob(jobId, targetUrl, productUrl);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'job-result',
                        jobId,
                        ...result,
                    }));
                }

            } else if (msg.type === 'heartbeat-ack') {
                // Server acknowledged heartbeat
            }
        } catch (e) {
            log(`Lỗi xử lý message: ${e.message}`);
        }
    });

    ws.on('close', () => {
        log(`Mất kết nối. Thử lại sau ${reconnectDelay / 1000}s...`);
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        log(`Lỗi WebSocket: ${err.message}`);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Max 30s
        connect();
    }, reconnectDelay);
}

// Heartbeat every 30s
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
}, 30000);

// Clean up dead browser processes
setInterval(() => {
    activeWorkers = activeWorkers.filter(w => {
        try {
            process.kill(w.process.pid, 0);
            return true;
        } catch {
            return false;
        }
    });
}, 5000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('Đang tắt worker...');
    for (const w of activeWorkers) {
        try { w.process.kill(); } catch { }
    }
    if (ws) ws.close();
    process.exit(0);
});

// ==================== Main ====================

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  YouTube Auto Listing - Windows Worker');
    console.log('═══════════════════════════════════════════');
    console.log(`  Server URL: ${SERVER_URL}`);
    console.log(`  Hostname: ${os.hostname()}`);
    console.log('');

    connect();
}

main().catch(console.error);
