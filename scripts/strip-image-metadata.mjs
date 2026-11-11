// Removes hidden metadata from the app's images (text tags, EXIF/XMP, "made with" C2PA manifests)
// without touching the picture itself: only whole metadata chunks are dropped, pixel data is copied as is.
//   node scripts/strip-image-metadata.mjs                (the app's own images)
//   node scripts/strip-image-metadata.mjs FILE...        (just these)
// test/images.test.js fails if an image with metadata is committed.
import fs from 'node:fs';
import path from 'node:path';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Chunks needed to draw the picture the same way. Everything else (tEXt, iTXt, zTXt, eXIf, tIME, caBX, ...) goes.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT']);
const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

export function stripPng(buf) {
  const out = [PNG_SIG], dropped = [];
  for (let i = 8; i < buf.length;) {
    const n = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, i + 12 + n)); else dropped.push(type);
    i += 12 + n; if (type === 'IEND') break;
  }
  return { buf: Buffer.concat(out), dropped };
}
export function stripWebp(buf) {
  const chunks = [], dropped = [];
  for (let i = 12; i < buf.length;) {
    const type = buf.toString('latin1', i, i + 4), n = buf.readUInt32LE(i + 4), end = i + 8 + n + (n & 1);
    if (WEBP_KEEP.has(type)) {
      const c = Buffer.from(buf.subarray(i, end));
      if (type === 'VP8X') c[8] &= ~(0x08 | 0x04);   // no EXIF, no XMP any more
      chunks.push(c);
    } else dropped.push(type.trim());
    i = end;
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return { buf: Buffer.concat([head, body]), dropped };
}
export function stripSvg(text) {
  const out = text.replace(/<metadata>[\s\S]*?<\/metadata>/g, '').replace(/\s+xmlns:c2pa="[^"]*"/g, '');
  return { text: out, dropped: out === text ? [] : ['metadata'] };
}
export function strip(file) {
  const ext = path.extname(file).toLowerCase(), buf = fs.readFileSync(file);
  if (ext === '.svg') { const r = stripSvg(buf.toString('utf8')); if (r.dropped.length) fs.writeFileSync(file, r.text); return r.dropped; }
  const r = buf.subarray(0, 8).equals(PNG_SIG) ? stripPng(buf) : buf.toString('latin1', 0, 4) === 'RIFF' ? stripWebp(buf) : null;
  if (!r) return [];
  if (!r.buf.equals(buf)) fs.writeFileSync(file, r.buf);
  return r.dropped;
}
export const appImages = root => ['public', 'public/art', 'docs/images'].flatMap(d => {
  const dir = path.join(root, d); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(png|webp|svg)$/i.test(f)).map(f => path.join(dir, f));
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : appImages(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  for (const f of files) { const d = strip(f); console.log(`${f}: ${d.length ? 'removed ' + d.join(', ') : 'clean'}`); }
}
