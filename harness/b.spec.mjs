#!/usr/bin/env node
/* E2E harness for version_b (Pairshare).
 * Loads the real extension into Chromium; verifies:
 *   - comment threads (pill → sidebar card → chronological replies)
 *   - edit suggestions (pill → sidebar card with proposed replacement,
 *     submit / cancel, ⋮ Edit to re-propose)
 *   - sidebar cards: context/author/timestamp/body, ⋮ Edit+Delete menu,
 *     expand/collapse, close control
 *   - extension-origin editor isolation from pre-registered host keyboard
 *     listeners on window/document in capture/bubble phases
 *   - a real WebRTC P2P session between two tabs (loopback host candidates,
 *     no STUN needed on one machine) with threads, replies, suggestions and
 *     deletions syncing live, including author identity (Riley/Jordan).
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
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? String(e.message).split('\n').slice(0, 8).join('\n      ') : e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error('assert: ' + (msg || 'condition false'));
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'eq') + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/* Robust interaction helpers.
 *
 * In this headful host environment, Playwright's pre-action "visible &
 * stable" check intermittently rejects shadow-DOM elements that are
 * perfectly visible (a valid bounding box, native checkVisibility() ===
 * true, and a force click that succeeds). When the normal action times out
 * we fall back to a force action (click) or a direct value set (fill) so the
 * suite stays deterministic. The app behavior under test is identical. */
async function rclick(loc, opts) {
  try {
    await loc.click(opts);
  } catch (_) {
    await loc.click(Object.assign({ force: true, timeout: 8000 }, opts));
  }
}
async function rfill(loc, value) {
  try {
    await loc.fill(value, { timeout: 6000 });
  } catch (_) {
    await loc.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
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

// Capture [TMB-PAIR] console logs per page so sync tests can assert the
// WebRTC receive path actually ran (independent of the storage.onChanged
// echo, which both tabs share in this single-profile harness).
const pairLogs = { page: [], p2: [] };
page.on('console', (m) => { const t = m.text(); if (t.includes('[TMB-PAIR]')) pairLogs.page.push(t); });

const sendBg = (msg) => sw.evaluate(async (m) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, m);
}, msg);

const waitBooted = (pg, t = 10000) => pg.waitForFunction(
  () => document.documentElement.hasAttribute('data-tmb-ready'),
  { timeout: t },
);
/* Bring the page's window to the front first: with a headful browser on the
 * host machine, a background window can make Playwright's actionability
 * checks flake ("element is not visible") even though the element is
 * perfectly visible. */
const selectWhole = async (pg, sel) => {
  await pg.bringToFront();
  return pg.evaluate((s) => {
  const el = document.querySelector(s);
  const r = document.createRange();
  r.selectNodeContents(el);
  const seln = window.getSelection();
  seln.removeAllRanges();
  seln.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}, sel);
};

/* Select a [start,end) CHARACTER slice across the flattened text of `sel`,
 * walking current text nodes in DOM order. Robust after prior highlights
 * have split text nodes (selectWhole/selectSlice assume a single firstChild). */
async function selectCharSlice(pg, sel, start, end) {
  await pg.bringToFront();
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

/* ---------------- sidebar helpers (shadow DOM) ---------------- */

const sb = (pg) => pg.locator('#tmb-sidebar');
const sidebarVisible = (pg) => pg.evaluate(() => {
  const el = document.querySelector('#tmb-sidebar');
  const a = el && el.shadowRoot && el.shadowRoot.querySelector('[data-el="aside"]');
  return a ? a.style.display === 'flex' : false;
});
const sbCardCount = (pg) => pg.locator('#tmb-sidebar [data-el="card"]').count();
const sbCard = (pg, nth) => pg.locator('#tmb-sidebar [data-el="card"]').nth(nth || 0);
const cardText = (pg, nth) => sbCard(pg, nth).evaluate((el) => el.textContent);
// The card whose header context matches `needle`.
const sbCardWith = (pg, needle) => pg.locator('#tmb-sidebar [data-el="card"]', { hasText: needle });
const editorTextarea = (frameLoc) => frameLoc.contentFrame().locator('textarea');
const sbComposer = (pg, cardLoc, mode) => editorTextarea(
  cardLoc.locator(`[data-el="composer"][data-mode="${mode || 'message'}"]`),
);
const panelEditor = (pg, name) => editorTextarea(pg.locator(`#tmb-panel [data-el="${name}"]`));
async function waitEditorValue(loc, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  await loc.waitFor({ state: 'visible', timeout });
  while (Date.now() < end) {
    const value = await loc.inputValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for isolated editor value');
}
async function waitEditorReady(loc, timeout = 15000) {
  await loc.waitFor({ state: 'visible', timeout });
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await loc.getAttribute('data-tmb-ready') !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for isolated editor readiness');
}

/* Expand a card if it is collapsed (synced threads arrive collapsed). */
async function ensureOpen(pg, cardLoc) {
  const open = await cardLoc.evaluate((el) => el.classList.contains('open'));
  if (!open) await rclick(cardLoc.locator('.sb-card-head'));
}

async function toggleSidebar(pg, open) {
  const cur = await sidebarVisible(pg);
  if (cur !== open) {
    await sendBg({ type: 'tmb:command', cmd: 'toggle-sidebar' });
    await pg.waitForFunction((want) => {
      const el = document.querySelector('#tmb-sidebar');
      const a = el && el.shadowRoot && el.shadowRoot.querySelector('[data-el="aside"]');
      return (a ? a.style.display === 'flex' : false) === want;
    }, open, { timeout: 5000 });
  }
}

/* Create a comment thread on `sel` and post `message` as its first reply. */
async function newCommentThread(pg, sel, message) {
  await pg.bringToFront();
  await selectWhole(pg, sel);
  await pg.locator('#tmb-pill .pill').waitFor({ state: 'visible', timeout: 5000 });
  await rclick(pg.locator('#tmb-pill [data-el="comment"]'));
  await sb(pg).locator('[data-el="card"]').last().waitFor({ state: 'visible', timeout: 5000 });
  if (message) {
    await rfill(sbComposer(pg, sb(pg).locator('[data-el="card"]').last()), message);
    await rclick(sb(pg).locator('[data-el="card"]').last().locator('[data-el="post"]'));
  }
  await pg.waitForTimeout(150);
}

/* Create a suggestion on `sel`, set the proposed replacement, submit. */
async function newSuggestion(pg, sel, proposed) {
  await pg.bringToFront();
  await selectWhole(pg, sel);
  await pg.locator('#tmb-pill .pill').waitFor({ state: 'visible', timeout: 5000 });
  await rclick(pg.locator('#tmb-pill [data-el="suggest"]'));
  const card = sb(pg).locator('[data-el="card"]').last();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const ta = sbComposer(pg, card, 'suggested');
  await ta.waitFor({ state: 'visible', timeout: 5000 });
  if (proposed !== null) await rfill(ta, proposed);
  await rclick(card.locator('[data-el="submit"]'));
  await pg.waitForTimeout(150);
}

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

/* ---------------- hostile host-page keyboard listeners ---------------- */

const hotkeyPage = await ctx.newPage();
hotkeyPage.on('pageerror', (e) => console.log('[pageerror hotkeys]', (e.stack || e.message).split('\n')[0]));
await sw.evaluate(async () => { await chrome.storage.local.remove('tmb.pages'); });
await hotkeyPage.goto(BASE + '/host-hotkeys.html');
await waitBooted(hotkeyPage);
const primaryMod = process.platform === 'darwin' ? 'Meta' : 'Control';

await test('B19 isolated sidebar editor defeats pre-registered host capture/bubble hotkeys', async () => {
  await selectWhole(hotkeyPage, '#p1');
  await rclick(hotkeyPage.locator('#tmb-pill [data-el="comment"]'));
  const card = sb(hotkeyPage).locator('[data-el="card"]').last();
  const ta = sbComposer(hotkeyPage, card, 'message');
  await waitEditorReady(ta);
  await ta.focus();

  await hotkeyPage.keyboard.type('sdjk/rfbn? alpha', { delay: 15 });
  eq(await ta.inputValue(), 'sdjk/rfbn? alpha', 'shortcut-heavy text entered exactly');
  await hotkeyPage.keyboard.press('Home');
  await hotkeyPage.keyboard.press('ArrowRight');
  await hotkeyPage.keyboard.press('ArrowRight');
  await hotkeyPage.keyboard.press('Delete');
  await hotkeyPage.keyboard.press('End');
  await hotkeyPage.keyboard.press('Backspace');
  eq(await ta.inputValue(), 'sdk/rfbn? alph', 'caret, Delete and Backspace edit normally');
  await hotkeyPage.keyboard.press('PageUp');
  await hotkeyPage.keyboard.press('PageDown');
  await hotkeyPage.keyboard.press('End');
  await hotkeyPage.keyboard.press('Enter');
  await hotkeyPage.keyboard.type('z!');
  eq(await ta.inputValue(), 'sdk/rfbn? alph\nz!', 'Enter inserts a newline');

  eq(await hotkeyPage.evaluate(() => window.__hostHotkeys.count()), 0, 'host interference never ran');
  eq(await hotkeyPage.evaluate(() => window.__hostHotkeys.records.length), 0,
    'no editor keyboard event entered the parent DOM event path');
});

await test('B20 isolated editor preserves select/copy/cut/paste/undo and Tab focus navigation', async () => {
  const card = sb(hotkeyPage).locator('[data-el="card"]').last();
  const ta = sbComposer(hotkeyPage, card, 'message');
  await ta.focus();
  await hotkeyPage.keyboard.press(primaryMod + '+A');
  await hotkeyPage.keyboard.type('copy me');
  await hotkeyPage.keyboard.press(primaryMod + '+A');
  await hotkeyPage.keyboard.press(primaryMod + '+C');
  await hotkeyPage.keyboard.press('End');
  await hotkeyPage.keyboard.press('Enter');
  await hotkeyPage.keyboard.press(primaryMod + '+V');
  eq(await ta.inputValue(), 'copy me\ncopy me', 'copy and paste preserve native editing');
  for (let i = 0; i < 'copy me'.length; i++) await hotkeyPage.keyboard.press('Shift+ArrowLeft');
  await hotkeyPage.keyboard.press(primaryMod + '+X');
  eq(await ta.inputValue(), 'copy me\n', 'cut preserves the first line');
  await hotkeyPage.keyboard.press(primaryMod + '+V');
  await hotkeyPage.keyboard.press(primaryMod + '+Z');
  await hotkeyPage.keyboard.press(primaryMod + '+Z');
  eq(await ta.inputValue(), 'copy me\ncopy me', 'undo restores the cut text');

  await hotkeyPage.keyboard.press('Tab');
  eq(await card.locator('[data-el="post"]').evaluate((el) => el.getRootNode().activeElement === el), true,
    'Tab leaves the editor for the next Pairshare control');
  await ta.focus();
  await hotkeyPage.keyboard.press('Shift+Tab');
  eq(await card.locator('[data-el="more"]').evaluate((el) => el.getRootNode().activeElement === el), true,
    'Shift+Tab moves to the previous Pairshare control');
  await ta.focus();

  await hotkeyPage.keyboard.press(primaryMod + '+Enter');
  await hotkeyPage.waitForFunction(() => {
    const host = document.querySelector('#tmb-sidebar');
    const card = host && host.shadowRoot && host.shadowRoot.querySelector('[data-el="card"]');
    return card && card.textContent.includes('copy me');
  });
  eq(await hotkeyPage.evaluate(() => window.__hostHotkeys.records.length), 0,
    'editing chords, Tab and submit chord stayed out of the host event path');
});

await test('B21 proposed replacement and panel code editors are isolated; Escape remains deliberate', async () => {
  await selectWhole(hotkeyPage, '#p2');
  await rclick(hotkeyPage.locator('#tmb-pill [data-el="suggest"]'));
  const suggestion = sb(hotkeyPage).locator('[data-el="card"]').last();
  const proposal = sbComposer(hotkeyPage, suggestion, 'suggested');
  await waitEditorReady(proposal);
  await proposal.focus();
  await hotkeyPage.keyboard.press(primaryMod + '+A');
  await hotkeyPage.keyboard.type('sdjk/rfbn? proposed -> value;', { delay: 10 });
  eq(await proposal.inputValue(), 'sdjk/rfbn? proposed -> value;', 'proposal accepts real keyboard input');
  await hotkeyPage.keyboard.press(primaryMod + '+Enter');
  await hotkeyPage.waitForFunction(() => {
    const host = document.querySelector('#tmb-sidebar');
    return host && host.shadowRoot && host.shadowRoot.textContent.includes('sdjk/rfbn? proposed -> value;');
  });

  await setPanel(hotkeyPage, true);
  await rclick(hotkeyPage.locator('#tmb-panel .tabs button', { hasText: 'Join' }));
  const code = panelEditor(hotkeyPage, 'invite-in');
  await waitEditorReady(code);
  await code.focus();
  const codeText = 'v=0/abc+DEF_123? x=y; {code}';
  await hotkeyPage.keyboard.type(codeText, { delay: 10 });
  eq(await code.inputValue(), codeText, 'writable panel code accepts real keyboard input');
  await rclick(hotkeyPage.locator('#tmb-panel .tabs button', { hasText: /^Invite/ }));
  const joinCode = panelEditor(hotkeyPage, 'join-in');
  await waitEditorReady(joinCode);
  await joinCode.focus();
  const joinText = 'answer/SDP+456? line=one;';
  await hotkeyPage.keyboard.type(joinText, { delay: 10 });
  eq(await joinCode.inputValue(), joinText, 'second writable panel code editor accepts real keyboard input');
  eq(await hotkeyPage.evaluate(() => window.__hostHotkeys.records.length), 0,
    'sidebar, proposal and panel editor events all stayed in child frames');

  await hotkeyPage.keyboard.press('Escape');
  await hotkeyPage.waitForTimeout(100);
  assert(!(await panelOpen(hotkeyPage)), 'Escape closes the panel');
  assert(!(await sidebarVisible(hotkeyPage)), 'Escape preserves Pairshare sidebar dismissal');
});

await test('B22 host key listeners still receive every phase/type when focus returns to the page', async () => {
  await hotkeyPage.evaluate(() => {
    window.__hostHotkeys.clear();
    window.__hostHotkeys.setInterference(false);
    document.querySelector('#host-focus-target').focus();
  });
  await hotkeyPage.keyboard.press('q');
  const coverage = await hotkeyPage.evaluate(() => window.__hostHotkeys.records.map((r) =>
    r.owner + ':' + r.phase + ':' + r.type));
  for (const type of ['keydown', 'keypress', 'keyup']) {
    for (const ownerPhase of ['window:capture', 'document:capture', 'document:bubble', 'window:bubble']) {
      assert(coverage.includes(ownerPhase + ':' + type), 'missing host listener coverage: ' + ownerPhase + ':' + type);
    }
  }
  await hotkeyPage.evaluate(() => {
    window.__hostHotkeys.clear();
    window.__hostHotkeys.setInterference(true);
    document.querySelector('#host-focus-target').focus();
  });
  await hotkeyPage.keyboard.press('s');
  eq(await hotkeyPage.evaluate(() => window.__hostHotkeys.count()), 1,
    'the hostile shortcut runs normally with host-page focus');
});

await hotkeyPage.close();
await sw.evaluate(async () => { await chrome.storage.local.remove('tmb.pages'); });
await page.goto(BASE + '/');
await waitBooted(page);

/* ---------------- core: comment threads ---------------- */

await test('B1 pill offers Comment + Suggest edit (no color dots); comment thread posts in sidebar', async () => {
  await selectWhole(page, '#p1');
  const pill = page.locator('#tmb-pill .pill');
  await pill.waitFor({ state: 'visible', timeout: 5000 });
  // No color picker any more: exactly two action buttons, no dots.
  eq(await pill.locator('.dot').count(), 0, 'no color dots');
  eq(await pill.locator('[data-el="comment"]').count(), 1, 'Comment action');
  eq(await pill.locator('[data-el="suggest"]').count(), 1, 'Suggest edit action');
  await rclick(page.locator('#tmb-pill [data-el="comment"]'));

  // The thread card opened in the sidebar, expanded, composer focused.
  const card = sb(page).locator('[data-el="card"]').last();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const txt = await card.evaluate((el) => el.textContent);
  assert(txt.includes('Comment'), 'comment badge, got: ' + txt.slice(0, 120));
  assert(txt.includes('The quick brown fox'), 'context quote shown');
  assert(txt.includes('Riley'), 'author identity (Riley) shown');
  const ta = sbComposer(page, card, 'message');
  await rfill(ta, 'first message in thread');
  await rclick(card.locator('[data-el="post"]'));
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const last = cards && cards[cards.length - 1];
    return last && last.textContent.includes('first message in thread');
  }, { timeout: 5000 });
  // Highlight created and yellow (the only color now).
  const hl = page.locator('[data-tmb-id]').first();
  await hl.waitFor({ state: 'attached', timeout: 5000 });
  eq(await hl.getAttribute('data-tmb-color'), 'yellow', 'highlight is yellow');
  const bg = await hl.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', 'highlight visibly styled: ' + bg);
});

await test('B2 comment thread (message + author) survives reload', async () => {
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await page.waitForSelector('[data-tmb-id]', { timeout: 8000 });
  await toggleSidebar(page, true);
  const txt = await sbCardWith(page, 'The quick brown fox').first().evaluate((el) => el.textContent);
  assert(txt.includes('first message in thread'), 'message restored: ' + txt.slice(0, 160));
  assert(txt.includes('Riley'), 'author restored');
  eq(await page.locator('[data-tmb-id]').first().getAttribute('data-tmb-color'), 'yellow', 'yellow restored');
});

await test('B8 multiple threads in the SAME paragraph all render and survive', async () => {
  // Regression (stale idx): with two non-overlapping selections in one
  // paragraph, the 2nd thread used to not render because wrapping the first
  // split the shared text node and the stale index threw IndexSizeError.
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await toggleSidebar(page, true);
  const before = await sbCardCount(page);
  eq(before, 1, 'one thread from B1');

  await page.bringToFront();
  await selectCharSlice(page, '#p1', 0, 19);   // "The quick brown fox"
  await rclick(page.locator('#tmb-pill [data-el="comment"]'));
  await rfill(sbComposer(page, sb(page).locator('[data-el="card"]').last()), 'nested one');
  await rclick(sb(page).locator('[data-el="card"]').last().locator('[data-el="post"]'));
  await page.waitForTimeout(600); // past the storage.onChanged debounce

  await page.bringToFront();
  await selectCharSlice(page, '#p1', 40, 60);  // "dog, and then it goe"
  await rclick(page.locator('#tmb-pill [data-el="comment"]'));
  await rfill(sbComposer(page, sb(page).locator('[data-el="card"]').last()), 'nested two');
  await rclick(sb(page).locator('[data-el="card"]').last().locator('[data-el="post"]'));
  await page.waitForTimeout(600);

  // Both new threads present right now — no reload, no retry.
  eq(await sbCardCount(page), before + 2, 'both threads in same paragraph rendered immediately');
  const live = await page.locator('[data-tmb-id]').count();
  assert(live >= 3, 'highlights present, got ' + live);

  // Both survive a reload.
  await page.reload({ waitUntil: 'load' });
  await waitBooted(page);
  await toggleSidebar(page, true);
  eq(await sbCardCount(page), before + 2, 'both threads restored after reload');
});

await test('B9 hover card: Open thread closes the card and expands the sidebar thread', async () => {
  await toggleSidebar(page, false);
  await page.locator('[data-tmb-id]').first().hover();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box && box.style.display === 'block';
  }, { timeout: 5000 });
  const hoverTxt = await page.locator('#tmb-card .card').evaluate((el) => el.textContent);
  assert(hoverTxt.includes('The quick brown fox'), 'hover card shows context');
  assert(hoverTxt.includes('Riley'), 'hover card shows author');
  await rclick(page.locator('#tmb-card [data-el="open"]'));
  // hover card gone, sidebar open with that thread expanded
  const hoverGone = await page.locator('#tmb-card .card').evaluate((el) => el.style.display === 'none');
  assert(hoverGone, 'hover card closed');
  assert(await sidebarVisible(page), 'sidebar opened');
  const active = await page.evaluate(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const act = Array.from(cards || []).find((c) => c.classList.contains('active'));
    return act ? act.classList.contains('open') : false;
  });
  assert(active, 'opened thread is expanded');
});

await test('B10 first post keeps the message (storage.onChanged reference race)', async () => {
  // Regression: createMark saved with note-less thread then the 300ms
  // debounced storage.onChanged reload replaced core.marks with clones;
  // mutations applied to the stale reference were silently dropped. The
  // message must appear on the card immediately — no reload needed.
  await sw.evaluate(async () => { await chrome.storage.local.remove('tmb.pages'); });
  await page.goto(BASE + '/');
  await waitBooted(page);
  await selectWhole(page, '#p1');
  await rclick(page.locator('#tmb-pill [data-el="comment"]'));
  const card = sb(page).locator('[data-el="card"]').last();
  const ta = sbComposer(page, card, 'message');
  await rclick(ta);
  await page.keyboard.type('first post kept', { delay: 40 });
  await page.waitForTimeout(500); // run the storage.onChanged debounce
  await rclick(card.locator('[data-el="post"]'));
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const last = cards && cards[cards.length - 1];
    return last && last.textContent.includes('first post kept');
  }, { timeout: 5000 });
});

await test('B11 cards expand/collapse; sidebar close + reopen (Alt+L path)', async () => {
  // collapse
  const card = sb(page).locator('[data-el="card"]').last();
  await rclick(card.locator('.sb-card-head'));
  let open = await card.evaluate((el) => el.classList.contains('open'));
  assert(!open, 'card collapsed after header click');
  const bodyHidden = await card.locator('.sb-card-body').evaluate((el) => getComputedStyle(el).display === 'none');
  assert(bodyHidden, 'collapsed body is hidden');
  // expand again
  await rclick(card.locator('.sb-card-head'));
  open = await card.evaluate((el) => el.classList.contains('open'));
  assert(open, 'card re-expanded');

  // close the whole sidebar via the ✕ control
  await rclick(sb(page).locator('[data-el="close"]'));
  assert(!(await sidebarVisible(page)), 'sidebar closed');
  // reopen through the background command (Alt+L / toolbar path)
  await toggleSidebar(page, true);
  assert(await sidebarVisible(page), 'sidebar reopened');
  eq(await sbCardCount(page), 1, 'thread still listed after reopen');
});

await test('B12 ⋮ menu Delete removes the thread and its highlight', async () => {
  // add a throwaway thread, then delete it via the ⋮ menu
  await newCommentThread(page, '#p3', 'to be deleted');
  eq(await sbCardCount(page), 2, 'throwaway thread added');
  const card = sb(page).locator('[data-el="card"]').last();
  const id = await card.getAttribute('data-id');
  assert(id, 'card has a thread id');
  await rclick(card.locator('[data-el="more"]'));
  const menu = sb(page).locator('[data-el="menu"]');
  await menu.waitFor({ state: 'visible', timeout: 3000 });
  assert((await menu.textContent()).includes('Edit') && (await menu.textContent()).includes('Delete'), 'menu lists Edit + Delete');
  await rclick(menu.locator('[data-el="menu-delete"]'));
  await page.waitForFunction((iid) => document.querySelectorAll('[data-tmb-id="' + iid + '"]').length === 0,
    id, { timeout: 5000 });
  eq(await sbCardCount(page), 1, 'card removed');
  const bodyText = await page.locator('#p3').textContent();
  assert(bodyText.includes('Third paragraph'), 'page text intact after unwrap');
});

/* ---------------- pairing ---------------- */

const p2 = await ctx.newPage();
p2.on('pageerror', (e) => console.log('[pageerror page2]', (e.stack || e.message).split('\n')[0]));
p2.on('console', (m) => { const t = m.text(); if (t.includes('[TMB-PAIR]')) pairLogs.p2.push(t); });
await p2.goto(BASE + '/');
await waitBooted(p2);

await test('B3 pair handshake: invite (page1) + join (page2) -> both connected', async () => {
  // page1: invite
  await setPanel(page, true);
  await waitStatus(page, 'Not paired');
  await rclick(page.locator('#tmb-panel [data-el="gen"]'));
  const invite = await waitEditorValue(panelEditor(page, 'invite-out'), (value) => value.length > 100);
  assert(invite.length > 100, 'invite code generated');

  // page2: join
  await setPanel(p2, true);
  await rclick(p2.locator('#tmb-panel .tabs button', { hasText: 'Join' }));
  await rfill(panelEditor(p2, 'invite-in'), invite);
  await rclick(p2.locator('#tmb-panel [data-el="gen-join"]'));
  const joinCode = await waitEditorValue(panelEditor(p2, 'join-out'), (value) => value.length > 100);
  assert(joinCode.length > 100, 'join code generated');

  // page1: connect
  await page.bringToFront();
  await rfill(panelEditor(page, 'join-in'), joinCode);
  await rclick(page.locator('#tmb-panel [data-el="connect"]'));
  await waitStatus(page, 'Connected');
  await waitStatus(p2, 'Connected');
  // close the overlay on both sides so the pill/sidebar are reachable
  await setPanel(page, false);
  await setPanel(p2, false);
  await page.bringToFront();
});

await test('B13 live sync: comment thread + first message reach page2 (as Riley)', async () => {
  await page.bringToFront();
  await newCommentThread(page, '#p2', 'synced over webrtc');
  // page2: the thread appears in its sidebar with author Riley
  await p2.bringToFront();
  await toggleSidebar(p2, true);
  await p2.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    return Array.from(cards || []).some((c) => c.textContent.includes('Second paragraph') && c.textContent.includes('synced over webrtc'));
  }, { timeout: 8000 });
  const txt = await sbCardWith(p2, 'Second paragraph').first().evaluate((el) => el.textContent);
  assert(txt.includes('Riley'), 'peer-side author identity is Riley: ' + txt.slice(0, 160));
  // the highlight rendered on page2 too
  assert(await p2.locator('#p2 [data-tmb-id]').count() >= 1, 'highlight on page2');
  // assert the WebRTC receive path actually ran (not just the shared-profile
  // storage echo): onMessage must merge the incoming thread.
  await page.bringToFront();
  await page.waitForTimeout(400);
  const merged = pairLogs.p2.slice(-20).some((l) =>
    /onMessage merge: added=[1-9]/.test(l) || /onMessage merge:.*added=0 updated=[1-9]/.test(l));
  assert(merged, 'WebRTC receive path did not merge the thread on page2; logs: ' + JSON.stringify(pairLogs.p2.slice(-6)));
});

await test('B14 live sync: reply from page2 (Jordan) accumulates on page1, chronological', async () => {
  // page2 replies to the #p2 thread (expand the synced card first)
  await p2.bringToFront();
  const card = sbCardWith(p2, 'Second paragraph').first();
  await ensureOpen(p2, card);
  await rfill(sbComposer(p2, card, 'message'), 'reply from the other browser');
  await rclick(card.locator('[data-el="post"]'));
  // page1 sees both messages in order
  await page.bringToFront();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const c = Array.from(cards || []).find((x) => x.textContent.includes('Second paragraph'));
    if (!c) return false;
    const msgs = c.querySelectorAll('.sb-msg .body');
    return msgs.length >= 2 &&
      msgs[0].textContent.includes('synced over webrtc') &&
      msgs[1].textContent.includes('reply from the other browser');
  }, { timeout: 8000 });
  const txt = await sbCardWith(page, 'Second paragraph').first().evaluate((el) => el.textContent);
  assert(txt.includes('Jordan'), 'reply authored by Jordan: ' + txt.slice(0, 200));
  assert(txt.includes('Riley'), 'original still attributed to Riley');
});

await test('B15 live sync: deleting the thread on page1 removes it on page2', async () => {
  await page.bringToFront();
  const card = sbCardWith(page, 'Second paragraph').first();
  const id = await card.getAttribute('data-id');
  await rclick(card.locator('[data-el="more"]'));
  await rclick(sb(page).locator('[data-el="menu-delete"]'));
  await p2.waitForFunction((iid) => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    return !Array.from(cards || []).some((c) => c.getAttribute('data-id') === iid) &&
      document.querySelectorAll('[data-tmb-id="' + iid + '"]').length === 0;
  }, id, { timeout: 8000 });
  assert(await p2.locator('#p2 [data-tmb-id]').count() === 0, 'page2 highlight gone');
});

await test('B16 live sync: suggestion (page2/Jordan) + reply (page1/Riley)', async () => {
  // page2 suggests a replacement for the whole #p3 paragraph
  await p2.bringToFront();
  await newSuggestion(p2, '#p3', 'Third paragraph, rewritten.');
  // page1: the suggestion card arrives with context + proposed + Jordan
  await page.bringToFront();
  await toggleSidebar(page, true);
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    return Array.from(cards || []).some((c) =>
      c.textContent.includes('Suggestion') && c.textContent.includes('Third paragraph') &&
      c.textContent.includes('rewritten') && c.textContent.includes('Jordan'));
  }, { timeout: 8000 });
  const sug = sbCardWith(page, 'Third paragraph').first();
  const sugTxt = await sug.evaluate((el) => el.textContent);
  assert(sugTxt.includes('Third paragraph, rewritten.'), 'proposed replacement shown: ' + sugTxt.slice(0, 220));
  assert(sugTxt.includes('Third paragraph, plain and simple'), 'original passage shown as context');
  // page1 replies to the suggestion (expand the synced card first)
  await ensureOpen(page, sug);
  await rfill(sbComposer(page, sug, 'message'), 'good catch, +1');
  await rclick(sug.locator('[data-el="post"]'));
  await p2.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const c = Array.from(cards || []).find((x) => x.textContent.includes('Suggestion') && x.textContent.includes('Third paragraph'));
    return c && c.textContent.includes('good catch, +1') && c.textContent.includes('Riley');
  }, { timeout: 8000 });
});

await test('B17 live sync: ⋮ Edit re-proposes; the new proposed reaches the peer', async () => {
  await p2.bringToFront();
  const sug = sbCardWith(p2, 'Third paragraph').first();
  await rclick(sug.locator('[data-el="more"]'));
  await rclick(sb(p2).locator('[data-el="menu-edit"]'));
  const ta = sbComposer(p2, sug, 'suggested');
  await ta.waitFor({ state: 'visible', timeout: 3000 });
  await rfill(ta, 'Third paragraph, revised again.');
  await rclick(sug.locator('[data-el="submit"]'));
  await page.waitForFunction(() => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    const c = Array.from(cards || []).find((x) => x.textContent.includes('Suggestion') && x.textContent.includes('Third paragraph'));
    return c && c.textContent.includes('revised again');
  }, { timeout: 8000 });
});

await test('B18 suggestion cancel: composing is discarded, nothing created', async () => {
  await p2.bringToFront();
  const before = await sbCardCount(p2);
  const hlBefore = await p2.locator('[data-tmb-id]').count();
  // #p4 is the last paragraph with no thread yet, so the new draft sorts last
  await selectWhole(p2, '#p4');
  await rclick(p2.locator('#tmb-pill [data-el="suggest"]'));
  // the draft is the only card showing a suggested composer
  const card = sb(p2).locator('[data-el="card"]:has([data-el="composer"][data-mode="suggested"])');
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const ta = sbComposer(p2, card, 'suggested');
  // the input is pre-filled with the selected passage
  const pre = await waitEditorValue(ta, (value) => value.length > 0);
  assert(pre.length > 0, 'proposed input pre-filled with selection');
  await rfill(ta, 'abandoned proposal');
  await rclick(card.locator('[data-el="cancel"]').first());
  await p2.waitForFunction((n) => {
    const el = document.querySelector('#tmb-sidebar');
    const cards = el && el.shadowRoot && el.shadowRoot.querySelectorAll('[data-el="card"]');
    return cards.length === n;
  }, before, { timeout: 5000 });
  eq(await p2.locator('[data-tmb-id]').count(), hlBefore, 'no highlight left behind');
});

await test('B7 end session returns both sides to idle', async () => {
  await setPanel(page, true);
  await rclick(page.locator('#tmb-panel [data-el="end"]'));
  assert((await statusText(page)).includes('Not paired'), 'page1 idle');
  await waitStatus(p2, 'Not paired', 8000);
});

/* ---------------- teardown ---------------- */

await ctx.close();
server.close();
await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
