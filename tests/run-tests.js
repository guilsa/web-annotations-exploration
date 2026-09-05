#!/usr/bin/env node
/* Test runner for the Textmarker variants. No dependencies.
 * Usage: node tests/run-tests.js [a|b|c|all]
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error('assert: ' + (msg || 'condition false'));
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((msg || 'eq') + '\n      got:  ' + ja + '\n      want: ' + jb);
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ------------------------------------------------------------------ */
/* Shared environment loader for a content script under a fake DOM     */
/* ------------------------------------------------------------------ */

function loadContentScript(file, testFlag, expose) {
  const { makeDocument } = require('./fake-dom');
  const doc = makeDocument();
  const previous = {
    window: global.window,
    document: global.document,
    browser: global.browser,
    flag: globalThis[testFlag],
  };
  global.window = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
    getSelection: () => null,
  };
  global.document = doc;
  global.browser = {
    runtime: {
      onMessage: { addListener() {} },
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
  globalThis[testFlag] = true;
  try {
    (0, eval)(fs.readFileSync(file, 'utf8'));
  } finally {
    globalThis[testFlag] = previous.flag;
  }
  return { doc, api: globalThis[expose] };
}

/* Serialize a fake-DOM tree to a comparable string. */
function structure(node) {
  if (!node) return '∅';
  if (node.nodeType === 3) return '«' + node.data + '»';
  return '<' + node.tagName.toLowerCase() + (node.getAttribute('data-x-id') ? ' x=' + node.getAttribute('data-x-id') : '') + '>' +
    node.childNodes.map(structure).join('') + '</' + node.tagName.toLowerCase() + '>';
}

/* ------------------------------------------------------------------ */
/* VERSION A                                                           */
/* ------------------------------------------------------------------ */

function testA() {
  section('version_a');
  const file = path.join(__dirname, '..', 'version_a', 'content.js');
  const { doc, api: dom } = loadContentScript(file, '__TMA_TEST__', '__TMA_DOM');
  const P = globalThis.__TMA_PURE;

  test('pure: squeeze + squeezeMap', () => {
    eq(P.squeeze('  a b\nc  d '), 'abcd');
    const { text, map } = P.squeezeMap('ab cd\nef');
    eq(text, 'abcdef');
    eq(map, [0, 1, 3, 4, 6, 7]);
  });

  test('pure: findOffsets exact at saved offset', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const mark = { quote: 'brown fox', offset: 10, pre: 'quick ', post: ' jumps' };
    eq(P.findOffsets(text, mark), [10, 19]);
  });

  test('pure: findOffsets whitespace-insensitive at saved offset', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const mark = { quote: 'brown  fox', offset: 10, pre: '', post: '' };
    eq(P.findOffsets(text, mark), [10, 19]);
  });

  test('pure: findOffsets re-locates after text inserted before it', () => {
    const mark = { quote: 'gamma delta', offset: 11, pre: 'beta ', post: '' };
    const modified = 'Alpha NEW WORDS inserted beta gamma delta.';
    eq(P.findOffsets(modified, mark), [30, 41]);
  });

  test('pure: findOffsets picks context-matching occurrence over distance', () => {
    const text = 'apple apple apple apple apple';
    // two "apple"s; context disambiguates to the 4th one (index 24)
    const mark = { quote: 'apple', offset: 24, pre: 'apple apple ', post: ' apple' };
    eq(P.findOffsets(text, mark), [24, 29]);
  });

  test('pure: findOffsets trusts exact match at saved offset, else rejects ambiguous', () => {
    const text = 'the the the the';
    // matches at saved offset -> trust it
    eq(P.findOffsets(text, { quote: 'the', offset: 4, pre: '', post: '' }), [4, 7]);
    // quote appears 3x, saved offset is wrong, no context -> ambiguous -> null
    eq(P.findOffsets('abc X abc Y abc', { quote: 'abc', offset: 5, pre: '', post: '' }), null);
  });

  test('pure: findOffsets unique occurrence without context', () => {
    const text = 'lorem ipsum dolor sit amet';
    const mark = { quote: 'dolor', offset: 999, pre: '', post: '' };
    eq(P.findOffsets(text, mark), [12, 17]);
  });

  test('pure: findOffsets re-attaches leading whitespace of the quote', () => {
    const text = 'one two three four five';
    // quote starts with a space; saved offset is stale (page changed)
    const mark = { quote: ' three four', offset: 999, pre: '', post: '' };
    eq(P.findOffsets(text, mark), [7, 18]);
    eq(text.slice(7, 18), ' three four');
  });

  test('pure: b64 unicode round-trip', () => {
    const s = 'héllo wörld — 日本語 📝';
    eq(P.b64dec(P.b64enc(s)), s);
  });

  test('pure: composeShareUrl / extractShareData round-trips', () => {
    const data = { v: 1, url: 'https://x.test/page', title: 'T', author: 'me', ts: 123, marks: [{ id: '1', quote: 'q', note: 'n ü' }] };
    // no existing fragment
    let url = P.composeShareUrl('https://x.test/page', '', data);
    assert(/^https:\/\/x\.test\/page#tmc=/.test(url), 'url shape: ' + url);
    const frag1 = url.slice(url.indexOf('#'));
    eq(P.extractShareData(frag1), data);
    // with existing fragment
    url = P.composeShareUrl('https://x.test/page', '#section-2', data);
    assert(url.startsWith('https://x.test/page#section-2&tmc='), 'url shape: ' + url);
    eq(P.extractShareData(url.slice(url.indexOf('#'))), data);
    // replacing an existing tmc param
    const url2 = P.composeShareUrl('https://x.test/page', '#tmc=OLD', data);
    assert(!url2.includes('tmc=OLD'), 'old tmc removed');
    eq(P.extractShareData(url2.slice(url2.indexOf('#'))), data);
    // garbage in -> null
    eq(P.extractShareData('#tmc=%%%notbase64%%%'), null);
    eq(P.extractShareData(''), null);
  });

  /* ---------- DOM tests ---------- */

  function makePage() {
    const { el } = require('./fake-dom');
    const b = el(doc, 'b', 'bold');
    const p1 = el(doc, 'p', 'Hello ', b, ' world. ');
    const p2 = el(doc, 'p', 'Second paragraph text here.');
    doc.body = el(doc, 'body', p1, p2);
    return { p1, p2 };
  }

  function rawRange(s, e) {
    const idx = dom.buildIndex();
    dom.state.idx = idx;
    return { idx, range: dom.rawToRange(s, e) };
  }

  test('dom: buildIndex concatenates text in order', () => {
    makePage();
    const idx = dom.buildIndex();
    eq(idx.text, 'Hello bold world. Second paragraph text here.');
    eq(idx.nodes.length, 4);
  });

  test('dom: buildIndex skips [data-tma-skip] subtrees', () => {
    const { el } = require('./fake-dom');
    const ui = el(doc, 'div', 'UI TEXT');
    ui.setAttribute('data-tma-skip', '');
    doc.body = el(doc, 'body', el(doc, 'p', 'real text'), ui);
    const idx = dom.buildIndex();
    eq(idx.text, 'real text');
  });

  test('dom: wrapRange single text node (mid range)', () => {
    makePage();
    const { idx, range } = rawRange(2, 5); // "llo"
    assert(range, 'range resolved');
    const wrappers = dom.wrapRange(range, 'x1', false);
    eq(wrappers.length, 1);
    assert(doc.body.querySelectorAll('[data-tma-id="x1"]').length === 1, 'one wrapper');
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    dom.unwrapAll('x1');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
  });

  test('dom: wrapRange across inline element in same parent', () => {
    makePage();
    const { idx, range } = rawRange(4, 8); // "o bo"
    const wrappers = dom.wrapRange(range, 'x2', false);
    eq(wrappers.length, 2); // one per parent: "o " in <p>, "bo" in <b>
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    const all = doc.body.querySelectorAll('[data-tma-id="x2"]');
    eq(all.map((w) => w.textContent), ['o ', 'bo']);
    // "ld" must NOT be highlighted: <b> stays in place, only "bo" wrapped
    const p1 = doc.body.childNodes[0];
    const bold = p1.childNodes[2];
    assert(bold.tagName === 'B' && !bold.hasAttribute('data-tma-id'), 'b itself not wrapped');
    assert(bold.childNodes[1].data === 'ld', 'ld outside wrapper');
    dom.unwrapAll('x2');
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    // tree fully restored (normalized)
    eq(structure(doc.body.childNodes[0].childNodes[0]), '«Hello »');
  });

  test('dom: wrapRange across block boundary -> multiple wrappers', () => {
    makePage();
    // text: "Hello bold world. Second..." ; mark "d. Sec" = offsets 15..21
    const { idx, range } = rawRange(15, 21);
    const wrappers = dom.wrapRange(range, 'x3', false);
    assert(wrappers.length === 2, 'two wrappers, got ' + wrappers.length);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    const all = doc.body.querySelectorAll('[data-tma-id="x3"]');
    eq(all.map((w) => w.textContent).sort(), ['Sec', 'd. ']);
    dom.unwrapAll('x3');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
  });

  test('dom: wrapRange ending at final text node of page (endNode null)', () => {
    makePage();
    // mark the tail "here." offsets 40..45 in "Hello bold world. Second paragraph text here."
    const { idx, range } = rawRange(40, 45);
    const wrappers = dom.wrapRange(range, 'x4', false);
    assert(wrappers.length === 1, 'one wrapper, got ' + wrappers.length);
    eq(wrappers[0].textContent, 'here.');
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    dom.unwrapAll('x4');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
  });

  test('dom: wrapRange whole last paragraph to its end', () => {
    makePage();
    // "Second paragraph text here." starts at 18
    const { idx, range } = rawRange(18, 45);
    const wrappers = dom.wrapRange(range, 'x5', false);
    eq(wrappers[0].textContent, 'Second paragraph text here.');
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    dom.unwrapAll('x5');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
  });

  test('dom: nested wrap (mark inside existing mark) then unwrap both', () => {
    makePage();
    const { idx, range: outer } = rawRange(0, 18); // "Hello bold world. "
    dom.wrapRange(outer, 'outer', false);
    const idx2 = dom.buildIndex();
    dom.state.idx = idx2;
    const range2 = dom.rawToRange(0, 5); // "Hello" inside the outer mark
    dom.wrapRange(range2, 'inner', false);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    dom.unwrapAll('inner');
    dom.unwrapAll('outer');
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
  });

  test('dom: clearHighlights removes everything', () => {
    makePage();
    const { range: r1 } = rawRange(0, 5);
    dom.wrapRange(r1, 'm1', false);
    const idx2 = dom.buildIndex();
    dom.state.idx = idx2;
    const r2 = dom.rawToRange(20, 26);
    dom.wrapRange(r2, 'm2', true);
    dom.clearHighlights();
    eq(doc.body.querySelectorAll('[data-tma-id]').length, 0);
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
  });

  test('dom: locate() restores a mark after text shift (full pipeline)', () => {
    // save a mark on the original page
    makePage();
    const idx = dom.buildIndex();
    dom.state.idx = idx;
    const s = 15, e = 21; // "d. Sec" (spans the p1/p2 boundary)
    const mark = {
      id: 'm',
      quote: idx.text.slice(s, e),
      pre: idx.text.slice(Math.max(0, s - 40), s),
      post: idx.text.slice(e, e + 40),
      offset: s,
    };
    dom.wrapRange(dom.rawToRange(s, e), 'm', false);

    // simulate page change: prepend a sentence to the first paragraph
    const { el } = require('./fake-dom');
    const p1 = doc.body.childNodes[0];
    p1.insertBefore(doc.createTextNode('Brand new sentence. '), p1.childNodes[0]);

    // restore: fresh index + locate
    const idx3 = dom.buildIndex();
    dom.state.idx = idx3;
    const range = dom.locate(mark);
    assert(range, 'locate found the mark after shift');
    // check the raw text covered by the located range equals the saved quote
    const segS = idx3.nodes.find((x) => x.node === range.startContainer);
    const segE = idx3.nodes.find((x) => x.node === range.endContainer);
    assert(segS && segE, 'endpoints in index');
    const rawStart = segS.start + range.startOffset;
    const rawEnd = segE.start + range.endOffset;
    eq(idx3.text.slice(rawStart, rawEnd), mark.quote);
  });
}

/* ------------------------------------------------------------------ */
/* VERSION B                                                           */
/* ------------------------------------------------------------------ */

function testB() {
  section('version_b');
  const file = path.join(__dirname, '..', 'version_b', 'content.js');
  const { doc, api: dom } = loadContentScript(file, '__TMB_TEST__', '__TMB_DOM');
  const P = globalThis.__TMB_PURE;

  test('pure: b64 unicode round-trip', () => {
    const s = 'héllo wörld — 日本語 📝';
    eq(P.b64dec(P.b64enc(s)), s);
  });

  test('pure: sdp code round-trip (whitespace tolerated)', () => {
    const sdp = 'v=0\r\n-0.0.0.0 IN IP4 127.0.0.1\r\nsession=tm\r\nm=application 9 UDP/TLS/RTP/SAVPF webrtcdatachannel\r\n';
    const code = P.sdpToCode(sdp);
    assert(/^[A-Za-z0-9+/=]+$/.test(code), 'code is base64');
    eq(P.codeToSdp(code), sdp);
    // codes pasted through textareas get newlines — they must be tolerated
    eq(P.codeToSdp(code.replace(/([A-Za-z0-9+/=]{40})/g, '$1\n')), sdp);
  });

  const mk = (id, note, ts) => ({ id, quote: 'q' + id, note, ts, offset: 0, pre: '', post: '', author: 'me' });

  test('pure: mergeMarks adds new remote marks', () => {
    const local = [mk('a', 'A', 100)];
    const remote = [mk('a', 'A', 100), mk('b', 'B', 200)];
    const r = P.mergeMarks(local, remote, null);
    eq(r.added, 1);
    eq(r.marks.map((m) => m.id).sort(), ['a', 'b']);
  });

  test('pure: mergeMarks updates note when remote is newer', () => {
    const local = [mk('a', 'old', 100)];
    const remote = [mk('a', 'newer', 200)];
    const r = P.mergeMarks(local, remote, null);
    eq(r.updated, 1);
    eq(r.marks[0].note, 'newer');
  });

  test('pure: mergeMarks keeps local note when local is newer', () => {
    const local = [mk('a', 'mine-newer', 300)];
    const remote = [mk('a', 'theirs-older', 200)];
    const r = P.mergeMarks(local, remote, null);
    eq(r.updated, 0);
    eq(r.marks[0].note, 'mine-newer');
  });

  test('pure: mergeMarks first exchange never deletes', () => {
    const local = [mk('a', 'A', 100), mk('c', 'C', 300)];
    const remote = [mk('a', 'A', 100)]; // peer has no "c" yet
    const r = P.mergeMarks(local, remote, null);
    eq(r.removed, []);
    eq(r.marks.map((m) => m.id).sort(), ['a', 'c']);
  });

  test('pure: mergeMarks deletes marks the peer removed', () => {
    const local = [mk('a', 'A', 100), mk('c', 'C', 300)];
    const lastRemote = ['a', 'c']; // peer had "c" in its previous state
    const remote = [mk('a', 'A', 100)]; // now gone
    const r = P.mergeMarks(local, remote, lastRemote);
    eq(r.removed, ['c']);
    eq(r.marks.map((m) => m.id), ['a']);
  });

  test('pure: mergeMarks does not delete marks peer never saw', () => {
    const local = [mk('a', 'A', 100), mk('c', 'C', 300)];
    const lastRemote = ['a']; // peer never had "c"
    const remote = [mk('a', 'A', 100)];
    const r = P.mergeMarks(local, remote, lastRemote);
    eq(r.removed, []);
    eq(r.marks.length, 2);
  });

  test('pure: findOffsets re-locates after shift', () => {
    const mark = { quote: 'gamma delta', offset: 11, pre: 'beta ', post: '' };
    const modified = 'Alpha NEW WORDS inserted beta gamma delta.';
    eq(P.findOffsets(modified, mark), [30, 41]);
  });

  /* ---------- DOM (fake) ---------- */

  function makePage() {
    const { el } = require('./fake-dom');
    const i = el(doc, 'i', 'italics');
    const p1 = el(doc, 'p', 'The quick brown fox jumps over the lazy dog. ', i, ' and home.');
    doc.body = el(doc, 'body', p1);
    return { p1 };
  }
  function idx() {
    const core = new dom.Core(doc);
    return core.index();
  }
  function core() {
    return new dom.Core(doc);
  }

  test('dom: core.index concatenates text', () => {
    makePage();
    const ix = idx();
    eq(ix.text, 'The quick brown fox jumps over the lazy dog. italics and home.');
  });

  test('dom: wrap/unwrap with color attr', () => {
    makePage();
    const c = core();
    const ix = idx();
    const s = 4, e = 8; // "ick "
    const a = c.nodeAt(ix.nodes, s);
    const b = c.nodeAt(ix.nodes, e);
    const range = doc.createRange();
    range.setStart(a.node, s - a.start);
    range.setEnd(b.node, e - b.start);
    const w = dom.D.wrap(doc, range, 'x9', 'blue');
    assert(w.length >= 1, 'wrappers');
    assert(doc.body.querySelectorAll('[data-tmb-id="x9"]').length >= 1, 'wrapped');
    eq(doc.body.textContent, 'The quick brown fox jumps over the lazy dog. italics and home.');
    dom.D.unwrap(doc, 'x9');
    eq(doc.body.querySelectorAll('[data-tmb-id]').length, 0);
    eq(doc.body.textContent, 'The quick brown fox jumps over the lazy dog. italics and home.');
  });

  test('dom: locate round-trip after text shift', () => {
    makePage();
    const c = core();
    const ix = idx();
    const s = 15, e = 25;
    const mark = {
      id: 'm', quote: ix.text.slice(s, e),
      pre: ix.text.slice(Math.max(0, s - 40), s),
      post: ix.text.slice(e, e + 40), offset: s,
    };
    const { el } = require('./fake-dom');
    const p1 = doc.body.childNodes[0];
    p1.insertBefore(doc.createTextNode('Prepended sentence. '), p1.childNodes[0]);
    const ix2 = c.index();
    const range = c.locate(mark, ix2);
    assert(range, 'located after shift');
    const segS = ix2.nodes.find((x) => x.node === range.startContainer);
    const segE = ix2.nodes.find((x) => x.node === range.endContainer);
    const rawS = segS.start + range.startOffset;
    const rawE = segE.start + range.endOffset;
    eq(ix2.text.slice(rawS, rawE), mark.quote);
  });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const which = process.argv[2] || 'a';
if (which === 'a' || which === 'all') testA();
if (which === 'b' || which === 'all') testB();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
