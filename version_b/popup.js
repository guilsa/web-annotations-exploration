(() => {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const status = document.querySelector('#status');

  const fail = (message) => {
    status.textContent = message;
    status.className = 'error';
  };

  async function send(message) {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error('No active tab.');
    try {
      const response = await api.tabs.sendMessage(tab.id, message);
      if (!response || !response.ok) throw new Error('Pairshare is not available on this page.');
    } catch (_) {
      throw new Error('Open a regular webpage to use Pairshare.');
    }
  }

  document.querySelector('[data-action="comments"]').addEventListener('click', async () => {
    try { await send({ type: 'tmb:open-sidebar' }); window.close(); }
    catch (err) { fail(err.message); }
  });

  document.querySelector('[data-action="pair"]').addEventListener('click', async () => {
    try { await send({ type: 'tmb:toggle-panel' }); window.close(); }
    catch (err) { fail(err.message); }
  });

  document.querySelector('#backup').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('The backup is larger than 10 MB.');
      await send({ type: 'tmb:import-data', text: await file.text() });
      window.close();
    } catch (err) {
      fail(err.message);
      event.target.value = '';
    }
  });
})();
