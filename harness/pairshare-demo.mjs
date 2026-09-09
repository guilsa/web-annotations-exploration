#!/usr/bin/env node
/* Pairshare (version_b) pairing-flow demo.
 *
 * Two isolated Chromium profiles are recorded side by side on the same page.
 * The Invite side opens the Pairshare panel and generates an invite code; the
 * Join side joins with that code and creates the join code; the invite side
 * pastes it back and Connects. Both panels end on "● Connected". The real
 * WebRTC handshake runs underneath and the real base64 codes stay visible in
 * the textareas (summarizing them read as a glitch to viewers).
 *
 * Run: pnpm demo:pairshare
 * Pace: DEMO_PACE=1.1 pnpm demo:pairshare
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
const EXTENSION = path.join(ROOT, 'version_b');
const WORK = path.join(HERE, '.demo-pairshare-work');
const OUTPUT = path.join(ROOT, 'docs', 'demo');
const PAGE_URL = process.env.DEMO_URL || 'https://resilientwebdesign.com/chapter5/';
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

/* ---- injected browser chrome (presentation only) ---- */

function demoChromeScript(role) {
  const install = () => {
    const SKIP = 'data-demo-skip';

    // Chrome bar: window dots, address, role label.
    const bar = document.createElement('div');
    bar.dataset.demoSkip = '';
    bar.setAttribute(SKIP, '');
    bar.style.cssText = [
      'position:fixed', 'inset:0 0 auto 0', 'height:48px',
      'display:flex', 'align-items:center', 'gap:12px', 'padding:0 14px',
      'z-index:2147483647', 'background:#f3f4f6', 'color:#4b5563',
      'border-bottom:1px solid #cfd2d6', 'box-shadow:0 1px 4px rgba(0,0,0,.12)',
      'font:12px/1 system-ui,-apple-system,sans-serif', 'box-sizing:border-box',
      'pointer-events:none',
    ].join(';');
    const dots = document.createElement('span');
    dots.style.cssText = 'display:flex;gap:5px;flex:none';
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('i');
      d.style.cssText = 'display:block;width:8px;height:8px;border-radius:50%;background:#aeb3b9';
      dots.appendChild(d);
    }
    const address = document.createElement('span');
    address.textContent = location.host + location.pathname;
    address.style.cssText = [
      'min-width:0', 'flex:1', 'max-width:460px', 'margin:auto',
      'padding:7px 12px', 'overflow:hidden', 'text-overflow:ellipsis',
      'white-space:nowrap', 'border:1px solid #d7d9dc', 'border-radius:6px',
      'background:#fff', 'color:#60646a', 'text-align:center',
    ].join(';');
    const label = document.createElement('strong');
    label.textContent = role;
    label.style.cssText = [
      'width:64px', 'color:#30343a', 'font-size:11px', 'letter-spacing:.08em',
      'text-align:right', 'text-transform:uppercase',
    ].join(';');
    bar.appendChild(dots);
    bar.appendChild(address);
    bar.appendChild(label);

    // Cursor dot (follows the real mouse, enlarges on press).
    const cursor = document.createElement('div');
    cursor.dataset.demoSkip = '';
    cursor.setAttribute(SKIP, '');
    cursor.style.cssText = [
      'position:fixed', 'left:-30px', 'top:-30px', 'z-index:2147483647',
      'width:17px', 'height:17px', 'border:2px solid #fff', 'border-radius:50%',
      'background:#202124', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      'transform:translate(-50%,-50%)', 'transition:width .12s,height .12s',
      'pointer-events:none',
    ].join(';');
    document.addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    }, true);
    document.addEventListener('mousedown', () => {
      cursor.style.width = '25px'; cursor.style.height = '25px';
    }, true);
    document.addEventListener('mouseup', () => {
      cursor.style.width = '17px'; cursor.style.height = '17px';
    }, true);

    document.documentElement.style.paddingTop = '48px';
    document.body.append(bar, cursor);

    // The extension's UI (overlay, pill, cards) also sits at z-index
    // 2147483647, so DOM order decides what wins. Keep the demo bar + cursor
    // as the last body children so they render above the pair panel.
    const keepTop = () => {
      if (document.body.lastElementChild !== cursor) {
        document.body.append(bar, cursor);
      }
    };
    new MutationObserver(keepTop).observe(document.body, { childList: true });

  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}

/* ---- browser lifecycle ---- */

async function launch(role) {
  const name = role.toLowerCase();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `pairshare-${name}-`));
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
    try {
      await context.grantPermissions(
        ['clipboard-read', 'clipboard-sanitized-write'], { origin: PAGE_URL });
    } catch (_) { /* copy toasts are optional in the video */ }
    const page = context.pages()[0] || await context.newPage();
    await page.addInitScript(demoChromeScript, role);
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

const overlayOpen = (page) => page.evaluate(() => {
  const el = document.querySelector('#tmb-panel');
  const ov = el && el.shadowRoot && el.shadowRoot.querySelector('.overlay');
  return ov ? ov.style.display === 'block' : false;
});

const statusHas = (page, needle) => page.waitForFunction((n) => {
  const el = document.querySelector('#tmb-panel');
  const st = el && el.shadowRoot && el.shadowRoot.querySelector('.status');
  return !!st && st.textContent.includes(n);
}, needle, { timeout: 15000 });

async function textareaValue(page, el) {
  const handle = await page.waitForFunction((sel) => {
    const host = document.querySelector('#tmb-panel');
    const ta = host && host.shadowRoot && host.shadowRoot.querySelector(`[data-el="${sel}"]`);
    return ta && ta.value.length > 100 ? ta.value : null;
  }, el, { timeout: 15000 });
  return handle.jsonValue();
}

async function togglePanel(browser) {
  await browser.page.bringToFront();
  const open = await overlayOpen(browser.page);
  if (!open) {
    await browser.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'tmb:toggle-panel' });
    });
    await browser.page.waitForFunction(
      () => {
        const el = document.querySelector('#tmb-panel');
        const ov = el && el.shadowRoot && el.shadowRoot.querySelector('.overlay');
        return ov && ov.style.display === 'block';
      }, { timeout: 8000 });
  }
}

const toastVisible = (page, needle) => page.evaluate((n) => {
  const el = document.querySelector('#tmb-toast');
  const t = el && el.shadowRoot && el.shadowRoot.querySelector('.toast');
  return !!t && t.style.display === 'block' && t.textContent.includes(n);
}, needle);

async function waitForToast(page, needle, ms) {
  try {
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('#tmb-toast');
        const t = el && el.shadowRoot && el.shadowRoot.querySelector('.toast');
        return !!t && t.style.display === 'block' && t.textContent.includes(n);
      }, needle, { timeout: ms });
    return true;
  } catch { return false; }
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

/**
 * The invite and join panes have different content heights, so the two
 * centered sheets would sit at slightly different vertical positions. Force
 * both sheets to the taller height so the side-by-side panels align.
 * Demo-only CSS injected into the (open) shadow root; no extension change.
 */
async function alignSheets(browsers) {
  const heights = await Promise.all(browsers.map(async (b) => b.page.evaluate(() => {
    const host = document.querySelector('#tmb-panel');
    const sheet = host && host.shadowRoot && host.shadowRoot.querySelector('.sheet');
    return sheet ? sheet.offsetHeight : 0;
  })));
  const maxH = Math.max(...heights);
  if (!maxH) throw new Error('Could not measure pair panel sheets');
  await Promise.all(browsers.map((b) => b.page.evaluate((h) => {
    const host = document.querySelector('#tmb-panel');
    const root = host && host.shadowRoot;
    if (!root) return;
    const st = document.createElement('style');
    st.textContent = `.sheet { height: ${h}px; }`;
    root.appendChild(st);
  }, maxH)));
}

async function pointAt(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot point at a hidden demo control');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
}

async function closeCapture(browser, destination) {
  const video = browser.page.video();
  await browser.context.close();
  await fs.copyFile(await video.path(), destination);
  await fs.rm(browser.profile, { recursive: true, force: true });
  activeBrowsers.delete(browser);
}

/* ---- the scene ---- */

async function record() {
  console.log(`Loading ${PAGE_URL} in two isolated browsers…`);
  // Launch sequentially: two simultaneous persistent Chromium startups are
  // needlessly brittle on developer laptops and offer no capture benefit.
  const invite = await launch('Invite');
  const join = await launch('Join');
  await Promise.all([
    invite.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    join.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }),
  ]);
  await Promise.all([
    invite.page.waitForFunction(
      () => document.documentElement.hasAttribute('data-tmb-ready'), { timeout: 18000 }),
    join.page.waitForFunction(
      () => document.documentElement.hasAttribute('data-tmb-ready'), { timeout: 18000 }),
  ]);
  await pause(invite.page, 500); // let fonts and the one image settle

  const sceneStart = Date.now();
  await pause(invite.page, 400); // calm open on both pages

  // 1 — Invite side opens the panel (Invite tab is the default).
  await togglePanel(invite);
  await pause(invite.page, 700);

  // 2 — Generate the invite code.
  await pointAndClick(invite.page, invite.page.locator('#tmb-panel [data-el="gen"]'));
  const inviteCode = await textareaValue(invite.page, 'invite-out');
  await pause(invite.page, 1000); // "Invite code ready — send it to the other browser"

  // 3 — Copy it (the hand-off).
  await pointAndClick(
    invite.page, invite.page.locator('#tmb-panel button', { hasText: 'Copy invite code' }));
  await waitForToast(invite.page, 'Invite code copied', 600);
  await pause(invite.page, 600);

  // 4 — Join side opens the panel and switches to the Join tab.
  await togglePanel(join);
  await pause(join.page, 450);
  await pointAndClick(
    join.page, join.page.locator('#tmb-panel .tabs button', { hasText: 'Join' }));
  await pause(join.page, 600);
  await alignSheets([invite, join]); // keep both sheets vertically aligned

  // 5 — Paste the invite code.
  await pointAt(join.page, join.page.locator('#tmb-panel [data-el="invite-in"]'));
  await pause(join.page, 250);
  await join.page.locator('#tmb-panel [data-el="invite-in"]').fill(inviteCode);
  await pause(join.page, 800);

  // 6 — Create the join code.
  await pointAndClick(join.page, join.page.locator('#tmb-panel [data-el="gen-join"]'));
  const joinCode = await textareaValue(join.page, 'join-out');
  await pause(join.page, 1000); // "Join code ready — send it back…"

  // 7 — Copy it back.
  await pointAndClick(
    join.page, join.page.locator('#tmb-panel button', { hasText: 'Copy join code' }));
  await waitForToast(join.page, 'Join code copied', 600);
  await pause(join.page, 600);

  // 8 — Invite side pastes the join code.
  await pointAt(invite.page, invite.page.locator('#tmb-panel [data-el="join-in"]'));
  await pause(invite.page, 250);
  await invite.page.locator('#tmb-panel [data-el="join-in"]').fill(joinCode);
  await pause(invite.page, 800);

  // 9 — Connect. The real WebRTC handshake runs over loopback host candidates.
  await pointAndClick(invite.page, invite.page.locator('#tmb-panel [data-el="connect"]'));
  await Promise.all([statusHas(invite.page, 'Connected'), statusHas(join.page, 'Connected')]);

  // 10 — Finish clean on both ● Connected states: let the "Connecting…"
  // toast expire, park the cursor, hold the final state.
  await invite.page.waitForFunction(() => {
    const el = document.querySelector('#tmb-toast');
    const t = el && el.shadowRoot && el.shadowRoot.querySelector('.toast');
    return !t || t.style.display !== 'block';
  }, { timeout: 4000 });
  await invite.page.mouse.move(48, VIEWPORT.height - 56, { steps: 14 });
  await pause(invite.page, 1800);
  const visible = (Date.now() - sceneStart) / 1000;
  await Promise.all([
    closeCapture(invite, path.join(WORK, 'invite.webm')),
    closeCapture(join, path.join(WORK, 'join.webm')),
  ]);
  return visible;
}

/* ---- render ---- */

async function render(visible) {
  console.log('Rendering side-by-side H.264 video…');
  const invite = path.join(WORK, 'invite.webm');
  const join = path.join(WORK, 'join.webm');

  const inviteStart = Math.max(0, await duration(invite) - visible - 0.12);
  const joinStart = Math.max(0, await duration(join) - visible - 0.12);
  const mp4 = path.join(OUTPUT, 'pairshare-demo.mp4');

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', inviteStart.toFixed(3), '-i', invite,
    '-ss', joinStart.toFixed(3), '-i', join,
    '-t', visible.toFixed(3),
    '-filter_complex',
    `[0:v]fps=30,scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos,setsar=1[l];` +
      `[1:v]fps=30,scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos,setsar=1[r];` +
      '[l][r]hstack=inputs=2:shortest=1,' +
      `drawbox=x=${VIEWPORT.width - 2}:y=0:w=4:h=${VIEWPORT.height}:color=#c8cbd0:t=fill[v]`,
    '-map', '[v]', '-an', '-r', '30', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
  ]);

  const bytes = (await fs.stat(mp4)).size;
  console.log(`  docs/demo/pairshare-demo.mp4: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (bytes > 10 * 1024 * 1024) throw new Error('Demo exceeds GitHub\'s 10 MB upload limit');
}

try {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(OUTPUT, { recursive: true });
  const visible = await record();
  console.log(`Scene length: ${visible.toFixed(1)}s`);
  await render(visible);
  console.log('Pairshare demo ready.');
} finally {
  await Promise.allSettled(Array.from(activeBrowsers, async (browser) => {
    await browser.context.close().catch(() => {});
    await fs.rm(browser.profile, { recursive: true, force: true }).catch(() => {});
  }));
}
