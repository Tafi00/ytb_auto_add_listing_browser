// Admin Dashboard - Single Profile Server
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

const jobQueue = new JobQueue();

// Connect to Chrome and get page
async function getChromePage() {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    await browser.close();
    throw new Error('No browser context found. Reopen browser.');
  }
  const context = contexts[0];
  const pages = context.pages();

  // Ưu tiên tìm tab đang mở Youtube Studio, nếu không có thì lấy tab đầu tiên
  let page = pages.find(p => p.url().includes('studio.youtube.com'));
  if (!page) {
    page = pages[0] || (await context.newPage());
  }
  return { browser, context, page };
}

// Add product and save
async function addProduct(page, productUrl) {
  // Click "Sản phẩm" / "Products" only if edit button is not visible
  const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');
  const editVisible = await editBtn.isVisible().catch(() => false);
  if (!editVisible) {
    const btn = page.locator('button:has(div.ytcpButtonShapeImpl__button-text-content:text("Sản phẩm")), button:has(div.ytcpButtonShapeImpl__button-text-content:text("Products"))').first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click();
    console.log('[Job] Clicked "Sản phẩm/Products"');
  }

  await editBtn.waitFor({ state: 'visible', timeout: 10000 });
  await editBtn.click();
  console.log('[Job] Clicked edit button');

  const searchInput = page.locator('input#search-input.search-input');
  await searchInput.waitFor({ state: 'visible', timeout: 10000 });
  await searchInput.click();
  await searchInput.fill(productUrl);
  console.log(`[Job] Filled product URL: ${productUrl}`);

  await searchInput.press('Enter');
  console.log('[Job] Pressed Enter to search');

  // Wait up to 5s for product to appear, if not found reload and throw error
  const tagBtn = page.locator('ytcp-icon-button.tag-product-button[aria-label="Tag"]').first();
  try {
    await tagBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    console.log('[Job] Product not found within 5s, reloading page...');
    await page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => { });
    throw new Error('Sản phẩm này không gắn giỏ được.');
  }
  await tagBtn.click();
  console.log('[Job] Clicked Tag button');

  const nextBtn = page.locator('ytcp-button#picker-next-button button').first();
  await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
  await nextBtn.click();
  console.log('[Job] Clicked Next button');

  const doneBtn = page.locator('button[aria-label="Done"]:has(div.ytcpButtonShapeImpl__button-text-content:text("Done"))').first();
  await doneBtn.waitFor({ state: 'visible', timeout: 5000 });
  await doneBtn.click();
  console.log('[Job] Clicked Done button');

  const saveBtn = page.locator('ytcp-button#save button').first();
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await saveBtn.click();
  console.log('[Job] Clicked Save button');
  await page.waitForTimeout(3000);
}

// Fetch affiliate URL from public YouTube page
async function fetchAffiliateUrl(videoUrl) {
  const videoIdMatch = videoUrl.match(/\/video\/([^/]+)\//);
  if (!videoIdMatch) throw new Error('Could not extract video ID from URL');
  const videoId = videoIdMatch[1];
  const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[Job] Fetching public video: ${publicUrl}`);

  // Decode unicode escapes helper
  const decodeUnicode = (str) => str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  let affiliateUrl = null;
  let metadata = { title: '', price: '', image: '' };

  // Lặp retry tối đa 5 lần (mỗi lần cách 2s) = chờ tối đa 10s cho dữ liệu YT cập nhật
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(publicUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' }
    });
    const pageContent = await response.text();

    // Extract affiliate URL (Bắt mọi link thuộc Shopee hoặc Lazada)
    const urlMatch = pageContent.match(/"url"\s*:\s*"(https:\/\/[^"]*(shopee\.vn|shp\.ee|lazada\.vn)[^"]*)"/);
    if (urlMatch) {
      affiliateUrl = decodeUnicode(urlMatch[1]);

      // Extract product metadata from productListItemRenderer
      const blockMarker = 'productListItemRenderer":{"title"';
      const blockStart = pageContent.indexOf(blockMarker);
      if (blockStart !== -1) {
        const block = pageContent.substring(blockStart, blockStart + 5000);
        console.log('[Job] Product block (first 600):', block.substring(0, 600));

        // Title from simpleText - first occurrence
        const titleMatch = block.match(/simpleText":"([^"]+)"/);
        if (titleMatch) metadata.title = decodeUnicode(titleMatch[1]);

        // Price: "147.869 ₫" or "₫147,869" format
        const priceMatch = block.match(/([0-9][0-9.,]+)\s*₫/) || block.match(/₫\s*([0-9][0-9,.]+)/);
        if (priceMatch) metadata.price = decodeUnicode(priceMatch[1]) + ' ₫';

        // Thumbnails: match all gstatic shopping URLs
        const thumbUrls = [...block.matchAll(/(https?:\/\/encrypted-tbn\d+\.gstatic\.com\/shopping\?q=tbn:[A-Za-z0-9_-]+)/g)]
          .map(m => decodeUnicode(m[1]));
        if (thumbUrls.length > 0) metadata.image = thumbUrls[thumbUrls.length - 1];
      }
      break; // Thành công, thoát vòng lặp
    }

    console.log(`[Job] Attempt ${attempt} fetchAffiliateUrl failed to find affiliate link, waiting 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('[Job] Extracted metadata:', JSON.stringify(metadata));

  return { affiliateUrl, metadata };
}

// Remove product and save
async function removeProduct(page) {
  console.log('[Job] Removing product from video...');

  const editBtn = page.locator('ytcp-icon-button#shopping-toolbar-edit');
  await editBtn.waitFor({ state: 'visible', timeout: 10000 });
  await editBtn.click();
  console.log('[Job] Clicked edit button for removal');

  const product = page.locator('ytshopping-product-picker-selected-product ytshopping-product').first();
  await product.waitFor({ state: 'visible', timeout: 10000 });
  await product.hover();
  console.log('[Job] Hovered on product');

  const deleteBtn = page.locator('ytcp-icon-button.delete-product-button[aria-label="Delete"]').first();
  await deleteBtn.waitFor({ state: 'visible', timeout: 5000 });
  await deleteBtn.click();
  console.log('[Job] Clicked Delete button');

  const doneBtn = page.locator('button[aria-label="Done"]:has(div.ytcpButtonShapeImpl__button-text-content:text("Done"))').first();
  await doneBtn.waitFor({ state: 'visible', timeout: 5000 });
  await doneBtn.click();
  console.log('[Job] Clicked Done button (remove)');

  const saveBtn = page.locator('ytcp-button#save button').first();
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await saveBtn.click();
  console.log('[Job] Clicked Save button (remove)');
  await page.waitForTimeout(2000);
  console.log('[Job] Remove completed');
}

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

// Helper: check if Chrome debugging port is available
const CHROME_DEBUG_PORT = 19222;
const isChromeRunning = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
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

  // Navigate browser to new URL if running
  const running = await isChromeRunning();
  if (running) {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        const pages = contexts[0].pages();
        // Ưu tiên tìm tab đang mở Youtube Studio, nếu không thì dùng tab đầu tiên
        const page = pages.find(p => p.url().includes('studio.youtube.com')) || pages[0];
        if (page) await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
      }
      await browser.close();
    } catch { }
  }

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
app.post('/api/get-affiliate', affiliateLimiter, async (req, res) => {
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
  const lastRequest = clientCooldowns.get(rateLimitKey);
  if (lastRequest && Date.now() - lastRequest < CLIENT_COOLDOWN_MS) {
    const wait = Math.ceil((CLIENT_COOLDOWN_MS - (Date.now() - lastRequest)) / 1000);
    return res.status(429).json({ error: `Vui lòng đợi ${wait}s trước khi gửi tiếp` });
  }
  clientCooldowns.set(rateLimitKey, Date.now());

  const config = loadJobConfig();
  if (!config.url) return res.status(400).json({ error: 'No Video URL configured in admin' });

  const running = await isChromeRunning();
  if (!running) return res.status(400).json({ error: 'Browser is not running' });

  try {
    const result = await jobQueue.push(async () => {
      const { browser, page } = await getChromePage();
      try {
        await addProduct(page, sanitizedUrl);
        const data = await fetchAffiliateUrl(config.url);
        console.log(`[API] Affiliate URL: ${data.affiliateUrl}`);

        // Gửi response sớm cho client không bị đợi lâu quá trình remove
        res.json({ affiliateUrl: data.affiliateUrl, metadata: data.metadata });

        // Save history to SQLite on success
        if (data.affiliateUrl) {
          addHistory(clientId || 'anonymous', {
            productUrl: sanitizedUrl,
            affiliateUrl: data.affiliateUrl,
            metadata: data.metadata || {},
            createdAt: new Date().toISOString(),
          });
        }

        // Đợi background xoá sản phẩm xong mới nhả JobQueue cho Job sau chạy tiếp
        await removeProduct(page);
        await browser.close();
        return data; // Result is returned but ignored by the caller
      } catch (e) {
        // Reload page to reset state after error
        console.log(`[API] Error during job, reloading page: ${e.message}`);
        try {
          await page.reload({ waitUntil: 'commit', timeout: 15000 });
          console.log('[API] Page reloaded after error');
        } catch (reloadErr) {
          console.log(`[API] Failed to reload page: ${reloadErr.message}`);
        }
        await browser.close();
        throw e; // Outer catch block will log this
      }
    });
  } catch (e) {
    if (!res.headersSent) {
      // Không leak internal error ra ngoài cho public API
      console.error(`[API] get-affiliate error: ${e.message}`);
      const safeMessage = e.message.includes('không gắn giỏ') ? e.message : 'Có lỗi xảy ra, vui lòng thử lại sau.';
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

// Open browser
app.post('/api/profile/open-browser', auth, (req, res) => {
  const jobConfig = loadJobConfig();
  const startUrl = jobConfig.url || 'about:blank';
  const browserScript = path.resolve(__dirname, 'open-browser.js');
  const child = spawn('node', [browserScript, `--session=${PROFILE_ID}`, startUrl], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, SESSION_ID: PROFILE_ID },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ message: 'Browser opened', pid: child.pid });
});

// Clear session data (cookies, localStorage, browser-data)
app.delete('/api/profile/session', auth, (req, res) => {
  try {
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

// Helper: get all page targets from CDP
async function getCdpPageTargets() {
  const targetsRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`);
  const targets = await targetsRes.json();
  return targets.filter(t => t.type === 'page');
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
    const tabs = pages.map(t => ({
      id: t.id,
      title: t.title || 'Untitled',
      url: t.url,
      active: t.id === activeTargetId || (!activeTargetId && pages[0]?.id === t.id),
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
    // Activate the tab via CDP
    await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/activate/${targetId}`);
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
    const newRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?${encodeURIComponent(targetUrl)}`);
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
    await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/close/${targetId}`);
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

// Screenshot via CDP directly (more reliable than Playwright)
app.get('/api/browser/screenshot', auth, async (_, res) => {
  try {
    const target = await getActiveTarget();
    if (!target) return res.status(400).json({ error: 'No page found' });

    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const contexts = browser.contexts();
    if (contexts.length === 0) { await browser.close(); return res.status(400).json({ error: 'No context' }); }
    // Find the page matching our active target
    const allPages = contexts[0].pages();
    const page = allPages.find(p => p.url() === target.url) || allPages[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }

    const url = page.url();
    const title = await page.title().catch(() => '');

    // Get actual viewport size and capture screenshot
    const cdp = await page.context().newCDPSession(page);
    const layoutMetrics = await cdp.send('Page.getLayoutMetrics');
    const cssViewport = layoutMetrics.cssVisualViewport || layoutMetrics.visualViewport || {};
    const cssWidth = cssViewport.clientWidth || 1920;
    const cssHeight = cssViewport.clientHeight || 1080;

    // Capture screenshot clipped to CSS viewport to avoid DPR scaling issues
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
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) { await browser.close(); throw new Error('No context'); }
  const allPages = contexts[0].pages();
  // Match by target URL or fall back to first
  const page = allPages.find(p => p.url() === target.url) || allPages[0];
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

  ws.on('close', () => {
    alive = false;
    console.log('[Screencast] Client disconnected');
    stopScreencast();
  });

  ws.on('error', () => {
    alive = false;
    stopScreencast();
  });

  // Handle input commands from client (click, scroll, switchTab) via the same CDP connection
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'switchTab') {
        // Client wants to switch to a different tab
        activeTargetId = msg.targetId;
        connectToTarget(msg.targetId);
        return;
      }
      if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) return;
      if (msg.type === 'click') {
        const { x, y } = msg;
        cdpWs.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } }));
        cdpWs.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } }));
      } else if (msg.type === 'scroll') {
        const { x, y, deltaX, deltaY } = msg;
        cdpWs.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: x || 0, y: y || 0, deltaX: deltaX || 0, deltaY: deltaY || 0 } }));
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

  async function connectToTarget(targetId) {
    // Stop existing screencast first
    await stopScreencast();
    cmdId = 1;

    try {
      const pages = await getCdpPageTargets();
      const target = targetId ? pages.find(t => t.id === targetId) : pages[0];
      if (!target || !target.webSocketDebuggerUrl) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'No browser page found' }));
        return;
      }
      currentTargetId = target.id;

      const { default: WebSocket } = await import('ws');
      cdpWs = new WebSocket(target.webSocketDebuggerUrl);

      cdpWs.on('open', () => {
        cdpWs.send(JSON.stringify({ id: cmdId++, method: 'Page.enable' }));
        cdpWs.send(JSON.stringify({
          id: cmdId++,
          method: 'Page.startScreencast',
          params: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 }
        }));
        console.log(`[Screencast] CDP screencast started for target ${target.id}`);
      });

      cdpWs.on('message', (data) => {
        if (!alive) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.screencastFrame') {
            const { data: frameData, metadata, sessionId: sid } = msg.params;
            sessionId = sid;
            cdpWs.send(JSON.stringify({ id: cmdId++, method: 'Page.screencastFrameAck', params: { sessionId: sid } }));
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'frame',
                image: `data:image/jpeg;base64,${frameData}`,
                metadata
              }));
            }
          }
        } catch { }
      });

      cdpWs.on('close', () => {
        if (alive && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', error: 'CDP connection closed' }));
        }
      });

      cdpWs.on('error', (err) => {
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
      const { default: Browser } = await import('./browser.js');
      const jobConfig = loadJobConfig();
      const startUrl = jobConfig.url || 'https://www.youtube.com';
      const config = { ...CONFIG, headless: false, sessionId: PROFILE_ID };
      const browser = new Browser(config);
      await browser.init();

      // Navigate via CDP HTTP directly (avoids Playwright crash)
      try {
        const targetsRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find(t => t.type === 'page');
        if (pageTarget) {
          const wsUrl = pageTarget.webSocketDebuggerUrl;
          const { default: WebSocket } = await import('ws');
          const ws = new WebSocket(wsUrl);
          await new Promise((resolve, reject) => {
            ws.on('open', () => {
              ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: startUrl } }));
              ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) { ws.close(); resolve(); }
              });
            });
            ws.on('error', reject);
            setTimeout(() => { ws.close(); resolve(); }, 10000);
          });
          console.log(`[Server] Browser navigated to: ${startUrl}`);
        }
      } catch (e) {
        console.log(`[Server] Could not navigate: ${e.message}`);
      }

      console.log('[Server] Chrome started automatically');
      browser.chromeProcess.on('exit', () => {
        console.log('[Server] Chrome process exited');
      });
    } catch (e) {
      console.error('[Server] Failed to auto-start browser:', e.message);
      console.log('[Server] Server continues without browser. Use admin panel to start it.');
    }
  })();
});
