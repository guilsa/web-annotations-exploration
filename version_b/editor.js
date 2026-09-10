/* Extension-origin text editor. Keyboard events stay in this browsing context. */
(() => {
  'use strict';

  const id = location.hash.slice(1);
  if (!/^[a-f0-9-]{16,64}$/.test(id)) return;
  const textarea = document.querySelector('textarea');
  const api = globalThis.browser || globalThis.chrome;
  const port = api.runtime.connect({ name: 'tmb-editor-ui:' + id });
  let version = -1;
  let seq = 0;

  const post = (message) => {
    try { port.postMessage(message); } catch (_) { /* frame is tearing down */ }
  };
  const selection = () => ({
    selectionStart: textarea.selectionStart || 0,
    selectionEnd: textarea.selectionEnd || 0,
  });
  const applyState = (msg) => {
    if (!Number.isSafeInteger(msg.version) || msg.version < version || typeof msg.value !== 'string') return;
    version = msg.version;
    seq = 0;
    textarea.value = msg.value;
    if (typeof msg.placeholder === 'string') textarea.placeholder = msg.placeholder;
    if (typeof msg.readOnly === 'boolean') textarea.readOnly = msg.readOnly;
    if (Number.isSafeInteger(msg.maxLength) && msg.maxLength > 0) textarea.maxLength = msg.maxLength;
    textarea.classList.toggle('code', msg.kind === 'code');
    const start = Number.isSafeInteger(msg.selectionStart) ? msg.selectionStart : textarea.value.length;
    const end = Number.isSafeInteger(msg.selectionEnd) ? msg.selectionEnd : start;
    try { textarea.setSelectionRange(start, end); } catch (_) { /* read-only/unsupported */ }
    textarea.disabled = false;
    textarea.setAttribute('data-tmb-ready', '');
  };

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init' || msg.type === 'set-state') applyState(msg);
    else if (msg.type === 'focus') textarea.focus();
    else if (msg.type === 'get-state' && Number.isSafeInteger(msg.requestId)) {
      post(Object.assign({
        type: 'state', requestId: msg.requestId, version, value: textarea.value,
      }, selection()));
    }
  });

  textarea.addEventListener('input', () => {
    post(Object.assign({ type: 'input', version, seq: ++seq, value: textarea.value }, selection()));
  });
  textarea.addEventListener('select', () => {
    post(Object.assign({ type: 'selection', version }, selection()));
  });
  textarea.addEventListener('keyup', () => {
    post(Object.assign({ type: 'selection', version }, selection()));
  });
  textarea.addEventListener('focus', () => post({ type: 'focus' }));
  textarea.addEventListener('blur', () => post({ type: 'blur' }));
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      // This is Pairshare's deliberate submit chord, not ordinary text entry.
      event.preventDefault();
      post({ type: 'action', action: 'submit' });
    } else if (event.key === 'Escape') {
      post({ type: 'action', action: 'escape' });
    }
  });
  for (const [selector, action] of [['.before', 'tab-prev'], ['.after', 'tab-next']]) {
    document.querySelector(selector).addEventListener('keyup', (event) => {
      if (event.key === 'Tab') post({ type: 'action', action });
    });
  }

  post({ type: 'ready' });
})();
