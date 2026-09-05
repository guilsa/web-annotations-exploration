/* Textmarker B — Pairshare (content script).
 *
 * Core: select text → pick one of 4 marker colors → comment. Marks persist
 * per-URL in browser.storage.local and restore on revisit (fuzzy matching).
 *
 * Sharing: a live P2P session with another browser over a WebRTC DataChannel.
 * Signaling is done by copy-pasting an invite code (offer SDP) and a join
 * code (answer SDP). No server is involved; public STUN is the only default
 * (LAN works without even that). While connected, both sides keep the page's
 * mark set in sync (add / edit / delete propagate; last-write-wins by ts).
 *
 * Structure: class-based (Core / Pair / UI), deliberately different from the
 * other variants. Pure helpers + merge logic are exposed on
 * globalThis.__TMB_PURE / __TMB_DOM for unit tests (see ../../tests/).
 */
(() => {
  'use strict';

  /* ================================================================
   * PURE HELPERS
   * ================================================================ */

  const squeeze = (s) => (typeof s === 'string' ? s.replace(/\s+/g, '') : '');

  function squeezeMap(text) {
    const chars = [];
    const map = new Array(text.length);
    let j = 0;
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i])) {
        chars.push(text[i]);
        map[j++] = i;
      }
    }
    return { text: chars.join(''), map: map.slice(0, j) };
  }

  /**
   * Locate a saved mark inside the current full page text.
   * Tiers: exact at saved offset → squeezed at saved offset →
   * context+window → context → long-quote window. Returns [s, e) or null.
   */
  function findOffsets(text, mark, opts) {
    opts = opts || {};
    const win = typeof opts.window === 'number' ? opts.window : 5000;
    const quote = mark.quote;
    if (!quote) return null;
    const target = typeof mark.offset === 'number' ? mark.offset : 0;

    if (text.slice(target, target + quote.length) === quote) {
      return [target, target + quote.length];
    }
    const sq = squeeze(quote);
    if (sq.length < 3) return null;
    if (squeeze(text.slice(target, target + quote.length)) === sq) {
      const { map: smap } = squeezeMap(text.slice(target, target + quote.length));
      return [target, target + smap[sq.length - 1] + 1];
    }

    const { text: stext, map } = squeezeMap(text);
    if (sq.length > stext.length) return null;
    const pre = squeeze(mark.pre || '').slice(-20);
    const post = squeeze(mark.post || '').slice(0, 20);
    const hasCtx = !!(pre || post);
    const lo = Math.max(0, target - win);
    const hi = Math.min(text.length, target + win);

    const cands = [];
    for (let bi = stext.indexOf(sq); bi !== -1; bi = stext.indexOf(sq, bi + 1)) {
      cands.push({ rawS: map[bi], rawE: map[bi + sq.length - 1] + 1, bi });
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

    if (hasCtx) {
      let c = closest((x) => ctxOk(x.bi) && inWindow(x));
      if (c) return finish(c);
      c = closest((x) => ctxOk(x.bi));
      if (c) return finish(c);
    }
    if (sq.length >= 20) {
      const c = closest(inWindow);
      if (c) return finish(c);
    }
    return null;
  }

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

  const sdpToCode = (sdp) => b64enc(sdp);
  const codeToSdp = (code) => b64dec(String(code || '').replace(/\s+/g, ''));

  /**
   * Merge a remote mark set into the local one.
   * - ids present remotely but not locally  -> added
   * - same id, newer remote ts, different note -> note updated
   * - ids present in the PREVIOUS remote state but gone now -> removed
   *   (only when lastRemoteIds is known; the first exchange never deletes)
   */
  function mergeMarks(local, remote, lastRemoteIds) {
    const lmap = new Map(local.map((m) => [m.id, m]));
    const rmap = new Map(remote.map((m) => [m.id, m]));
    const out = local.slice();
    let added = 0;
    let updated = 0;
    const removed = [];
    for (const r of remote) {
      const l = lmap.get(r.id);
      if (!l) {
        out.push(r);
        added++;
      } else if (r.ts > l.ts && r.note !== l.note) {
        l.note = r.note;
        l.ts = r.ts;
        updated++;
      }
    }
    if (Array.isArray(lastRemoteIds)) {
      for (const id of lastRemoteIds) {
        if (!rmap.has(id) && lmap.has(id)) removed.push(id);
      }
    }
    for (const id of removed) {
      const i = out.findIndex((m) => m.id === id);
      if (i >= 0) out.splice(i, 1);
    }
    return { marks: out, added, updated, removed };
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__TMB_PURE = {
      squeeze,
      squeezeMap,
      findOffsets,
      b64enc,
      b64dec,
      sdpToCode,
      codeToSdp,
      mergeMarks,
    };
  }

  /* ================================================================
   * RUNTIME (browser only)
   * ================================================================ */
  if (typeof window === 'undefined' || window.__TMB_LOADED__) return;
  window.__TMB_LOADED__ = true;

  const SKIP = 'data-tmb-skip';
  const ID_ATTR = 'data-tmb-id';
  const PAGES_KEY = 'tmb.pages';
  const COLOR_KEY = 'tmb.color';
  const HL_CLASS = 'tmb-hl';

  const COLORS = {
    yellow: { bg: '#ffd966', edge: 'rgba(160,120,0,.55)' },
    blue: { bg: '#a5d8ff', edge: 'rgba(30,100,200,.55)' },
    green: { bg: '#b2f2bb', edge: 'rgba(20,140,60,.55)' },
    pink: { bg: '#ffc9c9', edge: 'rgba(200,40,80,.55)' },
  };
  const COLOR_NAMES = Object.keys(COLORS);
  const DEFAULT_COLOR = 'yellow';

  const uid = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return ''; }
  };

  /* ---------------- Core: state, storage, index, marks ---------------- */

  class Core {
    constructor(doc) {
      this.doc = doc;
      this.marks = [];
      this.failed = [];
      this.color = DEFAULT_COLOR;
      this.onChange = null; // hook: () => void (Pair sends state when connected)
      this.lastRemoteIds = null;
      this.retry = 0;
      this.maxRetries = 6;
    }

    pageKey() {
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

    async load() {
      const [pages, colorData] = await Promise.all([
        browser.storage.local.get(PAGES_KEY),
        browser.storage.local.get(COLOR_KEY),
      ]);
      const page = (pages[PAGES_KEY] || {})[this.pageKey()];
      this.marks = page && Array.isArray(page.marks) ? page.marks : [];
      this.color = colorData[COLOR_KEY] && COLORS[colorData[COLOR_KEY]] ? colorData[COLOR_KEY] : DEFAULT_COLOR;
    }

    async save() {
      const data = await browser.storage.local.get(PAGES_KEY);
      const pages = data[PAGES_KEY] || {};
      if (this.marks.length) pages[this.pageKey()] = { marks: this.marks, updated: Date.now() };
      else delete pages[this.pageKey()];
      await browser.storage.local.set({ [PAGES_KEY]: pages });
    }

    async saveColor(name) {
      this.color = COLORS[name] ? name : DEFAULT_COLOR;
      await browser.storage.local.set({ [COLOR_KEY]: this.color });
    }

    emitChange() {
      if (this.onChange) this.onChange();
    }

    /* ---- text index & matching ---- */

    index() {
      const doc = this.doc;
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

    nodeAt(nodes, off) {
      let lo = 0;
      let hi = nodes.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].start <= off) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans >= 0 ? nodes[ans] : null;
    }

    locate(mark, idx) {
      const off = findOffsets(idx.text, mark);
      if (!off) return null;
      const a = this.nodeAt(idx.nodes, off[0]);
      const b = this.nodeAt(idx.nodes, off[1]);
      if (!a || !b) return null;
      const range = this.doc.createRange();
      try {
        range.setStart(a.node, off[0] - a.start);
        range.setEnd(b.node, off[1] - b.start);
      } catch (_) {
        return null;
      }
      return range;
    }
  }

  /* ---------------- DOM ops (text-node slicing; only splits text) ---------------- */

  const D = {
    firstText(node) {
      const doc = node.ownerDocument || node.parentNode && node.parentNode.ownerDocument;
      if (node.nodeType === Node.TEXT_NODE) return node;
      const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) if (t.data.length) return t;
      return null;
    },
    lastText(node) {
      const doc = node.ownerDocument || node.parentNode && node.parentNode.ownerDocument;
      if (node.nodeType === Node.TEXT_NODE) return node;
      const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let t;
      let last = null;
      while ((t = w.nextNode())) if (t.data.length) last = t;
      return last;
    },
    resolvePoint(node, offset) {
      if (node.nodeType === Node.TEXT_NODE) return [node, offset];
      if (offset <= 0) {
        const t = D.firstText(node);
        return t ? [t, 0] : null;
      }
      if (offset >= node.childNodes.length) {
        const t = D.lastText(node);
        return t ? [t, t.data.length] : null;
      }
      const t = D.lastText(node.childNodes[offset - 1]);
      return t ? [t, t.data.length] : null;
    },
    /** Wrap a range in highlight spans (one per parent). Only splits text nodes. */
    wrap(doc, range, id, color) {
      let sc = range.startContainer;
      let so = range.startOffset;
      let ec = range.endContainer;
      let eo = range.endOffset;
      if (sc.nodeType !== Node.TEXT_NODE) {
        const p = D.resolvePoint(sc, so);
        if (!p) return [];
        sc = p[0]; so = p[1];
      }
      if (ec.nodeType !== Node.TEXT_NODE) {
        const p = D.resolvePoint(ec, eo);
        if (!p) return [];
        ec = p[0]; eo = p[1];
      }
      if (sc === ec && so >= eo) return [];
      const r = doc.createRange();
      r.setStart(sc, so);
      r.setEnd(ec, eo);

      const plan = [];
      if (r.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
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
        w.className = HL_CLASS;
        w.setAttribute(ID_ATTR, id);
        w.setAttribute('data-tmb-color', color);
        return w;
      };
      const wrappers = [];
      for (const [tn, s, e] of plan) {
        let mid = tn;
        if (s > 0) mid = tn.splitText(s);
        if (e < mid.data.length) mid.splitText(e - s);
        const last = wrappers[wrappers.length - 1];
        let w;
        if (last && last.parentNode === mid.parentNode && last.nextSibling === mid) {
          w = last;
        } else {
          w = makeWrapper();
          mid.parentNode.insertBefore(w, mid);
          wrappers.push(w);
        }
        w.appendChild(mid);
      }
      return wrappers;
    },
    unwrap(doc, id) {
      const els = Array.from(doc.querySelectorAll('[' + ID_ATTR + '="' + id + '"]'));
      for (const el of els) {
        const parent = el.parentNode;
        if (!parent) continue;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
      }
    },
    clearAll(doc) {
      const ids = new Set();
      for (const el of Array.from(doc.querySelectorAll('[' + ID_ATTR + ']'))) {
        ids.add(el.getAttribute(ID_ATTR));
      }
      for (const id of ids) D.unwrap(doc, id);
    },
  };

  /* ---------------- Pair: WebRTC session ---------------- */

  class Pair {
    constructor(core) {
      this.core = core;
      this.ui = null;
      this.pc = null;
      this.dc = null;
      this.role = null; // 'invite' | 'join'
      core.onChange = () => this.sendState();
    }

    static iceConfig() {
      return {
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      };
    }

    static waitIce(pc, timeoutMs) {
      timeoutMs = timeoutMs || 3000;
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const t = setTimeout(resolve, timeoutMs);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t);
            resolve();
          }
        });
      });
    }

    setUI(ui) {
      this.ui = ui;
    }

    status(s, detail) {
      if (this.ui && this.ui.panel) this.ui.panel.setStatus(s, detail);
    }

    wireDc(dc) {
      this.dc = dc;
      dc.addEventListener('open', () => {
        this.status('connected');
        this.sendState();
      });
      dc.addEventListener('message', (e) => {
        try {
          this.onMessage(JSON.parse(e.data));
        } catch (_) { /* ignore bad frames */ }
      });
      dc.addEventListener('close', () => {
        this.status('idle', 'The connection was closed.');
        this.core.lastRemoteIds = null;
      });
      dc.addEventListener('error', () => this.status('error'));
    }

    /** Invite side: create pc + data channel + offer. Returns invite code. */
    async makeInvite() {
      this.teardown();
      this.role = 'invite';
      this.pc = new RTCPeerConnection(Pair.iceConfig());
      this.wireDc(this.pc.createDataChannel('tmb', { ordered: true }));
      this.status('waiting-join');
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await Pair.waitIce(this.pc);
      return sdpToCode(this.pc.localDescription.sdp);
    }

    /** Invite side: apply the peer's answer code. */
    async acceptJoin(code) {
      if (this.role !== 'invite' || !this.pc) throw new Error('Generate an invite first.');
      await this.pc.setRemoteDescription({ type: 'answer', sdp: codeToSdp(code) });
    }

    /** Join side: consume invite code, produce join code. */
    async makeJoin(inviteCode) {
      this.teardown();
      this.role = 'join';
      this.pc = new RTCPeerConnection(Pair.iceConfig());
      this.pc.ondatachannel = (e) => this.wireDc(e.channel);
      this.status('waiting-invite');
      await this.pc.setRemoteDescription({ type: 'offer', sdp: codeToSdp(inviteCode) });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await Pair.waitIce(this.pc);
      return sdpToCode(this.pc.localDescription.sdp);
    }

    sendState() {
      if (this.dc && this.dc.readyState === 'open') {
        this.dc.send(JSON.stringify({
          t: 'state',
          url: this.core.pageKey(),
          title: this.docTitle(),
          ts: Date.now(),
          marks: this.core.marks,
        }));
      }
    }

    docTitle() {
      try { return this.core.doc.title; } catch (_) { return ''; }
    }

    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'bye') {
        this.status('idle', 'The other side ended the session.');
        this.core.lastRemoteIds = null;
        return;
      }
      if (msg.t !== 'state' || !Array.isArray(msg.marks)) return;
      if (msg.url !== this.core.pageKey()) {
        this.status('connected', 'Peer is on a different page — see Import.');
        if (this.ui) this.ui.showForeign(msg.url, msg.title, msg.marks);
        return;
      }
      if (this.ui) this.ui.showForeign(null);
      const res = mergeMarks(this.core.marks, msg.marks, this.core.lastRemoteIds);
      this.core.lastRemoteIds = msg.marks.map((m) => m.id);
      if (res.added || res.updated || res.removed.length) {
        this.core.marks = res.marks;
        this.core.save().then(() => this.core.render());
        this.sendState(); // propagate deletions/edits back (no-op for the peer)
      }
    }

    end() {
      try {
        if (this.dc && this.dc.readyState === 'open') {
          this.dc.send(JSON.stringify({ t: 'bye' }));
        }
      } catch (_) { /* ignore */ }
      this.teardown();
      this.status('idle');
    }

    teardown() {
      if (this.dc) {
        this.dc.onmessage = null;
        this.dc.onopen = null;
        this.dc.onclose = null;
        try { this.dc.close(); } catch (_) { /* ignore */ }
      }
      if (this.pc) {
        this.pc.ondatachannel = null;
        try { this.pc.close(); } catch (_) { /* ignore */ }
      }
      this.pc = null;
      this.dc = null;
      this.role = null;
    }
  }

  /* ---------------- UI ---------------- */

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .pill {
      position: fixed; z-index: 2147483647; display: none; align-items: center; gap: 5px;
      background: #102a43; border-radius: 999px; padding: 4px 8px;
      box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    .dot {
      width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent;
      cursor: pointer; padding: 0;
    }
    .dot.sel { border-color: #102a43; box-shadow: 0 0 0 2px #fff; }
    .pill button.go {
      border: 0; background: #3b82f6; color: #fff; font-weight: 600;
      border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 13px;
    }
    .card, .editor {
      position: fixed; z-index: 2147483647; display: none;
      background: #fff; color: #111827; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.3); font-size: 13px;
    }
    .card { max-width: 320px; padding: 10px 12px; }
    .card .q { color: #6b7280; font-size: 12px; margin: 0 0 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card .note { margin: 0 0 6px; white-space: pre-wrap; }
    .card .meta { color: #6b7280; font-size: 11px; }
    .card .row, .editor .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .card button, .editor button, .panel button, .overlay button {
      border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; padding: 5px 11px; cursor: pointer; font-size: 12px;
    }
    .card button.primary, .editor button.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; font-weight: 600; }
    .card button.danger:hover { background: #fee2e2; border-color: #fca5a5; }
    .editor { width: 340px; padding: 10px 12px; }
    .editor h4 { margin: 0 0 6px; font-size: 12px; color: #6b7280; font-weight: 600; }
    .editor textarea {
      width: 100%; min-height: 72px; resize: vertical; padding: 8px;
      border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; font-family: inherit;
    }
    .toast {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%);
      display: none; background: #111827; color: #f9fafb; padding: 8px 16px;
      border-radius: 999px; font-size: 13px;
    }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483647; display: none;
      background: rgba(15, 23, 42, .55);
    }
    .sheet {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto;
      background: #fff; border-radius: 14px; padding: 18px 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,.4);
    }
    .sheet h3 { margin: 0 0 4px; font-size: 17px; }
    .status {
      font-size: 13px; margin: 0 0 12px; padding: 8px 10px; border-radius: 8px;
      background: #eff6ff; color: #1e40af;
    }
    .status.connected { background: #ecfdf5; color: #065f46; }
    .status.error { background: #fef2f2; color: #991b1b; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .tabs button { border-radius: 8px 8px 0 0; padding: 7px 14px; font-weight: 600; }
    .tabs button.on { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .pane { display: none; }
    .pane.on { display: block; }
    .pane label { display: block; font-size: 12px; color: #374151; font-weight: 600; margin: 10px 0 4px; }
    .pane textarea {
      width: 100%; min-height: 84px; font-size: 11px; font-family: ui-monospace, monospace;
      border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; resize: vertical;
      word-break: break-all;
    }
    .pane .actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .foreign {
      display: none; margin-top: 12px; padding: 10px; border-radius: 8px;
      background: #fffbeb; border: 1px solid #fde68a; font-size: 12px;
    }
    .foot { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
    .help { color: #6b7280; font-size: 11px; margin: 12px 0 0; }
  `;

  class UI {
    constructor(core, pair) {
      this.core = core;
      this.pair = pair;
      core.ui = this;
      this.hosts = {};
      this.toastTimer = null;
      this.pillColor = core.color;
      this._buildPill();
      this._buildEditor();
      this._buildCard();
      this._buildPanel();
      this._buildToast();
      pair.setUI(this);
    }

    doc() { return this.core.doc; }

    insideHost(name, e) {
      const div = this.hosts[name];
      return !!div && (e.target === div || div.contains(e.target));
    }

    host(name) {
      if (this.hosts[name]) return this.hosts[name].shadowRoot;
      const doc = this.doc();
      const div = doc.createElement('div');
      div.id = 'tmb-' + name;
      div.setAttribute(SKIP, '');
      div.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
      const root = div.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = UI_CSS;
      root.appendChild(style);
      (doc.body || doc.documentElement).appendChild(div);
      this.hosts[name] = div;
      return root;
    }

    h(root, tag, cls, text) {
      const el = root.ownerDocument.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    }

    toast(msg) {
      const el = this.host('toast').querySelector('.toast');
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
    }

    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        try {
          const ta = this.doc().createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;';
          ta.setAttribute(SKIP, '');
          this.doc().body.appendChild(ta);
          ta.select();
          const ok = this.doc().execCommand('copy');
          ta.remove();
          return ok;
        } catch (__) {
          return false;
        }
      }
    }

    /* ---- pill ---- */

    _buildPill() {
      const root = this.host('pill');
      const pill = this.h(root, 'div', 'pill');
      for (const name of COLOR_NAMES) {
        const dot = this.h(root, 'button', 'dot' + (name === this.pillColor ? ' sel' : ''));
        dot.style.background = COLORS[name].bg;
        dot.title = 'Marker color: ' + name;
        dot.dataset.color = name;
        dot.addEventListener('mousedown', (e) => e.preventDefault());
        dot.addEventListener('click', () => {
          this.pillColor = name;
          this.core.saveColor(name);
          for (const d of root.querySelectorAll('.dot')) {
            d.classList.toggle('sel', d.dataset.color === name);
          }
        });
        pill.appendChild(dot);
      }
      const go = this.h(root, 'button', 'go', '💬 Comment');
      go.addEventListener('mousedown', (e) => e.preventDefault());
      go.addEventListener('click', () => {
        this.hidePill();
        this.core.createMarkFromSelection(this.pillColor);
      });
      pill.appendChild(go);
      root.appendChild(pill);
      this.doc().addEventListener('mousedown', (e) => {
        if (e.button === 0 && !this.insideHost('pill', e)) this.hidePill();
      });
      this.pillEl = pill;
    }

    hidePill() {
      if (this.pillEl) this.pillEl.style.display = 'none';
    }

    updatePill() {
      const doc = this.doc();
      const sel = doc.defaultView.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hidePill();
      const range = sel.getRangeAt(0);
      if (!doc.body || !doc.body.contains(range.commonAncestorContainer)) return this.hidePill();
      if (range.toString().trim().length === 0) return this.hidePill();
      const rect = range.getBoundingClientRect();
      this.pillEl.style.display = 'flex';
      this.pillEl.style.left = Math.max(4, rect.left + rect.width / 2 - 90) + 'px';
      this.pillEl.style.top = Math.min(rect.bottom + 6, doc.defaultView.innerHeight - 44) + 'px';
    }

    /* ---- editor ---- */

    _buildEditor() {
      const root = this.host('editor');
      const box = this.h(root, 'div', 'editor');
      const title = this.h(root, 'h4', null, 'Comment on highlighted text');
      const ta = this.h(root, 'textarea');
      ta.placeholder = 'Write a comment… (leave empty for a plain highlight)';
      ta.maxLength = 5000;
      const row = this.h(root, 'div', 'row');
      const save = this.h(root, 'button', 'primary', 'Save');
      const del = this.h(root, 'button', 'danger', 'Delete');
      const cancel = this.h(root, 'button', null, 'Cancel');
      row.appendChild(save);
      row.appendChild(del);
      row.appendChild(cancel);
      box.appendChild(title);
      box.appendChild(ta);
      box.appendChild(row);
      root.appendChild(box);

      let current = null;
      const self = this;
      const api = {
        open(mark, anchorEl) {
          current = mark;
          ta.value = mark.note || '';
          del.style.display = mark.author === 'me' ? '' : 'none';
          box.style.display = 'block';
          self.positionEditor(anchorEl);
          ta.focus();
          ta.select();
        },
        close() {
          current = null;
          box.style.display = 'none';
        },
        current: () => current,
      };
      this.editor = api;

      save.addEventListener('click', () => {
        const mark = current;
        if (!mark) return;
        mark.note = ta.value;
        mark.ts = Date.now();
        api.close();
        this.core.updateMark(mark);
      });
      del.addEventListener('click', () => {
        const mark = current;
        if (!mark) return;
        api.close();
        this.core.deleteMark(mark.id);
      });
      cancel.addEventListener('click', () => api.close());
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click();
        if (e.key === 'Escape') api.close();
      });
      this.doc().addEventListener('mousedown', (e) => {
        if (box.style.display === 'block' && !this.insideHost('editor', e) && !this.isHighlight(e.target)) {
          api.close();
        }
      });
      this.doc().defaultView.addEventListener('scroll', () => api.close(), true);
    }

    positionEditor(anchorEl) {
      const box = this.host('editor').querySelector('.editor');
      const win = this.doc().defaultView;
      let rect = null;
      if (anchorEl && anchorEl.getBoundingClientRect) rect = anchorEl.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        box.style.left = '16px';
        box.style.top = '16px';
        return;
      }
      const w = 340;
      const hgt = box.offsetHeight || 180;
      let top = rect.bottom + 8;
      if (top + hgt > win.innerHeight - 8) top = rect.top - hgt - 8;
      top = Math.max(8, Math.min(top, win.innerHeight - hgt - 8));
      box.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - w - 8)) + 'px';
      box.style.top = top + 'px';
    }

    isHighlight(target) {
      let el = target;
      while (el && el.nodeType === Node.ELEMENT_NODE) {
        if (el.hasAttribute && el.hasAttribute(ID_ATTR)) return true;
        el = el.parentElement;
      }
      return false;
    }

    /* ---- hover card ---- */

    _buildCard() {
      const root = this.host('card');
      const box = this.h(root, 'div', 'card');
      const q = this.h(root, 'p', 'q');
      const note = this.h(root, 'p', 'note');
      const meta = this.h(root, 'div', 'meta');
      const row = this.h(root, 'div', 'row');
      const edit = this.h(root, 'button', 'primary', 'Edit');
      const close = this.h(root, 'button', null, 'Close');
      row.appendChild(edit);
      row.appendChild(close);
      box.appendChild(q);
      box.appendChild(note);
      box.appendChild(meta);
      box.appendChild(row);
      root.appendChild(box);

      let hoverTimer = null;
      let pinned = false;
      let currentMark = null;

      const show = (mark, anchorEl) => {
        currentMark = mark;
        q.textContent = '“' + mark.quote.slice(0, 120) + (mark.quote.length > 120 ? '…' : '') + '”';
        note.textContent = mark.note ? mark.note : '(no comment)';
        note.style.display = mark.note ? '' : 'none';
        meta.textContent = mark.author + ' · ' + fmtTime(mark.ts) + ' · ' + (mark.color || DEFAULT_COLOR) + ' marker';
        box.style.display = 'block';
        this.positionCard(anchorEl);
      };
      const hide = () => {
        if (pinned) return;
        box.style.display = 'none';
        currentMark = null;
      };

      edit.addEventListener('click', () => {
        const mark = currentMark; // capture: hide() clears currentMark
        if (!mark) return;
        hide();
        pinned = false;
        const el = this.doc().querySelector('[' + ID_ATTR + '="' + mark.id + '"]');
        this.editor.open(mark, el);
      });
      close.addEventListener('click', () => {
        pinned = false;
        box.style.display = 'none';
        currentMark = null;
      });

      this.doc().addEventListener('mouseover', (e) => {
        const el = e.target;
        if (!el || !el.closest) return;
        const hl = el.closest('[' + ID_ATTR + ']');
        if (!hl) return;
        const mark = this.core.marks.find((m) => m.id === hl.getAttribute(ID_ATTR));
        if (!mark) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => show(mark, hl), 220);
      });
      this.doc().addEventListener('mouseout', (e) => {
        const el = e.target;
        if (el && el.closest && el.closest('[' + ID_ATTR + ']')) {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(hide, 180);
        }
      });
      this.doc().addEventListener('click', (e) => {
        const el = e.target;
        if (!el || !el.closest) return;
        const hl = el.closest('[' + ID_ATTR + ']');
        if (!hl) return;
        e.preventDefault();
        e.stopPropagation();
        pinned = true;
        const mark = this.core.marks.find((m) => m.id === hl.getAttribute(ID_ATTR));
        if (mark) show(mark, hl);
      }, true);
      this.doc().addEventListener('mousedown', (e) => {
        if (box.style.display === 'block' && !this.insideHost('card', e) && !this.isHighlight(e.target)) {
          pinned = false;
          box.style.display = 'none';
          currentMark = null;
        }
      });
    }

    positionCard(anchorEl) {
      const box = this.host('card').querySelector('.card');
      const win = this.doc().defaultView;
      if (!anchorEl || !anchorEl.getBoundingClientRect) return;
      const rect = anchorEl.getBoundingClientRect();
      const w = box.offsetWidth || 300;
      const hgt = box.offsetHeight || 120;
      let top = rect.bottom + 8;
      if (top + hgt > win.innerHeight - 8) top = rect.top - hgt - 8;
      top = Math.max(8, Math.min(top, win.innerHeight - hgt - 8));
      box.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - w - 8)) + 'px';
      box.style.top = top + 'px';
    }

    /* ---- pair panel (overlay) ---- */

    _buildPanel() {
      const root = this.host('panel');
      const overlay = this.h(root, 'div', 'overlay');
      const sheet = this.h(root, 'div', 'sheet');

      const h3 = this.h(root, 'h3', null, 'Pairshare — live sync with another browser');
      const status = this.h(root, 'div', 'status', 'Not paired.');
      const tabs = this.h(root, 'div', 'tabs');
      const tabInvite = this.h(root, 'button', 'on', 'Invite (I have the page)');
      const tabJoin = this.h(root, 'button', null, 'Join (I got an invite code)');
      tabs.appendChild(tabInvite);
      tabs.appendChild(tabJoin);

      // invite pane
      const paneInvite = this.h(root, 'div', 'pane on');
      const gen = this.h(root, 'button', 'primary', '1. Generate invite code');
      gen.setAttribute('data-el', 'gen');
      const inviteOut = this.h(root, 'textarea');
      inviteOut.setAttribute('data-el', 'invite-out');
      inviteOut.readOnly = true;
      inviteOut.placeholder = 'invite code appears here…';
      const copyInv = this.h(root, 'button', null, 'Copy invite code');
      const joinIn = this.h(root, 'textarea');
      joinIn.setAttribute('data-el', 'join-in');
      joinIn.placeholder = 'paste the join code the other side sends you…';
      const connect = this.h(root, 'button', 'primary', 'Connect');
      connect.setAttribute('data-el', 'connect');
      const invActions = this.h(root, 'div', 'actions');
      invActions.appendChild(gen);
      invActions.appendChild(copyInv);
      invActions.appendChild(connect);
      paneInvite.appendChild(gen);
      paneInvite.appendChild(inviteOut);
      paneInvite.appendChild(invActions);
      const joinLabel = this.h(root, 'label', null, '2. Paste the join code you receive, then Connect');
      paneInvite.appendChild(joinLabel);
      paneInvite.appendChild(joinIn);

      // join pane
      const paneJoin = this.h(root, 'div', 'pane');
      const invInLabel = this.h(root, 'label', null, '1. Paste the invite code');
      const invIn = this.h(root, 'textarea');
      invIn.setAttribute('data-el', 'invite-in');
      invIn.placeholder = 'paste the invite code…';
      const genJoin = this.h(root, 'button', 'primary', '2. Create join code');
      genJoin.setAttribute('data-el', 'gen-join');
      const joinOut = this.h(root, 'textarea');
      joinOut.setAttribute('data-el', 'join-out');
      joinOut.readOnly = true;
      joinOut.placeholder = 'join code appears here — send it back…';
      const copyJoin = this.h(root, 'button', null, 'Copy join code');
      const joinActions = this.h(root, 'div', 'actions');
      joinActions.appendChild(genJoin);
      joinActions.appendChild(copyJoin);
      paneJoin.appendChild(invInLabel);
      paneJoin.appendChild(invIn);
      paneJoin.appendChild(joinActions);
      paneJoin.appendChild(joinOut);

      const foreign = this.h(root, 'div', 'foreign');
      const foreignText = this.h(root, 'span');
      const impBtn = this.h(root, 'button', 'primary', 'Import into this page');
      impBtn.setAttribute('data-el', 'imp');
      foreign.appendChild(foreignText);
      foreign.appendChild(impBtn);

      const foot = this.h(root, 'div', 'foot');
      const endBtn = this.h(root, 'button', 'danger', 'End session');
      endBtn.setAttribute('data-el', 'end');
      const closeBtn = this.h(root, 'button', null, 'Close');
      foot.appendChild(endBtn);
      foot.appendChild(closeBtn);

      const help = this.h(root, 'p', 'help',
        'Both browsers must be open on the same page URL. On a LAN this works with no ' +
        'internet; elsewhere the default public STUN servers are used. While connected, ' +
        'adds / edits / deletes sync both ways and are saved locally on each side.');

      sheet.appendChild(h3);
      sheet.appendChild(status);
      sheet.appendChild(tabs);
      sheet.appendChild(paneInvite);
      sheet.appendChild(paneJoin);
      sheet.appendChild(foreign);
      sheet.appendChild(foot);
      sheet.appendChild(help);
      overlay.appendChild(sheet);
      root.appendChild(overlay);

      const setTab = (invite) => {
        tabInvite.classList.toggle('on', invite);
        tabJoin.classList.toggle('on', !invite);
        paneInvite.classList.toggle('on', invite);
        paneJoin.classList.toggle('on', !invite);
      };
      tabInvite.addEventListener('click', () => setTab(true));
      tabJoin.addEventListener('click', () => setTab(false));

      const busy = (btn, on) => {
        btn.disabled = on;
        btn.textContent = on ? '…' : btn.dataset.label;
      };
      for (const b of [gen, connect, genJoin]) b.dataset.label = b.textContent;

      gen.addEventListener('click', async () => {
        busy(gen, true);
        try {
          const code = await this.pair.makeInvite();
          inviteOut.value = code;
          this.toast('Invite code ready — send it to the other browser');
        } catch (e) {
          this.toast('Invite failed: ' + e.message);
        }
        busy(gen, false);
      });
      copyInv.addEventListener('click', async () => {
        if (await this.copyText(inviteOut.value)) this.toast('Invite code copied');
      });
      connect.addEventListener('click', async () => {
        busy(connect, true);
        try {
          await this.pair.acceptJoin(joinIn.value);
          this.toast('Connecting… waiting for the data channel');
        } catch (e) {
          this.toast(e.message);
        }
        busy(connect, false);
      });
      genJoin.addEventListener('click', async () => {
        busy(genJoin, true);
        try {
          const code = await this.pair.makeJoin(invIn.value);
          joinOut.value = code;
          this.toast('Join code ready — send it back; the connection opens on both sides');
        } catch (e) {
          this.toast('Join failed: ' + e.message);
        }
        busy(genJoin, false);
      });
      copyJoin.addEventListener('click', async () => {
        if (await this.copyText(joinOut.value)) this.toast('Join code copied');
      });
      impBtn.addEventListener('click', () => {
        this.pair.importForeignIntoCurrent(this._foreignMarks);
      });
      endBtn.addEventListener('click', () => {
        this.pair.end();
      });
      closeBtn.addEventListener('click', () => this.hidePanel());
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) this.hidePanel();
      });

      const self = this;
      this.panel = {
        overlay,
        statusEl: status,
        foreign,
        foreignText,
        show() { overlay.style.display = 'block'; },
        hide() { overlay.style.display = 'none'; },
        toggle() {
          overlay.style.display = overlay.style.display === 'block' ? 'none' : 'block';
        },
        setStatus(state, detail) {
          status.className = 'status' + (state === 'connected' ? ' connected' : state === 'error' ? ' error' : '');
          const base = {
            'idle': 'Not paired.',
            'waiting-join': 'Waiting for the other side to paste your invite and send back the join code…',
            'waiting-invite': 'Waiting for the other side to paste your join code…',
            'connected': '● Connected — comments on this page sync live.',
            'error': 'Connection error.',
          }[state] || state;
          status.textContent = base + (detail ? ' ' + detail : '');
        },
        showForeign(url, title, marks) {
          if (!url) {
            foreign.style.display = 'none';
            self._foreignMarks = null;
            return;
          }
          self._foreignMarks = marks || [];
          foreignText.textContent = 'The other browser is on a different page' +
            (title ? ' (“' + title + '”)' : '') + ': ' + url +
            ' — ' + (marks ? marks.length : 0) + ' comment(s) there.';
          foreign.style.display = 'block';
        },
      };
    }

    hidePanel() {
      if (this.panel) this.panel.hide();
    }

    _buildToast() {
      const root = this.host('toast');
      root.appendChild(this.h(root, 'div', 'toast'));
    }
  }

  /* ---------------- Core mark ops (need UI) — mixed in ---------------- */

  function nodeOffsetInIdx(idx, node, off) {
    for (let i = 0; i < idx.nodes.length; i++) {
      if (idx.nodes[i].node === node) return idx.nodes[i].start + off;
    }
    return -1;
  }

  /**
   * Appended to Core instances: selection → mark, update, delete, render,
   * restore. Kept as functions to stay close to the DOM.
   */
  Core.prototype.createMarkFromSelection = function (color) {
    if (!this.marks) return;
    const doc = this.doc;
    const sel = doc.defaultView.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0).cloneRange();
    const sp = D.resolvePoint(range.startContainer, range.startOffset);
    const ep = D.resolvePoint(range.endContainer, range.endOffset);
    if (!sp || !ep) return;
    const idx = this.index();
    const s = nodeOffsetInIdx(idx, sp[0], sp[1]);
    const e = nodeOffsetInIdx(idx, ep[0], ep[1]);
    if (s < 0 || e < 0 || s >= e) return;
    const quote = idx.text.slice(s, e);
    if (!quote.trim()) return;
    if (quote.length > 5000) {
      this.ui && this.ui.toast('Selection too long to mark (max 5000 chars)');
      return;
    }
    const id = uid();
    const mark = {
      id,
      quote,
      pre: idx.text.slice(Math.max(0, s - 40), s),
      post: idx.text.slice(e, e + 40),
      offset: s,
      note: '',
      author: 'me',
      ts: Date.now(),
      color: COLORS[color] ? color : DEFAULT_COLOR,
    };
    const r = this.locate(mark, idx);
    if (!r) return;
    const wrappers = D.wrap(doc, r, id, mark.color);
    if (!wrappers.length) return;
    this.marks.push(mark);
    sel.removeAllRanges();
    this.save();
    this.emitChange();
    if (this.ui) this.ui.editor.open(mark, wrappers[0]);
  };

  Core.prototype.updateMark = function (mark) {
    this.save().then(() => this.emitChange());
  };

  Core.prototype.deleteMark = function (id) {
    this.marks = this.marks.filter((m) => m.id !== id);
    D.unwrap(this.doc, id);
    this.save().then(() => this.emitChange());
  };

  Core.prototype.render = function () {
    const doc = this.doc;
    D.clearAll(doc);
    const idx = this.index();
    this.failed = [];
    for (const m of this.marks) {
      const r = this.locate(m, idx);
      if (r) D.wrap(doc, r, m.id, m.color);
      else this.failed.push(m);
    }
    this.scheduleRetry();
  };

  Core.prototype.scheduleRetry = function () {
    if (!this.failed.length || this.retry >= this.maxRetries) return;
    this.retry++;
    setTimeout(() => {
      const idx = this.index();
      const still = [];
      for (const m of this.failed) {
        const r = this.locate(m, idx);
        if (r) D.wrap(this.doc, r, m.id, m.color);
        else still.push(m);
      }
      this.failed = still;
      this.scheduleRetry();
    }, 2500);
  };

  /* Pair helper: import a foreign page's marks into the current page. */
  Pair.prototype.importForeignIntoCurrent = function (marks) {
    if (!marks || !marks.length) return;
    for (const m of marks) {
      this.core.marks.push(Object.assign({}, m, { id: uid(), src: m.id, author: 'peer' }));
    }
    this.core.lastRemoteIds = null;
    this.core.save().then(() => {
      this.core.render();
      this.ui && this.ui.toast('Imported ' + marks.length + ' comment(s) into this page');
    });
    this.sendState();
  };

  /* ---------------- boot ---------------- */

  async function boot() {
    const doc = document;
    const core = new Core(doc);
    const pair = new Pair(core);
    const ui = new UI(core, pair);

    core.load().then(() => {
      ui.pillColor = core.color;
      for (const d of ui.host('pill').querySelectorAll('.dot')) {
        d.classList.toggle('sel', d.dataset.color === core.color);
      }
      core.render();
      ui.updatePill();
      doc.documentElement.setAttribute('data-tmb-ready', '');
    });

    doc.addEventListener('selectionchange', () => {
      if (ui.editor.current()) return;
      ui.updatePill();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ui.editor.close();
        ui.hidePanel();
      }
    });

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return sendResponse({ ok: false });
      if (msg.type === 'tmb:toggle-panel') {
        ui.panel.toggle();
      } else if (msg.type === 'tmb:command') {
        if (msg.cmd === 'comment') core.createMarkFromSelection(ui.pillColor);
      }
      sendResponse({ ok: true });
    });

    let debounce = null;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[PAGES_KEY]) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        core.load().then(() => core.render());
      }, 300);
    });
  }

  if (typeof globalThis !== 'undefined' && globalThis.__TMB_TEST__) {
    globalThis.__TMB_DOM = {
      Core,
      D,
      Pair,
      nodeOffsetInIdx,
      COLORS,
    };
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
