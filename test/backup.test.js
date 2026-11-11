// Backups, restores, a full disk and the time zone, with a server of its own: locked copies (BACKUP_PASSPHRASE),
// receipt photos copied once, restores that check the file first, the laptop restore command, and a far-off TZ.
// Run with: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-backup-test-'));
const DATA = path.join(DIR, 'data'), COPIES = path.join(DIR, 'copies');
const PASS = 'correct horse battery staple';
const ZONE = 'Pacific/Kiritimati';   // UTC+14, so its "today" is a different day from UTC's for most of the day
const zoneDay = (t = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
let PORT, proc, env, addr = 0;
const S = require('../server.js');

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '', extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
async function start() {
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 20000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
}
async function stop() { if (proc && proc.exitCode === null) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; } proc = null; }
function browser() {
  const from = `10.8.${++addr >> 8}.${addr & 255}`; let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  return { call, get: u => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h),
    set: (p, data) => call('POST', '/api/write', { ops: [{ op: 'set', path: p, data }] }), doc: p => call('GET', '/api/doc?path=' + encodeURIComponent(p)) };
}
let ana, uid, n = 0;
const id = () => `e_bk${++n}`;
const expense = amount => ({ kind: 'expense', title: 'Groceries', amount, paidBy: uid, split: { [uid]: amount }, splitMode: 'exact', people: [uid], date: '2026-11-01', createdAt: Date.now(), addedBy: uid });
async function signIn() { ana = browser(); assert.strictEqual((await ana.post('/api/login', { name: 'Ana', password: 'ana-password' })).status, 200); uid = (await ana.get('/api/me')).data.uid; }
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), require('crypto').randomBytes(400)]);

before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: COPIES, BACKUP_PASSPHRASE: PASS, TZ: ZONE,
    UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '' };
  assert.match(cli(['add-user', 'Ana'], 'ana-password\n'), /Added/);
  await start(); await signIn();
});
after(async () => { await stop(); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('the server works out "today" in its TZ time zone, and says which zone that is', async () => {
  const h = (await ana.get('/api/admin/overview')).data.health;
  assert.strictEqual(h.timeZone, ZONE);
  assert.strictEqual(h.serverTime.slice(0, 10), zoneDay());
  assert.ok(fs.readdirSync(DATA + '/backups').includes(`db-${zoneDay()}.json`), 'the daily copy is named by the local day, not the UTC one');
  assert.ok(fs.readdirSync(COPIES).includes(`split-it-backup-${zoneDay()}.locked`));
});

test('a copy of the records is taken when the app starts', async () => {
  assert.ok(fs.readdirSync(DATA + '/backups').some(f => new RegExp(`^db-${zoneDay()}-\\d{4}\\.json$`).test(f)));
});

test('an expense is on disk before the phone hears it was saved', async () => {
  const e = id();
  assert.strictEqual((await ana.set('expenses/' + e, expense(700))).status, 200);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).docs['expenses/' + e].amount, 700);
});

test('copies off the laptop are locked, hold no sign-ins, and each photo is copied once', async () => {
  const ph = await ana.call('POST', '/api/photo', jpeg(), { 'Content-Type': 'image/jpeg' });
  assert.strictEqual(ph.status, 200);
  assert.strictEqual((await ana.post('/api/admin/copy-now')).status, 200);
  const file = path.join(COPIES, `split-it-backup-${zoneDay()}.locked`), buf = fs.readFileSync(file);
  assert.ok(S.isLocked(buf), 'it starts with the lock mark');
  assert.ok(!buf.includes(Buffer.from('"docs"')), 'nothing readable inside');
  assert.throws(() => S.unlockBuf(buf, 'not the passphrase'), /passphrase/);
  const files = S.zipRead(S.unlockBuf(buf, PASS));
  assert.ok(files['db.json'] && files['users.json']);
  const u = JSON.parse(files['users.json']);
  assert.deepStrictEqual(u.sessions, {}, 'no sign-ins in a backup');
  assert.ok(!files['push.json'] && !files['push-keys.json'], 'no phone notification keys');
  assert.ok(!Object.keys(files).some(f => f.startsWith('photos/')), 'photos are not in the daily file');
  const photo = path.join(COPIES, 'photos', ph.data.id + '.jpg.locked');
  assert.ok(fs.existsSync(photo), 'the photo went to photos/, locked');
  assert.ok(S.unlockBuf(fs.readFileSync(photo), PASS).equals(fs.readFileSync(path.join(DATA, 'photos', ph.data.id + '.jpg'))));
  const was = fs.statSync(photo).mtimeMs;
  assert.strictEqual((await ana.post('/api/admin/copy-now')).status, 200);
  assert.strictEqual(fs.statSync(photo).mtimeMs, was, 'a photo already there is not copied again');
  const h = (await ana.get('/api/admin/overview')).data.health;
  assert.strictEqual(h.copyLocked, true);
  assert.ok(!JSON.stringify(h).includes(PASS), 'the passphrase never leaves the laptop');
});

test('the owner can download a locked backup, and restoring it asks for the passphrase', async () => {
  const kept = id(), lost = id();
  assert.strictEqual((await ana.set('expenses/' + kept, expense(1100))).status, 200);
  const dl = await ana.get('/api/admin/backup?lock=1');
  assert.strictEqual(dl.status, 200); assert.ok(S.isLocked(dl.buf)); assert.match(dl.headers.get('content-disposition'), /\.locked"/);
  const typed = await ana.post('/api/admin/backup', { passphrase: 'another-one-123' });
  assert.ok(S.isLocked(typed.buf)); assert.ok(S.zipRead(S.unlockBuf(typed.buf, 'another-one-123'))['db.json']);
  assert.strictEqual((await ana.post('/api/admin/backup', { passphrase: 'short' })).status, 400);
  const plain = await ana.get('/api/admin/backup');
  assert.ok(Object.keys(S.zipRead(plain.buf)).some(f => f.startsWith('photos/')), 'a download has the photos in it');
  assert.strictEqual((await ana.set('expenses/' + lost, expense(900))).status, 200);
  const none = await ana.call('POST', '/api/admin/restore', dl.buf);
  assert.strictEqual(none.status, 401); assert.strictEqual(none.data.locked, true);
  assert.strictEqual((await ana.call('POST', '/api/admin/restore', dl.buf, { 'X-Backup-Passphrase': 'wrong-pass' })).status, 401);
  assert.strictEqual((await ana.doc('expenses/' + lost)).data.data.amount, 900, 'nothing changed by a wrong passphrase');
  const ok = await ana.call('POST', '/api/admin/restore', dl.buf, { 'X-Backup-Passphrase': encodeURIComponent(PASS) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.strictEqual((await ana.doc('expenses/' + kept)).data.data.amount, 1100);
  assert.strictEqual((await ana.doc('expenses/' + lost)).data.data, null);
  assert.strictEqual((await ana.get('/api/me')).status, 200, 'still signed in after the restore');
});

test('a restore checks the file first and refuses the wrong shape without breaking anything', async () => {
  const e = id(); assert.strictEqual((await ana.set('expenses/' + e, expense(300))).status, 200);
  for (const bad of ['{"docs":null}', '{"docs":[]}', '{"docs":{"expenses/x":null}}', '{"docs":{"expenses":{}}}', '{"nope":1}', '{broken']) {
    const r = await ana.call('POST', '/api/admin/restore?name=db.json', Buffer.from(bad));
    assert.strictEqual(r.status, 400, bad); assert.match(r.data.error, /Nothing was changed|damaged/, bad);
  }
  const badZip = S.zipWrite([{ name: 'db.json', data: Buffer.from('{"docs":null}') }]);
  assert.strictEqual((await ana.call('POST', '/api/admin/restore', badZip)).status, 400);
  const badUsers = S.zipWrite([{ name: 'db.json', data: Buffer.from('{"docs":{}}') }, { name: 'users.json', data: Buffer.from('{"users":null}') }]);
  assert.strictEqual((await ana.call('POST', '/api/admin/restore', badUsers)).status, 400);
  assert.strictEqual((await ana.doc('expenses/' + e)).data.data.amount, 300, 'the app still works and nothing was replaced');
  assert.strictEqual(S.dataProblem({ docs: {} }), null);
});

test('the laptop restore command puts a copy back while the app runs, photos included', async () => {
  const ph = (await ana.call('POST', '/api/photo', jpeg(), { 'Content-Type': 'image/jpeg' })).data.id;
  const kept = id(); assert.strictEqual((await ana.set('expenses/' + kept, expense(4200))).status, 200);
  assert.strictEqual((await ana.post('/api/admin/copy-now')).status, 200);
  const copy = path.join(COPIES, `split-it-backup-${zoneDay()}.locked`);
  const lost = id(); assert.strictEqual((await ana.set('expenses/' + lost, expense(10))).status, 200);
  fs.unlinkSync(path.join(DATA, 'photos', ph + '.jpg'));
  const out = cli(['restore', copy]);
  assert.match(out, /Restored \d+ records/, out);
  assert.strictEqual((await ana.doc('expenses/' + kept)).data.data.amount, 4200, 'the running app has it at once');
  assert.strictEqual((await ana.doc('expenses/' + lost)).data.data, null);
  assert.ok(fs.existsSync(path.join(DATA, 'photos', ph + '.jpg')), 'the photo came back from the photos folder next to the copy');
  assert.match(cli(['restore', copy], 'wrong passphrase here\n', { BACKUP_PASSPHRASE: '' }), /Nothing was restored\. That passphrase doesn’t open this backup/);
  assert.match(cli(['restore', path.join(DIR, 'no-such-file.zip')]), /Usage/);
});

test('a full disk refuses changes with a clear message, keeps serving, and the owner is told', async () => {
  const blocker = path.join(DATA, 'db.json.tmp');
  fs.mkdirSync(blocker);   // the next save of db.json can't write its temporary file, as on a full disk
  try {
    const e = id(), r = await ana.set('expenses/' + e, expense(500));
    assert.strictEqual(r.status, 507); assert.match(r.data.error, /wasn’t saved/);
    assert.strictEqual((await ana.doc('expenses/' + e)).data.data, null, 'what was refused is not shown as saved');
    assert.strictEqual((await ana.set('people/' + uid, { nickname: 'A' })).status, 507, 'other changes wait too');
    assert.strictEqual((await ana.get('/api/me')).status, 200, 'reading still works');
    const alerts = (await ana.get('/api/admin/alerts')).data.alerts;
    assert.ok(alerts.some(a => a.kind === 'disk'), JSON.stringify(alerts));
  } finally { fs.rmSync(blocker, { recursive: true, force: true }); }
  await new Promise(r => setTimeout(r, 3200));   // the next try after the 3-second pause
  const e2 = id(); assert.strictEqual((await ana.set('expenses/' + e2, expense(600))).status, 200, 'saving works again once there is room');
  assert.ok(!(await ana.get('/api/admin/alerts')).data.alerts.some(a => a.kind === 'disk'));
});

test('if db.json is damaged at start, the owner sees which copy was used and when', async () => {
  await stop();
  fs.writeFileSync(path.join(DATA, 'db.json'), '{"docs":null}');   // parses, but is not Split it data
  await start(); await signIn();
  const alerts = (await ana.get('/api/admin/alerts')).data.alerts, r = alerts.find(a => a.kind === 'recovered');
  assert.ok(r, JSON.stringify(alerts)); assert.match(r.text, /db\.json was damaged .* put back from the copy db-[\d-]+\.json, taken /);
  assert.ok(fs.readdirSync(DATA).some(f => f.startsWith('db.json.damaged-')), 'the damaged file is kept');
  assert.ok((await ana.get('/api/admin/overview')).data.alerts.some(a => a.kind === 'recovered'), 'also on the owner’s page');
  await stop(); await start(); await signIn();
  assert.ok((await ana.get('/api/admin/alerts')).data.alerts.some(a => a.kind === 'recovered'), 'still shown after a restart');
  assert.strictEqual((await ana.post('/api/admin/alerts/dismiss')).status, 200);
  assert.ok(!(await ana.get('/api/admin/alerts')).data.alerts.some(a => a.kind === 'recovered'));
});
