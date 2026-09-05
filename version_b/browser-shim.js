/* Compatibility shim (content scripts).
 * Firefox provides a `browser` global; Chromium provides `chrome`.
 * In Firefox this is a no-op.
 */
if (typeof window !== 'undefined' && typeof window.browser === 'undefined' && typeof chrome !== 'undefined') {
  window.browser = chrome;
}
