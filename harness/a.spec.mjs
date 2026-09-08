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
// Select a [start,end) CHARACTER slice across the flattened text of `sel`,
// walking current text nodes in DOM order. Robust after prior highlights have
// split text nodes (the plain selectSlice above assumes a single firstChild).
async function selectCharSlice(page, sel, start, end) {
  await page.evaluate(([sel, start, end]) => {
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
async function saveEditorNote(page, note) {
  const ta = page.locator('#tma-editor textarea');
  await ta.click();
  await page.keyboard.type(note, { delay: 30 });
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tma-editor');
    const b = el && el.shadowRoot && el.shadowRoot.querySelector('.editor');
    return !b || b.style.display !== 'block';
  });
}
const ownIds = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-tma-id]:not([data-tma-id^="s:"])'))
    .map((e) => e.getAttribute('data-tma-id')));
async function cardNoteFor(page, id) {
  await page.locator(`[data-tma-id="${id}"]`).first().click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tma-card');
    const b = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return b ? b.style.display === 'block' : false;
  }, { timeout: 5000 });
  const note = await page.locator('#tma-card .card .note').evaluate((el) => el.textContent);
  await page.locator('#tma-card button', { hasText: 'Close' }).click();
  return note;
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

const cardShown = () => page.waitForFunction(
  () => {
    const el = document.querySelector('#tma-card');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.card');
    return box ? box.style.display === 'block' : false;
  },
  { timeout: 5000 },
);

await test('T3 save note -> highlight + comment survive reload', async () => {
  // Type the note slowly, like a human (not fill()), then pause past the
  // 300ms storage.onChanged debounce that createMarkFromSelection' own
  // pre-editor savePage() triggers. That debounce reassigns state.marks to
  // a structurally-cloned array; if the editor held the original mark ref,
  // its Save used to be silently dropped (regression: "note does not appear,
  // Edit reopens empty").
  await editorTa.click();
  await page.keyboard.type('the fox is the main character', { delay: 40 });
  await page.waitForTimeout(500); // > 300ms debounce window
  await page.locator('#tma-editor button', { hasText: 'Save' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#tma-editor');
    const box = el && el.shadowRoot && el.shadowRoot.querySelector('.editor');
    return !box || box.style.display !== 'block';
  });
  // The note must appear in the hover card immediately — no reload needed
  // (this is the user's reported symptom).
  await page.locator('[data-tma-id]').first().hover();
  await cardShown();
  const text = await cardText();
  assert(text.includes('the fox is the main character'),
    'card missing note right after Save (no reload): ' + text.slice(0, 120));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });
  const n = await page.locator('[data-tma-id]').count();
  assert(n > 0, 'no highlights after reload');
});

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

await test('T6a Edit from a pinned card hides the card (editor not behind it)', async () => {
  // Regression: clicking a highlight pins the card. The Edit button used to
  // call hide(), which is a no-op while pinned, so the card stayed on top of
  // the editor (the card's shadow host is appended after the editor's and
  // they share the same z-index, so the card wins the stack). The editor
  // opened *behind* the card and was unusable until the card was dismissed.
  await page.locator('[data-tma-id]').first().click(); // click pins the card
  await cardShown();
  assert((await cardVisible()), 'card should be pinned and visible');
  await page.locator('#tma-card button', { hasText: 'Edit' }).click();
  assert(await editorVisible(), 'editor did not open from pinned-card Edit');
  assert(!(await cardVisible()), 'pinned card did not hide on Edit — editor is behind it');
  // clean up: close the editor so the next test starts clean.
  await page.locator('#tma-editor button', { hasText: 'Cancel' }).click();
});

await test('T6 delete via editor removes the mark after reload', async () => {
  await page.locator('[data-tma-id]').first().hover();
  await cardShown();
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

await test('T11 multiple marks in the SAME paragraph all render and survive', async () => {
  // Regression: with two non-overlapping selections in one paragraph, the
  // 2nd mark used to not render (sometimes ever) and only "reappear nilly
  // willy" on the retry loop. Root cause: restoreOwn built state.idx once,
  // then wrapping mark1 splitText()'d the shared text node; mark2's
  // locate()/rawToRange() then used the stale (truncated) node refs and
  // threw IndexSizeError -> null -> state.failed. Different paragraphs were
  // unaffected because their text nodes were never split.
  await sw.evaluate(async () => { await chrome.storage.local.remove('tma.pages'); });
  await page.goto(BASE + '/');
  await waitBooted(page);
  // #p1: "The quick brown fox jumps over the lazy dog, and then it goes
  //       home to sleep in the warm barn by the river." (~104 chars)
  await selectCharSlice(page, '#p1', 0, 19);    // "The quick brown fox"
  await pill.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#tma-pill button').click();
  await page.waitForSelector('[data-tma-id]');
  await saveEditorNote(page, 'first');
  // pause past the storage.onChanged debounce so the restore race also runs
  await page.waitForTimeout(600);

  await selectCharSlice(page, '#p1', 40, 60);   // "dog, and then it goe"
  await pill.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#tma-pill button').click();
  await page.waitForSelector('[data-tma-id]');
  await saveEditorNote(page, 'second');
  await page.waitForTimeout(600);

  // Both highlights must be present right now — no reload, no retry.
  const live = await ownIds();
  eq(live.length, 2, '2nd mark in same paragraph did not render immediately: ' + JSON.stringify(live));

  // And each one shows its own note (click pins the card).
  const notes = {};
  for (const id of live) notes[id] = await cardNoteFor(page, id);
  const values = Object.values(notes).sort();
  eq(values, ['first', 'second'], 'notes mixed up: ' + JSON.stringify(notes));

  // Both must survive a reload too.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-tma-id]', { timeout: 8000 });
  const after = await ownIds();
  eq(after.length, 2, 'not both marks restored after reload: ' + JSON.stringify(after));
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
