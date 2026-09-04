/* Minimal fake DOM — just enough surface for the Textmarker content scripts'
 * core text-index / wrap / unwrap logic. Used by tests/run-tests.js only.
 */
'use strict';

global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
global.NodeFilter = {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
};

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return p.childNodes[i + 1] || null;
  }
  splitText(offset) {
    if (offset < 0 || offset > this.data.length) throw new Error('bad split offset');
    const after = new FakeText(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    const p = this.parentNode;
    if (p) p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, after);
    after.parentNode = p;
    return after;
  }
  cloneNode() {
    const t = new FakeText(this.data);
    return t;
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = '';
    this.style = { cssText: '' };
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return p.childNodes[i + 1] || null;
  }
  get textContent() {
    let out = '';
    for (const c of this.childNodes) {
      out += c.nodeType === 3 ? c.data : c.textContent;
    }
    return out;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  hasAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k);
  }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (i < 0) throw new Error('insertBefore: reference node is not a child');
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(i, 0, node);
    return node;
  }
  appendChild(node) {
    return this.insertBefore(node, null);
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error('removeChild: node is not a child');
    node.parentNode = null;
    this.childNodes.splice(i, 1);
    return node;
  }
  normalize() {
    let i = 0;
    while (i < this.childNodes.length) {
      const c = this.childNodes[i];
      if (c.nodeType === 3 && i + 1 < this.childNodes.length && this.childNodes[i + 1].nodeType === 3) {
        c.data += this.childNodes[i + 1].data;
        this.childNodes.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
  cloneNode() {
    const el = new FakeElement(this.tagName);
    for (const [k, v] of Object.entries(this.attributes)) el.attributes[k] = v;
    return el;
  }
}

function collectText(root) {
  const out = [];
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  })(root);
  return out;
}

function lca(a, b) {
  if (!a || !b) return null;
  const chain = [];
  let cur = a;
  while (cur) { chain.push(cur); cur = cur.parentNode; }
  cur = b;
  while (cur) {
    if (chain.includes(cur)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function makeDocument() {
  const doc = {
    documentElement: null,
    head: null,
    body: null,
    readyState: 'complete',
    title: 'test',
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { return new FakeText(text); },
    createTreeWalker(root, _whatToShow, filter) {
      const out = [];
      (function walk(node) {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) {
            const acc = filter ? filter.acceptNode(c) : 1;
            if (acc === 1) out.push(c);
          } else if (c.nodeType === 1) {
            // SHOW_TEXT walkers only invoke the filter on text nodes
            walk(c);
          }
        }
      })(root);
      let i = 0;
      return { nextNode: () => (i < out.length ? out[i++] : null) };
    },
    createRange() {
      const r = {
        startContainer: null, startOffset: 0,
        endContainer: null, endOffset: 0,
        setStart(node, off) { this.startContainer = node; this.startOffset = off; },
        setEnd(node, off) { this.endContainer = node; this.endOffset = off; },
        get commonAncestorContainer() {
          return lca(this.startContainer, this.endContainer);
        },
        intersectsNode(n) {
          if (n.nodeType !== 3) return false;
          const all = collectText(doc.body || { childNodes: [] });
          let cum = 0;
          const pos = new Map();
          for (const t of all) { pos.set(t, cum); cum += t.data.length; }
          if (!pos.has(n) || !pos.has(r.startContainer) || !pos.has(r.endContainer)) return false;
          const tStart = pos.get(n);
          const tEnd = tStart + n.data.length;
          const rStart = pos.get(r.startContainer) + r.startOffset;
          const rEnd = pos.get(r.endContainer) + r.endOffset;
          const lo = Math.min(rStart, rEnd);
          const hi = Math.max(rStart, rEnd);
          return tEnd > lo && tStart < hi;
        },
      };
      return r;
    },
    querySelectorAll(sel) {
      return doc.body ? queryAll(doc.body, sel) : [];
    },
    getElementById(id) {
      let found = null;
      (function walk(n) {
        for (const c of n.childNodes) {
          if (c.nodeType === 1) {
            if (c.getAttribute && c.getAttribute('id') === id) { found = c; return; }
            walk(c);
          }
        }
      })(doc.body || doc.documentElement || { childNodes: [] });
      return found;
    },
    addEventListener() {},
    defaultView: null,
  };
  return doc;
}

function queryAll(root, sel) {
  let m = sel.match(/^\[([^\]=\]]+)="([^"]*)"\]$/);
  if (m) {
    const res = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (c.hasAttribute(m[1]) && c.getAttribute(m[1]) === m[2]) res.push(c);
          walk(c);
        }
      }
    })(root);
    return res;
  }
  m = sel.match(/^\[([^\]]+)\]$/);
  if (m) {
    const res = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (c.hasAttribute(m[1])) res.push(c);
          walk(c);
        }
      }
    })(root);
    return res;
  }
  throw new Error('fake-dom: unsupported selector ' + sel);
}

function el(doc, tag, ...children) {
  const e = doc.createElement(tag);
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(doc.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

module.exports = { FakeText, FakeElement, makeDocument, el };
