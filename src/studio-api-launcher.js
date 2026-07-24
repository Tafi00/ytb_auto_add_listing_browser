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
let autoStartGeneration = 0;

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

async function waitForBrowserCount(expectedCount, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await getPanelStatus();
    if ((status?.browsers?.length || 0) >= expectedCount) return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return status;
}

async function waitForApiReady(expectedCount, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await getPanelStatus();
    if ((status?.apiReadyCount || 0) >= expectedCount) return status;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return status;
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
  const loginPhase = mode === 'login';
  const config = loadConfig();
  let videoUrls;
  try {
    videoUrls = normalizeVideoUrls(config.video_urls || []);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const expectedBrowserCount = loginPhase ? 1 : videoUrls.length;
  let status = await getPanelStatus();

  if (status?.apiMode) {
    if (Boolean(status.primaryOnlyMode) !== loginPhase) {
      await panelRequest('/api/toggle-primary-only', { method: 'POST', timeoutMs: 60_000 });
      status = await getPanelStatus();
    }
    const registeredUrls = Array.isArray(status.localUrls) ? status.localUrls : [];
    const urlsChanged = JSON.stringify(registeredUrls) !== JSON.stringify(videoUrls);
    const missingBrowsers = (status.browsers?.length || 0) !== expectedBrowserCount;
    if (urlsChanged || missingBrowsers) {
      addLog(`Đang đồng bộ ${videoUrls.length} video vào API worker...`);
      await panelRequest('/api/video-urls', {
        method: 'POST',
        body: { videoUrls: videoUrls.join('\n') },
        timeoutMs: 60_000,
      });
      status = await waitForBrowserCount(expectedBrowserCount);
    }
    if ((status?.browsers?.length || 0) !== expectedBrowserCount) {
      throw new Error(
        `Chrome chỉ mở được ${status?.browsers?.length || 0}/${expectedBrowserCount} video. `
        + 'Hãy bấm Dừng rồi thử lại.',
      );
    }
    workerMode = mode;
    await ensureConnection(!loginPhase);
    addLog(loginPhase
      ? 'Đã mở browser gốc. Hãy đăng nhập YouTube Studio; tool sẽ tự mở các browser còn lại.'
      : 'API worker đang chạy và đã kết nối relay.');
    emit('api-status-changed');
    return { ok: true };
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WORKER_SERVER_URL: process.env.WORKER_SERVER_URL || 'wss://voucheryoutube.vn',
    USE_STUDIO_INTERNAL_API: '1',
    STUDIO_API_USE_LOCAL_URLS: '1',
    STUDIO_API_PRIMARY_ONLY: loginPhase ? '1' : '0',
    CONTROL_PANEL_PORT: '19200',
    SESSIONS_DIR: path.join(ROOT_DIR, 'sessions'),
    STUDIO_API_CONFIG_PATH: CONFIG_PATH,
  };

  workerProc = spawn(process.execPath, [WORKER_PATH], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  workerMode = mode;
  attachWorkerLogs(workerProc);
  addLog(loginPhase ? 'Đang mở Chrome cho lần đăng nhập đầu tiên...' : 'Đang khởi động API worker...');

  status = await waitForPanel();
  const registeredUrls = Array.isArray(status?.localUrls) ? status.localUrls : [];
  const urlsChanged = JSON.stringify(registeredUrls) !== JSON.stringify(videoUrls);
  if (urlsChanged) {
    addLog(`Đang đồng bộ ${videoUrls.length} video vào API worker...`);
    await panelRequest('/api/video-urls', {
      method: 'POST',
      body: { videoUrls: videoUrls.join('\n') },
      timeoutMs: 60_000,
    });
    status = await waitForBrowserCount(expectedBrowserCount);
  } else if ((status?.browsers?.length || 0) !== expectedBrowserCount) {
    status = await waitForBrowserCount(expectedBrowserCount);
  }
  if ((status?.browsers?.length || 0) !== expectedBrowserCount) {
    throw new Error(
      `Chrome chỉ mở được ${status?.browsers?.length || 0}/${expectedBrowserCount} video. `
      + 'Hãy bấm Dừng rồi thử lại.',
    );
  }
  await ensureConnection(!loginPhase);
  emit('api-status-changed');
  return { ok: true };
}

async function promoteAfterLogin(generation) {
  while (generation === autoStartGeneration) {
    const status = await getPanelStatus();
    if (!status?.apiMode) return;
    if ((status.apiReadyCount || 0) >= 1) {
      addLog('Đăng nhập đã sẵn sàng. Đang copy profile và mở các browser...');
      const result = await startWorker('run');
      if (!result.ok) addLog(result.error || 'Không thể chạy API', 'error');
      else addLog('Bắt đầu thành công. Tất cả browser API đang hiển thị.');
      emit('api-status-changed');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

async function startAutomatic() {
  const generation = ++autoStartGeneration;
  const config = loadConfig();
  let videoUrls;
  try {
    videoUrls = normalizeVideoUrls(config.video_urls || []);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let result = await startWorker('run');
  if (!result.ok) return result;

  const status = await waitForApiReady(videoUrls.length);
  if ((status?.apiReadyCount || 0) >= videoUrls.length) {
    addLog('Bắt đầu thành công. Tất cả browser API đã sẵn sàng.');
    return { ok: true };
  }

  addLog('Profile chưa sẵn sàng. Đang mở browser gốc để đăng nhập...');
  result = await startWorker('login');
  if (!result.ok) return result;
  void promoteAfterLogin(generation);
  return {
    ok: true,
    warning: 'Hãy đăng nhập YouTube Studio trên browser vừa mở. Tool sẽ tự mở các browser còn lại.',
  };
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
    mode: panel?.apiMode ? (panel.primaryOnlyMode ? 'login' : 'run') : null,
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

ipcMain.handle('api-start', async () => {
  try {
    return await startAutomatic();
  } catch (error) {
    addLog(error.message, 'error');
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('api-stop', async () => {
  autoStartGeneration++;
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
