// The app's images carry no hidden metadata (text tags, EXIF/XMP, "made with" C2PA manifests).
// If this fails, run: node scripts/strip-image-metadata.mjs
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = ['public', 'public/art', 'docs/images'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(f => /\.(png|webp|svg)$/i.test(f)).map(f => path.join(d, f)));

test('images carry no hidden metadata', async () => {
  const { strip } = await import('../scripts/strip-image-metadata.mjs');
  assert.ok(files.length >= 10, 'found the images');
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    assert.ok(!/c2pa|<x:xmpmeta|Exif\0\0/i.test(buf.toString('latin1')), f + ' has metadata in it');
    // a copy run through the stripper comes out the same, so nothing in it is metadata
    const tmp = path.join(require('os').tmpdir(), 'split-it-img-' + process.pid + path.extname(f));
    fs.copyFileSync(path.join(ROOT, f), tmp);
    try { assert.deepStrictEqual(strip(tmp), [], f + ' has metadata chunks'); } finally { fs.rmSync(tmp, { force: true }); }
  }
});
