// The whole server, started for real on a spare port with an empty data folder:
// sign-in, who can see what, the money rules, sign-in codes, backups, laptop commands and the assistant connector.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-test-'));
const DATA = path.join(DIR, 'data'), COPIES = path.join(DIR, 'copies');
let PORT, FAKE_PORT, proc, fake, env, addr = 0;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
// node server.js COMMAND NAME, with the answers to its questions typed in
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// One browser: keeps its cookie, and arrives from its own address so the sign-in limits of one test never touch another.
function browser(ip) {
  const from = ip || `10.9.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf };
  };
  const me = {
    get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body), upload: (url, buf) => call('POST', url, buf, true),
    signIn: (name, password) => me.post('/api/login', { name, password }),
    write: (...ops) => me.post('/api/write', { ops }),
    set: (p, data) => me.write({ op: 'set', path: p, data }), update: (p, data) => me.write({ op: 'update', path: p, data }),
    doc: p => me.get('/api/doc?path=' + encodeURIComponent(p)), col: p => me.get('/api/col?path=' + encodeURIComponent(p)),
  };
  return me;
}
// A signed-in browser for someone. The uid comes back too.
async function as(name, password = name.toLowerCase() + '-password') {
  const b = browser(); const r = await b.signIn(name, password);
  assert.strictEqual(r.status, 200, `${name} signs in`);
  b.uid = (await b.get('/api/me')).data.uid; b.name = name;
  return b;
}

// The code an authenticator app would show (RFC 6238), written again here so the server's own maths is checked against it.
function appCode(secret, at = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = crypto.createHmac('sha1', key).update(msg).digest(), o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const mcpCall = async (key, method, params) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const tool = async (key, name, args = {}) => { const r = await mcpCall(key, 'tools/call', { name, arguments: args }); return { text: r.data.result.content[0].text, isError: !!r.data.result.isError }; };

let ana, ben, cat, GID;   // Ana (owner) and Ben share a group; Cat is in the house but not in that group
const member = (b, extra = {}) => ({ op: 'set', path: `groups/${GID}/members/${b.uid || b}`, data: { kind: 'account', active: true, joinedAt: Date.now(), ...extra } });
const expense = (by, amount, split, extra = {}) => ({ kind: 'expense', title: 'Groceries', amount, paidBy: by.uid, split, splitMode: 'exact', people: Object.keys(split), groupId: GID, date: '2026-11-01', createdAt: Date.now(), addedBy: by.uid, ...extra });
const payment = (by, from, to, amount, extra = {}) => ({ kind: 'payment', from, to, amount, date: '2026-11-02', createdAt: Date.now(), addedBy: by.uid, people: [from, to], groupId: GID, ...extra });
let n = 0; const id = (p = 'e') => `${p}_test${++n}`;

before(async () => {
  PORT = await freePort(); FAKE_PORT = await freePort();
  // stands in for GitHub's "latest release" answer
  fake = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v99.1.0', name: 'A much later one', html_url: 'https://github.com/sherrypanaich/split-it/releases/tag/v99.1.0' })); }).listen(FAKE_PORT, '127.0.0.1');
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: COPIES, RELEASES_URL: `http://127.0.0.1:${FAKE_PORT}/latest`,
    UPDATE_CHECK: '', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '' };
  for (const name of ['Ana', 'Ben', 'Cat']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben'); cat = await as('Cat');
  GID = 'g_test';
  assert.strictEqual((await ana.set('groups/' + GID, { name: 'Maple St', createdBy: ana.uid, createdAt: Date.now() })).status, 200);
  assert.strictEqual((await ana.write(member(ana), member(ben), { op: 'set', path: `groups/${GID}/members/guest_dee`, data: { kind: 'guest', name: 'Dee', active: true } })).status, 200);
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  if (fake) fake.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- signing in ----------
test('a wrong password is refused, and nothing answers without a sign-in', async () => {
  const b = browser();
  assert.strictEqual((await b.signIn('Ana', 'not-her-password')).status, 401);
  assert.strictEqual((await b.signIn('Nobody', 'whatever-it-is')).status, 401);
  assert.strictEqual((await b.get('/api/me')).status, 401);
  assert.strictEqual((await b.get('/api/col?path=expenses')).status, 401);
  assert.strictEqual((await b.write({ op: 'set', path: 'expenses/x', data: {} })).status, 401);
  assert.strictEqual((await b.get('/')).status, 302);
  assert.strictEqual((await ana.get('/api/me')).data.name, 'Ana');
  assert.strictEqual((await ana.get('/api/me')).data.isOwner, true, 'the first person added runs the house');
  assert.strictEqual((await ben.get('/api/me')).data.isOwner, false);
});

test('five wrong passwords from one address lock that address out, even with the right one', async () => {
  const b = browser('10.77.0.1');
  for (let i = 0; i < 5; i++) assert.strictEqual((await b.signIn('Cat', 'wrong-guess-' + i)).status, 401);
  assert.strictEqual((await b.signIn('Cat', 'cat-password')).status, 429);
  assert.strictEqual((await browser('10.77.0.2').signIn('Cat', 'cat-password')).status, 200, 'someone else is not locked out by it');
});

test('ten wrong passwords for one person slow that account down, but never lock its owner out', async () => {
  assert.match(cli(['add-user', 'Target'], 'target-password\n'), /Added/);
  for (let i = 0; i < 10; i++) assert.strictEqual((await browser(`10.78.0.${i + 1}`).signIn('Target', 'wrong-guess-' + i)).status, 401);
  const t0 = Date.now();
  assert.strictEqual((await browser('10.78.1.1').signIn('Target', 'target-password')).status, 200, 'the right password still gets in');
  assert.ok(Date.now() - t0 >= 900, 'after a slow-down');
  assert.strictEqual((await browser('10.78.1.2').signIn('Ben', 'ben-password')).status, 200, 'other people are not slowed');
});

// ---------- who sees what ----------
test('a group and everything in it is seen only by the people in it', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(ana, 3000, { [ana.uid]: 1500, [ben.uid]: 1500 }))).status, 200);
  assert.strictEqual((await ana.set(`expenses/${e}/comments/c1`, { text: 'receipt is on the fridge', by: ana.uid, at: Date.now() })).status, 200);
  assert.strictEqual((await ana.set('recurring/r_test', { title: 'Internet', amount: 8000, paidBy: ana.uid, groupId: GID, splitMode: 'equal', splitInput: { ids: [ana.uid, ben.uid] }, every: 'month', day: 1 })).status, 200);
  assert.strictEqual((await ana.set('chores/c_test', { title: 'Bins', groupId: GID, who: [ana.uid, ben.uid] })).status, 200);

  assert.strictEqual((await ben.doc('expenses/' + e)).data.data.amount, 3000);
  assert.ok((await ben.col('expenses')).data.docs.some(d => d.id === e));
  assert.strictEqual((await ben.col(`expenses/${e}/comments`)).data.docs.length, 1);

  for (const p of ['expenses/' + e, 'groups/' + GID, `groups/${GID}/members/${ana.uid}`, 'recurring/r_test', 'chores/c_test', `expenses/${e}/comments/c1`])
    assert.strictEqual((await cat.doc(p)).status, 403, 'Cat cannot read ' + p);
  for (const c of ['expenses', 'groups', `groups/${GID}/members`, 'recurring', 'chores', `expenses/${e}/comments`])
    assert.deepStrictEqual((await cat.col(c)).data.docs, [], 'Cat sees nothing in ' + c);

  assert.strictEqual((await cat.set('expenses/' + id(), expense(cat, 1000, { [cat.uid]: 1000 }))).status, 403, 'Cat cannot add to a group she is not in');
  assert.strictEqual((await cat.update('expenses/' + e, { title: 'Mine now' })).status, 403);
  assert.strictEqual((await cat.write({ op: 'delete', path: 'expenses/' + e })).status, 403);
  assert.strictEqual((await cat.write(member(cat))).status, 403, 'Cat cannot add herself to the group');
  assert.strictEqual((await cat.set(`expenses/${e}/comments/c2`, { text: 'hello', by: cat.uid })).status, 403);
  assert.strictEqual((await cat.update('recurring/r_test', { amount: 1 })).status, 403);
});

test('private data is yours alone, and a profile can only be changed by its owner', async () => {
  const mine = `data/users/${ana.uid}/root/entries/p1`;
  assert.strictEqual((await ana.set(mine, { kind: 'expense', title: 'Just mine', amount: 500 })).status, 200);
  assert.strictEqual((await ana.doc(mine)).data.data.title, 'Just mine');
  assert.strictEqual((await ben.doc(mine)).status, 403);
  assert.strictEqual((await ben.col(`data/users/${ana.uid}/root/entries`)).status, 403);
  assert.strictEqual((await ben.set(mine, { title: 'Ben was here' })).status, 403);
  assert.strictEqual((await ben.write({ op: 'delete', path: mine })).status, 403);

  assert.strictEqual((await ana.set('people/' + ana.uid, { nickname: 'Ana B', color: 2 })).status, 200);
  assert.strictEqual((await ben.set('people/' + ana.uid, { nickname: 'Not Ana' })).status, 403);
  assert.strictEqual((await ben.doc('people/' + ana.uid)).data.data.nickname, 'Ana B', 'names and colours are seen by everyone signed in');
});

test('an expense outside a group is seen only by the people on it', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(ana, 2000, { [ana.uid]: 1000, [cat.uid]: 1000 }, { groupId: null }))).status, 200);
  assert.strictEqual((await cat.doc('expenses/' + e)).status, 200);
  assert.strictEqual((await ben.doc('expenses/' + e)).status, 403);
  assert.ok(!(await ben.col('expenses')).data.docs.some(d => d.id === e));
});

test('paths that try to climb out of the data are refused', async () => {
  for (const p of ['../users', 'expenses/../../users.json', 'expenses//x', 'a b/c', 'expenses'])
    assert.strictEqual((await ana.set(p, { x: 1 })).status, 400, p);
  assert.strictEqual((await ana.get('/api/doc?path=' + encodeURIComponent('../users.json'))).status, 400);
});

// ---------- the money rules ----------
test('shares have to add up to the total, in whole cents, between people in the group', async () => {
  const bad = async (data, why) => { const r = await ana.set('expenses/' + id(), data); assert.strictEqual(r.status, 422, why + ': ' + JSON.stringify(r.data)); assert.ok(r.data.error.length > 10, 'says why in words'); };
  await bad(expense(ana, 3000, { [ana.uid]: 1500, [ben.uid]: 1400 }), 'shares one dollar short');
  await bad(expense(ana, 3000, { [ana.uid]: 1500.5, [ben.uid]: 1499.5 }), 'half cents');
  await bad(expense(ana, '3000', { [ana.uid]: 1500, [ben.uid]: 1500 }), 'amount as text');
  await bad(expense(ana, 3000, { [ana.uid]: 4000, [ben.uid]: -1000 }), 'a negative share on a normal expense');
  await bad(expense(ana, 3000, { [ana.uid]: 1500, [cat.uid]: 1500 }), 'someone who is not in the group');
  await bad(expense(ana, 3000, { [ana.uid]: 3000 }, { paidBy: cat.uid }), 'paid by someone who is not in the group');
  await bad(expense(ana, 3000, {}), 'no shares at all');
  await bad(expense(ana, 3000, { [ana.uid]: 1500, [ben.uid]: 1500 }, { addedBy: ben.uid }), 'logged under someone else');
  await bad({ ...expense(ana, 3000, { [ana.uid]: 3000 }), kind: 'gift' }, 'an unknown kind of entry');
  await bad(expense(ana, 2e12, { [ana.uid]: 2e12 }), 'an absurd amount');

  const ok = async (data, why) => { const e = id(); const r = await ana.set('expenses/' + e, data); assert.strictEqual(r.status, 200, why + ': ' + JSON.stringify(r.data)); return e; };
  await ok(expense(ana, 3001, { [ana.uid]: 1501, [ben.uid]: 1500 }), 'an odd cent');
  await ok(expense(ana, 3000, { [ana.uid]: 1000, [ben.uid]: 1000, guest_dee: 1000 }), 'a housemate without an account');
  await ok(expense(ana, -4000, { [ana.uid]: -2000, [ben.uid]: -2000 }), 'money in (a refund)');
  await ok(expense(ana, 0, {}, { status: 'needs_amount' }), 'a bill still waiting for its amount');
  await ok(expense(ana, 2500, { [ben.uid]: 2500 }, { paidBy: ben.uid }), 'adding an expense someone else paid');
});

test('changing an expense is checked again, but notes, comments and deleting are left alone', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(ana, 3000, { [ana.uid]: 1500, [ben.uid]: 1500 }))).status, 200);
  assert.strictEqual((await ben.update('expenses/' + e, { amount: 5000 })).status, 422, 'a new total without new shares');
  assert.strictEqual((await ben.update('expenses/' + e, { split: { [ana.uid]: 2900, [ben.uid]: 50 } })).status, 422);
  assert.strictEqual((await ben.update('expenses/' + e, { amount: 5000, split: { [ana.uid]: 2500, [ben.uid]: 2500 } })).status, 200);
  assert.strictEqual((await ben.update('expenses/' + e, { note: 'two bags', category: 'groceries' })).status, 200);
  assert.strictEqual((await ben.update('expenses/' + e, { deletedAt: Date.now(), deletedBy: ben.uid })).status, 200);
  assert.strictEqual((await ana.doc('expenses/' + e)).data.data.amount, 5000);
});

test('an older entry that would not pass today can still be commented on and deleted', async () => {
  // put one straight into the data the way an old version or an import might have left it
  const e = 'e_legacy';
  const before = await ana.get('/api/admin/backup');
  const zip = require('../server.js'), files = zip.zipRead(before.buf), db = JSON.parse(files['db.json'].toString('utf8'));
  db.docs['expenses/' + e] = { kind: 'expense', title: 'Old and odd', amount: 1000, paidBy: ana.uid, split: { [ana.uid]: 333, [ben.uid]: 333 }, groupId: GID, people: [ana.uid, ben.uid] };
  const r = await ana.upload('/api/admin/restore?name=db.json', Buffer.from(JSON.stringify(db)));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await ben.update('expenses/' + e, { note: 'what was this?' })).status, 200);
  assert.strictEqual((await ben.update('expenses/' + e, { paidBy: ben.uid })).status, 422, 'but changing its money means fixing it');
  assert.strictEqual((await ben.update('expenses/' + e, { deletedAt: Date.now() })).status, 200);
});

test('only the person who was paid can say the money arrived', async () => {
  // Ben says he paid Ana and tries to make it count himself
  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, ana.uid, 1500, { confirmed: true }))).status, 422);
  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, ana.uid, 1500))).status, 422, 'leaving the field out counts as confirmed too');
  const p = id('p');
  assert.strictEqual((await ben.set('expenses/' + p, payment(ben, ben.uid, ana.uid, 1500, { confirmed: false }))).status, 200);
  assert.strictEqual((await ben.update('expenses/' + p, { confirmed: true })).status, 422);
  assert.strictEqual((await ben.update('expenses/' + p, { note: 'e-Transfer' })).status, 200);
  assert.strictEqual((await ana.update('expenses/' + p, { confirmed: true })).status, 200, 'Ana got it, so she confirms');
  assert.strictEqual((await ben.update('expenses/' + p, { amount: 9900 })).status, 422, 'the payer cannot make a confirmed payment bigger');
  assert.strictEqual((await ben.update('expenses/' + p, { amount: 1000 })).status, 200, 'but can correct it down');

  assert.strictEqual((await ana.set('expenses/' + id('p'), payment(ana, ben.uid, ana.uid, 700, { confirmed: true }))).status, 200, 'the person paid can record it as received');
  assert.strictEqual((await ana.set('expenses/' + id('p'), payment(ana, ana.uid, 'guest_dee', 700, { confirmed: true }))).status, 200, 'someone without an account cannot confirm, so it counts right away');
  assert.strictEqual((await ana.set('expenses/' + id('p'), payment(ana, ben.uid, 'guest_dee', 700, { confirmed: true }))).status, 200);

  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, ben.uid, 500, { confirmed: false }))).status, 422, 'paying yourself');
  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, ana.uid, 0, { confirmed: false }))).status, 422);
  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, ana.uid, -500, { confirmed: false }))).status, 422);
  assert.strictEqual((await ben.set('expenses/' + id('p'), payment(ben, ben.uid, cat.uid, 500, { confirmed: false }))).status, 422, 'to someone outside the group');
});

test('a new housemate and their first expense can be saved together', async () => {
  const e = id();
  const r = await ana.write({ op: 'set', path: `groups/${GID}/members/guest_eli`, data: { kind: 'guest', name: 'Eli', active: true } },
    { op: 'set', path: 'expenses/' + e, data: expense(ana, 900, { [ana.uid]: 450, guest_eli: 450 }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
});

test('one bad change in a batch stops the whole batch', async () => {
  const good = id(), bad = id();
  const r = await ana.write({ op: 'set', path: 'expenses/' + good, data: expense(ana, 1000, { [ana.uid]: 500, [ben.uid]: 500 }) },
    { op: 'set', path: 'expenses/' + bad, data: expense(ana, 1000, { [ana.uid]: 500, [ben.uid]: 400 }) });
  assert.strictEqual(r.status, 422);
  assert.strictEqual((await ana.doc('expenses/' + good)).data.data, null, 'nothing from that batch was saved');
});

// ---------- sign-in code ----------
test('a sign-in code from an authenticator app is asked for after the password', async () => {
  assert.match(cli(['add-user', 'Dan'], 'dan-password\n'), /Added/);
  const dan = await as('Dan');
  assert.strictEqual((await dan.get('/api/account')).data.code, false);
  const start = await dan.post('/api/account/code/start');
  assert.match(start.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(start.data.uri, /^otpauth:\/\/totp\/Split%20it%3ADan\?secret=/);
  assert.strictEqual((await dan.post('/api/account/code/confirm', { code: '000000' })).status, 401, 'a wrong code does not turn it on');
  const at = Date.now(), used = appCode(start.data.secret, at);
  const next = appCode(start.data.secret, at + 30000);   // the code the app shows half a minute later
  const on = await dan.post('/api/account/code/confirm', { code: used });
  assert.strictEqual(on.status, 200, JSON.stringify(on.data));
  assert.strictEqual(on.data.backup.length, 8);
  assert.deepStrictEqual([(await dan.get('/api/account')).data.code, (await dan.get('/api/account')).data.backupCodes], [true, 8]);

  // signing in on a new phone
  const phone = browser();
  const step1 = await phone.signIn('Dan', 'dan-password');
  assert.strictEqual(step1.data.need, 'code'); assert.ok(step1.data.ticket);
  assert.strictEqual((await phone.get('/api/me')).status, 401, 'the password alone is not enough');
  assert.strictEqual((await phone.post('/api/login/code', { ticket: step1.data.ticket, code: '123456' })).status, 401);
  assert.strictEqual((await phone.post('/api/login/code', { ticket: 'made-up', code: next })).status, 410);
  // the code used to turn it on can't be used a second time, so the next one is needed
  assert.strictEqual((await phone.post('/api/login/code', { ticket: step1.data.ticket, code: used })).status, 401, 'a code works once');
  assert.strictEqual((await phone.post('/api/login/code', { ticket: step1.data.ticket, code: next })).status, 200);
  assert.strictEqual((await phone.get('/api/me')).data.name, 'Dan');

  // a backup code works once
  const tablet = browser(), t1 = await tablet.signIn('Dan', 'dan-password');
  assert.strictEqual((await tablet.post('/api/login/code', { ticket: t1.data.ticket, code: on.data.backup[0] })).status, 200);
  const again = browser(), t2 = await again.signIn('Dan', 'dan-password');
  assert.strictEqual((await again.post('/api/login/code', { ticket: t2.data.ticket, code: on.data.backup[0] })).status, 401);
  assert.strictEqual((await dan.get('/api/account')).data.backupCodes, 7);

  // a reset link changes the password but does not skip the code
  const link = (await ana.post('/api/admin/reset-link', { id: dan.uid })).data.url;
  const reset = await browser().post('/api/reset', { token: link.split('#reset=')[1], password: 'dan-new-password' });
  assert.deepStrictEqual([reset.status, reset.data.signin], [200, true]);
  assert.strictEqual((await dan.get('/api/me')).status, 401, 'and it signs out the other phones');

  // the owner can turn it off for someone who lost their phone; only the owner
  assert.strictEqual((await ben.post('/api/admin/code-off', { id: dan.uid })).status, 403);
  assert.ok((await ana.get('/api/admin/overview')).data.people.find(p => p.name === 'Dan').code);
  assert.strictEqual((await ana.post('/api/admin/code-off', { id: dan.uid })).data.was, true);
  assert.strictEqual((await browser().signIn('Dan', 'dan-new-password')).data.ok, true);
});

test('changing your password signs out your other phones and keeps this one', async () => {
  assert.match(cli(['add-user', 'Eve'], 'eve-password\n'), /Added/);
  const here = await as('Eve'), there = await as('Eve');
  assert.strictEqual((await here.post('/api/account/password', { current: 'wrong-one-here', next: 'eve-new-password' })).status, 401);
  assert.strictEqual((await here.post('/api/account/password', { current: 'eve-password', next: 'short' })).status, 400);
  assert.strictEqual((await here.post('/api/account/password', { current: 'eve-password', next: 'eve-new-password' })).status, 200);
  assert.strictEqual((await here.get('/api/me')).status, 200);
  assert.strictEqual((await there.get('/api/me')).status, 401);
  assert.strictEqual((await browser().signIn('Eve', 'eve-password')).status, 401);
});

// ---------- the owner's page ----------
test('only the owner reaches the owner tools', async () => {
  for (const p of ['/api/admin/overview', '/api/admin/backup', '/api/admin/update']) assert.strictEqual((await ben.get(p)).status, 403, p);
  for (const p of ['/api/admin/remove', '/api/admin/owner', '/api/admin/reset-link', '/api/admin/signout', '/api/admin/copy-now', '/api/admin/restore'])
    assert.strictEqual((await ben.post(p, { id: ana.uid, owner: false })).status, 403, p);
  const o = (await ana.get('/api/admin/overview')).data;
  assert.ok(o.people.length >= 3); assert.match(o.health.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!JSON.stringify(o).includes('"hash"'), 'no password hashes leave the laptop');
});

test('a backup zip brings everything back, and a restore can itself be undone', async () => {
  const kept = id(), lost = id();
  assert.strictEqual((await ana.set('expenses/' + kept, expense(ana, 1200, { [ana.uid]: 600, [ben.uid]: 600 }))).status, 200);
  const zip = await ana.get('/api/admin/backup');
  assert.strictEqual(zip.status, 200); assert.strictEqual(zip.buf.readUInt32LE(0), 0x04034b50, 'it is a zip');
  const names = Object.keys(require('../server.js').zipRead(zip.buf));
  assert.ok(names.includes('db.json') && names.includes('users.json'));
  assert.strictEqual((await ana.set('expenses/' + lost, expense(ana, 800, { [ana.uid]: 400, [ben.uid]: 400 }))).status, 200);
  const r = await ana.upload('/api/admin/restore?name=backup.zip', zip.buf);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await ana.doc('expenses/' + kept)).data.data.amount, 1200);
  assert.strictEqual((await ana.doc('expenses/' + lost)).data.data, null);
  assert.strictEqual((await ben.get('/api/me')).status, 200, 'people stay signed in through a restore');
  assert.ok(fs.readdirSync(path.join(DATA, 'backups')).some(f => /^before-restore-.*db\.json$/.test(f)), 'what was there before is kept');
  assert.strictEqual((await ana.upload('/api/admin/restore?name=x.zip', Buffer.from('not a zip at all'))).status, 400);
});

test('a full copy of the backup goes to the second place every day', async () => {
  const today = `split-it-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  assert.ok(fs.existsSync(path.join(COPIES, today)), 'written when the app started');
  const h = (await ana.get('/api/admin/overview')).data.health;
  assert.strictEqual(h.copyDir, COPIES); assert.ok(h.copyAt > 0); assert.strictEqual(h.copyError, null);
  const was = fs.statSync(path.join(COPIES, today)).size;
  assert.strictEqual((await ana.set('expenses/' + id(), expense(ana, 100, { [ana.uid]: 100 }))).status, 200);
  assert.strictEqual((await ana.post('/api/admin/copy-now')).status, 200);
  assert.ok(Object.keys(require('../server.js').zipRead(fs.readFileSync(path.join(COPIES, today)))).includes('db.json'));
  assert.ok(fs.statSync(path.join(COPIES, today)).size >= was);
  assert.ok(!fs.readdirSync(COPIES).some(f => f.endsWith('.part')));
});

test('the owner is told when a newer version is out', async () => {
  const u = (await ana.get('/api/admin/update')).data;
  assert.strictEqual(u.latest, '99.1.0'); assert.strictEqual(u.newer, true); assert.match(u.url, /^https:\/\/github\.com\//);
  const { newerThan } = require('../server.js');
  assert.ok(newerThan('v2.10.0', '2.9.9')); assert.ok(!newerThan('2.2.0', '2.2.0')); assert.ok(!newerThan('2.1.9', '2.2.0'));
});

// ---------- laptop commands while the app is running ----------
test('laptop commands reach the running app, so they take effect right away', async () => {
  assert.match(cli(['add-user', 'Fay'], 'fay-password\n'), /Added Fay/);
  const fay = await as('Fay');   // no restart needed
  const out = cli(['set-password', 'Fay'], 'fay-second-password\n');
  assert.match(out, /New password saved for Fay\. Signed out 1 session/);
  assert.strictEqual((await fay.get('/api/me')).status, 401, 'her old sign-in stopped working at once');
  assert.strictEqual((await browser().signIn('Fay', 'fay-password')).status, 401);
  const fay2 = await as('Fay', 'fay-second-password');
  assert.match(cli(['remove-user', 'Fay'], 'yes\n'), /Removed Fay/);
  assert.strictEqual((await fay2.get('/api/me')).status, 401);
  assert.match(cli(['list-users']), /Ana \(owner\)/);
  assert.ok(!/Fay/.test(cli(['list-users'])));
  assert.match(cli(['remove-user', 'Ana'], 'yes\n'), /is the owner/);
});

test('the door those commands use only opens from this computer with its secret', async () => {
  const lock = JSON.parse(fs.readFileSync(path.join(DATA, 'server.lock'), 'utf8'));
  const knock = (headers) => fetch(`http://127.0.0.1:${PORT}/api/local/cli`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ cmd: 'set-password', name: 'Ana', password: 'taken-over-123' }) });
  assert.strictEqual((await knock({})).status, 404);
  assert.strictEqual((await knock({ 'X-Local-Token': 'x'.repeat(lock.token.length) })).status, 404);
  assert.strictEqual((await knock({ 'X-Local-Token': lock.token, 'X-Forwarded-For': '203.0.113.9' })).status, 404, 'never through a tunnel or proxy');
  assert.strictEqual((await ana.get('/api/me')).status, 200, 'Ana is untouched');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(DATA, 'server.lock')).mode & 0o077, 0, 'only this user can read the secret');
});

// ---------- the assistant connector ----------
test('an assistant can do what its person can, and nothing more', async () => {
  const key = /(hsk_\S+)/.exec(cli(['mcp-key', 'Ben']))[1];
  assert.strictEqual((await mcpCall('hsk_not-a-real-key', 'tools/list')).status, 401);
  const names = (await mcpCall(key, 'tools/list')).data.result.tools.map(t => t.name);
  for (const t of ['get_balances', 'add_expense', 'record_payment', 'settle_up_plan', 'list_bills', 'month_summary']) assert.ok(names.includes(t), t);
  assert.strictEqual((await mcpCall(key, 'initialize', { protocolVersion: '2025-06-18' })).data.result.serverInfo.name, 'split-it');

  const before = (await ben.col('expenses')).data.docs.length;
  const a = await tool(key, 'add_expense', { title: 'Hydro', amount: 90, group: 'Maple St', shares: { Ana: 2, Ben: 1 } });
  assert.ok(!a.isError, a.text);
  assert.match(a.text, /Your share: \$30\.00\.$/, 'the answer says what your own share is (Budget it reads this)');
  const added = (await ben.col('expenses')).data.docs.map(d => d.data).find(e => e.title === 'Hydro');
  assert.deepStrictEqual([added.amount, added.split[ana.uid], added.split[ben.uid], added.paidBy], [9000, 6000, 3000, ben.uid]);
  assert.strictEqual((await ben.col('expenses')).data.docs.length, before + 1);

  const x = await tool(key, 'add_expense', { title: 'Paint', amount: 50, group: 'Maple St', exact_amounts: { Ana: 20, Ben: 20 } });
  assert.ok(x.isError, 'exact amounts that do not add up are refused: ' + x.text);
  const y = await tool(key, 'add_expense', { title: 'Paint', amount: 50, group: 'Maple St', exact_amounts: { Ana: 35.5, Ben: 14.5 } });
  assert.ok(!y.isError, y.text);
  const z = await tool(key, 'add_expense', { title: 'Their taxi', amount: 24, group: 'Maple St', exact_amounts: { Ana: 24 } });
  assert.match(z.text, /You’re not in this split\.$/, z.text);

  const pay = await tool(key, 'record_payment', { to: 'Ana', amount: 12.5, group: 'Maple St' });
  assert.match(pay.text, /confirm/);
  const p = (await ben.col('expenses')).data.docs.map(d => d.data).find(e => e.kind === 'payment' && e.via === 'assistant');
  assert.strictEqual(p.confirmed, false, 'a payment from an assistant waits for the other person too');

  for (const t of ['settle_up_plan', 'month_summary']) { const r = await tool(key, t, { group: 'Maple St' }); assert.ok(!r.isError && r.text.length > 10, t + ': ' + r.text); }
  assert.ok(!(await tool(key, 'list_bills', {})).isError);
  assert.match((await tool(key, 'list_bills', { group: 'Maple St' })).text, /Internet/);

  const catKey = /(hsk_\S+)/.exec(cli(['mcp-key', 'Cat']))[1];
  for (const t of ['settle_up_plan', 'month_summary', 'list_bills']) assert.ok((await tool(catKey, t, { group: 'Maple St' })).isError, 'Cat’s assistant cannot see the group with ' + t);
  assert.ok(!/Internet|Hydro/.test((await tool(catKey, 'list_bills', {})).text));
  assert.ok(!/Hydro/.test((await tool(catKey, 'recent_expenses', {})).text));
});

test('each person links their own assistants from the app, and only they can disconnect them', async () => {
  assert.strictEqual((await browser().get('/api/assistants')).status, 401, 'needs a sign-in');
  let r = await cat.get('/api/assistants');
  assert.strictEqual(r.status, 200);
  assert.match(r.data.url, /\/mcp$/);
  const before = r.data.list.length;

  // a key made in the app works on /mcp and acts as its person
  r = await cat.post('/api/assistants/key', { name: '  Muse   on my phone ' });
  assert.strictEqual(r.status, 200);
  const key = r.data.key;
  assert.match(key, /^hsk_/);
  assert.strictEqual((await mcpCall(key, 'tools/list')).status, 200);
  assert.match((await tool(key, 'get_balances')).text, /Cat/);
  const list = (await cat.get('/api/assistants')).data.list;
  assert.strictEqual(list.length, before + 1);
  const row = list.find(x => x.name === 'Muse on my phone');
  assert.strictEqual(row.kind, 'key');
  assert.ok(row.used > 0, 'it shows when it was last used');
  assert.ok(!JSON.stringify(list).includes(key.slice(4)), 'the list never shows the key itself');

  // an assistant connected by signing in (what Claude does) shows up under its own name
  const base = `http://127.0.0.1:${PORT}`, form = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '10.200.0.1' };
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 's', code_challenge: challenge, code_challenge_method: 'S256' };
  const back = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: form, body: new URLSearchParams({ ...q, name: 'Ben', password: 'ben-password' }) });
  const code = new URL(back.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(base + '/oauth/token', { method: 'POST', headers: form, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: q.redirect_uri }) })).json();
  assert.strictEqual((await mcpCall(tok.access_token, 'tools/list')).status, 200);
  const bens = (await ben.get('/api/assistants')).data.list;
  const claude = bens.find(x => x.name === 'Claude');
  assert.strictEqual(claude.kind, 'app');
  assert.ok(!bens.some(x => x.name === 'Muse on my phone'), 'Ben sees only his own');

  // someone else can't disconnect yours
  assert.strictEqual((await ben.post('/api/assistants/remove', { id: row.id })).data.removed, 0);
  assert.strictEqual((await mcpCall(key, 'tools/list')).status, 200);
  // you can
  assert.strictEqual((await cat.post('/api/assistants/remove', { id: row.id })).data.removed, 1);
  assert.strictEqual((await mcpCall(key, 'tools/list')).status, 401);
  // disconnecting Claude ends both its access and its refresh
  assert.strictEqual((await ben.post('/api/assistants/remove', { id: claude.id })).data.removed, 2);
  assert.strictEqual((await mcpCall(tok.access_token, 'tools/list')).status, 401);
  const again = await fetch(base + '/oauth/token', { method: 'POST', headers: form, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
  assert.strictEqual(again.status, 400);
  assert.strictEqual((await cat.post('/api/assistants/remove', {})).status, 400);
});

test('an assistant sees private one-on-ones with friends who are not on the app, and nobody else does', async () => {
  const root = `data/users/${cat.uid}/root`;
  assert.strictEqual((await cat.write(
    { op: 'set', path: `${root}/friends/f_raja`, data: { name: 'Raja', kind: 'contact' } },
    { op: 'set', path: `${root}/friends/f_moe`, data: { name: 'Moe', kind: 'contact' } },
    { op: 'set', path: `${root}/entries/e_raja1`, data: { kind: 'expense', title: 'Carried over', amount: 40708, paidBy: cat.uid, split: { f_raja: 40708 }, splitMode: 'exact', people: [cat.uid, 'f_raja'], friendId: 'f_raja', date: '2026-11-01', createdAt: Date.now(), addedBy: cat.uid } },
    { op: 'set', path: `${root}/entries/e_moe1`, data: { kind: 'expense', title: 'Concert', amount: 9000, paidBy: 'f_moe', split: { [cat.uid]: 4500, f_moe: 4500 }, splitMode: 'equal', people: ['f_moe', cat.uid], friendId: 'f_moe', date: '2026-11-03', createdAt: Date.now(), addedBy: cat.uid } },
    { op: 'set', path: `${root}/entries/e_moe2`, data: { kind: 'expense', title: 'Old one', amount: 500, paidBy: cat.uid, split: { f_moe: 500 }, people: [cat.uid, 'f_moe'], friendId: 'f_moe', date: '2026-10-01', createdAt: Date.now(), addedBy: cat.uid, deletedAt: Date.now() } })).status, 200);
  const key = /(hsk_\S+)/.exec(cli(['mcp-key', 'Cat']))[1];

  const bal = (await tool(key, 'get_balances')).text;
  assert.match(bal, /Raja owes you \$407\.08/, bal);
  assert.match(bal, /You owe Moe \$45\.00/, bal);
  assert.ok(!/\$5\.00/.test(bal), 'deleted ones do not count');
  const recent = (await tool(key, 'recent_expenses')).text;
  assert.match(recent, /Carried over \$407\.08.*one-on-one with Raja/, recent);

  const add = await tool(key, 'add_expense', { title: 'Lunch', amount: 20, with_person: 'Raja' });
  assert.ok(!add.isError, add.text);
  const saved = (await cat.col(`${root}/entries`)).data.docs.map(d => d.data).find(e => e.title === 'Lunch');
  assert.deepStrictEqual([saved.friendId, saved.groupId, saved.split.f_raja], ['f_raja', undefined, 1000]);
  assert.ok(!(await cat.col('expenses')).data.docs.some(d => d.data.title === 'Lunch'), 'it stays private');
  assert.ok(!(await tool(key, 'record_payment', { to: 'Moe', amount: 45 })).isError);
  assert.match((await tool(key, 'get_balances')).text, /Raja owes you \$417\.08/);
  assert.ok(!/Moe/.test((await tool(key, 'get_balances')).text), 'paying Moe back squares it');
  assert.match((await tool(key, 'delete_last_expense')).text, /payment/);

  const benKey = /(hsk_\S+)/.exec(cli(['mcp-key', 'Ben']))[1];
  for (const t of ['get_balances', 'recent_expenses']) assert.ok(!/Raja|Moe|Carried over/.test((await tool(benKey, t)).text), 'Ben’s assistant sees none of it: ' + t);
  assert.ok((await tool(benKey, 'add_expense', { title: 'x', amount: 1, with_person: 'Raja' })).isError);
});
