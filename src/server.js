// Admin Dashboard - Single Profile Server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { SessionManager } from './session-manager.js';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const sessionManager = new SessionManager({ sessionsDir: CONFIG.sessionsDir });

// Auto-create default profile if not exists
const PROFILE_ID = CONFIG.defaultProfile;
if (!sessionManager.exists(PROFILE_ID)) {
  sessionManager.create(PROFILE_ID, { description: 'Chrome Profile' });
  console.log(`[Server] Created default profile: ${PROFILE_ID}`);
}

app.use(cors());
app.use(express.json());

// Serve static files from web/dist in production
const distPath = path.resolve(__dirname, '../web/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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
app.post('/api/login', (req, res) => {
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
  const page = context.pages()[0] || await context.newPage();
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
  await page.waitForTimeout(2000);

  const tagBtn = page.locator('ytcp-icon-button.tag-product-button[aria-label="Tag"]').first();
  await tagBtn.waitFor({ state: 'visible', timeout: 5000 });
  await tagBtn.click();
  console.log('[Job] Clicked Tag button');

  const nextBtn = page.locator('ytcp-button#next-button button').first();
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

  const response = await fetch(publicUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' }
  });
  const pageContent = await response.text();

  // Decode unicode escapes helper
  const decodeUnicode = (str) => str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Extract affiliate URL
  const urlMatch = pageContent.match(/"url"\s*:\s*"(https:\/\/s\.shopee\.vn\/[^"]+|https:\/\/www\.lazada\.vn\/products[^"]+)"/);
  const affiliateUrl = urlMatch ? decodeUnicode(urlMatch[1]) : null;

  // Extract product metadata from productListItemRenderer
  let metadata = { title: '', price: '', image: '' };
  
  // Find the actual product data block (not the renderer name list)
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

// Job config file path
const jobConfigPath = path.resolve(__dirname, '../config/job-config.json');

const loadJobConfig = () => {
  try {
    if (fs.existsSync(jobConfigPath)) return JSON.parse(fs.readFileSync(jobConfigPath, 'utf8'));
  } catch {}
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
        const page = contexts[0].pages()[0];
        if (page) await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
      }
      await browser.close();
    } catch {}
  }

  res.json({ message: 'Config saved', ...config });
});

// Check browser status
app.get('/api/browser-status', auth, async (_, res) => {
  const running = await isChromeRunning();
  res.json({ running });
});

// Rate limiting per client (15s cooldown)
const clientCooldowns = new Map();
const CLIENT_COOLDOWN_MS = 15000;

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of clientCooldowns) {
    if (now - time > CLIENT_COOLDOWN_MS * 2) clientCooldowns.delete(key);
  }
}, 5 * 60 * 1000);

// Public API: get affiliate URL by product URL (uses Video URL from config)
app.post('/api/get-affiliate', async (req, res) => {
  const { productUrl, clientId } = req.body;
  if (!productUrl) return res.status(400).json({ error: 'productUrl is required' });

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
        await addProduct(page, productUrl);
        const data = await fetchAffiliateUrl(config.url);
        console.log(`[API] Affiliate URL: ${data.affiliateUrl}`);
        // Remove in background, don't block response
        removeProduct(page).then(() => browser.close()).catch(() => browser.close());
        return data;
      } catch (e) {
        await browser.close();
        throw e;
      }
    });

    res.json({ affiliateUrl: result.affiliateUrl, metadata: result.metadata });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// Screenshot via CDP directly (more reliable than Playwright)
app.get('/api/browser/screenshot', auth, async (_, res) => {
  try {
    // Get page target
    const targetsRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) return res.status(400).json({ error: 'No page found' });

    // Connect via WebSocket
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const contexts = browser.contexts();
    if (contexts.length === 0) { await browser.close(); return res.status(400).json({ error: 'No context' }); }
    const page = contexts[0].pages()[0];
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

// Navigate
app.post('/api/browser/navigate', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }
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
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }
    const cdp = await page.context().newCDPSession(page);
    // Dispatch mouse events via CDP for precise coordinates
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
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }
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
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }
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
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_DEBUG_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) { await browser.close(); return res.status(400).json({ error: 'No page' }); }
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
  } catch {}
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

// Admin: upload guide video
app.post('/api/upload-video', auth, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('video/')) {
    return res.status(400).json({ error: 'Only video files are allowed' });
  }

  const ext = contentType.includes('mp4') ? '.mp4' : contentType.includes('webm') ? '.webm' : '.mp4';
  const filename = `guide-video${ext}`;
  const filepath = path.join(uploadsDir, filename);

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
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

app.listen(PORT, '0.0.0.0', () => {
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

      try {
        const connection = await browser.connectForExport();
        if (connection?.page) {
          await connection.page.goto(startUrl, { waitUntil: 'commit', timeout: 15000 });
          console.log(`[Server] Browser navigated to: ${startUrl}`);
        }
        if (connection?.browser) await connection.browser.close();
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
