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
    this.sessionManager = new SessionManager({ sessionsDir: config.sessionsDir || './sessions' });
  }

  async init() {
    log('[Browser] Starting...');

    if (!this.sessionId) {
      throw new Error('[Browser] sessionId is required.');
    }
    if (!this.sessionManager.exists(this.sessionId)) {
      throw new Error(`[Browser] Session "${this.sessionId}" not found.`);
    }

    const userDataDir = this.sessionManager.getBrowserDataDir(this.sessionId);
    log(`[Browser] Using session: ${this.sessionId}`);

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
      `--remote-debugging-port=${DEBUGGING_PORT}`,
      '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-component-update',
    ];

    if (this.config.headless) {
      args.push('--headless=new', '--disable-gpu', '--no-sandbox');
    } else {
      args.push('--window-size=1920,1080');
    }

    // Launch Chrome as a normal process - no CDP control during user interaction
    this.chromeProcess = spawn(chromePath, args, {
      detached: false,
      stdio: 'ignore',
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
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUGGING_PORT}`);
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
        const res = await fetch(`http://127.0.0.1:${DEBUGGING_PORT}/json/version`);
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`Chrome debugging port ${DEBUGGING_PORT} not ready after ${timeout}ms`);
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
      } catch {}
    }
    const defaultDir = path.join(userDataDir, 'Default');
    if (fs.existsSync(defaultDir)) {
      for (const f of ['LOCK', 'lockfile']) {
        try { fs.unlinkSync(path.join(defaultDir, f)); } catch {}
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

    // Fallback: try Playwright's bundled Chromium
    const playwrightChromium = this._findPlaywrightChromium();
    if (playwrightChromium) return playwrightChromium;

    throw new Error('Chrome not found. Set CHROME_PATH environment variable.');
  }

  _findPlaywrightChromium() {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const cacheDir = path.join(homeDir, '.cache', 'ms-playwright');
      if (!fs.existsSync(cacheDir)) return null;
      const dirs = fs.readdirSync(cacheDir).filter(d => d.startsWith('chromium'));
      if (dirs.length === 0) return null;
      dirs.sort().reverse();
      const chromiumDir = path.join(cacheDir, dirs[0]);
      const candidates = [
        path.join(chromiumDir, 'chrome-linux', 'chrome'),
        path.join(chromiumDir, 'chrome-linux', 'headless_shell'),
        path.join(chromiumDir, 'chrome-win', 'chrome.exe'),
        path.join(chromiumDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          log(`[Browser] Using Playwright Chromium: ${c}`);
          return c;
        }
      }
    } catch {}
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
