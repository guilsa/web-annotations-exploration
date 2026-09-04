/* Textmarker A — Linkshare: background (event page).
 * Only job: relay toolbar clicks and keyboard commands to the content script.
 */
'use strict';

async function sendToActiveTab(message) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    await browser.tabs.sendMessage(tab.id, message);
  } catch (_) {
    /* tab has no content script (e.g. about: pages) — ignore */
  }
}

browser.action.onClicked.addListener(() => {
  sendToActiveTab({ type: 'tma:toggle-panel' });
});

browser.commands.onCommand.addListener((command) => {
  if (command === 'comment-selection') {
    sendToActiveTab({ type: 'tma:command', cmd: 'comment' });
  } else if (command === 'copy-share-link') {
    sendToActiveTab({ type: 'tma:command', cmd: 'share' });
  }
});
