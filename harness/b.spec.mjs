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
  // Regression: the highlight span must be visually styled (non-transparent
  // background). version_b used to inject no page-level CSS for .tmb-hl, so
  // spans existed in the DOM (hover/click worked) but were invisible.
  const bg = await page.locator('[data-tmb-id]').first().evaluate(
    (el) => getComputedStyle(el).backgroundColor);
  assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent',
    'highlight has no visible background (injectPageCSS missing): ' + bg);
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

await test('B9 Edit from a pinned card hides the card (editor not behind it)', async () => {
  // Regression: clicking a highlight pins the card. The Edit button used to
  // call hide() while still pinned (a no-op), then set pinned=false AFTER —
  // too late, the card stayed display:block. The card's shadow host is
  // appended after the editor's and they share z-index 2147483647, so the
  // card won the stack and the editor opened behind it. Same bug + fix as
  // version_a T6a.
  await page.locator('[data-tmb-id]').first().click(); // click pins the card
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  await page.locator('#tmb-card button', { hasText: 'Edit' }).click();
  const editorOpen = await page.locator('#tmb-editor .editor').evaluate((el) => el.style.display === 'block');
  assert(editorOpen, 'editor did not open from pinned-card Edit');
  const cardStillUp = await page.locator('#tmb-card .card').evaluate((el) => el.style.display === 'block');
  assert(!cardStillUp, 'pinned card did not hide on Edit — editor is behind it');
  // clean up: close the editor so the next test starts clean.
  await page.locator('#tmb-editor button', { hasText: 'Cancel' }).click();
});

// Select a [start,end) CHARACTER slice across the flattened text of `sel`,
// walking current text nodes in DOM order. Robust after prior highlights have
// split text nodes (selectWhole/selectSlice assume a single firstChild).
async function selectCharSlice(pg, sel, start, end) {
  await pg.evaluate(([sel, start, end]) => {
    const el = document.querySelector(sel);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let t, map = [];
    while ((t = w.nextNode())) map.push(t);
    const point = (o) => {
      let off = 0;
      for (const n of map) { if (o < off + n.data.length) return [n, o - off]; off += n.data.length; }
      const last = map[map.length - 1]; return [last, last.data.length];
    };
    const [sn, so] = point(start), [en, eo] = point(end);
    const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  }, [sel, start, end]);
}
async function saveEditorNote(pg, note) {
  const ta = pg.locator('#tmb-editor textarea');
  await ta.click();
  await pg.keyboard.type(note, { delay: 30 });
  await pg.locator('#tmb-editor button', { hasText: 'Save' }).click();
  await pg.waitForFunction(() => {
    const el = document.querySelector('#tmb-editor');
    const b = el && el.shadowRoot && el.shadowRoot.querySelector('.editor');
    return !b || b.style.display !== 'block';
  });
}
const ownIds = (pg) => pg.evaluate(() =>
  Array.from(document.querySelectorAll('[data-tmb-id]:not([data-tmb-id^="r:"])'))
    .map((e) => e.getAttribute('data-tmb-id')));

await test('B8 multiple marks in the SAME paragraph all render and survive', async () => {
  // Regression: with two non-overlapping selections in one paragraph, the
  // 2nd mark used to not render (sometimes ever). Root cause: Core.render()
  // built idx once then wrapped every mark in a loop; wrapping mark1
  // splitText()'d the shared text node, so mark2's locate() used the stale
  // (truncated) node refs and threw IndexSizeError -> null -> this.failed.
  // Different paragraphs were unaffected (disjoint text nodes). Same bug +
  // fix as version_a T11.
  await sw.evaluate(async () => { await chrome.storage.local.remove('tmb.pages'); });
  await page.goto(BASE + '/');
  await waitBooted(page);
  // #p1: "The quick brown fox jumps over the lazy dog, and then it goes
  //       home to sleep in the warm barn by the river." (~104 chars)
  await selectCharSlice(page, '#p1', 0, 19);    // "The quick brown fox"
  await page.locator('#tmb-pill .pill').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#tmb-pill button.go').click();
  await page.waitForSelector('[data-tmb-id]');
  await saveEditorNote(page, 'first');
  await page.waitForTimeout(600); // past the storage.onChanged debounce

  await selectCharSlice(page, '#p1', 40, 60);   // "dog, and then it goe"
  await page.locator('#tmb-pill .pill').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#tmb-pill button.go').click();
  await page.waitForSelector('[data-tmb-id]');
  await saveEditorNote(page, 'second');
  await page.waitForTimeout(600);

  // Both highlights must be present right now — no reload, no retry.
  const live = await ownIds(page);
  assert(live.length === 2, '2nd mark in same paragraph did not render immediately: ' + JSON.stringify(live));

  // Both must survive a reload too.
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await page.waitForSelector('[data-tmb-id]', { timeout: 8000 });
  const after = await ownIds(page);
  assert(after.length === 2, 'not both marks restored after reload: ' + JSON.stringify(after));
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
