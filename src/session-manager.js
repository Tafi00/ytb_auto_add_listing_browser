// Session Manager - Quản lý nhiều browser session
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export class SessionManager {
  constructor(config = {}) {
    this.sessionsDir = path.isAbsolute(config.sessionsDir || '')
      ? config.sessionsDir
      : path.resolve(PROJECT_ROOT, config.sessionsDir || './sessions');

    this._ensureDir(this.sessionsDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getSessionDir(sessionId) {
    return path.join(this.sessionsDir, sessionId);
  }

  getBrowserDataDir(sessionId) {
    return path.join(this.getSessionDir(sessionId), 'browser-data');
  }

  getSessionFilePath(sessionId) {
    return path.join(this.getSessionDir(sessionId), 'session.json');
  }

  getMetadataPath(sessionId) {
    return path.join(this.getSessionDir(sessionId), 'metadata.json');
  }

  create(sessionId, metadata = {}) {
    const sessionDir = this.getSessionDir(sessionId);
    if (fs.existsSync(sessionDir)) {
      throw new Error(`Session "${sessionId}" already exists`);
    }

    this._ensureDir(sessionDir);
    this._ensureDir(this.getBrowserDataDir(sessionId));

    const meta = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      description: metadata.description || '',
      tags: metadata.tags || [],
    };

    fs.writeFileSync(this.getMetadataPath(sessionId), JSON.stringify(meta, null, 2));
    log(`[SessionManager] Created session: ${sessionId}`);
    return meta;
  }

  list() {
    if (!fs.existsSync(this.sessionsDir)) return [];

    return fs.readdirSync(this.sessionsDir)
      .filter(name => {
        const metaPath = path.join(this.sessionsDir, name, 'metadata.json');
        return fs.existsSync(metaPath);
      })
      .map(name => this.getMetadata(name))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getMetadata(sessionId) {
    const metaPath = this.getMetadataPath(sessionId);
    if (!fs.existsSync(metaPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      return null;
    }
  }

  updateMetadata(sessionId, updates) {
    const meta = this.getMetadata(sessionId);
    if (!meta) throw new Error(`Session "${sessionId}" not found`);

    const updated = { ...meta, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.getMetadataPath(sessionId), JSON.stringify(updated, null, 2));
    return updated;
  }

  touch(sessionId) {
    try {
      this.updateMetadata(sessionId, { lastUsedAt: new Date().toISOString() });
    } catch { /* ignore */ }
  }

  delete(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    fs.rmSync(sessionDir, { recursive: true, force: true });
    log(`[SessionManager] Deleted session: ${sessionId}`);
  }

  exists(sessionId) {
    return fs.existsSync(this.getMetadataPath(sessionId));
  }

  async exportSession(sessionId, browserContext, page) {
    const cookies = await browserContext.cookies();

    let localStorageData = {};
    try {
      localStorageData = await page.evaluate(() => {
        const json = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          json[key] = localStorage.getItem(key);
        }
        return json;
      });
    } catch { /* page might not be on a valid domain */ }

    const sessionData = {
      cookies,
      localStorage: localStorageData,
      timestamp: new Date().toISOString(),
      sessionId,
    };

    const sessionFilePath = this.getSessionFilePath(sessionId);
    fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2));
    this.touch(sessionId);

    log(`[SessionManager] Exported session "${sessionId}": ${cookies.length} cookies, ${Object.keys(localStorageData).length} localStorage items`);
    return sessionData;
  }

  async importSession(sessionId, browserContext, page) {
    const sessionFilePath = this.getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFilePath)) {
      log(`[SessionManager] No session.json for "${sessionId}", using browser-data only`);
      return false;
    }

    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));

      if (sessionData.cookies?.length) {
        await browserContext.addCookies(sessionData.cookies);
        log(`[SessionManager] Loaded ${sessionData.cookies.length} cookies for "${sessionId}"`);
      }

      if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
        try {
          // Detect domain from session data or cookies
          let targetDomain = 'https://www.aliexpress.com/404';
          if (sessionData.domain) {
            targetDomain = `https://www.${sessionData.domain}/`;
          } else if (sessionData.cookies?.length) {
            const domain = sessionData.cookies[0].domain?.replace(/^\./, '') || 'aliexpress.com';
            targetDomain = `https://www.${domain}/`;
          }
          await page.goto(targetDomain, { waitUntil: 'commit', timeout: 15000 });
          await page.waitForFunction(() => typeof window !== 'undefined');
          await page.evaluate((data) => {
            for (const key in data) localStorage.setItem(key, data[key]);
          }, sessionData.localStorage);
          log(`[SessionManager] Injected ${Object.keys(sessionData.localStorage).length} localStorage items for "${sessionId}"`);
        } catch (e) {
          log(`[SessionManager] Warning: Failed to inject localStorage for "${sessionId}": ${e.message.split('\n')[0]}`);
        }
      }

      this.touch(sessionId);
      return true;
    } catch (e) {
      log(`[SessionManager] Failed to import session "${sessionId}": ${e.message}`);
      return false;
    }
  }

  async updateFromServer(sessionId, serverUrl) {
    log(`[SessionManager] Updating session "${sessionId}" from ${serverUrl}...`);

    try {
      const response = await fetch(serverUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const sessionData = await response.json();
      sessionData.sessionId = sessionId;
      sessionData.syncedAt = new Date().toISOString();

      fs.writeFileSync(this.getSessionFilePath(sessionId), JSON.stringify(sessionData, null, 2));
      this.updateMetadata(sessionId, { lastSyncedAt: new Date().toISOString(), syncSource: serverUrl });

      log(`[SessionManager] Session "${sessionId}" updated from server`);
      return true;
    } catch (e) {
      log(`[SessionManager] Failed to update session "${sessionId}" from server: ${e.message}`);
      return false;
    }
  }

  clone(sourceId, targetId) {
    if (!this.exists(sourceId)) throw new Error(`Source session "${sourceId}" not found`);
    if (this.exists(targetId)) throw new Error(`Target session "${targetId}" already exists`);

    const sourceDir = this.getSessionDir(sourceId);
    const targetDir = this.getSessionDir(targetId);

    fs.cpSync(sourceDir, targetDir, { recursive: true });

    const meta = this.getMetadata(targetId);
    if (meta) {
      meta.id = targetId;
      meta.createdAt = new Date().toISOString();
      meta.updatedAt = new Date().toISOString();
      meta.description = `Cloned from ${sourceId}`;
      fs.writeFileSync(this.getMetadataPath(targetId), JSON.stringify(meta, null, 2));
    }

    log(`[SessionManager] Cloned "${sourceId}" -> "${targetId}"`);
    return this.getMetadata(targetId);
  }
}

export default SessionManager;
