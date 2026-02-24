// Open browser with custom profile and port
import 'dotenv/config';
import Browser from './browser.js';
import { CONFIG } from './config.js';

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const sessionArg = args.find(arg => arg.startsWith('--session='));
  const portArg = args.find(arg => arg.startsWith('--port='));
  const userDataDirArg = args.find(arg => arg.startsWith('--userDataDir='));
  const positionArg = args.find(arg => arg.startsWith('--position='));

  const sessionId = sessionArg ? sessionArg.split('=')[1] : null;
  const debuggingPort = portArg ? parseInt(portArg.split('=')[1], 10) : 19222;
  const userDataDir = userDataDirArg ? userDataDirArg.split('=')[1] : null;

  let windowPosition = null;
  if (positionArg) {
    const [x, y] = positionArg.split('=')[1].split(',');
    windowPosition = { x: parseInt(x, 10), y: parseInt(y, 10) };
  }

  // Get the target URL (the first non-flag argument)
  let targetUrl = args.find(arg => !arg.startsWith('--') && arg.startsWith('http'));
  if (!targetUrl) targetUrl = 'https://www.youtube.com';

  const config = {
    ...CONFIG,
    headless: false,
    sessionId,
    userDataDir,
    debuggingPort,
    windowPosition
  };

  console.log(`[OpenBrowser] Starting Chrome on port ${debuggingPort}...`);
  console.log(`[OpenBrowser] Target URL: ${targetUrl}`);
  console.log('[OpenBrowser] Press Ctrl+C to close\n');

  const browser = new Browser(config);
  await browser.init();

  // Navigate first tab to target URL via CDP WebSocket
  if (targetUrl && targetUrl !== 'about:blank') {
    try {
      // Need to wait slightly for targets to be available
      await new Promise(r => setTimeout(r, 1000));
      const targetsRes = await fetch(`http://127.0.0.1:${debuggingPort}/json`);
      const targets = await targetsRes.json();
      const pageTarget = targets.find(t => t.type === 'page');

      if (pageTarget) {
        const { default: WebSocket } = await import('ws');
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: targetUrl } }));
            ws.on('message', (data) => {
              const msg = JSON.parse(data.toString());
              if (msg.id === 1) { ws.close(); resolve(); }
            });
          });
          ws.on('error', reject);
          setTimeout(() => { ws.close(); resolve(); }, 10000);
        });
        console.log(`[OpenBrowser] Navigated to: ${targetUrl}`);
      }
    } catch (e) {
      console.log(`[OpenBrowser] Could not navigate to URL: ${e.message}`);
    }
  }

  console.log(`[OpenBrowser] Chrome worker is running on port ${debuggingPort}.`);

  // Keep process alive until Chrome closes
  browser.chromeProcess.on('exit', () => {
    console.log(`[OpenBrowser] Chrome closed on port ${debuggingPort}.`);
    process.exit(0);
  });

  await new Promise(() => { });
}

main().catch(console.error);
