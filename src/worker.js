// Windows Worker - Connects to Linux server via WebSocket
// Run on Windows machine: npm run worker

import 'dotenv/config';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import WebSocket from 'ws';
import { StudioInternalApi } from './studio-internal-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const SERVER_URL = process.env.WORKER_SERVER_URL || 'ws://localhost:3002';
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'default-worker-token';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
let headlessMode = process.env.HEADLESS === 'true';
const CONTROL_PANEL_PORT = parseInt(process.env.CONTROL_PANEL_PORT || '19200');
const BROWSER_HEALTH_INTERVAL_MS = parseInt(process.env.BROWSER_HEALTH_INTERVAL_MS || '15000');
const PAGE_IDLE_REFRESH_MS = parseInt(process.env.PAGE_IDLE_REFRESH_MS || `${30 * 60 * 1000}`);
const CHROME_ERROR_URL_PREFIX = 'chrome-error://';
const ENABLE_BROWSER_PUBLIC_FALLBACK = process.env.ENABLE_BROWSER_PUBLIC_FALLBACK === '1';
const USE_DIRECT_SHOPEE_AFFILIATE = process.env.USE_DIRECT_SHOPEE_AFFILIATE !== '0';
const USE_PROVIDED_LAZADA_AFFILIATE_FALLBACK = process.env.USE_PROVIDED_LAZADA_AFFILIATE_FALLBACK !== '0';
const USE_DIRECT_LAZADA_AFFILIATE = process.env.USE_DIRECT_LAZADA_AFFILIATE !== '0';
const USE_STUDIO_INTERNAL_API = process.env.USE_STUDIO_INTERNAL_API === '1';
const USE_LOCAL_STUDIO_API_URLS =
    USE_STUDIO_INTERNAL_API && process.env.STUDIO_API_USE_LOCAL_URLS !== '0';
const LAZADA_YOUTUBE_EXLAZ = process.env.LAZADA_YOUTUBE_EXLAZ || 'd_2:mm_254241245_236353075_2194553061:vn2880030:00:';

// State
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let connectionEnabled = true; // Bật/tắt kết nối server
let currentUrls = [];
let activeWorkers = []; // Chrome process workers
let browsersOpening = false;
let _playwrightChromium = null;
let recentLogs = []; // Keep last 100 logs for control panel
let jobStats = { total: 0, success: 0, failed: 0 };
const pagesWithDialogHandler = new WeakSet();

function getRegistrationInfo() {
    if (!USE_STUDIO_INTERNAL_API) {
        return { workerType: 'browser', capabilities: [] };
    }
    return {
        workerType: 'studio-api',
        capabilities: ['local-video-pool', 'internal-metadata-api'],
    };
}

function loadLocalStudioApiUrls() {
    const apiConfigPath = path.resolve(__dirname, '..', 'studio-api.json');
    const androidConfigPath = path.resolve(__dirname, '..', 'android-worker.json');
    try {
        const configPath = fs.existsSync(apiConfigPath) ? apiConfigPath : androidConfigPath;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return [...new Set(
            (Array.isArray(config.video_urls) ? config.video_urls : [])
                .map(value => String(value || '').trim())
                .filter(Boolean),
        )];
    } catch (error) {
        console.error(`Không đọc được video_urls local cho API worker: ${error.message}`);
        return [];
    }
}

function saveLocalStudioApiUrls(urls) {
    const configPath = path.resolve(__dirname, '..', 'studio-api.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ video_urls: urls }, null, 2)}\n`, 'utf8');
}

// ==================== Playwright & Chrome ====================

async function getPlaywright() {
    if (!_playwrightChromium) {
        const pw = await import('playwright');
        _playwrightChromium = pw.chromium;
    }
    return _playwrightChromium;
}

async function connectWorkerBrowser(worker, timeout = 10000) {
    if (worker.cdpBrowser?.isConnected?.()) return worker.cdpBrowser;

    worker.cdpBrowser = null;
    const chromium = await getPlaywright();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${worker.port}`, { timeout });
    worker.cdpBrowser = browser;
    browser.once?.('disconnected', () => {
        if (worker.cdpBrowser === browser) worker.cdpBrowser = null;
    });
    return browser;
}

function forgetWorkerBrowser(worker, browser = null) {
    if (!worker) return;
    if (!browser || worker.cdpBrowser === browser) worker.cdpBrowser = null;
}

async function disconnectBrowser() {
    // Intentionally a no-op for connectOverCDP browsers. Calling browser.close()
    // closes the real Chrome instance, and closing the internal Playwright
    // connection can poison later CDP attaches. Keep one connection per worker.
}

function shortErrorMessage(error) {
    return (error?.message || String(error))
        .replace(/(?:browserType\.connectOverCDP:\s*){2,}/g, 'browserType.connectOverCDP: ')
        .replace(/(?:browserContext\.newPage:\s*){2,}/g, 'browserContext.newPage: ')
        .replace(/(?:page\.(?:close|evaluate|removeListener|title):\s*){2,}/g, '')
        .slice(0, 500);
}

function createWorkerError(message, code, stage, retryable = false) {
    const error = new Error(message);
    error.code = code;
    error.stage = stage;
    error.retryable = retryable;
    return error;
}

function serializeJobError(error) {
    const raw = shortErrorMessage(error);
    let code = error?.code || 'WORKER_ERROR';
    let stage = error?.stage || 'worker';
    let retryable = Boolean(error?.retryable);
    let message = raw;

    if (!error?.code && /affiliate|public shelf|product shelf/i.test(raw)) {
        code = 'AFFILIATE_NOT_READY';
        stage = 'affiliate-lookup';
        retryable = true;
        message = 'YouTube đã nhận sản phẩm nhưng link affiliate công khai chưa cập nhật kịp. Vui lòng thử lại.';
    } else if (!error?.code && /No browser found|browser.*video URL/i.test(raw)) {
        code = 'VIDEO_NOT_READY';
        stage = 'browser-session';
        retryable = true;
        message = 'Tab video chưa sẵn sàng trên API worker.';
    } else if (!error?.code && /Target page|Browser closed|Connection closed|CDP/i.test(raw)) {
        code = 'BROWSER_DISCONNECTED';
        stage = 'browser-session';
        retryable = true;
        message = 'Chrome nền bị mất kết nối. Worker sẽ mở lại phiên video.';
    } else if (!error?.code && /timeout|timed out/i.test(raw)) {
        code = 'WORKER_TIMEOUT';
        stage = 'worker';
        retryable = true;
        message = 'Worker xử lý quá thời gian chờ.';
    }

    return {
        error: message,
        errorCode: code,
        errorStage: stage,
        retryable,
        ...(error?.cleanupSucceeded === false ? {
            cleanupSucceeded: false,
            cleanupError: error.cleanupError || 'Không thể xác nhận đã gỡ sản phẩm.',
        } : {}),
    };
}

function isTargetClosedError(error) {
    return /Target page, context or browser has been closed|Browser closed|Connection closed|Session closed/i
        .test(error?.message || String(error));
}

async function acquireCdpLock(worker, owner, { wait = false, timeout = 15000 } = {}) {
    const start = Date.now();
    while (worker.cdpLocked) {
        if (!wait || Date.now() - start > timeout) return false;
        await new Promise(r => setTimeout(r, 100));
    }
    worker.cdpLocked = owner;
    return true;
}

function releaseCdpLock(worker, owner) {
    if (!worker) return;
    if (!owner || worker.cdpLocked === owner) worker.cdpLocked = null;
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

function cleanSessionRestoreState(userDataDir) {
    const defaultDir = path.join(userDataDir, 'Default');
    if (!fs.existsSync(defaultDir)) return;

    // Chrome stores the tabs it should restore here. Keeping these files after a
    // forced restart can reopen many stale YouTube Studio tabs and exhaust RAM.
    for (const name of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
        try { fs.rmSync(path.join(defaultDir, name), { recursive: true, force: true }); } catch { }
    }

    const preferencesPath = path.join(defaultDir, 'Preferences');
    try {
        if (!fs.existsSync(preferencesPath)) return;
        const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8').replace(/^\uFEFF/, ''));
        preferences.profile = preferences.profile || {};
        preferences.profile.exit_type = 'Normal';
        preferences.profile.exited_cleanly = true;

        if (preferences.session?.restore_on_startup === 1) {
            delete preferences.session.restore_on_startup;
            delete preferences.session.startup_urls;
        }

        fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
    } catch { }
}

function prepareProfileForLaunch(userDataDir) {
    cleanLockFiles(userDataDir);
    cleanSessionRestoreState(userDataDir);
}

function isProcessAlive(child) {
    if (!child || child.killed || !child.pid) return false;
    try {
        process.kill(child.pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForDebugPort(port, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) return true;
        } catch { }
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function waitForDebugPortClosed(port, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (!await waitForDebugPort(port, 250)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

async function waitForProcessExit(child, timeout = 5000) {
    if (!isProcessAlive(child)) return true;
    return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(!isProcessAlive(child)), timeout);
        child.once?.('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

function killProcessTree(childOrPid, force = true) {
    const pid = typeof childOrPid === 'number' ? childOrPid : childOrPid?.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
        const args = [force ? '/F' : null, '/T', '/PID', String(pid)].filter(Boolean);
        try { execFileSync('taskkill', args, { stdio: 'ignore' }); } catch { }
        return;
    }

    try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { }
}

async function sendBrowserClose(port) {
    try {
        const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!versionRes.ok) return false;
        const version = await versionRes.json();
        if (!version.webSocketDebuggerUrl) return false;

        const closeWs = new WebSocket(version.webSocketDebuggerUrl);
        return await new Promise(resolve => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                try { closeWs.close(); } catch { }
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), 2500);
            closeWs.on('open', () => {
                closeWs.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            });
            closeWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === 1) {
                        clearTimeout(timer);
                        finish(true);
                    }
                } catch { }
            });
            closeWs.on('close', () => {
                clearTimeout(timer);
                finish(true);
            });
            closeWs.on('error', () => {
                clearTimeout(timer);
                finish(false);
            });
        });
    } catch {
        return false;
    }
}

async function stopWorkerBrowser(worker, reason = 'restart') {
    if (!worker?.process) return;

    log(`[Recovery] Closing browser on port ${worker.port}: ${reason}`);
    if (worker.port && await waitForDebugPort(worker.port, 800)) {
        await sendBrowserClose(worker.port);
        await waitForProcessExit(worker.process, 4000);
    }

    if (isProcessAlive(worker.process)) {
        killProcessTree(worker.process, true);
        await waitForProcessExit(worker.process, 3000);
    }

    if (worker.port) await waitForDebugPortClosed(worker.port, 3000);
}

async function getPageTargets(port) {
    const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
    const targets = await targetsRes.json();
    return targets.filter(t => t.type === 'page');
}

function urlsMatch(actualUrl, targetUrl) {
    if (!actualUrl || !targetUrl) return false;
    return actualUrl === targetUrl || actualUrl.split('?')[0] === targetUrl.split('?')[0];
}

async function navigateTarget(target, url) {
    if (!url || url === 'about:blank') return;

    const navWs = new WebSocket(target.webSocketDebuggerUrl);
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

async function resetBrowserToSingleTab(port, url) {
    await new Promise(r => setTimeout(r, 500));

    let pageTargets = await getPageTargets(port);
    let keepTarget = pageTargets.find(t => urlsMatch(t.url, url))
        || pageTargets.find(t => t.url === 'about:blank' || t.url.startsWith('chrome://newtab'))
        || pageTargets[0];

    if (!keepTarget) return;

    await navigateTarget(keepTarget, url);

    pageTargets = await getPageTargets(port);
    keepTarget = pageTargets.find(t => urlsMatch(t.url, url)) || keepTarget;
    for (const target of pageTargets) {
        if (target.id === keepTarget.id) continue;
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => { });
    }
}

async function launchBrowser(url, port, sessionDir) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH env var.');

    const userDataDir = path.join(sessionDir, 'browser-data');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    prepareProfileForLaunch(userDataDir);

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
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-restore-session-state',
        '--noerrdialogs',
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
    const ready = await waitForDebugPort(port, 15000);
    if (!ready) throw new Error(`Chrome debugging port ${port} not ready after 15000ms`);

    // Navigate to URL and close restored/stale tabs immediately.
    if (url && url !== 'about:blank') {
        try {
            await resetBrowserToSingleTab(port, url);
        } catch (e) {
            log(`Could not navigate to URL: ${e.message}`);
        }
    }

    return child;
}

function findWorkerForTargetUrl(targetUrl) {
    const targetBase = targetUrl ? targetUrl.split('?')[0] : null;
    return targetUrl
        ? activeWorkers.find(w => w.url === targetUrl || w.url.split('?')[0] === targetBase)
        : activeWorkers[0];
}

function workerProcessIsAlive(worker) {
    return isProcessAlive(worker?.sharedApiOwner?.process || worker?.process);
}

async function getChromePage(targetUrl, reservedWorker = null) {
    const targetBase = targetUrl ? targetUrl.split('?')[0] : null;
    let worker = reservedWorker || findWorkerForTargetUrl(targetUrl);

    if (!worker) {
        if (activeWorkers.length === 0) throw new Error('No browser running.');
        // Do NOT fallback to activeWorkers[0] - that causes cross-contamination
        throw new Error(`No browser found for URL: ${targetUrl}`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser = null;
        try {
            if (!workerProcessIsAlive(worker) || !await waitForDebugPort(worker.port, 3000)) {
                log(`[Recovery] Browser on port ${worker.port} is not reachable. Restarting...`);
                worker = await restartWorkerBrowser(worker, 'debug port not reachable');
                worker.busy = true;
            }

            browser = await connectWorkerBrowser(worker, 10000);
            const contexts = browser.contexts();
            if (contexts.length === 0) {
                throw new Error(`No browser context found on port ${worker.port}.`);
            }
            const context = contexts[0];
            const pages = context.pages();

            let page;
            if (targetUrl) {
                page = pages.find(p => p.url() === targetUrl || p.url().split('?')[0] === targetBase);
            }
            if (!page) {
                page = await recoverWorkerPage(browser, context, worker, 'matching page missing');
            } else if (await isChromeCrashPage(page)) {
                page = await recoverWorkerPage(browser, context, worker, 'Chrome crash page');
            }
            setupPageDialogHandler(page, worker.port);

            return { browser, context, page, worker };
        } catch (e) {
            lastError = e;
            forgetWorkerBrowser(worker, browser);
            log(`[Recovery] connectOverCDP failed on port ${worker.port} (attempt ${attempt}/3): ${shortErrorMessage(e)}`);

            if (!workerProcessIsAlive(worker) || isTargetClosedError(e)) {
                const reason = isTargetClosedError(e)
                    ? 'CDP target closed while connecting'
                    : 'Chrome process exited while connecting';
                worker = await restartWorkerBrowser(worker, reason);
                worker.busy = true;
                await new Promise(r => setTimeout(r, 1000));
            }

            if (attempt < 3) await new Promise(r => setTimeout(r, 700 * attempt));
        }
    }

    throw new Error(`Không kết nối được browser trên port ${worker.port}: ${shortErrorMessage(lastError)}`);
}

// Setup persistent dialog handler for a page to auto-dismiss YouTube alerts
function setupPageDialogHandler(page, port) {
    if (pagesWithDialogHandler.has(page)) return;
    pagesWithDialogHandler.add(page);
    page.on('dialog', async (dialog) => {
        log(`[Port ${port}] Unexpected dialog: "${dialog.message()}" — auto-dismissing`);
        await dialog.dismiss().catch(() => { });
    });
}

async function isChromeCrashPage(page) {
    try {
        const url = page.url();
        if (url.startsWith(CHROME_ERROR_URL_PREFIX)) return true;

        const title = await page.title().catch(() => '');
        if (/aw,\s*snap|out of memory/i.test(title)) return true;

        return await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            return /Aw,\s*Snap!|Error code:\s*Out of Memory/i.test(bodyText);
        }).catch(() => true);
    } catch {
        return true;
    }
}

async function closeExtraPages(context, keepPage) {
    for (const page of context.pages()) {
        if (page === keepPage) continue;
        const url = page.url();
        if (url === 'about:blank' || url.startsWith(CHROME_ERROR_URL_PREFIX) || /studio\.youtube\.com/.test(url)) {
            await page.close().catch(() => { });
        }
    }
}

async function recoverWorkerPage(browser, context, worker, reason) {
    log(`[Recovery] Port ${worker.port}: ${reason}. Reopening ${worker.url}`);

    const existingPages = context.pages();
    const page = existingPages[0] || await context.newPage();
    setupPageDialogHandler(page, worker.port);
    await page.goto(worker.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async (e) => {
        log(`[Recovery] goto failed on port ${worker.port}: ${e.message}. Retrying with commit...`);
        await page.goto(worker.url, { waitUntil: 'commit', timeout: 30000 }).catch(() => { });
    });
    await page.waitForTimeout(2000);
    if (!USE_STUDIO_INTERNAL_API) {
        await closeExtraPages(context, page);
    }
    worker.lastRecoveredAt = Date.now();
    worker.lastRefreshAt = Date.now();

    if (await isChromeCrashPage(page)) {
        await disconnectBrowser(browser);
        await restartWorkerBrowser(worker, 'page still crashed after reopen');
        throw new Error(`Browser on port ${worker.port} was restarted after repeated Chrome crash. Please retry the job.`);
    }

    return page;
}

async function restartWorkerBrowser(worker, reason = 'unknown') {
    if (worker.restarting) {
        log(`[Recovery] Restart already in progress on port ${worker.port}, skip: ${reason}`);
        return worker;
    }

    worker.restarting = true;
    try {
        log(`[Recovery] Restarting browser on port ${worker.port}: ${reason}`);
        forgetWorkerBrowser(worker);
        await stopWorkerBrowser(worker, reason);

        const child = await launchBrowser(worker.url, worker.port, worker.sessionDir);
        worker.process = child;
        worker.busy = false;
        worker.healthMisses = 0;
        worker.lastRecoveredAt = Date.now();
        worker.lastRefreshAt = Date.now();
        log(`[Recovery] Browser restarted on port ${worker.port}`);
        return worker;
    } finally {
        worker.restarting = false;
    }
}

// ==================== Browser Automation ====================

function normalizeMaybeUrl(url) {
    if (Array.isArray(url)) return normalizeMaybeUrl(url[0]);
    if (!url || typeof url !== 'string') return url || null;
    return url.startsWith('//') ? `https:${url}` : url;
}

function jsonLdTypeMatches(node, type) {
    const nodeType = node?.['@type'];
    return nodeType === type || (Array.isArray(nodeType) && nodeType.includes(type));
}

function parseLazadaTrackingData(html) {
    const match = html.match(/var\s+pdpTrackingData\s*=\s*"((?:\\.|[^"\\])*)"/);
    if (!match) return null;

    try {
        const jsonText = JSON.parse(`"${match[1]}"`);
        return JSON.parse(jsonText);
    } catch {
        try {
            return JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
        } catch {
            return null;
        }
    }
}

/**
 * Fetch product title/price from Shopee/Lazada using Facebook bot UA (SSR for social preview).
 * Retries up to 3 times with delay if rate-limited.
 * Returns { title, price, ... } or null.
 */
async function getProductInfo(productUrl) {
    const userAgents = [
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'WhatsApp/2.23.20.0',
        'facebookexternalhit/1.1',
    ];
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (attempt > 1) {
                const delay = attempt * 2000;
                log(`getProductInfo retry ${attempt} after ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
            const ua = userAgents[(attempt - 1) % userAgents.length];
            const res = await fetch(productUrl, {
                headers: {
                    'User-Agent': ua,
                    'Accept': 'text/html',
                },
                redirect: 'follow',
            });
            if (!res.ok) {
                log(`getProductInfo attempt ${attempt}: HTTP ${res.status}`);
                continue;
            }
            const html = await res.text();
            if (html.length < 1000) {
                log(`getProductInfo attempt ${attempt}: response too short (${html.length} bytes)`);
                continue;
            }

            // --- Parse JSON-LD structured data (most reliable source) ---
            let ld = null;
            const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
            for (const m of ldMatches) {
                try {
                    const parsed = JSON.parse(m[1]);
                    const nodes = Array.isArray(parsed) ? parsed : [parsed];
                    const productNode = nodes.find(node => jsonLdTypeMatches(node, 'Product'));
                    if (productNode) { ld = productNode; break; }
                } catch { }
            }

            // --- Parse OG meta tags as fallback ---
            const meta = (name) => {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\' + '$&');
                const patterns = [
                    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*?)["']`, 'i'),
                    new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
                ];
                for (const re of patterns) {
                    const m = html.match(re);
                    if (m) return m[1].trim();
                }
                return null;
            };

            const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            const cleanTitle = titleTag ? titleTag[1].replace(/\s*\|\s*(Shopee|Lazada).*$/i, '').trim() : null;
            const offer = ld?.offers || {};
            const lazadaTrackingData = parseLazadaTrackingData(html);
            const offerPrice = offer.price ?? offer.lowPrice ?? offer.highPrice ?? null;
            const trackingPrice = lazadaTrackingData?.pdt_price
                ? String(lazadaTrackingData.pdt_price).replace(/[^\d]/g, '') || String(lazadaTrackingData.pdt_price)
                : null;
            const seller = offer.seller || {};
            const sellerRating = seller.aggregateRating || {};
            const productRating = ld?.aggregateRating || {};

            const info = {
                // Basic
                title: (ld?.name || meta('og:title') || lazadaTrackingData?.pdt_name || cleanTitle || '').replace(/\s*\|\s*(Shopee|Lazada).*$/i, '').trim() || null,
                description: ld?.description?.trim() || meta('og:description') || null,
                image: normalizeMaybeUrl(ld?.image || meta('og:image') || lazadaTrackingData?.pdt_photo || null),
                url: ld?.url || meta('og:url') || productUrl,
                productID: ld?.productID || null,
                brand: ld?.brand || lazadaTrackingData?.brand_name || null,
                // Price
                price: offerPrice || meta('product:price:amount') || meta('og:price:amount') || trackingPrice || null,
                currency: offer.priceCurrency || meta('product:price:currency') || meta('og:price:currency') || lazadaTrackingData?.core?.currencyCode || null,
                condition: offer.itemCondition?.replace('http://schema.org/', '') || null,
                availability: offer.availability?.replace('http://schema.org/', '') || null,
                // Seller
                seller: seller.name || null,
                sellerUrl: seller.url || null,
                sellerImage: seller.image || null,
                sellerRating: sellerRating.ratingValue || null,
                sellerRatingCount: sellerRating.ratingCount || null,
                // Product rating
                rating: productRating.ratingValue || null,
                ratingCount: productRating.ratingCount || null,
                resolvedUrl: res.url || productUrl,
            };

            log(`Product info: title="${info.title}", price=${info.price || 'N/A'} ${info.currency || ''}, rating=${info.rating || 'N/A'}, seller="${info.seller || 'N/A'}"`);
            return info;
        } catch (e) {
            log(`getProductInfo attempt ${attempt} error: ${e.message}`);
            if (attempt === 3) return null;
        }
    }
    return null;
}

async function isProductDetailsOpen(page) {
    return await page.locator('ytshopping-product-details-dialog').first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
}

async function closeProductDetailsDialog(page) {
    if (!await isProductDetailsOpen(page)) return false;

    const closeBtn = page.locator([
        'ytshopping-product-details-dialog ytcp-icon-button[aria-label="Close"]',
        'ytshopping-product-details-dialog button[aria-label="Close"]',
        'ytshopping-product-details-dialog [aria-label="Close"]',
        'ytshopping-product-details-dialog ytcp-icon-button[aria-label="Đóng"]',
        'ytshopping-product-details-dialog button[aria-label="Đóng"]',
        'ytshopping-product-details-dialog [aria-label="Đóng"]',
    ].join(', ')).first();

    if (await closeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
        await closeBtn.click({ force: true }).catch(async () => {
            await closeBtn.evaluate(el => el.click()).catch(() => { });
        });
    } else {
        await page.keyboard.press('Escape').catch(() => { });
    }

    await page.locator('ytshopping-product-details-dialog').first()
        .waitFor({ state: 'hidden', timeout: 3000 })
        .catch(() => { });
    return true;
}

async function isPickerNextEnabled(page) {
    const pickerNextBtn = page.locator('ytcp-button#picker-next-button button').first();
    const visible = await pickerNextBtn.isVisible({ timeout: 300 }).catch(() => false);
    if (!visible) return false;

    return await pickerNextBtn.evaluate(btn => {
        const host = btn.closest('ytcp-button');
        const disabled = btn.disabled
            || btn.getAttribute('aria-disabled') === 'true'
            || host?.getAttribute('aria-disabled') === 'true'
            || host?.hasAttribute('disabled');
        return !disabled;
    }).catch(() => false);
}

async function waitForTagClickOutcome(page, timeout = 2500) {
    const selectedProduct = page.locator('ytshopping-product-picker-selected-product ytshopping-product');
    const start = Date.now();

    while (Date.now() - start < timeout) {
        if (await isPickerNextEnabled(page)) return 'next-enabled';
        if (await selectedProduct.first().isVisible({ timeout: 200 }).catch(() => false)) return 'selected-product';
        if (await isProductDetailsOpen(page)) return 'details-opened';
        await page.waitForTimeout(150);
    }

    return null;
}

async function getPickerSelectedProductCount(page) {
    return await page.evaluate(() =>
        document.querySelectorAll('ytshopping-product-picker-selected-product ytshopping-product').length
    ).catch(() => 0);
}

async function clickPickerNextButton(page) {
    const nextBtn = page.locator('ytcp-button#picker-next-button button').first();
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });

    await page.waitForFunction(() => {
        const selectedCount = document.querySelectorAll('ytshopping-product-picker-selected-product ytshopping-product').length;
        const btn = document.querySelector('ytcp-button#picker-next-button button');
        const host = document.querySelector('ytcp-button#picker-next-button');
        if (!btn || selectedCount <= 0) return false;
        return !btn.disabled
            && btn.getAttribute('aria-disabled') !== 'true'
            && host?.getAttribute('aria-disabled') !== 'true'
            && !host?.hasAttribute('disabled');
    }, null, { timeout: 12000 }).catch(() => { });

    const selectedCount = await getPickerSelectedProductCount(page);
    const enabled = await isPickerNextEnabled(page);
    log(`Picker selected products: ${selectedCount}; Next enabled: ${enabled ? 'yes' : 'no'}`);
    if (!enabled) throw new Error('Next button is not enabled after tagging product.');

    for (let attempt = 1; attempt <= 3; attempt++) {
        let method = null;
        if (attempt === 1) {
            method = 'playwright';
            await nextBtn.click({ timeout: 3000 }).catch(() => { method = null; });
        }

        if (!method && attempt <= 2) {
            method = await page.evaluate(() => {
                const host = document.querySelector('ytcp-button#picker-next-button');
                const btn = host?.querySelector('button');
                if (!btn) return null;
                btn.click();
                return 'dom';
            }).catch(() => null);
        }

        if (!method) {
            const point = await nextBtn.evaluate(btn => {
                const rect = btn.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            }).catch(() => null);
            if (point) {
                await page.mouse.click(point.x, point.y);
                method = 'mouse';
            }
        }

        if (method) log(`Clicked Next button (${method}, attempt ${attempt})`);

        const movedToDone = await page.locator('ytcp-button#picker-done-button button, button[aria-label="Done"], button[aria-label="Xong"]')
            .first()
            .isVisible({ timeout: 2500 })
            .catch(() => false);
        if (movedToDone) return;

        await page.waitForTimeout(500);
    }

    throw new Error('Clicked Next but product picker did not advance to Done step.');
}

async function clickPickerDoneButton(page) {
    const doneBtn = page.locator('ytcp-button#picker-done-button button, button[aria-label="Done"], button[aria-label="Xong"]').first();
    await doneBtn.waitFor({ state: 'visible', timeout: 10000 });

    for (let attempt = 1; attempt <= 3; attempt++) {
        let method = null;
        if (attempt === 1) {
            method = 'playwright';
            await doneBtn.click({ timeout: 3000 }).catch(() => { method = null; });
        }

        if (!method && attempt <= 2) {
            method = await page.evaluate(() => {
                const host = document.querySelector('ytcp-button#picker-done-button');
                const btn = host?.querySelector('button')
                    || document.querySelector('button[aria-label="Done"], button[aria-label="Xong"]');
                if (!btn) return null;
                btn.click();
                return 'dom';
            }).catch(() => null);
        }

        if (!method) {
            const point = await doneBtn.evaluate(btn => {
                const rect = btn.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            }).catch(() => null);
            if (point) {
                await page.mouse.click(point.x, point.y);
                method = 'mouse';
            }
        }

        if (method) log(`Clicked Done button (${method}, attempt ${attempt})`);

        const pickerClosed = await page.locator('input#search-input.search-input')
            .first()
            .isVisible({ timeout: 2500 })
            .then(visible => !visible)
            .catch(() => true);
        if (pickerClosed) return;

        await page.waitForTimeout(500);
    }

    throw new Error('Clicked Done but product picker did not close.');
}

async function clickTagButtonPrecisely(page, tagBtn, label = 'Tag button') {
    await tagBtn.waitFor({ state: 'visible', timeout: 10000 });
    await tagBtn.scrollIntoViewIfNeeded().catch(() => { });

    for (let attempt = 1; attempt <= 3; attempt++) {
        if (await closeProductDetailsDialog(page)) {
            log(`${label}: closed Details dialog before retry`);
            await page.waitForTimeout(300);
        }

        const domTarget = await tagBtn.evaluate(el => {
            const roots = [el.shadowRoot, el].filter(Boolean);
            const selectors = [
                'button[aria-label="Tag"]',
                'button[title="Tag"]',
                'button',
                '[role="button"]',
                '#button',
                'tp-yt-paper-icon-button',
                'paper-icon-button',
            ];

            for (const root of roots) {
                for (const selector of selectors) {
                    const target = root.querySelector(selector);
                    if (!target) continue;
                    const rect = target.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    target.click();
                    return selector;
                }
            }

            el.click();
            return 'host';
        }).catch(e => {
            log(`${label}: DOM click failed on attempt ${attempt}: ${e.message}`);
            return null;
        });

        if (domTarget) log(`${label}: DOM clicked ${domTarget} (attempt ${attempt})`);
        let outcome = await waitForTagClickOutcome(page, 1800);
        if (outcome && outcome !== 'details-opened') {
            log(`${label}: click confirmed by ${outcome}`);
            return;
        }

        if (outcome === 'details-opened' || await isProductDetailsOpen(page)) {
            log(`${label}: click opened Details instead of tagging; closing and retrying`);
            await closeProductDetailsDialog(page);
            await page.waitForTimeout(300);
        }

        const point = await tagBtn.evaluate(el => {
            const candidates = [];
            const roots = [el.shadowRoot, el].filter(Boolean);
            const selectors = [
                'button[aria-label="Tag"]',
                'button[title="Tag"]',
                'button',
                '[role="button"]',
                '#button',
                'tp-yt-paper-icon-button',
                'paper-icon-button',
                'yt-icon',
                'iron-icon',
                'svg',
            ];

            for (const root of roots) {
                for (const selector of selectors) {
                    for (const target of root.querySelectorAll(selector)) {
                        const rect = target.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) candidates.push(rect);
                    }
                }
            }

            const hostRect = el.getBoundingClientRect();
            if (hostRect.width > 0 && hostRect.height > 0) candidates.push(hostRect);
            candidates.sort((a, b) => (a.width * a.height) - (b.width * b.height));
            const rect = candidates[0];
            if (!rect) return null;

            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }).catch(() => null);

        if (point) {
            await page.mouse.click(point.x, point.y);
            log(`${label}: mouse clicked at ${point.x},${point.y} (attempt ${attempt})`);
        }

        outcome = await waitForTagClickOutcome(page, 2200);
        if (outcome && outcome !== 'details-opened') {
            log(`${label}: click confirmed by ${outcome}`);
            return;
        }

        if (outcome === 'details-opened' || await isProductDetailsOpen(page)) {
            log(`${label}: mouse click opened Details; closing and retrying`);
            await closeProductDetailsDialog(page);
            await page.waitForTimeout(300);
        }
    }

    throw new Error('Đã tìm thấy nút Tag nhưng bấm không thành công.');
}

async function waitForSaveToFinish(page, saveBtn) {
    await page.waitForFunction(() => {
        const btn = document.querySelector('ytcp-button#save button');
        const host = document.querySelector('ytcp-button#save');
        if (!btn) return false;
        return btn.disabled
            || btn.getAttribute('aria-disabled') === 'true'
            || host?.getAttribute('aria-disabled') === 'true'
            || host?.hasAttribute('disabled');
    }, null, { timeout: 15000 }).catch(() => { });

    await saveBtn.waitFor({ state: 'attached', timeout: 3000 }).catch(() => { });
}

async function addProduct(page, productUrl, _retryCount = 0) {
    // Setup dialog handler to auto-dismiss YouTube Studio alerts (e.g. "Sorry, we were not able to save your video")
    let dialogDismissed = false;
    const dialogHandler = (dialog) => {
        log(`Dialog detected: "${dialog.message()}" — auto-dismissing`);
        dialogDismissed = true;
        dialog.dismiss().catch(() => { });
    };
    page.on('dialog', dialogHandler);

    let cachedProductInfo = null;
    const getExpectedProductInfo = async () => {
        if (cachedProductInfo !== null) return cachedProductInfo;
        cachedProductInfo = await getProductInfo(productUrl).catch(() => null);
        return cachedProductInfo;
    };
    const normalizeProductTitle = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

    const btn = page.locator('button:has(div.ytcpButtonShapeImpl__button-text-content)').filter({
        hasText: /(Sản phẩm|Products|tagged product|sản phẩm đã gắn)/i
    }).first();

    const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');

    try {
        await Promise.race([
            editBtn.waitFor({ state: 'attached', timeout: 15000 }),
            btn.waitFor({ state: 'attached', timeout: 15000 })
        ]);
    } catch (e) {
        // If neither button found, try one page reload then wait again
        log('Products button not found, reloading page and retrying...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
        await page.waitForTimeout(2000);
        try {
            await Promise.race([
                editBtn.waitFor({ state: 'attached', timeout: 15000 }),
                btn.waitFor({ state: 'attached', timeout: 15000 })
            ]);
        } catch (e2) {
            throw new Error('Không tìm thấy nút Sản phẩm sau khi reload. Trang có thể chưa load xong.');
        }
    }

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

    let matchingProductAlreadySelected = false;
    try {
        const selectedProductTexts = await page.evaluate(() => {
            const products = document.querySelectorAll('ytshopping-product-picker-selected-product ytshopping-product');
            return Array.from(products).map(p => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        });
        if (selectedProductTexts.length > 0) {
            const existingInfo = await getExpectedProductInfo();
            const expectedTitle = normalizeProductTitle(existingInfo?.title || '');
            matchingProductAlreadySelected = !!expectedTitle && selectedProductTexts.some(text => {
                const selectedTitle = normalizeProductTitle(text);
                return selectedTitle.includes(expectedTitle) || expectedTitle.includes(selectedTitle);
            });
            log(`Found ${selectedProductTexts.length} existing selected product(s); match target: ${matchingProductAlreadySelected ? 'yes' : 'no'}`);
        }
    } catch (e) {
        log(`Warning: could not inspect selected products: ${shortErrorMessage(e)}`);
    }

    if (!matchingProductAlreadySelected) {
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
    const searchResultProduct = page.locator('ytshopping-product').filter({
        has: page.locator('ytcp-icon-button.tag-product-button')
    }).first();
    let tagBtn = searchResultProduct.locator('ytcp-icon-button.tag-product-button').first();
    try {
        await tagBtn.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
        tagBtn = page.locator('ytcp-icon-button.tag-product-button').first();
        try {
            await tagBtn.waitFor({ state: 'visible', timeout: 7000 });
        } catch {
            log('Product not found within 15s, reloading page...');
            await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
            throw new Error('Sản phẩm này không gắn giỏ được.');
        }
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

    // ---- Check if product has multiple options (variants) ----
    const productScope = await searchResultProduct.isVisible({ timeout: 500 }).catch(() => false)
        ? searchResultProduct
        : page;
    const optionsLabel = productScope.locator('yt-formatted-string').filter({
        hasText: /\d+\+?\s*options?/i
    }).first();
    const hasOptions = await optionsLabel.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasOptions) {
        const optionsText = await optionsLabel.textContent().catch(() => '');
        log(`Product has variants: "${optionsText}" — entering variant selection flow`);

        // Step 1: Fetch info from product page to know which variant to pick
        let productInfo = null;
        let shopeeTitle = null;
        let shopeePrice = null;
        productInfo = await getExpectedProductInfo();
        shopeeTitle = productInfo?.title || null;
        shopeePrice = productInfo?.price || null;
        log(`Product title: "${shopeeTitle}", price: ${shopeePrice}`);
        if (!shopeeTitle) {
            // Fallback: no title found, use normal tag flow
            log('Could not fetch product title, falling back to normal tag flow');
            await clickTagButtonPrecisely(page, tagBtn, 'Fallback tag button');
            log('Clicked Tag button (fallback)');
        } else {
            // Step 2: Click on product title card to open product details
            const productTitleCard = productScope.locator('div.product-title.style-scope.ytshopping-product[role="button"]').first();
            await productTitleCard.waitFor({ state: 'visible', timeout: 5000 });
            await productTitleCard.click();
            log('Clicked product title card');
            await page.waitForTimeout(800);

            // Step 3: Click on "x product options" group label to expand variants
            const offerGroupLabel = page.locator('.ytshoppingProductDetailsOfferGroupLabelContent').first();
            // Scroll dialog to make offer group visible (may be below fold for products with long descriptions)
            await page.evaluate(() => {
                const dialog = document.querySelector('ytshopping-product-details-dialog');
                if (dialog) dialog.scrollTop = dialog.scrollHeight;
                const details = document.querySelector('ytshopping-product-details');
                if (details) details.scrollTop = details.scrollHeight;
            });
            await page.waitForTimeout(300);
            const offerGroupVisible = await offerGroupLabel.isVisible({ timeout: 3000 }).catch(() => false);
            if (!offerGroupVisible) {
                // No offer group — close dialog and fallback to normal tag
                log('No offer group label found — falling back to normal tag flow');
                const closeBtn = page.locator('ytcp-icon-button[aria-label="Close"]').first();
                if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await closeBtn.click();
                    await page.waitForTimeout(500);
                }
                await clickTagButtonPrecisely(page, tagBtn, 'Fallback tag button');
                log('Clicked Tag button (fallback, no offer group)');
            } else {
                await offerGroupLabel.click();
                log('Clicked product options group label');

                // Wait for variant selection panel to load
                const variantPanel = page.locator('ytshopping-variant-selection');
                await variantPanel.waitFor({ state: 'visible', timeout: 5000 });
                await page.waitForTimeout(500);

                // Step 4: Turn off "Show best option" switch (click the track to toggle off)
                const switchTrack = page.locator('ytshopping-variant-selection .widgetsYtcpSwitchTrack.widgetsYtcpSwitchTrackActive').first();
                const switchVisible = await switchTrack.isVisible({ timeout: 2000 }).catch(() => false);
                if (switchVisible) {
                    await switchTrack.click();
                    log('Toggled off "Show best option" switch');
                    await page.waitForTimeout(500);
                } else {
                    log('"Show best option" switch not active or not found, skipping toggle');
                }

                // Step 5: Find the variant whose title AND price match the Shopee product
                const variantCards = page.locator('ytshopping-variant-selection-product');
                await variantCards.first().waitFor({ state: 'visible', timeout: 5000 });
                const variantCount = await variantCards.count();
                log(`Found ${variantCount} variant(s)`);

                // Normalize price: "17990000.00" → "17990000", "₫17,990,000" → "17990000"
                const normalizePrice = (str) => {
                    if (!str) return '';
                    const cleaned = String(str).replace(/\.\d+$/, '').replace(/[^\d]/g, '');
                    return cleaned.replace(/^0+/, '') || '0';
                };
                const shopeeNormPrice = normalizePrice(shopeePrice);
                const normTitle = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
                const nShopee = normTitle(shopeeTitle);

                // Batch-read all variant titles + prices in one evaluate call (fast!)
                const allVariants = await page.evaluate(() => {
                    const cards = document.querySelectorAll('ytshopping-variant-selection-product');
                    return Array.from(cards).map(c => {
                        const titleEl = c.querySelector('.ytshoppingVariantSelectionProductProductTitle');
                        const priceEl = c.querySelector('yt-formatted-string[aria-label*="rice"]');
                        return {
                            title: titleEl ? titleEl.textContent.trim() : '',
                            price: priceEl ? priceEl.textContent.trim() : '',
                        };
                    });
                });
                log(`Found ${allVariants.length} variant(s), matching...`);

                // Find exact title match (prefer last match + price match)
                let bestIdx = -1;
                for (let i = 0; i < allVariants.length; i++) {
                    const nVariant = normTitle(allVariants[i].title);
                    if (nVariant === nShopee) {
                        const variantNormPrice = normalizePrice(allVariants[i].price);
                        if (shopeeNormPrice && variantNormPrice && variantNormPrice === shopeeNormPrice) {
                            // Exact title + price match — best possible
                            bestIdx = i;
                            break;
                        }
                        // Exact title match — keep last one (original seller tends to be last)
                        bestIdx = i;
                    }
                }

                // Click the matched variant
                let matched = false;
                if (bestIdx >= 0) {
                    log(`✅ Match: variant ${bestIdx} — "${allVariants[bestIdx].title}" — ${allVariants[bestIdx].price}`);
                    const card = variantCards.nth(bestIdx);
                    const variantTagBtn = card.locator('ytcp-icon-button#tag-button');
                    await variantTagBtn.waitFor({ state: 'visible', timeout: 3000 });
                    await variantTagBtn.click();
                    log('Clicked tag button on matched variant');
                    matched = true;
                }

                if (!matched) {
                    log(`⚠️ No exact title match found. Falling back to first variant.`);
                    const firstTagBtn = variantCards.first().locator('ytcp-icon-button#tag-button');
                    await firstTagBtn.waitFor({ state: 'visible', timeout: 3000 });
                    await firstTagBtn.click();
                    log('Clicked tag button on first variant (fallback)');
                }

                await page.waitForTimeout(500);

                // Click Tag button via JS (dialog overlay blocks Playwright click, but JS click works fine)
                await page.waitForTimeout(500);
                await page.evaluate(() => document.querySelector("button[aria-label='Tag']").click());
                log('Clicked Tag button on product card (via JS)');
            } // end offerGroupVisible else
        }
    } else {
        // No options — normal flow: click tag directly
        await clickTagButtonPrecisely(page, tagBtn);
        log('Clicked Tag button');
    }

    // Next → Done (same for both flows — variant dialog auto-closes after tagging)
    } else {
        const selectedCount = await getPickerSelectedProductCount(page);
        if (selectedCount > 0) {
            log('Matching target product already selected in picker; completing Next/Done without re-tagging.');
        } else {
            log('Matching target product already selected in Studio; skipping remove/search/tag to avoid resetting YouTube publish.');
            await page.keyboard.press('Escape').catch(() => { });
            await page.waitForTimeout(500);
            page.removeListener('dialog', dialogHandler);
            return;
        }
    }

    await clickPickerNextButton(page);
    await clickPickerDoneButton(page);

    const saveBtn = page.locator('ytcp-button#save button').first();
    await saveBtn.waitFor({ state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    const isDisabled = await saveBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);

    if (isDisabled) {
        log('Save button is disabled (no changes). Proceeding directly.');
        page.removeListener('dialog', dialogHandler);
    } else {
        await saveBtn.evaluate(b => b.scrollIntoView()).catch(() => { });
        await saveBtn.click({ force: true }).catch(async () => {
            await saveBtn.evaluate(b => b.click());
        });
        log('Clicked Save button');

        // Wait for save to complete, checking for dialog errors
        await waitForSaveToFinish(page, saveBtn);
        await page.waitForTimeout(5000);

        if (dialogDismissed) {
            log('Save failed (dialog error detected). Reloading page...');
            page.removeListener('dialog', dialogHandler);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
            await page.waitForTimeout(2000);

            // Retry up to 2 times
            if (_retryCount < 2) {
                log(`Retrying addProduct (attempt ${_retryCount + 2}/3)...`);
                return await addProduct(page, productUrl, _retryCount + 1);
            } else {
                throw new Error('Save failed after 3 attempts (YouTube dialog error).');
            }
        }

        // Also check for "Oops, something went wrong" error on page
        const oopsError = await page.evaluate(() => {
            const el = document.querySelector('yt-alert-with-actions-renderer, .error-message, .yt-alert-message');
            return el ? el.textContent.trim() : null;
        }).catch(() => null);

        if (oopsError && /oops|something went wrong|went wrong/i.test(oopsError)) {
            log(`Page error detected: "${oopsError}". Reloading page...`);
            page.removeListener('dialog', dialogHandler);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
            await page.waitForTimeout(2000);

            if (_retryCount < 2) {
                log(`Retrying addProduct (attempt ${_retryCount + 2}/3)...`);
                return await addProduct(page, productUrl, _retryCount + 1);
            } else {
                throw new Error('Save failed after 3 attempts (page error).');
            }
        }

        page.removeListener('dialog', dialogHandler);
        log('Save clicked, proceeding to fetch after save wait');
    }
}

const decodeUnicode = (str = '') => String(str).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number(`0x${hex}`)));

function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeAffiliateUrl(rawUrl) {
    if (!rawUrl) return '';

    let url = decodeUnicode(rawUrl)
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .trim();

    if (/^https?%3a%2f%2f/i.test(url)) {
        url = safeDecodeURIComponent(url);
    }

    if (url.startsWith('/redirect?')) {
        url = `https://www.youtube.com${url}`;
    }

    if (/^https:\/\/www\.youtube\.com\/redirect\?/i.test(url)) {
        try {
            const redirect = new URL(url);
            const target = redirect.searchParams.get('q') || redirect.searchParams.get('url');
            if (target) return normalizeAffiliateUrl(target);
        } catch { }
    }

    return url;
}

function extractAffiliateUrlCandidates(pageContent) {
    const candidates = [];
    const seen = new Set();
    const shoppingDomainPattern = /(shopee\.vn|shp\.ee|lazada\.vn|lzd\.co)/i;

    const addCandidate = (rawUrl, index) => {
        const url = normalizeAffiliateUrl(rawUrl);
        if (!url || !shoppingDomainPattern.test(url)) return;
        if (seen.has(url)) return;
        seen.add(url);
        candidates.push({ url, index });
    };

    const patterns = [
        /"url"\s*:\s*"([^"]+)"/g,
        /"(https?:\\?\/\\?\/[^"]+)"/g,
        /"(\/redirect\?[^"]+)"/g,
        /https%3A%2F%2F[^"'\\<>\s]+/gi,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(pageContent)) !== null) {
            addCandidate(match[1] || match[0], match.index);
        }
    }

    return candidates.sort((a, b) => a.index - b.index);
}

function withYouTubeLocale(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('hl')) parsed.searchParams.set('hl', 'vi');
        if (!parsed.searchParams.has('gl')) parsed.searchParams.set('gl', 'VN');
        return parsed.toString();
    } catch {
        return url;
    }
}

function getPublicPageSignals(pageContent) {
    return {
        hasProductShelf: pageContent.includes('productListItemRenderer'),
        hasShoppingText: /(shopee|shp\.ee|lazada|lzd\.co)/i.test(pageContent),
    };
}

function extractYouTubeConfig(pageContent) {
    return {
        apiKey: decodeUnicode(pageContent.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || ''),
        clientVersion: decodeUnicode(pageContent.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || ''),
        visitorData: decodeUnicode(
            pageContent.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1]
            || pageContent.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1]
            || ''
        ),
    };
}

function buildYouTubeNextVariants(config, videoId) {
    const versions = [
        config.clientVersion,
        '2.20260612.01.00-canary_experiment_2.20260611.01.00',
        '2.20260612.01.00',
        '2.20260610.01.00',
    ].filter(Boolean);
    const uniqueVersions = [...new Set(versions)];
    const variants = [];

    for (const clientVersion of uniqueVersions) {
        variants.push({
            label: `${clientVersion}${config.visitorData ? ' + visitor' : ''}`,
            clientVersion,
            visitorData: config.visitorData || '',
        });
        variants.push({
            label: `${clientVersion} clean`,
            clientVersion,
            visitorData: '',
        });
    }

    return variants.slice(0, 6).map(variant => ({
        ...variant,
        body: {
            context: {
                client: {
                    hl: 'vi',
                    gl: 'VN',
                    clientName: 'WEB',
                    clientVersion: variant.clientVersion,
                    ...(variant.visitorData ? { visitorData: variant.visitorData } : {}),
                },
            },
            videoId,
            racyCheckOk: true,
            contentCheckOk: true,
        },
    }));
}

async function fetchYouTubeNextData(videoId, publicUrl, seedPageContent = '') {
    let config = extractYouTubeConfig(seedPageContent);
    let configHtml = seedPageContent;
    const localeUrl = withYouTubeLocale(publicUrl);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'PREF=hl=vi&gl=VN; SOCS=CAI',
    };

    if (!config.apiKey) {
        const configStart = Date.now();
        const response = await fetch(localeUrl, { headers: { ...headers, 'Accept': 'text/html' } });
        configHtml = await response.text();
        config = extractYouTubeConfig(configHtml);
        log(`Fetched YouTube config in ${Date.now() - configStart}ms (${(configHtml.length / 1024).toFixed(0)}KB, apiKey=${config.apiKey ? 'yes' : 'no'})`);
    }

    if (!config.apiKey) return null;

    let bestContent = configHtml;
    let bestScore = 0;
    for (const variant of buildYouTubeNextVariants(config, videoId)) {
        const started = Date.now();
        const response = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(config.apiKey)}`, {
            method: 'POST',
            headers: {
                ...headers,
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'Referer': localeUrl,
                'X-YouTube-Client-Name': '1',
                'X-YouTube-Client-Version': variant.clientVersion,
            },
            body: JSON.stringify(variant.body),
        });
        const content = await response.text();
        const candidates = extractAffiliateUrlCandidates(content);
        const signals = getPublicPageSignals(content);
        const score = candidates.length * 10 + (signals.hasProductShelf ? 2 : 0) + (signals.hasShoppingText ? 1 : 0);
        log(`Fetched youtubei next (${variant.label}) in ${Date.now() - started}ms (${(content.length / 1024).toFixed(0)}KB, status=${response.status}, candidates=${candidates.length}, shelf=${signals.hasProductShelf ? 'yes' : 'no'}, shopping=${signals.hasShoppingText ? 'yes' : 'no'})`);
        if (score > bestScore) {
            bestScore = score;
            bestContent = content;
        }
        if (candidates.length > 0) return content;
    }

    return bestContent;
}

async function fetchPublicDataWithBrowserRequest(browser, videoId, publicUrl) {
    const context = browser?.contexts?.()[0];
    const request = context?.request;
    if (!request) return null;

    const localeUrl = withYouTubeLocale(publicUrl);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
    };

    const started = Date.now();
    const watchResponse = await request.get(localeUrl, { headers: { ...headers, 'Accept': 'text/html' }, timeout: 30000 });
    const watchContent = await watchResponse.text();
    let bestContent = watchContent;
    let bestCandidates = extractAffiliateUrlCandidates(watchContent);
    let bestSignals = getPublicPageSignals(watchContent);
    log(`Browser request watch in ${Date.now() - started}ms (${(watchContent.length / 1024).toFixed(0)}KB, status=${watchResponse.status()}, candidates=${bestCandidates.length}, shelf=${bestSignals.hasProductShelf ? 'yes' : 'no'}, shopping=${bestSignals.hasShoppingText ? 'yes' : 'no'})`);
    if (bestCandidates.length > 0) return bestContent;

    const config = extractYouTubeConfig(watchContent);
    if (!config.apiKey) return bestContent;

    for (const variant of buildYouTubeNextVariants(config, videoId)) {
        const nextStart = Date.now();
        const response = await request.post(`https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(config.apiKey)}`, {
            headers: {
                ...headers,
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Origin': 'https://www.youtube.com',
                'Referer': localeUrl,
                'X-YouTube-Client-Name': '1',
                'X-YouTube-Client-Version': variant.clientVersion,
            },
            data: variant.body,
            timeout: 30000,
        });
        const content = await response.text();
        const candidates = extractAffiliateUrlCandidates(content);
        const signals = getPublicPageSignals(content);
        log(`Browser request youtubei (${variant.label}) in ${Date.now() - nextStart}ms (${(content.length / 1024).toFixed(0)}KB, status=${response.status()}, candidates=${candidates.length}, shelf=${signals.hasProductShelf ? 'yes' : 'no'}, shopping=${signals.hasShoppingText ? 'yes' : 'no'})`);
        if (candidates.length > bestCandidates.length || signals.hasProductShelf || signals.hasShoppingText) {
            bestContent = content;
            bestCandidates = candidates;
            bestSignals = signals;
        }
        if (candidates.length > 0) return content;
    }

    return bestContent;
}

async function resolveProductOriginUrl(productUrl, expectedInfo) {
    const candidates = [
        expectedInfo?.resolvedUrl,
        expectedInfo?.url,
        productUrl,
    ].filter(Boolean);

    const direct = candidates.find(url => /shopee\.vn\/(product|opaanlp|[^/?#]+-i\.)/i.test(url));
    if (direct) return direct;

    try {
        const response = await fetch(productUrl, {
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept': 'text/html',
            },
        });
        return response.url || productUrl;
    } catch {
        return candidates[0] || productUrl;
    }
}

async function buildFallbackAffiliateUrl(expectedProductUrl, expectedInfo, videoId) {
    const lower = (expectedProductUrl || '').toLowerCase();
    if (!lower.includes('shopee') && !lower.includes('shp.ee')) return null;

    const originUrl = await resolveProductOriginUrl(expectedProductUrl, expectedInfo);
    if (!originUrl) return null;

    const subId = `YT3-fallback-${videoId}`.replace(/[^A-Za-z0-9_-]/g, '');
    const affiliateUrl = `https://s.shopee.vn/an_redir?affiliate_id=17104820001&sub_id=${encodeURIComponent(subId)}&origin_link=${encodeURIComponent(originUrl)}`;
    return affiliateUrl;
}

function isLazadaUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        return host === 'lazada.vn' || host.endsWith('.lazada.vn') || host === 'lzd.co' || host.endsWith('.lzd.co');
    } catch {
        return /lazada\.vn|lzd\.co/i.test(String(url));
    }
}

function cleanLazadaProductUrl(url) {
    try {
        const parsed = new URL(url);
        if (!isLazadaUrl(parsed.href)) return null;
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return null;
    }
}

function buildDirectLazadaAffiliateUrl(expectedProductUrl, expectedInfo, videoId) {
    const candidates = [
        expectedProductUrl,
        expectedInfo?.resolvedUrl,
        expectedInfo?.url,
    ].filter(Boolean);

    const productUrl = candidates.map(cleanLazadaProductUrl).find(Boolean);
    if (!productUrl) return null;

    const subId = `YT3-fallback-${videoId}`.replace(/[^A-Za-z0-9_-]/g, '');
    const parsed = new URL(productUrl);
    parsed.searchParams.set('from_gmc', '1');
    parsed.searchParams.set('fl_tag', '1');
    parsed.searchParams.set('sub_aff_id', subId);
    parsed.searchParams.set('exlaz', LAZADA_YOUTUBE_EXLAZ);
    return parsed.toString();
}

function isLikelyLazadaAffiliateUrl(url) {
    if (!url) return false;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const query = parsed.search.toLowerCase();
        const full = url.toLowerCase();

        if (host === 'c.lazada.vn' || host.endsWith('.c.lazada.vn') || host === 'lzd.co' || host.endsWith('.lzd.co')) return true;
        if (/(laz_trackid|mkttid|exlaz|sub_aff_id|sub_id|aff_id|trafficfrom|lzd_click_id)/i.test(query)) return true;
        if (/\/\/s\.lazada\.vn\/l\./i.test(full)) return true;
    } catch {
        return /(c\.lazada\.vn|lzd\.co|laz_trackid|mkttid|exlaz|sub_aff_id|aff_id)/i.test(String(url));
    }

    return false;
}

async function getBrowserShoppingState(page) {
    return await page.evaluate(() => {
        const shoppingPattern = /(shopee\.vn|shp\.ee|lazada\.vn|lzd\.co)/i;
        const html = document.documentElement?.innerHTML || '';
        const text = document.body?.innerText || '';
        const urls = [];
        for (const el of document.querySelectorAll('a[href], area[href]')) {
            const href = el.href || el.getAttribute('href') || '';
            if (shoppingPattern.test(href)) urls.push(href);
        }
        for (const el of document.querySelectorAll('[data-url], [data-href], [data-command]')) {
            for (const name of ['data-url', 'data-href', 'data-command']) {
                const value = el.getAttribute(name) || '';
                if (shoppingPattern.test(value)) urls.push(value);
            }
        }
        return {
            title: document.title,
            url: location.href,
            htmlLength: html.length,
            hasProductShelf: html.includes('productListItemRenderer'),
            hasShoppingText: shoppingPattern.test(html),
            textHasProduct: /\d+\s+product|view products|products|sản phẩm|xem sản phẩm/i.test(text),
            textSnippet: text.slice(0, 800),
            urls: [...new Set(urls)].slice(0, 20),
        };
    });
}

async function clickPublicProductsButton(page) {
    try {
        return await page.evaluate(() => {
            const labelPattern = /view products|xem sản phẩm|\d+\s+product|products/i;
            const elements = [...document.querySelectorAll('button, a, ytd-button-renderer, yt-button-shape, tp-yt-paper-button')];
            const target = elements.find(el => {
                const text = `${el.innerText || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim();
                if (!labelPattern.test(text)) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
            if (!target) return false;
            const clickable = target.closest('button, a, ytd-button-renderer, yt-button-shape, tp-yt-paper-button') || target;
            clickable.click();
            return true;
        });
    } catch {
        return false;
    }
}

async function readPublicPageContent(page, label, publicUrl) {
    const started = Date.now();
    const url = withYouTubeLocale(publicUrl);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
        const html = document.documentElement?.innerHTML || '';
        const text = document.body?.innerText || '';
        return html.includes('productListItemRenderer')
            || /(shopee|shp\.ee|lazada)/i.test(html)
            || /\d+\s+product|view products|xem sản phẩm|sản phẩm/i.test(text);
    }, null, { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(1000);

    let content = await page.content();
    let candidates = extractAffiliateUrlCandidates(content);
    let state = await getBrowserShoppingState(page).catch(() => null);
    log(`Browser fallback ${label}: candidates=${candidates.length}, shelf=${state?.hasProductShelf ? 'yes' : 'no'}, shopping=${state?.hasShoppingText ? 'yes' : 'no'}, textProduct=${state?.textHasProduct ? 'yes' : 'no'}`);

    if (candidates.length === 0 && state?.textHasProduct) {
        const clicked = await clickPublicProductsButton(page);
        if (clicked) {
            await page.waitForTimeout(3000);
            content = await page.content();
            state = await getBrowserShoppingState(page).catch(() => state);
            const domUrls = state?.urls?.length
                ? `\n${state.urls.map(u => `"url":"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n')}`
                : '';
            content += domUrls;
            candidates = extractAffiliateUrlCandidates(content);
            log(`Browser fallback ${label} after product click: candidates=${candidates.length}, shelf=${state?.hasProductShelf ? 'yes' : 'no'}, shopping=${state?.hasShoppingText ? 'yes' : 'no'}`);
        }
    } else if (state?.urls?.length) {
        content += `\n${state.urls.map(u => `"url":"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n')}`;
        candidates = extractAffiliateUrlCandidates(content);
    }

    log(`Browser fallback ${label} fetched public page in ${Date.now() - started}ms (${(content.length / 1024).toFixed(0)}KB)`);
    return { content, candidates };
}

async function fetchPublicVideoHtmlFromBrowser(browser, publicUrl) {
    const context = browser?.contexts?.()[0];
    if (!context) return null;

    let publicPage = null;
    let privateContext = null;
    try {
        publicPage = await context.newPage();
        const defaultResult = await readPublicPageContent(publicPage, 'default context', publicUrl);
        if (defaultResult.candidates.length > 0) return defaultResult.content;

        if (browser.newContext) {
            privateContext = await browser.newContext({
                locale: 'vi-VN',
                extraHTTPHeaders: { 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' },
            });
            const privatePage = await privateContext.newPage();
            const privateResult = await readPublicPageContent(privatePage, 'anonymous context', publicUrl);
            if (privateResult.candidates.length > 0) return privateResult.content;
            return privateResult.content || defaultResult.content;
        }

        return defaultResult.content;
    } catch (e) {
        log(`Browser fallback failed: ${shortErrorMessage(e)}`);
        return null;
    } finally {
        if (publicPage) await publicPage.close().catch(() => { });
        if (privateContext) await privateContext.close().catch(() => { });
    }
}

async function fetchAffiliateUrl(
    videoUrl,
    expectedProductUrl,
    browser = null,
    providedAffiliateFallbackUrl = null,
    options = {},
) {
    const forcePublicShelf = options.forcePublicShelf === true;
    const videoIdMatch = videoUrl.match(/\/video\/([^/]+)\//);
    if (!videoIdMatch) throw new Error('Could not extract video ID from URL');
    const videoId = videoIdMatch[1];
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    log(`Fetching public video: ${publicUrl}`);

    // Determine expected domains from product URL for verification.
    // YouTube may expose Shopee affiliate links as shp.ee short links.
    const expectedProductUrlLower = (expectedProductUrl || '').toLowerCase();
    const expectedDomainAliases = expectedProductUrlLower
        ? expectedProductUrlLower.includes('shopee') || expectedProductUrlLower.includes('shp.ee')
            ? ['shopee', 'shp.ee']
            : expectedProductUrlLower.includes('lazada') || expectedProductUrlLower.includes('lzd.co')
                ? ['lazada', 'lzd.co']
                : null
        : null;
    const matchesExpectedDomain = (url) => {
        if (!expectedDomainAliases) return true;
        const lower = (url || '').toLowerCase();
        return expectedDomainAliases.some(alias => lower.includes(alias));
    };

    // Fetch expected product info (title + price) for matching
    let expectedInfo = null;
    if (expectedProductUrl) {
        expectedInfo = await getProductInfo(expectedProductUrl);
        if (expectedInfo) {
            log(`Expected product: "${expectedInfo.title}", price: ${expectedInfo.price || 'N/A'}`);
        }
    }

    if (!forcePublicShelf && USE_DIRECT_SHOPEE_AFFILIATE && expectedDomainAliases?.some(alias => alias.includes('shopee') || alias.includes('shp.ee'))) {
        const directAffiliateUrl = await buildFallbackAffiliateUrl(expectedProductUrl, expectedInfo, videoId);
        if (directAffiliateUrl) {
            const directMetadata = {
                title: expectedInfo?.title || '',
                price: expectedInfo?.price || '',
                image: expectedInfo?.image || '',
                fallback: true,
                source: 'direct-shopee',
            };
            log(`Using direct Shopee affiliate URL; skipping YouTube public shelf polling: ${directAffiliateUrl.slice(0, 180)}...`);
            return { affiliateUrl: directAffiliateUrl, metadata: directMetadata };
        }
    }

    if (
        !forcePublicShelf
        && USE_PROVIDED_LAZADA_AFFILIATE_FALLBACK
        && expectedDomainAliases?.some(alias => alias.includes('lazada') || alias.includes('lzd.co'))
        && isLikelyLazadaAffiliateUrl(providedAffiliateFallbackUrl)
    ) {
        const fallbackMetadata = {
            title: expectedInfo?.title || '',
            price: expectedInfo?.price || '',
            image: expectedInfo?.image || '',
            fallback: true,
            source: 'provided-lazada-affiliate',
        };
        log(`Using provided Lazada affiliate URL; skipping YouTube public shelf polling: ${String(providedAffiliateFallbackUrl).slice(0, 180)}...`);
        return { affiliateUrl: providedAffiliateFallbackUrl, metadata: fallbackMetadata };
    }

    if (!forcePublicShelf && USE_DIRECT_LAZADA_AFFILIATE && expectedDomainAliases?.some(alias => alias.includes('lazada') || alias.includes('lzd.co'))) {
        const directLazadaUrl = buildDirectLazadaAffiliateUrl(expectedProductUrl, expectedInfo, videoId);
        if (directLazadaUrl) {
            const directMetadata = {
                title: expectedInfo?.title || '',
                price: expectedInfo?.price || '',
                image: expectedInfo?.image || '',
                fallback: true,
                source: 'direct-lazada',
            };
            log(`Using direct Lazada affiliate URL; skipping YouTube public shelf polling: ${directLazadaUrl.slice(0, 180)}...`);
            return { affiliateUrl: directLazadaUrl, metadata: directMetadata };
        }
    }

    const normPrice = (str) => {
        if (!str) return '';
        return String(str).replace(/\.\d+$/, '').replace(/[^\d]/g, '').replace(/^0+/, '') || '0';
    };
    const normTitle = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

    let affiliateUrl = null;
    let metadata = { title: '', price: '', image: '' };

    const maxAttempts = Number.isInteger(options.maxAttempts)
        ? Math.max(1, options.maxAttempts)
        : 18;
    const retryDelayMs = Number.isInteger(options.retryDelayMs)
        ? Math.max(0, options.retryDelayMs)
        : null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
            const delay = retryDelayMs ?? (attempt <= 3 ? 1500 : attempt <= 7 ? 3000 : 5000);
            log(`Attempt ${attempt} fetchAffiliateUrl retrying after ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }

        const baseHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
        };
        const cacheBustUrl = `${publicUrl}&_cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const fetchPlans = [
            {
                label: 'VN locale',
                url: withYouTubeLocale(cacheBustUrl),
                headers: {
                    ...baseHeaders,
                    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cookie': 'PREF=hl=vi&gl=VN; SOCS=CAI',
                },
            },
            { label: 'default', url: cacheBustUrl, headers: baseHeaders },
        ];

        let pageContent = '';
        let urlCandidates = [];
        for (const plan of fetchPlans) {
            const fetchStart = Date.now();
            const response = await fetch(plan.url, { headers: plan.headers });
            const candidateContent = await response.text();
            const candidateUrls = extractAffiliateUrlCandidates(candidateContent);
            const signals = getPublicPageSignals(candidateContent);
            log(`Fetched ${plan.label} page in ${Date.now() - fetchStart}ms (${(candidateContent.length / 1024).toFixed(0)}KB, candidates=${candidateUrls.length}, shelf=${signals.hasProductShelf ? 'yes' : 'no'}, shopping=${signals.hasShoppingText ? 'yes' : 'no'})`);
            if (!pageContent || candidateUrls.length > urlCandidates.length || signals.hasProductShelf || signals.hasShoppingText) {
                pageContent = candidateContent;
                urlCandidates = candidateUrls;
            }
            if (urlCandidates.length > 0) break;
        }

        // Extract all product blocks with their affiliate URLs. YouTube may expose
        // links as direct Shopee/Lazada URLs, YouTube redirects, or escaped strings.
        if (urlCandidates.length === 0) {
            const nextContent = await fetchYouTubeNextData(videoId, publicUrl, pageContent).catch(e => {
                log(`youtubei next failed: ${shortErrorMessage(e)}`);
                return null;
            });
            if (nextContent) {
                const nextCandidates = extractAffiliateUrlCandidates(nextContent);
                const nextSignals = getPublicPageSignals(nextContent);
                if (nextCandidates.length > urlCandidates.length || nextSignals.hasProductShelf || nextSignals.hasShoppingText) {
                    pageContent = nextContent;
                    urlCandidates = nextCandidates;
                }
            }
        }

        if (urlCandidates.length === 0 && browser) {
            const browserRequestContent = await fetchPublicDataWithBrowserRequest(browser, videoId, publicUrl).catch(e => {
                log(`browser request fallback failed: ${shortErrorMessage(e)}`);
                return null;
            });
            if (browserRequestContent) {
                const browserRequestCandidates = extractAffiliateUrlCandidates(browserRequestContent);
                const browserRequestSignals = getPublicPageSignals(browserRequestContent);
                if (browserRequestCandidates.length > urlCandidates.length || browserRequestSignals.hasProductShelf || browserRequestSignals.hasShoppingText) {
                    pageContent = browserRequestContent;
                    urlCandidates = browserRequestCandidates;
                }
            }
        }

        if (urlCandidates.length === 0 && ENABLE_BROWSER_PUBLIC_FALLBACK && browser && attempt >= 3 && (attempt % 3 === 0 || attempt === maxAttempts)) {
            log(`Attempt ${attempt}: opening browser fallback to read public product shelf`);
            const browserPageContent = await fetchPublicVideoHtmlFromBrowser(browser, publicUrl);
            if (browserPageContent) {
                pageContent = browserPageContent;
                urlCandidates = extractAffiliateUrlCandidates(pageContent);
                log(`Attempt ${attempt}: browser fallback found ${urlCandidates.length} shopping URL candidate(s)`);
            }
        } else if (urlCandidates.length === 0 && !ENABLE_BROWSER_PUBLIC_FALLBACK && attempt === 3) {
            log('Browser public fallback disabled; using fetch/youtubei only (no new tab)');
        }

        if (urlCandidates.length === 0) {
            const hasProductShelf = pageContent.includes('productListItemRenderer');
            const hasShoppingText = /(shopee|shp\.ee|lazada|lzd\.co)/i.test(pageContent);
            log(`Attempt ${attempt} fetchAffiliateUrl failed to find affiliate link (product shelf: ${hasProductShelf ? 'yes' : 'no'}, shopping text: ${hasShoppingText ? 'yes' : 'no'})`);
            continue;
        }

        const decodedUrls = urlCandidates.map(c => c.url);
        const firstExpectedUrl = decodedUrls.find(matchesExpectedDomain);
        const firstUrl = firstExpectedUrl || decodedUrls[0];
        log(`Attempt ${attempt}: found ${urlCandidates.length} shopping URL candidate(s)`);

        if (expectedDomainAliases && !firstExpectedUrl) {
            log(`Attempt ${attempt}: domain mismatch! Expected ${expectedDomainAliases.join('/')} but got: ${decodedUrls[0]}. Retrying...`);
            continue;
        }

        // Parse all product blocks from page
        const products = [];
        const blockStarts = [...pageContent.matchAll(/productListItemRenderer":\{"title"/g)].map(m => m.index);
        for (let blockIdx = 0; blockIdx < blockStarts.length; blockIdx++) {
            const blockStart = blockStarts[blockIdx];
            const blockEnd = Math.min(pageContent.length, blockStarts[blockIdx + 1] || blockStart + 15000);
            const block = pageContent.substring(blockStart, blockEnd);
            const titleM = block.match(/"title"\s*:\s*\{"simpleText":"([^"]+)"/) || block.match(/simpleText":"([^"]+)"/);
            const priceM = block.match(/"price"\s*:\s*"([^"]+)"/);
            const thumbUrls = [...block.matchAll(/(https?:\/\/encrypted-tbn\d+\.gstatic\.com\/shopping\?q=tbn:[A-Za-z0-9_-]+)/g)]
                .map(m => decodeUnicode(m[1]));
            const blockUrl = urlCandidates.find(c => c.index >= blockStart && c.index < blockEnd)?.url
                || urlCandidates[blockIdx]?.url
                || null;

            products.push({
                title: titleM ? decodeUnicode(titleM[1]) : '',
                price: priceM ? decodeUnicode(priceM[1]).replace(/\u00a0/g, ' ').trim() : '',
                image: thumbUrls.length > 0 ? thumbUrls[0] : '',
                url: blockUrl,
            });
        }

        // If no blocks parsed, fallback to first URL
        if (products.length === 0 && urlCandidates.length > 0) {
            affiliateUrl = firstUrl;
            log('No product blocks found, using first affiliate URL');
            break;
        }

        log(`Found ${products.length} product(s) on YouTube page`);

        // Match by title + price
        if (expectedInfo && expectedInfo.title) {
            const eTitle = normTitle(expectedInfo.title);
            const ePrice = normPrice(expectedInfo.price);

            let bestMatch = null;
            let bestScore = -1;

            for (let i = 0; i < products.length; i++) {
                const p = products[i];
                const pTitle = normTitle(p.title);
                const pPrice = normPrice(p.price);
                let score = 0;

                // Title matching
                if (pTitle === eTitle) score += 10;
                else if (pTitle.startsWith(eTitle) || eTitle.startsWith(pTitle)) score += 8;
                else if (pTitle.includes(eTitle) || eTitle.includes(pTitle)) score += 5;
                else {
                    // Word overlap: count shared words between titles
                    const stripPunct = s => s.replace(/[^\p{L}\p{N}\s]/gu, '');
                    const eWords = new Set(stripPunct(eTitle).split(/\s+/).filter(w => w.length > 1));
                    const pWords = new Set(stripPunct(pTitle).split(/\s+/).filter(w => w.length > 1));
                    const common = [...eWords].filter(w => pWords.has(w)).length;
                    const overlap = eWords.size > 0 ? common / eWords.size : 0;
                    if (overlap >= 0.6) score += Math.round(overlap * 10); // up to 10 points
                }

                // Price matching
                if (ePrice && pPrice && pPrice === ePrice) score += 5;

                log(`  Product ${i}: "${p.title}" — ${p.price || 'no price'} (score: ${score})`);

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = i;
                }
            }

            if (bestMatch !== null && bestScore > 0) {
                const picked = products[bestMatch];
                affiliateUrl = picked.url || firstExpectedUrl || firstUrl;
                metadata = { title: picked.title, price: picked.price || '', image: picked.image };
                log(`✅ Best match (score ${bestScore}): "${picked.title}" — ${picked.price || 'no price'}`);
                break;
            }
        }

        // Fallback: if the expected domain is known, avoid returning a product
        // from a different merchant when the shelf contains mixed stores.
        const firstMatchingDomain = expectedDomainAliases
            ? products.find(p => p.url && matchesExpectedDomain(p.url))
            : null;
        const first = firstMatchingDomain || products[0] || {};
        affiliateUrl = first.url || firstUrl;
        metadata = { title: first.title || '', price: first.price || '', image: first.image || '' };
        log(firstMatchingDomain ? 'Using first product matching expected domain' : 'Using first product (no better match found)');
        break;
    }

    if (!affiliateUrl) {
        const fallbackAffiliateUrl = forcePublicShelf
            ? null
            : await buildFallbackAffiliateUrl(expectedProductUrl, expectedInfo, videoId);
        if (fallbackAffiliateUrl) {
            affiliateUrl = fallbackAffiliateUrl;
            metadata = {
                title: expectedInfo?.title || metadata.title || '',
                price: expectedInfo?.price || metadata.price || '',
                image: expectedInfo?.image || metadata.image || '',
                fallback: true,
            };
            log(`YouTube product shelf still unavailable; using constructed Shopee fallback URL: ${affiliateUrl.slice(0, 180)}...`);
        } else if (!forcePublicShelf && USE_PROVIDED_LAZADA_AFFILIATE_FALLBACK && isLikelyLazadaAffiliateUrl(providedAffiliateFallbackUrl)) {
            affiliateUrl = providedAffiliateFallbackUrl;
            metadata = {
                title: expectedInfo?.title || metadata.title || '',
                price: expectedInfo?.price || metadata.price || '',
                image: expectedInfo?.image || metadata.image || '',
                fallback: true,
                source: 'provided-lazada-affiliate',
            };
            log(`YouTube product shelf still unavailable; using provided Lazada affiliate URL: ${String(affiliateUrl).slice(0, 180)}...`);
        } else if (!forcePublicShelf && USE_DIRECT_LAZADA_AFFILIATE) {
            const directLazadaUrl = buildDirectLazadaAffiliateUrl(expectedProductUrl, expectedInfo, videoId);
            if (directLazadaUrl) {
                affiliateUrl = directLazadaUrl;
                metadata = {
                    title: expectedInfo?.title || metadata.title || '',
                    price: expectedInfo?.price || metadata.price || '',
                    image: expectedInfo?.image || metadata.image || '',
                    fallback: true,
                    source: 'direct-lazada',
                };
                log(`YouTube product shelf still unavailable; using direct Lazada affiliate URL: ${affiliateUrl.slice(0, 180)}...`);
            }
        }

        if (!affiliateUrl) {
            throw new Error('Không lấy được link affiliate sau khi lưu video. YouTube có thể cập nhật chậm, vui lòng thử lại.');
        }
    }

    log('Extracted metadata: ' + JSON.stringify(metadata));
    return { affiliateUrl, metadata };
}

// ==================== Job Execution ====================

function extractMarketplaceListingIdentity(productUrl) {
    try {
        const url = new URL(productUrl);
        if (/lazada\./i.test(url.hostname)) {
            const match = decodeURIComponent(url.pathname)
                .match(/-i(\d+)-s(\d+)\.html/i);
            if (match) {
                return {
                    marketplace: 'lazada',
                    productId: match[1],
                    offerId: match[2],
                };
            }
        }
    } catch {}
    return null;
}

function findExactOfferIndex(offers, productUrl) {
    const identity = extractMarketplaceListingIdentity(productUrl);
    if (!identity) return -1;
    return (offers || []).findIndex(offer => {
        const rawOfferId = String(offer?.itemId?.rawMerchantOfferId || '');
        if (rawOfferId === identity.offerId) return true;
        const targetIdentity = extractMarketplaceListingIdentity(offer?.targetUrl || '');
        return targetIdentity?.productId === identity.productId
            && targetIdentity?.offerId === identity.offerId;
    });
}

async function bootstrapStudioWriteSession(
    page,
    videoId,
    productUrl,
    api,
    retryCount = 0,
) {
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    const productsButton = page.getByRole('button', {
        name: /^(Products|Sản phẩm),/i,
    }).first();
    const editButton = page.locator('ytcp-icon-button#shopping-toolbar-edit');

    try {
        await Promise.race([
            editButton.waitFor({ state: 'visible', timeout: 20_000 }),
            productsButton.waitFor({ state: 'visible', timeout: 20_000 }),
        ]);
        if (!await editButton.isVisible().catch(() => false)) {
            await productsButton.waitFor({ state: 'visible', timeout: 15_000 });
            await productsButton.evaluate(element => element.click());
        }
        await editButton.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
        if (retryCount >= 1) throw error;
        log('Studio product controls were not ready; reloading once.');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        api.invalidateWriteSession();
        return bootstrapStudioWriteSession(
            page, videoId, productUrl, api, retryCount + 1,
        );
    }
    await editButton.evaluate(element => element.click());

    const search = page.locator('input#search-input.search-input');
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    const selected = page.locator(
        'ytshopping-product-picker-selected-product ytshopping-product',
    );
    while (await selected.count() > 0) {
        await selected.first().hover();
        await page.locator('ytcp-icon-button.delete-product-button').first()
            .click({ force: true });
        await page.waitForTimeout(100);
    }

    await search.fill(productUrl);
    await search.press('Enter');
    const searchResult = page.locator(
        'ytshopping-product-picker-search-result:visible',
    ).first();
    await searchResult.waitFor({ state: 'visible', timeout: 15_000 });
    const product = searchResult.locator('ytshopping-product').first();
    await product.waitFor({ state: 'visible', timeout: 15_000 });
    const tag = searchResult.locator(
        'ytcp-icon-button.tag-product-button',
    ).first();
    const optionsLabel = product.locator('yt-formatted-string').filter({
        hasText: /\d+\+?\s*options?/i,
    }).first();
    const hasOptions = await optionsLabel.isVisible({ timeout: 800 }).catch(() => false);

    let exactOffer = null;
    if (hasOptions) {
        const identity = extractMarketplaceListingIdentity(productUrl);
        if (identity) {
            const searchPayload = await api.searchProductsRaw(videoId, productUrl);
            const offerGroupItem = searchPayload?.shoppingProducts?.items?.[0];
            const offersPayload = await api.getOffersForOfferGroupRaw(
                videoId,
                offerGroupItem,
            );
            const offers = offersPayload?.offersForOfferGroup?.items || [];
            const exactIndex = findExactOfferIndex(offers, productUrl);
            if (exactIndex < 0) {
                throw createWorkerError(
                    `YouTube Shopping không có đúng listing ${identity.offerId} trong nhóm ${offers.length} lựa chọn.`,
                    'EXACT_OFFER_NOT_FOUND',
                    'product-selection',
                    false,
                );
            }
            exactOffer = offers[exactIndex];
            log(`Resolved exact marketplace offer ${identity.offerId} by API (${exactIndex + 1}/${offers.length}).`);
        }
    }
    let writeTokenTag = tag;
    if (hasOptions) {
        writeTokenTag = null;
        const results = page.locator(
            'ytshopping-product-picker-search-result:visible',
        );
        for (let index = 1; index < await results.count(); index++) {
            const candidateProduct = results.nth(index)
                .locator('ytshopping-product').first();
            await candidateProduct.hover();
            const candidateTag = results.nth(index)
                .locator('ytcp-icon-button.tag-product-button').first();
            if (await candidateTag.isVisible({ timeout: 1000 }).catch(() => false)) {
                writeTokenTag = candidateTag;
                break;
            }
        }
        if (!writeTokenTag) {
            throw createWorkerError(
                'Không tìm được sản phẩm tạm để tạo mã xác thực ghi của YouTube Studio.',
                'WRITE_TOKEN_PRODUCT_NOT_FOUND',
                'authentication',
                true,
            );
        }
    } else {
        await product.hover();
    }
    await writeTokenTag.waitFor({ state: 'visible', timeout: 15_000 });
    await writeTokenTag.evaluate(element => {
        const button = element.shadowRoot?.querySelector('button')
            || element.querySelector('button')
            || element;
        button.click();
    });
    await page.waitForFunction(() => {
        const next = document.querySelector('ytcp-button#picker-next-button button');
        return next && !next.disabled && next.getAttribute('aria-disabled') !== 'true';
    }, null, { timeout: 10_000 });

    await clickPickerNextButton(page);
    await clickPickerDoneButton(page);
    const save = page.locator('ytcp-button#save button').first();
    try {
        await page.waitForFunction(() => {
            const button = document.querySelector('ytcp-button#save button');
            return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
        }, null, { timeout: 4_000 });
    } catch (error) {
        if (retryCount >= 1) throw error;
        log('Studio page state was stale after API cleanup; reloading once.');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        api.invalidateWriteSession();
        return bootstrapStudioWriteSession(
            page, videoId, productUrl, api, retryCount + 1,
        );
    }
    await save.click({ force: true });
    await waitForSaveToFinish(page, save);

    for (let attempt = 0; attempt < 30 && !api.hasWriteSession(); attempt++) {
        await page.waitForTimeout(100);
    }
    if (!api.hasWriteSession()) {
        log(`Studio write capture state: captured=${Boolean(api.writeSession)}, attestation=${Boolean(api.writeSession?.body?.attestationResponseData)}`);
        throw createWorkerError(
            'Không lấy được xác thực ghi từ YouTube Studio sau khi lưu.',
            'WRITE_SESSION_NOT_READY',
            'authentication',
            true,
        );
    }
    return { exactOffer };
}

async function cleanupStudioProductsUi(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    const productsButton = page.getByRole('button', {
        name: /^(Products|Sản phẩm),/i,
    }).first();
    const editButton = page.locator('ytcp-icon-button#shopping-toolbar-edit');
    await Promise.race([
        editButton.waitFor({ state: 'visible', timeout: 20_000 }),
        productsButton.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
    if (!await editButton.isVisible().catch(() => false)) {
        await productsButton.evaluate(element => element.click());
    }
    await editButton.waitFor({ state: 'visible', timeout: 10_000 });
    await editButton.evaluate(element => element.click());

    const search = page.locator('input#search-input.search-input');
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    const selected = page.locator(
        'ytshopping-product-picker-selected-product ytshopping-product',
    );
    while (await selected.count() > 0) {
        await selected.first().hover();
        await page.locator('ytcp-icon-button.delete-product-button').first()
            .click({ force: true });
        await page.waitForTimeout(100);
    }

    const done = page.locator(
        'ytcp-button#picker-save-button button, ytcp-button#picker-done-button button, button[aria-label="Done"], button[aria-label="Xong"]',
    ).first();
    await done.waitFor({ state: 'visible', timeout: 10_000 });
    await done.click({ force: true });

    const save = page.locator('ytcp-button#save button').first();
    await page.waitForFunction(() => {
        const button = document.querySelector('ytcp-button#save button');
        return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    }, null, { timeout: 10_000 });
    await save.click({ force: true });
    await waitForSaveToFinish(page, save);
}

async function discoverShoppingItemId(page, productUrl) {
    const productsButton = page.locator(
        'button:has(div.ytcpButtonShapeImpl__button-text-content)',
    ).filter({
        hasText: /(Sáº£n pháº©m|Products|tagged product|sáº£n pháº©m Ä‘Ã£ gáº¯n)/i,
    }).first();
    const editButton = page.locator('ytcp-icon-button#shopping-toolbar-edit');

    let search = page.locator('input#search-input.search-input');
    if (!await search.isVisible({ timeout: 300 }).catch(() => false)
        && !await editButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await productsButton.waitFor({ state: 'visible', timeout: 10_000 });
        await productsButton.click({ force: true });
    }
    if (!await search.isVisible({ timeout: 300 }).catch(() => false)) {
        await editButton.waitFor({ state: 'visible', timeout: 8_000 });
        await editButton.click({ force: true });
    }

    search = page.locator('input#search-input.search-input');
    await search.waitFor({ state: 'visible', timeout: 8_000 });
    await search.fill(productUrl);
    await search.press('Enter');

    const result = page.locator(
        'ytshopping-product-picker-search-result[ve-sibling-key]',
    ).first();
    await result.waitFor({ state: 'visible', timeout: 10_000 });
    const veSiblingKey = await result.getAttribute('ve-sibling-key');
    const shoppingItemId = extractShoppingItemId(veSiblingKey);
    log(`API product discovery: ${shoppingItemId}`);

    const close = page.locator(
        'ytcp-icon-button[aria-label="Close"], button[aria-label="Close"]',
    ).last();
    if (await close.isVisible({ timeout: 300 }).catch(() => false)) {
        await close.click({ force: true }).catch(() => { });
    } else {
        await page.keyboard.press('Escape').catch(() => { });
    }
    return shoppingItemId;
}

async function warmStudioApiSession(worker, page) {
    const existing = worker.studioApi;
    if (
        existing?.page === page
        && existing.session
        && Date.now() - existing.session.capturedAt < 5 * 60_000
    ) return existing;

    existing?.stop();
    const api = new StudioInternalApi(page).start();
    worker.studioApi = api;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await api.waitUntilReady(10_000);
    return api;
}

async function executeStudioApiJob(
    worker,
    page,
    browser,
    targetUrl,
    productUrl,
    providedAffiliateFallbackUrl,
) {
    const match = targetUrl.match(/\/video\/([^/]+)\//);
    if (!match) {
        throw createWorkerError(
            'URL YouTube Studio không chứa video ID hợp lệ.',
            'INVALID_VIDEO_URL',
            'validation',
            false,
        );
    }
    const videoId = match[1];
    const api = await warmStudioApiSession(worker, page);
    let productAdded = false;
    let primaryError = null;

    try {
        const addStarted = Date.now();
        api.invalidateWriteSession();
        log('Creating a fresh Studio write token with one automatic save.');
        const { exactOffer } = await bootstrapStudioWriteSession(
            page,
            videoId,
            productUrl,
            api,
        );
        productAdded = true;
        let shoppingItemId = exactOffer?.itemId?.rawMerchantOfferId
            || api.getWriteShoppingItemId();
        if (exactOffer?.itemId) {
            const exactUpdateStarted = Date.now();
            await api.updateProducts(videoId, [exactOffer.itemId]);
            log(`API exact-offer update took ${Date.now() - exactUpdateStarted}ms`);
        }
        if (!shoppingItemId) {
            const discovered = await api.searchProduct(videoId, productUrl);
            shoppingItemId = discovered.shoppingItemId;
        }
        log(`API add took ${Date.now() - addStarted}ms`);

        const affiliateStarted = Date.now();
        const data = await fetchAffiliateUrl(
            targetUrl,
            productUrl,
            browser,
            providedAffiliateFallbackUrl,
            {
                forcePublicShelf: true,
                maxAttempts: 3,
                retryDelayMs: 500,
            },
        );
        const expectedIdentity = extractMarketplaceListingIdentity(productUrl);
        const actualIdentity = extractMarketplaceListingIdentity(data.affiliateUrl);
        if (expectedIdentity && (
            actualIdentity?.productId !== expectedIdentity.productId
            || actualIdentity?.offerId !== expectedIdentity.offerId
        )) {
            throw createWorkerError(
                `YouTube trả về listing ${actualIdentity?.offerId || 'không xác định'} thay vì ${expectedIdentity.offerId}.`,
                'AFFILIATE_LISTING_MISMATCH',
                'affiliate-validation',
                true,
            );
        }
        log(`API affiliate lookup took ${Date.now() - affiliateStarted}ms`);
        return {
            ...data,
            metadata: {
                ...(data.metadata || {}),
                workerType: 'studio-api',
                shoppingItemId,
            },
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        if (productAdded || api.hasWriteSession()) {
            const removeStarted = Date.now();
            try {
                await cleanupStudioProductsUi(page);
                log(`Studio cleanup took ${Date.now() - removeStarted}ms`);
            } catch (error) {
                log(`Studio cleanup failed: ${shortErrorMessage(error)}; trying API fallback.`);
                try {
                    await api.updateProducts(videoId, []);
                    log(`API cleanup fallback took ${Date.now() - removeStarted}ms`);
                } catch (fallbackError) {
                    log(`API cleanup fallback failed: ${shortErrorMessage(fallbackError)}`);
                    if (primaryError) {
                        primaryError.cleanupError = shortErrorMessage(fallbackError);
                        primaryError.cleanupSucceeded = false;
                    } else {
                        throw fallbackError;
                    }
                }
            } finally {
                api.invalidateWriteSession();
            }
        }
    }
}

async function executeJob(jobId, targetUrl, productUrl, providedAffiliateFallbackUrl = null) {
    const jobStart = Date.now();
    log(`Job START: ${productUrl} on tab: ${targetUrl}`);

    let browser = null;
    let page = null;
    let worker = findWorkerForTargetUrl(targetUrl);
    if (!worker) {
        return {
            success: false,
            ...serializeJobError(createWorkerError(
                'Tab video chưa sẵn sàng trên API worker.',
                'VIDEO_NOT_READY',
                'browser-session',
                true,
            )),
        };
    }

    const lockOwner = `job:${jobId}`;
    if (!await acquireCdpLock(worker, lockOwner, { wait: true, timeout: 20000 })) {
        return {
            success: false,
            ...serializeJobError(createWorkerError(
                'Video đang xử lý một job khác. Vui lòng thử lại.',
                'WORKER_BUSY',
                'queue',
                true,
            )),
        };
    }

    worker.busy = true;
    try {
        const chromePage = await getChromePage(targetUrl, worker);
        browser = chromePage.browser;
        page = chromePage.page;
        worker = chromePage.worker;
        worker.busy = true;

        await page.bringToFront().catch(() => { });
        await page.waitForTimeout(300);

        if (USE_STUDIO_INTERNAL_API) {
            const data = await executeStudioApiJob(
                worker,
                page,
                browser,
                targetUrl,
                productUrl,
                providedAffiliateFallbackUrl,
            );
            log(`Total API job time: ${Date.now() - jobStart}ms`);
            log(`Affiliate URL: ${data.affiliateUrl}`);
            return { success: true, affiliateUrl: data.affiliateUrl, metadata: data.metadata };
        }

        await addProduct(page, productUrl);
        const addProductTime = Date.now() - jobStart;
        log(`addProduct took ${addProductTime}ms`);

        const fetchStart = Date.now();
        const data = await fetchAffiliateUrl(targetUrl, productUrl, browser, providedAffiliateFallbackUrl);
        log(`fetchAffiliateUrl took ${Date.now() - fetchStart}ms`);
        log(`Total job time: ${Date.now() - jobStart}ms`);
        log(`Affiliate URL: ${data.affiliateUrl}`);

        return { success: true, affiliateUrl: data.affiliateUrl, metadata: data.metadata };
    } catch (e) {
        log(`Error during job: ${shortErrorMessage(e)}`);
        try {
            if (page && browser && await isChromeCrashPage(page)) {
                await recoverWorkerPage(browser, browser.contexts()[0], worker, 'Chrome crash after job error');
            } else if (page) {
                await page.reload({ waitUntil: 'commit', timeout: 15000 });
                log('Page reloaded after error');
            }
        } catch (reloadErr) {
            log(`Failed to reload page: ${shortErrorMessage(reloadErr)}`);
        }
        return { success: false, ...serializeJobError(e) };
    } finally {
        await disconnectBrowser(browser);
        if (worker) {
            worker.busy = false;
            worker.lastRefreshAt = Date.now();
        }
        releaseCdpLock(worker, lockOwner);
    }
}

// ==================== Browser Management ====================

async function openBrowsers(urls) {
    if (browsersOpening) {
        log('[Recovery] Browser open/restart is already running, skipping duplicate request');
        return;
    }

    browsersOpening = true;
    try {
        // Kill existing workers
        for (const w of activeWorkers) {
            w.restarting = true;
            await stopWorkerBrowser(w, 'opening new browser set').catch(e => {
                log(`[Recovery] Failed to close port ${w.port}: ${e.message}`);
            });
        }
        activeWorkers = [];

        await new Promise(r => setTimeout(r, 500));

        const sessionsDir = path.resolve(__dirname, '..', SESSIONS_DIR);
        const defaultDataDir = path.join(sessionsDir, 'default', 'browser-data');
        let startPort = 19222;

        // Dirs to skip when cloning (cache = large & unnecessary)
        const SKIP_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache',
            'ShaderCache', 'Service Worker', 'ScriptCache', 'component_crx_cache', 'Sessions'];
        let sharedApiOwner = null;

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            if (USE_STUDIO_INTERNAL_API && sharedApiOwner) {
                try {
                    const browser = await connectWorkerBrowser(sharedApiOwner);
                    const context = browser.contexts()[0];
                    const page = await context.newPage();
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    const worker = {
                        process: null,
                        port: sharedApiOwner.port,
                        url,
                        sessionDir: sharedApiOwner.sessionDir,
                        busy: false,
                        restarting: false,
                        cdpLocked: null,
                        cdpBrowser: browser,
                        healthMisses: 0,
                        lastRefreshAt: Date.now(),
                        lastRecoveredAt: 0,
                        sharedApiOwner,
                    };
                    activeWorkers.push(worker);
                    log(`API tab ${i} opened in shared Chrome for URL: ${url}`);
                    const started = Date.now();
                    await warmStudioApiSession(worker, page);
                    log(`API session ${i} warmed in ${Date.now() - started}ms`);
                } catch (error) {
                    log(`Failed to open shared API tab ${i}: ${shortErrorMessage(error)}`);
                }
                continue;
            }

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
                    prepareProfileForLaunch(browserDataDir);
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
                const worker = {
                    process: child,
                    port,
                    url,
                    sessionDir,
                    busy: false,
                    restarting: false,
                    cdpLocked: null,
                    cdpBrowser: null,
                    healthMisses: 0,
                    lastRefreshAt: Date.now(),
                    lastRecoveredAt: 0,
                };
                activeWorkers.push(worker);
                if (USE_STUDIO_INTERNAL_API && !sharedApiOwner) sharedApiOwner = worker;
                log(`Browser ${i} opened on port ${port} for URL: ${url}`);
                if (USE_STUDIO_INTERNAL_API) {
                    try {
                        const chromePage = await getChromePage(url, worker);
                        const started = Date.now();
                        await warmStudioApiSession(worker, chromePage.page);
                        log(`API session ${i} warmed in ${Date.now() - started}ms`);
                    } catch (error) {
                        log(`API session ${i} chưa sẵn sàng: ${shortErrorMessage(error)}`);
                    }
                }
            } catch (e) {
                log(`Failed to launch browser ${i}: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 500));
        }
    } finally {
        browsersOpening = false;
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
        const registration = getRegistrationInfo();
        ws.send(JSON.stringify({
            type: 'register',
            urls: activeWorkers.map(w => w.url),
            hostname: os.hostname(),
            ...registration,
        }));
        log(`Registered ${activeWorkers.length} browser URL(s) with server`);
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'config-update') {
                // Server sends updated URLs
                const newUrls = msg.urls || [];
                if (USE_LOCAL_STUDIO_API_URLS) {
                    log('API worker dùng video_urls local; bỏ qua danh sách video trên server');
                    return;
                }
                log(`Nhận cấu hình mới: ${newUrls.length} URLs`);

                // Check if URLs changed
                const urlsChanged = JSON.stringify(newUrls.sort()) !== JSON.stringify(currentUrls.sort());
                if (urlsChanged && newUrls.length > 0) {
                    currentUrls = newUrls;
                    await openBrowsers(newUrls);

                    // Re-register with new URLs
                    if (ws.readyState === WebSocket.OPEN) {
                        const registration = getRegistrationInfo();
                        ws.send(JSON.stringify({
                            type: 'register',
                            urls: activeWorkers.map(w => w.url),
                            hostname: os.hostname(),
                            ...registration,
                        }));
                    }
                } else if (newUrls.length > 0 && activeWorkers.length === 0) {
                    // First config, open browsers
                    currentUrls = newUrls;
                    await openBrowsers(newUrls);

                    if (ws.readyState === WebSocket.OPEN) {
                        const registration = getRegistrationInfo();
                        ws.send(JSON.stringify({
                            type: 'register',
                            urls: activeWorkers.map(w => w.url),
                            hostname: os.hostname(),
                            ...registration,
                        }));
                    }
                }

            } else if (msg.type === 'execute-job') {
                // Execute job
                const { jobId, targetUrl, productUrl, affiliateFallbackUrl } = msg;
                log(`Nhận job: ${jobId} - ${productUrl}`);
                log(`Target video tab: ${targetUrl}`);
                if (affiliateFallbackUrl) log(`Provided affiliate fallback: ${String(affiliateFallbackUrl).slice(0, 180)}...`);

                jobStats.total++;
                let result;
                try {
                    result = await executeJob(jobId, targetUrl, productUrl, affiliateFallbackUrl);
                } catch (e) {
                    result = { success: false, ...serializeJobError(e) };
                    log(`Job failed before result handler: ${result.error}`);
                }
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

// Restart dead browser processes instead of silently dropping them.
setInterval(async () => {
    if (browsersOpening) return;
    for (const worker of activeWorkers) {
        if (worker.sharedApiOwner) continue;
        if (worker.busy || worker.restarting || worker.cdpLocked) continue;
        if (!isProcessAlive(worker.process)) {
            await restartWorkerBrowser(worker, 'Chrome process exited').catch(e => {
                log(`[Recovery] Failed to restart port ${worker.port}: ${e.message}`);
            });
        }
    }
}, 5000);

// Periodically check for stuck dialogs on all browser tabs and auto-dismiss + reload
setInterval(async () => {
    if (browsersOpening) return;
    for (const worker of activeWorkers) {
        if (worker.sharedApiOwner) continue;
        if (worker.busy || worker.restarting) continue;
        const lockOwner = 'watchdog-dialog';
        if (!await acquireCdpLock(worker, lockOwner, { wait: false })) continue;
        let browser = null;
        try {
            browser = await connectWorkerBrowser(worker);
            const contexts = browser.contexts();
            if (contexts.length > 0) {
                for (const page of contexts[0].pages()) {
                    // Register a one-time dialog handler to catch any pending dialog
                    let hadDialog = false;
                    const handler = (dialog) => {
                        hadDialog = true;
                        log(`[Watchdog] Dialog on port ${worker.port}: "${dialog.message()}" — dismissing & reloading`);
                        dialog.dismiss().catch(() => { });
                    };
                    page.on('dialog', handler);

                    // Quick check: try to evaluate something on the page
                    // If a dialog is blocking, this will trigger the handler
                    await page.evaluate(() => true).catch(() => { });

                    page.removeListener('dialog', handler);

                    if (hadDialog) {
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
                        log(`[Watchdog] Page reloaded on port ${worker.port}`);
                    }
                }
            }
        } catch {
            // Browser might be busy with a job, skip
        } finally {
            await disconnectBrowser(browser);
            releaseCdpLock(worker, lockOwner);
        }
    }
}, 15000);

// Stronger health check for Chrome's "Aw, Snap! / Out of Memory" crash page.
setInterval(async () => {
    if (browsersOpening) return;
    for (const worker of activeWorkers) {
        if (worker.busy || worker.restarting) continue;
        const lockOwner = 'watchdog-health';
        if (!await acquireCdpLock(worker, lockOwner, { wait: false })) continue;
        let browser = null;

        try {
            const processOwner = worker.sharedApiOwner || worker;
            if (!isProcessAlive(processOwner.process)) {
                worker.healthMisses = 0;
                if (!worker.sharedApiOwner) {
                    await restartWorkerBrowser(worker, 'health check found Chrome process exited');
                }
                continue;
            }

            if (!await waitForDebugPort(worker.port, 4000)) {
                worker.healthMisses = (worker.healthMisses || 0) + 1;
                log(`[Watchdog] Debug port ${worker.port} not reachable (${worker.healthMisses}/3)`);
                if (worker.healthMisses >= 3) {
                    await restartWorkerBrowser(worker, 'health check could not reach debug port after 3 tries');
                }
                continue;
            }
            worker.healthMisses = 0;

            browser = await connectWorkerBrowser(worker);
            const context = browser.contexts()[0];
            if (!context) {
                await restartWorkerBrowser(worker, 'missing browser context');
                continue;
            }

            let targetPage = context.pages().find(p => p.url() === worker.url || p.url().split('?')[0] === worker.url.split('?')[0]);
            if (!targetPage) {
                targetPage = await recoverWorkerPage(browser, context, worker, 'health check could not find target tab');
            } else if (await isChromeCrashPage(targetPage)) {
                targetPage = await recoverWorkerPage(browser, context, worker, 'Chrome Aw Snap / Out of Memory');
            }

            if (!USE_STUDIO_INTERNAL_API) {
                await closeExtraPages(context, targetPage);
            }

            if (Date.now() - (worker.lastRefreshAt || 0) > PAGE_IDLE_REFRESH_MS) {
                log(`[Watchdog] Periodic refresh on port ${worker.port} to release YouTube Studio memory`);
                await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
                    targetPage = await recoverWorkerPage(browser, context, worker, 'periodic refresh failed');
                });
                worker.lastRefreshAt = Date.now();
            }

        } catch (e) {
            if (!/Target page, context or browser has been closed|Connection closed|Browser closed/i.test(e.message)) {
                log(`[Watchdog] Health check skipped on port ${worker.port}: ${e.message}`);
            }
        } finally {
            await disconnectBrowser(browser);
            releaseCdpLock(worker, lockOwner);
        }
    }
}, BROWSER_HEALTH_INTERVAL_MS);

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Đang tắt worker...');
    for (const w of activeWorkers) {
        await stopWorkerBrowser(w, 'worker shutdown').catch(() => { });
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
            const registration = getRegistrationInfo();
            ws.send(JSON.stringify({
                type: 'register',
                urls: activeWorkers.map(w => w.url),
                hostname: os.hostname(),
                ...registration,
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
        .video-urls {
            width: 100%;
            min-height: 110px;
            resize: vertical;
            box-sizing: border-box;
            margin: 10px 0;
            padding: 12px;
            border: 1px solid #2a2a4a;
            border-radius: 8px;
            background: #0a0a18;
            color: #e0e0e0;
            font-family: Consolas, monospace;
            font-size: 12px;
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

        <div class="card" id="apiVideosCard">
            <div class="card-title">Video YouTube local cho API worker</div>
            <textarea class="video-urls" id="videoUrls" placeholder="Mỗi dòng một URL YouTube Studio"></textarea>
            <div class="actions">
                <button class="btn btn-primary" onclick="saveVideoUrls()">Lưu & mở browsers</button>
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
                const videoUrls = document.getElementById('videoUrls');
                if (data.apiMode && document.activeElement !== videoUrls) {
                    videoUrls.value = (data.localUrls || []).join('\\n');
                }
                document.getElementById('apiVideosCard').style.display = data.apiMode ? '' : 'none';

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

        async function saveVideoUrls() {
            try {
                const videoUrls = document.getElementById('videoUrls').value;
                const res = await fetch('/api/video-urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoUrls }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Không thể lưu');
                showToast('Đã mở ' + data.count + ' API browser');
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
                apiMode: USE_STUDIO_INTERNAL_API,
                localUrls: currentUrls,
                browsers: activeWorkers.map(w => ({ port: w.port, url: w.url })),
                apiReadyCount: activeWorkers.filter(worker => Boolean(worker.studioApi?.session)).length,
                jobStats,
                logs: recentLogs.slice(-50),
            }));
        } else if (url.pathname === '/api/video-urls' && req.method === 'POST') {
            if (!USE_STUDIO_INTERNAL_API) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Worker chưa chạy ở chế độ Studio API' }));
                return;
            }
            try {
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (raw.length > 100_000) throw new Error('Dữ liệu quá lớn');
                }
                const value = JSON.parse(raw || '{}').videoUrls || '';
                const urls = [...new Set(
                    String(value).split(/\r?\n/)
                        .map(item => item.trim())
                        .filter(Boolean),
                )];
                if (urls.some(item => !/^https:\/\/studio\.youtube\.com\/video\/[^/]+\/edit(?:[?#].*)?$/.test(item))) {
                    throw new Error('Mỗi dòng phải là URL YouTube Studio dạng /video/ID/edit');
                }
                currentUrls = urls;
                saveLocalStudioApiUrls(urls);
                await openBrowsers(urls);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const registration = getRegistrationInfo();
                    ws.send(JSON.stringify({
                        type: 'register',
                        urls: activeWorkers.map(worker => worker.url),
                        hostname: os.hostname(),
                        ...registration,
                    }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, count: activeWorkers.length, urls }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
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
        } else if (url.pathname === '/api/shutdown' && req.method === 'POST') {
            const remoteAddress = req.socket.remoteAddress || '';
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Local access only' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
        } else if (url.pathname === '/api/test-job' && req.method === 'POST') {
            const remoteAddress = req.socket.remoteAddress || '';
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Local access only' }));
                return;
            }
            if (!USE_STUDIO_INTERNAL_API) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Worker is not running in Studio API mode' }));
                return;
            }
            try {
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (raw.length > 100_000) throw new Error('Request body too large');
                }
                const body = JSON.parse(raw || '{}');
                const productUrl = String(body.productUrl || '').trim();
                const targetUrl = String(body.targetUrl || currentUrls[0] || '').trim();
                if (!/^https?:\/\//.test(productUrl)) throw new Error('productUrl is required');
                if (!targetUrl) throw new Error('No local video URL is configured');

                jobStats.total++;
                const startedAt = Date.now();
                const result = await executeJob(
                    `local-test-${Date.now()}`,
                    targetUrl,
                    productUrl,
                    body.affiliateFallbackUrl || null,
                );
                if (result.success) jobStats.success++; else jobStats.failed++;
                res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ...result,
                    targetUrl,
                    elapsedMs: Date.now() - startedAt,
                }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: shortErrorMessage(error) }));
            }
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
    if (USE_LOCAL_STUDIO_API_URLS) {
        currentUrls = loadLocalStudioApiUrls();
        log(`API worker đọc ${currentUrls.length} video URL local`);
        if (currentUrls.length > 0) await openBrowsers(currentUrls);
    }
    connect();
}

main().catch(console.error);
