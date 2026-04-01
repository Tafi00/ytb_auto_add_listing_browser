// Windows Worker - Connects to Linux server via WebSocket
// Run on Windows machine: npm run worker

import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const SERVER_URL = process.env.WORKER_SERVER_URL || 'ws://localhost:3002';
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'default-worker-token';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
let headlessMode = process.env.HEADLESS === 'true';
const CONTROL_PANEL_PORT = parseInt(process.env.CONTROL_PANEL_PORT || '19200');

// State
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let connectionEnabled = true; // Bật/tắt kết nối server
let currentUrls = [];
let activeWorkers = []; // Chrome process workers
let _playwrightChromium = null;
let recentLogs = []; // Keep last 100 logs for control panel
let jobStats = { total: 0, success: 0, failed: 0 };

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

    if (headlessMode) {
        args.push(
            '--headless=new',                     // New headless - cùng engine render như headed
            '--disable-gpu',                      // Tránh lỗi GPU trong headless
            '--no-sandbox',                       // Cần cho headless trên một số môi trường
            '--disable-blink-features=AutomationControlled', // Ẩn flag webdriver
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        );
        log('Running in HEADLESS mode (--headless=new)');
    }

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
                const deleteBtn = page.locator('ytcp-icon-button.delete-product-button').first();
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
    const tagBtn = page.locator('ytcp-icon-button.tag-product-button').first();
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

    const doneBtn = page.locator('ytcp-button#picker-done-button button, button[aria-label="Done"], button[aria-label="Xong"]').first();
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
    const defaultDataDir = path.join(sessionsDir, 'default', 'browser-data');
    let startPort = 19222;

    // Dirs to skip when cloning (cache = large & unnecessary)
    const SKIP_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache',
        'ShaderCache', 'Service Worker', 'ScriptCache', 'component_crx_cache'];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const port = startPort + i;
        const sessionDir = path.join(sessionsDir, `worker-${i}`);
        const browserDataDir = path.join(sessionDir, 'browser-data');

        // Auto-clone from default profile if this worker has no session data
        if (!fs.existsSync(path.join(browserDataDir, 'Local State')) && fs.existsSync(path.join(defaultDataDir, 'Local State'))) {
            try {
                if (fs.existsSync(browserDataDir)) fs.rmSync(browserDataDir, { recursive: true, force: true });
                fs.cpSync(defaultDataDir, browserDataDir, {
                    recursive: true,
                    filter: (src) => !SKIP_DIRS.includes(path.basename(src)),
                });
                cleanLockFiles(browserDataDir);
                log(`📋 Auto-clone session → worker-${i}`);
            } catch (e) {
                log(`⚠️ Lỗi auto-clone worker-${i}: ${e.message}`);
            }
        }

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
    const logEntry = `[Worker ${timestamp}] ${msg}`;
    console.log(logEntry);

    // Keep recent logs for control panel
    recentLogs.push({ time: timestamp, message: msg });
    if (recentLogs.length > 100) recentLogs.shift();

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

                jobStats.total++;
                const result = await executeJob(jobId, targetUrl, productUrl);
                if (result.success) jobStats.success++; else jobStats.failed++;

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
        if (connectionEnabled) {
            log(`Mất kết nối. Thử lại sau ${reconnectDelay / 1000}s...`);
            scheduleReconnect();
        } else {
            log('Đã ngắt kết nối server.');
        }
    });

    ws.on('error', (err) => {
        log(`Lỗi WebSocket: ${err.message}`);
    });
}

function disconnect() {
    connectionEnabled = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
        try { ws.close(); } catch { }
        ws = null;
    }
    log('🔌 Đã ngắt kết nối server');
}

function scheduleReconnect() {
    if (!connectionEnabled) return;
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

// ==================== Control Panel HTTP Server ====================

async function restartBrowsers() {
    if (currentUrls.length > 0) {
        log(`Đang restart browsers (mode: ${headlessMode ? 'headless' : 'headed'})...`);
        await openBrowsers(currentUrls);

        // Re-register with server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'register',
                urls: activeWorkers.map(w => w.url),
                hostname: os.hostname(),
            }));
        }
        log('Restart browsers hoàn tất!');
    } else {
        log('Không có URL nào để mở browser.');
    }
}

function getControlPanelHTML() {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Worker Control Panel</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: #0f0f1a;
            color: #e0e0e0;
            min-height: 100vh;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 24px 16px;
        }
        .header {
            text-align: center;
            margin-bottom: 28px;
        }
        .header h1 {
            font-size: 22px;
            font-weight: 700;
            background: linear-gradient(135deg, #6366f1, #a855f7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 6px;
        }
        .header p {
            font-size: 13px;
            color: #888;
        }
        .card {
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 14px;
            padding: 20px;
            margin-bottom: 16px;
        }
        .card-title {
            font-size: 13px;
            font-weight: 600;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 14px;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
        }
        .stat {
            background: #12122a;
            border-radius: 10px;
            padding: 14px;
            text-align: center;
        }
        .stat-value {
            font-size: 26px;
            font-weight: 700;
            color: #fff;
        }
        .stat-value.green { color: #22c55e; }
        .stat-value.red { color: #ef4444; }
        .stat-value.blue { color: #6366f1; }
        .stat-value.yellow { color: #eab308; }
        .stat-label {
            font-size: 11px;
            color: #777;
            margin-top: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .toggle-section {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
        }
        .toggle-info {
            flex: 1;
            min-width: 200px;
        }
        .toggle-info h3 {
            font-size: 15px;
            font-weight: 600;
            color: #e0e0e0;
            margin-bottom: 4px;
        }
        .toggle-info p {
            font-size: 12px;
            color: #777;
        }
        .mode-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
        }
        .mode-badge.headless {
            background: rgba(234, 179, 8, 0.15);
            color: #eab308;
            border: 1px solid rgba(234, 179, 8, 0.3);
        }
        .mode-badge.headed {
            background: rgba(34, 197, 94, 0.15);
            color: #22c55e;
            border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .btn {
            padding: 10px 24px;
            border: none;
            border-radius: 10px;
            font-family: 'Inter', sans-serif;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .btn:active { transform: scale(0.97); }
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        .btn-primary {
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff;
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
        }
        .btn-primary:hover:not(:disabled) {
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.5);
        }
        .btn-secondary {
            background: #2a2a4a;
            color: #e0e0e0;
        }
        .btn-secondary:hover:not(:disabled) {
            background: #3a3a5a;
        }
        .btn-danger {
            background: linear-gradient(135deg, #dc2626, #ef4444);
            color: #fff;
        }
        .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .browser-list {
            list-style: none;
        }
        .browser-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            background: #12122a;
            border-radius: 8px;
            margin-bottom: 6px;
            font-size: 13px;
        }
        .browser-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #22c55e;
            flex-shrink: 0;
        }
        .browser-port {
            color: #6366f1;
            font-weight: 600;
            font-size: 12px;
            flex-shrink: 0;
        }
        .browser-url {
            color: #aaa;
            font-size: 12px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .log-box {
            background: #0a0a18;
            border: 1px solid #1a1a3a;
            border-radius: 8px;
            padding: 12px;
            max-height: 300px;
            overflow-y: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 11px;
            line-height: 1.7;
        }
        .log-line {
            color: #888;
        }
        .log-line .time {
            color: #555;
            margin-right: 6px;
        }
        .log-line .msg { color: #bbb; }
        .empty-state {
            text-align: center;
            padding: 20px;
            color: #555;
            font-size: 13px;
        }
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 500;
            z-index: 1000;
            transform: translateY(100px);
            opacity: 0;
            transition: all 0.3s;
        }
        .toast.show {
            transform: translateY(0);
            opacity: 1;
        }
        .toast.success {
            background: rgba(34, 197, 94, 0.15);
            border: 1px solid rgba(34, 197, 94, 0.3);
            color: #22c55e;
        }
        .toast.error {
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #ef4444;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚙️ Worker Control Panel</h1>
            <p id="hostname">Loading...</p>
        </div>

        <!-- Status -->
        <div class="card">
            <div class="card-title">Trạng thái</div>
            <div class="status-grid">
                <div class="stat">
                    <div class="stat-value" id="serverStatus">-</div>
                    <div class="stat-label">Server</div>
                </div>
                <div class="stat">
                    <div class="stat-value blue" id="browserCount">0</div>
                    <div class="stat-label">Browsers</div>
                </div>
                <div class="stat">
                    <div class="stat-value green" id="jobSuccess">0</div>
                    <div class="stat-label">Thành công</div>
                </div>
                <div class="stat">
                    <div class="stat-value red" id="jobFailed">0</div>
                    <div class="stat-label">Thất bại</div>
                </div>
            </div>
        </div>

        <!-- Browser Mode -->
        <div class="card">
            <div class="card-title">Chế độ Browser</div>
            <div class="toggle-section">
                <div class="toggle-info">
                    <h3>Hiển thị Browser <span class="mode-badge" id="modeBadge">...</span></h3>
                    <p>Khi tắt, browser chạy ngầm (headless). Khi bật, browser hiển thị cửa sổ.</p>
                </div>
                <div class="actions">
                    <button class="btn btn-primary" id="toggleBtn" onclick="toggleHeadless()">
                        🔄 Đang tải...
                    </button>
                </div>
            </div>
        </div>

        <!-- Extra Actions -->
        <div class="card">
            <div class="card-title">Hành động</div>
            <div class="actions">
                <button class="btn btn-secondary" onclick="restartBrowsers()">🔄 Restart Browsers</button>
            </div>
        </div>

        <!-- Active Browsers -->
        <div class="card">
            <div class="card-title">Browsers đang chạy</div>
            <ul class="browser-list" id="browserList">
                <li class="empty-state">Chưa có browser nào</li>
            </ul>
        </div>

        <!-- Logs -->
        <div class="card">
            <div class="card-title">Logs gần đây</div>
            <div class="log-box" id="logBox">
                <div class="empty-state">Chưa có log</div>
            </div>
        </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
        let refreshTimer;

        function showToast(msg, type = 'success') {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast ' + type + ' show';
            setTimeout(() => t.classList.remove('show'), 3000);
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                document.getElementById('hostname').textContent = data.hostname + ' • ' + data.serverUrl;
                document.getElementById('serverStatus').textContent = data.wsConnected ? '🟢' : '🔴';
                document.getElementById('serverStatus').className = 'stat-value';
                document.getElementById('browserCount').textContent = data.browsers.length;
                document.getElementById('jobSuccess').textContent = data.jobStats.success;
                document.getElementById('jobFailed').textContent = data.jobStats.failed;

                // Mode badge
                const badge = document.getElementById('modeBadge');
                if (data.headless) {
                    badge.textContent = 'TẮT';
                    badge.className = 'mode-badge headless';
                } else {
                    badge.textContent = 'BẬT';
                    badge.className = 'mode-badge headed';
                }

                // Toggle button
                const btn = document.getElementById('toggleBtn');
                if (data.headless) {
                    btn.innerHTML = '👁️ Bật hiển thị';
                } else {
                    btn.innerHTML = '🙈 Tắt hiển thị';
                }

                // Browser list
                const list = document.getElementById('browserList');
                if (data.browsers.length === 0) {
                    list.innerHTML = '<li class="empty-state">Chưa có browser nào</li>';
                } else {
                    list.innerHTML = data.browsers.map(b =>
                        '<li class="browser-item">' +
                        '<span class="browser-dot"></span>' +
                        '<span class="browser-port">:' + b.port + '</span>' +
                        '<span class="browser-url">' + b.url + '</span>' +
                        '</li>'
                    ).join('');
                }

                // Logs
                const logBox = document.getElementById('logBox');
                if (data.logs.length === 0) {
                    logBox.innerHTML = '<div class="empty-state">Chưa có log</div>';
                } else {
                    logBox.innerHTML = data.logs.map(l =>
                        '<div class="log-line"><span class="time">' + l.time + '</span><span class="msg">' +
                        l.message.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>'
                    ).join('');
                    logBox.scrollTop = logBox.scrollHeight;
                }
            } catch (e) {
                console.error('Fetch status error:', e);
            }
        }

        async function toggleHeadless() {
            const btn = document.getElementById('toggleBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Đang chuyển...';
            try {
                const res = await fetch('/api/toggle-headless', { method: 'POST' });
                const data = await res.json();
                showToast(data.headless ? '🙈 Đã chuyển sang headless' : '👁️ Đã bật hiển thị browser');
                await fetchStatus();
            } catch (e) {
                showToast('Lỗi: ' + e.message, 'error');
            }
            btn.disabled = false;
        }

        async function restartBrowsers() {
            if (!confirm('Restart tất cả browsers?')) return;
            showToast('Đang restart...');
            try {
                const res = await fetch('/api/restart-browsers', { method: 'POST' });
                const data = await res.json();
                showToast('✅ ' + data.message);
                await fetchStatus();
            } catch (e) {
                showToast('Lỗi: ' + e.message, 'error');
            }
        }

        // Auto refresh every 2s
        fetchStatus();
        refreshTimer = setInterval(fetchStatus, 2000);
    </script>
</body>
</html>`;
}

function startControlPanel() {
    const server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = new URL(req.url, `http://localhost:${CONTROL_PANEL_PORT}`);

        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getControlPanelHTML());
        } else if (url.pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                hostname: os.hostname(),
                serverUrl: SERVER_URL,
                headless: headlessMode,
                connectionEnabled,
                wsConnected: ws && ws.readyState === WebSocket.OPEN,
                browsers: activeWorkers.map(w => ({ port: w.port, url: w.url })),
                jobStats,
                logs: recentLogs.slice(-50),
            }));
        } else if (url.pathname === '/api/toggle-headless' && req.method === 'POST') {
            headlessMode = !headlessMode;
            log(`Chuyển sang mode: ${headlessMode ? 'HEADLESS' : 'HEADED'}`);
            // Restart browsers with new mode
            await restartBrowsers().catch(e => log(`Lỗi restart: ${e.message}`));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ headless: headlessMode, message: 'OK' }));
        } else if (url.pathname === '/api/restart-browsers' && req.method === 'POST') {
            await restartBrowsers().catch(e => log(`Lỗi restart: ${e.message}`));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Đã restart ${activeWorkers.length} browser(s)` }));
        } else if (url.pathname === '/api/toggle-connection' && req.method === 'POST') {
            if (connectionEnabled) {
                disconnect();
            } else {
                connectionEnabled = true;
                reconnectDelay = 1000;
                connect();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ connectionEnabled, message: 'OK' }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    let tryPort = CONTROL_PANEL_PORT;
    const maxRetries = 5;

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && tryPort < CONTROL_PANEL_PORT + maxRetries) {
            tryPort++;
            log(`⚠️ Port ${tryPort - 1} đang bị chiếm, thử port ${tryPort}...`);
            server.listen(tryPort);
        } else if (err.code === 'EADDRINUSE') {
            log(`⚠️ Không tìm được port trống cho Control Panel. Worker vẫn chạy bình thường.`);
        } else {
            log(`⚠️ Lỗi Control Panel: ${err.message}`);
        }
    });

    server.listen(tryPort, () => {
        log(`🎛️ Control Panel: http://localhost:${tryPort}`);
    });
}

// ==================== Main ====================

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  YouTube Auto Listing - Windows Worker');
    console.log('═══════════════════════════════════════════');
    console.log(`  Server URL: ${SERVER_URL}`);
    console.log(`  Hostname: ${os.hostname()}`);
    console.log(`  Headless: ${headlessMode ? 'YES (--headless=new)' : 'NO (headed)'}`);
    console.log(`  Control Panel: http://localhost:${CONTROL_PANEL_PORT}`);
    console.log('');

    startControlPanel();
    connect();
}

main().catch(console.error);
