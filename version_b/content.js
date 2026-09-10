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

  /* ---- threads (comments & edit suggestions) ----
   *
   * A mark is a thread anchored to a text selection. kind 'comment' holds a
   * chronological list of messages; kind 'suggestion' holds the proposed
   * replacement for the selected passage (plus discussion messages).
   * All mutations are pure/immutable so the same code paths can be unit
   * tested and the resulting threads round-trip through mergeMarks (whole-
   * thread last-write-wins by ts).
   */

  const AUTHORS = { me: 'Riley', peer: 'Jordan' };
  const LOCAL_ROLE = 'me';

  function displayName(role) {
    return AUTHORS[role] || AUTHORS.me;
  }

  /**
   * Local author identity. The two hard-coded names are assigned by pairing
   * role: the side that generated the invite code is Riley, the side that
   * joined with a join code is Jordan. Unpaired (or freshly paired) browsers
   * are Riley. The chosen name is stored on each thread/message it creates,
   * so both peers display the same author identity.
   */
  function localName(pairRole) {
    return pairRole === 'join' ? AUTHORS.peer : AUTHORS.me;
  }

  const mid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function appendMessage(thread, body, name, ts) {
    const messages = Array.isArray(thread.messages) ? thread.messages.slice() : [];
    messages.push({ id: mid('m'), name: name || AUTHORS.me, body: body == null ? '' : String(body), ts: ts || Date.now() });
    return Object.assign({}, thread, { messages, ts: ts || Date.now() });
  }

  function updateMessage(thread, id, body, ts) {
    if (!Array.isArray(thread.messages)) return thread;
    let hit = false;
    const messages = thread.messages.map((m) => {
      if (m.id !== id) return m;
      hit = true;
      return Object.assign({}, m, { body: body == null ? '' : String(body), ts: ts || m.ts });
    });
    return hit ? Object.assign({}, thread, { messages, ts: ts || Date.now() }) : thread;
  }

  function deleteMessage(thread, id) {
    if (!Array.isArray(thread.messages)) return thread;
    const messages = thread.messages.filter((m) => m.id !== id);
    if (messages.length === thread.messages.length) return thread;
    return Object.assign({}, thread, { messages, ts: Date.now() });
  }

  /**
   * Upgrade a stored mark to the thread shape. Legacy marks (pre-threads)
   * become comment threads whose single message is the old `note`; the note
   * is kept verbatim so the upgrade is idempotent and round-trips through
   * storage without changing what is displayed.
   */
  function normalizeMark(m) {
    if (!m || typeof m !== 'object') return m;
    const kind = m.kind === 'suggestion' ? 'suggestion' : 'comment';
    const out = Object.assign({}, m, { kind });
    if (kind === 'suggestion') {
      out.proposed = typeof m.proposed === 'string' ? m.proposed : '';
      out.messages = Array.isArray(m.messages) ? m.messages : [];
    } else {
      out.messages = Array.isArray(m.messages)
        ? m.messages
        : (typeof m.note === 'string' && m.note.trim() ? [{ id: mid('m'), name: displayName(m.author), body: m.note, ts: m.ts || Date.now() }] : []);
    }
    if (typeof out.name !== 'string' || !out.name) out.name = displayName(m.author);
    return out;
  }

  const normalizeMarks = (marks) => (Array.isArray(marks) ? marks.map(normalizeMark) : []);

  /** Document order: ascending saved offset; stable for equal offsets. */
  function sortedThreads(marks) {
    return marks
      .map((m, i) => [m, i])
      .sort((a, b) => ((a[0].offset || 0) - (b[0].offset || 0)) || (a[1] - b[1]))
      .map((x) => x[0]);
  }

  const threadsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Merge a remote mark set into the local one.
   * - ids present remotely but not locally  -> added
   * - same id, newer remote ts, different content -> whole mark replaced
   *   (threads are compared as a unit: any new/edited reply or proposed
   *   edit on the newer side wins; last-write-wins)
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
      } else if (r.ts > l.ts && !threadsEqual(r, l)) {
        const i = out.indexOf(l);
        out[i] = r;
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
      AUTHORS,
      displayName,
      localName,
      appendMessage,
      updateMessage,
      deleteMessage,
      normalizeMark,
      normalizeMarks,
      sortedThreads,
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
  const trunc = (s, n) => {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
      // Upgrade legacy marks (note strings) to thread shape once, at load.
      this.marks = normalizeMarks(page && Array.isArray(page.marks) ? page.marks : []);
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
        const selectedLength = e - s;
        if (selectedLength < mid.data.length) mid.splitText(selectedLength);
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
      console.log('[TMB-PAIR] wireDc: role=' + this.role + ' dc.readyState=' + dc.readyState);
      dc.addEventListener('open', () => {
        console.log('[TMB-PAIR] dc OPEN (role=' + this.role + ')');
        this.status('connected');
        this.sendState();
      });
      dc.addEventListener('message', (e) => {
        let preview;
        try { const m = JSON.parse(e.data); preview = m.t + ' marks=' + (Array.isArray(m.marks) ? m.marks.length : m.marks); }
        catch (_) { preview = '(unparseable, len=' + (typeof e.data === 'string' ? e.data.length : '?') + ')'; }
        console.log('[TMB-PAIR] dc MESSAGE (role=' + this.role + '): ' + preview);
        try {
          this.onMessage(JSON.parse(e.data));
        } catch (err) { console.log('[TMB-PAIR] onMessage threw (role=' + this.role + '):', err && err.message || err, err && err.stack ? err.stack.split('\n').slice(0,3).join(' | ') : ''); /* ignore bad frames */ }
      });
      dc.addEventListener('close', () => {
        console.log('[TMB-PAIR] dc CLOSE (role=' + this.role + ')');
        this.status('idle', 'The connection was closed.');
        this.core.lastRemoteIds = null;
      });
      dc.addEventListener('error', (err) => {
        console.log('[TMB-PAIR] dc ERROR (role=' + this.role + '):', err && err.message || err);
        this.status('error');
      });
    }

    /** Invite side: create pc + data channel + offer. Returns invite code. */
    async makeInvite() {
      this.teardown();
      this.role = 'invite';
      this.pc = new RTCPeerConnection(Pair.iceConfig());
      this.wireDc(this.pc.createDataChannel('tmb', { ordered: true }));
      this._wirePcLogs(this.pc);
      this.status('waiting-join');
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await Pair.waitIce(this.pc);
      const code = sdpToCode(this.pc.localDescription.sdp);
      console.log('[TMB-PAIR] makeInvite: offer SDP len=' + this.pc.localDescription.sdp.length +
        ' code len=' + code.length + ' iceGathering=' + this.pc.iceGatheringState +
        ' conn=' + this.pc.connectionState);
      return code;
    }

    /** Invite side: apply the peer's answer code. */
    async acceptJoin(code) {
      if (this.role !== 'invite' || !this.pc) throw new Error('Generate an invite first.');
      const sdp = codeToSdp(code);
      console.log('[TMB-PAIR] acceptJoin: answer SDP len=' + sdp.length + ' conn=' + this.pc.connectionState);
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    }

    /** Join side: consume invite code, produce join code. */
    async makeJoin(inviteCode) {
      this.teardown();
      this.role = 'join';
      this.pc = new RTCPeerConnection(Pair.iceConfig());
      this.pc.ondatachannel = (e) => {
        console.log('[TMB-PAIR] ondatachannel fired (join side): label=' + e.channel.label + ' readyState=' + e.channel.readyState);
        this.wireDc(e.channel);
      };
      this._wirePcLogs(this.pc);
      this.status('waiting-invite');
      const offerSdp = codeToSdp(inviteCode);
      console.log('[TMB-PAIR] makeJoin: received offer SDP len=' + offerSdp.length);
      await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await Pair.waitIce(this.pc);
      const code = sdpToCode(this.pc.localDescription.sdp);
      console.log('[TMB-PAIR] makeJoin: answer SDP len=' + this.pc.localDescription.sdp.length +
        ' code len=' + code.length + ' iceGathering=' + this.pc.iceGatheringState +
        ' conn=' + this.pc.connectionState);
      return code;
    }

    _wirePcLogs(pc) {
      pc.addEventListener('connectionstatechange', () => {
        console.log('[TMB-PAIR] pc connectionstatechange: ' + pc.connectionState + ' (role=' + this.role + ')');
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log('[TMB-PAIR] iceconnectionstatechange: ' + pc.iceConnectionState + ' (role=' + this.role + ')');
      });
      pc.addEventListener('icegatheringstatechange', () => {
        console.log('[TMB-PAIR] icegatheringstatechange: ' + pc.iceGatheringState + ' (role=' + this.role + ')');
      });
    }

    sendState() {
      if (this.dc && this.dc.readyState === 'open') {
        const payload = { t: 'state', url: this.core.pageKey(), title: this.docTitle(), ts: Date.now(), marks: this.core.marks };
        this.dc.send(JSON.stringify(payload));
        console.log('[TMB-PAIR] sendState: sent marks=' + payload.marks.length + ' url=' + payload.url + ' (role=' + this.role + ')');
      } else {
        console.log('[TMB-PAIR] sendState: SKIP (dc readyState=' + (this.dc && this.dc.readyState) + ', role=' + this.role + ')');
      }
    }

    docTitle() {
      try { return this.core.doc.title; } catch (_) { return ''; }
    }

    onMessage(msg) {
      if (!msg || typeof msg !== 'object') { console.log('[TMB-PAIR] onMessage: bad msg'); return; }
      console.log('[TMB-PAIR] onMessage: t=' + msg.t + ' url=' + msg.url + ' myPageKey=' + this.core.pageKey() + ' marks=' + (Array.isArray(msg.marks) ? msg.marks.length : null) + ' (role=' + this.role + ')');
      try {
      if (msg.t === 'bye') {
        this.status('idle', 'The other side ended the session.');
        this.core.lastRemoteIds = null;
        return;
      }
      if (msg.t !== 'state' || !Array.isArray(msg.marks)) return;
      if (msg.url !== this.core.pageKey()) {
        this.status('connected', 'Peer is on a different page — see Import.');
        if (this.ui && this.ui.panel) this.ui.panel.showForeign(msg.url, msg.title, msg.marks);
        return;
      }
      if (this.ui && this.ui.panel) this.ui.panel.showForeign(null);
      console.log('[TMB-PAIR] onMessage pre-merge: local=' + this.core.marks.length + ' remote=' + msg.marks.length + ' lastRemoteIds=' + (Array.isArray(this.core.lastRemoteIds) ? this.core.lastRemoteIds.length : this.core.lastRemoteIds));
      const res = mergeMarks(this.core.marks, msg.marks, this.core.lastRemoteIds);
      this.core.lastRemoteIds = msg.marks.map((m) => m.id);
      console.log('[TMB-PAIR] onMessage merge: added=' + res.added + ' updated=' + res.updated + ' removed=' + res.removed.length);
      if (res.added || res.updated || res.removed.length) {
        this.core.marks = res.marks;
        this.core.save().then(() => this.core.render());
        this.sendState(); // propagate deletions/edits back (no-op for the peer)
      }
      } catch (err) {
        console.log('[TMB-PAIR] onMessage INNER threw (role=' + this.role + '):', err && err.message || err, '\n', err && err.stack ? err.stack.split('\n').slice(0,4).join('\n') : '');
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
    .pill button.go {
      border: 0; background: #3b82f6; color: #fff; font-weight: 600;
      border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 13px;
    }
    .pill button.go.alt { background: #0e7490; }
    .card {
      position: fixed; z-index: 2147483647; display: none;
      background: #fff; color: #111827; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.3); font-size: 13px;
      max-width: 320px; padding: 10px 12px;
    }
    .card .q { color: #6b7280; font-size: 12px; margin: 0 0 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card .note { margin: 0 0 6px; white-space: pre-wrap; }
    .card .meta { color: #6b7280; font-size: 11px; }
    .card .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .card button, .panel button, .overlay button {
      border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; padding: 5px 11px; cursor: pointer; font-size: 12px;
    }
    .card button.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; font-weight: 600; }
    .card button.danger:hover { background: #fee2e2; border-color: #fca5a5; }
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

    /* ---- comments sidebar ---- */
    .sidebar {
      position: fixed; top: 0; right: 0; height: 100vh; width: min(400px, 92vw);
      display: none; flex-direction: column;
      background: #f8fafc; color: #111827;
      border-left: 1px solid #e2e8f0; box-shadow: -8px 0 24px rgba(0,0,0,.18);
      font-size: 13px; z-index: 2147483647;
    }
    .sb-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0; background: #fff; }
    .sb-head h3 { margin: 0; font-size: 14px; flex: 1; }
    .sb-count { color: #6b7280; font-size: 12px; }
    .sb-close { border: 0; background: transparent; font-size: 15px; cursor: pointer;
      padding: 4px 8px; border-radius: 6px; color: #475569; }
    .sb-close:hover { background: #e2e8f0; }
    .sb-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .sb-empty { color: #6b7280; font-size: 12px; padding: 24px 16px; text-align: center; margin: auto; }
    .sb-card { position: relative; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .sb-card.menu-open { z-index: 5; }
    .sb-card.active { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
    .sb-card-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      cursor: pointer; user-select: none; }
    .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
      border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
    .badge.comment { background: #dbeafe; color: #1e40af; }
    .badge.suggestion { background: #fef3c7; color: #92400e; }
    .badge.draft { background: #e0e7ff; color: #3730a3; }
    .sb-card-head .ctx { flex: 1; color: #374151; font-size: 12px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .sb-card-head .when { color: #6b7280; font-size: 11px; white-space: nowrap; }
    .sb-more { border: 0; background: transparent; cursor: pointer; color: #475569;
      font-size: 15px; line-height: 1; padding: 3px 6px; border-radius: 50%;
      width: 24px; height: 24px; flex: none; }
    .sb-more:hover { background: #e2e8f0; }
    .sb-more.open { background: #e2e8f0; }
    .sb-card-body { display: none; border-top: 1px solid #f1f5f9; padding: 10px 12px; }
    .sb-card.open .sb-card-body { display: block; }
    .sb-card .quote { margin: 0 0 8px; padding: 6px 8px; background: #fffbeb;
      border-left: 3px solid #fde68a; border-radius: 4px; color: #78350f;
      font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .sb-card.suggestion .quote { background: #fff7ed; border-left-color: #fdba74; }
    .prop-label { font-size: 11px; font-weight: 700; color: #6b7280; margin: 8px 0 4px;
      text-transform: uppercase; letter-spacing: .4px; }
    .prop { margin: 0 0 8px; padding: 6px 8px; background: #f0fdf4; border-left: 3px solid #86efac;
      border-radius: 4px; color: #14532d; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .prop-input { width: 100%; min-height: 64px; resize: vertical; padding: 6px 8px;
      border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; font-family: inherit; }
    .sb-msgs { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 8px; }
    .sb-msg { padding: 6px 8px; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 8px; }
    .sb-msg .who { font-size: 11px; color: #6b7280; margin-bottom: 2px; display: flex; gap: 6px; justify-content: space-between; }
    .sb-msg .who b { color: #334155; font-weight: 600; }
    .sb-msg .body { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; }
    .sb-none { color: #94a3b8; font-size: 12px; font-style: italic; margin: 4px 0 8px; }
    .sb-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .sb-row button, .sb-card .menu button, .sb-card .composer button {
      border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
    }
    .sb-row button.primary, .sb-card .menu button.primary, .sb-card .composer button.primary {
      background: #3b82f6; border-color: #3b82f6; color: #fff; font-weight: 600; }
    .sb-row button.danger:hover, .sb-card .menu button.danger:hover { background: #fee2e2; border-color: #fca5a5; }
    .composer { margin-top: 8px; }
    .composer textarea {
      width: 100%; min-height: 56px; resize: vertical; padding: 6px 8px;
      border: 1px solid #d1d5db; border-radius: 6px; font-size: 12.5px; font-family: inherit;
    }
    iframe.editor-frame {
      display: block; width: 100%; padding: 0; border: 0; border-radius: 6px;
      background: #fff; color-scheme: light;
    }
    .composer iframe.editor-frame { height: 70px; }
    iframe.editor-frame.prop-input { height: 78px; min-height: 78px; resize: none; }
    .pane iframe.editor-frame { height: 100px; margin: 0; }
    .sb-menu { position: absolute;
      background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 4px; min-width: 110px; z-index: 10; }
    .sb-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent;
      padding: 6px 10px; border-radius: 6px; font-size: 12.5px; cursor: pointer; color: #111827; }
    .sb-menu button:hover { background: #f1f5f9; }
    .sb-menu button.danger { color: #b91c1c; }
    .sb-menu button.danger:hover { background: #fee2e2; }
  `;

  class UI {
    constructor(core, pair) {
      this.core = core;
      this.pair = pair;
      core.ui = this;
      this.hosts = {};
      this.toastTimer = null;
      this._buildPill();
      this._buildCard();
      this._buildSidebar();
      this._buildPanel();
      this._buildToast();
      pair.setUI(this);
    }

    /** Local author identity (see localName() in the pure helpers). */
    localName() {
      return localName(this.pair ? this.pair.role : null);
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

    /**
     * Create a textarea in a separate extension-origin browsing context.
     * Native keyboard events terminate in that frame instead of traversing
     * the host page's window/document event path. The field value crosses an
     * extension-runtime Port broker, never a page-visible MessageEvent.
     */
    editor(root, cls, kind) {
      const frame = this.h(root, 'iframe', 'editor-frame' + (cls ? ' ' + cls : ''));
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      const state = {
        value: '', placeholder: '', readOnly: false, maxLength: 5000,
        kind: kind || 'text', version: 0, seq: -1,
        selectionStart: 0, selectionEnd: 0, ready: false, focusPending: false,
      };
      const reads = new Map();
      let nextReadId = 1;
      const port = browser.runtime.connect({ name: 'tmb-editor-core:' + id });
      const send = (msg) => {
        try { port.postMessage(msg); } catch (_) { /* editor is tearing down */ }
      };
      const snapshot = (type) => ({
        type,
        version: state.version,
        value: state.value,
        placeholder: state.placeholder,
        readOnly: state.readOnly,
        maxLength: state.maxLength,
        kind: state.kind,
        selectionStart: state.selectionStart,
        selectionEnd: state.selectionEnd,
      });
      const update = () => {
        state.version++;
        state.seq = -1;
        if (state.ready) send(snapshot('set-state'));
      };
      const directEvent = (name) => frame.dispatchEvent(new Event(name));

      Object.defineProperties(frame, {
        value: {
          get: () => state.value,
          set: (value) => {
            state.value = String(value == null ? '' : value).slice(0, state.maxLength);
            state.selectionStart = state.selectionEnd = state.value.length;
            update();
          },
        },
        placeholder: {
          get: () => state.placeholder,
          set: (value) => { state.placeholder = String(value == null ? '' : value).slice(0, 500); update(); },
        },
        readOnly: {
          get: () => state.readOnly,
          set: (value) => { state.readOnly = !!value; update(); },
        },
        maxLength: {
          get: () => state.maxLength,
          set: (value) => {
            const n = Number(value);
            if (Number.isSafeInteger(n) && n > 0 && n <= 10000) {
              state.maxLength = n;
              if (state.value.length > n) state.value = state.value.slice(0, n);
              update();
            }
          },
        },
      });
      frame.tmbFocus = () => {
        state.focusPending = true;
        try { HTMLIFrameElement.prototype.focus.call(frame); } catch (_) { /* fake DOM/unit parse */ }
        if (state.ready) send({ type: 'focus' });
      };
      frame.tmbSetSelectionRange = (start, end) => {
        state.selectionStart = Math.max(0, Math.min(state.value.length, Number(start) || 0));
        state.selectionEnd = Math.max(state.selectionStart, Math.min(state.value.length, Number(end) || 0));
        update();
      };
      frame.tmbReadValue = () => new Promise((resolve) => {
        if (!state.ready) { resolve(state.value); return; }
        const requestId = nextReadId++;
        const timer = setTimeout(() => {
          reads.delete(requestId);
          resolve(state.value);
        }, 1000);
        reads.set(requestId, { resolve, timer });
        send({ type: 'get-state', requestId });
      });
      frame.tmbDispose = () => {
        for (const pending of reads.values()) {
          clearTimeout(pending.timer);
          pending.resolve(state.value);
        }
        reads.clear();
        if (this.activeEditor === frame) this.activeEditor = null;
        try { port.disconnect(); } catch (_) { /* already disconnected */ }
      };
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          state.ready = true;
          send(snapshot('init'));
          if (state.focusPending) send({ type: 'focus' });
          return;
        }
        if (msg.type === 'input' && msg.version === state.version &&
            Number.isSafeInteger(msg.seq) && msg.seq > state.seq &&
            typeof msg.value === 'string' && msg.value.length <= state.maxLength) {
          state.seq = msg.seq;
          state.value = msg.value;
          state.selectionStart = msg.selectionStart;
          state.selectionEnd = msg.selectionEnd;
          this.lastEditorInput = Date.now();
          directEvent('input');
          if (this._sbRenderPending) this.scheduleSidebarRender();
        } else if (msg.type === 'selection' && msg.version === state.version &&
                   Number.isSafeInteger(msg.selectionStart) && Number.isSafeInteger(msg.selectionEnd)) {
          state.selectionStart = msg.selectionStart;
          state.selectionEnd = msg.selectionEnd;
        } else if (msg.type === 'focus') {
          this.activeEditor = frame;
          directEvent('tmb-focus');
        } else if (msg.type === 'blur') {
          if (this.activeEditor === frame) this.activeEditor = null;
          if (this._sbRenderPending) {
            clearTimeout(this._sbRenderTimer);
            this._sbRenderTimer = setTimeout(() => {
              if (this._sbRenderPending) this.renderSidebar(true);
            }, 50);
          }
        } else if (msg.type === 'state' && Number.isSafeInteger(msg.requestId)) {
          const pending = reads.get(msg.requestId);
          if (pending && msg.version === state.version && typeof msg.value === 'string') {
            clearTimeout(pending.timer);
            reads.delete(msg.requestId);
            state.value = msg.value.slice(0, state.maxLength);
            state.selectionStart = msg.selectionStart;
            state.selectionEnd = msg.selectionEnd;
            pending.resolve(state.value);
          }
        } else if (msg.type === 'action' && msg.action === 'submit') {
          directEvent('tmb-submit');
        } else if (msg.type === 'action' && msg.action === 'escape') {
          this.dismissSidebar();
          this.hidePanel();
        } else if (msg.type === 'action' && (msg.action === 'tab-next' || msg.action === 'tab-prev')) {
          this.moveEditorFocus(frame, msg.action === 'tab-next' ? 1 : -1);
        }
      });
      frame.setAttribute('data-tmb-editor', id);
      frame.setAttribute('title', kind === 'code' ? 'Pairshare code editor' : 'Pairshare text editor');
      frame.src = browser.runtime.getURL('editor.html') + '#' + id;
      return frame;
    }

    disposeEditors(container) {
      if (!container || !container.querySelectorAll) return;
      for (const editor of container.querySelectorAll('[data-tmb-editor]')) {
        if (editor.tmbDispose) editor.tmbDispose();
      }
    }

    moveEditorFocus(editor, direction) {
      const root = editor && editor.getRootNode ? editor.getRootNode() : null;
      if (!root || !root.querySelectorAll) return;
      const candidates = Array.from(root.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
        'iframe[data-tmb-editor]'
      )).filter((el) => el.isConnected && el.getClientRects && el.getClientRects().length);
      const at = candidates.indexOf(editor);
      const next = at >= 0 ? candidates[at + direction] : null;
      if (!next) return;
      if (next.tmbFocus) next.tmbFocus();
      else if (next.focus) next.focus();
    }

    scheduleSidebarRender() {
      clearTimeout(this._sbRenderTimer);
      const quietFor = Date.now() - (this.lastEditorInput || 0);
      const delay = Math.max(0, 300 - quietFor);
      this._sbRenderTimer = setTimeout(() => {
        if (!this._sbRenderPending) return;
        const nowQuiet = Date.now() - (this.lastEditorInput || 0);
        if (nowQuiet < 300) this.scheduleSidebarRender();
        else this.renderSidebar(true);
      }, delay);
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
      // Two explicit actions: Comment (default primary) and Suggest edit.
      // Highlights are always yellow — no color picker.
      const comment = this.h(root, 'button', 'go', '💬 Comment');
      comment.setAttribute('data-el', 'comment');
      const suggest = this.h(root, 'button', 'go alt', '✏️ Suggest edit');
      suggest.setAttribute('data-el', 'suggest');
      comment.addEventListener('mousedown', (e) => e.preventDefault());
      suggest.addEventListener('mousedown', (e) => e.preventDefault());
      comment.addEventListener('click', () => {
        this.hidePill();
        this.core.createMarkFromSelection('comment');
      });
      suggest.addEventListener('click', () => {
        this.hidePill();
        this.core.createMarkFromSelection('suggestion');
      });
      pill.appendChild(comment);
      pill.appendChild(suggest);
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
      const anc = range.commonAncestorContainer;
      // Selections inside our own shadow UI (sidebar composers, panel
      // inputs) are not page selections. (Checking the sidebar's focused
      // element instead would wrongly suppress the pill when the user selects
      // page text while a composer still holds focus.)
      if (this.inOwnUI(anc)) return this.hidePill();
      if (!doc.body || !doc.body.contains(anc)) return this.hidePill();
      if (range.toString().trim().length === 0) return this.hidePill();
      const rect = range.getBoundingClientRect();
      this.pillEl.style.display = 'flex';
      this.pillEl.style.left = Math.max(4, rect.left + rect.width / 2 - 90) + 'px';
      this.pillEl.style.top = Math.min(rect.bottom + 6, doc.defaultView.innerHeight - 44) + 'px';
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
      const openBtn = this.h(root, 'button', 'primary', 'Open thread');
      openBtn.setAttribute('data-el', 'open');
      const close = this.h(root, 'button', null, 'Close');
      row.appendChild(openBtn);
      row.appendChild(close);
      box.appendChild(q);
      box.appendChild(note);
      box.appendChild(meta);
      box.appendChild(row);
      root.appendChild(box);

      let hoverTimer = null;
      let currentMark = null;

      const show = (mark, anchorEl) => {
        currentMark = mark;
        q.textContent = '“' + mark.quote.slice(0, 120) + (mark.quote.length > 120 ? '…' : '') + '”';
        if (mark.kind === 'suggestion') {
          note.textContent = 'Proposed: “' + String(mark.proposed || '').slice(0, 160) + (String(mark.proposed || '').length > 160 ? '…' : '') + '”';
          note.style.display = '';
        } else {
          const msgs = Array.isArray(mark.messages) ? mark.messages : [];
          const last = msgs[msgs.length - 1];
          if (last && last.body) {
            note.textContent = last.body;
            note.style.display = '';
          } else {
            note.textContent = '(no comment yet)';
            note.style.display = '';
          }
        }
        const n = Array.isArray(mark.messages) ? mark.messages.length : 0;
        meta.textContent = (mark.name || displayName(mark.author)) + ' · ' + fmtTime(mark.ts) +
          (mark.kind === 'suggestion' ? ' · suggestion' : n > 1 ? ' · ' + n + ' comments' : n === 1 ? ' · 1 comment' : '');
        box.style.display = 'block';
        this.positionCard(anchorEl);
      };
      const hide = () => {
        box.style.display = 'none';
        currentMark = null;
      };

      openBtn.addEventListener('click', () => {
        const mark = currentMark; // capture: hide() clears currentMark
        if (!mark) return;
        hide();
        this.openThread(mark.id);
      });
      close.addEventListener('click', hide);

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
        const id = hl.getAttribute(ID_ATTR);
        // Clicking a highlight opens its thread in the sidebar (the hover
        // card stays available for a quick peek without switching focus).
        this._sbHideMenu();
        this.openThread(id);
      }, true);
      this.doc().addEventListener('mousedown', (e) => {
        if (box.style.display === 'block' && !this.insideHost('card', e) && !this.isHighlight(e.target)) {
          hide();
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

    /* ---- comments sidebar ---- */

    /** True when a node lives inside one of our shadow-UI hosts (walking
     *  across shadow boundaries). Used to keep the pill away from selections
     *  made inside our own composers/inputs. */
    inOwnUI(node) {
      if (!node) return false;
      const hosts = Object.values(this.hosts);
      let n = node.nodeType === 1 ? node : (node.parentElement || null);
      let root = node.getRootNode ? node.getRootNode() : null;
      while (n || (root && root.nodeType === Node.DOCUMENT_FRAGMENT_ROOT)) {
        if (n && hosts.includes(n)) return true;
        if (root && hosts.includes(root.host)) return true;
        n = n ? n.parentElement : (root.host ? root.host.parentElement : null);
        root = root && root.nodeType === Node.DOCUMENT_FRAGMENT_ROOT && root.host && root.host.getRootNode
          ? root.host.getRootNode() : null;
      }
      return false;
    }

    _buildSidebar() {
      const root = this.host('sidebar');
      const aside = this.h(root, 'aside', 'sidebar');
      aside.setAttribute('data-el', 'aside');
      const head = this.h(root, 'div', 'sb-head');
      const title = this.h(root, 'h3', null, 'Comments & suggestions');
      const count = this.h(root, 'span', 'sb-count');
      count.setAttribute('data-el', 'count');
      const close = this.h(root, 'button', 'sb-close', '✕');
      close.setAttribute('data-el', 'close');
      close.title = 'Close sidebar';
      head.appendChild(title);
      head.appendChild(count);
      head.appendChild(close);
      const list = this.h(root, 'div', 'sb-list');
      list.setAttribute('data-el', 'list');
      const empty = this.h(root, 'div', 'sb-empty');
      empty.setAttribute('data-el', 'empty');
      empty.textContent = 'Nothing here yet. Select some text, then choose Comment or Suggest edit.';
      aside.appendChild(head);
      aside.appendChild(list);
      aside.appendChild(empty);
      root.appendChild(aside);

      // Shared action menu (Edit / Delete) shown next to a card's ⋮ button.
      const menu = this.h(root, 'div', 'sb-menu');
      menu.setAttribute('data-el', 'menu');
      menu.style.display = 'none';
      const mEdit = this.h(root, 'button', null, 'Edit');
      mEdit.setAttribute('data-el', 'menu-edit');
      const mDel = this.h(root, 'button', 'danger', 'Delete');
      mDel.setAttribute('data-el', 'menu-delete');
      menu.appendChild(mEdit);
      menu.appendChild(mDel);
      root.appendChild(menu);

      // State that must survive re-renders while the user is composing.
      this.sbOpenIds = new Set();        // expanded cards
      this.sbComposing = null;           // { id, mode } — active composer session
      this.sbFocusKey = null;            // { id, mode } — last-focused composer
      this.sbComposerDrafts = {};        // id -> { mode, value }
      this.sbMenuFor = null;             // id of the card whose menu is open
      this.sbMenuMark = null;            // the mark of the card whose menu is open
      this.sbActiveId = null;            // most-recently-opened card (highlight)
      this._sbAside = aside;
      this._sbList = list;
      this._sbEmpty = empty;
      this._sbCount = count;
      this._sbMenu = menu;
      this._sbMenuEdit = mEdit;
      this._sbMenuDelete = mDel;

      close.addEventListener('click', () => this.closeSidebar());
      mEdit.addEventListener('click', () => this._sbMenuAction('edit'));
      mDel.addEventListener('click', () => this._sbMenuAction('delete'));
      list.addEventListener('focusin', (e) => {
        const t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-el') === 'composer') {
          this.sbFocusKey = { id: t.getAttribute('data-id'), mode: t.getAttribute('data-mode') };
        }
      });
      list.addEventListener('scroll', () => this._sbHideMenu(), { passive: true });
      this.doc().addEventListener('mousedown', (e) => {
        if (this.sbMenuFor && !this.insideHost('sidebar', e) &&
            !(e.target && e.target.closest && e.target.closest('[' + ID_ATTR + ']'))) {
          this._sbHideMenu();
        }
      });
    }

    /** Escape: close the action menu, then the sidebar if open. In-progress
     *  composer drafts are kept, so re-opening restores what was typed. */
    dismissSidebar() {
      this._sbHideMenu();
      if (this.sidebarOpen()) this.closeSidebar();
    }

    sidebarOpen() {
      return !!this._sbAside && this._sbAside.style.display === 'flex';
    }
    openSidebar() {
      if (!this._sbAside) return;
      this._sbAside.style.display = 'flex';
      this.renderSidebar();
    }
    closeSidebar() {
      if (!this._sbAside) return;
      this._sbAside.style.display = 'none';
      this._sbHideMenu();
      this.sbMenuFor = null;
    }
    toggleSidebar() {
      if (this.sidebarOpen()) this.closeSidebar(); else this.openSidebar();
    }

    /**
     * Render (or re-render) the sidebar list from core.marks in document
     * order. Preserves which cards are expanded and any in-progress composer
     * drafts/focus so a peer sync or local save does not wipe what the user
     * is typing.
     */
    renderSidebar(force) {
      if (!this._sbList) return;
      if (!force && this.activeEditor && this.activeEditor.isConnected) {
        this._sbRenderPending = true;
        this.scheduleSidebarRender();
        return;
      }
      this._sbRenderPending = false;
      clearTimeout(this._sbRenderTimer);
      const marks = sortedThreads(this.core.marks || []);
      this._sbCount.textContent = marks.length ? String(marks.length) : '';
      this._sbEmpty.style.display = marks.length ? 'none' : '';
      this.disposeEditors(this._sbList);
      this._sbList.textContent = '';
      for (const m of marks) this._sbList.appendChild(this._sbCard(m));
      if (this.sbMenuFor) this._sbHideMenu();
      // Restore focus to the composer the user was typing in, if still present.
      const key = this.sbFocusKey || (this.sbComposing ? { id: this.sbComposing.id, mode: this.sbComposing.mode } : null);
      if (key) {
        const ta = this._sbList.querySelector('[data-el="composer"][data-id="' + key.id + '"][data-mode="' + key.mode + '"]');
        if (ta && ta.tmbFocus) {
          const d = this.sbComposerDrafts[key.id];
          if (d && d.mode === key.mode && d.value != null) ta.value = d.value;
          ta.tmbFocus();
          ta.tmbSetSelectionRange(ta.value.length, ta.value.length);
        }
      }
    }

    _sbCard(m) {
      const root = this.host('sidebar');
      const isSug = m.kind === 'suggestion';
      const open = this.sbOpenIds.has(m.id);
      const card = this.h(root, 'div', 'sb-card' + (isSug ? ' suggestion' : '') + (open ? ' open' : '') + (m.id === this.sbActiveId ? ' active' : ''));
      card.setAttribute('data-el', 'card');
      card.setAttribute('data-id', m.id);

      // header: badge · quote excerpt · author/time · ⋮
      const head = this.h(root, 'div', 'sb-card-head');
      const badge = this.h(root, 'span', 'badge ' + (isSug ? 'suggestion' : 'comment'), isSug ? 'Suggestion' : 'Comment');
      const ctx = this.h(root, 'span', 'ctx', '“' + trunc(m.quote, 64) + '”');
      const nMsg = Array.isArray(m.messages) ? m.messages.length : 0;
      const when = this.h(root, 'span', 'when', (m.name || displayName(m.author)) + ' · ' + fmtTime(m.ts) + (isSug ? '' : (nMsg ? ' · ' + nMsg + (nMsg === 1 ? ' comment' : ' comments') : '')));
      const more = this.h(root, 'button', 'sb-more', '⋮');
      more.setAttribute('data-el', 'more');
      more.title = 'Actions';
      more.setAttribute('aria-label', 'Actions');
      head.appendChild(badge);
      head.appendChild(ctx);
      head.appendChild(when);
      head.appendChild(more);

      // body: quote, (proposed), messages, composer
      const body = this.h(root, 'div', 'sb-card-body');
      const quote = this.h(root, 'p', 'quote', '“' + m.quote + '”');
      body.appendChild(quote);

      if (isSug) {
        const pLabel = this.h(root, 'div', 'prop-label', 'Proposed replacement');
        const draft = this.sbComposerDrafts[m.id];
        const composing = this.sbComposing && this.sbComposing.id === m.id && this.sbComposing.mode === 'suggested';
        body.appendChild(pLabel);
        if (composing || (draft && draft.mode === 'suggested')) {
          const ta = this.editor(root, 'prop-input', 'text');
          ta.setAttribute('data-el', 'composer');
          ta.setAttribute('data-id', m.id);
          ta.setAttribute('data-mode', 'suggested');
          ta.maxLength = 5000;
          ta.value = (draft && draft.value != null) ? draft.value : (m.proposed || m.quote);
          body.appendChild(ta);
          const row = this.h(root, 'div', 'sb-row');
          const submit = this.h(root, 'button', 'primary', 'Submit suggestion');
          submit.setAttribute('data-el', 'submit');
          const cancel = this.h(root, 'button', null, 'Cancel');
          cancel.setAttribute('data-el', 'cancel');
          row.appendChild(submit);
          row.appendChild(cancel);
          body.appendChild(row);
        } else {
          const prop = this.h(root, 'p', 'prop', '“' + (m.proposed ? m.proposed : '(not submitted yet)') + '”');
          body.appendChild(prop);
        }
      }

      const msgs = Array.isArray(m.messages) ? m.messages : [];
      if (msgs.length) {
        const wrap = this.h(root, 'div', 'sb-msgs');
        for (const msg of msgs) {
          const el = this.h(root, 'div', 'sb-msg');
          const who = this.h(root, 'div', 'who', '');
          const nm = this.h(root, 'b', null, msg.name || displayName(m.author));
          const tm = this.h(root, 'span', null, fmtTime(msg.ts));
          who.appendChild(nm);
          who.appendChild(tm);
          const bodyEl = this.h(root, 'div', 'body', msg.body || '');
          el.appendChild(who);
          el.appendChild(bodyEl);
          wrap.appendChild(el);
        }
        body.appendChild(wrap);
      } else if (!isSug) {
        body.appendChild(this.h(root, 'div', 'sb-none', 'No comments yet.'));
      }

      // reply composer — always visible: threads accumulate replies over time
      const cDraft = this.sbComposerDrafts[m.id];
      const comp = this.h(root, 'div', 'composer');
      const ta = this.editor(root, null, 'text');
      ta.setAttribute('data-el', 'composer');
      ta.setAttribute('data-id', m.id);
      ta.setAttribute('data-mode', 'message');
      ta.maxLength = 5000;
      ta.placeholder = isSug ? 'Add a comment to this suggestion…' : 'Add a comment…';
      ta.value = (cDraft && cDraft.mode === 'message' && cDraft.value != null) ? cDraft.value : '';
      const row = this.h(root, 'div', 'sb-row');
      const post = this.h(root, 'button', 'primary', isSug ? 'Comment' : 'Reply');
      post.setAttribute('data-el', 'post');
      const cancel = this.h(root, 'button', null, 'Cancel');
      cancel.setAttribute('data-el', 'cancel');
      row.appendChild(post);
      row.appendChild(cancel);
      comp.appendChild(ta);
      comp.appendChild(row);
      body.appendChild(comp);

      card.appendChild(head);
      card.appendChild(body);

      // header toggles expand/collapse (but a click on ⋮ must not)
      head.addEventListener('click', (e) => {
        if (e.target === more) return;
        this._sbToggle(m.id, card);
      });
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this._sbShowMenu(m, more);
      });

      // wire up composers / action buttons in this card
      const sugTa = body.querySelector('[data-el="composer"][data-mode="suggested"]');
      if (sugTa) {
        const submit = body.querySelector('[data-el="submit"]');
        const cancel = body.querySelector('[data-el="cancel"]');
        submit.addEventListener('click', () => this._sbSubmitSuggestion(m.id, sugTa));
        cancel.addEventListener('click', () => this._sbCancelSuggested(m.id));
        sugTa.addEventListener('input', () => {
          this.sbComposerDrafts[m.id] = { mode: 'suggested', value: sugTa.value };
        });
        sugTa.addEventListener('tmb-submit', () => this._sbSubmitSuggestion(m.id, sugTa));
        sugTa.addEventListener('tmb-focus', () => {
          this.sbFocusKey = { id: m.id, mode: 'suggested' };
        });
      }
      const msgTa = body.querySelector('[data-el="composer"][data-mode="message"]');
      if (msgTa) {
        const post = body.querySelector('[data-el="post"]');
        const cancel = body.querySelector('[data-el="cancel"]');
        post.addEventListener('click', () => this._sbPostMessage(m.id, msgTa));
        cancel.addEventListener('click', () => {
          msgTa.value = '';
          delete this.sbComposerDrafts[m.id];
        });
        msgTa.addEventListener('input', () => {
          this.sbComposerDrafts[m.id] = { mode: 'message', value: msgTa.value };
        });
        msgTa.addEventListener('tmb-submit', () => this._sbPostMessage(m.id, msgTa));
        msgTa.addEventListener('tmb-focus', () => {
          this.sbFocusKey = { id: m.id, mode: 'message' };
        });
      }
      return card;
    }

    _sbToggle(id, card) {
      if (this.sbOpenIds.has(id)) {
        this.sbOpenIds.delete(id);
        if (card) card.classList.remove('open');
      } else {
        this.sbOpenIds.add(id);
        if (card) card.classList.add('open');
      }
    }

    _sbFindCard(id) {
      return this._sbList && this._sbList.querySelector ? this._sbList.querySelector('[data-el="card"][data-id="' + id + '"]') : null;
    }

    _sbShowMenu(m, anchorEl) {
      if (this.sbMenuFor === m.id) { this._sbHideMenu(); return; }
      this._sbHideMenu();
      this.sbMenuFor = m.id;
      this.sbMenuMark = m;
      const menu = this._sbMenu;
      const root = this.host('sidebar');
      // Re-parent the menu into the card so it is positioned relative to the
      // card (the card is position:relative) and scrolls with it.
      const card = this._sbFindCard(m.id);
      if (card) card.appendChild(menu); else root.appendChild(menu);
      if (card && card.classList) card.classList.add('menu-open');
      menu.style.display = 'block';
      const r = anchorEl.getBoundingClientRect();
      const cr = card ? card.getBoundingClientRect() : this._sbAside.getBoundingClientRect();
      // position just below the ⋮ button
      menu.style.top = (r.bottom - cr.top + 4) + 'px';
      menu.style.left = Math.max(4, r.left - cr.left) + 'px';
    }

    _sbHideMenu() {
      if (this._sbMenu) {
        this._sbMenu.style.display = 'none';
        const card = this._sbMenu.parentNode;
        if (card && card.classList && card.classList.contains('menu-open')) card.classList.remove('menu-open');
      }
      this.sbMenuFor = null;
    }

    _sbMenuAction(action) {
      const m = this.sbMenuMark;
      this._sbHideMenu();
      if (!m) return;
      if (action === 'delete') {
        this._sbClearComposing(m.id);
        this.core.deleteMark(m.id);
        this.renderSidebar();
      } else if (action === 'edit') {
        if (m.kind === 'suggestion') {
          this.sbComposing = { id: m.id, mode: 'suggested' };
          this.sbComposerDrafts[m.id] = { mode: 'suggested', value: m.proposed || m.quote };
        } else {
          this.sbComposing = { id: m.id, mode: 'message' };
          this.sbFocusKey = { id: m.id, mode: 'message' };
        }
        this.sbOpenIds.add(m.id);
        this.renderSidebar();
        const card = this._sbFindCard(m.id);
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
      }
    }

    _sbClearComposing(id) {
      if (this.sbComposing && this.sbComposing.id === id) this.sbComposing = null;
      if (this.sbFocusKey && this.sbFocusKey.id === id) this.sbFocusKey = null;
      delete this.sbComposerDrafts[id];
    }

    async _sbSubmitSuggestion(id, ta) {
      const raw = ta.tmbReadValue ? await ta.tmbReadValue() : ta.value;
      const value = (raw || '').trim();
      if (!value) { this.toast('Type the proposed replacement first'); return; }
      const m = this.core.marks.find((x) => x.id === id);
      if (!m) return;
      this.core.updateThread(id, (t) => Object.assign({}, t, { proposed: value }));
      this._sbClearComposing(id);
      if (this.sbFocusKey && this.sbFocusKey.id === id) this.sbFocusKey = null;
      this.sbOpenIds.add(id);
      this.renderSidebar(true);
    }

    async _sbPostMessage(id, ta) {
      const raw = ta.tmbReadValue ? await ta.tmbReadValue() : ta.value;
      const value = (raw || '').trim();
      if (!value) { this.toast('Write a comment first'); return; }
      this.core.updateThread(id, (t) => appendMessage(t, value, this.localName(), Date.now()));
      // Keep the composer focused for follow-up replies in the same thread.
      delete this.sbComposerDrafts[id];
      this.sbOpenIds.add(id);
      this.renderSidebar(true);
    }

    _sbCancelSuggested(id) {
      const m = this.core.marks.find((x) => x.id === id);
      this._sbClearComposing(id);
      // A suggestion that was never submitted and has no discussion is pure
      // noise — discard the whole thread. Anything with content just closes
      // the composer.
      if (m && m.kind === 'suggestion' && !(m.proposed || '').trim() && !(Array.isArray(m.messages) && m.messages.length)) {
        this.core.deleteMark(id);
      }
      this.renderSidebar(true);
    }

    /** Open the sidebar and expand + focus a specific thread. */
    openThread(id, opts) {
      opts = opts || {};
      this.openSidebar();
      this.sbActiveId = id;
      this.sbOpenIds.add(id);
      if (opts.compose) {
        const m = this.core.marks.find((x) => x.id === id);
        if (m) {
          if (m.kind === 'suggestion') {
            this.sbComposing = { id, mode: 'suggested' };
            this.sbFocusKey = { id, mode: 'suggested' };
            this.sbComposerDrafts[id] = { mode: 'suggested', value: m.quote };
          } else {
            this.sbComposing = { id, mode: 'message' };
            this.sbFocusKey = { id, mode: 'message' };
          }
        }
      }
      this.renderSidebar(true);
      const card = this._sbFindCard(id);
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
      return card;
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
      const inviteOut = this.editor(root, null, 'code');
      inviteOut.setAttribute('data-el', 'invite-out');
      inviteOut.readOnly = true;
      inviteOut.placeholder = 'invite code appears here…';
      const copyInv = this.h(root, 'button', null, 'Copy invite code');
      const joinIn = this.editor(root, null, 'code');
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
      const invIn = this.editor(root, null, 'code');
      invIn.setAttribute('data-el', 'invite-in');
      invIn.placeholder = 'paste the invite code…';
      const genJoin = this.h(root, 'button', 'primary', '2. Create join code');
      genJoin.setAttribute('data-el', 'gen-join');
      const joinOut = this.editor(root, null, 'code');
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
          const code = joinIn.tmbReadValue ? await joinIn.tmbReadValue() : joinIn.value;
          await this.pair.acceptJoin(code);
          this.toast('Connecting… waiting for the data channel');
        } catch (e) {
          this.toast(e.message);
        }
        busy(connect, false);
      });
      genJoin.addEventListener('click', async () => {
        busy(genJoin, true);
        try {
          const inviteCode = invIn.tmbReadValue ? await invIn.tmbReadValue() : invIn.value;
          const code = await this.pair.makeJoin(inviteCode);
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
  /**
   * Resolve the current window selection to a slice of the flattened page
   * text. Returns { s, e, quote, pre, post } or null.
   */
  Core.prototype.selectionSlice = function () {
    const doc = this.doc;
    const sel = doc.defaultView.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const sp = D.resolvePoint(range.startContainer, range.startOffset);
    const ep = D.resolvePoint(range.endContainer, range.endOffset);
    if (!sp || !ep) return null;
    const idx = this.index();
    const s = nodeOffsetInIdx(idx, sp[0], sp[1]);
    const e = nodeOffsetInIdx(idx, ep[0], ep[1]);
    if (s < 0 || e < 0 || s >= e) return null;
    const quote = idx.text.slice(s, e);
    if (!quote.trim()) return null;
    return {
      s, e, quote,
      pre: idx.text.slice(Math.max(0, s - 40), s),
      post: idx.text.slice(e, e + 40),
      text: idx.text,
    };
  };

  /**
   * Create a thread (comment or edit suggestion) anchored to the current
   * selection. kind: 'comment' | 'suggestion'. The mark is created
   * immediately (so the yellow highlight appears and the thread is tied to
   * this exact selection); the user then composes in the sidebar — the first
   * comment / proposed replacement is still pending. Returns { mark } or null.
   */
  Core.prototype.createMarkFromSelection = function (kind) {
    if (!this.marks) return null;
    const doc = this.doc;
    const slice = this.selectionSlice();
    if (!slice) return null;
    if (slice.quote.length > 5000) {
      this.ui && this.ui.toast('Selection too long to mark (max 5000 chars)');
      return null;
    }
    const name = this.ui ? this.ui.localName() : AUTHORS.me;
    const id = uid();
    const mark = {
      id,
      kind: kind === 'suggestion' ? 'suggestion' : 'comment',
      quote: slice.quote,
      pre: slice.pre,
      post: slice.post,
      offset: slice.s,
      note: '',
      messages: [],
      proposed: '',
      author: LOCAL_ROLE,
      name,
      ts: Date.now(),
      color: DEFAULT_COLOR,
    };
    const r = this.locate(mark, this.index());
    if (!r) return null;
    const wrappers = D.wrap(doc, r, id, mark.color);
    if (!wrappers.length) return null;
    this.marks.push(mark);
    const sel = doc.defaultView.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    this.save();
    this.emitChange();
    if (this.ui) this.ui.openThread(id, { compose: true });
    return { mark };
  };

  /**
   * Apply a pure mutation to a live thread by id and persist.
   * `mutate(thread) -> thread'` (use the pure helpers: appendMessage,
   * updateMessage, deleteMessage, or Object.assign for e.g. `proposed`).
   * The thread is looked up by id because `this.marks` may have been
   * replaced wholesale by the storage.onChanged reload (the same stale-
   * reference race that bit version_a — 48f4efb — and version_b 0.2.3).
   */
  Core.prototype.updateThread = function (id, mutate) {
    const live = this.marks.find((m) => m.id === id);
    if (!live) return false;
    let next;
    try {
      next = mutate(live);
    } catch (err) {
      console.log('[TMB] updateThread mutate threw:', err && err.message || err);
      return false;
    }
    if (!next || next === live) return true;
    const i = this.marks.indexOf(live);
    this.marks[i] = Object.assign({}, next, { id: live.id, ts: Date.now() });
    this.save().then(() => this.emitChange());
    return true;
  };

  Core.prototype.deleteMark = function (id) {
    this.marks = this.marks.filter((m) => m.id !== id);
    D.unwrap(this.doc, id);
    this.save().then(() => this.emitChange());
  };

  Core.prototype.render = function () {
    const doc = this.doc;
    D.clearAll(doc);
    this.failed = [];
    for (const m of this.marks) {
      if (!this.wrapOne(m)) this.failed.push(m);
    }
    console.log('[TMB-PAIR] render: total=' + this.marks.length + ' rendered=' + (this.marks.length - this.failed.length) + ' failed=' + this.failed.length);
    if (this.ui && this.ui.renderSidebar) this.ui.renderSidebar();
    this.scheduleRetry();
  };

  // Wrap a single mark from a FRESH index. Wrapping earlier marks splits text
  // nodes via splitText(), which truncates the .data of the node objects an
  // older idx still references — so locate() on a stale idx throws
  // IndexSizeError and the mark silently fails to render. Rebuilding the
  // index per mark is safe (highlight spans add no text, so raw page-text
  // offsets stay identical) and only O(n) total across a page's few marks.
  // Same root cause + fix as version_a (see wrapOne there).
  Core.prototype.wrapOne = function (m, prefix) {
    const idx = this.index();
    const r = this.locate(m, idx);
    if (!r) return false;
    D.wrap(this.doc, r, prefix ? prefix + m.id : m.id, m.color);
    return true;
  };

  Core.prototype.scheduleRetry = function () {
    if (!this.failed.length || this.retry >= this.maxRetries) return;
    this.retry++;
    setTimeout(() => {
      const still = [];
      for (const m of this.failed) {
        if (!this.wrapOne(m)) still.push(m);
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

  /* ---------------- page-level (light DOM) styles ---------------- */

  function injectPageCSS() {
    const doc = document;
    if (doc.getElementById('tmb-page-css')) return;
    // Build a rule per marker color so highlights are actually visible.
    // Without this the .tmb-hl spans exist in the DOM (hover/click work) but
    // have no background — they are invisible. (version_a injects the
    // equivalent in its own injectPageCSS.)
    let rules = '';
    for (const name of COLOR_NAMES) {
      const c = COLORS[name];
      rules +=
        '.tmb-hl[data-tmb-color="' + name + '"]{background-color:' + c.bg +
        '!important;border-radius:2px;box-shadow:inset 0 -2px 0 ' + c.edge +
        ';cursor:pointer;}';
    }
    const st = doc.createElement('style');
    st.id = 'tmb-page-css';
    st.setAttribute(SKIP, '');
    st.textContent = rules;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    injectPageCSS();
    const doc = document;
    const core = new Core(doc);
    const pair = new Pair(core);
    const ui = new UI(core, pair);

    core.load().then(() => {
      core.render();
      ui.updatePill();
      doc.documentElement.setAttribute('data-tmb-ready', '');
    });

    doc.addEventListener('selectionchange', () => {
      ui.updatePill();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ui.dismissSidebar();
        ui.hidePanel();
      }
    });

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return sendResponse({ ok: false });
      if (msg.type === 'tmb:toggle-panel') {
        ui.panel.toggle();
      } else if (msg.type === 'tmb:command') {
        if (msg.cmd === 'comment') core.createMarkFromSelection('comment');
        else if (msg.cmd === 'toggle-sidebar') ui.toggleSidebar();
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
