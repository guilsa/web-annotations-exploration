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
  const P = globalThis.__TMA_PURE;
  const { doc, api: dom } = loadContentScript(file, '__TMA_TEST__', '__TMA_DOM');

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
    const original = 'Alpha beta gamma delta.';
    const mark = { quote: 'gamma delta', offset: 11, pre: 'beta ', post: '' };
    const modified = 'Alpha NEW WORDS inserted beta gamma delta.';
    eq(P.findOffsets(modified, mark), [29, 41]);
  });

  test('pure: findOffsets picks context-matching occurrence over distance', () => {
    const text = 'apple apple apple apple apple';
    // two "apple"s; context disambiguates to the 4th one (index 24)
    const mark = { quote: 'apple', offset: 24, pre: 'apple apple ', post: ' apple' };
    eq(P.findOffsets(text, mark), [24, 29]);
  });

  test('pure: findOffsets rejects ambiguous short-quote-less-context', () => {
    const text = 'the the the the';
    const mark = { quote: 'the', offset: 4, pre: '', post: '' };
    eq(P.findOffsets(text, mark), null);
  });

  test('pure: findOffsets unique occurrence without context', () => {
    const text = 'lorem ipsum dolor sit amet';
    const mark = { quote: 'dolor', offset: 999, pre: '', post: '' };
    eq(P.findOffsets(text, mark), [11, 16]);
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
    assert(wrappers.length >= 1, 'wrappers created');
    eq(doc.body.textContent, 'Hello bold world. Second paragraph text here.');
    // the wrapper must contain the partial "o " text
    const w = doc.body.querySelectorAll('[data-tma-id="x2"]')[0];
    assert(w.textContent === 'o bo', 'wrapper text, got: ' + w.textContent);
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
    eq(all.map((w) => w.textContent).sort(), ['Sec', 'd']);
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
/* main                                                                */
/* ------------------------------------------------------------------ */

const which = process.argv[2] || 'a';
if (which === 'a' || which === 'all') testA();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
