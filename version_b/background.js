/* Textmarker B — Pairshare: background (MV3 service worker).
 * Relays toolbar clicks and keyboard commands to the content script.
 */
'use strict';

/* Firefox provides `browser`; Chromium service workers provide `chrome`. */
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}

async function sendToActiveTab(message) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    await browser.tabs.sendMessage(tab.id, message);
  } catch (_) {
    /* tab has no content script — ignore */
  }
}

browser.action.onClicked.addListener(() => {
  sendToActiveTab({ type: 'tmb:toggle-panel' });
});

browser.commands.onCommand.addListener((command) => {
  if (command === 'comment-selection') {
    sendToActiveTab({ type: 'tmb:command', cmd: 'comment' });
  } else if (command === 'toggle-pair-panel') {
    sendToActiveTab({ type: 'tmb:toggle-panel' });
  }
});
