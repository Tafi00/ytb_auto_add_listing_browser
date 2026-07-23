import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const ROOT_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  || (isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'));
const APP_DIR = isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'studio-api.json');
const WORKER_PATH = path.join(APP_DIR, 'src', 'worker.js');
const PANEL_URL = 'http://127.0.0.1:19200';

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

let mainWindow = null;
let workerProc = null;
let workerMode = null;
let recentLogs = [];

function emit(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function addLog(message, level = 'info') {
  const entry = {
    time: new Date().toISOString().slice(11, 19),
    message: String(message || '').trim(),
    level,
  };
  if (!entry.message) return;
  recentLogs.push(entry);
  if (recentLogs.length > 250) recentLogs.shift();
  emit('api-log', entry);
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (error) {
    addLog(`Không đọc được studio-api.json: ${error.message}`, 'error');
  }
  return { video_urls: [] };
}

function normalizeVideoUrls(value) {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const urls = [];
  for (const line of lines) {
    const url = String(line || '').trim();
    if (!url) continue;
    if (!/^https:\/\/studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}\/edit(?:[?#].*)?$/.test(url)) {
      throw new Error(`URL Studio không hợp lệ: ${url}`);
    }
    if (!urls.includes(url)) urls.push(url);
  }
  if (!urls.length) throw new Error('Cần nhập ít nhất một URL YouTube Studio');
  return urls;
}

async function panelRequest(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(`${PANEL_URL}${pathname}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          [502, 503, 504].includes(response.status)
            ? 'Control panel tạm thời không phản hồi. Hãy khởi động lại API worker.'
            : `Control panel trả về dữ liệu không hợp lệ (HTTP ${response.status}).`,
        );
      }
    }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getPanelStatus() {
  try {
    return await panelRequest('/api/status');
  } catch {
    return null;
  }
}

async function waitForPanel(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getPanelStatus();
    if (status?.apiMode) return status;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('API worker không khởi động được');
}

function attachWorkerLogs(proc) {
  const consume = (data, level) => {
    data.toString().split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .forEach(line => addLog(line, level));
  };
  proc.stdout.on('data', data => consume(data, 'info'));
  proc.stderr.on('data', data => consume(data, 'error'));
  proc.on('exit', code => {
    if (workerProc === proc) {
      workerProc = null;
      workerMode = null;
    }
    addLog(`API worker đã dừng (code ${code})`, code === 0 ? 'info' : 'error');
    emit('api-status-changed');
  });
}

async function ensureConnection(enabled) {
  const status = await getPanelStatus();
  if (status && Boolean(status.connectionEnabled) !== enabled) {
    await panelRequest('/api/toggle-connection', { method: 'POST', timeoutMs: 5000 });
  }
}

async function startWorker(mode) {
  const headed = mode === 'login';
  let status = await getPanelStatus();

  if (status?.apiMode) {
    if (Boolean(status.headless) === headed) {
      await panelRequest('/api/toggle-headless', { method: 'POST', timeoutMs: 35_000 });
    }
    workerMode = mode;
    await ensureConnection(!headed);
    addLog(headed
      ? 'Đã mở Chrome để đăng nhập. Hoàn tất đăng nhập rồi bấm “Chạy API nền”.'
      : 'API worker đang chạy nền và đã kết nối relay.');
    emit('api-status-changed');
    return { ok: true };
  }

  const config = loadConfig();
  if (!Array.isArray(config.video_urls) || !config.video_urls.length) {
    return { ok: false, error: 'Hãy lưu ít nhất một URL video trước' };
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WORKER_SERVER_URL: process.env.WORKER_SERVER_URL || 'wss://voucheryoutube.vn',
    USE_STUDIO_INTERNAL_API: '1',
    STUDIO_API_USE_LOCAL_URLS: '1',
    HEADLESS: headed ? 'false' : 'true',
    CONTROL_PANEL_PORT: '19200',
    SESSIONS_DIR: './sessions',
  };

  workerProc = spawn(process.execPath, [WORKER_PATH], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  workerMode = mode;
  attachWorkerLogs(workerProc);
  addLog(headed ? 'Đang mở Chrome cho lần đăng nhập đầu tiên...' : 'Đang khởi động API worker nền...');

  status = await waitForPanel();
  await ensureConnection(!headed);
  emit('api-status-changed');
  return { ok: true };
}

function stopOwnedWorker() {
  if (!workerProc) return false;
  const pid = workerProc.pid;
  const proc = workerProc;
  workerProc = null;
  workerMode = null;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}
  addLog(`Đã dừng API worker (PID ${pid})`);
  emit('api-status-changed');
  return true;
}

ipcMain.handle('api-status', async () => {
  const panel = await getPanelStatus();
  const config = loadConfig();
  const combinedLogs = new Map();
  for (const item of [...(panel?.logs || []), ...recentLogs]) {
    const normalized = {
      time: item?.time || '',
      message: String(item?.message || ''),
      level: item?.level || (/error|failed|lỗi|thất bại/i.test(item?.message || '') ? 'error' : 'info'),
    };
    combinedLogs.set(`${normalized.time}|${normalized.message}`, normalized);
  }
  return {
    hostname: os.hostname(),
    relayUrl: process.env.WORKER_SERVER_URL || panel?.serverUrl || 'wss://voucheryoutube.vn',
    running: Boolean(panel?.apiMode),
    owned: Boolean(workerProc),
    mode: panel?.apiMode ? (panel.headless ? 'background' : 'login') : null,
    relayConnected: Boolean(panel?.wsConnected),
    connectionEnabled: Boolean(panel?.connectionEnabled),
    browsers: panel?.browsers || [],
    apiReadyCount: panel?.apiReadyCount || 0,
    jobStats: panel?.jobStats || { total: 0, success: 0, failed: 0 },
    videoUrls: Array.isArray(config.video_urls) ? config.video_urls : [],
    logs: [...combinedLogs.values()].slice(-250),
  };
});

ipcMain.handle('api-save-videos', async (_, value) => {
  try {
    const videoUrls = normalizeVideoUrls(value);
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ video_urls: videoUrls }, null, 2)}\n`, 'utf8');
    const panel = await getPanelStatus();
    if (panel?.apiMode) {
      await panelRequest('/api/video-urls', {
        method: 'POST',
        body: { videoUrls: videoUrls.join('\n') },
        timeoutMs: 60_000,
      });
    }
    addLog(`Đã lưu ${videoUrls.length} video local`);
    emit('api-status-changed');
    return { ok: true, count: videoUrls.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

async function safeStartWorker(mode) {
  try {
    return await startWorker(mode);
  } catch (error) {
    addLog(error.message, 'error');
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('api-start-login', () => safeStartWorker('login'));
ipcMain.handle('api-start-background', () => safeStartWorker('background'));
ipcMain.handle('api-stop', async () => {
  try {
    const panel = await getPanelStatus();
    if (panel?.apiMode) {
      await panelRequest('/api/shutdown', { method: 'POST', timeoutMs: 5000 });
      workerProc = null;
      workerMode = null;
      addLog('Đã dừng API worker');
      emit('api-status-changed');
      return { ok: true };
    }
    stopOwnedWorker();
    return { ok: true };
  } catch (error) {
    addLog(`Không thể dừng worker: ${error.message}`, 'error');
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    title: 'YouTube Studio API Worker',
    backgroundColor: '#080c17',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'studio-api-launcher.html'));
});

app.on('window-all-closed', () => {
  stopOwnedWorker();
  app.quit();
});
