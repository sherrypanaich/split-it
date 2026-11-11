// Sign-in and request safety, with the server started for real behind a pretend proxy:
// the visitor's real address, the slow-down for one account, the assistant connect page and app list,
// where a request comes from, changing email, and how sign-ins are kept.
// Run with: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-auth-'));
const DATA = path.join(DIR, 'data'), USERS = path.join(DATA, 'users.json'), OAUTH = path.join(DATA, 'oauth.json');
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
let PORT, MAIL_PORT, proc, mailer, env, BASE;
const mails = [];

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
// One request, from this computer (as a proxy on it would send it), with whatever headers the test gives.
async function call(method, url, { headers = {}, body, form } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (form) h['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(BASE + url, { method, redirect: 'manual', headers: h, body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
// A visitor arriving through Cloudflare and Traefik: the proxy (10.0.2.6) is the last hop.
const via = ip => ({ 'X-Forwarded-For': `${ip}, 10.0.2.6` });
const signIn = (name, password, headers) => call('POST', '/api/login', { headers, body: { name, password } });
const uidOf = name => Object.entries(JSON.parse(fs.readFileSync(USERS, 'utf8')).users).find(([, u]) => u.name === name)[0];
const appCode = (secret, at = Date.now()) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = crypto.createHmac('sha1', key).update(msg).digest(), o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};

// Sign-ins saved by an older version, with the token itself as the key: they must keep working.
const OLD = 'a'.repeat(64), OLD_AGING = 'b'.repeat(64), GUS_OLD = 'c'.repeat(64), GUS_NEW = 'd'.repeat(64);

before(async () => {
  PORT = await freePort(); MAIL_PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`;
  mailer = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { mails.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); }).listen(MAIL_PORT, '127.0.0.1');
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: '', UPDATE_CHECK: 'off', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    PUBLIC_URL: BASE, RESEND_API_KEY: 'test-key', RESEND_URL: `http://127.0.0.1:${MAIL_PORT}/emails`, TRUSTED_PROXY: '' };
  for (const name of ['Ana', 'Ben', 'Gus', 'Hal']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  const u = JSON.parse(fs.readFileSync(USERS, 'utf8'));
  const id = n => Object.keys(u.users).find(k => u.users[k].name === n);
  delete u.users[id('Gus')].hash; delete u.users[id('Gus')].salt;   // Gus signs in with Google only
  const day = 864e5, now = Date.now();
  u.sessions = { [OLD]: { uid: id('Ana'), exp: now + 80 * day }, [OLD_AGING]: { uid: id('Ben'), exp: now + day },
    [GUS_OLD]: { uid: id('Gus'), exp: now + 80 * day, at: now - 3600e3 }, [GUS_NEW]: { uid: id('Gus'), exp: now + 90 * day, at: now } };
  delete u.sessionsHashed;
  fs.writeFileSync(USERS, JSON.stringify(u));
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  if (mailer) mailer.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- the visitor's real address behind a proxy ----------
test('behind a proxy, five wrong passwords lock out only the visitor who typed them', async () => {
  for (let i = 0; i < 5; i++) assert.strictEqual((await signIn('Hal', 'wrong-guess-' + i, via('203.0.113.5'))).status, 401);
  assert.strictEqual((await signIn('Hal', 'hal-password', via('203.0.113.5'))).status, 429, 'that visitor waits');
  assert.strictEqual((await signIn('Hal', 'hal-password', via('198.51.100.7'))).status, 200, 'everyone else behind the same proxy still gets in');
  // Made-up addresses added on the left don't help: the proxy's own entry on the right is what counts.
  assert.strictEqual((await signIn('Hal', 'hal-password', { 'X-Forwarded-For': '192.0.2.99, 203.0.113.5, 10.0.2.6' })).status, 429);
  // Cloudflare's header names the visitor when the request comes through a trusted proxy.
  for (let i = 0; i < 5; i++) await signIn('Hal', 'wrong-again-' + i, { ...via('198.51.100.50'), 'CF-Connecting-IP': '192.0.2.10' });
  assert.strictEqual((await signIn('Hal', 'hal-password', { ...via('198.51.100.50'), 'CF-Connecting-IP': '192.0.2.10' })).status, 429);
  assert.strictEqual((await signIn('Hal', 'hal-password', { ...via('198.51.100.50'), 'CF-Connecting-IP': '192.0.2.11' })).status, 200);
});

test('a request passed on by a proxy is never treated as coming from this computer', async () => {
  const lock = JSON.parse(fs.readFileSync(path.join(DATA, 'server.lock'), 'utf8'));
  const knock = headers => call('POST', '/api/local/cli', { headers: { 'X-Local-Token': lock.token, ...headers }, body: { cmd: 'list-users' } });
  for (const h of [{ 'CF-Connecting-IP': '203.0.113.9' }, { Forwarded: 'for=203.0.113.9' }, { 'X-Real-IP': '203.0.113.9' }, { 'X-Forwarded-For': '127.0.0.1' }])
    assert.strictEqual((await knock(h)).status, 404, JSON.stringify(h));
  assert.strictEqual((await knock({})).status, 200, 'straight from this computer it works');
});

test('which addresses are trusted as proxies, and TRUSTED_PROXY', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(DIR, 'unit-'));
  const S = require('../server.js');
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  const dflt = S.makeClientIp(S.trustList(''));
  assert.strictEqual(dflt(req('::ffff:10.0.2.6', { 'x-forwarded-for': '203.0.113.5' })), '203.0.113.5', 'Docker address, written the IPv6 way');
  assert.strictEqual(dflt(req('172.18.0.3', { 'x-forwarded-for': '203.0.113.5, 172.18.0.1' })), '203.0.113.5');
  assert.strictEqual(dflt(req('fd12::3', { 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
  assert.strictEqual(dflt(req('192.168.1.20', { 'x-forwarded-for': '192.168.1.7' })), '192.168.1.7', 'a phone on the home network');
  assert.strictEqual(dflt(req('203.0.113.80', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4' })), '203.0.113.80', 'an outside address is never believed');
  const none = S.makeClientIp(S.trustList('none'));
  assert.strictEqual(none(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), '127.0.0.1');
  const only = S.makeClientIp(S.trustList('10.0.2.6, 172.16.0.0/12'));
  assert.strictEqual(only(req('10.0.2.6', { 'x-forwarded-for': '203.0.113.5' })), '203.0.113.5');
  assert.strictEqual(only(req('10.0.2.7', { 'x-forwarded-for': '203.0.113.5' })), '10.0.2.7', 'not on the list');
  assert.strictEqual(only(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), '127.0.0.1', 'the list replaces the default');
  assert.strictEqual(S.isLocalReq(req('::1', {})), true);
  assert.strictEqual(S.isLocalReq(req('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), false);
  // where a write comes from
  const w = (headers, p = '/api/write', method = 'POST') => S.fromElsewhere({ method, headers: { host: 'split.example.com', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, p);
  assert.strictEqual(w({}), false, 'scripts that say nothing are fine');
  assert.strictEqual(w({ origin: 'https://split.example.com' }), false);
  assert.strictEqual(w({ origin: 'https://evil.example.com' }), true);
  assert.strictEqual(w({ origin: 'null' }), true);
  assert.strictEqual(w({ referer: 'https://old.example.com/page' }), true);
  assert.strictEqual(w({ origin: 'https://evil.example.com' }, '/api/doc', 'GET'), false, 'reading is not a write');
  assert.strictEqual(w({ origin: 'https://claude.ai' }, '/oauth/token'), false, 'assistants talk to the token endpoint from anywhere');
  const was = process.env.PUBLIC_URL; process.env.PUBLIC_URL = 'https://app.example.org';
  try { assert.strictEqual(w({ origin: 'https://app.example.org' }), false, 'the PUBLIC_URL address counts as this app'); } finally { process.env.PUBLIC_URL = was; }
});

// ---------- one account ----------
test('a sign-in code still lets its owner in after many wrong passwords aimed at them', async () => {
  const sess = await signIn('Ana', 'ana-password', via('198.51.100.1'));
  const c = sess.cookie;
  const start = await call('POST', '/api/account/code/start', { headers: { Cookie: c } });
  const on = await call('POST', '/api/account/code/confirm', { headers: { Cookie: c }, body: { code: appCode(start.data.secret) } });
  assert.strictEqual(on.status, 200);
  for (let i = 0; i < 11; i++) assert.strictEqual((await signIn('Ana', 'wrong-' + i, via(`198.51.100.${10 + i}`))).status, 401);
  const step1 = await signIn('Ana', 'ana-password', via('198.51.100.40'));
  assert.strictEqual(step1.data.need, 'code', 'not locked out');
  const step2 = await call('POST', '/api/login/code', { headers: via('198.51.100.40'), body: { ticket: step1.data.ticket, code: on.data.backup[0] } });
  assert.strictEqual(step2.status, 200);
  // and turn it off again, so the other tests can sign Ana in with a password alone
  assert.strictEqual((await call('POST', '/api/account/code/off', { headers: { Cookie: c, ...via('198.51.100.41') }, body: { code: on.data.backup[1] } })).status, 200);
});

// ---------- how sign-ins are kept ----------
test('sign-ins are kept hashed, older ones were converted without signing anyone out, and use keeps them going', async () => {
  const saved = fs.readFileSync(USERS, 'utf8');
  for (const t of [OLD, OLD_AGING]) { assert.ok(!saved.includes(t), 'no plain token on disk'); assert.ok(saved.includes(sha(t))); }
  assert.strictEqual((await call('GET', '/api/me', { headers: { Cookie: 'hs=' + OLD } })).data.name, 'Ana', 'still signed in after the change');
  const fresh = await signIn('Ben', 'ben-password', via('198.51.100.60'));
  assert.ok(!fs.readFileSync(USERS, 'utf8').includes(fresh.cookie.slice(3)), 'a new sign-in is stored hashed too');
  // Ben's old sign-in had a day left: using it pushes it to 90 days from now, and sends the cookie again
  const r = await call('GET', '/api/me', { headers: { Cookie: 'hs=' + OLD_AGING } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /hs=b{64}; .*Max-Age=7776000/);
  const exp = JSON.parse(fs.readFileSync(USERS, 'utf8')).sessions[sha(OLD_AGING)].exp;
  assert.ok(exp > Date.now() + 89 * 864e5);
  assert.strictEqual((await call('GET', '/api/me', { headers: { Cookie: 'hs=' + OLD_AGING } })).headers.get('set-cookie'), null, 'at most once a day');
  // signing out removes it
  await call('GET', '/api/logout', { headers: { Cookie: fresh.cookie } });
  assert.strictEqual((await call('GET', '/api/me', { headers: { Cookie: fresh.cookie } })).status, 401);
});

// ---------- changing email ----------
test('changing email needs the password, a sign-in code, or (Google only) a fresh sign-in', async () => {
  const ben = (await signIn('Ben', 'ben-password', via('198.51.100.70'))).cookie;
  const ask = (cookie, body, ip = '198.51.100.71') => call('POST', '/api/account/email', { headers: { Cookie: cookie, ...via(ip) }, body });
  let r = await ask(ben, { email: 'ben@example.com' });
  assert.deepStrictEqual([r.status, r.data.need], [403, 'password']);
  assert.strictEqual((await ask(ben, { email: 'ben@example.com', current: 'not-it' })).status, 401);
  r = await ask(ben, { email: 'ben@example.com', current: 'ben-password' });
  assert.deepStrictEqual([r.status, r.data.pending], [200, 'ben@example.com']);
  assert.strictEqual(mails.at(-1).to[0], 'ben@example.com');
  // Gus signs in with Google only: an hour-old sign-in isn't enough, a new one is
  r = await ask('hs=' + GUS_OLD, { email: 'gus@example.com' }, '198.51.100.72');
  assert.deepStrictEqual([r.status, r.data.need], [403, 'fresh']);
  r = await ask('hs=' + GUS_NEW, { email: 'gus@example.com' }, '198.51.100.73');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
});

// ---------- where a request comes from ----------
test('another website cannot make a signed-in browser change things', async () => {
  const c = (await signIn('Ben', 'ben-password', via('198.51.100.80'))).cookie;
  const write = headers => call('POST', '/api/write', { headers: { Cookie: c, ...headers }, body: { ops: [{ op: 'set', path: 'people/' + uidOf('Ben'), data: { nickname: 'Benny', color: 3 } }] } });
  assert.strictEqual((await write({ Origin: 'https://evil.example.com' })).status, 403);
  assert.strictEqual((await write({ Referer: 'https://evil.example.com/x' })).status, 403);
  assert.strictEqual((await write({ Origin: BASE })).status, 200, 'the app itself');
  assert.strictEqual((await write({})).status, 200, 'no Origin at all (a script on the laptop)');
  assert.strictEqual((await call('POST', '/api/account/signout-all', { headers: { Cookie: c, Origin: 'https://evil.example.com' } })).status, 403);
  assert.strictEqual((await call('GET', '/api/me', { headers: { Cookie: c } })).status, 200, 'still signed in');
});

// ---------- connecting an assistant ----------
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
const register = (headers = via('203.0.113.200'), uri = 'https://claude.ai/api/mcp/auth_callback') =>
  call('POST', '/oauth/register', { headers: { Origin: 'https://claude.ai', ...headers }, body: { client_name: 'Claude', redirect_uris: [uri] } });

test('the connect page shows where the key goes, and someone signed in can allow it with one tap', async () => {
  const reg = (await register(via('203.0.113.201'), 'https://evil-helper.example.net/cb')).data;
  const { verifier, challenge } = pkce();
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://evil-helper.example.net/cb', state: 'st', code_challenge: challenge, code_challenge_method: 'S256' };
  const signedOut = await call('GET', '/oauth/authorize?' + new URLSearchParams(q));
  assert.strictEqual(signedOut.status, 200);
  assert.match(signedOut.text, /evil-helper\.example\.net/, 'the address the key is sent to');
  assert.match(signedOut.text, /href="\/login\?next=%2Foauth%2Fauthorize%3F/, 'a way to sign in with Google first');
  assert.ok(!/name="allow"/.test(signedOut.text));

  // Gus signs in with Google only, and is signed in to the app in this browser
  const page = await call('GET', '/oauth/authorize?' + new URLSearchParams(q), { headers: { Cookie: 'hs=' + GUS_NEW } });
  assert.match(page.text, /Signed in as <b>Gus<\/b>/);
  const allow = /name="allow" value="([a-f0-9]+)"/.exec(page.text)[1];
  const post = (form, headers = {}) => call('POST', '/oauth/authorize', { headers: { Cookie: 'hs=' + GUS_NEW, Origin: BASE, ...headers }, form });
  assert.strictEqual((await post({ ...q, allow: 'f'.repeat(64) })).status, 401, 'a made-up value does nothing');
  assert.strictEqual((await post({ ...q, allow }, { Origin: 'https://evil-helper.example.net' })).status, 403, 'not from another site');
  assert.strictEqual((await call('POST', '/oauth/authorize', { headers: { Cookie: 'hs=' + GUS_OLD, Origin: BASE }, form: { ...q, allow } })).status, 401, 'tied to this sign-in');
  const ok = await post({ ...q, allow });
  assert.strictEqual(ok.status, 302);
  const code = new URL(ok.headers.get('location')).searchParams.get('code');
  const tok = await call('POST', '/oauth/token', { headers: { Origin: 'https://evil-helper.example.net' }, form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: q.redirect_uri } });
  assert.strictEqual(tok.status, 200, 'the token endpoint takes calls from anywhere');
  const me = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.data.access_token, Origin: 'https://claude.ai' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.strictEqual(me.status, 200);
});

test('the list of assistant apps limits each address, clears out unused ones, and never fills up', async () => {
  for (let i = 0; i < 20; i++) assert.strictEqual((await register(via('203.0.113.210'))).status, 201);
  assert.strictEqual((await register(via('203.0.113.210'))).status, 429, 'twenty an hour from one address');
  assert.strictEqual((await register(via('203.0.113.211'))).status, 201, 'others are not affected');

  // fill the list: 500 that never signed in (one of them from two days ago), plus one in use
  const store = JSON.parse(fs.readFileSync(OAUTH, 'utf8'));
  const now = Date.now();
  store.clients = {};
  for (let i = 0; i < 499; i++) store.clients['c_fill' + i] = { name: 'x', redirect_uris: ['https://x.example/cb'], secret: null, at: now - 3600e3 + i };
  store.clients.c_stale = { name: 'old', redirect_uris: ['https://x.example/cb'], secret: null, at: now - 2 * 864e5 };
  store.clients.c_inuse = { name: 'Muse', redirect_uris: ['https://x.example/cb'], secret: null, at: now - 30 * 864e5, used: now - 30 * 864e5 };
  // keys: one used yesterday, one nobody used for 91 days
  const live = 'hsk_live' + crypto.randomBytes(8).toString('hex'), idle = 'hsk_idle' + crypto.randomBytes(8).toString('hex');
  const hal = uidOf('Hal');
  store.tokens[sha(live)] = { uid: hal, client: 'key', kind: 'key', at: now - 200 * 864e5, used: now - 864e5, exp: null };
  store.tokens[sha(idle)] = { uid: hal, client: 'key', kind: 'key', at: now - 91 * 864e5, exp: null };
  store.tokens[sha('inuse-access')] = { uid: hal, client: 'c_inuse', kind: 'access', at: now - 864e5, exp: now + 29 * 864e5 };
  fs.writeFileSync(OAUTH, JSON.stringify(store));
  fs.utimesSync(OAUTH, new Date(), new Date(Date.now() + 5000));   // so the server notices the change

  const r = await register(via('203.0.113.212'));
  assert.strictEqual(r.status, 201, 'a full list makes room instead of refusing');
  const after = JSON.parse(fs.readFileSync(OAUTH, 'utf8')).clients;
  assert.ok(Object.keys(after).length <= 500);
  assert.ok(!after.c_stale, 'never signed in for a day: gone');
  assert.ok(after.c_inuse, 'one somebody uses stays');
  assert.ok(!after.c_fill0 && after.c_fill498, 'the oldest unused one made room');
  assert.ok(after[r.data.client_id]);

  const mcp = key => fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.strictEqual((await mcp(live)).status, 200, 'a key in use keeps working');
  assert.strictEqual((await mcp(idle)).status, 401, 'a key nobody used for 90 days stops');
  const used = JSON.parse(fs.readFileSync(OAUTH, 'utf8')).tokens[sha(live)].used;
  assert.ok(used > now - 60e3, 'and "last used" is kept');
});
