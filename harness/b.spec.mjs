#!/usr/bin/env node
/* E2E harness for version_b (Pairshare).
 * Loads the real extension into Chromium; verifies core mark flow AND a real
 * WebRTC P2P session between two tabs (loopback host candidates, no STUN
 * needed on one machine).
 *
 * Run: cd harness && node b.spec.mjs
 */
'use strict';

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', 'version_b');
const PORT = Number(process.env.HARNESS_PORT_B || 8133);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? String(e.message).split('\n').slice(0, 6).join('\n      ') : e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error('assert: ' + (msg || 'condition false'));
}

const server = await startServer(PORT);
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-harness-b-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
ctx.setDefaultTimeout(15000);
const sw = await ctx.waitForEvent('serviceworker');
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('pageerror', (e) => console.log('[pageerror page1]', (e.stack || e.message).split('\n')[0]));

const sendBg = (msg) => sw.evaluate(async (m) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, m);
}, msg);

const waitBooted = (pg, t = 10000) => pg.waitForFunction(
  () => document.documentElement.hasAttribute('data-tmb-ready'),
  { timeout: t },
);
const selectWhole = (pg, sel) => pg.evaluate((s) => {
  const el = document.querySelector(s);
  const r = document.createRange();
  r.selectNodeContents(el);
  const seln = window.getSelection();
  seln.removeAllRanges();
  seln.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}, sel);

const panel = (pg) => pg.locator('#tmb-panel');
const statusText = (pg) => pg.locator('#tmb-panel .status').evaluate((el) => el.textContent);
const waitStatus = (pg, needle, t = 12000) => pg.waitForFunction(
  (n) => {
    const el = document.querySelector('#tmb-panel');
    const st = el && el.shadowRoot && el.shadowRoot.querySelector('.status');
    return st && st.textContent.includes(n);
  },
  needle,
  { timeout: t },
);
const panelOpen = (pg) => pg.evaluate(() => {
  const el = document.querySelector('#tmb-panel');
  const ov = el && el.shadowRoot && el.shadowRoot.querySelector('.overlay');
  return ov ? ov.style.display === 'block' : false;
});
async function setPanel(pg, open) {
  await pg.bringToFront();
  if (await panelOpen(pg) ? open === false : open) {
    await sendBg({ type: 'tmb:toggle-panel' });
    await pg.waitForTimeout(100);
  }
}

console.log(`\n=== version_b e2e (base ${BASE}) ===`);

await page.goto(BASE + '/');
await waitBooted(page);

/* ---------------- core ---------------- */

await test('B1 pill shows 4 color dots; picking a color + comment creates colored mark', async () => {
  await selectWhole(page, '#p1');
  await page.locator('#tmb-pill .pill').waitFor({ state: 'visible', timeout: 5000 });
  eqDots(await page.locator('#tmb-pill .dot').count(), 4, 'four dots');
  // pick blue
  await page.locator('#tmb-pill .dot[data-color="blue"]').click();
  const sel = await page.locator('#tmb-pill .dot.sel').evaluate((el) => el.dataset.color);
  assert(sel === 'blue', 'blue selected');
  await page.locator('#tmb-pill button.go').click();
  await page.waitForSelector('[data-tmb-id]');
  const color = await page.locator('[data-tmb-id]').first().getAttribute('data-tmb-color');
  assert(color === 'blue', 'highlight uses blue, got ' + color);
  const editorOpen = await page.locator('#tmb-editor .editor').evaluate((el) => el.style.display === 'block');
  assert(editorOpen, 'editor opened');
  await page.locator('#tmb-editor textarea').fill('blue mark note');
  await page.locator('#tmb-editor button', { hasText: 'Save' }).click();
});

function eqDots(a, b, msg) {
  if (a !== b) throw new Error(msg + ` — got ${a}, want ${b}`);
}

await test('B2 colored mark + note survive reload', async () => {
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await page.waitForSelector('[data-tmb-id]', { timeout: 8000 });
  const color = await page.locator('[data-tmb-id]').first().getAttribute('data-tmb-color');
  assert(color === 'blue', 'color restored, got ' + color);
  await page.locator('[data-tmb-id]').first().hover();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  const cardText = await page.locator('#tmb-card .card').evaluate((el) => el.textContent);
  assert(cardText.includes('blue mark note'), 'note restored: ' + cardText.slice(0, 100));
});

/* ---------------- pairing ---------------- */

const p2 = await ctx.newPage();
p2.on('pageerror', (e) => console.log('[pageerror page2]', (e.stack || e.message).split('\n')[0]));
await p2.goto(BASE + '/');
await waitBooted(p2);

await test('B3 pair handshake: invite (page1) + join (page2) -> both connected', async () => {
  // page1: invite
  await setPanel(page, true);
  await waitStatus(page, 'Not paired');
  await page.locator('#tmb-panel [data-el="gen"]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-panel');
    const ta = el && el.shadowRoot && el.shadowRoot.querySelector('[data-el="invite-out"]');
    return ta && ta.value.length > 100;
  }, { timeout: 15000 });
  const invite = await page.locator('#tmb-panel [data-el="invite-out"]').inputValue();
  assert(invite.length > 100, 'invite code generated');

  // page2: join
  await setPanel(p2, true);
  await p2.locator('#tmb-panel .tabs button', { hasText: 'Join' }).click();
  await p2.locator('#tmb-panel [data-el="invite-in"]').fill(invite);
  await p2.locator('#tmb-panel [data-el="gen-join"]').click();
  await p2.waitForFunction(() => {
    const el = document.querySelector('#tmb-panel');
    const ta = el && el.shadowRoot && el.shadowRoot.querySelector('[data-el="join-out"]');
    return ta && ta.value.length > 100;
  }, { timeout: 15000 });
  const joinCode = await p2.locator('#tmb-panel [data-el="join-out"]').inputValue();
  assert(joinCode.length > 100, 'join code generated');

  // page1: connect
  await page.bringToFront();
  await page.locator('#tmb-panel [data-el="join-in"]').fill(joinCode);
  await page.locator('#tmb-panel [data-el="connect"]').click();
  await waitStatus(page, 'Connected');
  await waitStatus(p2, 'Connected');
  // close the overlay on both sides so the pill/editor are reachable
  await setPanel(page, false);
  await setPanel(p2, false);
  await page.bringToFront();
});

await test('B4 live sync: new mark on page1 appears on page2', async () => {
  await page.bringToFront();
  await selectWhole(page, '#p2');
  await page.locator('#tmb-pill button.go').click();
  await page.waitForSelector('#p2 [data-tmb-id]'); // mark created on #p2
  await page.locator('#tmb-editor textarea').fill('synced over webrtc');
  await page.locator('#tmb-editor button', { hasText: 'Save' }).click();
  await p2.waitForSelector('[data-tmb-id]', { timeout: 8000 });
  const n = await p2.locator('[data-tmb-id]').count();
  assert(n >= 1, 'page2 has the synced mark');
});

await test('B5 live sync: note edit on page1 reaches page2', async () => {
  // find the mark created on #p2 on page1 and edit it
  await page.bringToFront();
  const markEl = page.locator('#p2 [data-tmb-id]').first();
  await markEl.hover();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  await page.locator('#tmb-card button', { hasText: 'Edit' }).click();
  await page.locator('#tmb-editor textarea').fill('EDITED via p2p');
  await page.locator('#tmb-editor button', { hasText: 'Save' }).click();
  // page2: hover the same mark, check the fresh card text
  await p2.bringToFront();
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(300);
  await p2.locator('#p2 [data-tmb-id]').first().hover();
  await p2.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  const cardText = await p2.locator('#tmb-card .card').evaluate((el) => el.textContent);
  assert(cardText.includes('EDITED via p2p'), 'edited note reached page2: ' + cardText.slice(0, 120));
});

await test('B6 live sync: delete on page1 removes on page2', async () => {
  const before = await p2.locator('#p2 [data-tmb-id]').count();
  assert(before >= 1, 'precondition');
  await page.bringToFront();
  await page.locator('#p2 [data-tmb-id]').first().hover();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  await page.locator('#tmb-card button', { hasText: 'Edit' }).click();
  await page.locator('#tmb-editor button', { hasText: 'Delete' }).click();
  await p2.waitForFunction(
    () => document.querySelectorAll('#p2 [data-tmb-id]').length === 0,
    { timeout: 8000 },
  );
});

await test('B7 end session returns both sides to idle', async () => {
  await setPanel(page, true);
  await page.locator('#tmb-panel [data-el="end"]').click();
  assert((await statusText(page)).includes('Not paired'), 'page1 idle');
  await waitStatus(p2, 'Not paired', 8000);
});

/* ---------------- teardown ---------------- */

await ctx.close();
server.close();
await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
