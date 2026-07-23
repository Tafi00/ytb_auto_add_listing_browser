// Admin Dashboard - Single Profile Server
// Architecture: Linux Server + Windows Worker

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

// Rate limit riêng cho login (chặt hơn)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // tối đa 10 lần login / IP / 15 phút
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
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
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'default-worker-token';

// Cảnh báo bảo mật khi dùng giá trị mặc định
if (JWT_SECRET === 'default-secret-change-me') {
  console.warn('⚠️  [Security] JWT_SECRET đang dùng giá trị mặc định. Hãy đổi trong .env!');
}
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('⚠️  [Security] ADMIN_PASSWORD đang dùng giá trị mặc định. Hãy đổi trong .env!');
}
if (WORKER_AUTH_TOKEN === 'default-worker-token') {
  console.warn('⚠️  [Security] WORKER_AUTH_TOKEN đang dùng giá trị mặc định. Hãy đổi trong .env!');
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

// ==================== Worker Management ====================

// Connected workers (Windows machines)
const connectedWorkers = new Map(); // id -> { ws, info, busy }
// Mobile jobs include public-shelf propagation and a verified cleanup pass, so
// they legitimately take longer than the old browser-only flow.
const WORKER_JOB_TIMEOUT_MS = parseInt(process.env.WORKER_JOB_TIMEOUT_MS || '420000', 10);
const QUEUE_WAIT_TIMEOUT_MS = parseInt(process.env.QUEUE_WAIT_TIMEOUT_MS || '30000', 10);
const PREFER_ANDROID_WORKERS = process.env.PREFER_ANDROID_WORKERS !== '0';

// Simple sequential queue per tab
class JobQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }
  get pending() {
    return (this.running ? 1 : 0) + this.queue.length;
  }
  push(fn, options = {}) {
    const waitTimeoutMs = options.waitTimeoutMs || 0;
    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, timer: null };
      if (waitTimeoutMs > 0) {
        item.timer = setTimeout(() => {
          const idx = this.queue.indexOf(item);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error('Tool đang bận, vui lòng thử lại sau.'));
          }
        }, waitTimeoutMs);
      }
      this.queue.push(item);
      this._next();
    });
  }
  async _next() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const { fn, resolve, reject, timer } = this.queue.shift();
    if (timer) clearTimeout(timer);
    try { resolve(await fn()); }
    catch (e) { reject(e); }
    finally { this.running = false; this._next(); }
  }
}

// Use per-tab Job Queues to allow concurrent processing across tabs
const tabQueues = new Map();
let globalJobCounter = 0;

function getQueueForTab(targetUrl) {
  if (!tabQueues.has(targetUrl)) {
    tabQueues.set(targetUrl, new JobQueue());
  }
  return tabQueues.get(targetUrl);
}

// Get an available worker
function getAvailableWorker(targetUrl) {
  const workers = [...connectedWorkers.values()]
    .filter(worker => worker?.ws?.readyState === 1)
    .sort((a, b) => {
      if (!PREFER_ANDROID_WORKERS) return 0;
      return Number(b.info?.workerType === 'android') - Number(a.info?.workerType === 'android');
    });

  // Try to find a worker that handles this specific URL (exact match)
  for (const worker of workers) {
    if (worker.info?.urls?.includes(targetUrl)) return worker;
  }
  // Try partial match (same base URL without query params)
  const targetBase = targetUrl ? targetUrl.split('?')[0] : null;
  if (targetBase) {
    for (const worker of workers) {
      if (worker.info?.urls?.some(u => u.split('?')[0] === targetBase)) return worker;
    }
  }
  // NO fallback - do not send job to wrong worker
  return null;
}

// Check if any worker is connected
const isWorkerConnected = () => connectedWorkers.size > 0;

function getWorkerReadyUrls(configUrls) {
  return configUrls.filter(url => !!getAvailableWorker(url));
}

function getLocalAndroidWorkerUrls() {
  const urls = [];
  for (const worker of connectedWorkers.values()) {
    if (worker?.ws?.readyState !== 1) continue;
    if (worker.info?.workerType !== 'android') continue;
    if (!worker.info?.capabilities?.includes('local-video-pool')) continue;
    urls.push(...(worker.info?.urls || []));
  }
  return [...new Set(urls)];
}

// Send a job to worker and wait for result
function sendJobToWorker(worker, jobId, targetUrl, productUrl, affiliateFallbackUrl = null) {
  return new Promise((resolve, reject) => {
    if (!worker?.ws || worker.ws.readyState !== 1) {
      reject(new Error('Worker chưa kết nối'));
      return;
    }

    const timeout = setTimeout(() => {
      delete worker.pendingJobs[jobId];
      reject(new Error(`Worker timeout (${Math.round(WORKER_JOB_TIMEOUT_MS / 1000)}s)`));
    }, WORKER_JOB_TIMEOUT_MS);

    worker.pendingJobs[jobId] = { resolve, reject, timeout };

    worker.ws.send(JSON.stringify({
      type: 'execute-job',
      jobId,
      targetUrl,
      productUrl,
      affiliateFallbackUrl,
    }));
  });
}

// ==================== Profile & Config API ====================

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

  // Notify all workers about new config
  const urlPattern = /https?:\/\/[^\s]+/g;
  const urls = url.match(urlPattern) || [];
  for (const [id, worker] of connectedWorkers) {
    if (worker.info?.capabilities?.includes('local-video-pool')) continue;
    try {
      worker.ws.send(JSON.stringify({ type: 'config-update', urls }));
    } catch { }
  }

  res.json({ message: 'Config saved', ...config });
});

// Worker status (replaces browser-status)
app.get('/api/worker-status', auth, async (_, res) => {
  const workers = [];
  for (const [id, worker] of connectedWorkers) {
    workers.push({
      id,
      connectedAt: worker.connectedAt,
      urls: worker.info?.urls || [],
      busy: worker.busy || false,
      workerType: worker.info?.workerType || 'browser',
      devices: worker.info?.devices || [],
      capabilities: worker.info?.capabilities || [],
    });
  }
  res.json({ connected: connectedWorkers.size > 0, workers });
});

// Keep backward compatibility
app.get('/api/browser-status', auth, async (_, res) => {
  res.json({ running: isWorkerConnected() });
});

// History stats
app.get('/api/history-stats', auth, (_, res) => {
  res.json({ totalLinks: getTotalLinks() });
});

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

// ==================== Redirect Resolver ====================

// Các domain rút gọn cần resolve
const SHORT_URL_HOSTS = ['s.lazada.vn', 'c.lazada.vn', 'lzd.co', 's.shopee.vn', 'shp.ee', 'vn.shp.ee'];
const LAZADA_SHORT_HOSTS = ['s.lazada.vn', 'c.lazada.vn', 'lzd.co'];

function isShortUrl(url) {
  try {
    const parsed = new URL(url);
    return SHORT_URL_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch { return false; }
}

function isLazadaShortUrl(url) {
  try {
    const parsed = new URL(url);
    return LAZADA_SHORT_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch { return false; }
}

// Strip tracking params from Lazada URL, keep only clean product path
function cleanLazadaUrl(url) {
  try {
    const parsed = new URL(url);
    // Giữ lại origin + pathname, bỏ hết query params tracking
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
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

function getLazadaAffiliateFallbackUrl(inputUrl, resolvedUrl) {
  const lower = `${inputUrl || ''} ${resolvedUrl || ''}`.toLowerCase();
  if (!lower.includes('lazada') && !lower.includes('lzd.co')) return null;

  if (isLikelyLazadaAffiliateUrl(inputUrl) || isLikelyLazadaAffiliateUrl(resolvedUrl)) {
    return inputUrl;
  }

  return null;
}

async function resolveRedirects(startUrl, maxHops = 10) {
  let currentUrl = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
    } else {
      // Check meta refresh
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const body = await res.text();
        const match = body.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"']+)["']/i);
        if (match) {
          currentUrl = new URL(match[1], currentUrl).href;
          continue;
        }
      }
      break;
    }
  }
  return currentUrl;
}

// Validate product URL format
function isValidProductUrl(url) {
  try {
    const parsed = new URL(url);
    const validHosts = ['shopee.vn', 'www.shopee.vn', 's.shopee.vn', 'shp.ee', 'lazada.vn', 'www.lazada.vn', 's.lazada.vn', 'c.lazada.vn', 'lzd.co'];
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

// Public API: get affiliate URL by product URL (via Worker)
app.post('/api/get-affiliate', async (req, res) => {
  const { productUrl, clientId } = req.body;
  if (!productUrl || typeof productUrl !== 'string') return res.status(400).json({ error: 'productUrl is required' });

  // Sanitize input
  const sanitizedUrl = productUrl.trim().slice(0, 2048);
  if (sanitizedUrl.length === 0) return res.status(400).json({ error: 'productUrl is required' });

  if (clientId && (typeof clientId !== 'string' || clientId.length > 128)) {
    return res.status(400).json({ error: 'clientId không hợp lệ' });
  }

  if (containsMultipleLinks(sanitizedUrl)) {
    return res.status(400).json({ error: 'Mỗi lần chỉ gửi 1 link' });
  }

  if (!isValidProductUrl(sanitizedUrl)) {
    return res.status(400).json({ error: 'Link sản phẩm không hợp lệ. Vui lòng nhập link Shopee hoặc Lazada.' });
  }

  // Resolve short URL → full URL trước khi gửi cho worker
  let finalProductUrl = sanitizedUrl;
  let resolvedProductUrl = sanitizedUrl;
  if (isShortUrl(sanitizedUrl)) {
    try {
      console.log(`[API] Resolving short URL: ${sanitizedUrl}`);
      resolvedProductUrl = await resolveRedirects(sanitizedUrl);
      console.log(`[API] Resolved to: ${resolvedProductUrl}`);
      if (!isValidProductUrl(resolvedProductUrl)) {
        return res.status(400).json({ error: 'Link sau khi chuyển hướng không hợp lệ.' });
      }

      if (isLazadaShortUrl(sanitizedUrl)) {
        // Lazada: YouTube Studio không nhận link ngắn → dùng link đã resolve nhưng strip tracking params
        finalProductUrl = cleanLazadaUrl(resolvedProductUrl);
        console.log(`[API] Lazada cleaned URL: ${finalProductUrl}`);
      } else {
        // Shopee: YouTube Studio nhận link ngắn OK → giữ nguyên link gốc
        finalProductUrl = sanitizedUrl;
      }
    } catch (e) {
      console.error(`[API] Failed to resolve short URL: ${e.message}`);
      return res.status(400).json({ error: 'Không thể xử lý link rút gọn. Vui lòng dùng link đầy đủ.' });
    }
  }

  const affiliateFallbackUrl = getLazadaAffiliateFallbackUrl(sanitizedUrl, resolvedProductUrl);
  if (affiliateFallbackUrl) {
    console.log(`[API] Lazada affiliate fallback retained: ${affiliateFallbackUrl}`);
  }

  // Rate limit
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

  const urlPattern = /https?:\/\/[^\s]+/g;
  const localAndroidUrls = getLocalAndroidWorkerUrls();
  const config = loadJobConfig();
  const serverUrls = config.url ? config.url.match(urlPattern) || [] : [];
  const urls = localAndroidUrls.length > 0 ? localAndroidUrls : serverUrls;
  if (urls.length === 0) {
    return res.status(400).json({
      error: 'Android worker chưa cấu hình video_urls local và server cũng chưa có Video URL.',
    });
  }

    if (!isWorkerConnected()) return res.status(400).json({ error: 'Worker chưa kết nối. Vui lòng chạy worker trên máy Windows.' });

    const readyUrls = getWorkerReadyUrls(urls);
    if (readyUrls.length === 0) {
      return res.status(503).json({ error: 'Tool chưa sẵn sàng: worker chưa mở browser đúng video URL. Vui lòng mở/restart browsers trong tool.' });
    }

  // Keep the reverse-proxy connection active while the Android worker waits
  // for YouTube propagation and verified cleanup. Whitespace before JSON is
  // valid and prevents nginx/proxies from replacing the response with a plain
  // text "Bad Gateway" page during a healthy long-running job.
  let responseHeartbeat = null;
  const stopResponseHeartbeat = () => {
    if (responseHeartbeat) clearInterval(responseHeartbeat);
    responseHeartbeat = null;
  };
  const finishJson = (payload, status = 200) => {
    stopResponseHeartbeat();
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.status(status).json(payload);
    } else {
      res.end(JSON.stringify(payload));
    }
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  responseHeartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(' ');
  }, 10000);
  res.on('close', stopResponseHeartbeat);

  try {
    // Select the tab (URL) that currently has the shortest queue
    let targetUrl = readyUrls[0];
    let minPending = Infinity;

    for (const url of readyUrls) {
      const q = getQueueForTab(url);
      if (q.pending < minPending) {
        minPending = q.pending;
        targetUrl = url;
      }
    }

    globalJobCounter++;
    const jobId = `job-${globalJobCounter}-${Date.now()}`;

    const tabQueue = getQueueForTab(targetUrl);
    const queuePos = tabQueue.pending;
    console.log(`[API] Tab queue pending: ${queuePos}`);
    console.log(`[API] Assigned to: ${targetUrl} (position ${queuePos}), product: ${finalProductUrl}`);

    const result = await tabQueue.push(async () => {
      const jobStart = Date.now();
      console.log(`[API] Job START for product: ${finalProductUrl} on tab: ${targetUrl}`);

      const worker = getAvailableWorker(targetUrl);
      if (!worker) throw new Error('Tool chưa sẵn sàng: worker chưa mở browser đúng video URL.');

      const data = await sendJobToWorker(worker, jobId, targetUrl, finalProductUrl, affiliateFallbackUrl);
      console.log(`[API] Total job time: ${Date.now() - jobStart}ms`);
      console.log(`[API] Affiliate URL for ${finalProductUrl}: ${data.affiliateUrl}`);

      // Verify domain match (dùng resolvedProductUrl vì nó có domain thật)
      if (data.affiliateUrl) {
        const resolvedProductUrlLower = resolvedProductUrl.toLowerCase();
        const productDomains = resolvedProductUrlLower.includes('shopee') || resolvedProductUrlLower.includes('shp.ee') ? ['shopee', 'shp.ee'] :
          resolvedProductUrlLower.includes('lazada') || resolvedProductUrlLower.includes('lzd.co') ? ['lazada', 'lzd.co'] : null;
        if (productDomains && !productDomains.some(domain => data.affiliateUrl.toLowerCase().includes(domain))) {
          console.warn(`[API] WARNING: Product domain mismatch! Expected ${productDomains.join('/')} in affiliate URL but got: ${data.affiliateUrl}`);
        }
      }

      finishJson({ affiliateUrl: data.affiliateUrl, metadata: data.metadata });

      // Save history to SQLite on success
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

      return data;
    }, { waitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS });
  } catch (e) {
    console.error(`[API] get-affiliate error: ${e.message}`);
    const safeMessage = e.message.includes('không gắn giỏ')
      ? e.message
      : `Có lỗi xảy ra, vui lòng thử lại sau. (Chi tiết: ${e.message.substring(0, 150)})`;
    finishJson({ error: safeMessage }, 500);
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

// ==================== Worker WebSocket ====================
const workerWss = new WebSocketServer({ server, path: '/ws/worker' });

workerWss.on('connection', (ws, req) => {
  // Verify worker auth token from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (token !== WORKER_AUTH_TOKEN) {
    console.log('[Worker WS] Rejected connection: invalid token');
    ws.close(4001, 'Unauthorized');
    return;
  }

  const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const worker = {
    ws,
    info: {},
    connectedAt: new Date().toISOString(),
    busy: false,
    pendingJobs: {}, // jobId -> { resolve, reject, timeout }
  };

  connectedWorkers.set(workerId, worker);
  console.log(`[Worker WS] Worker connected: ${workerId} (total: ${connectedWorkers.size})`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'register') {
        // Worker reports its info (URLs it handles, etc.)
        worker.info = {
          urls: msg.urls || [],
          hostname: msg.hostname || '',
          workerType: msg.workerType || 'browser',
          devices: Array.isArray(msg.devices) ? msg.devices : [],
          capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
        };
        console.log(`[Worker WS] Worker ${workerId} registered: ${msg.urls?.length || 0} URLs, host: ${msg.hostname || 'unknown'}, type: ${worker.info.workerType}`);

      } else if (msg.type === 'job-result') {
        // Worker completed a job
        const pending = worker.pendingJobs[msg.jobId];
        if (pending) {
          clearTimeout(pending.timeout);
          delete worker.pendingJobs[msg.jobId];

          if (msg.success) {
            pending.resolve({
              affiliateUrl: msg.affiliateUrl,
              metadata: msg.metadata || {},
            });
          } else {
            pending.reject(new Error(msg.error || 'Worker job failed'));
          }
        }

      } else if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'heartbeat-ack' }));

      } else if (msg.type === 'log') {
        // Worker sends log messages
        console.log(`[Worker ${workerId}] ${msg.message}`);
      }
    } catch (e) {
      console.error(`[Worker WS] Error parsing message from ${workerId}:`, e.message);
    }
  });

  ws.on('close', () => {
    // Reject all pending jobs
    for (const [jobId, pending] of Object.entries(worker.pendingJobs)) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker disconnected'));
    }
    connectedWorkers.delete(workerId);
    console.log(`[Worker WS] Worker disconnected: ${workerId} (total: ${connectedWorkers.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[Worker WS] Error from ${workerId}:`, err.message);
  });

  // Send current config to worker
  const jobConfig = loadJobConfig();
  const urlPattern = /https?:\/\/[^\s]+/g;
  const configUrls = jobConfig.url ? jobConfig.url.match(urlPattern) || [] : [];
  ws.send(JSON.stringify({ type: 'config-update', urls: configUrls }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin Dashboard running on http://localhost:${PORT}`);
  console.log(`[Server] Chờ Worker kết nối qua WebSocket tại /ws/worker`);
  console.log(`[Server] Chạy worker trên máy Windows: npm run worker`);
});
