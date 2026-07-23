import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const videoId = process.argv[2] || 'VNa64icfGAg';
const productUrl = process.argv[3]
  || 'https://www.lazada.vn/products/moi-2025-dien-thoai-samsung-galaxy-a17-5g-8gb128gb-xam-khoi-i3237396474-s15582798079.html';
const sourceProfile = path.resolve(
  process.env.STUDIO_CAPTURE_PROFILE
    || path.join(projectRoot, 'sessions', 'worker-0', 'browser-data'),
);
const probeOnly = process.argv.includes('--probe');
const capturePath = path.join(os.tmpdir(), 'youtube-studio-shopping-api-capture.json');
const sourceProfileName = path.basename(path.dirname(sourceProfile));
const captureProfile = path.resolve(
  process.env.STUDIO_CAPTURE_WORKDIR
    || path.join(os.tmpdir(), `youtube-studio-shopping-capture-${sourceProfileName}`),
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function copyProfileOnce() {
  if (fs.existsSync(path.join(captureProfile, 'Local State'))) return;
  const skip = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'GrShaderCache',
    'ShaderCache',
    'Service Worker',
    'ScriptCache',
    'component_crx_cache',
    'Sessions',
  ]);
  fs.cpSync(sourceProfile, captureProfile, {
    recursive: true,
    filter: source => !skip.has(path.basename(source)),
  });
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(captureProfile, name), { force: true });
  }
}

function parseBody(request) {
  const raw = request.postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 50_000);
  }
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = structuredClone(body);
  if (copy.context) copy.context = '[redacted: client/session context]';
  if (copy.delegationContext) copy.delegationContext = '[redacted]';
  return copy;
}

async function openPicker(page) {
  const editButton = page.locator('ytcp-icon-button#shopping-toolbar-edit');
  if (!await editButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const productsButton = page.getByRole('button', {
      name: /Products|Sản phẩm|tagged product/i,
    }).first();
    await productsButton.waitFor({ state: 'visible', timeout: 20_000 });
    await productsButton.click();
  }
  await editButton.waitFor({ state: 'visible', timeout: 15_000 });
  await editButton.click();
  await page.locator('input#search-input.search-input')
    .waitFor({ state: 'visible', timeout: 15_000 });
}

async function clickTag(page) {
  const tagButton = page.locator('ytcp-icon-button.tag-product-button').first();
  await tagButton.waitFor({ state: 'visible', timeout: 20_000 });
  await tagButton.evaluate(element => {
    const button = element.shadowRoot?.querySelector('button')
      || element.querySelector('button')
      || element;
    button.click();
  });
  await page.waitForFunction(() => {
    const selected = document.querySelectorAll(
      'ytshopping-product-picker-selected-product ytshopping-product',
    ).length;
    const button = document.querySelector('ytcp-button#picker-next-button button');
    return selected > 0 && button && !button.disabled;
  }, null, { timeout: 12_000 });
}

async function finishPicker(page) {
  const next = page.locator('ytcp-button#picker-next-button button').first();
  await next.click();
  const done = page.locator(
    'ytcp-button#picker-done-button button, button[aria-label="Done"], button[aria-label="Xong"]',
  ).first();
  await done.waitFor({ state: 'visible', timeout: 10_000 });
  await done.click();
  await page.locator('input#search-input.search-input')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => {});
}

async function saveAndWait(page, captures, phase) {
  const save = page.locator('ytcp-button#save button').first();
  await save.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('ytcp-button#save button');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: 10_000 });

  const before = captures.length;
  await save.click({ force: true });
  await page.waitForFunction(() => {
    const button = document.querySelector('ytcp-button#save button');
    return button && (button.disabled || button.getAttribute('aria-disabled') === 'true');
  }, null, { timeout: 15_000 }).catch(() => {});

  for (let attempt = 0; attempt < 50; attempt++) {
    if (captures.slice(before).some(item => item.url.includes('/video_manager/metadata_update'))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`No metadata_update request captured during ${phase}`);
}

async function removeAllProducts(page) {
  await openPicker(page);
  const selected = page.locator(
    'ytshopping-product-picker-selected-product ytshopping-product',
  );
  while (await selected.count() > 0) {
    const product = selected.first();
    await product.hover();
    const remove = page.locator('ytcp-icon-button.delete-product-button').first();
    await remove.waitFor({ state: 'visible', timeout: 5_000 });
    await remove.click();
    await sleep(150);
  }
  await finishPicker(page);
}

copyProfileOnce();

const context = await chromium.launchPersistentContext(captureProfile, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

const page = context.pages()[0] || await context.newPage();
const captures = [];
let phase = 'initial-load';

page.on('request', request => {
  if (request.method() !== 'POST') return;
  const url = request.url();
  const body = parseBody(request);
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  if (
    !url.includes('youtubei')
    && !url.includes('/video_manager/')
    && !/shopping|product|lazada/i.test(raw || '')
  ) return;

  captures.push({
    phase,
    time: new Date().toISOString(),
    method: request.method(),
    resourceType: request.resourceType(),
    url,
    body,
  });
});

try {
  await page.goto(`https://studio.youtube.com/video/${videoId}/edit`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  if (/accounts\.google\.com|ServiceLogin/i.test(page.url())) {
    throw new Error('The capture profile is no longer signed in to YouTube Studio');
  }
  await page.getByRole('heading', { name: /Video details|Chi tiết video/i })
    .waitFor({ state: 'visible', timeout: 25_000 });

  if (probeOnly) {
    console.log(JSON.stringify({
      ok: true,
      loggedIn: true,
      sourceProfile,
      captureProfile,
    }, null, 2));
    process.exitCode = 0;
  } else {
  phase = 'product-search';
  await openPicker(page);
  const search = page.locator('input#search-input.search-input');
  await search.fill(productUrl);
  await search.press('Enter');
  await page.locator('ytcp-icon-button.tag-product-button').first()
    .waitFor({ state: 'visible', timeout: 20_000 });

  phase = 'tag-product';
  await clickTag(page);
  await finishPicker(page);

  phase = 'save-add';
  await saveAndWait(page, captures, phase);

  phase = 'remove-product';
  await removeAllProducts(page);

  phase = 'save-remove';
  await saveAndWait(page, captures, phase);

  const metadataRequests = captures
    .filter(item => item.url.includes('/video_manager/metadata_update'))
    .map(item => ({
      phase: item.phase,
      url: item.url,
      body: summarizeBody(item.body),
    }));
  const searchRequests = captures
    .filter(item => item.phase === 'product-search')
    .map(item => ({
      url: item.url,
      body: summarizeBody(item.body),
    }));

  fs.writeFileSync(capturePath, JSON.stringify(captures, null, 2));
  console.log(JSON.stringify({
    ok: true,
    capturePath,
    metadataRequests,
    searchRequests,
  }, null, 2));
  }
} finally {
  await context.close();
}
