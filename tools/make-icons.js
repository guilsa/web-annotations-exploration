#!/usr/bin/env node
/* Generates simple PNG icons for the three Textmarker variants.
 * Pure node (zlib + manual PNG encoding). No dependencies.
 * Usage: node tools/make-icons.js
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- minimal PNG encoder ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x + 0.5, y + 0.5, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- drawing ----------
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function inRR(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
function makeIcon(color) {
  const [cr, cg, cb] = hex(color);
  // returns [r,g,b,a]
  function pixel(x, y, s) {
    // 2x2 supersampling for smoother edges
    let r = 0, g = 0, b = 0, a = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const px = x - 0.5 + ox, py = y - 0.5 + oy;
      let c = null;
      const m = s * 0.08;
      if (inRR(px, py, m, m, s - m, s - m, s * 0.2)) {
        // white inner card
        c = [255, 255, 255];
        const i0 = s * 0.24, i1 = s * 0.76;
        if (inRR(px, py, i0, i0, i1, i1, s * 0.1)) {
          // "T" glyph in the brand color
          const inTopBar = px >= s * 0.32 && px <= s * 0.68 && py >= s * 0.34 && py <= s * 0.46;
          const inStem = px >= s * 0.44 && px <= s * 0.56 && py >= s * 0.34 && py <= s * 0.64;
          if (inTopBar || inStem) c = [cr, cg, cb];
          // small "share" dot, top-right of the card
          const dx = px - s * 0.66, dy = py - s * 0.32;
          if (dx * dx + dy * dy <= (s * 0.055) * (s * 0.055)) c = [cr, cg, cb];
        }
      } else if (inRR(px, py, 0, 0, s, s, s * 0.22)) {
        c = [cr, cg, cb]; // rounded brand background
      }
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    return [Math.round(r / 4), Math.round(g / 4), Math.round(b / 4), Math.round(a / 4)];
  }
  return pixel;
}

const variants = {
  version_a: { color: '#f6b93b' },
  version_b: { color: '#3b82f6' },
  version_c: { color: '#22c55e' },
};
for (const [dir, { color }] of Object.entries(variants)) {
  const outDir = path.join(__dirname, '..', dir, 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  const pixel = makeIcon(color);
  for (const size of [16, 32, 48, 96]) {
    const file = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(file, encodePNG(size, pixel));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}
