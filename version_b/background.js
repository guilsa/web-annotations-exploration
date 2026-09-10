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
  } else if (command === 'toggle-comments-sidebar') {
    sendToActiveTab({ type: 'tmb:command', cmd: 'toggle-sidebar' });
  } else if (command === 'toggle-pair-panel') {
    sendToActiveTab({ type: 'tmb:toggle-panel' });
  }
});

/* Isolated-editor broker.
 *
 * Writable Pairshare controls live in extension-origin child frames so their
 * keyboard events never enter the host page's DOM event path. Content scripts
 * and those frames cannot safely exchange field contents through window
 * messages (page scripts can observe parent-window MessageEvents), so both
 * sides connect here instead. Ports are paired by tab + unguessable instance
 * id and by their trusted sender context.
 */
const editorPairs = new Map();
const CORE_PREFIX = 'tmb-editor-core:';
const UI_PREFIX = 'tmb-editor-ui:';

function validEditorMessage(role, msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (role === 'core') {
    if (msg.type === 'init' || msg.type === 'set-state') {
      return Number.isSafeInteger(msg.version) && msg.version >= 0 &&
        typeof msg.value === 'string' && msg.value.length <= 10000 &&
        (msg.selectionStart == null || Number.isSafeInteger(msg.selectionStart)) &&
        (msg.selectionEnd == null || Number.isSafeInteger(msg.selectionEnd)) &&
        (msg.placeholder == null || (typeof msg.placeholder === 'string' && msg.placeholder.length <= 500)) &&
        (msg.readOnly == null || typeof msg.readOnly === 'boolean') &&
        (msg.maxLength == null || (Number.isSafeInteger(msg.maxLength) && msg.maxLength > 0 && msg.maxLength <= 10000));
    }
    return msg.type === 'focus' ||
      (msg.type === 'get-state' && Number.isSafeInteger(msg.requestId) && msg.requestId >= 0);
  }
  if (msg.type === 'ready' || msg.type === 'focus' || msg.type === 'blur') return true;
  if (msg.type === 'input') {
    return Number.isSafeInteger(msg.version) && msg.version >= 0 &&
      Number.isSafeInteger(msg.seq) && msg.seq >= 0 &&
      typeof msg.value === 'string' && msg.value.length <= 10000 &&
      Number.isSafeInteger(msg.selectionStart) && Number.isSafeInteger(msg.selectionEnd);
  }
  if (msg.type === 'selection') {
    return Number.isSafeInteger(msg.version) && msg.version >= 0 &&
      Number.isSafeInteger(msg.selectionStart) && Number.isSafeInteger(msg.selectionEnd);
  }
  if (msg.type === 'state') {
    return Number.isSafeInteger(msg.requestId) && msg.requestId >= 0 &&
      Number.isSafeInteger(msg.version) && msg.version >= 0 &&
      typeof msg.value === 'string' && msg.value.length <= 10000 &&
      Number.isSafeInteger(msg.selectionStart) && Number.isSafeInteger(msg.selectionEnd);
  }
  return msg.type === 'action' &&
    ['submit', 'escape', 'tab-next', 'tab-prev'].includes(msg.action);
}

function editorSenderRole(port) {
  const name = String(port.name || '');
  const sender = port.sender || {};
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) return null;
  if (name.startsWith(CORE_PREFIX) && sender.frameId === 0 && /^https?:/.test(sender.url || '')) {
    return { role: 'core', id: name.slice(CORE_PREFIX.length), tabId };
  }
  const editorUrl = browser.runtime.getURL('editor.html');
  if (name.startsWith(UI_PREFIX) && sender.frameId !== 0 && String(sender.url || '').startsWith(editorUrl)) {
    return { role: 'ui', id: name.slice(UI_PREFIX.length), tabId };
  }
  return null;
}

browser.runtime.onConnect.addListener((port) => {
  const peer = editorSenderRole(port);
  if (!peer || !/^[a-f0-9-]{16,64}$/.test(peer.id)) {
    try { port.disconnect(); } catch (_) { /* already gone */ }
    return;
  }
  const key = peer.tabId + ':' + peer.id;
  const pair = editorPairs.get(key) || { core: null, ui: null, corePending: [], uiPending: [] };
  if (pair[peer.role]) {
    try { pair[peer.role].disconnect(); } catch (_) { /* already gone */ }
  }
  pair[peer.role] = port;
  editorPairs.set(key, pair);

  const waiting = pair[peer.role === 'core' ? 'uiPending' : 'corePending'];
  while (waiting.length) {
    try { port.postMessage(waiting.shift()); } catch (_) { break; }
  }

  port.onMessage.addListener((msg) => {
    if (!validEditorMessage(peer.role, msg)) return;
    const current = editorPairs.get(key);
    const other = current && current[peer.role === 'core' ? 'ui' : 'core'];
    if (other) {
      try { other.postMessage(msg); } catch (_) { /* peer disconnected */ }
    } else {
      const pending = current && current[peer.role + 'Pending'];
      if (pending) {
        pending.push(msg);
        if (pending.length > 8) pending.shift();
      }
    }
  });
  port.onDisconnect.addListener(() => {
    const current = editorPairs.get(key);
    if (!current || current[peer.role] !== port) return;
    current[peer.role] = null;
    if (!current.core && !current.ui) editorPairs.delete(key);
  });
});
