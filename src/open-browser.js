// Open browser with default profile
import 'dotenv/config';
import Browser from './browser.js';
import { CONFIG } from './config.js';
import { SessionManager } from './session-manager.js';

async function main() {
  const args = process.argv.slice(2);
  const sessionArg = args.find(arg => arg.startsWith('--session='));
  const sessionId = sessionArg ? sessionArg.split('=')[1] : (process.env.SESSION_ID || CONFIG.defaultProfile);
  // Accept multiple URLs from command line arguments
  const urls = args.filter(arg => !arg.startsWith('--') && arg.startsWith('http'));
  if (urls.length === 0) urls.push('https://www.youtube.com');

  const sessionManager = new SessionManager({ sessionsDir: CONFIG.sessionsDir });

  // Auto-create if not exists
  if (!sessionManager.exists(sessionId)) {
    sessionManager.create(sessionId, { description: 'Chrome Profile' });
    console.log(`[OpenBrowser] Created profile: ${sessionId}`);
  }

  const config = { ...CONFIG, headless: false, sessionId };

  console.log(`[OpenBrowser] Starting Chrome with profile "${sessionId}"...`);
  console.log('[OpenBrowser] Chrome will open as a normal browser (no automation detection)');
  console.log('[OpenBrowser] Press Ctrl+C to close\n');

  const browser = new Browser(config);
  await browser.init();

  // Navigate first tab to first URL via CDP WebSocket
  const firstUrl = urls[0];
  if (firstUrl && firstUrl !== 'about:blank') {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:19222/json`);
      const targets = await targetsRes.json();
      const pageTarget = targets.find(t => t.type === 'page');
      if (pageTarget) {
        const { default: WebSocket } = await import('ws');
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: firstUrl } }));
            ws.on('message', (data) => {
              const msg = JSON.parse(data.toString());
              if (msg.id === 1) { ws.close(); resolve(); }
            });
          });
          ws.on('error', reject);
          setTimeout(() => { ws.close(); resolve(); }, 10000);
        });
        console.log(`[OpenBrowser] Tab 1 navigated to: ${firstUrl}`);
      }
    } catch (e) {
      console.log(`[OpenBrowser] Could not navigate to URL: ${e.message}`);
    }
  }

  // Open additional tabs for remaining URLs via CDP HTTP API
  for (let i = 1; i < urls.length; i++) {
    try {
      await fetch(`http://127.0.0.1:19222/json/new?${encodeURIComponent(urls[i])}`);
      console.log(`[OpenBrowser] Tab ${i + 1} opened: ${urls[i]}`);
      // Small delay between tab opens to avoid overwhelming Chrome
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log(`[OpenBrowser] Failed to open tab for ${urls[i]}: ${e.message}`);
    }
  }
  console.log(`[OpenBrowser] Opened ${urls.length} tab(s) total`);

  // Export session periodically by connecting via CDP briefly
  const doExport = async () => {
    if (!sessionManager.exists(sessionId)) return;
    let connection = null;
    try {
      connection = await browser.connectForExport();
      if (!connection || !connection.page) return;

      const { context, page } = connection;
      await sessionManager.exportSession(sessionId, context, page);
      console.log(`[OpenBrowser] Session saved (${new Date().toLocaleTimeString()})`);
    } catch (e) {
      // Silently ignore export errors - Chrome might be on a restricted page
    } finally {
      // Disconnect Playwright so Chrome runs clean again
      if (connection?.browser) {
        try { await connection.browser.close(); } catch { }
      }
    }
  };

  // Wait a bit before first export to let user navigate
  setTimeout(async () => {
    await doExport();
    setInterval(doExport, 30000);
  }, 10000);

  console.log(`[OpenBrowser] Chrome is running with ${urls.length} tab(s).`);
  console.log('[OpenBrowser] Session will be auto-saved every 30 seconds.\n');

  // Keep process alive until Chrome closes
  browser.chromeProcess.on('exit', () => {
    console.log('[OpenBrowser] Chrome closed.');
    process.exit(0);
  });

  await new Promise(() => { });
}

main().catch(console.error);
