#!/usr/bin/env node
/* Linkshare-only marketing capture.
 *
 * Two isolated Chromium profiles are recorded side by side on a real page.
 * The sender creates a comment and the recipient opens the generated link,
 * sees the shared annotation, and imports it.
 *
 * Run: pnpm demo:linkshare
 * Pace: DEMO_PACE=1.15 pnpm demo:linkshare
 */
'use strict';

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, 'version_a');
const WORK = path.join(HERE, '.demo-linkshare-work');
const OUTPUT = path.join(ROOT, 'docs', 'demo');
const PAGE_URL = process.env.DEMO_URL || 'https://paulgraham.com/convince.html';
const QUOTE_START = 'Just be concise.';
const QUOTE_END = "you don't really understand them.";
const VIEWPORT = { width: 720, height: 760 };
const PACE = Math.max(0.5, Number(process.env.DEMO_PACE || 1));
const activeBrowsers = new Set();

const pause = (page, ms) => page.waitForTimeout(Math.round(ms * PACE));

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let stdout = '';
    if (capture) child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function duration(file) {
  return Number(await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], true));
}

function browserChromeScript(role) {
  const install = () => {
    document.querySelector('[data-demo-browser-chrome]')?.remove();
    const bar = document.createElement('div');
    bar.dataset.demoBrowserChrome = '';
    bar.setAttribute('data-tma-skip', '');
    bar.innerHTML = `
      <span class="demo-window-dots"><i></i><i></i><i></i></span>
      <span class="demo-address"></span>
      <strong>${role}</strong>
    `;
    const url = location.href.includes('tmc=')
      ? 'paulgraham.com/convince.html#shared-comments'
      : 'paulgraham.com/convince.html';
    bar.querySelector('.demo-address').textContent = url;
    bar.style.cssText = [
      'position:fixed', 'inset:0 0 auto 0', 'height:48px',
      'display:flex', 'align-items:center', 'gap:12px', 'padding:0 14px',
      'z-index:2147483646', 'background:#f3f4f6', 'color:#4b5563',
      'border-bottom:1px solid #cfd2d6', 'box-shadow:0 1px 4px rgba(0,0,0,.12)',
      'font:12px/1 system-ui,-apple-system,sans-serif', 'box-sizing:border-box',
    ].join(';');
    const dots = bar.querySelector('.demo-window-dots');
    dots.style.cssText = 'display:flex;gap:5px;flex:none';
    for (const dot of dots.children) {
      dot.style.cssText = 'display:block;width:8px;height:8px;border-radius:50%;background:#aeb3b9';
    }
    const address = bar.querySelector('.demo-address');
    address.style.cssText = [
      'min-width:0', 'flex:1', 'max-width:460px', 'margin:auto',
      'padding:7px 12px', 'overflow:hidden', 'text-overflow:ellipsis',
      'white-space:nowrap', 'border:1px solid #d7d9dc', 'border-radius:6px',
      'background:#fff', 'color:#60646a', 'text-align:center',
    ].join(';');
    bar.querySelector('strong').style.cssText = [
      'width:64px', 'color:#30343a', 'font-size:11px', 'letter-spacing:.08em',
      'text-align:right', 'text-transform:uppercase',
    ].join(';');

    const cursor = document.createElement('div');
    cursor.dataset.demoBrowserChrome = '';
    cursor.setAttribute('data-tma-skip', '');
    cursor.style.cssText = [
      'position:fixed', 'left:-30px', 'top:-30px', 'z-index:2147483646',
      'width:17px', 'height:17px', 'border:2px solid #fff', 'border-radius:50%',
      'background:#202124', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      'transform:translate(-50%,-50%)', 'transition:width .12s,height .12s',
      'pointer-events:none',
    ].join(';');
    document.addEventListener('mousemove', (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    }, true);
    document.addEventListener('mousedown', () => {
      cursor.style.width = '25px'; cursor.style.height = '25px';
    }, true);
    document.addEventListener('mouseup', () => {
      cursor.style.width = '17px'; cursor.style.height = '17px';
    }, true);

    document.documentElement.style.paddingTop = '48px';
    document.body.style.background = '#fff';
    const article = document.querySelector('body > table');
    if (article) {
      article.style.zoom = '1.28';
      article.style.margin = '0 auto';
    }
    document.body.append(bar, cursor);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}

async function launch(role) {
  const name = role.toLowerCase();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `linkshare-${name}-`));
  const videoDir = path.join(WORK, `${name}-video`);
  await fs.mkdir(videoDir, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: VIEWPORT,
      recordVideo: { dir: videoDir, size: VIEWPORT },
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    context.setDefaultTimeout(18000);
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(browserChromeScript, role);
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 15000 });
    const browser = { role, context, page, worker, profile };
    activeBrowsers.add(browser);
    return browser;
  } catch (error) {
    await context?.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function waitReady(page) {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-tma-ready'),
    { timeout: 18000 },
  );
  // Keep Linkshare's shared-comments banner below the presentation chrome.
  await page.evaluate(() => {
    const banner = document.querySelector('#tma-banner')?.shadowRoot?.querySelector('.banner');
    if (banner) banner.style.top = '48px';
  });
}

async function rangeForQuote(page, selectIt = false) {
  return page.evaluate(({ quoteStart, quoteEnd, selectIt }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('[data-tma-skip]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const data = node.data.toLowerCase();
      const start = data.indexOf(quoteStart.toLowerCase());
      if (start === -1) continue;
      const endStart = data.indexOf(quoteEnd.toLowerCase(), start);
      if (endStart === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, endStart + quoteEnd.length);
      if (selectIt) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      }
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    throw new Error(`Quote not found: ${quoteStart} … ${quoteEnd}`);
  }, { quoteStart: QUOTE_START, quoteEnd: QUOTE_END, selectIt });
}

async function focusQuote(page) {
  const rect = await rangeForQuote(page);
  await page.evaluate((top) => {
    window.scrollBy(0, top - window.innerHeight * 0.43);
  }, rect.y);
  await page.waitForTimeout(200);
}

async function selectQuote(page) {
  const rect = await rangeForQuote(page);
  await page.mouse.move(
    Math.max(20, Math.min(VIEWPORT.width - 20, rect.x + 8)),
    Math.max(70, Math.min(VIEWPORT.height - 20, rect.y + rect.height / 2)),
    { steps: 12 },
  );
  await rangeForQuote(page, true);
}

async function pointAndClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot click a hidden demo control');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await pause(page, 110);
  await page.mouse.down();
  await pause(page, 85);
  await page.mouse.up();
}

async function pointAndHover(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot hover a hidden demo target');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
  await locator.hover();
}

async function sendBackground(browser, message) {
  await browser.page.bringToFront();
  await browser.worker.evaluate(async (msg) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, msg);
  }, message);
}

async function closeCapture(browser, destination) {
  const video = browser.page.video();
  await browser.context.close();
  await fs.copyFile(await video.path(), destination);
  await fs.rm(browser.profile, { recursive: true, force: true });
  activeBrowsers.delete(browser);
}

async function record() {
  console.log(`Loading ${PAGE_URL} in two isolated browsers…`);
  // Launch sequentially. Two simultaneous persistent Chromium startups are
  // needlessly brittle on developer laptops and offer no capture benefit.
  const sender = await launch('Sender');
  const recipient = await launch('Recipient');
  await Promise.all([
    sender.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    recipient.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
  ]);
  await Promise.all([waitReady(sender.page), waitReady(recipient.page)]);
  await Promise.all([focusQuote(sender.page), focusQuote(recipient.page)]);

  const sceneStart = Date.now();
  await pause(sender.page, 750);
  await selectQuote(sender.page);
  await sender.page.locator('#tma-pill .pill').waitFor({ state: 'visible' });
  await pause(sender.page, 650);
  await pointAndClick(sender.page, sender.page.locator('#tma-pill button'));
  await sender.page.locator('#tma-editor .editor').waitFor({ state: 'visible' });
  await pointAndClick(sender.page, sender.page.locator('#tma-editor textarea'));
  await sender.page.keyboard.type('This applies to product docs too.', {
    delay: Math.round(43 * PACE),
  });
  await pause(sender.page, 450);
  await pointAndClick(sender.page, sender.page.locator('#tma-editor button', { hasText: 'Save' }));
  const senderHighlight = sender.page.locator('[data-tma-id]:not([data-tma-id^="s:"])').first();
  await senderHighlight.waitFor({ state: 'visible' });
  await pause(sender.page, 450);
  await pointAndHover(sender.page, senderHighlight);
  await sender.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(sender.page, 900);
  await sender.page.keyboard.press('Escape');

  await sendBackground(sender, { type: 'tma:toggle-panel' });
  await sender.page.locator('#tma-panel .panel').waitFor({ state: 'visible' });
  await pause(sender.page, 550);
  await pointAndClick(sender.page, sender.page.locator('#tma-panel button', { hasText: 'Copy share link' }));
  await sender.page.waitForFunction(() => document.documentElement.hasAttribute('data-tma-last-share'));
  const shareURL = await sender.page.evaluate(
    () => document.documentElement.getAttribute('data-tma-last-share'),
  );
  await pause(sender.page, 700);

  await recipient.page.goto(shareURL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The recipient is already viewing the same base URL, so the first goto is
  // a same-document hash navigation. Reload to model opening the received
  // link as a fresh navigation, when the extension reads its share payload.
  await recipient.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitReady(recipient.page);
  await recipient.page.waitForSelector('[data-tma-id^="s:"]', { timeout: 12000 });
  await focusQuote(recipient.page);
  await pause(recipient.page, 850);
  const sharedHighlight = recipient.page.locator('[data-tma-id^="s:"]').first();
  await pointAndHover(recipient.page, sharedHighlight);
  await recipient.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(recipient.page, 1000);
  await recipient.page.keyboard.press('Escape');
  await pointAndClick(
    recipient.page,
    recipient.page.locator('#tma-banner button', { hasText: 'Import all' }),
  );
  await recipient.page.waitForSelector('[data-tma-id]:not([data-tma-id^="s:"])');
  await pause(recipient.page, 600);
  const imported = recipient.page.locator('[data-tma-id]:not([data-tma-id^="s:"])').first();
  await pointAndHover(recipient.page, imported);
  await recipient.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(recipient.page, 1200);
  const visible = (Date.now() - sceneStart) / 1000;

  await Promise.all([
    closeCapture(sender, path.join(WORK, 'sender.webm')),
    closeCapture(recipient, path.join(WORK, 'recipient.webm')),
  ]);
  return visible;
}

async function render(visible) {
  console.log('Rendering side-by-side H.264 video…');
  const sender = path.join(WORK, 'sender.webm');
  const recipient = path.join(WORK, 'recipient.webm');
  const senderStart = Math.max(0, await duration(sender) - visible - 0.12);
  const recipientStart = Math.max(0, await duration(recipient) - visible - 0.12);
  const mp4 = path.join(OUTPUT, 'linkshare-demo.mp4');

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', senderStart.toFixed(3), '-i', sender,
    '-ss', recipientStart.toFixed(3), '-i', recipient,
    '-t', visible.toFixed(3),
    '-filter_complex',
    `[0:v]fps=30,scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos,setsar=1[l];` +
      `[1:v]fps=30,scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos,setsar=1[r];` +
      '[l][r]hstack=inputs=2:shortest=1,' +
      `drawbox=x=${VIEWPORT.width - 2}:y=0:w=4:h=${VIEWPORT.height}:color=#c8cbd0:t=fill[v]`,
    '-map', '[v]', '-an', '-r', '30', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
  ]);

  const posterAt = Math.min(5.0, visible * 0.4);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', posterAt.toFixed(2),
    '-i', mp4, '-frames:v', '1', path.join(OUTPUT, 'linkshare-demo-poster.png'),
  ]);
  const bytes = (await fs.stat(mp4)).size;
  console.log(`  docs/demo/linkshare-demo.mp4: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (bytes > 10 * 1024 * 1024) throw new Error('Demo exceeds GitHub\'s 10 MB upload limit');
}

try {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(OUTPUT, { recursive: true });
  const visible = await record();
  await render(visible);
  console.log('Linkshare demo ready.');
} finally {
  await Promise.allSettled(Array.from(activeBrowsers, async (browser) => {
    await browser.context.close().catch(() => {});
    await fs.rm(browser.profile, { recursive: true, force: true }).catch(() => {});
  }));
}
