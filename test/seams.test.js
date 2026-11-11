// Where separate pieces of the server meet: bad input that used to crash a request, the bills of someone who
// deletes their data, a rates file that can't be written, the assistant on a full disk, a restore and the
// assistants signed in now, and "today" in the server's own time zone. The real server, on a spare port.
// Run with: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-seams-'));
const DATA = path.join(DIR, 'data');
const TZ = 'Pacific/Kiritimati';   // UTC+14: for most of the day its date isn't UTC's
let PORT, RATES_PORT, proc, rates, env, addr = 0;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const localDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const wait = ms => new Promise(r => setTimeout(r, ms));

function browser() {
  const from = `10.33.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  const me = {
    get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body), raw: (url, buf) => call('POST', url, buf, true),
    write: (...ops) => me.post('/api/write', { ops }), set: (p, data) => me.write({ op: 'set', path: p, data }),
    doc: p => me.get('/api/doc?path=' + encodeURIComponent(p)),
  };
  return me;
}
async function as(name) {
  const b = browser();
  assert.strictEqual((await b.post('/api/login', { name, password: name.toLowerCase() + '-password' })).status, 200, name + ' signs in');
  b.uid = (await b.get('/api/me')).data.uid;
  return b;
}
const mcp = async (key, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const tool = async (key, name, args) => (await mcp(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).data.result;
const keyFor = name => /(hsk_\S+)/.exec(cli(['mcp-key', name]))[1];

let ana, ben, GID = 'g_seams';
before(async () => {
  PORT = await freePort(); RATES_PORT = await freePort();
  rates = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ base: 'EUR', date: '2026-11-10', rates: { CAD: 1.5, USD: 1.1, GBP: 0.85 } })); }).listen(RATES_PORT, '127.0.0.1');
  env = { ...process.env, TZ, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: '', UPDATE_CHECK: 'off', RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', RATES_URL: `http://127.0.0.1:${RATES_PORT}/latest` };
  for (const name of ['Ana', 'Ben', 'Dan']) assert.match(cli(['add-user', name], name.toLowerCase() + '-password\n'), /Added/);
  fs.mkdirSync(path.join(DATA, 'rates.json'));   // a rates file that can't be written (here: a folder in its place)
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben');
  assert.strictEqual((await ana.set('groups/' + GID, { name: 'Seams St', createdBy: ana.uid, createdAt: Date.now() })).status, 200);
  assert.strictEqual((await ana.write({ op: 'set', path: `groups/${GID}/members/${ana.uid}`, data: { kind: 'account', active: true } },
    { op: 'set', path: `groups/${GID}/members/${ben.uid}`, data: { kind: 'account', active: true } })).status, 200);
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  if (rates) rates.close();
  try { fs.rmdirSync(path.join(DATA, 'db.json.tmp')); } catch {}
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('a request body that isn’t JSON, or is null, gets a 400, never a server error', async () => {
  for (const url of ['/api/write', '/api/batch', '/api/claims', '/api/claims/answer', '/api/login', '/api/join', '/api/push/nudge', '/api/friends/request', '/api/admin/rename', '/api/account/password'])
    for (const body of ['{', 'not json']) assert.strictEqual((await ana.raw(url, body)).status, 400, `${url} with ${body}`);
  for (const url of ['/api/write', '/api/batch', '/api/login', '/api/friends/answer', '/api/assistants/key', '/api/me/delete', '/api/calendar'])
    assert.ok((await ana.raw(url, 'null')).status < 500, url + ' with null');
  assert.strictEqual((await ana.raw('/api/write', 'null')).data.error, 'bad ops');
  assert.strictEqual((await ana.get('/api/me')).status, 200, 'and the server carries on');
});

test('the assistant connector answers junk with an error, not a crash', async () => {
  const key = keyFor('Ana');
  const nul = await mcp(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null });
  assert.strictEqual(nul.status, 200); assert.match(nul.data.error.message, /Unknown tool/);
  assert.strictEqual((await mcp(key, { jsonrpc: '2.0', id: 2, method: 'initialize', params: null })).data.result.serverInfo.name, 'split-it');
  const str = await tool(key, 'list_groups', 'not an object');
  assert.ok(Array.isArray(str.content), 'arguments that aren’t an object are treated as none');
  const form = body => fetch(`http://127.0.0.1:${PORT}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  for (const id of ['__proto__', 'constructor', 'toString']) assert.strictEqual((await form({ client_id: id, redirect_uri: 'https://x.example' })).status, 400, 'no app called ' + id);
  const tokenPost = (headers, body) => fetch(`http://127.0.0.1:${PORT}/oauth/token`, { method: 'POST', headers, body });
  assert.strictEqual((await tokenPost({ 'Content-Type': 'application/json' }, 'null')).status, 401);
  assert.strictEqual((await tokenPost({ 'Content-Type': 'application/json' }, JSON.stringify({ client_id: '__proto__', grant_type: 'authorization_code' }))).status, 401);
  assert.strictEqual((await tokenPost({ Authorization: 'Basic ' + Buffer.from('%zz:%').toString('base64') })).status, 401, 'a broken Basic header');
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' })).status, 400);
});

test('nobody called __proto__ can be sent a friend request or a hand-over', async () => {
  for (const to of ['__proto__', 'constructor']) {
    assert.strictEqual((await ana.post('/api/friends/request', { to })).status, 400, 'friend request to ' + to);
    const root = `data/users/${ana.uid}/root`;
    assert.strictEqual((await ana.set(`${root}/friends/f_kai`, { name: 'Kai', kind: 'contact' })).status, 200);
    assert.strictEqual((await ana.post('/api/claims', { contact: 'f_kai', to })).status, 400, 'claim to ' + to);
  }
});

test('a rates file that can’t be written doesn’t stop anything else being saved', async () => {
  const r = await ana.get('/api/rates');
  assert.strictEqual(r.status, 200); assert.ok(r.data.rates.USD > 0, 'the rates still come through');
  assert.strictEqual((await ana.set('people/' + ana.uid, { nickname: 'Annie' })).status, 200, 'saves still work');
  assert.ok(!(await ana.get('/api/admin/alerts')).data.alerts.some(a => a.kind === 'disk'), 'and the owner isn’t told the disk is failing');
});

test('someone who deletes their data has their bills paused for the group, like anyone who leaves', async () => {
  const dan = await as('Dan');
  assert.strictEqual((await ana.write({ op: 'set', path: `groups/${GID}/members/${dan.uid}`, data: { kind: 'account', active: true } })).status, 200);
  assert.strictEqual((await ana.set('recurring/b_rent', { title: 'Rent', groupId: GID, paidBy: dan.uid, amount: 90000, splitMode: 'equal',
    splitInput: { ids: [ana.uid, ben.uid, dan.uid] }, startMonth: '2099-01', day: 1, createdAt: Date.now(), addedBy: ana.uid })).status, 200);
  assert.strictEqual((await dan.post('/api/me/delete', { password: 'dan-password' })).status, 200);
  const bill = (await ana.doc('recurring/b_rent')).data.data;
  assert.strictEqual(bill.paused, true, 'it can’t charge someone who is gone');
  assert.strictEqual(bill.takeover?.who, dan.uid, 'and the group is asked who takes over');
  assert.strictEqual((await ana.doc(`groups/${GID}/members/${dan.uid}`)).data.data.active, false);
});

test('"today" is the server’s own day (TZ): a hand-over’s carried-over line and the data download', async () => {
  const root = `data/users/${ana.uid}/root`;
  assert.strictEqual((await ana.write(
    { op: 'set', path: `${root}/friends/f_lu`, data: { name: 'Lu', kind: 'contact' } },
    { op: 'set', path: `${root}/entries/e_lu1`, data: { kind: 'expense', title: 'Dinner', amount: 3000, paidBy: ana.uid, split: { [ana.uid]: 1000, f_lu: 1000, f_mo: 1000 },
      people: [ana.uid, 'f_lu', 'f_mo'], friendId: 'f_lu', date: '2026-10-01', createdAt: Date.now(), addedBy: ana.uid } })).status, 200);
  const sent = await ana.post('/api/claims', { contact: 'f_lu', to: ben.uid });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.data));
  assert.strictEqual((await ben.post('/api/claims/answer', { id: sent.data.id, yes: true })).status, 200);
  const line = (await ana.doc('expenses/x' + sent.data.id.slice(0, 12))).data.data;
  assert.strictEqual(line.title, 'Carried over from before you joined');
  assert.strictEqual(line.date, localDay());
  assert.ok(line.v >= 1, 'with a version, like every entry');
  const exp = await ana.get('/api/me/export');
  assert.match(exp.headers.get('content-disposition'), new RegExp(`split-it-my-data-${localDay()}\\.json`));
});

test('on a full disk, the assistant’s private one-on-ones and hand-overs are refused, not kept only in memory', async () => {
  const key = keyFor('Ana'), root = `data/users/${ana.uid}/root`, blocker = path.join(DATA, 'db.json.tmp');
  fs.mkdirSync(blocker);   // the next save of db.json fails, the way a full disk does
  try {
    assert.strictEqual((await ana.set('expenses/e_disk', { kind: 'expense', title: 'Milk', amount: 400, paidBy: ana.uid, split: { [ana.uid]: 200, [ben.uid]: 200 },
      people: [ana.uid, ben.uid], groupId: GID, date: '2026-11-01', createdAt: Date.now(), addedBy: ana.uid })).status, 507);
    const add = await tool(key, 'add_expense', { title: 'Taxi', amount: 12, with_person: 'Kai' });
    assert.ok(add.isError, add.content[0].text); assert.match(add.content[0].text, /Nothing was added/);
    const col = await ana.get('/api/col?path=' + encodeURIComponent(`${root}/entries`));
    assert.ok(!col.data.docs.some(d => d.data.title === 'Taxi'), 'nothing half-saved');
    assert.strictEqual((await ana.post('/api/claims', { contact: 'f_kai', to: ben.uid })).status, 507);
  } finally { fs.rmdirSync(blocker); }
  await wait(3200);   // failed saves are tried again at most every 3 seconds
  assert.ok(!(await tool(key, 'add_expense', { title: 'Taxi', amount: 12, with_person: 'Kai' })).isError, 'and once there is room it works');
});

test('a restore keeps the assistants signed in now, and doesn’t bring back one that was disconnected', async () => {
  const old = keyFor('Ana');
  assert.strictEqual((await mcp(old, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
  const zip = await ana.get('/api/admin/backup');
  assert.strictEqual(zip.status, 200);
  assert.ok((await ana.post('/api/assistants/remove', { id: 'all' })).data.removed >= 1);
  const now = keyFor('Ana');
  const r = await ana.raw('/api/admin/restore', zip.buf);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await mcp(old, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401, 'the disconnected one stays out');
  assert.strictEqual((await mcp(now, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200, 'the one connected now still works');
  assert.strictEqual((await ana.get('/api/me')).status, 200, 'and so does the owner’s own sign-in');
});
