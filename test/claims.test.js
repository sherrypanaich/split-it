// Taking over history logged before you joined (claims.js), personal invites, @tags and friend requests,
// against the real server on a spare port with an empty data folder.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-claims-'));
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


let ana, ben, GID;   // Ana logged things for Jay (not on the app yet) and Ben shares her group
const priv = (b, rest) => `data/users/${b.uid}/root/${rest}`;
const today = '2026-11-01';
async function join(token, name) {   // a new person opens an invite link and makes an account
  const b = browser();
  const peek = await b.post('/api/join', { token });
  assert.strictEqual(peek.status, 200, 'the link works');
  const r = await b.post('/api/join', { token, name, password: name.toLowerCase() + '-password' });
  assert.strictEqual(r.status, 200, 'they join');
  b.uid = (await b.get('/api/me')).data.uid; b.name = name; b.peek = peek.data;
  return b;
}
const balanceWith = async (b, other) => {   // what `other` owes b across shared entries just between them (+ = owed to b)
  const list = (await b.col('expenses')).data.docs;
  let v = 0;
  for (const d of Object.values(list)) { const e = d.data || d; if (!e || e.groupId || e.deletedAt) continue;
    if (e.kind === 'payment') { if (e.confirmed === false) continue; if (e.from === b.uid && e.to === other) v += e.amount; if (e.from === other && e.to === b.uid) v -= e.amount; continue; }
    for (const [id, c] of Object.entries(e.split || {})) { if (e.paidBy === b.uid && id === other) v += c; if (e.paidBy === other && id === b.uid) v -= c; } }
  return v;
};

before(async () => {
  PORT = await freePort(); FAKE_PORT = await freePort();
  fake = http.createServer((req, res) => { res.writeHead(404); res.end(); }).listen(FAKE_PORT, '127.0.0.1');
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: '', RELEASES_URL: `http://127.0.0.1:${FAKE_PORT}/latest`,
    UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '' };
  for (const name of ['Ana', 'Ben']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben');
  GID = 'g_house';
  assert.strictEqual((await ana.set('groups/' + GID, { name: 'House', createdBy: ana.uid, createdAt: Date.now() })).status, 200);
  const mem = (id, data) => ({ op: 'set', path: `groups/${GID}/members/${id}`, data });
  assert.strictEqual((await ana.write(mem(ana.uid, { kind: 'account', active: true }), mem(ben.uid, { kind: 'account', active: true }), mem('g_jay', { kind: 'guest', name: 'Jay', active: true }))).status, 200);
  // in the group: Ana paid $90 for the three of them, Jay paid Ana back $10
  const r1 = await ana.write(
    { op: 'set', path: 'expenses/e_h1', data: { kind: 'expense', title: 'Internet', amount: 9000, paidBy: ana.uid, split: { [ana.uid]: 3000, [ben.uid]: 3000, g_jay: 3000 }, people: [ana.uid, ben.uid, 'g_jay'], groupId: GID, date: today, createdAt: 1, addedBy: ana.uid } },
    { op: 'set', path: 'expenses/p_h1', data: { kind: 'payment', from: 'g_jay', to: ana.uid, amount: 1000, people: ['g_jay', ana.uid], groupId: GID, date: today, createdAt: 2, addedBy: ana.uid, confirmed: true } },
    { op: 'set', path: 'recurring/r_h1', data: { title: 'Rent', groupId: GID, paidBy: 'g_jay', amount: 100000, splitMode: 'equal', splitInput: { ids: [ana.uid, ben.uid, 'g_jay'] } } },
    { op: 'set', path: 'chores/c_h1', data: { title: 'Bins', groupId: GID, order: [ana.uid, 'g_jay'], turn: 1 } });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.data));
  // privately: Jay is Ana's contact; two one-on-ones and one with Mo (another contact) too
  const r2 = await ana.write(
    { op: 'set', path: priv(ana, 'friends/c_jay'), data: { kind: 'contact', name: 'Jay', color: 1 } },
    { op: 'set', path: priv(ana, 'friends/c_mo'), data: { kind: 'contact', name: 'Mo', color: 2 } },
    { op: 'set', path: priv(ana, 'entries/e_p1'), data: { kind: 'expense', title: 'Pizza', amount: 4000, paidBy: ana.uid, split: { [ana.uid]: 2000, c_jay: 2000 }, people: [ana.uid, 'c_jay'], friendId: 'c_jay', date: today, createdAt: 3, addedBy: ana.uid, note: 'Friday' } },
    { op: 'set', path: priv(ana, 'entries/p_p1'), data: { kind: 'payment', from: 'c_jay', to: ana.uid, amount: 500, people: ['c_jay', ana.uid], friendId: 'c_jay', date: today, createdAt: 4, addedBy: ana.uid, confirmed: true } },
    { op: 'set', path: priv(ana, 'entries/e_p2'), data: { kind: 'expense', title: 'Concert', amount: 9000, paidBy: ana.uid, split: { [ana.uid]: 3000, c_jay: 3000, c_mo: 3000 }, people: [ana.uid, 'c_jay', 'c_mo'], date: today, createdAt: 5, addedBy: ana.uid } });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  if (fake) fake.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let jay, claimId;
test('a personal invite shows counts before sign-up, never amounts', async () => {
  const dry = await ana.post('/api/claims', { contact: 'c_jay', guests: [{ gid: GID, id: 'g_jay' }], dry: true });
  assert.strictEqual(dry.status, 200, JSON.stringify(dry.data));
  assert.strictEqual(dry.data.preview.groups[0].balance, -2000, 'Jay owes $20 in the house');
  assert.strictEqual(dry.data.preview.oneOnOne.balance, -4500, 'and $15 + $30 to Ana privately');
  assert.strictEqual(dry.data.preview.oneOnOne.carried, 1, 'the concert has Mo in it too');
  assert.strictEqual((await ben.post('/api/claims', { contact: 'c_jay', link: true })).status, 400, 'Ben can’t hand over Ana’s contact');
  const r = await ana.post('/api/claims', { contact: 'c_jay', guests: [{ gid: GID, id: 'g_jay' }], link: true });
  assert.strictEqual(r.status, 200); assert.ok(r.data.token); claimId = r.data.id;
  jay = await join(r.data.token, 'Jay');
  assert.deepStrictEqual(jay.peek.waiting, { name: 'Jay', expenses: jay.peek.waiting.expenses, groups: 1 });
  assert.ok(jay.peek.waiting.expenses >= 4);
  assert.ok(!JSON.stringify(jay.peek).includes('4500') && !JSON.stringify(jay.peek).includes('Pizza'), 'no amounts or titles on the join page');
  assert.strictEqual((await browser().post('/api/join', { token: r.data.token })).status, 410, 'the link works once');
});

test('nothing moves until Jay says yes, and Jay sees what is waiting', async () => {
  assert.strictEqual((await jay.doc('expenses/e_h1')).status, 403, 'not in the group yet');
  const list = await jay.get('/api/claims');
  assert.strictEqual(list.data.incoming.length, 1);
  assert.strictEqual(list.data.incoming[0].preview.total, -6500);
  assert.ok(list.data.incoming[0].preview.items.some(i => i.title === 'Pizza'));
  assert.strictEqual((await ben.post('/api/claims/answer', { id: claimId, yes: true })).status, 410, 'only Jay can answer');
});

test('yes moves the group and private history, and every balance stays the same', async () => {
  const r = await jay.post('/api/claims/answer', { id: claimId, yes: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const e = (await jay.doc('expenses/e_h1')).data.data;
  assert.strictEqual(e.split[jay.uid], 3000); assert.ok(!('g_jay' in e.split));
  assert.strictEqual((await ana.doc(`groups/${GID}/members/g_jay`)).data.data, null, 'the name-only member is gone');
  assert.strictEqual((await ana.doc(`groups/${GID}/members/${jay.uid}`)).data.data.kind, 'account');
  assert.strictEqual((await ana.doc('recurring/r_h1')).data.data.paidBy, jay.uid);
  assert.deepStrictEqual((await ana.doc('chores/c_h1')).data.data.order, [ana.uid, jay.uid]);
  assert.strictEqual((await jay.doc('expenses/e_p1')).data.data.note, 'Friday', 'the pizza is shared now, note and all');
  assert.strictEqual((await ana.doc(priv(ana, 'entries/e_p1'))).data.data, null, 'and gone from Ana’s private notes');
  assert.strictEqual((await ana.doc(priv(ana, 'entries/e_p2'))).data.data.carried, claimId, 'the concert with Mo stays Ana’s');
  assert.strictEqual((await ben.doc('expenses/e_p1')).status, 403, 'Ben never sees the one-on-ones');
  assert.strictEqual(await balanceWith(ana, jay.uid), 4500, 'still $45 between them, counted once');
  assert.strictEqual(await balanceWith(jay, ana.uid), -4500);
  assert.strictEqual((await ana.doc(priv(ana, 'friends/c_jay'))).data.data, null);
  assert.strictEqual((await jay.doc(`data/users/${jay.uid}/root/friends/${ana.uid}`)).data.data.kind, 'account');
  assert.strictEqual((await jay.post('/api/claims/answer', { id: claimId, yes: true })).status, 410, 'only once');
});

test('undo puts it all back, unless something was changed since', async () => {
  const back = await jay.doc('expenses/e_h1');
  assert.strictEqual((await ben.post('/api/claims/undo', { id: claimId })).status, 404, 'Ben can’t undo it');
  // an edit since blocks undo
  assert.strictEqual((await ana.update('expenses/e_h1', { title: 'Internet (Nov)' })).status, 200);
  assert.strictEqual((await ana.post('/api/claims/undo', { id: claimId })).status, 409);
  assert.strictEqual((await ana.set('expenses/e_h1', back.data.data)).status, 200);
  const r = await ana.post('/api/claims/undo', { id: claimId });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await ana.doc(`groups/${GID}/members/g_jay`)).data.data.kind, 'guest');
  assert.strictEqual((await ana.doc(priv(ana, 'entries/e_p1'))).data.data.title, 'Pizza');
  assert.strictEqual((await ana.doc('expenses/e_p1')).data.data, null);
  assert.strictEqual((await ana.doc('expenses/e_h1')).data.data.split.g_jay, 3000);
});

test('someone already on the app gets a request; Not me moves nothing', async () => {
  const r = await ana.post('/api/claims', { guests: [{ gid: GID, id: 'g_jay' }], to: ben.uid });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await ben.get('/api/claims')).data.incoming.length, 1);
  assert.strictEqual((await ben.post('/api/claims/answer', { id: r.data.id, yes: false })).status, 200);
  assert.strictEqual((await ana.doc(`groups/${GID}/members/g_jay`)).data.data.kind, 'guest', 'still name-only');
  assert.strictEqual((await ana.get('/api/claims')).data.sent.find(c => c.id === r.data.id).status, 'no');
  // and Jay, now on the app, can take it as a request
  const r2 = await ben.post('/api/claims', { guests: [{ gid: GID, id: 'g_jay' }], to: jay.uid });
  assert.strictEqual(r2.status, 200, 'anyone in the group can hand over its name-only member');
  assert.strictEqual((await jay.post('/api/claims/answer', { id: r2.data.id, yes: true })).status, 200);
  assert.strictEqual((await jay.doc('expenses/e_h1')).data.data.split[jay.uid], 3000);
});

test('tags: everyone gets one, they are unique, and finding is exact', async () => {
  const a = (await ana.get('/api/account')).data.tag, j = (await jay.get('/api/account')).data.tag;
  assert.strictEqual(a, 'ana'); assert.strictEqual(j, 'jay');
  assert.strictEqual((await jay.post('/api/account/tag', { tag: '@Ana' })).status, 409, 'taken');
  assert.strictEqual((await jay.post('/api/account/tag', { tag: 'j!' })).status, 400);
  assert.strictEqual((await jay.post('/api/account/tag', { tag: 'jay_s' })).status, 200);
  assert.strictEqual((await ben.post('/api/people/find', { q: '@jay_s' })).data.uid, jay.uid);
  assert.strictEqual((await ben.post('/api/people/find', { q: 'ja' })).status, 404, 'no partial matches');
  assert.strictEqual((await ben.post('/api/people/find', { q: 'jay@example.com' })).status, 404, 'unchecked emails find nobody');
});

test('friend requests need a yes; a friend link adds right away', async () => {
  assert.match(cli(['add-user', 'Kim'], 'kim-password\n'), /Added/);
  const kim = await as('Kim');
  assert.strictEqual((await kim.post('/api/friends/request', { to: ben.uid })).data.asked, true);
  const inc = (await ben.get('/api/friends/requests')).data.incoming;
  assert.strictEqual(inc.length, 1); assert.strictEqual(inc[0].tag, 'kim');
  assert.strictEqual((await kim.doc(`data/users/${kim.uid}/root/friends/${ben.uid}`)).data.data, null, 'not friends yet');
  assert.strictEqual((await ben.post('/api/friends/answer', { id: inc[0].id, yes: true })).status, 200);
  assert.strictEqual((await kim.doc(`data/users/${kim.uid}/root/friends/${ben.uid}`)).data.data.kind, 'account');
  const link = (await ana.post('/api/friends/link')).data.url, token = link.split('#add=')[1];
  assert.ok(token);
  assert.strictEqual((await kim.post('/api/friends/link/use', { token: 'nope' + token })).status, 404);
  assert.strictEqual((await kim.post('/api/friends/link/use', { token })).data.uid, ana.uid);
  assert.strictEqual((await ana.doc(`data/users/${ana.uid}/root/friends/${kim.uid}`)).data.data.kind, 'account');
  const fresh = (await ana.post('/api/friends/link', { fresh: true })).data.url.split('#add=')[1];
  assert.notStrictEqual(fresh, token);
  assert.strictEqual((await kim.post('/api/friends/link/use', { token })).status, 404, 'an old link stops working');
});

test('open invite links can be listed and cancelled, which cancels the claim too', async () => {
  const r = await ana.post('/api/claims', { contact: 'c_mo', link: true });
  assert.strictEqual(r.status, 200);
  const list = (await ana.get('/api/invites')).data.list;
  const inv = list.find(i => i.claim === r.data.id); assert.ok(inv); assert.strictEqual(inv.name, 'Mo');
  assert.strictEqual((await ana.post('/api/invites/cancel', { id: inv.id })).status, 200);
  assert.strictEqual((await browser().post('/api/join', { token: r.data.token })).status, 410);
  assert.strictEqual((await ana.get('/api/claims')).data.sent.some(c => c.id === r.data.id), false, 'cancelled ones drop off');
});
