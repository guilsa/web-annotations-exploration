#!/usr/bin/env node
/* E2E harness for version_a (Linkshare).
 * Loads the real extension into Chromium (persistent context) and drives it
 * against a local static page + (if network allows) Wikipedia.
 *
 * Run: cd harness && pnpm test:a        (or: node a.spec.mjs)
 * Env: HEADLESS=1 to force headless (extensions need new headless; default is headful).
 */
'use strict';

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', 'version_a');
const PORT = Number(process.env.HARNESS_PORT || 8123);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? String(e.message).split('\n').slice(0, 6).join('\n      ') : e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error('assert: ' + (msg || 'condition false'));
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'eq') + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}

const server = await startServer(PORT);
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-harness-'));

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

async function getSW() {
  for (let i = 0; i < 40; i++) {
    const sws = ctx.serviceWorkers();
    if (sws.length) return sws[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('service worker did not start');
}

const page = ctx.pages()[0] || (await ctx.newPage());
const sw = await getSW();

/** Send a message to the active tab as the background would (toolbar/command path). */
async function sendBg(msg) {
  await sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, m);
  }, msg);
}

async function selectWhole(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error('no element ' + s);
    const r = document.createRange();
    r.selectNodeContents(el);
    const seln = window.getSelection();
    seln.removeAllRanges();
    seln.addRange(r);
    document.dispatchEvent(new Event('selectionchange')); // safety net
  }, sel);
}
async function selectSlice(page, sel, start, end) {
  await page.evaluate(([s, a, b]) => {
    const el = document.querySelector(s);
    const t = el.firstChild;
    const r = document.createRange();
    r.setStart(t, a);
    r.setEnd(t, b);
    const seln = window.getSelection();
    seln.removeAllRanges();
    seln.addRange(r);
    document.dispatchEvent(new Event('selectionchange')); // safety net
  }, [sel, start, end]);
}
/** Wait until the content script has fully booted (storage loaded, restore done). */
async function waitBooted(page, timeout = 10000) {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-tma-ready'),
    { timeout },
  );
}

const pill = page.locator('#tma-pill .pill');
const editorBox = page.locator('#tma-editor .editor');
const editorTa = page.locator('#tma-editor textarea');
const card = page.locator('#tma-card .card');

async function editorVisible() {
  return editorBox.evaluate((el) => el.style.display === 'block');
}
async function cardVisible() {
  return card.evaluate((el) => el.style.display === 'block');
}
async function cardText() {
  return card.evaluate((el) => el.textContent);
}
async function shareUrlAttr() {
  return page.evaluate(() => document.documentElement.getAttribute('data-tma-last-share'));
}

console.log(`\n=== version_a e2e (base ${BASE}) ===`);

await page.goto(BASE + '/');
await page.waitForSelector('#p3');
await waitBooted(page);

/* ---------------- core loop ---------------- */

await test('T1 selection shows the pill', async () => {
  await selectWhole(page, '#p1');
  await pill.waitFor({ state: 'visible', timeout: 5000 });
});

await test('T2 pill click highlights AND opens the comment box', async () => {
  await page.locator('#tma-pill button').click();
  await page.waitForSelector('[data-tma-id]');
  assert(await editorVisible(), 'editor box did not open');
  eq(await editorTa.evaluate((t) => t.value.length), 0, 'editor starts empty');
});

await test('T3 save note -> highlight + comment survive reload', async () => {
  await editorTa.fill('the fox is the main character');
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tma-editor');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.editor');
    return !box || box.style.display !== 'block';
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });
  const n = await page.locator('[data-tma-id]').count();
  assert(n > 0, 'no highlights after reload');
});

const cardShown = () => page.waitForFunction(
  () => {
    const el = document.querySelector('#tma-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box ? box.style.display === 'block' : false;
  },
  { timeout: 5000 },
);

await test('T4 hover shows card with the note', async () => {
  await page.locator('[data-tma-id]').first().hover();
  await cardShown();
  const text = await cardText();
  assert(text.includes('the fox is the main character'), 'card missing note: ' + text.slice(0, 120));
});

await test('T5 Edit button opens editor with prefilled note; edit persists', async () => {
  await page.locator('#tma-card button', { hasText: 'Edit' }).click();
  assert(await editorVisible(), 'editor did not open from Edit');
  eq(await editorTa.evaluate((t) => t.value), 'the fox is the main character', 'note not prefilled');
  await editorTa.fill('REVISED: the fox leads');
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });
  await page.locator('[data-tma-id]').first().hover();
  await cardShown();
  assert((await cardText()).includes('REVISED: the fox leads'), 'edited note not restored');
});

await test('T6 delete via editor removes the mark after reload', async () => {
  await page.locator('#tma-card button', { hasText: 'Edit' }).click();
  await page.locator('#tma-editor button', { hasText: 'Delete' }).click();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  eq(await page.locator('[data-tma-id]').count(), 0, 'mark still present after delete');
});

await test('T7 async-loaded paragraph can be marked and restores', async () => {
  await page.waitForSelector('#p4', { timeout: 5000 });
  await selectSlice(page, '#p4', 0, 20);
  await pill.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#tma-pill button').click();
  await page.waitForSelector('[data-tma-id]');
  await editorTa.fill('async text marked');
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });
  eq(await page.locator('[data-tma-id]').count(), 1, 'async mark not restored');
});

/* ---------------- sharing ---------------- */

await test('T8 share link: generated, decodes, renders shared layer, import works', async () => {
  // panel via the same path the toolbar button uses
  await sendBg({ type: 'tma:toggle-panel' });
  await page.waitForSelector('#tma-panel .panel');
  const panelVisible = await page.locator('#tma-panel .panel').evaluate((el) => el.style.display === 'block');
  assert(panelVisible, 'panel did not open');
  await page.locator('#tma-panel button', { hasText: 'Copy share link' }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-tma-last-share'), { timeout: 5000 });
  const url = await shareUrlAttr();
  assert(url && url.startsWith(BASE), 'bad share url: ' + url);
  assert(url.includes('tmc='), 'no tmc param');
  const b64 = url.match(/tmc=([A-Za-z0-9+/=]+)/)[1];
  const data = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert(data.v === 1 && Array.isArray(data.marks) && data.marks.length >= 1, 'bad payload');

  // open the share link in a fresh tab (no local state there)
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.waitForFunction(
    () => {
      const el = document.querySelector('#tma-banner');
      const bar = el && el.shadowRoot && el.shadowRoot.querySelector('.banner');
      return bar && bar.classList.contains('show');
    },
    { timeout: 8000 },
  );
  // The shared mark may target async-loaded text: wait for the retry loop to place it.
  await p2.waitForSelector('[data-tma-id^="s:"]', { timeout: 8000 });
  const sharedN = await p2.locator('[data-tma-id^="s:"]').count();
  assert(sharedN >= 1, 'no shared (purple) highlights');
  // Note: p2 shares the profile storage with `page`, so it may already have
  // local marks for this URL — that's expected, not a failure.
  const ownN = await p2.locator('[data-tma-id]:not([data-tma-id^="s:"])').count();

  await p2.locator('#tma-banner button', { hasText: 'Import all' }).click();
  await p2.waitForFunction(() => !location.hash.includes('tmc='), { timeout: 5000 });
  await p2.reload({ waitUntil: 'load' });
  // Imported marks may target async-loaded text: allow the retry loop to place them.
  await p2.waitForSelector('[data-tma-id]:not([data-tma-id^="s:"])', { timeout: 8000 }).catch(() => {});
  await p2.waitForTimeout(1000);
  const localAfter = await p2.locator('[data-tma-id]:not([data-tma-id^="s:"])').count();
  assert(localAfter >= ownN + data.marks.length, 'import did not add local marks: ' + localAfter + ' < ' + (ownN + data.marks.length));
  const sharedAfter = await p2.locator('[data-tma-id^="s:"]').count();
  eq(sharedAfter, 0, 'shared layer should be gone after import + url clean');
  await p2.close();
});

await test('T9 comment command (background path) + Alt+M accelerator check', async () => {
  await page.goto(BASE + '/');
  await waitBooted(page);
  const editorShown = (ms) => page.waitForFunction(() => {
    const el = document.querySelector('#tma-editor');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.editor');
    return box ? box.style.display === 'block' : false;
  }, { timeout: ms });

  // Deterministic: the exact message the toolbar button / keyboard command sends.
  await selectSlice(page, '#p2', 0, 18);
  await sendBg({ type: 'tma:command', cmd: 'comment' });
  const opened = await editorShown(3000).then(() => true).catch(() => false);
  assert(opened, 'comment command did not open the editor');
  await editorTa.fill('command mark');
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });

  // The keyboard accelerator is platform-dependent — report it, don't fail on it.
  // (use #p3: #p2's text is now split by the restored highlight above)
  await selectSlice(page, '#p3', 0, 18);
  await page.keyboard.press('Alt+M');
  const kb = await editorShown(2500).then(() => true).catch(() => false);
  console.log('      (Alt+M accelerator: ' + (kb ? 'triggered' : 'not triggered on this platform; command path verified above') + ')');
  if (kb) {
    await page.locator('#tma-editor button', { hasText: 'Cancel' }).click();
  }
});

/* ---------------- real page (network) ---------------- */

await test('T10 wikipedia: mark a sentence, survives reload', async () => {
  let ok = true;
  try {
    await page.goto('https://en.wikipedia.org/wiki/Firefox', { timeout: 20000, waitUntil: 'domcontentloaded' });
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    console.log('      (skipped: no network)');
    return;
  }
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#mw-content-text p')).some((p) => p.textContent.trim().length > 80),
    { timeout: 15000 },
  );
  await waitBooted(page, 20000);
  const made = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('#mw-content-text p'));
    for (const p of ps) {
      const txt = p.textContent.trim();
      if (txt.length < 80 || txt.length > 400) continue;
      const t = p.firstChild;
      if (!t || t.nodeType !== 3 || t.data.length < 70) continue;
      const r = document.createRange();
      r.setStart(t, 5);
      r.setEnd(t, 70);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    }
    return false;
  });
  if (!made) {
    console.log('      (skipped: no suitable paragraph)');
    return;
  }
  await page.waitForSelector('#tma-pill .pill', { state: 'visible', timeout: 5000 });
  await page.locator('#tma-pill button').click();
  await page.waitForSelector('[data-tma-id]');
  await page.locator('#tma-editor textarea').fill('wikipedia e2e mark');
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tma-id]', { timeout: 12000 });
});

/* ---------------- teardown ---------------- */

await ctx.close();
server.close();
await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
