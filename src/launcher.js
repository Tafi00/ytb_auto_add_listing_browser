// Electron Launcher - Worker Manager UI
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In portable exe: PORTABLE_EXECUTABLE_DIR = folder where user placed the exe
// In packaged (non-portable): path.dirname(exe)
// In dev mode: project root
const isPackaged = app.isPackaged;
const ROOT_DIR = process.env.PORTABLE_EXECUTABLE_DIR
    || (isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'));
const APP_DIR = isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SESSIONS_DIR = path.resolve(ROOT_DIR, './sessions');
const DEFAULT_DATA_DIR = path.join(SESSIONS_DIR, 'default', 'browser-data');
const WORKER_API_PORT = parseInt(process.env.CONTROL_PANEL_PORT || '19200');
const NUM_CLONES = 10;

let mainWindow = null;
let defaultChromeProc = null;
let workerProc = null;

// ===== Helpers =====

function findChrome() {
    for (const p of [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter(Boolean)) {
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

function killTree(pid) {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch { }
}

function killPortProcess(port) {
    try {
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const lines = out.trim().split('\n');
        const pids = new Set();
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1]);
            if (pid && pid !== process.pid) pids.add(pid);
        }
        for (const pid of pids) {
            addLog(`Đang kill process cũ (PID: ${pid}) trên port ${port}...`);
            killTree(pid);
        }
    } catch { }
}

async function waitForWorkerAPI(maxWait = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const res = await fetch(`http://localhost:${WORKER_API_PORT}/api/status`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) return true;
        } catch { }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

function send(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function addLog(msg) {
    send('log', { time: new Date().toISOString().slice(11, 19), message: msg });
}

// ===== IPC Handlers =====

ipcMain.handle('get-status', () => ({
    defaultRunning: !!defaultChromeProc,
    workerRunning: !!workerProc,
    hasData: fs.existsSync(path.join(DEFAULT_DATA_DIR, 'Local State')),
    hostname: os.hostname(),
}));

ipcMain.handle('open-default-browser', async () => {
    if (defaultChromeProc) return { ok: false, error: 'Browser mặc định đang mở!' };
    const chrome = findChrome();
    if (!chrome) return { ok: false, error: 'Không tìm thấy Chrome!' };

    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
    prepareProfileForLaunch(DEFAULT_DATA_DIR);

    defaultChromeProc = spawn(chrome, [
        `--user-data-dir=${DEFAULT_DATA_DIR}`,
        '--disable-features=TranslateUI', '--disable-infobars',
        '--disable-component-update', '--disable-extensions',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-restore-session-state',
        '--noerrdialogs',
        '--window-size=1300,900', 'https://studio.youtube.com',
    ], { detached: false, stdio: 'ignore' });

    defaultChromeProc.on('exit', () => {
        defaultChromeProc = null;
        addLog('Browser mặc định đã đóng');
        send('status-changed');
    });

    addLog('Đã mở browser mặc định → studio.youtube.com');
    return { ok: true };
});

ipcMain.handle('close-default-browser', () => {
    if (defaultChromeProc) {
        killTree(defaultChromeProc.pid);
        defaultChromeProc = null;
        addLog('Đã đóng browser mặc định');
    }
    return { ok: true };
});

ipcMain.handle('clone-and-start', async () => {
    if (!fs.existsSync(path.join(DEFAULT_DATA_DIR, 'Local State'))) {
        return { ok: false, error: 'Chưa có dữ liệu! Mở browser mặc định và đăng nhập trước.' };
    }

    // Close default browser first
    if (defaultChromeProc) {
        killTree(defaultChromeProc.pid);
        defaultChromeProc = null;
        await new Promise(r => setTimeout(r, 1500));
        addLog('Đã đóng browser mặc định');
    }

    // Stop existing worker
    if (workerProc) {
        killTree(workerProc.pid);
        workerProc = null;
        await new Promise(r => setTimeout(r, 1500));
    }

    // Kill any process using the control panel port
    killPortProcess(WORKER_API_PORT);

    // Clone full browser-data but skip cache dirs (giữ nguyên session Google)
    const SKIP_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache',
        'ShaderCache', 'Service Worker', 'ScriptCache', 'component_crx_cache', 'Sessions'];

    let cloned = 0;
    let skipped = 0;
    for (let i = 0; i < NUM_CLONES; i++) {
        const target = path.join(SESSIONS_DIR, `worker-${i}`, 'browser-data');
        const hasData = fs.existsSync(path.join(target, 'Local State'));
        if (hasData) {
            prepareProfileForLaunch(target);
            skipped++;
            continue;
        }
        try {
            if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
            fs.cpSync(DEFAULT_DATA_DIR, target, {
                recursive: true,
                filter: (src) => {
                    const name = path.basename(src);
                    return !SKIP_DIRS.includes(name);
                },
            });
            prepareProfileForLaunch(target);
            cloned++;
            addLog(`📋 Clone → worker-${i}`);
        } catch (e) {
            addLog(`⚠️ Lỗi clone worker-${i}: ${e.message}`);
        }
    }
    if (skipped > 0) addLog(`⏭️ Bỏ qua ${skipped} worker(s) đã có dữ liệu`);
    if (cloned > 0) addLog(`✅ Clone hoàn tất: ${cloned} worker(s) mới`);
    else addLog(`✅ Tất cả ${NUM_CLONES} workers đã có dữ liệu, không cần clone`);

    // Start worker.js - use Electron's built-in Node.js runtime
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary act as plain Node.js
    const workerScript = path.join(APP_DIR, 'src', 'worker.js');
    const externalEnvFile = path.join(ROOT_DIR, '.env');
    const bundledEnvFile = path.resolve(APP_DIR, '..', '..', '.env');
    const envFile = fs.existsSync(externalEnvFile) ? externalEnvFile : bundledEnvFile;
    const workerEnv = { ...process.env };

    // Portable builds keep a bundled fallback inside the extracted app. A sibling
    // .env remains supported so an operator can override the relay later.
    if (fs.existsSync(envFile)) {
        const lines = fs.readFileSync(envFile, 'utf8').split('\n');
        for (const line of lines) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) workerEnv[match[1].trim()] = match[2].trim();
        }
    }

    // Override with launcher's computed absolute paths (AFTER .env loading)
    workerEnv.SESSIONS_DIR = SESSIONS_DIR;
    workerEnv.ELECTRON_RUN_AS_NODE = '1';

    workerProc = spawn(process.execPath, [workerScript], {
        cwd: ROOT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: workerEnv,
    });

    workerProc.stdout.on('data', d => {
        d.toString().trim().split('\n').forEach(line => {
            const clean = line.replace(/\[Worker \d{2}:\d{2}:\d{2}\]\s*/, '').trim();
            if (clean) addLog(clean);
        });
    });
    workerProc.stderr.on('data', d => {
        const m = d.toString().trim();
        if (m) addLog(`⚠️ ${m}`);
    });
    workerProc.on('exit', code => {
        addLog(`Worker dừng (code: ${code})`);
        workerProc = null;
        send('status-changed');
    });

    addLog('🚀 Worker đang khởi động...');

    // Wait for worker API to be ready
    const apiReady = await waitForWorkerAPI();
    if (apiReady) addLog('✅ Worker API sẵn sàng!');
    else addLog('⚠️ Worker API chưa sẵn sàng, một số nút có thể chưa hoạt động');

    return { ok: true };
});

ipcMain.handle('stop-worker', () => {
    if (workerProc) {
        killTree(workerProc.pid);
        workerProc = null;
        addLog('Đã dừng worker');
    }
    return { ok: true };
});

ipcMain.handle('toggle-headless', async () => {
    try {
        const res = await fetch(`http://localhost:${WORKER_API_PORT}/api/toggle-headless`, {
            method: 'POST', signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        addLog(data.headless ? '🙈 Chuyển sang ẩn browser' : '👁️ Chuyển sang hiện browser');
        return { ok: true, headless: data.headless };
    } catch {
        return { ok: false, error: 'Worker chưa chạy!' };
    }
});

ipcMain.handle('toggle-connection', async () => {
    try {
        const res = await fetch(`http://localhost:${WORKER_API_PORT}/api/toggle-connection`, {
            method: 'POST', signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        addLog(data.connectionEnabled ? '🔗 Đã kết nối lại server' : '🔌 Đã ngắt kết nối server');
        return { ok: true, connectionEnabled: data.connectionEnabled };
    } catch {
        return { ok: false, error: 'Worker chưa chạy!' };
    }
});

ipcMain.handle('get-worker-api', async () => {
    try {
        const res = await fetch(`http://localhost:${WORKER_API_PORT}/api/status`, {
            signal: AbortSignal.timeout(2000),
        });
        return await res.json();
    } catch { return null; }
});

// ===== App =====

app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 520, height: 740, resizable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'YT Browser Worker',
        backgroundColor: '#0c0c18',
        autoHideMenuBar: true,
    });
    mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
});

app.on('window-all-closed', () => {
    if (defaultChromeProc) killTree(defaultChromeProc.pid);
    if (workerProc) killTree(workerProc.pid);
    app.quit();
});
