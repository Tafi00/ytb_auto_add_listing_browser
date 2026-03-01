// Admin Dashboard - Single Profile Server

// Prevent unhandled errors from crashing the entire server
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (server continues):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (server continues):', reason?.message || reason);
});

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import { SessionManager } from './session-manager.js';
import { CONFIG } from './config.js';
import { addHistory, getHistory, getTotalLinks, clearAllHistory } from './history-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const sessionManager = new SessionManager({ sessionsDir: CONFIG.sessionsDir });

// Auto-create default profile if not exists
const PROFILE_ID = CONFIG.defaultProfile;
if (!sessionManager.exists(PROFILE_ID)) {
  sessionManager.create(PROFILE_ID, { description: 'Chrome Profile' });
  console.log(`[Server] Created default profile: ${PROFILE_ID}`);
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // tắt CSP vì SPA tự quản lý
  crossOriginEmbedderPolicy: false,
}));

// CORS - chỉ cho phép origin cụ thể trong production
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = cho phép tất cả (dev mode)
app.use(cors(allowedOrigins ? {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
} : undefined));

// Giới hạn body size để chống abuse (10MB cho upload, 1MB cho JSON)
app.use(express.json({ limit: '1mb' }));

// Rate limit chỉ cho public API get-affiliate (chống spam)
// Các API admin đã có auth bảo vệ, không cần rate limit

// Rate limit riêng cho login (chặt hơn)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // tối đa 10 lần login / IP / 15 phút
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

// Rate limit riêng cho public API get-affiliate (chống spam)
const affiliateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 phút
  max: 5, // tối đa 5 request / IP / phút
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn gửi quá nhiều yêu cầu. Vui lòng đợi 1 phút.' },
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress,
});

// Serve static files from web/dist in production
const distPath = path.resolve(__dirname, '../web/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Cảnh báo bảo mật khi dùng giá trị mặc định
if (JWT_SECRET === 'default-secret-change-me') {
  console.warn('⚠️  [Security] JWT_SECRET đang dùng giá trị mặc định. Hãy đổi trong .env!');
}
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('⚠️  [Security] ADMIN_PASSWORD đang dùng giá trị mặc định. Hãy đổi trong .env!');
}

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Login
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token, username });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// Verify token
app.get('/api/verify', auth, (req, res) => {
  res.json({ valid: true, username: req.user.username });
});

// ==================== Job Queue & Core Logic ====================

// Simple sequential queue
class JobQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }
  // Total pending = running (0 or 1) + waiting in queue
  get pending() {
    return (this.running ? 1 : 0) + this.queue.length;
  }
  push(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._next();
    });
  }
  async _next() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const { fn, resolve, reject } = this.queue.shift();
    try { resolve(await fn()); }
    catch (e) { reject(e); }
    finally { this.running = false; this._next(); }
  }
}

// Use per-tab Job Queues to allow concurrent processing across tabs
// while maintaining strict sequential execution within each tab
const tabQueues = new Map();
let globalJobCounter = 0;

let activeWorkers = [];

// Clean up dead workers
setInterval(() => {
  activeWorkers = activeWorkers.filter(w => {
    try {
      if (w.pid) {
        process.kill(w.pid, 0); // Check if process is still running
      }
      return true;
    } catch {
      return false; // Process dead
    }
  });
}, 5000);

function getQueueForTab(targetUrl) {
  if (!tabQueues.has(targetUrl)) {
    tabQueues.set(targetUrl, new JobQueue());
  }
  return tabQueues.get(targetUrl);
}

// Cache playwright module at top level for faster access
let _playwrightChromium = null;
async function getPlaywright() {
  if (!_playwrightChromium) {
    const pw = await import('playwright');
    _playwrightChromium = pw.chromium;
  }
  return _playwrightChromium;
}

// Connect to Chrome and get page
async function getChromePage(targetUrl) {
  const chromium = await getPlaywright();

  const targetBase = targetUrl ? targetUrl.split('?')[0] : null;
  let worker = targetUrl ? activeWorkers.find(w => w.url === targetUrl || w.url.startsWith(targetBase)) : null;

  if (!worker) {
    if (activeWorkers.length === 0) throw new Error('No browser running.');
    worker = activeWorkers[0]; // fallback
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${worker.port}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    await browser.close();
    throw new Error(`No browser context found on port ${worker.port}. Reopen browser.`);
  }
  const context = contexts[0];
  const pages = context.pages();

  let page;
  if (targetUrl) {
    page = pages.find(p => p.url() === targetUrl || p.url().startsWith(targetBase));
  }

  if (!page) {
    page = pages[0]; // Since 1 worker = 1 target url, just return its first page
  }
  return { browser, context, page };
}

// Add product and save (auto-removes existing product before adding)
// Returns a promise that resolves when save is complete
async function addProduct(page, productUrl) {
  // Wait for the Products row to at least be attached so we know the page has rendered
  const btn = page.locator('button:has(div.ytcpButtonShapeImpl__button-text-content)').filter({
    hasText: /(Sản phẩm|Products|tagged product|sản phẩm đã gắn)/i
  }).first();

  // Give the page a moment to render in case the edit panel is already open
  const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');

  // Try to wait for either the edit button or the products row to appear
  try {
    await Promise.race([
      editBtn.waitFor({ state: 'attached', timeout: 8000 }),
      btn.waitFor({ state: 'attached', timeout: 8000 })
    ]);
  } catch (e) {
    // Ignore timeout, we'll let the individual checks handle it
  }

  const editVisible = await editBtn.isVisible().catch(() => false);
  if (!editVisible) {
    await btn.waitFor({ state: 'attached', timeout: 15000 });
    await btn.evaluate(b => b.click()).catch(async () => {
      await btn.click({ force: true }).catch(() => { });
    });
    console.log('[Job] Clicked Products row (matched by regex)');
    // Wait for slide-in animation or UI update to settle before clicking edit
    await page.waitForTimeout(800);
  }

  // Use state: 'attached' and evaluate click to completely bypass Playwright's visibility/overlap checks
  await editBtn.waitFor({ state: 'attached', timeout: 10000 });
  await editBtn.evaluate(b => b.click()).catch(async () => {
    await editBtn.click({ force: true }).catch(() => { });
  });
  console.log('[Job] Clicked edit button');

  // Wait for product picker to fully load
  const searchInput = page.locator('input#search-input.search-input');
  await searchInput.waitFor({ state: 'visible', timeout: 10000 });

  // Step 1: Fill search input and press Enter FIRST (start searching immediately)
  await searchInput.click();
  await searchInput.fill(productUrl);
  console.log(`[Job] Filled product URL: ${productUrl}`);

  await searchInput.press('Enter');
  console.log('[Job] Pressed Enter to search');

  // Step 2: While search is loading, remove existing products in parallel
  try {
    const allProducts = page.locator('ytshopping-product-picker-selected-product ytshopping-product');
    let productCount = await allProducts.count().catch(() => 0);
    if (productCount > 0) {
      console.log(`[Job] Found ${productCount} existing product(s), removing while search loads...`);
      // Remove products one by one from the first element (DOM updates after each removal)
      while (productCount > 0) {
        const product = allProducts.first();
        const isVisible = await product.isVisible().catch(() => false);
        if (!isVisible) break;
        await product.hover();
        const deleteBtn = page.locator('ytcp-icon-button.delete-product-button[aria-label="Delete"]').first();
        await deleteBtn.waitFor({ state: 'visible', timeout: 10000 });
        await deleteBtn.click();
        console.log(`[Job] Removed product (${productCount} remaining before this removal)`);
        // Wait briefly for DOM to update after removal
        await page.waitForTimeout(300);
        productCount = await allProducts.count().catch(() => 0);
      }
      console.log('[Job] All existing products removed');
    }
  } catch (e) {
    console.log(`[Job] Warning: could not remove existing products: ${e.message}`);
  }

  // Step 3: Wait for search results (product tag button)
  const tagBtn = page.locator('ytcp-icon-button.tag-product-button[aria-label="Tag"]').first();
  try {
    await tagBtn.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    console.log('[Job] Product not found within 8s, reloading page...');
    await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
    throw new Error('Sản phẩm này không gắn giỏ được.');
  }

  // Check if banner-title has error message (product not eligible for shopping cart)
  const bannerText = await page.evaluate(() => {
    const el = document.querySelector(".banner-title > ytcp-msg");
    return el ? el.textContent : null;
  }).catch(() => null);

  if (bannerText !== null) {
    console.log(`[Job] Banner message detected: "${bannerText}", product cannot be added to cart. Reloading...`);
    await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
    throw new Error('Sản phẩm này không gắn giỏ được.');
  }

  await tagBtn.click();
  console.log('[Job] Clicked Tag button');

  const nextBtn = page.locator('ytcp-button#picker-next-button button').first();
  await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
  await nextBtn.click();
  console.log('[Job] Clicked Next button');

  const doneBtn = page.locator('button[aria-label="Done"]:has(div.ytcpButtonShapeImpl__button-text-content:text("Done"))').first();
  await doneBtn.waitFor({ state: 'visible', timeout: 10000 });
  await doneBtn.click();
  console.log('[Job] Clicked Done button');

  const saveBtn = page.locator('ytcp-button#save button').first();
  await saveBtn.waitFor({ state: 'attached', timeout: 10000 });

  // Give UI a moment to update button state
  await page.waitForTimeout(500);

  const isDisabled = await saveBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);

  if (isDisabled) {
    console.log('[Job] Save button is disabled (no net changes made to products). Proceeding directly.');
  } else {
    // Normal scroll to view and click
    await saveBtn.evaluate(b => b.scrollIntoView()).catch(() => { });
    await saveBtn.click({ force: true }).catch(async () => {
      await saveBtn.evaluate(b => b.click());
    });
    console.log('[Job] Clicked Save button');
    // Wait 1.5s after save for YouTube to update public page
    await page.waitForTimeout(1500);
    console.log('[Job] Save clicked, proceeding to fetch after 1.5s');
  }
} // End addProduct

// Decode unicode escapes helper (module-level for reuse)
const decodeUnicode = (str) => str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// Fetch affiliate URL from public YouTube page
// Optimized: reduced retry delay, faster parsing
async function fetchAffiliateUrl(videoUrl) {
  const videoIdMatch = videoUrl.match(/\/video\/([^/]+)\//);
  if (!videoIdMatch) throw new Error('Could not extract video ID from URL');
  const videoId = videoIdMatch[1];
  const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[Job] Fetching public video: ${publicUrl}`);

  let affiliateUrl = null;
  let metadata = { title: '', price: '', image: '' };

  // Retry up to 3 times (first immediately, then 200ms delay)
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`[Job] Attempt ${attempt} fetchAffiliateUrl retrying after 200ms...`);
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
    console.log(`[Job] Fetched page in ${Date.now() - fetchStart}ms (${(pageContent.length / 1024).toFixed(0)}KB)`);

    // Extract affiliate URL (Shopee or Lazada links)
    // Take FIRST match — old products are removed so first match is the correct one
    const allUrlMatches = [...pageContent.matchAll(/"url"\s*:\s*"(https:\/\/[^"]*(shopee\.vn|shp\.ee|lazada\.vn)[^"]*)"/g)];
    const urlMatch = allUrlMatches.length > 0 ? allUrlMatches[0] : null;
    if (urlMatch) {
      affiliateUrl = decodeUnicode(urlMatch[1]);

      // Extract product metadata from productListItemRenderer
      // Take FIRST product block — old products are removed so first is correct
      const blockMarker = 'productListItemRenderer":{"title"';
      const blockStart = pageContent.indexOf(blockMarker);
      if (blockStart !== -1) {
        const block = pageContent.substring(blockStart, blockStart + 5000);
        console.log('[Job] Product block (first, 600 chars):', block.substring(0, 600));

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

    console.log(`[Job] Attempt ${attempt} fetchAffiliateUrl failed to find affiliate link`);
  }

  console.log('[Job] Extracted metadata:', JSON.stringify(metadata));
  return { affiliateUrl, metadata };
}

// removeProduct is no longer needed — removal is integrated into addProduct

// ==================== Profile API ====================

// History stats (now backed by SQLite via history-db.js)

// Job config file path
const jobConfigPath = path.resolve(__dirname, '../config/job-config.json');

const loadJobConfig = () => {
  try {
    if (fs.existsSync(jobConfigPath)) return JSON.parse(fs.readFileSync(jobConfigPath, 'utf8'));
  } catch { }
  return { url: '' };
};

const saveJobConfig = (config) => {
  const dir = path.dirname(jobConfigPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobConfigPath, JSON.stringify(config, null, 2));
};

const CHROME_DEBUG_PORT = 19222;

const isChromeRunning = async () => {
  if (activeWorkers.length === 0) return false;
  // Check if at least one worker is alive
  for (const w of activeWorkers) {
    try {
      const res = await fetch(`http://127.0.0.1:${w.port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { }
  }
  return false;
};

// Get job config
app.get('/api/job-config', auth, (_, res) => {
  res.json(loadJobConfig());
});

// Save job config
app.put('/api/job-config', auth, async (req, res) => {
  const { url, productUrl } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const config = { url, productUrl: productUrl || '', updatedAt: new Date().toISOString() };
  saveJobConfig(config);

  res.json({ message: 'Config saved', ...config });
});

// Check browser status
app.get('/api/browser-status', auth, async (_, res) => {
  const running = await isChromeRunning();
  res.json({ running });
});

// History stats - get total count
app.get('/api/history-stats', auth, (_, res) => {
  res.json({ totalLinks: getTotalLinks() });
});

// History stats - reset (delete all)
app.delete('/api/history-stats', auth, (_, res) => {
  clearAllHistory();
  res.json({ message: 'Đã xóa toàn bộ lịch sử' });
});

// Rate limiting per client (15s cooldown)
const clientCooldowns = new Map();
const CLIENT_COOLDOWN_MS = 15000;

// Public API: get history by clientId
app.get('/api/history/:clientId', (req, res) => {
  const { clientId } = req.params;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  res.json(getHistory(clientId));
});

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of clientCooldowns) {
    if (now - time > CLIENT_COOLDOWN_MS * 2) clientCooldowns.delete(key);
  }
}, 5 * 60 * 1000);

// Validate product URL format
function isValidProductUrl(url) {
  try {
    const parsed = new URL(url);
    const validHosts = ['shopee.vn', 'www.shopee.vn', 's.shopee.vn', 'shp.ee', 'lazada.vn', 'www.lazada.vn', 's.lazada.vn', 'c.lazada.vn'];
    return validHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Check if input contains multiple links
function containsMultipleLinks(input) {
  const urlPattern = /https?:\/\/[^\s]+/g;
  const matches = input.match(urlPattern);
  return matches && matches.length > 1;
}

// Public API: get affiliate URL by product URL (uses Video URL from config)
app.post('/api/get-affiliate', async (req, res) => {
  const { productUrl, clientId } = req.body;
  if (!productUrl || typeof productUrl !== 'string') return res.status(400).json({ error: 'productUrl is required' });

  // Sanitize input - giới hạn độ dài
  const sanitizedUrl = productUrl.trim().slice(0, 2048);
  if (sanitizedUrl.length === 0) return res.status(400).json({ error: 'productUrl is required' });

  // Validate clientId nếu có
  if (clientId && (typeof clientId !== 'string' || clientId.length > 128)) {
    return res.status(400).json({ error: 'clientId không hợp lệ' });
  }

  // Check multiple links
  if (containsMultipleLinks(sanitizedUrl)) {
    return res.status(400).json({ error: 'Mỗi lần chỉ gửi 1 link' });
  }

  // Validate URL format immediately
  if (!isValidProductUrl(sanitizedUrl)) {
    return res.status(400).json({ error: 'Link sản phẩm không hợp lệ. Vui lòng nhập link Shopee hoặc Lazada.' });
  }

  // Rate limit by clientId + IP combo
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const rateLimitKey = clientId ? `${clientId}_${ip}` : ip;
  if (!req.body.bypassRateLimit) {
    const lastRequest = clientCooldowns.get(rateLimitKey);
    if (lastRequest && Date.now() - lastRequest < CLIENT_COOLDOWN_MS) {
      const wait = Math.ceil((CLIENT_COOLDOWN_MS - (Date.now() - lastRequest)) / 1000);
      return res.status(429).json({ error: `Vui lòng đợi ${wait}s trước khi gửi tiếp` });
    }
    clientCooldowns.set(rateLimitKey, Date.now());
  }

  const config = loadJobConfig();
  if (!config.url) return res.status(400).json({ error: 'No Video URL configured in admin' });

  const urlPattern = /https?:\/\/[^\s]+/g;
  const urls = config.url.match(urlPattern) || [];
  if (urls.length === 0) return res.status(400).json({ error: 'No Video URL configured in admin' });

  const running = await isChromeRunning();
  if (!running) return res.status(400).json({ error: 'Browser is not running' });

  try {
    // Select the tab (URL) that currently has the shortest queue
    let targetUrl = urls[0];
    let minPending = Infinity;

    for (const url of urls) {
      const q = getQueueForTab(url);
      if (q.pending < minPending) {
        minPending = q.pending;
        targetUrl = url;
      }
    }

    // We update the counter just for logging/tracking purposes if needed
    globalJobCounter++;

    const tabQueue = getQueueForTab(targetUrl);
    const queuePos = tabQueue.pending;
    console.log(`[API] Tab queue pending: ${queuePos}`);
    console.log(`[API] Assigned to: ${targetUrl} (position ${queuePos}), product: ${sanitizedUrl}`);

    const result = await tabQueue.push(async () => {
      const jobStart = Date.now();
      console.log(`[API] Job START for product: ${sanitizedUrl} on tab: ${targetUrl}`);
      const { browser, page } = await getChromePage(targetUrl);
      try {
        // CRITICAL: Bring the tab to the front so Chrome renders it properly
        // This prevents "Element is not visible" errors for background tabs
        await page.bringToFront().catch(() => { });
        // Wait a tiny bit for the browser to paint the newly active tab
        await page.waitForTimeout(300);

        // addProduct now auto-removes existing product before adding
        await addProduct(page, sanitizedUrl);
        const addProductTime = Date.now() - jobStart;
        console.log(`[API] addProduct took ${addProductTime}ms for product: ${sanitizedUrl}`);

        // Start fetching affiliate URL
        // After save is clicked and confirmed, the product is committed on YouTube's side.
        // We can now fetch the public page to get the affiliate link.
        const fetchStart = Date.now();
        const data = await fetchAffiliateUrl(targetUrl);
        console.log(`[API] fetchAffiliateUrl took ${Date.now() - fetchStart}ms for product: ${sanitizedUrl}`);
        console.log(`[API] Total job time: ${Date.now() - jobStart}ms`);
        console.log(`[API] Affiliate URL for ${sanitizedUrl}: ${data.affiliateUrl}`);

        // Verify: ensure affiliate URL contains the expected product domain
        if (data.affiliateUrl) {
          const productDomain = sanitizedUrl.includes('shopee') ? 'shopee' :
            sanitizedUrl.includes('lazada') ? 'lazada' : null;
          if (productDomain && !data.affiliateUrl.toLowerCase().includes(productDomain)) {
            console.warn(`[API] WARNING: Product domain mismatch! Expected ${productDomain} in affiliate URL but got: ${data.affiliateUrl}`);
          }
        }

        res.json({ affiliateUrl: data.affiliateUrl, metadata: data.metadata });

        // Save history to SQLite on success (fire-and-forget, don't block response)
        if (data.affiliateUrl) {
          try {
            addHistory(clientId || 'anonymous', {
              productUrl: sanitizedUrl,
              affiliateUrl: data.affiliateUrl,
              metadata: data.metadata || {},
              createdAt: new Date().toISOString(),
            });
          } catch (histErr) {
            console.log(`[API] History save error: ${histErr.message}`);
          }
        }

        await browser.close().catch(() => { });
        return data;
      } catch (e) {
        // Reload page to reset state after error
        console.log(`[API] Error during job for product ${sanitizedUrl}: ${e.message}`);
        try {
          await page.reload({ waitUntil: 'commit', timeout: 15000 });
          console.log('[API] Page reloaded after error');
        } catch (reloadErr) {
          console.log(`[API] Failed to reload page: ${reloadErr.message}`);
        }
        await browser.close().catch(() => { });
        throw e;
      }
    });
  } catch (e) {
    if (!res.headersSent) {
      // Không leak internal error ra ngoài cho public API ngoại trừ các lỗi đã biết
      console.error(`[API] get-affiliate error: ${e.message}`);
      const safeMessage = e.message.includes('không gắn giỏ')
        ? e.message
        : `Có lỗi xảy ra, vui lòng thử lại sau. (Chi tiết: ${e.message.substring(0, 150)})`;
      res.status(500).json({ error: safeMessage });
    } else {
      console.error(`[API] get-affiliate background error after response sent: ${e.message}`);
    }
  }
});

// Get profile info
app.get('/api/profile', auth, (_, res) => {
  try {
    const meta = sessionManager.getMetadata(PROFILE_ID);
    if (!meta) return res.status(404).json({ error: 'Profile not found' });
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function launchBrowsersAndStoreWorkers(urls) {
  // Kill existing workers before opening new ones
  for (const w of activeWorkers) {
    try { process.kill(w.pid); console.log(`[Server] Killed worker ${w.pid} before relaunch`); } catch { }

    // Attempt to forcefully clean up worker folders to prevent lock/busy issues
    try {
      const wDir = sessionManager.getSessionDir(w.sessionId);
      if (fs.existsSync(wDir)) {
        fs.rmSync(wDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch (e) {
      console.log(`[Server] Could not delete old worker dir: ${e.message}`);
    }
  }
  activeWorkers = [];

  // Quick wait for processes to exit
  await new Promise(r => setTimeout(r, 1000));

  const browserScript = path.resolve(__dirname, 'open-browser.js');
  let startPort = 19222;
  let x = 50, y = 50;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const port = startPort + i;
    const workerSessionId = `worker-${i}`;

    // Auto clone session for worker
    try {
      if (sessionManager.exists(workerSessionId)) {
        sessionManager.delete(workerSessionId);
        await new Promise(r => setTimeout(r, 200));
      }

      // Clean up locks in the default profile before cloning so it doesn't carry over
      const srcDataDir = sessionManager.getBrowserDataDir(PROFILE_ID);
      try { fs.rmSync(path.join(srcDataDir, 'SingletonLock'), { force: true }); } catch { }
      try { fs.rmSync(path.join(srcDataDir, 'SingletonCookie'), { force: true }); } catch { }
      try { fs.rmSync(path.join(srcDataDir, 'SingletonSocket'), { force: true }); } catch { }

      sessionManager.clone(PROFILE_ID, workerSessionId);

      // Clean up locks in the cloned worker profile just in case
      const destDataDir = sessionManager.getBrowserDataDir(workerSessionId);
      try { fs.rmSync(path.join(destDataDir, 'SingletonLock'), { force: true }); } catch { }
      try { fs.rmSync(path.join(destDataDir, 'SingletonCookie'), { force: true }); } catch { }
      try { fs.rmSync(path.join(destDataDir, 'SingletonSocket'), { force: true }); } catch { }
    } catch (e) {
      console.error(`[Server] Failed to prepare session for ${workerSessionId}:`, e.message);
    }

    const child = spawn('node', [
      browserScript,
      `--session=${workerSessionId}`,
      `--port=${port}`,
      `--position=${x},${y}`,
      url
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, SESSION_ID: workerSessionId },
      detached: true,
      stdio: 'ignore', // Keep server clean
    });

    child.unref(); // Detach deeply
    activeWorkers.push({ pid: child.pid, port, url, sessionId: workerSessionId, process: child });
    console.log(`[Server] Worker ${i} opened on port ${port} for URL: ${url}`);
    x += 50; y += 30; // Stagger UI

    // Give browser time to spin up
    await new Promise(r => setTimeout(r, 500));
  }
}

// Open browser
app.post('/api/profile/open-browser', auth, async (req, res) => {
  const jobConfig = loadJobConfig();
  // Collect all URLs to pass to open-browser script
  let allUrls = ['about:blank'];
  if (jobConfig.url) {
    const urlPattern = /https?:\/\/[^\s]+/g;
    const matches = jobConfig.url.match(urlPattern);
    if (matches && matches.length > 0) {
      allUrls = matches;
    }
  }

  await launchBrowsersAndStoreWorkers(allUrls);

  res.json({ message: 'Browsers opened', tabs: allUrls.length });
});

// Clear session data (cookies, localStorage, browser-data)
app.delete('/api/profile/session', auth, (req, res) => {
  try {
    // Kill existing workers before clearing session data
    for (const w of activeWorkers) {
      try { process.kill(w.pid); console.log(`[Server] Killed worker ${w.pid} before clearing session`); } catch { }
    }
    activeWorkers = [];

    // Remove session.json
    const sessionFile = sessionManager.getSessionFilePath(PROFILE_ID);
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);

    // Remove browser-data
    const browserDataDir = sessionManager.getBrowserDataDir(PROFILE_ID);
    if (fs.existsSync(browserDataDir)) {
      fs.rmSync(browserDataDir, { recursive: true, force: true });
      fs.mkdirSync(browserDataDir, { recursive: true });
    }

    sessionManager.updateMetadata(PROFILE_ID, { lastUsedAt: null });
    res.json({ message: 'Session cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Remote Browser Control ====================

// Lightweight page info (URL + title only, no screenshot)
// Track which tab (by CDP targetId) is currently active for remote control
let activeTargetId = null;

// Helper: get all page targets from CDP across all active workers
async function getCdpPageTargets() {
  const allTargets = [];
  for (const w of activeWorkers) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${w.port}/json`);
      const targets = await targetsRes.json();
      const pages = targets.filter(t => !['browser', 'background_page', 'service_worker', 'shared_worker'].includes(t.type)).map(t => ({
        ...t,
        port: w.port,
        workerId: w.sessionId
      }));
      allTargets.push(...pages);
    } catch (e) {
      // Worker might not have booted yet, ignore
    }
  }
  return allTargets;
}

// Helper: get the active target (or fall back to first page)
async function getActiveTarget() {
  const pages = await getCdpPageTargets();
  if (pages.length === 0) return null;
  if (activeTargetId) {
    const found = pages.find(t => t.id === activeTargetId);
    if (found) return found;
  }
  activeTargetId = pages[0].id;
  return pages[0];
}

// List all tabs
app.get('/api/browser/tabs', auth, async (_, res) => {
  try {
    const pages = await getCdpPageTargets();
    const tabs = pages.map((t, idx) => ({
      id: t.id,
      title: `${t.workerId || 'Worker'} - ${t.title || 'Untitled'}`,
      url: t.url,
      active: t.id === activeTargetId || (!activeTargetId && idx === 0),
    }));
    res.json({ tabs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Switch active tab
app.post('/api/browser/tabs/switch', auth, async (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  try {
    const pages = await getCdpPageTargets();
    const found = pages.find(t => t.id === targetId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    activeTargetId = targetId;
    await fetch(`http://127.0.0.1:${found.port}/json/activate/${targetId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new tab
app.post('/api/browser/tabs/new', auth, async (req, res) => {
  const { url } = req.body;
  try {
    const targetUrl = url || 'about:blank';
    const port = activeWorkers.length > 0 ? activeWorkers[0].port : 19222;
    const newRes = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`);
    const newTarget = await newRes.json();
    activeTargetId = newTarget.id;
    res.json({ ok: true, tab: { id: newTarget.id, title: newTarget.title || 'New Tab', url: newTarget.url } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close a tab
app.post('/api/browser/tabs/close', auth, async (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  try {
    const pages = await getCdpPageTargets();
    const found = pages.find(t => t.id === targetId);
    if (found) {
      await fetch(`http://127.0.0.1:${found.port}/json/close/${targetId}`);
    }
    // If we closed the active tab, reset
    if (activeTargetId === targetId) {
      activeTargetId = null;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/browser/page-info', auth, async (_, res) => {
  try {
    const target = await getActiveTarget();
    if (!target) return res.status(400).json({ error: 'No page' });
    res.json({ url: target.url, title: target.title || '', targetId: target.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Robustly find the Playwright page that matches the CDP target
function findMatchingPage(allPages, target) {
  // 1. Exact match
  let page = allPages.find(p => p.url() === target.url);
  if (page) return page;

  // 2. Base URL match (ignore queries/hashes that change during redirects)
  const targetBase = target.url.split('?')[0].split('#')[0];
  page = allPages.find(p => p.url().startsWith(targetBase));
  if (page) return page;

  // 3. Hostname match (very reliable for distinguishing popups like accounts.google.com)
  try {
    const targetHost = new URL(target.url).hostname;
    const sameHostPages = allPages.filter(p => {
      try { return new URL(p.url()).hostname === targetHost; } catch { return false; }
    });
    // If exactly one page has this hostname, it's our target!
    if (sameHostPages.length === 1) return sameHostPages[0];
  } catch { }

  // 4. If we know it's a popup (it's not the main page), guess the last opened one
  if (allPages.length > 1 && allPages[0].url() !== target.url) {
    return allPages[allPages.length - 1]; // Popups are appended
  }

  // Fallback
  return allPages[0];
}

// Screenshot via CDP directly
app.get('/api/browser/screenshot', auth, async (_, res) => {
  try {
    const target = await getActiveTarget();
    if (!target) return res.status(400).json({ error: 'No page found' });

    const port = target.port || 19222;
    const chromium = await getPlaywright();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contexts = browser.contexts();
    if (contexts.length === 0) { await browser.close(); return res.status(400).json({ error: 'No context' }); }

    const allPages = contexts[0].pages();
    const page = findMatchingPage(allPages, target);
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }

    const url = page.url();
    const title = await page.title().catch(() => '');

    const cdp = await page.context().newCDPSession(page);
    const layoutMetrics = await cdp.send('Page.getLayoutMetrics');
    const cssViewport = layoutMetrics.cssVisualViewport || layoutMetrics.visualViewport || {};
    const cssWidth = cssViewport.clientWidth || 1920;
    const cssHeight = cssViewport.clientHeight || 1080;

    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      clip: { x: 0, y: 0, width: cssWidth, height: cssHeight, scale: 1 },
    });
    await cdp.detach();
    await browser.close();

    res.json({
      image: `data:image/jpeg;base64,${data}`,
      url,
      title,
      viewport: { width: cssWidth, height: cssHeight },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: get Playwright page for the active target
async function getActivePage() {
  const target = await getActiveTarget();
  if (!target) throw new Error('No page');

  const port = target.port || 19222;
  const chromium = await getPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) { await browser.close(); throw new Error('No context'); }
  const allPages = contexts[0].pages();
  const page = findMatchingPage(allPages, target);
  if (!page) { await browser.close(); throw new Error('No page'); }
  return { browser, page };
}

// Navigate
app.post('/api/browser/navigate', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { browser, page } = await getActivePage();
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    await browser.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Click at coordinates via CDP (more accurate)
app.post('/api/browser/click', auth, async (req, res) => {
  const { x, y } = req.body;
  try {
    const { browser, page } = await getActivePage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await cdp.detach();
    await new Promise(r => setTimeout(r, 500));
    await browser.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Type text
app.post('/api/browser/type', auth, async (req, res) => {
  const { text } = req.body;
  try {
    const { browser, page } = await getActivePage();
    await page.keyboard.type(text, { delay: 50 });
    await browser.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scroll
app.post('/api/browser/scroll', auth, async (req, res) => {
  const { x, y, deltaX = 0, deltaY = 0 } = req.body;
  try {
    const { browser, page } = await getActivePage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || 0, y: y || 0, deltaX, deltaY });
    await cdp.detach();
    await browser.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Press key (Enter, Tab, Backspace, etc.)
app.post('/api/browser/key', auth, async (req, res) => {
  const { key } = req.body;
  try {
    const { browser, page } = await getActivePage();
    await page.keyboard.press(key);
    await browser.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Site Config (public page texts) ====================

const configDir = path.resolve(__dirname, '../config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

const siteConfigPath = path.resolve(configDir, 'site-config.json');
const uploadsDir = path.resolve(configDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const defaultSiteConfig = {
  pageTitle: 'GẮN SẢN PHẨM YOUTUBE',
  pageSubtitle: 'Nhập link sản phẩm Shopee, Lazada để gắn giỏ youtube',
  faviconUrl: '',
  noteTitle: 'Lưu ý máy tính',
  noteText: 'Tool chỉ hoạt động khi mở link sản phẩm đến ứng dụng Shopee trên điện thoại. Nếu bạn thực hiện trên máy tính, vui lòng copy link sản phẩm đã thêm Youtube hoặc Facebook và mở trên điện thoại.',
  tips: [
    'Không dùng nhiều tài khoản trên 1 thiết bị',
    'Không dùng cùng mã trên nhiều thiết bị chung mạng',
    'Không mua cùng shop liên tục trong thời gian ngắn',
  ],
  tipsFooter: 'Nếu không hiện mã: kiểm tra lượt còn, cập nhật Shopee, thử SP khác, đổi tài khoản.',
  productNote: 'Nếu mã không hiện, tài khoản của bạn có thể đã bị lọc, cần đổi tài khoản khác.',
  guideVideoUrl: '',
};

const loadSiteConfig = () => {
  try {
    if (fs.existsSync(siteConfigPath)) return { ...defaultSiteConfig, ...JSON.parse(fs.readFileSync(siteConfigPath, 'utf8')) };
  } catch { }
  return { ...defaultSiteConfig };
};

const saveSiteConfig = (config) => {
  fs.writeFileSync(siteConfigPath, JSON.stringify(config, null, 2));
};

// Public: get site config
app.get('/api/site-config', (_, res) => {
  res.json(loadSiteConfig());
});

// Admin: update site config
app.put('/api/site-config', auth, (req, res) => {
  const current = loadSiteConfig();
  const updated = { ...current, ...req.body, updatedAt: new Date().toISOString() };
  saveSiteConfig(updated);
  res.json(updated);
});

// Admin: upload guide video (giới hạn 50MB)
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
app.post('/api/upload-video', auth, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('video/')) {
    return res.status(400).json({ error: 'Only video files are allowed' });
  }

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_VIDEO_SIZE) {
    return res.status(413).json({ error: 'File quá lớn. Tối đa 50MB.' });
  }

  const ext = contentType.includes('mp4') ? '.mp4' : contentType.includes('webm') ? '.webm' : '.mp4';
  const filename = `guide-video${ext}`;
  const filepath = path.join(uploadsDir, filename);

  // Chống path traversal
  if (!filepath.startsWith(uploadsDir)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  let totalSize = 0;
  const chunks = [];
  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize > MAX_VIDEO_SIZE) {
      req.destroy();
      return res.status(413).json({ error: 'File quá lớn. Tối đa 50MB.' });
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    fs.writeFileSync(filepath, Buffer.concat(chunks));
    const videoUrl = `/uploads/${filename}`;
    const config = loadSiteConfig();
    config.guideVideoUrl = videoUrl;
    saveSiteConfig(config);
    res.json({ videoUrl });
  });
  req.on('error', (e) => res.status(500).json({ error: e.message }));
});

// Admin: upload favicon (giới hạn 2MB)
const MAX_FAVICON_SIZE = 2 * 1024 * 1024;
app.post('/api/upload-favicon', auth, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image files are allowed' });
  }

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_FAVICON_SIZE) {
    return res.status(413).json({ error: 'File quá lớn. Tối đa 2MB.' });
  }

  const ext = contentType.includes('png') ? '.png' : contentType.includes('svg') ? '.svg' : contentType.includes('gif') ? '.gif' : '.ico';
  const filename = `favicon${ext}`;
  const filepath = path.join(uploadsDir, filename);

  // Chống path traversal
  if (!filepath.startsWith(uploadsDir)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  let totalSize = 0;
  const chunks = [];
  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize > MAX_FAVICON_SIZE) {
      req.destroy();
      return res.status(413).json({ error: 'File quá lớn. Tối đa 2MB.' });
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    fs.writeFileSync(filepath, Buffer.concat(chunks));
    const faviconUrl = `/uploads/${filename}`;
    const config = loadSiteConfig();
    config.faviconUrl = faviconUrl;
    saveSiteConfig(config);
    res.json({ faviconUrl });
  });
  req.on('error', (e) => res.status(500).json({ error: e.message }));
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// SPA fallback
app.get('*', (_, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Build web UI first: cd web && npm run build');
  }
});

const server = http.createServer(app);

// ==================== WebSocket Screencast ====================
const wss = new WebSocketServer({ server, path: '/ws/screencast' });

wss.on('connection', async (ws, req) => {
  // Verify JWT from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[Screencast] Client connected');
  let cdpWs = null;
  let sessionId = null;
  let alive = true;
  let cmdId = 1;
  let currentTargetId = null;
  let switchingTab = false;
  let knownTargetIds = new Set();
  let newTabPollTimer = null;
  let currentPort = null;

  // Popup tracking — secondary CDP screencast for popup windows
  let popupCdpWs = null;
  let popupTargetId = null;
  let popupCmdId = 5000; // separate cmd ID range to avoid collisions

  // Debug logging - sends to console AND frontend WS
  function debugLog(msg) {
    console.log(`[Screencast] ${msg}`);
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'debug', message: msg }));
      }
    } catch { }
  }

  ws.on('close', () => {
    alive = false;
    console.log('[Screencast] Client disconnected');
    stopScreencast();
    stopPopupScreencast();
    stopNewTabPoll();
  });

  ws.on('error', () => {
    alive = false;
    stopScreencast();
    stopPopupScreencast();
    stopNewTabPoll();
  });

  // Handle input commands from client (click, scroll, switchTab, popup*) via the same CDP connection
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'switchTab') {
        // Client wants to switch to a different tab
        activeTargetId = msg.targetId;
        connectToTarget(msg.targetId).catch(() => { });
        return;
      }

      // === Popup input commands — route to the popup CDP session ===
      if (msg.type === 'popupClick' || msg.type === 'popupScroll' || msg.type === 'popupType' || msg.type === 'popupKey') {
        const pCdp = popupCdpWs;
        if (!pCdp || pCdp.readyState !== pCdp.OPEN) return;
        try {
          if (msg.type === 'popupClick') {
            const { x, y } = msg;
            pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } }));
            pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } }));
          } else if (msg.type === 'popupScroll') {
            const { x, y, deltaX, deltaY } = msg;
            pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: x || 0, y: y || 0, deltaX: deltaX || 0, deltaY: deltaY || 0 } }));
          } else if (msg.type === 'popupType') {
            const { text } = msg;
            for (const char of text) {
              pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}` } }));
              pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: char, code: `Key${char.toUpperCase()}` } }));
            }
          } else if (msg.type === 'popupKey') {
            const { key } = msg;
            pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key, code: key } }));
            pCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key, code: key } }));
          }
        } catch (e) {
          debugLog(`Popup input error: ${e.message}`);
        }
        return;
      }

      if (msg.type === 'closePopup') {
        // Client requests closing the popup
        if (popupTargetId && currentPort) {
          fetch(`http://127.0.0.1:${currentPort}/json/close/${popupTargetId}`).catch(() => { });
        }
        stopPopupScreencast();
        return;
      }

      // === Main page input commands ===
      const currentCdp = cdpWs; // snapshot to avoid race
      if (!currentCdp || currentCdp.readyState !== currentCdp.OPEN) return;
      try {
        if (msg.type === 'click') {
          const { x, y } = msg;
          currentCdp.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } }));
          currentCdp.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } }));
        } else if (msg.type === 'scroll') {
          const { x, y, deltaX, deltaY } = msg;
          currentCdp.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: x || 0, y: y || 0, deltaX: deltaX || 0, deltaY: deltaY || 0 } }));
        }
      } catch (sendErr) {
        console.log(`[Screencast] Error sending input command: ${sendErr.message}`);
      }
    } catch { }
  });

  async function stopScreencast() {
    if (cdpWs && cdpWs.readyState === cdpWs.OPEN) {
      try {
        cdpWs.send(JSON.stringify({ id: 999, method: 'Page.stopScreencast' }));
      } catch { }
      setTimeout(() => { try { cdpWs.close(); } catch { } }, 200);
    }
    cdpWs = null;
  }

  function stopPopupScreencast() {
    if (popupCdpWs && popupCdpWs.readyState === popupCdpWs.OPEN) {
      try {
        popupCdpWs.send(JSON.stringify({ id: 9999, method: 'Page.stopScreencast' }));
      } catch { }
      setTimeout(() => { try { popupCdpWs.close(); } catch { } }, 200);
    }
    popupCdpWs = null;
    popupTargetId = null;
    // Notify frontend that popup is closed
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'popupClosed' }));
      }
    } catch { }
  }

  function stopNewTabPoll() {
    if (newTabPollTimer) { clearInterval(newTabPollTimer); newTabPollTimer = null; }
  }

  // Centralized auto-switch with /json/activate
  async function autoSwitchToTab(newTargetId, source) {
    if (!alive || switchingTab || newTargetId === currentTargetId) return;
    switchingTab = true;
    debugLog(`Auto-switching to ${newTargetId} (via ${source})`);
    try {
      // Activate the tab in Chrome so it becomes foreground
      if (currentPort) {
        try { await fetch(`http://127.0.0.1:${currentPort}/json/activate/${newTargetId}`); } catch { }
      }
      activeTargetId = newTargetId;
      await connectToTarget(newTargetId);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'tabChanged', targetId: newTargetId }));
      }
      debugLog(`Switched to ${newTargetId} OK`);
    } catch (e) {
      debugLog(`Switch failed: ${e.message}`);
    }
    switchingTab = false;
  }

  // Poll /json every 1 second to detect new tabs
  function startNewTabPoll(port) {
    stopNewTabPoll();
    currentPort = port;
    debugLog(`Poll started on port ${port}, known: [${[...knownTargetIds].join(', ')}]`);

    newTabPollTimer = setInterval(async () => {
      if (!alive || switchingTab) return;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        const targets = await res.json();
        const pageTargets = targets.filter(t => !['browser', 'background_page', 'service_worker', 'shared_worker'].includes(t.type));

        for (const t of pageTargets) {
          if (!knownTargetIds.has(t.id)) {
            knownTargetIds.add(t.id);
            // Don't auto-switch to popup targets or when a popup is already active
            if (t.id !== currentTargetId && t.id !== popupTargetId && !popupTargetId) {
              debugLog(`Poll: new tab ${t.id} (${t.url})`);
              await autoSwitchToTab(t.id, 'polling');
              break;
            }
          }
        }

        // Clean stale IDs
        const currentIds = new Set(pageTargets.map(t => t.id));
        for (const id of knownTargetIds) {
          if (!currentIds.has(id)) knownTargetIds.delete(id);
        }
      } catch { }
    }, 1000);
  }

  // Handle Page.windowOpen: open popup screencast dialog instead of switching tabs
  async function handleNewWindowOpened(port, popupUrl) {
    if (!alive) return;
    debugLog(`Page.windowOpen detected! url=${popupUrl}`);
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const pageTargets = targets.filter(t => !['browser', 'background_page', 'service_worker', 'shared_worker'].includes(t.type));
      const newTab = pageTargets.find(t => !knownTargetIds.has(t.id) && t.id !== currentTargetId);
      if (newTab) {
        knownTargetIds.add(newTab.id);
        debugLog(`Popup found: ${newTab.id} (${newTab.url})`);
        // Start secondary popup screencast instead of switching main view
        await startPopupScreencast(newTab, port);
      } else {
        for (const t of pageTargets) knownTargetIds.add(t.id);
        debugLog('windowOpen: no new tab found in /json');
      }
    } catch (e) {
      debugLog(`windowOpen error: ${e.message}`);
    }
  }

  // Start a secondary CDP screencast for the popup target
  async function startPopupScreencast(popupTarget, port) {
    // Stop any existing popup screencast first
    stopPopupScreencast();
    popupTargetId = popupTarget.id;

    debugLog(`Starting popup screencast for ${popupTarget.id} (${popupTarget.url})`);

    try {
      const { default: WebSocket } = await import('ws');
      const newPopupCdp = new WebSocket(popupTarget.webSocketDebuggerUrl);
      popupCdpWs = newPopupCdp;

      newPopupCdp.on('open', () => {
        if (popupCdpWs !== newPopupCdp || !alive) {
          try { newPopupCdp.close(); } catch { }
          return;
        }
        try {
          newPopupCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Page.enable' }));
          newPopupCdp.send(JSON.stringify({
            id: popupCmdId++,
            method: 'Page.startScreencast',
            params: { format: 'jpeg', quality: 60, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 }
          }));
          debugLog(`Popup screencast started for ${popupTarget.id}`);
          // Notify frontend that popup is opened
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'popupOpened',
              targetId: popupTarget.id,
              url: popupTarget.url,
              title: popupTarget.title || 'Popup',
            }));
          }
        } catch (e) {
          debugLog(`Error starting popup screencast: ${e.message}`);
        }
      });

      newPopupCdp.on('message', (data) => {
        if (!alive || popupCdpWs !== newPopupCdp) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.screencastFrame') {
            const { data: frameData, metadata, sessionId: sid } = msg.params;
            if (newPopupCdp.readyState === newPopupCdp.OPEN) {
              newPopupCdp.send(JSON.stringify({ id: popupCmdId++, method: 'Page.screencastFrameAck', params: { sessionId: sid } }));
            }
            // Send popup frames with type='popupFrame' so frontend can display them in the dialog
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'popupFrame',
                image: `data:image/jpeg;base64,${frameData}`,
                metadata,
              }));
            }
          } else if (msg.method === 'Page.frameNavigated') {
            // Update popup URL in frontend
            const url = msg.params?.frame?.url;
            if (url && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'popupNavigated', url }));
            }
          }
        } catch { }
      });

      newPopupCdp.on('close', () => {
        debugLog(`Popup CDP closed for ${popupTarget.id}`);
        if (popupCdpWs === newPopupCdp) {
          stopPopupScreencast();
        }
      });

      newPopupCdp.on('error', (err) => {
        debugLog(`Popup CDP error: ${err.message}`);
      });

      // Monitor when popup tab is closed (poll)
      const popupMonitor = setInterval(async () => {
        if (!alive || !popupTargetId) { clearInterval(popupMonitor); return; }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          const targets = await res.json();
          const stillExists = targets.some(t => t.id === popupTargetId);
          if (!stillExists) {
            debugLog(`Popup ${popupTargetId} closed (detected by poll)`);
            clearInterval(popupMonitor);
            stopPopupScreencast();
          }
        } catch { }
      }, 1500);

    } catch (e) {
      debugLog(`Failed to start popup screencast: ${e.message}`);
    }
  }

  async function connectToTarget(targetId) {
    await stopScreencast();
    cmdId = 1;

    try {
      const pages = await getCdpPageTargets();
      debugLog(`connectToTarget(${targetId || 'null'}): ${pages.length} pages [${pages.map(p => p.id).join(', ')}]`);

      const target = targetId ? pages.find(t => t.id === targetId) : pages[0];
      if (!target || !target.webSocketDebuggerUrl) {
        debugLog(`Target ${targetId} not found`);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'No browser page found' }));
        return;
      }
      currentTargetId = target.id;
      const targetPort = target.port || 19222;
      currentPort = targetPort;

      // Activate the tab in Chrome
      try { await fetch(`http://127.0.0.1:${targetPort}/json/activate/${target.id}`); } catch { }

      // Update known targets to prevent falsely detecting existing tabs as new
      for (const p of pages) knownTargetIds.add(p.id);

      // Start polling if not already running
      if (!newTabPollTimer) {
        startNewTabPoll(targetPort);
      }

      const { default: WebSocket } = await import('ws');
      const newCdpWs = new WebSocket(target.webSocketDebuggerUrl);
      cdpWs = newCdpWs;

      newCdpWs.on('open', () => {
        // Check if this connection is still the active one (race condition guard)
        if (cdpWs !== newCdpWs || !alive) {
          try { newCdpWs.close(); } catch { }
          return;
        }
        try {
          newCdpWs.send(JSON.stringify({ id: cmdId++, method: 'Page.enable' }));
          // Enable Target domain for targetCreated events
          newCdpWs.send(JSON.stringify({ id: cmdId++, method: 'Target.setDiscoverTargets', params: { discover: true } }));
          newCdpWs.send(JSON.stringify({
            id: cmdId++,
            method: 'Page.startScreencast',
            params: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 }
          }));
          debugLog(`Screencast started for ${target.id} (${target.url})`);
        } catch (e) {
          debugLog(`Error starting screencast: ${e.message}`);
        }
      });

      newCdpWs.on('message', (data) => {
        if (!alive || cdpWs !== newCdpWs) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.screencastFrame') {
            const { data: frameData, metadata, sessionId: sid } = msg.params;
            sessionId = sid;
            if (newCdpWs.readyState === newCdpWs.OPEN) {
              newCdpWs.send(JSON.stringify({ id: cmdId++, method: 'Page.screencastFrameAck', params: { sessionId: sid } }));
            }
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'frame',
                image: `data:image/jpeg;base64,${frameData}`,
                metadata
              }));
            }
          } else if (msg.method === 'Page.windowOpen') {
            debugLog(`Page.windowOpen: url=${msg.params?.url}`);
            handleNewWindowOpened(targetPort, msg.params?.url).catch(() => { });
          } else if (msg.method === 'Target.targetCreated') {
            const info = msg.params?.targetInfo;
            if (info && !['browser', 'background_page', 'service_worker', 'shared_worker'].includes(info.type) && info.targetId !== currentTargetId) {
              if (!knownTargetIds.has(info.targetId)) {
                debugLog(`Target.targetCreated: ${info.targetId} (${info.url} - ${info.type})`);
                knownTargetIds.add(info.targetId);
                // Don't auto-switch if this target is already being handled as a popup
                if (info.targetId !== popupTargetId) {
                  setTimeout(() => autoSwitchToTab(info.targetId, 'Target.targetCreated').catch(() => { }), 500);
                }
              }
            }
          }
        } catch { }
      });

      newCdpWs.on('close', () => {
        if (alive && ws.readyState === ws.OPEN && cdpWs === newCdpWs) {
          ws.send(JSON.stringify({ type: 'error', error: 'CDP connection closed' }));
        }
      });

      newCdpWs.on('error', (err) => {
        console.log(`[Screencast] CDP error: ${err.message}`);
      });

    } catch (e) {
      console.log(`[Screencast] Error: ${e.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', error: e.message }));
      }
    }
  }

  // Initial connection — use active target
  connectToTarget(activeTargetId);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin Dashboard running on http://localhost:${PORT}`);

  // Auto-launch browser on startup (non-blocking)
  (async () => {
    const running = await isChromeRunning();
    if (running) {
      console.log('[Server] Chrome already running');
      return;
    }
    try {
      const jobConfig = loadJobConfig();
      const urlPattern = /https?:\/\/[^\s]+/g;
      const startUrls = jobConfig.url ? jobConfig.url.match(urlPattern) || [] : [];
      if (startUrls.length === 0) startUrls.push('https://www.youtube.com');

      await launchBrowsersAndStoreWorkers(startUrls);
    } catch (e) {
      console.error('[Server] Failed to auto-start browser:', e.message);
      console.log('[Server] Server continues without browser. Use admin panel to start it.');
    }
  })();
});
