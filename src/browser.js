// Browser Module - Launch Chrome natively, connect Playwright only for session export
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { log } from './logger.js';
import { SessionManager } from './session-manager.js';
import fs from 'fs';
import path from 'path';

const DEBUGGING_PORT = 19222;

export class Browser {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
    this.sessionId = config.sessionId || null;
    this.debuggingPort = config.debuggingPort || DEBUGGING_PORT;
    this.sessionManager = new SessionManager({ sessionsDir: config.sessionsDir || './sessions' });
  }

  async init() {
    log('[Browser] Starting...');

    if (!this.sessionId && !this.config.userDataDir) {
      throw new Error('[Browser] sessionId or userDataDir is required.');
    }

    let userDataDir = this.config.userDataDir;
    if (!userDataDir) {
      if (!this.sessionManager.exists(this.sessionId)) {
        throw new Error(`[Browser] Session "${this.sessionId}" not found.`);
      }
      userDataDir = this.sessionManager.getBrowserDataDir(this.sessionId);
      log(`[Browser] Using session: ${this.sessionId}`);
    } else {
      log(`[Browser] Using custom userDataDir: ${userDataDir}`);
    }

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // Remove stale lock files
    this._cleanLockFiles(userDataDir);

    // Find Chrome executable
    const chromePath = this._findChrome();
    log(`[Browser] Chrome path: ${chromePath}`);

    const args = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${this.debuggingPort}`,
      '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-component-update',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-logging',
      '--disable-extensions',
      '--disable-popup-blocking',
    ];

    if (this.config.headless) {
      args.push('--headless=new', '--disable-gpu');
    } else {
      args.push('--window-size=1200,800');
      if (this.config.windowPosition) {
        args.push(`--window-position=${this.config.windowPosition.x},${this.config.windowPosition.y}`);
      }
    }

    // Launch Chrome
    log(`[Browser] Launching with args: ${args.join(' ')}`);
    this.chromeProcess = spawn(chromePath, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.chromeProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Lọc bỏ các cảnh báo không quan trọng từ Chrome như GCM endpoint
      if (msg && !msg.includes('google_apis\\gcm') && !msg.includes('DEPRECATED_ENDPOINT')) {
        log(`[Browser:stderr] ${msg}`);
      }
    });

    this.chromeProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(`[Browser:stdout] ${msg}`);
    });

    this.chromeProcess.on('error', (err) => {
      log(`[Browser] Chrome process error: ${err.message}`);
    });

    // Wait for Chrome to start and debugging port to be ready
    await this._waitForDebugPort();

    log('[Browser] Ready! Chrome is running natively (no automation control).');
    return null; // No page object - Chrome runs independently
  }

  /**
   * Connect Playwright via CDP only when needed (e.g., session export).
   * This should NOT be called while user is on Google login page.
   */
  async connectForExport() {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debuggingPort}`);
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        await browser.close();
        return null;
      }
      this.context = contexts[0];
      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : null;
      return { browser, context: this.context, page: this.page };
    } catch (e) {
      log(`[Browser] Failed to connect for export: ${e.message}`);
      return null;
    }
  }

  async _waitForDebugPort(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.debuggingPort}/json/version`);
        if (res.ok) return;
      } catch { }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`Chrome debugging port ${this.debuggingPort} not ready after ${timeout}ms`);
  }

  _cleanLockFiles(userDataDir) {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(userDataDir, lockFile);
      try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || stat.isFile() || stat.isSocket()) {
          fs.unlinkSync(lockPath);
        }
      } catch { }
    }
    const defaultDir = path.join(userDataDir, 'Default');
    if (fs.existsSync(defaultDir)) {
      for (const f of ['LOCK', 'lockfile']) {
        try { fs.unlinkSync(path.join(defaultDir, f)); } catch { }
      }
    }
  }

  _findChrome() {
    const paths = [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ].filter(Boolean);

    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }

    // Fallback: Playwright's bundled Chromium
    const pwChrome = this._findPlaywrightChromium();
    if (pwChrome) return pwChrome;

    throw new Error('Chrome not found. Set CHROME_PATH environment variable.');
  }

  _findPlaywrightChromium() {
    // Use Playwright's own API to get the executable path
    try {
      const execPath = chromium.executablePath();
      if (execPath && fs.existsSync(execPath)) {
        log(`[Browser] Using Playwright Chromium: ${execPath}`);
        return execPath;
      }
    } catch { }

    // Manual search in common cache locations
    const searchDirs = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
      '/root/.cache/ms-playwright',
      '/home/.cache/ms-playwright',
      path.resolve('node_modules', '.cache', 'ms-playwright'),
    ].filter(Boolean);

    for (const cacheDir of searchDirs) {
      try {
        if (!fs.existsSync(cacheDir)) continue;
        const dirs = fs.readdirSync(cacheDir).filter(d => d.startsWith('chromium'));
        if (dirs.length === 0) continue;
        dirs.sort().reverse();
        const chromiumDir = path.join(cacheDir, dirs[0]);
        const candidates = [
          path.join(chromiumDir, 'chrome-linux', 'chrome'),
          path.join(chromiumDir, 'chrome-linux', 'headless_shell'),
          path.join(chromiumDir, 'chrome-win', 'chrome.exe'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            log(`[Browser] Using Playwright Chromium: ${c}`);
            return c;
          }
        }
      } catch { }
    }
    return null;
  }

  async close() {
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill();
      log('[Browser] Chrome process terminated');
    }
  }
}

export default Browser;
