/* Textmarker A — Linkshare (content script, single file).
 *
 * Highlights text on any page, attaches comments, persists them per-URL in
 * browser.storage.local, and restores them on revisit. Sharing is done by
 * embedding the whole comment set into the page URL as base64 JSON
 * (#...&tmc=<data>) — no server, no account, works offline.
 *
 * Pure helpers (no DOM) are exposed on globalThis.__TMA_PURE for unit tests.
 */
(() => {
  'use strict';

  /* ================================================================
   * PURE HELPERS (unit-tested in ../../tests/)
   * ================================================================ */

  const squeeze = (s) => (typeof s === 'string' ? s.replace(/\s+/g, '') : '');

  /** Map squeezed string back to raw offsets. */
  function squeezeMap(text) {
    const out = [];
    const map = new Array(text.length);
    let j = 0;
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i])) {
        out.push(text[i]);
        map[j++] = i;
      }
    }
    return { text: out.join(''), map: map.slice(0, j) };
  }

  /**
   * Given the current full page text and a saved mark, find its raw
   * [start, end) offsets. Tries, in order:
   *   1. exact raw match at the saved offset
   *   2. whitespace-insensitive match at the saved offset
   *   3. whitespace-insensitive search of the whole text, scoring each
   *      candidate by saved context (pre/post) + distance from saved offset
   */
  function findOffsets(text, mark, opts) {
    opts = opts || {};
    const window = typeof opts.window === 'number' ? opts.window : 5000;
    const quote = mark.quote;
    if (!quote) return null;
    const target = typeof mark.offset === 'number' ? mark.offset : 0;

    if (text.slice(target, target + quote.length) === quote) {
      return [target, target + quote.length];
    }
    const sq = squeeze(quote);
    if (sq.length < 3) return null; // too ambiguous to relocate
    if (squeeze(text.slice(target, target + quote.length)) === sq) {
      // Whitespace-insensitive match at the saved offset: the raw end is the
      // position of the quote's last non-space char, not target + quote.length.
      const { map: smap } = squeezeMap(text.slice(target, target + quote.length));
      return [target, target + smap[sq.length - 1] + 1];
    }

    const { text: stext, map } = squeezeMap(text);
    if (sq.length > stext.length) return null;

    const pre = squeeze(mark.pre || '').slice(-20);
    const post = squeeze(mark.post || '').slice(0, 20);
    const hasCtx = !!(pre || post);
    const lo = Math.max(0, target - window);
    const hi = Math.min(text.length, target + window);

    const cands = [];
    for (let bi = stext.indexOf(sq); bi !== -1; bi = stext.indexOf(sq, bi + 1)) {
      const rawS = map[bi];
      const rawE = map[bi + sq.length - 1] + 1;
      cands.push({ rawS, rawE, bi });
      if (cands.length > 500) break;
    }
    if (!cands.length) return null;
    // Squeezed search starts at the first non-space char; re-attach any
    // leading whitespace the saved quote had.
    const finish = (c) => {
      const lead = (quote.match(/^\s+/) || [''])[0].length;
      let rs = c.rawS;
      let g = lead;
      while (g-- > 0 && rs > 0 && /\s/.test(text[rs - 1])) rs--;
      return [rs, c.rawE];
    };
    if (cands.length === 1) return finish(cands[0]);

    const ctxOk = (bi) => {
      const before = squeeze(stext.slice(Math.max(0, bi - 40), bi));
      const after = squeeze(stext.slice(bi + sq.length, bi + sq.length + 40));
      return (!pre || before.endsWith(pre)) && (!post || after.startsWith(post));
    };
    const inWindow = (c) => c.rawS >= lo && c.rawS <= hi;
    const dist = (c) => Math.abs((c.rawS + c.rawE) / 2 - (target + sq.length / 2));
    const closest = (filter) => {
      let best = null;
      let bestScore = Infinity;
      for (const c of cands) {
        if (!filter(c)) continue;
        const s = dist(c);
        if (s < bestScore) { bestScore = s; best = c; }
      }
      return best;
    };

    // Tier A: saved context matches inside the window.
    if (hasCtx) {
      const c = closest((x) => ctxOk(x.bi) && inWindow(x));
      if (c) return finish(c);
      // Tier C: context matches, but outside the window (big insertion/deletion).
      const c2 = closest((x) => ctxOk(x.bi));
      if (c2) return finish(c2);
    }
    // Tier B: long quotes disambiguate themselves — closest in window.
    if (sq.length >= 20) {
      const c = closest(inWindow);
      if (c) return finish(c);
    }
    return null;
  }

  /** UTF-8 safe base64. */
  const b64enc = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const b64dec = (s) => {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  /** Build the share URL. `hashless` has no fragment; `frag` is the existing
   *  fragment (including its leading '#') or ''. */
  function composeShareUrl(hashless, frag, data) {
    const tmc = 'tmc=' + b64enc(JSON.stringify(data));
    if (!frag) return hashless + '#' + tmc;
    if (/tmc=/.test(frag)) {
      const u = new URL(hashless + frag);
      u.hash = u.hash.replace(/tmc=[^&]*/, tmc);
      return u.toString();
    }
    return hashless + frag + '&' + tmc;
  }

  /** Extract shared data from a URL fragment ('#...'). Returns null if none. */
  function extractShareData(frag) {
    if (!frag) return null;
    const m = String(frag).match(/tmc=([A-Za-z0-9+/=]+)/);
    if (!m) return null;
    try {
      const data = JSON.parse(b64dec(m[1]));
      if (data && data.v === 1 && Array.isArray(data.marks)) return data;
    } catch (_) {
      /* fall through */
    }
    return null;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__TMA_PURE = {
      squeeze,
      squeezeMap,
      findOffsets,
      b64enc,
      b64dec,
      composeShareUrl,
      extractShareData,
    };
  }

  /* ================================================================
   * RUNTIME (browser only)
   * ================================================================ */
  if (typeof window === 'undefined' || window.__TMA_LOADED__) return;
  window.__TMA_LOADED__ = true;

  const SKIP = 'data-tma-skip';
  const ID_ATTR = 'data-tma-id';
  const STORE_KEY = 'tma.pages';
  const HL_CLASS = 'tma-hl';
  const SHARED_CLASS = 'tma-hl--shared';
  const OWN_BG = '#ffe58a';
  const SHARED_BG = '#e9d5ff';

  const state = {
    marks: [],      // own marks for this page
    shared: null,   // shared payload from URL, or null
    idx: null,      // last text index {text, nodes}
    failed: [],     // own marks that could not be restored
    sharedFailed: [], // shared marks that could not be restored yet
    retry: 0,
    maxRetries: 6,
    bannerDismissed: false,
    lastShareUrl: null, // set by doShare (also readable from the page for tests)
    doc: document,
  };

  /* ---------------- text index & matching ---------------- */

  function buildIndex() {
    const doc = state.doc;
    const nodes = [];
    let text = '';
    if (!doc.body) return { text, nodes };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.data.length) return NodeFilter.FILTER_REJECT;
        let el = n.parentElement;
        while (el) {
          if (el.hasAttribute && el.hasAttribute(SKIP)) return NodeFilter.FILTER_REJECT;
          const tag = el.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
            return NodeFilter.FILTER_REJECT;
          }
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: text.length, len: n.data.length });
      text += n.data;
    }
    return { text, nodes };
  }

  function nodeAt(nodes, off) {
    let lo = 0, hi = nodes.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].start <= off) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans >= 0 ? nodes[ans] : null;
  }

  function rawToRange(s, e) {
    const idx = state.idx;
    if (!idx || e <= s) return null;
    const a = nodeAt(idx.nodes, s);
    const b = nodeAt(idx.nodes, e);
    if (!a || !b) return null;
    const range = state.doc.createRange();
    try {
      range.setStart(a.node, s - a.start);
      range.setEnd(b.node, e - b.start);
    } catch (_) {
      return null;
    }
    return range;
  }

  function locate(mark) {
    const off = findOffsets(state.idx ? state.idx.text : '', mark);
    if (!off) return null;
    return rawToRange(off[0], off[1]);
  }

  /* ---------------- DOM mark ops ---------------- */

  function firstText(node) {
    const doc = node.ownerDocument || state.doc;
    if (node.nodeType === Node.TEXT_NODE) return node;
    const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) if (t.data.length) return t;
    return null;
  }
  function lastText(node) {
    const doc = node.ownerDocument || state.doc;
    if (node.nodeType === Node.TEXT_NODE) return node;
    const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let t, last = null;
    while ((t = w.nextNode())) if (t.data.length) last = t;
    return last;
  }
  function resolvePoint(node, offset) {
    if (node.nodeType === Node.TEXT_NODE) return [node, offset];
    if (offset <= 0) {
      const t = firstText(node);
      return t ? [t, 0] : null;
    }
    if (offset >= node.childNodes.length) {
      const t = lastText(node);
      return t ? [t, t.data.length] : null;
    }
    const t = lastText(node.childNodes[offset - 1]);
    return t ? [t, t.data.length] : null;
  }

  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I',
    'IMG', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB',
    'SUP', 'TIME', 'U', 'VAR', 'WBR',
  ]);

  /**
   * Wrap the range in highlight spans. Only ever splits TEXT nodes (never
   * elements), so partially-covered inline elements are handled correctly:
   * the text inside them is split and the middle slice wrapped, while the
   * element itself stays in place. One wrapper per parent is produced.
   */
  function wrapRange(range, id, shared) {
    const doc = state.doc;
    // Resolve element endpoints to text endpoints so the rest is simple.
    let sc = range.startContainer, so = range.startOffset;
    let ec = range.endContainer, eo = range.endOffset;
    if (sc.nodeType !== Node.TEXT_NODE) {
      const p = resolvePoint(sc, so);
      if (!p) return [];
      sc = p[0]; so = p[1];
    }
    if (ec.nodeType !== Node.TEXT_NODE) {
      const p = resolvePoint(ec, eo);
      if (!p) return [];
      ec = p[0]; eo = p[1];
    }
    if (sc === ec && so >= eo) return [];
    const r = doc.createRange();
    r.setStart(sc, so);
    r.setEnd(ec, eo);

    // Plan all (node, start, end) slices BEFORE mutating the DOM.
    const plan = [];
    if (r.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
      // Range lies inside a single text node.
      plan.push([r.commonAncestorContainer, r.startOffset, r.endOffset]);
    } else {
      const walker = doc.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = walker.nextNode())) {
        if (!r.intersectsNode(tn)) continue;
        let s = 0;
        let e = tn.data.length;
        if (tn === r.startContainer) s = r.startOffset;
        if (tn === r.endContainer) e = r.endOffset;
        if (s < e) plan.push([tn, s, e]);
      }
    }
    if (!plan.length) return [];
    const makeWrapper = () => {
      const w = doc.createElement('span');
      w.className = shared ? HL_CLASS + ' ' + SHARED_CLASS : HL_CLASS;
      w.setAttribute(ID_ATTR, id);
      return w;
    };
    const wrappers = [];
    for (const [tn, s, e] of plan) {
      let mid = tn;
      if (s > 0) mid = tn.splitText(s);
      const selectedLength = e - s;
      if (selectedLength < mid.data.length) mid.splitText(selectedLength);
      const last = wrappers[wrappers.length - 1];
      let w;
      if (last && last.parentNode === mid.parentNode && last.nextSibling === mid) {
        w = last; // extend the previous wrapper over adjacent content
      } else {
        w = makeWrapper();
        mid.parentNode.insertBefore(w, mid);
        wrappers.push(w);
      }
      w.appendChild(mid);
    }
    return wrappers;
  }

  function unwrapAll(id) {
    const doc = state.doc;
    const els = Array.from(doc.querySelectorAll('[' + ID_ATTR + '="' + id + '"]'));
    for (const el of els) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    }
  }

  function clearHighlights() {
    const doc = state.doc;
    const ids = new Set();
    for (const el of Array.from(doc.querySelectorAll('[' + ID_ATTR + ']'))) {
      ids.add(el.getAttribute(ID_ATTR));
    }
    for (const id of ids) unwrapAll(id);
  }

  /* ---------------- storage ---------------- */

  function pageKey() {
    try {
      const u = new URL(location.href);
      u.hash = '';
      let s = u.toString();
      if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
      return s;
    } catch (_) {
      return location.href;
    }
  }

  async function loadPage() {
    const data = await browser.storage.local.get(STORE_KEY);
    const pages = data[STORE_KEY] || {};
    const page = pages[pageKey()];
    return page && Array.isArray(page.marks) ? page.marks : [];
  }

  async function savePage() {
    const data = await browser.storage.local.get(STORE_KEY);
    const pages = data[STORE_KEY] || {};
    if (state.marks.length) pages[pageKey()] = { marks: state.marks, updated: Date.now() };
    else delete pages[pageKey()];
    await browser.storage.local.set({ [STORE_KEY]: pages });
  }

  /* ---------------- shadow-DOM UI helpers ---------------- */

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .pill {
      position: fixed; z-index: 2147483647; display: none;
      background: #1f2937; color: #f9fafb; border-radius: 999px;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); padding: 4px 6px;
      font-size: 13px; line-height: 1; align-items: center; gap: 4px;
    }
    .pill button {
      border: 0; background: #f6b93b; color: #1f2937; font-weight: 600;
      border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 13px;
    }
    .pill button:hover { filter: brightness(1.05); }
    .card, .editor, .panel, .banner, .toast {
      position: fixed; z-index: 2147483647; display: none;
      background: #ffffff; color: #111827; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.28); font-size: 13px;
    }
    .card { max-width: 320px; padding: 10px 12px; }
    .card .q { color: #6b7280; font-size: 12px; margin: 0 0 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; }
    .card .note { margin: 0 0 6px; white-space: pre-wrap; }
    .card .meta { color: #6b7280; font-size: 11px; }
    .card .row, .panel .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
    .card button, .panel button, .banner button {
      border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
    }
    .card button.primary, .panel button.primary, .banner button.primary {
      background: #f6b93b; border-color: #f6b93b; font-weight: 600;
    }
    .card button.danger:hover { background: #fee2e2; border-color: #fca5a5; }
    .editor { width: 340px; padding: 10px 12px; }
    .editor h4 { margin: 0 0 6px; font-size: 12px; color: #6b7280; font-weight: 600; }
    .editor textarea {
      width: 100%; min-height: 72px; resize: vertical; padding: 8px;
      border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px;
      font-family: inherit;
    }
    .panel { right: 16px; bottom: 16px; width: 300px; padding: 12px 14px; }
    .panel h3 { margin: 0 0 4px; font-size: 14px; }
    .panel .sub { color: #6b7280; font-size: 12px; margin: 0 0 4px; }
    .panel .status { color: #2563eb; font-size: 12px; min-height: 16px; margin-top: 6px; }
    .banner {
      top: 0; left: 0; right: 0; padding: 8px 16px;
      background: #f5f3ff; border-bottom: 1px solid #ddd6fe;
      display: none; align-items: center; gap: 10px; font-size: 13px;
      border-radius: 0;
    }
    .banner.show { display: flex; }
    .banner .grow { flex: 1; }
    .toast {
      left: 50%; bottom: 24px; transform: translateX(-50%);
      background: #111827; color: #f9fafb; padding: 8px 16px;
      border-radius: 999px; font-size: 13px;
    }
  `;

  const hosts = {};
  /** True if the event's (retargeted) target is inside the named shadow host. */
  function insideHost(name, e) {
    const div = hosts[name];
    return !!div && (e.target === div || div.contains(e.target));
  }
  function host(name) {
    if (hosts[name]) return hosts[name].shadowRoot;
    const doc = state.doc;
    const div = doc.createElement('div');
    div.id = 'tma-' + name;
    div.setAttribute(SKIP, '');
    div.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const root = div.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = UI_CSS;
    root.appendChild(style);
    (doc.body || doc.documentElement).appendChild(div);
    hosts[name] = div;
    return root;
  }
  function h(root, tag, cls, text) {
    const el = root.ownerDocument.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  };

  let toastTimer = null;
  function toast(msg) {
    const root = host('toast');
    let el = root.querySelector('.toast');
    if (!el) {
      el = h(root, 'div', 'toast', '');
      root.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = state.doc.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        ta.setAttribute(SKIP, '');
        state.doc.body.appendChild(ta);
        ta.select();
        const ok = state.doc.execCommand('copy');
        ta.remove();
        return ok;
      } catch (__) {
        return false;
      }
    }
  }

  /* ---------------- pill (selection action) ---------------- */

  function buildPill() {
    const root = host('pill');
    const pill = h(root, 'div', 'pill');
    const btn = h(root, 'button', null, '💬 Comment');
    pill.appendChild(btn);
    root.appendChild(pill);
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
    btn.addEventListener('click', () => {
      hidePill();
      createMarkFromSelection();
    });
    state.doc.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !insideHost('pill', e)) hidePill();
    });
  }
  function hidePill() {
    const el = host('pill').querySelector('.pill');
    if (el) el.style.display = 'none';
  }
  function updatePill() {
    const sel = state.doc.defaultView.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hidePill();
    const range = sel.getRangeAt(0);
    if (!state.doc.body || !state.doc.body.contains(range.commonAncestorContainer)) {
      return hidePill();
    }
    if (range.toString().trim().length === 0) return hidePill();
    const rect = range.getBoundingClientRect();
    const root = host('pill');
    const pill = root.querySelector('.pill');
    pill.style.display = 'flex';
    pill.style.left = Math.max(4, rect.left + rect.width / 2 - 60) + 'px';
    pill.style.top = Math.min(rect.bottom + 6, window.innerHeight - 40) + 'px';
  }

  /* ---------------- mark creation ---------------- */

  function nodeOffsetInIdx(idx, node, off) {
    for (let i = 0; i < idx.nodes.length; i++) {
      if (idx.nodes[i].node === node) return idx.nodes[i].start + off;
    }
    return -1;
  }

  function createMarkFromSelection() {
    if (!state.marks) return; // not booted yet
    const sel = state.doc.defaultView.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0).cloneRange();
    const sp = resolvePoint(range.startContainer, range.startOffset);
    const ep = resolvePoint(range.endContainer, range.endOffset);
    if (!sp || !ep) return;
    const idx = state.idx = buildIndex();
    const s = nodeOffsetInIdx(idx, sp[0], sp[1]);
    const e = nodeOffsetInIdx(idx, ep[0], ep[1]);
    if (s < 0 || e < 0 || s >= e) return;
    const quote = idx.text.slice(s, e);
    if (!quote.trim()) return;
    if (quote.length > 5000) {
      toast('Selection too long to mark (max 5000 chars)');
      return;
    }
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mark = {
      id,
      quote,
      pre: idx.text.slice(Math.max(0, s - 40), s),
      post: idx.text.slice(e, e + 40),
      offset: s,
      note: '',
      author: 'me',
      ts: Date.now(),
    };
    const r = rawToRange(s, e);
    if (!r) return;
    const wrappers = wrapRange(r, id, false);
    if (!wrappers.length) return;
    state.marks.push(mark);
    sel.removeAllRanges();
    savePage(); // persist immediately; the note can still be edited via the box
    openEditor(mark, wrappers[0]);
  }

  /* ---------------- editor (comment popover) ---------------- */

  function openEditor(mark, anchorEl) {
    if (state.editor) state.editor.open(mark, anchorEl);
  }

  function buildEditor() {
    const root = host('editor');
    const box = h(root, 'div', 'editor');
    const title = h(root, 'h4', null, 'Comment on highlighted text');
    const ta = h(root, 'textarea');
    ta.placeholder = 'Write a comment… (leave empty for a plain highlight)';
    ta.maxLength = 5000;
    const row = h(root, 'div', 'row');
    const save = h(root, 'button', 'primary', 'Save');
    const del = h(root, 'button', 'danger', 'Delete');
    const cancel = h(root, 'button', null, 'Cancel');
    row.appendChild(save);
    row.appendChild(del);
    row.appendChild(cancel);
    box.appendChild(title);
    box.appendChild(ta);
    box.appendChild(row);
    root.appendChild(box);

    let current = null;
    state.editor = {
      open(mark, anchorEl) {
        current = mark;
        ta.value = mark.note || '';
        del.style.display = mark.author === 'me' ? '' : 'none';
        box.style.display = 'block';
        positionEditor(anchorEl);
        ta.focus();
        ta.select();
      },
      close() {
        current = null;
        box.style.display = 'none';
      },
      current: () => current,
    };

    const doSave = async () => {
      const mark = current;
      if (!mark) return;
      const note = ta.value;
      // `state.marks` may have been replaced wholesale by the storage.onChanged
      // listener (which reloads a fresh, structurally-cloned array from storage
      // ~300ms after our own create-time save). The object the editor holds
      // (`mark`) can then be a stale reference no longer present in
      // `state.marks`, so writing `mark.note` would be silently dropped by the
      // next savePage(). Write the note onto the live entry found by id; if it
      // was removed while we were editing, re-add the mark so the just-typed
      // note is not lost.
      const live = state.marks.find((m) => m.id === mark.id);
      if (live) { live.note = note; live.ts = Date.now(); }
      else { mark.note = note; mark.ts = Date.now(); state.marks.push(mark); }
      state.editor.close(); // close() nulls the shared `current` — keep a local ref
      await savePage();
      flash(mark.id);
    };
    const doDelete = async () => {
      const mark = current;
      if (!mark) return;
      state.editor.close();
      state.marks = state.marks.filter((m) => m.id !== mark.id);
      unwrapAll(mark.id);
      await savePage();
      updatePanel();
    };
    save.addEventListener('click', doSave);
    del.addEventListener('click', doDelete);
    cancel.addEventListener('click', () => state.editor.close());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSave();
      if (e.key === 'Escape') state.editor.close();
    });
    state.doc.addEventListener('mousedown', (e) => {
      const el = host('editor').querySelector('.editor');
      // e.target is retargeted to the shadow host for events inside the shadow
      if (el && el.style.display === 'block' && !insideHost('editor', e) && !isHighlight(e.target)) {
        state.editor.close();
      }
    });
    state.doc.defaultView.addEventListener('scroll', () => state.editor.close(), true);
  }
  function positionEditor(anchorEl) {
    const box = host('editor').querySelector('.editor');
    let rect = null;
    if (anchorEl && anchorEl.getBoundingClientRect) rect = anchorEl.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      box.style.left = '16px';
      box.style.top = '16px';
      return;
    }
    const w = 340, hgt = box.offsetHeight || 180;
    // Prefer below the anchor, else above — then clamp into the viewport
    // (the anchor may be far off-screen on long pages).
    let top = rect.bottom + 8;
    if (top + hgt > window.innerHeight - 8) top = rect.top - hgt - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }
  function isHighlight(target) {
    let el = target;
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      if (el.hasAttribute && el.hasAttribute(ID_ATTR)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function flash(id) {
    const els = state.doc.querySelectorAll('[' + ID_ATTR + '="' + id + '"]');
    for (const el of els) {
      el.classList.add('tma-flash');
      setTimeout(() => el.classList.remove('tma-flash'), 1200);
    }
  }

  /* ---------------- hover card ---------------- */

  function buildCard() {
    const root = host('card');
    const box = h(root, 'div', 'card');
    const q = h(root, 'p', 'q');
    const note = h(root, 'p', 'note');
    const meta = h(root, 'div', 'meta');
    const row = h(root, 'div', 'row');
    const edit = h(root, 'button', 'primary', 'Edit');
    const imp = h(root, 'button', 'primary', 'Import to my page');
    const close = h(root, 'button', null, 'Close');
    row.appendChild(edit);
    row.appendChild(imp);
    row.appendChild(close);
    box.appendChild(q);
    box.appendChild(note);
    box.appendChild(meta);
    box.appendChild(row);
    root.appendChild(box);

    let hoverTimer = null;
    let pinned = false;
    let current = null;

    const show = (mark, shared, anchorEl) => {
      current = { mark, shared };
      q.textContent = '“' + mark.quote.slice(0, 120) + (mark.quote.length > 120 ? '…' : '') + '”';
      note.textContent = mark.note ? mark.note : '(no comment)';
      note.style.display = mark.note ? '' : 'none';
      meta.textContent = (shared ? 'shared by ' : '') + mark.author + ' · ' + fmtTime(mark.ts);
      edit.style.display = shared ? 'none' : '';
      imp.style.display = shared ? '' : 'none';
      box.style.display = 'block';
      positionCard(anchorEl);
    };
    const hide = () => {
      if (pinned) return;
      box.style.display = 'none';
      current = null;
    };
    // Unpin and hide in one step. `hide()` alone is a no-op while the card is
    // pinned (clicking a highlight pins it), so action buttons that should
    // dismiss the card must unpinned first — otherwise the card stays on top
    // of whatever they open next (the editor opens behind it because the
    // card's shadow host is appended after the editor's in the light DOM and
    // they share the same z-index).
    const dismiss = () => { pinned = false; hide(); };

    state.card = { show, hide, pinned: () => pinned };

    edit.addEventListener('click', () => {
      const cur = current; // dismiss() nulls `current` — capture first
      if (!cur) return;
      dismiss();
      const mark = cur.mark;
      const el = state.doc.querySelector('[' + ID_ATTR + '="' + mark.id + '"]');
      openEditor(mark, el);
    });
    imp.addEventListener('click', async () => {
      if (!current) return;
      const mark = current.mark;
      const mine = await importSharedMark(mark);
      if (state.shared) {
        state.shared.marks = state.shared.marks.filter((x) => x.id !== mark.id);
        if (!state.shared.marks.length) state.shared = null;
      }
      unwrapAll('s:' + mark.id);
      state.idx = buildIndex();
      const r = locate(mine);
      if (r) wrapRange(r, mine.id, false);
      state.banner.update();
      updatePanel();
      dismiss();
    });
    close.addEventListener('click', dismiss);

    // Clicking outside (not on a highlight, not inside the card) unpins.
    state.doc.addEventListener('mousedown', (e) => {
      const box2 = host('card').querySelector('.card');
      if (box2.style.display === 'block' && !insideHost('card', e) && !isHighlight(e.target)) {
        pinned = false;
        box2.style.display = 'none';
        current = null;
      }
    });

    const onOver = (e) => {
      const el = e.target;
      if (!el || !el.closest) return;
      const hl = el.closest ? el.closest('[' + ID_ATTR + ']') : null;
      if (!hl) return;
      const id = hl.getAttribute(ID_ATTR);
      const shared = id.startsWith('s:');
      const localId = shared ? id.slice(2) : id;
      const mark = shared
        ? (state.shared ? state.shared.marks.find((m) => m.id === localId) : null)
        : state.marks.find((m) => m.id === localId);
      if (!mark) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => show(mark, shared, hl), 220);
    };
    const onOut = (e) => {
      const el = e.target;
      if (el && el.closest && el.closest('[' + ID_ATTR + ']')) {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(hide, 180);
      }
    };
    const onClick = (e) => {
      const el = e.target;
      if (!el || !el.closest) return;
      const hl = el.closest('[' + ID_ATTR + ']');
      if (!hl) return;
      e.preventDefault();
      e.stopPropagation();
      pinned = true;
      const id = hl.getAttribute(ID_ATTR);
      const shared = id.startsWith('s:');
      const localId = shared ? id.slice(2) : id;
      const mark = shared
        ? (state.shared ? state.shared.marks.find((m) => m.id === localId) : null)
        : state.marks.find((m) => m.id === localId);
      if (mark) show(mark, shared, hl);
    };
    state.doc.addEventListener('mouseover', onOver);
    state.doc.addEventListener('mouseout', onOut);
    state.doc.addEventListener('click', onClick, true);
  }
  function positionCard(anchorEl) {
    const box = host('card').querySelector('.card');
    if (!anchorEl || !anchorEl.getBoundingClientRect) return;
    const rect = anchorEl.getBoundingClientRect();
    const w = box.offsetWidth || 300;
    const hgt = box.offsetHeight || 120;
    let top = rect.bottom + 8;
    if (top + hgt > window.innerHeight - 8) top = rect.top - hgt - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  /* ---------------- shared layer ---------------- */

  function renderShared() {
    state.sharedFailed = [];
    if (!state.shared) return;
    for (const m of state.shared.marks) {
      if (!wrapOne(m, 's:')) state.sharedFailed.push(m);
    }
    state.idx = buildIndex();
  }

  function buildBanner() {
    const root = host('banner');
    /* banner host uses the shared UI css */
    const bar = h(root, 'div', 'banner');
    const label = h(root, 'span');
    label.style.cssText = 'flex:1;';
    const imp = h(root, 'button', 'primary', 'Import all');
    const dis = h(root, 'button', null, 'Dismiss');
    bar.appendChild(label);
    bar.appendChild(imp);
    bar.appendChild(dis);
    root.appendChild(bar);

    imp.addEventListener('click', async () => {
      if (!state.shared) return;
      let n = 0;
      for (const m of state.shared.marks) {
        if (await importSharedMark(m)) n++;
      }
      state.shared = null;
      // Clean the tmc= fragment so the shared layer doesn't reappear on reload.
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch (_) { /* ignore */ }
      refreshHighlights();
      toast(n + ' shared comment(s) imported to your page');
    });
    dis.addEventListener('click', () => {
      state.bannerDismissed = true;
      state.banner.update();
    });

    state.banner = {
      update() {
        if (!state.shared || state.bannerDismissed) {
          bar.classList.remove('show');
          return;
        }
        const total = state.shared.marks.length;
        const ok = total - state.sharedFailed.length;
        label.textContent = '📬 ' + ok + ' of ' + total +
          ' shared comments from ' + (state.shared.author || 'a friend') +
          (state.shared.title ? ' on “' + state.shared.title + '”' : '');
        imp.textContent = 'Import all (' + total + ')';
        bar.classList.add('show');
      },
    };
  }

  async function importSharedMark(m) {
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mark = {
      id,
      quote: m.quote,
      pre: m.pre || '',
      post: m.post || '',
      offset: m.offset || 0,
      note: m.note || '',
      author: m.author || 'shared',
      ts: m.ts || Date.now(),
      src: m.id,
    };
    state.marks.push(mark);
    await savePage();
    return mark;
  }

  function refreshHighlights() {
    clearHighlights();
    state.idx = buildIndex();
    restoreOwn(); // wraps found marks, fills state.failed
    renderShared(); // also resets state.sharedFailed
    state.banner.update();
    updatePanel();
  }

  /* ---------------- panel (share bar) ---------------- */

  function buildPanel() {
    const root = host('panel');
    const box = h(root, 'div', 'panel');
    const title = h(root, 'h3', null, 'Textmarker A');
    const sub = h(root, 'p', 'sub');
    const row = h(root, 'div', 'row');
    const share = h(root, 'button', 'primary', '📤 Copy share link');
    const resync = h(root, 'button', null, 'Re-sync');
    const clear = h(root, 'button', 'danger', 'Clear page');
    row.appendChild(share);
    row.appendChild(resync);
    row.appendChild(clear);
    const status = h(root, 'div', 'status');
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(row);
    box.appendChild(status);
    root.appendChild(box);

    share.addEventListener('click', async () => {
      const ok = await doShare();
      status.textContent = ok ? 'Link copied — send it to anyone.' : 'Copy failed — see console.';
    });
    resync.addEventListener('click', () => {
      refreshHighlights();
      status.textContent = 'Re-synced.';
    });
    clear.addEventListener('click', async () => {
      state.marks = [];
      await savePage();
      refreshHighlights();
      status.textContent = 'All comments for this page removed.';
    });

    state.panel = {
      el: box,
      toggle() {
        const showing = box.style.display === 'block';
        box.style.display = showing ? 'none' : 'block';
        if (!showing) updatePanel();
      },
      hide() { box.style.display = 'none'; },
    };
  }

  function updatePanel() {
    if (!state.panel) return;
    const sub = state.panel.el.querySelector('.sub');
    const failed = state.failed.length;
    sub.textContent = state.marks.length + ' comment(s) on this page' +
      (failed ? ' · ' + failed + ' could not be re-found' : '') +
      (state.shared ? ' · ' + state.shared.marks.length + ' shared' : '');
  }

  /* ---------------- sharing ---------------- */

  function shareData() {
    return {
      v: 1,
      url: pageKey(),
      title: state.doc.title,
      author: 'me',
      ts: Date.now(),
      marks: state.marks,
    };
  }

  function buildShareUrl() {
    return composeShareUrl(pageKey(), location.hash, shareData());
  }

  async function doShare() {
    if (!state.marks) return false;
    const url = buildShareUrl();
    state.lastShareUrl = url;
    try {
      // Test hook: attributes are visible across worlds (JS globals are not).
      state.doc.documentElement.setAttribute('data-tma-last-share', url);
    } catch (_) { /* ignore */ }
    const ok = await copyText(url);
    if (ok) toast('Share link copied');
    return ok;
  }

  /* ---------------- restoration ---------------- */

  // Wrap a single mark from a FRESH index. Wrapping earlier marks splits text
  // nodes via splitText(), which truncates the .data of the node objects an
  // older state.idx still references — so locate()/rawToRange() on a stale idx
  // throws IndexSizeError and the mark silently fails to render. Rebuilding
  // the index per mark is safe (highlight spans add no text, so raw page-text
  // offsets stay identical) and only O(n) total across a page's few marks.
  function wrapOne(m, prefix) {
    state.idx = buildIndex();
    const r = locate(m);
    if (!r) return false;
    wrapRange(r, prefix ? prefix + m.id : m.id, !!prefix);
    return true;
  }

  function restoreOwn() {
    state.failed = [];
    for (const m of state.marks) {
      if (!wrapOne(m)) state.failed.push(m);
    }
    state.idx = buildIndex();
  }

  async function initRestore() {
    state.marks = await loadPage();
    state.shared = extractShareData(location.hash);
    refreshHighlights();
    scheduleRetry();
  }

  function scheduleRetry() {
    if (!state.failed.length && !state.sharedFailed.length) return;
    if (state.retry >= state.maxRetries) return;
    state.retry++;
    setTimeout(() => {
      const still = [];
      for (const m of state.failed) {
        if (!wrapOne(m)) still.push(m);
      }
      state.failed = still;
      const stillS = [];
      for (const m of state.sharedFailed) {
        if (!wrapOne(m, 's:')) stillS.push(m);
      }
      state.sharedFailed = stillS;
      state.idx = buildIndex();
      updatePanel();
      if (state.banner) state.banner.update();
      scheduleRetry();
    }, 2500);
  }

  /* ---------------- events ---------------- */

  function onSelectionChange() {
    if (state.editor && state.editor.current()) return;
    updatePill();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      state.editor.close();
      state.card.hide();
      state.panel.hide();
    }
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return sendResponse({ ok: false });
    if (msg.type === 'tma:toggle-panel') {
      if (state.panel) state.panel.toggle();
    } else if (msg.type === 'tma:command') {
      if (msg.cmd === 'comment') createMarkFromSelection();
      else if (msg.cmd === 'share') doShare();
    }
    sendResponse({ ok: true });
  });

  let storageDebounce = null;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORE_KEY] || !state.panel) return;
    clearTimeout(storageDebounce);
    storageDebounce = setTimeout(async () => {
      state.marks = await loadPage();
      refreshHighlights();
    }, 300);
  });

  /* ---------------- page-level (light DOM) styles ---------------- */

  function injectPageCSS() {
    const doc = state.doc;
    if (doc.getElementById('tma-page-css')) return;
    const st = doc.createElement('style');
    st.id = 'tma-page-css';
    st.setAttribute(SKIP, '');
    st.textContent =
      '.tma-hl{background-color:' + OWN_BG + '!important;border-radius:2px;' +
      'box-shadow:inset 0 -2px 0 rgba(180,130,0,.55);cursor:pointer;}' +
      '.tma-hl--shared{background-color:' + SHARED_BG + '!important;' +
      'box-shadow:inset 0 -2px 0 rgba(124,58,237,.6);}' +
      '.tma-flash{animation:tmaFlash .9s ease 2;}' +
      '@keyframes tmaFlash{0%,100%{box-shadow:inset 0 -2px 0 rgba(180,130,0,.55);}' +
      '50%{box-shadow:0 0 0 5px rgba(246,185,59,.9);}}';
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    injectPageCSS();
    buildPill();
    buildEditor();
    buildCard();
    buildBanner();
    buildPanel();
    state.doc.addEventListener('selectionchange', onSelectionChange);
    state.doc.addEventListener('keydown', onKey);
    await initRestore();
    updatePill(); // in case a selection already existed when we booted
    // Ready marker (also a useful hook for tests / other scripts).
    try {
      state.doc.documentElement.setAttribute('data-tma-ready', '');
    } catch (_) { /* ignore */ }
  }

  if (typeof globalThis !== 'undefined' && globalThis.__TMA_TEST__) {
    // Test hook: expose internals, skip boot (used by ../../tests/).
    globalThis.__TMA_DOM = {
      state,
      buildIndex,
      wrapRange,
      unwrapAll,
      clearHighlights,
      resolvePoint,
      rawToRange,
      locate,
    };
    return;
  }

  if (state.doc.readyState === 'loading') {
    state.doc.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
