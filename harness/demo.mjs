#!/usr/bin/env node
/* Deterministic marketing capture for the README.
 * Records the real extensions with Playwright, then lets ffmpeg assemble an
 * inline GIF, an H.264 MP4, and a poster frame.
 *
 * Run: pnpm demo
 * Pace: DEMO_PACE=1.15 pnpm demo
 */
'use strict';

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(HERE, '.demo-work');
const OUTPUT = path.join(ROOT, 'docs', 'demo');
const PORT = Number(process.env.DEMO_PORT || 8143);
const URL = `http://127.0.0.1:${PORT}/demo.html`;
const FULL = { width: 1120, height: 700 };
const HALF = { width: 560, height: 700 };
const PACE = Math.max(0.5, Number(process.env.DEMO_PACE || 1));

const pause = (page, ms) => page.waitForTimeout(Math.round(ms * PACE));

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
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
  const value = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], true);
  return Number(value);
}

async function getServiceWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 15000 });
}

async function launch(name, extension, viewport) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `textmarker-demo-${name}-`));
  const videoDir = path.join(WORK, `${name}-video`);
  await fs.mkdir(videoDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  context.setDefaultTimeout(15000);
  const page = context.pages()[0] || await context.newPage();
  const worker = await getServiceWorker(context);
  return { name, context, page, worker, profile };
}

async function closeCapture(browser, destination) {
  const video = browser.page.video();
  await browser.context.close();
  const source = await video.path();
  await fs.copyFile(source, destination);
  await fs.rm(browser.profile, { recursive: true, force: true });
}

async function waitReady(page, variant) {
  await page.waitForFunction(
    (v) => document.documentElement.hasAttribute(`data-tm${v}-ready`),
    variant,
    { timeout: 12000 },
  );
}

async function decorate(page, label) {
  await page.evaluate((text) => {
    for (const old of document.querySelectorAll('[data-demo-chrome]')) old.remove();
    const labelEl = document.createElement('div');
    labelEl.dataset.demoChrome = 'label';
    labelEl.setAttribute('data-tma-skip', '');
    labelEl.setAttribute('data-tmb-skip', '');
    labelEl.textContent = text;
    labelEl.style.cssText = [
      'position:fixed', 'top:14px', 'right:16px', 'z-index:2147483646',
      'padding:7px 11px', 'border:1px solid rgba(255,255,255,.28)',
      'border-radius:999px', 'background:rgba(25,28,26,.88)', 'color:#fff',
      'box-shadow:0 4px 18px rgba(0,0,0,.18)',
      'font:700 11px/1 system-ui,sans-serif', 'letter-spacing:.08em',
      'text-transform:uppercase', 'pointer-events:none',
    ].join(';');

    const cursor = document.createElement('div');
    cursor.dataset.demoChrome = 'cursor';
    cursor.setAttribute('data-tma-skip', '');
    cursor.setAttribute('data-tmb-skip', '');
    cursor.style.cssText = [
      'position:fixed', 'left:-30px', 'top:-30px', 'z-index:2147483646',
      'width:17px', 'height:17px', 'border:2px solid #fff', 'border-radius:50%',
      'background:#20211f', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
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
    document.body.append(labelEl, cursor);
  }, label);
}

async function select(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Cannot select ${selector}`);
  await page.mouse.move(box.x + 8, box.y + Math.min(14, box.height / 2), { steps: 12 });
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, selector);
}

async function pointAndClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot click a hidden demo control');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await pause(page, 120);
  await page.mouse.down();
  await pause(page, 90);
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

async function recordLinkshare() {
  console.log('Recording Linkshare sender…');
  const extension = path.join(ROOT, 'version_a');
  const sender = await launch('link-sender', extension, FULL);
  await sender.page.goto(URL);
  await waitReady(sender.page, 'a');
  await decorate(sender.page, 'Linkshare · your browser');

  const senderStart = Date.now();
  await pause(sender.page, 650);
  await select(sender.page, '#share-sentence');
  await sender.page.locator('#tma-pill .pill').waitFor({ state: 'visible' });
  await pause(sender.page, 650);
  await pointAndClick(sender.page, sender.page.locator('#tma-pill button'));
  await sender.page.locator('#tma-editor .editor').waitFor({ state: 'visible' });
  await pointAndClick(sender.page, sender.page.locator('#tma-editor textarea'));
  await sender.page.keyboard.type('This belongs in the launch notes.', { delay: Math.round(42 * PACE) });
  await pause(sender.page, 450);
  await pointAndClick(sender.page, sender.page.locator('#tma-editor button', { hasText: 'Save' }));
  const highlight = sender.page.locator('[data-tma-id]:not([data-tma-id^="s:"])').first();
  await highlight.waitFor({ state: 'visible' });
  await pause(sender.page, 500);
  await pointAndHover(sender.page, highlight);
  await sender.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(sender.page, 1150);
  await sender.page.keyboard.press('Escape');
  await sendBackground(sender, { type: 'tma:toggle-panel' });
  await sender.page.locator('#tma-panel .panel').waitFor({ state: 'visible' });
  await pause(sender.page, 600);
  await pointAndClick(sender.page, sender.page.locator('#tma-panel button', { hasText: 'Copy share link' }));
  await sender.page.waitForFunction(() => document.documentElement.hasAttribute('data-tma-last-share'));
  const shareURL = await sender.page.evaluate(() => document.documentElement.getAttribute('data-tma-last-share'));
  await pause(sender.page, 1050);
  const senderVisible = (Date.now() - senderStart) / 1000;
  await closeCapture(sender, path.join(WORK, 'link-sender.webm'));

  console.log('Recording Linkshare recipient…');
  const recipient = await launch('link-recipient', extension, FULL);
  await recipient.page.goto(shareURL);
  await waitReady(recipient.page, 'a');
  await recipient.page.waitForSelector('[data-tma-id^="s:"]');
  await decorate(recipient.page, 'Linkshare · shared link');

  const recipientStart = Date.now();
  await pause(recipient.page, 1050);
  const shared = recipient.page.locator('[data-tma-id^="s:"]').first();
  await pointAndHover(recipient.page, shared);
  await recipient.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(recipient.page, 1050);
  await recipient.page.keyboard.press('Escape');
  await pointAndClick(recipient.page, recipient.page.locator('#tma-banner button', { hasText: 'Import all' }));
  await recipient.page.waitForSelector('[data-tma-id]:not([data-tma-id^="s:"])');
  await pause(recipient.page, 650);
  const imported = recipient.page.locator('[data-tma-id]:not([data-tma-id^="s:"])').first();
  await pointAndHover(recipient.page, imported);
  await recipient.page.locator('#tma-card .card').waitFor({ state: 'visible' });
  await pause(recipient.page, 1050);
  const recipientVisible = (Date.now() - recipientStart) / 1000;
  await closeCapture(recipient, path.join(WORK, 'link-recipient.webm'));

  return { senderVisible, recipientVisible };
}

const pairStatus = (page, needle) => page.waitForFunction((text) => {
  const host = document.querySelector('#tmb-panel');
  const status = host?.shadowRoot?.querySelector('.status');
  return status?.textContent.includes(text);
}, needle, { timeout: 18000 });

async function openPairPanel(browser) {
  await sendBackground(browser, { type: 'tmb:toggle-panel' });
  await browser.page.locator('#tmb-panel .overlay').waitFor({ state: 'visible' });
}

async function pairBrowsers(left, right) {
  await openPairPanel(left);
  await left.page.locator('#tmb-panel [data-el="gen"]').click();
  await left.page.waitForFunction(() => {
    const host = document.querySelector('#tmb-panel');
    return (host?.shadowRoot?.querySelector('[data-el="invite-out"]')?.value.length || 0) > 100;
  }, { timeout: 18000 });
  const invite = await left.page.locator('#tmb-panel [data-el="invite-out"]').inputValue();

  await openPairPanel(right);
  await right.page.locator('#tmb-panel .tabs button', { hasText: 'Join' }).click();
  await right.page.locator('#tmb-panel [data-el="invite-in"]').fill(invite);
  await right.page.locator('#tmb-panel [data-el="gen-join"]').click();
  await right.page.waitForFunction(() => {
    const host = document.querySelector('#tmb-panel');
    return (host?.shadowRoot?.querySelector('[data-el="join-out"]')?.value.length || 0) > 100;
  }, { timeout: 18000 });
  const answer = await right.page.locator('#tmb-panel [data-el="join-out"]').inputValue();

  await left.page.locator('#tmb-panel [data-el="join-in"]').fill(answer);
  await left.page.locator('#tmb-panel [data-el="connect"]').click();
  await Promise.all([pairStatus(left.page, 'Connected'), pairStatus(right.page, 'Connected')]);
  await Promise.all([
    left.page.locator('#tmb-panel button', { hasText: 'Close' }).click(),
    right.page.locator('#tmb-panel button', { hasText: 'Close' }).click(),
  ]);
}

async function recordPairshare() {
  console.log('Pairing two isolated browser profiles…');
  const extension = path.join(ROOT, 'version_b');
  const [left, right] = await Promise.all([
    launch('pair-left', extension, HALF),
    launch('pair-right', extension, HALF),
  ]);
  await Promise.all([left.page.goto(URL), right.page.goto(URL)]);
  await Promise.all([waitReady(left.page, 'b'), waitReady(right.page, 'b')]);
  await pairBrowsers(left, right);
  // Pairing uses short-lived setup toasts. Let them clear before the polished
  // scene begins so the first frame communicates only the connected state.
  await pause(left.page, 3200);
  await Promise.all([
    decorate(left.page, 'Pairshare · you · connected'),
    decorate(right.page, 'Pairshare · peer · connected'),
  ]);

  console.log('Recording Pairshare live sync…');
  const sceneStart = Date.now();
  await pause(left.page, 800);
  await select(left.page, '#sync-sentence');
  await left.page.locator('#tmb-pill .pill').waitFor({ state: 'visible' });
  await pause(left.page, 650);
  await pointAndClick(left.page, left.page.locator('#tmb-pill .dot[data-color="blue"]'));
  await pointAndClick(left.page, left.page.locator('#tmb-pill button.go'));
  const localHighlight = left.page.locator('[data-tmb-id]').first();
  await localHighlight.waitFor({ state: 'visible' });
  await right.page.locator('[data-tmb-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await pointAndClick(left.page, left.page.locator('#tmb-editor textarea'));
  await left.page.keyboard.type('Keep this for the team review.', { delay: Math.round(43 * PACE) });
  await pause(left.page, 400);
  await pointAndClick(left.page, left.page.locator('#tmb-editor button', { hasText: 'Save' }));
  await right.page.waitForFunction(() => {
    const marks = document.querySelectorAll('[data-tmb-id]');
    return marks.length > 0;
  });
  await pause(right.page, 650);
  await pointAndHover(right.page, right.page.locator('[data-tmb-id]').first());
  await right.page.locator('#tmb-card .card').waitFor({ state: 'visible' });
  await right.page.waitForFunction(() => {
    const host = document.querySelector('#tmb-card');
    return host?.shadowRoot?.querySelector('.note')?.textContent === 'Keep this for the team review.';
  });
  await pause(right.page, 1500);
  const visible = (Date.now() - sceneStart) / 1000;

  const leftVideo = left.page.video();
  const rightVideo = right.page.video();
  await Promise.all([left.context.close(), right.context.close()]);
  await Promise.all([
    fs.copyFile(await leftVideo.path(), path.join(WORK, 'pair-left.webm')),
    fs.copyFile(await rightVideo.path(), path.join(WORK, 'pair-right.webm')),
  ]);
  await Promise.all([
    fs.rm(left.profile, { recursive: true, force: true }),
    fs.rm(right.profile, { recursive: true, force: true }),
  ]);
  return { visible };
}

async function trimStart(file, visible) {
  return Math.max(0, (await duration(file)) - visible - 0.12);
}

async function render(scenes) {
  console.log('Rendering README media…');
  const senderRaw = path.join(WORK, 'link-sender.webm');
  const recipientRaw = path.join(WORK, 'link-recipient.webm');
  const pairLeftRaw = path.join(WORK, 'pair-left.webm');
  const pairRightRaw = path.join(WORK, 'pair-right.webm');
  const senderClip = path.join(WORK, '01-link-sender.mp4');
  const recipientClip = path.join(WORK, '02-link-recipient.mp4');
  const pairClip = path.join(WORK, '03-pair.mp4');

  const senderStart = await trimStart(senderRaw, scenes.senderVisible);
  const recipientStart = await trimStart(recipientRaw, scenes.recipientVisible);
  const pairLeftStart = await trimStart(pairLeftRaw, scenes.pairVisible);
  const pairRightStart = await trimStart(pairRightRaw, scenes.pairVisible);
  const encode = ['-an', '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

  for (const [source, start, length, destination] of [
    [senderRaw, senderStart, scenes.senderVisible, senderClip],
    [recipientRaw, recipientStart, scenes.recipientVisible, recipientClip],
  ]) {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(3), '-i', source,
      '-t', length.toFixed(3), '-vf', `fps=30,scale=${FULL.width}:${FULL.height}:flags=lanczos,setsar=1`,
      ...encode, destination,
    ]);
  }

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', pairLeftStart.toFixed(3), '-i', pairLeftRaw,
    '-ss', pairRightStart.toFixed(3), '-i', pairRightRaw,
    '-t', scenes.pairVisible.toFixed(3),
    '-filter_complex',
    `[0:v]fps=30,scale=${HALF.width}:${HALF.height}:flags=lanczos,setsar=1[l];` +
      `[1:v]fps=30,scale=${HALF.width}:${HALF.height}:flags=lanczos,setsar=1[r];` +
      '[l][r]hstack=inputs=2:shortest=1[v]',
    '-map', '[v]', ...encode, pairClip,
  ]);

  const mp4 = path.join(OUTPUT, 'textmarker-demo.mp4');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', senderClip, '-i', recipientClip, '-i', pairClip,
    '-filter_complex',
    '[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];' +
      '[2:v]setpts=PTS-STARTPTS[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', ...encode, mp4,
  ]);

  const gif = path.join(OUTPUT, 'textmarker-demo.gif');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', mp4,
    '-filter_complex',
    'fps=12,scale=896:-1:flags=lanczos,split[a][b];' +
      '[a]palettegen=max_colors=192:stats_mode=diff[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop', '0', gif,
  ]);

  const posterAt = Math.min(4.5, scenes.senderVisible * 0.72);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', posterAt.toFixed(2),
    '-i', mp4, '-frames:v', '1', path.join(OUTPUT, 'textmarker-demo-poster.png'),
  ]);

  const stats = await Promise.all([mp4, gif].map(async (file) => ({
    file: path.relative(ROOT, file),
    bytes: (await fs.stat(file)).size,
  })));
  for (const item of stats) console.log(`  ${item.file}: ${(item.bytes / 1024 / 1024).toFixed(2)} MB`);
  if (stats.find((item) => item.file.endsWith('.gif')).bytes > 10 * 1024 * 1024) {
    throw new Error('README GIF exceeds GitHub\'s 10 MB image limit');
  }
}

let server;
try {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(OUTPUT, { recursive: true });
  server = await startServer(PORT);
  const link = await recordLinkshare();
  const pair = await recordPairshare();
  await render({
    senderVisible: link.senderVisible,
    recipientVisible: link.recipientVisible,
    pairVisible: pair.visible,
  });
  console.log('Demo ready.');
} finally {
  server?.close();
}
