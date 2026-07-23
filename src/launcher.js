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
const CONFIG_PATH = path.join(ROOT_DIR, 'android-worker.json');
const EXAMPLE_CONFIG_PATH = path.join(APP_DIR, 'android-worker.example.json');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

let mainWindow = null;
let workerProc = null;
let workerStartedAt = null;
let lastWorkerExit = null;
let recentLogs = [];

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function addLog(message, level = 'info') {
  const entry = { time: new Date().toISOString().slice(11, 19), message, level };
  recentLogs.push(entry);
  if (recentLogs.length > 250) recentLogs.shift();
  send('log', entry);
}

function loadConfig() {
  for (const file of [CONFIG_PATH, EXAMPLE_CONFIG_PATH]) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      addLog(`Không đọc được ${path.basename(file)}: ${error.message}`, 'error');
    }
  }
  return { server_url: '', adb_path: '', devices: [] };
}

function findAdb(config = loadConfig()) {
  const candidates = [
    config.adb_path,
    process.env.ADB_PATH,
    'D:\\LDPlayer\\LDPlayer9\\adb.exe',
    'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file)) || null;
}

function findPython() {
  for (const command of ['python', 'py']) {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 4000 });
      return command;
    } catch { }
  }
  return null;
}

function getDeviceModel(adb, serial) {
  try {
    return execFileSync(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    }).trim() || 'Android';
  } catch {
    return 'Android';
  }
}

function listDevices() {
  const config = loadConfig();
  const adb = findAdb(config);
  if (!adb) return { adbFound: false, adbPath: '', devices: [], error: 'Không tìm thấy adb.exe của LDPlayer' };
  try {
    const output = execFileSync(adb, ['devices', '-l'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    const configDevices = config.devices || [];
    const fallbackUrls = config.video_urls || [];
    const configured = new Map(configDevices.map((item, index) => {
      const serial = typeof item === 'string' ? item : item.serial;
      const videoUrl = typeof item === 'object' && item.video_url
        ? item.video_url
        : fallbackUrls[index] || '';
      return [serial, videoUrl];
    }));
    const devices = output.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean).map(line => {
      const [serial, state = 'unknown'] = line.split(/\s+/, 3);
      const videoUrl = configured.get(serial) || '';
      const videoId = videoUrl.match(/(?:\/video\/|youtu\.be\/|[?&]v=|\/(?:shorts|live)\/)([A-Za-z0-9_-]{6,})/i)?.[1] || '';
      return {
        serial,
        state,
        model: state === 'device' ? getDeviceModel(adb, serial) : '—',
        configured: configured.has(serial),
        assigned: !!videoUrl,
        videoUrl,
        videoId,
      };
    });
    return { adbFound: true, adbPath: adb, devices, error: '' };
  } catch (error) {
    return { adbFound: true, adbPath: adb, devices: [], error: error.message };
  }
}

function currentStatus() {
  const config = loadConfig();
  const deviceInfo = listDevices();
  return {
    hostname: os.hostname(),
    relayUrl: process.env.WORKER_SERVER_URL || config.server_url || 'Chưa cấu hình',
    workerRunning: !!workerProc,
    workerPid: workerProc?.pid || null,
    workerStartedAt,
    lastWorkerExit,
    pythonFound: !!findPython(),
    configFound: fs.existsSync(CONFIG_PATH),
    videoUrls: Array.isArray(config.video_urls) ? config.video_urls : [],
    maxVideoUrls: Array.isArray(config.devices) ? config.devices.length : 0,
    ...deviceInfo,
    logs: recentLogs,
  };
}

function normalizeVideoUrls(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const urls = [];
  for (const item of items) {
    const url = String(item || '').trim();
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`URL YouTube không hợp lệ: ${url}`);
    }
    const host = parsed.hostname.toLowerCase();
    const isYouTubeHost = host === 'youtu.be'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com');
    const hasVideoId = /studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}/i.test(url)
      || /youtu\.be\/[A-Za-z0-9_-]{6,}/i.test(url)
      || /[?&]v=[A-Za-z0-9_-]{6,}/i.test(url)
      || /youtube\.com\/(?:shorts|live)\/[A-Za-z0-9_-]{6,}/i.test(url);
    if (!isYouTubeHost || !hasVideoId) {
      throw new Error(`URL YouTube không hợp lệ: ${url}`);
    }
    if (!urls.includes(url)) urls.push(url);
  }
  if (urls.length === 0) throw new Error('Cần nhập ít nhất một URL video YouTube');
  return urls;
}

function stopWorker() {
  if (!workerProc) return;
  const proc = workerProc;
  workerProc = null;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { }
  workerStartedAt = null;
}

ipcMain.handle('android-status', () => currentStatus());
ipcMain.handle('android-refresh-devices', () => {
  const result = listDevices();
  addLog(`Làm mới thiết bị: ${result.devices.filter(d => d.state === 'device').length} LDPlayer online`);
  return result;
});

ipcMain.handle('android-open-ldplayer', () => {
  const adb = findAdb();
  const exe = adb ? path.join(path.dirname(adb), 'dnplayer.exe') : '';
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'Không tìm thấy dnplayer.exe' };
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  addLog('Đã mở LDPlayer');
  return { ok: true };
});

async function startWorker() {
  if (workerProc) return { ok: false, error: 'Android worker đang chạy' };
  const python = findPython();
  if (!python) return { ok: false, error: 'Không tìm thấy Python' };
  if (!fs.existsSync(CONFIG_PATH)) return { ok: false, error: 'Thiếu android-worker.json' };
  const config = loadConfig();
  const online = listDevices().devices.filter(
    device => device.state === 'device' && device.configured && device.assigned
  );
  if (online.length === 0) return { ok: false, error: 'Không có LDPlayer đã cấu hình đang online' };

  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    ADBUTILS_ADB_PATH: findAdb(config) || '',
  };
  if (config.server_url) env.WORKER_SERVER_URL = config.server_url;

  workerProc = spawn(python, ['-u', '-m', 'android_worker.worker', '--config', CONFIG_PATH], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const startedProc = workerProc;
  workerStartedAt = new Date().toISOString();
  lastWorkerExit = null;
  addLog(`Đang khởi động Android worker (PID ${workerProc.pid})...`);

  workerProc.stdout.on('data', data => {
    data.toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => {
      addLog(line.replace(/^\[AndroidWorker\s+\d{2}:\d{2}:\d{2}\]\s*/, ''));
    });
  });
  workerProc.stderr.on('data', data => {
    data.toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => addLog(line, 'error'));
  });
  startedProc.on('exit', code => {
    lastWorkerExit = { code, at: new Date().toISOString() };
    if (workerProc === startedProc) {
      workerProc = null;
      workerStartedAt = null;
    }
    addLog(`Android worker đã dừng (code ${code})`, code === 0 ? 'info' : 'error');
    send('status-changed');
  });
  send('status-changed');
  return { ok: true };
}

ipcMain.handle('android-start-worker', () => startWorker());

ipcMain.handle('android-save-video-urls', async (_, value) => {
  try {
    const videoUrls = normalizeVideoUrls(value);
    const config = loadConfig();
    const devices = Array.isArray(config.devices) ? config.devices : [];
    if (videoUrls.length > devices.length) {
      throw new Error(
        `Chỉ có ${devices.length} LDPlayer: tối đa ${devices.length} URL video`
      );
    }
    config.video_urls = videoUrls;
    config.devices = devices.map((item, index) => {
      const device = typeof item === 'string' ? { serial: item } : { ...item };
      device.video_url = videoUrls[index] || '';
      delete device.video_ids;
      return device;
    });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const shouldRestart = !!workerProc;
    if (shouldRestart) stopWorker();
    addLog(`Đã lưu ${videoUrls.length} video local`);
    if (shouldRestart) {
      const result = await startWorker();
      if (!result.ok) return result;
      addLog('Đã đăng ký lại danh sách video với relay');
    }
    send('status-changed');
    return { ok: true, count: videoUrls.length, restarted: shouldRestart };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('android-stop-worker', () => {
  if (!workerProc) return { ok: true };
  const pid = workerProc.pid;
  stopWorker();
  addLog(`Đã dừng Android worker (PID ${pid})`);
  send('status-changed');
  return { ok: true };
});

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 850,
    minWidth: 820,
    minHeight: 650,
    resizable: true,
    title: 'YT Android Worker',
    backgroundColor: '#070b16',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    if (loadConfig().auto_start) startWorker();
  });
});

app.on('window-all-closed', () => {
  stopWorker();
  app.quit();
});
