#!/usr/bin/env node
/* Feasibility-gate proof: a shadow root is not an event-isolation boundary. */
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const port = Number(process.env.HARNESS_PROOF_PORT || 8134);
const server = await startServer(port);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/host-hotkeys.html`);
  await page.evaluate(() => {
    window.__shadowProof = { rootCapture: 0, target: 0 };
    const host = document.createElement('div');
    host.id = 'proof-shadow-host';
    const root = host.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    textarea.id = 'proof-shadow-textarea';
    root.addEventListener('keydown', (event) => {
      window.__shadowProof.rootCapture++;
      event.stopPropagation();
    }, true);
    textarea.addEventListener('keydown', () => { window.__shadowProof.target++; });
    root.appendChild(textarea);
    document.body.appendChild(host);
  });

  const textarea = page.locator('#proof-shadow-host textarea');
  await textarea.focus();
  await page.keyboard.type('s');

  const result = await page.evaluate(() => ({
    value: document.querySelector('#proof-shadow-host').shadowRoot.querySelector('textarea').value,
    activeId: document.activeElement && document.activeElement.id,
    shortcutCount: window.__hostHotkeys.count(),
    first: window.__hostHotkeys.records[0],
    rootCapture: window.__shadowProof.rootCapture,
    target: window.__shadowProof.target,
  }));

  if (result.value !== '' || result.activeId !== 'host-focus-target' ||
      result.shortcutCount !== 1 || !result.first ||
      result.first.owner !== 'window' || result.first.phase !== 'capture' ||
      result.rootCapture !== 1 || result.target !== 0) {
    throw new Error(`unexpected shadow-DOM proof result: ${JSON.stringify(result)}`);
  }
  console.log('ok: pre-registered window capture canceled shadow textarea input and stole focus');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  server.close();
}
