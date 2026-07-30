import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
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
const VMOS_SECRET_PATH = path.join(ROOT_DIR, 'vmos-secrets.json');
const STUDIO_API_CONFIG_PATH = path.join(ROOT_DIR, 'studio-api.json');
const BROWSER_WORKER_PATH = path.join(APP_DIR, 'src', 'worker.js');
const BUNDLED_ANDROID_WORKER = path.join(APP_DIR, 'bundled', 'android-worker', 'android-worker.exe');
const BUNDLED_ADB = path.join(APP_DIR, 'bundled', 'platform-tools', 'adb.exe');

const externalEnvFile = path.join(ROOT_DIR, '.env');
const bundledEnvFile = path.resolve(APP_DIR, '..', '..', '.env');
dotenv.config({ path: fs.existsSync(externalEnvFile) ? externalEnvFile : bundledEnvFile });

let mainWindow = null;
let workerProc = null;
let browserWorkerProc = null;
let workerStartedAt = null;
let lastWorkerExit = null;
let recentLogs = [];
let sessionVerification = {
  running: false,
  verifiedAt: null,
  results: [],
};

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
      if (fs.existsSync(file)) {
        const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        config.primary_mode = 'browser';
        return config;
      }
    } catch (error) {
      addLog(`Không đọc được ${path.basename(file)}: ${error.message}`, 'error');
    }
  }
  return { server_url: '', adb_path: '', devices: [] };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function loadVmosSecrets() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(VMOS_SECRET_PATH)) return {};
    const encrypted = JSON.parse(fs.readFileSync(VMOS_SECRET_PATH, 'utf8'));
    return Object.fromEntries(Object.entries(encrypted).map(([key, value]) => [
      key,
      safeStorage.decryptString(Buffer.from(value, 'base64')),
    ]));
  } catch (error) {
    addLog(`Không đọc được thông tin đăng nhập VMOS: ${error.message}`, 'error');
    return {};
  }
}

function saveVmosSecrets(secrets) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows chưa sẵn sàng mã hóa thông tin VMOS.');
  const encrypted = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value) encrypted[key] = safeStorage.encryptString(String(value)).toString('base64');
  }
  fs.writeFileSync(VMOS_SECRET_PATH, `${JSON.stringify(encrypted, null, 2)}\n`, 'utf8');
}

function workerEnv(config) {
  const secrets = loadVmosSecrets();
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: [APP_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    ADBUTILS_ADB_PATH: findAdb(config) || '',
    VMOS_ACCESS_KEY: secrets.accessKey || '',
    VMOS_SECRET_KEY: secrets.secretKey || '',
    VMOS_SSH_KEY: secrets.sshKey || '',
  };
}

function persistDetectedAdb(config) {
  const adb = findAdb(config);
  if (adb && config.adb_path !== adb) {
    config.adb_path = adb;
    saveConfig(config);
  }
  return adb;
}

function ensureConfig() {
  if (!fs.existsSync(EXAMPLE_CONFIG_PATH)) return;
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
    addLog('Đã tạo cấu hình collection mặc định');
    return;
  }

  // Portable releases keep android-worker.json beside the EXE. Upgrade older
  // configs in place without touching relay, VMOS, or browser credentials.
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const defaults = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const fixedPool = Array.isArray(defaults.collection_urls)
      ? defaults.collection_urls.filter(Boolean)
      : [];
    let changed = false;

    if (typeof config.auto_discover_collections !== 'boolean') {
      config.auto_discover_collections = false;
      changed = true;
    }
    if (!Number.isFinite(Number(config.collection_pool_size))) {
      config.collection_pool_size = Number(defaults.collection_pool_size) || 5;
      changed = true;
    }
    if (fixedPool.length && (!Array.isArray(config.collection_urls)
      || config.collection_urls.length < fixedPool.length)) {
      config.collection_urls = [...fixedPool];
      config.collection_url = fixedPool[0];
      if (Array.isArray(config.devices) && config.devices.length === 1) {
        const current = config.devices[0];
        const device = typeof current === 'object' && current !== null
          ? { ...current }
          : { serial: String(current || 'auto') };
        device.collection_urls = [...fixedPool];
        device.collection_url = fixedPool[0];
        config.devices = [device];
      }
      changed = true;
    }
    for (const key of [
      'oauth_refresh_seconds',
      'oauth_refresh_retry_seconds',
      'oauth_refresh_wait_seconds',
    ]) {
      if (config[key] == null && defaults[key] != null) {
        config[key] = defaults[key];
        changed = true;
      }
    }
    if (changed) {
      saveConfig(config);
      addLog('Đã nâng cấu hình cũ lên pool cố định 5 collection');
    }
  } catch (error) {
    addLog(`Không nâng được cấu hình cũ: ${error.message}`, 'error');
  }
}

function findAdb(config = loadConfig()) {
  const candidates = [
    BUNDLED_ADB,
    config.adb_path,
    process.env.ADB_PATH,
    path.join(ROOT_DIR, 'platform-tools', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
    'D:\\LDPlayer\\LDPlayer9\\adb.exe',
    'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  ].filter(Boolean);
  const existing = candidates.find(file => fs.existsSync(file));
  if (existing) return existing;
  try {
    return execFileSync('where.exe', ['adb.exe'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    }).split(/\r?\n/).map(value => value.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function androidRuntime() {
  if (fs.existsSync(BUNDLED_ANDROID_WORKER)) {
    return {
      command: BUNDLED_ANDROID_WORKER,
      verifyArgs: ['verify'],
      workerArgs: ['worker'],
    };
  }
  const python = findPython();
  return python ? {
    command: python,
    verifyArgs: ['-u', '-m', 'android_worker.verify_session'],
    workerArgs: ['-u', '-m', 'android_worker.worker'],
  } : null;
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
    const fallbackUrls = config.collection_urls
      || (config.collection_url ? [config.collection_url] : []);
    const configuredEntries = configDevices.map((item, index) => {
      const serial = typeof item === 'string' ? item : item.serial;
      let collectionUrls = typeof item === 'object' && Array.isArray(item.collection_urls)
        ? item.collection_urls.filter(Boolean)
        : [];
      if (typeof item === 'object' && item.collection_url
        && !collectionUrls.includes(item.collection_url)) {
        collectionUrls.push(item.collection_url);
      }
      if (collectionUrls.length === 0) {
        collectionUrls = configDevices.length === 1
          ? [...fallbackUrls]
          : (fallbackUrls[index] ? [fallbackUrls[index]] : []);
      }
      return [serial, collectionUrls];
    });
    const configured = new Map(configuredEntries);
    let onlineIndex = 0;
    const devices = output.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean).map(line => {
      const [serial, state = 'unknown'] = line.split(/\s+/, 3);
      const slotIndex = state === 'device' ? onlineIndex++ : -1;
      const collectionUrls = configured.get(serial)
        || (slotIndex >= 0 ? configuredEntries[slotIndex]?.[1] : [])
        || [];
      const collectionIds = collectionUrls
        .map(url => url.match(/\/shopcollection\/([A-Za-z0-9_-]+)/i)?.[1] || '')
        .filter(Boolean);
      return {
        serial,
        state,
        model: state === 'device' ? getDeviceModel(adb, serial) : '—',
        configured: collectionUrls.length > 0,
        assigned: collectionUrls.length > 0,
        collectionUrls,
        collectionIds,
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
  deviceInfo.devices = deviceInfo.devices.map(device => ({
    ...device,
    verifications: sessionVerification.results.filter(
      item => item.serial === device.serial
    ),
  }));
  return {
    hostname: os.hostname(),
    relayUrl: process.env.WORKER_SERVER_URL || config.server_url || 'Chưa cấu hình',
    workerRunning: !!workerProc || !!browserWorkerProc,
    browserFallbackRunning: !!browserWorkerProc,
    workerPid: workerProc?.pid || browserWorkerProc?.pid || null,
    workerStartedAt,
    lastWorkerExit,
    pythonFound: !!findPython(),
    standaloneWorkerFound: fs.existsSync(BUNDLED_ANDROID_WORKER),
    configFound: fs.existsSync(CONFIG_PATH),
    collectionUrls: Array.isArray(config.collection_urls)
      ? config.collection_urls
      : (config.collection_url ? [config.collection_url] : []),
    sessionVerification,
    primaryMode: config.primary_mode === 'browser' ? 'browser' : 'mobile',
    vmos: {
      enabled: Boolean(config.vmos?.enabled),
      authMode: config.vmos?.auth_mode || 'api',
      padCode: config.vmos?.pad_code || '',
      localPort: config.vmos?.local_port || 60733,
      expireMinutes: config.vmos?.expire_minutes || 10080,
    },
    chromeFallbackEnabled: Boolean(config.chrome_fallback?.enabled),
    browserVideoUrls: config.chrome_fallback?.video_urls || [],
    ...deviceInfo,
    logs: recentLogs,
  };
}

ipcMain.handle('vmos-get-config', () => {
  const config = loadConfig();
  const secrets = loadVmosSecrets();
  return {
    primaryMode: config.primary_mode === 'browser' ? 'browser' : 'mobile',
    enabled: Boolean(config.vmos?.enabled),
    authMode: config.vmos?.auth_mode || 'api',
    padCode: config.vmos?.pad_code || '',
    caBundle: config.vmos?.ca_bundle || '',
    accessKeySaved: Boolean(secrets.accessKey),
    secretKeySaved: Boolean(secrets.secretKey),
    sshCommand: config.vmos?.ssh_command || '',
    sshKeySaved: Boolean(secrets.sshKey),
    adbCommand: config.vmos?.adb_command || '',
    localPort: config.vmos?.local_port || 60733,
    expireMinutes: config.vmos?.expire_minutes || 10080,
    chromeFallbackEnabled: Boolean(config.chrome_fallback?.enabled),
    chromeVideoUrls: config.chrome_fallback?.video_urls || [],
  };
});

ipcMain.handle('vmos-save-config', (_, input = {}) => {
  try {
    const config = loadConfig();
    const previousSecrets = loadVmosSecrets();
    const primaryMode = input.primaryMode === 'browser' ? 'browser' : 'mobile';
    const authMode = input.authMode === 'manual' ? 'manual' : 'api';
    const enabled = Boolean(input.enabled);
    const secrets = {
      accessKey: String(input.accessKey || previousSecrets.accessKey || '').trim(),
      secretKey: String(input.secretKey || previousSecrets.secretKey || '').trim(),
      sshKey: String(input.sshKey || previousSecrets.sshKey || '').trim(),
    };
    if (primaryMode === 'mobile' && enabled && authMode === 'api' && (!input.padCode || !secrets.accessKey || !secrets.secretKey)) {
      throw new Error('Cần nhập Pad Code, Access Key và Secret Key của VMOS.');
    }
    if (primaryMode === 'mobile' && enabled && authMode === 'manual' && (!input.sshCommand || !secrets.sshKey)) {
      throw new Error('Cần nhập lệnh SSH và khóa kết nối VMOS.');
    }
    config.primary_mode = primaryMode;
    config.vmos = {
      enabled,
      auth_mode: authMode,
      pad_code: String(input.padCode || '').trim(),
      ca_bundle: String(input.caBundle || '').trim(),
      ssh_command: String(input.sshCommand || '').trim(),
      adb_command: String(input.adbCommand || '').trim(),
      local_port: Math.max(1024, Math.min(65535, Number(input.localPort) || 60733)),
      expire_minutes: Math.max(1440, Math.min(10080, Number(input.expireMinutes) || 10080)),
    };
    const videoUrls = Array.isArray(input.chromeVideoUrls)
      ? input.chromeVideoUrls.map(value => String(value).trim()).filter(Boolean)
      : [];
    if (primaryMode === 'browser' && videoUrls.length === 0) {
      throw new Error('Chế độ Browser cần ít nhất một URL video YouTube Studio.');
    }
    config.chrome_fallback = {
      enabled: Boolean(input.chromeFallbackEnabled),
      video_urls: videoUrls,
    };
    saveConfig(config);
    saveVmosSecrets(secrets);
    fs.writeFileSync(STUDIO_API_CONFIG_PATH, `${JSON.stringify({ video_urls: videoUrls }, null, 2)}\n`, 'utf8');
    addLog('Đã lưu cấu hình VMOS Cloud và Chrome dự phòng.');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browser-save-videos', (_, value = '') => {
  try {
    const config = loadConfig();
    const videoUrls = String(value).split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean);
    if (videoUrls.length === 0) throw new Error('Cần ít nhất một URL video YouTube Studio.');
    config.chrome_fallback = {
      ...(config.chrome_fallback || {}),
      video_urls: [...new Set(videoUrls)],
    };
    saveConfig(config);
    fs.writeFileSync(
      STUDIO_API_CONFIG_PATH,
      `${JSON.stringify({ video_urls: config.chrome_fallback.video_urls }, null, 2)}\n`,
      'utf8',
    );
    addLog(`Đã lưu ${videoUrls.length} video cho Browser worker.`);
    return { ok: true, count: videoUrls.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function stopWorker() {
  for (const proc of [workerProc, browserWorkerProc].filter(Boolean)) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        proc.kill('SIGTERM');
      }
    } catch { }
  }
  workerProc = null;
  browserWorkerProc = null;
  workerStartedAt = null;
}

function startBrowserFallback(config, force = false) {
  if ((!force && !config.chrome_fallback?.enabled) || !(config.chrome_fallback?.video_urls || []).length) return false;
  if (browserWorkerProc) return true;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WORKER_SERVER_URL: process.env.WORKER_SERVER_URL || config.server_url || '',
    WORKER_AUTH_TOKEN: config.worker_auth_token || process.env.WORKER_AUTH_TOKEN || '',
    USE_STUDIO_INTERNAL_API: '1',
    STUDIO_API_USE_LOCAL_URLS: '1',
    STUDIO_API_PRIMARY_ONLY: '0',
    CONTROL_PANEL_PORT: '19201',
    SESSIONS_DIR: path.join(ROOT_DIR, 'sessions'),
    STUDIO_API_CONFIG_PATH,
  };
  browserWorkerProc = spawn(process.execPath, [BROWSER_WORKER_PATH], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const proc = browserWorkerProc;
  addLog(`Chrome dự phòng đã khởi động (PID ${proc.pid}).`);
  proc.stdout.on('data', data => data.toString().split(/\r?\n/).filter(Boolean)
    .forEach(line => addLog(`[Chrome fallback] ${line}`)));
  proc.stderr.on('data', data => data.toString().split(/\r?\n/).filter(Boolean)
    .forEach(line => addLog(`[Chrome fallback] ${line}`, 'error')));
  proc.on('exit', code => {
    if (browserWorkerProc === proc) browserWorkerProc = null;
    if (!workerProc) workerStartedAt = null;
    lastWorkerExit = { code, at: new Date().toISOString(), mode: 'browser' };
    addLog(`Chrome dự phòng đã dừng (code ${code}).`, code === 0 ? 'info' : 'error');
    send('status-changed');
  });
  return true;
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

function verifyStudioSessions() {
  if (sessionVerification.running) {
    return Promise.resolve({ ok: false, error: 'Đang xác thực tài khoản' });
  }
  const runtime = androidRuntime();
  if (!runtime) return Promise.resolve({ ok: false, error: 'Thiếu Android worker runtime' });
  if (!fs.existsSync(CONFIG_PATH)) {
    return Promise.resolve({ ok: false, error: 'Thiếu android-worker.json' });
  }
  const workerWasRunning = Boolean(workerProc);

  sessionVerification = { running: true, verifiedAt: null, results: [] };
  send('status-changed');
  addLog('Bắt đầu xác thực ADB, root và phiên YouTube Studio đã lưu...');

  const config = loadConfig();
  persistDetectedAdb(config);
  const env = workerEnv(config);
  if (workerWasRunning && config.vmos?.enabled) {
    env.VMOS_REUSE_EXISTING_TUNNEL = '1';
    addLog('Xác thực dùng lại tunnel VMOS đang chạy, không ngắt worker');
  }

  return new Promise(resolve => {
    const proc = spawn(
      runtime.command,
      [...runtime.verifyArgs, '--config', CONFIG_PATH],
      { cwd: ROOT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { }
    }, 300000);

    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('error', error => {
      clearTimeout(timer);
      sessionVerification = {
        running: false,
        verifiedAt: null,
        results: [],
      };
      addLog(`Không chạy được kiểm tra tài khoản: ${error.message}`, 'error');
      send('status-changed');
      resolve({ ok: false, error: error.message });
    });
    proc.on('exit', async () => {
      clearTimeout(timer);
      const marker = stdout.split(/\r?\n/)
        .find(line => line.startsWith('SESSION_VERIFY_RESULT='));
      let result;
      try {
        result = marker
          ? JSON.parse(marker.slice('SESSION_VERIFY_RESULT='.length))
          : { ok: false, results: [], error: stderr.trim() || 'Không nhận được kết quả xác thực' };
      } catch (error) {
        result = { ok: false, results: [], error: `Kết quả xác thực không hợp lệ: ${error.message}` };
      }
      sessionVerification = {
        running: false,
        verifiedAt: result.ok ? new Date().toISOString() : null,
        results: result.results || [],
      };
      for (const item of sessionVerification.results) {
        if (item.ok) {
          addLog(`${item.serial}: phiên Studio hợp lệ, API collection test thành công (${item.seconds}s)`);
        } else {
          addLog(`${item.serial}: xác thực thất bại — ${item.error}`, 'error');
        }
      }
      if (!result.results?.length) {
        addLog(result.error || 'Không có LDPlayer nào để xác thực', 'error');
      }
      for (const discovery of result.discoveries || []) {
        addLog(
          `${discovery.serial}: tự tìm thấy ${discovery.collectionUrls?.length || 0} collection (${discovery.seconds}s)`
        );
      }
      if (result.ok) {
        if (!workerProc) {
          const started = await startWorker();
          if (!started.ok) {
            result = { ...result, ok: false, error: started.error };
            addLog(`Không khởi động được worker sau xác thực: ${started.error}`, 'error');
          } else {
            addLog('Xác thực xong, worker đã kết nối lại relay');
          }
        } else {
          addLog('Xác thực xong, worker và relay vẫn hoạt động liên tục');
        }
      }
      send('status-changed');
      resolve(result);
    });
  });
}

ipcMain.handle('android-verify-studio-session', () => verifyStudioSessions());

async function startWorker() {
  if (browserWorkerProc) return { ok: false, error: 'Browser worker đang chạy' };
  const selectedConfig = loadConfig();
  if (selectedConfig.primary_mode === 'browser') {
    if (!startBrowserFallback(selectedConfig, true)) {
      return { ok: false, error: 'Chế độ Browser chưa có URL video YouTube Studio.' };
    }
    workerStartedAt = new Date().toISOString();
    lastWorkerExit = null;
    addLog('Đã khởi động worker ở chế độ Browser.');
    send('status-changed');
    return { ok: true, mode: 'browser' };
  }
  if (workerProc) return { ok: false, error: 'Android worker đang chạy' };
  const runtime = androidRuntime();
  if (!runtime) return { ok: false, error: 'Thiếu Android worker runtime' };
  if (!fs.existsSync(CONFIG_PATH)) return { ok: false, error: 'Thiếu android-worker.json' };
  const config = loadConfig();
  persistDetectedAdb(config);
  const online = config.vmos?.enabled
    ? [{ state: 'device', configured: true, assigned: true }]
    : listDevices().devices.filter(
      device => device.state === 'device' && device.configured && device.assigned
    );
  if (online.length === 0) return { ok: false, error: 'Không có LDPlayer đã cấu hình đang online' };

  const env = workerEnv(config);
  if (config.server_url) env.WORKER_SERVER_URL = config.server_url;

  workerProc = spawn(runtime.command, [...runtime.workerArgs, '--config', CONFIG_PATH], {
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
      addLog(line.replace(/^\[(?:AndroidWorker|CollectionAPI)\s+\d{2}:\d{2}:\d{2}\]\s*/, ''));
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
  startBrowserFallback(config);
  return { ok: true, mode: 'mobile' };
}

ipcMain.handle('android-start-worker', () => startWorker());

ipcMain.handle('android-stop-worker', () => {
  if (!workerProc && !browserWorkerProc) return { ok: true };
  const pid = workerProc?.pid || browserWorkerProc?.pid;
  stopWorker();
  addLog(`Đã dừng Android worker (PID ${pid})`);
  send('status-changed');
  return { ok: true };
});

app.whenReady().then(() => {
  ensureConfig();
  mainWindow = new BrowserWindow({
    width: 960,
    height: 850,
    minWidth: 820,
    minHeight: 650,
    resizable: true,
    title: 'YT Browser Worker',
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
