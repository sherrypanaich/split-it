// Split it behind a proxy, the way it runs on the laptop: Cloudflare's tunnel hands every request to Traefik,
// and Traefik hands it to the app from one fixed address. Also checks that the receipt reader is served
// from the app itself and that the page's Content-Security-Policy names no outside script hosts.
// Run with: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-proxy-'));
let PORT, proc, env;
const PROXY = '10.0.2.6';   // the address Traefik has inside Docker; every request arrives "from" it

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// A visitor at `ip`, reaching the app through Cloudflare and Traefik (from loopback, with their headers).
function visitor(ip, extra = {}) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': PROXY, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'split.example.com', 'CF-Connecting-IP': ip,
        ...extra, ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  return { call, get: (u, h) => call('GET', u, undefined, h), signIn: (name, password) => call('POST', '/api/login', { name, password }), cookie: () => cookie };
}

before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: path.join(DIR, 'data'), PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: '', RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '' };
  for (const name of ['Ana', 'Ben', 'Cat']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('signing in works through Cloudflare and Traefik, and the sign-in sticks', async () => {
  const v = visitor('203.0.113.10');
  const r = await v.signIn('Ana', 'ana-password');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /Secure/i, 'the cookie is marked secure when the proxy says the visitor used https');
  assert.strictEqual((await v.get('/api/me')).data.name, 'Ana');
  assert.strictEqual((await v.get('/')).status, 200, 'the app page loads');
});

test('five wrong passwords through a proxy that adds X-Forwarded-For lock out only that visitor', async () => {
  // a proxy (Caddy, nginx, or Traefik set to trust the tunnel) that passes the visitor's own address in X-Forwarded-For
  const via = ip => visitor(ip, { 'X-Forwarded-For': ip, 'CF-Connecting-IP': ip });
  const bad = via('198.51.100.20');
  for (let i = 0; i < 5; i++) assert.strictEqual((await bad.signIn('Cat', 'wrong-guess-' + i)).status, 401);
  assert.strictEqual((await bad.signIn('Cat', 'cat-password')).status, 429);
  assert.strictEqual((await via('198.51.100.21').signIn('Cat', 'cat-password')).status, 200);
});

// ---------- receipt reader shipped inside the app ----------
test('the receipt reader is served by the app, compressed, and only to people signed in', async () => {
  const own = ip => visitor(ip, { 'X-Forwarded-For': ip });
  const out = own('203.0.113.30');
  assert.notStrictEqual((await out.get('/vendor/tesseract/tesseract.min.js')).status, 200, 'not for people signed out');
  const v = own('203.0.113.31'); assert.strictEqual((await v.signIn('Ana', 'ana-password')).status, 200);
  for (const f of ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js', 'eng.traineddata.gz']) {
    const r = await v.get('/vendor/tesseract/' + f);
    assert.strictEqual(r.status, 200, f);
    assert.ok(r.buf.length > 10000, f + ' has its content');
    assert.ok(r.headers.get('etag'), f + ' can be checked for changes cheaply');
  }
  // node's fetch unpacks gzip by itself, so ask by hand and look at the raw answer
  const raw = await new Promise((res, rej) => require('http').get({ host: '127.0.0.1', port: PORT, path: '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    headers: { 'Accept-Encoding': 'gzip', Cookie: v.cookie() } }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ h: r.headers, b: Buffer.concat(c) })); }).on('error', rej));
  assert.strictEqual(raw.h['content-encoding'], 'gzip');
  assert.ok(raw.b.length < 2.5e6, 'the 4 MB engine goes out compressed');
  assert.strictEqual(zlib.gunzipSync(raw.b).length, fs.statSync(path.join(__dirname, '..', 'public/vendor/tesseract/tesseract-core-simd-lstm.wasm.js')).size);
  for (const p of ['/vendor/tesseract/../server.js', '/vendor/tesseract/%2e%2e/server.js', '/vendor/tesseract/VERSIONS.txt'])
    assert.notStrictEqual((await v.get(p)).status, 200, p);
});

test('the page allows scripts and connections only from itself (plus the exchange rate service)', async () => {
  const v = visitor('203.0.113.32', { 'X-Forwarded-For': '203.0.113.32' }); await v.signIn('Ana', 'ana-password');
  const csp = (await v.get('/')).headers.get('content-security-policy');
  const part = name => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) || '').split(/\s+/).slice(1);
  for (const host of [...part('script-src'), ...part('worker-src')]) assert.ok(!/^https?:/.test(host), 'no outside script host: ' + host);
  assert.deepStrictEqual(part('connect-src').filter(h => /^https?:/.test(h)).sort(), ['https://api.frankfurter.app', 'https://api.frankfurter.dev']);
  assert.ok(!/jsdelivr|projectnaptha/.test(csp));
});

// Last, because on a branch without the fix it locks the shared proxy address for everyone after it.
test('five wrong passwords through the proxy only lock out the visitor who made them (Cloudflare address)',
  { todo: 'needs the change that reads CF-Connecting-IP from a trusted proxy (sign-in slice); drop this todo once it is merged' }, async () => {
    const bad = visitor('198.51.100.7');
    for (let i = 0; i < 5; i++) assert.strictEqual((await bad.signIn('Ben', 'wrong-guess-' + i)).status, 401);
    assert.strictEqual((await bad.signIn('Ben', 'ben-password')).status, 429, 'the guesser waits');
    assert.strictEqual((await visitor('198.51.100.8').signIn('Ben', 'ben-password')).status, 200, 'someone else, behind the same proxy, still gets in');
  });
