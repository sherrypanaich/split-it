// Who changed what, the bin, stale edits, group rules, what can be stored, nudges, the calendar link,
// and taking a copy of / deleting your own data. The real server, started on a spare port with an empty data folder.
// Run with: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-integrity-'));
const DATA = path.join(DIR, 'data');
let PORT, proc, env, addr = 0, phones = null;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function browser(ip) {
  const from = ip || `10.31.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  const me = {
    get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body),
    signIn: (name, password) => me.post('/api/login', { name, password }),
    write: (...ops) => me.post('/api/write', { ops }),
    set: (p, data) => me.write({ op: 'set', path: p, data }), update: (p, data) => me.write({ op: 'update', path: p, data }),
    del: p => me.write({ op: 'delete', path: p }),
    doc: async p => (await me.get('/api/doc?path=' + encodeURIComponent(p))),
    data: async p => (await me.get('/api/doc?path=' + encodeURIComponent(p))).data?.data,
    col: p => me.get('/api/col?path=' + encodeURIComponent(p)),
  };
  return me;
}
async function as(name, password = name.toLowerCase() + '-password') {
  const b = browser(); const r = await b.signIn(name, password);
  assert.strictEqual(r.status, 200, `${name} signs in`);
  b.uid = (await b.get('/api/me')).data.uid; b.name = name;
  return b;
}

// ---------- a stand-in for the phones' push service, so we can read the notifications ----------
// Each person's phone has its own key; the server encrypts to it exactly as for a real phone.
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function phoneKeys() { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); return { ecdh, auth: crypto.randomBytes(16) }; }
function openPush(keys, buf) {
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), body = buf.subarray(21 + idlen);
  const uaPublic = keys.ecdh.getPublicKey();
  const prkKey = hmac(keys.auth, keys.ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}
async function startPhones() {   // -> null when there is no openssl to make a certificate with (then push checks are skipped)
  const key = path.join(DIR, 'push-key.pem'), cert = path.join(DIR, 'push-cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert, '-days', '2'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const inbox = {}, keys = {};
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { const who = req.url.slice(1); try { (inbox[who] = inbox[who] || []).push(openPush(keys[who], Buffer.concat(chunks))); } catch (e) { console.error(e); } res.writeHead(201); res.end(); });
  });
  const port = await freePort(); await new Promise(res => srv.listen(port, '127.0.0.1', res));
  return { srv, cert, inbox, keys, port,
    async subscribe(b) { const k = keys[b.name] = phoneKeys();
      const r = await b.post('/api/push/subscribe', { endpoint: `https://127.0.0.1:${port}/${b.name}`, keys: { p256dh: k.ecdh.getPublicKey('base64url'), auth: k.auth.toString('base64url') } });
      assert.strictEqual(r.status, 200); },
    async next(name, match) { for (let i = 0; i < 50; i++) { const m = (inbox[name] || []).find(x => match.test(x.title + ' ' + x.body)); if (m) return m; await wait(50); } return null; } };
}

let ana, ben, cat, GID;   // Ana (owner) made the group with Ben in it; Cat is in the house but not the group
let n = 0; const id = (p = 'e') => `${p}_int${++n}`;
const expense = (by, amount, split, extra = {}) => ({ kind: 'expense', title: 'Groceries', amount, paidBy: by.uid, split, splitMode: 'exact', people: Object.keys(split), groupId: GID, date: '2026-11-01', createdAt: Date.now(), addedBy: by.uid, ...extra });
const payment = (by, from, to, amount, extra = {}) => ({ kind: 'payment', from, to, amount, date: '2026-11-02', createdAt: Date.now(), addedBy: by.uid, people: [from, to], groupId: GID, ...extra });
async function newGroup(owner, others, extra = {}) {
  const g = id('g');
  assert.strictEqual((await owner.set('groups/' + g, { name: 'House ' + g, createdBy: owner.uid, createdAt: Date.now(), ...extra })).status, 200);
  const ops = [owner, ...others].map(b => ({ op: 'set', path: `groups/${g}/members/${b.uid}`, data: { kind: 'account', active: true, joinedAt: Date.now(), addedBy: owner.uid } }));
  assert.strictEqual((await owner.write(...ops)).status, 200);
  return g;
}

before(async () => {
  PORT = await freePort();
  phones = await startPhones();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: '', UPDATE_CHECK: 'off', MAX_DOCS_PER_PERSON: '30',
    RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', ...(phones ? { NODE_EXTRA_CA_CERTS: phones.cert } : {}) };
  for (const name of ['Ana', 'Ben', 'Cat']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben'); cat = await as('Cat');
  if (phones) for (const b of [ana, ben, cat]) await phones.subscribe(b);
  else console.log("# no openssl here, so the notification checks are skipped");
  GID = await newGroup(ana, [ben]);
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  if (phones) phones.srv.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- deletes go to the bin, and everyone in the entry is told ----------
test('deleting an expense through the server moves it to the bin and tells everyone in it', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(ana, 10000, { [ana.uid]: 5000, [ben.uid]: 5000 }, { title: 'Hydro' }))).status, 200);
  // Ben owes $50 and tries to make it vanish for good
  const r = await ben.del('expenses/' + e);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const d = await ana.data('expenses/' + e);
  assert.ok(d, 'it is still there');
  assert.ok(d.deletedAt > 0, 'in the bin');
  assert.strictEqual(d.deletedBy, ben.uid, 'it says who removed it');
  assert.strictEqual(d.amount, 10000);
  if (phones) {
    const note = await phones.next('Ana', /Ben removed Hydro/);
    assert.ok(note, 'Ana gets a notification');
    assert.match(note.body, /\$100\.00/); assert.match(note.body, /Recently deleted/);
    assert.ok(!(phones.inbox.Ben || []).some(x => /removed Hydro/.test(x.title)), 'not the person who did it');
    assert.ok(!(phones.inbox.Cat || []).some(x => /removed Hydro/.test(x.title)), 'not someone outside it');
  }
  // deleting again (already in the bin) changes nothing
  assert.strictEqual((await ben.del('expenses/' + e)).status, 200);
  assert.strictEqual((await ana.data('expenses/' + e)).deletedAt, d.deletedAt);
  // and it can be put back
  assert.strictEqual((await ana.update('expenses/' + e, { deletedAt: null })).status, 200);
  assert.strictEqual((await ana.data('expenses/' + e)).deletedBy, null);
});

test('moving to the bin from the app also notifies, and nobody can put someone else’s name on it', async () => {
  const p = id('p');
  assert.strictEqual((await ben.set('expenses/' + p, payment(ben, ben.uid, ana.uid, 2500, { confirmed: false }))).status, 200);
  assert.strictEqual((await ana.update('expenses/' + p, { deletedAt: Date.now(), deletedBy: ben.uid })).status, 200);
  assert.strictEqual((await ben.data('expenses/' + p)).deletedBy, ana.uid, 'the bin names who really removed it');
  if (phones) assert.ok(await phones.next('Ben', /Ana removed a payment.*\$25\.00 payment from Ben to Ana/), 'Ben hears about it');
  assert.strictEqual((await cat.del('expenses/' + p)).status, 403, 'someone outside it cannot');
});

test('comments can still be deleted outright, and a delete of something missing is harmless', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(ana, 1000, { [ana.uid]: 500, [ben.uid]: 500 }))).status, 200);
  assert.strictEqual((await ana.set(`expenses/${e}/comments/c1`, { by: ana.uid, text: 'oops', at: Date.now() })).status, 200);
  assert.strictEqual((await ana.del(`expenses/${e}/comments/c1`)).status, 200);
  assert.strictEqual(await ana.data(`expenses/${e}/comments/c1`), null);
  assert.strictEqual((await ana.del('expenses/never_was')).status, 200);
  assert.strictEqual(await ana.data('expenses/never_was'), null);
});

// ---------- the change log ----------
test('every save is logged by the server: who, when, and the old and new values', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, { ...expense(ana, 8000, { [ana.uid]: 4000, [ben.uid]: 4000 }), v: 99, changes: [{ by: cat.uid, what: 'added' }] })).status, 200);
  let d = await ben.data('expenses/' + e);
  assert.strictEqual(d.v, 1, 'the version is the server’s, not the phone’s');
  assert.deepStrictEqual(d.changes.map(c => [c.what, c.by, c.v]), [['added', ana.uid, 1]], 'a faked log is thrown away');
  const r = await ben.update('expenses/' + e, { amount: 9000, split: { [ana.uid]: 4500, [ben.uid]: 4500 }, title: 'Groceries and wine', date: '2026-11-03', editedBy: cat.uid });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.versions['expenses/' + e], 2, 'the answer gives the new version');
  d = await ana.data('expenses/' + e);
  const last = d.changes.at(-1);
  assert.deepStrictEqual([last.what, last.by, last.v, d.v], ['edited', ben.uid, 2, 2]);
  assert.deepStrictEqual(last.diff.amount, [8000, 9000]);
  assert.deepStrictEqual(last.diff.title, ['Groceries', 'Groceries and wine']);
  assert.deepStrictEqual(last.diff.date, ['2026-11-01', '2026-11-03']);
  assert.deepStrictEqual(last.diff.split[1], { [ana.uid]: 4500, [ben.uid]: 4500 });
  assert.ok(last.at > 0);
  assert.strictEqual(d.editedBy, ben.uid, 'edited by whoever really did it');
  // a comment count going up is not a change worth a version
  assert.strictEqual((await ana.update('expenses/' + e, { comments: 1 })).status, 200);
  assert.strictEqual((await ana.data('expenses/' + e)).v, 2);
  // removing and restoring are logged too
  await ben.del('expenses/' + e); await ana.update('expenses/' + e, { deletedAt: null });
  d = await ana.data('expenses/' + e);
  assert.deepStrictEqual(d.changes.slice(-2).map(c => [c.what, c.by]), [['removed', ben.uid], ['restored', ana.uid]]);
  // a payment being confirmed is logged
  const p = id('p');
  await ben.set('expenses/' + p, payment(ben, ben.uid, ana.uid, 700, { confirmed: false }));
  await ana.update('expenses/' + p, { confirmed: true });
  assert.deepStrictEqual((await ben.data('expenses/' + p)).changes.map(c => c.what), ['added', 'confirmed']);
});

test('the log keeps the last 20 changes', async () => {
  const e = id();
  await ana.set('expenses/' + e, expense(ana, 100, { [ana.uid]: 100 }));
  for (let i = 0; i < 25; i++) assert.strictEqual((await ana.update('expenses/' + e, { title: 'Snack ' + i })).status, 200);
  const d = await ana.data('expenses/' + e);
  assert.strictEqual(d.changes.length, 20); assert.strictEqual(d.v, 26); assert.strictEqual(d.changes.at(-1).diff.title[1], 'Snack 24');
});

// ---------- stale edits ----------
test('a save made from an older version than someone else’s change is refused with 409', async () => {
  const e = id();
  await ana.set('expenses/' + e, expense(ana, 8000, { [ana.uid]: 4000, [ben.uid]: 4000 }));
  const opened = (await ana.data('expenses/' + e)).v;   // Ana opens it
  assert.strictEqual((await ben.update('expenses/' + e, { v: opened, amount: 6000, split: { [ana.uid]: 3000, [ben.uid]: 3000 } })).status, 200, 'Ben saves first');
  const r = await ana.update('expenses/' + e, { v: opened, title: 'Ana’s fix' });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.data, { error: 'This changed since you opened it. Have a look again.', code: 'stale' });
  assert.strictEqual((await ana.data('expenses/' + e)).title, 'Groceries', 'nothing of hers was saved');
  const now = (await ana.data('expenses/' + e)).v;
  assert.strictEqual((await ana.update('expenses/' + e, { v: now, title: 'Ana’s fix' })).status, 200, 'after looking again it saves');
  // a whole replace (set) is checked the same way
  assert.strictEqual((await ben.set('expenses/' + e, { ...expense(ben, 100, { [ben.uid]: 100 }, { addedBy: ana.uid }), v: opened })).status, 409);
  // and an offline edit made before someone else moved it to the bin comes back refused
  const v2 = (await ana.data('expenses/' + e)).v;
  await ana.del('expenses/' + e);
  assert.strictEqual((await ben.update('expenses/' + e, { v: v2, note: 'typed on the bus' })).status, 409);
});

test('your own edits in a row never clash, and saves without a version are not checked', async () => {
  const e = id();
  await ana.set('expenses/' + e, expense(ana, 8000, { [ana.uid]: 4000, [ben.uid]: 4000 }));
  const opened = (await ana.data('expenses/' + e)).v;
  // two edits queued offline from the same opened copy, sent one after the other
  assert.strictEqual((await ana.update('expenses/' + e, { v: opened, title: 'One' })).status, 200);
  assert.strictEqual((await ana.update('expenses/' + e, { v: opened, note: 'two' })).status, 200);
  assert.strictEqual((await ben.update('expenses/' + e, { note: 'no version sent' })).status, 200);
  assert.strictEqual((await ana.update('expenses/' + e, { v: (await ana.data('expenses/' + e)).v, title: 'Three' })).status, 200);
  // an entry from before versions existed (no v) takes a save from version 0
  assert.strictEqual((await ana.update('expenses/' + e, { v: 9999, title: 'From the future' })).status, 200, 'a newer number than stored is not stale');
});

// ---------- group rules ----------
test('only the group’s creator can rename it, delete it or hand it over', async () => {
  const g = await newGroup(ana, [ben]);
  assert.strictEqual((await ben.update('groups/' + g, { name: 'Ben’s house' })).status, 403);
  const r = await ben.update('groups/' + g, { createdBy: ben.uid });
  assert.strictEqual(r.status, 403); assert.match(r.data.error, /Ana, who made this group/);
  assert.strictEqual((await ben.del('groups/' + g)).status, 403);
  assert.strictEqual((await ben.set('groups/' + g, { name: 'Taken', createdBy: ben.uid })).status, 403);
  assert.strictEqual((await ben.update('groups/' + g, { emoji: 'party', simplify: false })).status, 200, 'everyday settings are for everyone');
  assert.strictEqual((await ana.update('groups/' + g, { name: 'Renamed' })).status, 200);
  assert.strictEqual((await ana.update('groups/' + g, { createdBy: cat.uid })).status, 403, 'not to someone outside the group');
  assert.strictEqual((await ana.update('groups/' + g, { createdBy: 'constructor' })).status, 403);
  assert.strictEqual((await ana.update('groups/' + g, { createdBy: ben.uid })).status, 200, 'handed over to Ben');
  assert.strictEqual((await ana.update('groups/' + g, { name: 'Ana again' })).status, 403, 'and now Ana can’t rename it');
  assert.strictEqual((await ben.update('groups/' + g, { name: 'Ben’s now' })).status, 200);
});

test('only the creator, or the person themselves, can take someone out of a group', async () => {
  const g = await newGroup(ana, [ben, cat]);
  const m = b => `groups/${g}/members/${b.uid}`;
  assert.strictEqual((await ben.update(m(cat), { active: false })).status, 403, 'Ben can’t move Cat out');
  assert.strictEqual((await ben.del(m(ana))).status, 403, 'or remove Ana');
  assert.strictEqual((await ben.set(m(cat), { kind: 'account', active: false })).status, 403);
  assert.strictEqual((await ben.update(m(cat), { color: 3 })).status, 200, 'other changes are fine');
  // a name-only guest can be taken out by whoever added them
  await ben.set(`groups/${g}/members/g_benspal`, { kind: 'guest', name: 'Pal', active: true, addedBy: ben.uid });
  await ana.set(`groups/${g}/members/g_anaspal`, { kind: 'guest', name: 'Other', active: true, addedBy: ana.uid });
  assert.strictEqual((await ben.update(`groups/${g}/members/g_benspal`, { active: false })).status, 200);
  assert.strictEqual((await ben.update(`groups/${g}/members/g_anaspal`, { active: false })).status, 403);
  // themselves, and the creator
  assert.strictEqual((await cat.update(m(cat), { active: false, leftAt: Date.now() })).status, 200, 'Cat leaves');
  assert.strictEqual((await ben.update(m(cat), { active: true })).status, 200, 'anyone can bring someone back');
  assert.strictEqual((await ana.update(m(ben), { active: false })).status, 200, 'the creator can move Ben out');
  assert.strictEqual((await ana.del(m(cat))).status, 200);
});

// ---------- what can be stored ----------
test('only the app’s own collections can be read or written', async () => {
  for (const p of ['junk/x', 'notes/n1', 'groups/' + GID + '/secrets/s1', 'expenses/e1/files/f1', 'people/x/extra/y', 'data/other/x/y'])
    assert.strictEqual((await ana.set(p, { hello: 1 })).status, 403, p);
  assert.strictEqual((await ana.doc('junk/x')).status, 403);
  assert.deepStrictEqual((await ana.col('junk')).data.docs, []);
  assert.strictEqual((await ana.set(`data/users/${ana.uid}/root/favs/f1`, { title: 'ok' })).status, 200, 'your private data still works');
  // the old single-house collections: read for the upgrade, written only by the owner
  assert.strictEqual((await ben.set('house/config', { name: 'x' })).status, 403);
  assert.strictEqual((await ana.set('house/config', { name: 'Old house', migratedTo: 'g_house' })).status, 200);
  assert.strictEqual((await ben.doc('house/config')).status, 200);
});

test('one document is capped at 256 KB, and one person at a set number per collection', async () => {
  const big = 'x'.repeat(300 * 1024);
  const r = await ana.set(`data/users/${ana.uid}/root/favs/big`, { note: big });
  assert.strictEqual(r.status, 413); assert.match(r.data.error, /too big/);
  assert.strictEqual((await ana.set('expenses/' + id(), expense(ana, 100, { [ana.uid]: 100 }, { note: big }))).status, 413);
  // this test server allows 30 per person per collection
  const root = `data/users/${cat.uid}/root/favs/`;
  const ops = []; for (let i = 0; i < 30; i++) ops.push({ op: 'set', path: root + 'f' + i, data: { at: i } });
  assert.strictEqual((await cat.write(...ops.slice(0, 20))).status, 200);
  const over = await cat.write(...ops.slice(20), { op: 'set', path: root + 'one-more', data: {} });
  assert.strictEqual(over.status, 429, 'the batch that goes over is refused whole');
  assert.strictEqual(await cat.data(root + 'f25'), null);
  assert.strictEqual((await cat.write(...ops.slice(20))).status, 200, 'up to the limit is fine');
  assert.strictEqual((await cat.set(root + 'one-more', {})).status, 429);
  assert.strictEqual((await cat.set(root + 'f3', { at: 'changed' })).status, 200, 'changing one you have is fine');
  assert.strictEqual((await ben.set(`data/users/${ben.uid}/root/favs/f1`, {})).status, 200, 'the limit is per person');
});

// ---------- people are looked up safely ----------
test('names like constructor are never taken for a real person', async () => {
  for (const fake of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.strictEqual((await ana.set('expenses/' + id(), expense(ana, 1000, { [ana.uid]: 500, [fake]: 500 }, { groupId: null }))).status, 422, fake + ' in a split');
    assert.strictEqual((await ana.set('expenses/' + id(), expense(ana, 1000, { [ana.uid]: 1000 }, { groupId: null, paidBy: fake }))).status, 422, fake + ' paying');
    assert.strictEqual((await ana.set('expenses/' + id(), payment(ana, fake, ana.uid, 500, { groupId: null, confirmed: true }))).status, 422, fake + ' in a payment');
    assert.strictEqual((await ana.post('/api/push/nudge', { to: fake, amount: 500 })).status, 400);
    assert.deepStrictEqual((await ana.get('/api/profiles?ids=' + fake)).data, {});
    assert.strictEqual((await ana.post('/api/admin/reset-link', { id: fake })).status, 404);
  }
});

// ---------- nudges ----------
test('a reminder only goes out for a debt that exists, and never for more than it', async () => {
  const g = await newGroup(cat, [ben]);
  assert.strictEqual((await cat.post('/api/push/nudge', { to: ben.uid, amount: 5000 })).status, 400, 'Ben owes Cat nothing yet');
  assert.match((await cat.post('/api/push/nudge', { to: ana.uid, amount: 5000 })).data.error, /doesn’t owe you/, 'nor Ana, who she shares nothing with');
  await cat.set('expenses/' + id(), expense(cat, 3000, { [cat.uid]: 1500, [ben.uid]: 1500 }, { groupId: g }));
  assert.strictEqual((await ben.post('/api/push/nudge', { to: cat.uid, amount: 1500 })).status, 400, 'the one who owes can’t nudge');
  const r = await cat.post('/api/push/nudge', { to: ben.uid, amount: 999999 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  if (phones) { const note = await phones.next('Ben', /Cat sent a reminder/); assert.ok(note); assert.match(note.body, /\$15\.00/, 'capped at what Ben owes'); }
  assert.strictEqual((await cat.post('/api/push/nudge', { to: ben.uid, amount: 1500 })).status, 429, 'still once per 6 hours');
});

// ---------- calendar link ----------
test('the calendar link can be replaced, and the old one stops working', async () => {
  const a = (await ben.post('/api/calendar')).data.url, again = (await ben.post('/api/calendar')).data.url;
  assert.strictEqual(a, again, 'the same link until you ask for a new one');
  const ics = u => fetch(`http://127.0.0.1:${PORT}` + new URL(u).pathname).then(r => r.status);
  assert.strictEqual(await ics(a), 200);
  const b = (await ben.post('/api/calendar', { fresh: true })).data.url;
  assert.notStrictEqual(a, b);
  assert.strictEqual(await ics(a), 404, 'the old link is dead');
  assert.strictEqual(await ics(b), 200);
});

// ---------- your own data ----------
test('download my data has your own things and nobody else’s private data', async () => {
  await ben.set(`data/users/${ben.uid}/root/entries/mine1`, { kind: 'expense', title: 'Ben private', amount: 100 });
  await ana.set(`data/users/${ana.uid}/root/entries/hers1`, { kind: 'expense', title: 'Ana private', amount: 100 });
  const e = id(); await ana.set('expenses/' + e, expense(ana, 2000, { [ana.uid]: 1000, [ben.uid]: 1000 }, { title: 'Shared pizza' }));
  const r = await ben.get('/api/me/export');
  assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="split-it-my-data-/);
  const d = r.data;
  assert.strictEqual(d.account.name, 'Ben'); assert.strictEqual(d.account.id, ben.uid);
  assert.ok(d.docs[`data/users/${ben.uid}/root/entries/mine1`]);
  assert.ok(d.docs['expenses/' + e]); assert.ok(d.docs['groups/' + GID]);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('Ana private'), 'not Ana’s private data');
  assert.ok(!/"hash"|"salt"|calToken/.test(text), 'no password hash or secret links');
  assert.strictEqual((await browser().get('/api/me/export')).status, 401);
});

test('delete my data needs the password, removes the private data, and keeps shared entries as a former member', async () => {
  assert.match(cli(['add-user', 'Gus'], 'gus-password\n'), /Added/);
  const gus = await as('Gus');
  const g = await newGroup(gus, [ana]);
  const shared = id(); await gus.set('expenses/' + shared, expense(gus, 4000, { [gus.uid]: 2000, [ana.uid]: 2000 }, { groupId: g, title: 'Paint' }));
  const alone = id(); await gus.set('expenses/' + alone, expense(gus, 500, { [gus.uid]: 500 }, { groupId: null, title: 'Just me' }));
  await gus.set('people/' + gus.uid, { nickname: 'Gussie', color: 1 });
  await gus.set(`data/users/${gus.uid}/root/entries/p1`, { kind: 'expense', title: 'Private', amount: 1 });

  assert.strictEqual((await gus.post('/api/me/delete', { password: 'wrong-password' })).status, 401);
  assert.strictEqual((await gus.get('/api/me')).status, 200, 'nothing happened');
  const r = await gus.post('/api/me/delete', { password: 'gus-password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await gus.get('/api/me')).status, 401, 'signed out');
  assert.strictEqual((await browser().signIn('Gus', 'gus-password')).status, 401, 'and can’t sign in again');

  assert.strictEqual(await ana.data('people/' + gus.uid), null, 'profile gone');
  assert.strictEqual(await ana.data('expenses/' + alone), null);
  const keep = await ana.data('expenses/' + shared);
  assert.strictEqual(keep.amount, 4000, 'the shared expense stays, so Ana’s balance doesn’t change');
  const m = await ana.data(`groups/${g}/members/${gus.uid}`);
  assert.deepStrictEqual([m.kind, m.name, m.active], ['guest', 'Former member', false]);
  assert.strictEqual((await ana.data('groups/' + g)).createdBy, ana.uid, 'the group passes to someone still in it');
  assert.strictEqual((await ana.get('/api/profiles?ids=' + gus.uid)).data[gus.uid].name, 'Former member');
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  assert.ok(!Object.keys(db.docs).some(k => k.startsWith(`data/users/${gus.uid}/`)), 'private data gone from the file too');
  assert.ok(!JSON.stringify(db).includes('Gussie'));
});

test('the only owner can’t delete themselves away, and the owner can still remove people', async () => {
  const r = await ana.post('/api/me/delete', { password: 'ana-password' });
  assert.strictEqual(r.status, 400); assert.match(r.data.error, /only owner/);
  assert.match(cli(['add-user', 'Hal'], 'hal-password\n'), /Added/);
  const hal = await as('Hal');
  assert.strictEqual((await ana.post('/api/admin/remove', { id: hal.uid })).status, 200);
  assert.strictEqual((await hal.get('/api/me')).status, 401);
});
