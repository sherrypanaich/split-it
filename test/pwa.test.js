// What only shows up on a real phone: the service worker taking over after an update, the offline queue
// in a real browser, two people sharing one phone, and the page published as a Claude artifact (no shim.js).
// Needs Playwright with Chromium installed. Without it (as on GitHub's test runners) these are skipped.
// Run with: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
let pw = null, why = false;
try { pw = require('playwright'); if (!fs.existsSync(pw.chromium.executablePath())) why = 'Chromium for Playwright is not installed'; }
catch { why = 'Playwright is not installed'; }

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const day = () => new Date().toISOString().slice(0, 10);

// A house on a temporary DATA_DIR, with Ana and Ben, that can be stopped and started again (also as another version).
async function house(prefix) {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const PORT = await freePort(), B = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, DATA_DIR: path.join(DIR, 'data'), PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '' };
  let proc = null;
  const h = {
    DIR, B,
    addUsers: (server = SERVER) => { for (const n of ['Ana', 'Ben']) spawnSync(process.execPath, [server, 'add-user', n], { env, input: 'some-password\n' }); },
    start: (server = SERVER) => new Promise((res, rej) => {
      proc = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
      const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
      proc.stdout.on('data', d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } });
      proc.stderr.on('data', d => { out += d; });
      proc.on('exit', c => rej(new Error('server stopped (' + c + '): ' + out)));
    }),
    stop: async () => { if (!proc) return; const p = proc; proc = null; const gone = new Promise(r => p.on('exit', r)); p.kill(); await gone; },
    api: async (cookie, method, url, body) => {
      const r = await fetch(B + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) };
    },
    signIn: async name => { const r = await h.api('', 'POST', '/api/login', { name, password: 'some-password' }); assert.strictEqual(r.status, 200);
      return { cookie: r.cookie, uid: (await h.api(r.cookie, 'GET', '/api/me')).data.uid }; },
    put: async (who, url, ...ops) => { const r = await h.api(who.cookie, 'POST', url, { ops }); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); },
    docs: async who => (await h.api(who.cookie, 'GET', '/api/col?path=expenses')).data.docs,
    done: async () => { await h.stop(); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
  return h;
}
const set = (p, data) => ({ op: 'set', path: p, data });
const expense = (by, title, amount, people, extra = {}) => ({ kind: 'expense', title, amount, paidBy: by, split: Object.fromEntries(people.map(id => [id, amount / people.length])),
  splitMode: 'equal', splitInput: { ids: people }, people, groupId: null, date: day(), createdAt: Date.now(), addedBy: by, category: 'groceries', ...extra });
async function profile(h, who, name) { await h.put(who, '/api/write', set('people/' + who.uid, { nickname: name, joinedAt: Date.now(), guide: 'none' })); }
async function houseGroup(h, ana, ben) {
  const now = Date.now();
  await h.put(ana, '/api/write', set('groups/g1', { name: 'House', createdBy: ana.uid, createdAt: now, simplify: true, archived: false }));
  await h.put(ana, '/api/write', set(`groups/g1/members/${ana.uid}`, { kind: 'account', active: true, joinedAt: now }), set(`groups/g1/members/${ben.uid}`, { kind: 'account', active: true, joinedAt: now + 1 }));
}
const cookieFor = (h, who) => ({ name: who.cookie.split('=')[0], value: who.cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' });
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn())) return v; await new Promise(r => setTimeout(r, 200)); } return v; };
const watch = page => { const errors = []; page.on('pageerror', e => errors.push(String(e.stack || e))); page.on('dialog', d => d.dismiss().catch(() => {})); return errors; };
const signedIn = page => page.waitForSelector('#tabs:not([hidden])', { timeout: 15000 });
const pending = page => page.evaluate(() => window.HouseSplitOffline.pending());
const cacheNames = page => page.evaluate(() => caches.keys());

// The release before this one, from git. Not there (a shallow clone, a download): that test is skipped.
function oldRelease() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-old-'));
  for (const ref of ['v2.1.0', 'e2639cb']) {
    const a = spawnSync('git', ['archive', ref], { cwd: ROOT, maxBuffer: 1 << 28 });
    if (a.status !== 0 || !a.stdout.length) continue;
    if (spawnSync('tar', ['-x', '-C', dir], { input: a.stdout }).status === 0 && fs.existsSync(path.join(dir, 'server.js'))) return dir;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}
const OLD = why ? null : oldRelease();

test('updating from the last release: the new service worker takes over, old copies go, changes left waiting are sent once', { skip: why || (!OLD && 'the previous release is not in this git checkout'), timeout: 120000 }, async () => {
  const h = await house('split-it-pwa-upd-'), OLDSERVER = path.join(OLD, 'server.js');
  let browser;
  try {
    h.addUsers(OLDSERVER); await h.start(OLDSERVER);
    const ana = await h.signIn('Ana'), ben = await h.signIn('Ben');
    await profile(h, ana, 'Ana'); await profile(h, ben, 'Ben');
    await h.put(ana, '/api/write', set('expenses/e_seed', expense(ana.uid, 'Seeded', 500, [ana.uid])));
    await h.put(ben, '/api/write', set('expenses/e_ben', expense(ben.uid, 'Ben private', 700, [ben.uid])));
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addCookies([cookieFor(h, ana)]);
    const page = await ctx.newPage(), errors = watch(page);
    await page.goto(h.B + '/'); await signedIn(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await signedIn(page);
    assert.ok((await waitFor(async () => (await cacheNames(page)).includes('split-it-data-v3'))), 'the old release kept its copy');
    // what the old release left waiting: one change per item, no owner
    await page.evaluate(([uid, d]) => localStorage.setItem('hs-queue', JSON.stringify([
      { op: 'set', path: 'expenses/e_old', data: { kind: 'expense', title: 'Queued before the update', amount: 1000, paidBy: uid, split: { [uid]: 1000 }, splitMode: 'exact', people: [uid], groupId: null, date: d, createdAt: Date.now(), addedBy: uid } },
      { op: 'update', path: 'expenses/e_old', data: { title: 'Queued and edited' } },
      { op: 'update', path: 'expenses/e_seed', data: { deletedAt: Date.now(), deletedBy: uid } }
    ])), [ana.uid, day()]);

    const sub = n => ({ endpoint: 'https://push.example/' + n, keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual((await h.api(ben.cookie, 'POST', '/api/push/subscribe', sub('ben-phone'))).status, 200);
    await h.stop(); await h.start();
    // sign-ins from before (kept hashed now) still work, for notifications too, and old subscriptions are kept
    assert.deepStrictEqual((await h.api(ben.cookie, 'GET', '/api/push/who')).data.uids, [ben.uid]);
    assert.strictEqual((await h.api(ana.cookie, 'POST', '/api/push/subscribe', sub('ana-phone'))).status, 200);
    assert.deepStrictEqual((await h.api(ben.cookie, 'GET', '/api/push/who')).data.uids.sort(), [ana.uid, ben.uid].sort());
    const writes = [];
    page.on('response', r => { if (r.request().method() === 'POST' && /\/api\/(write|batch)$/.test(r.url())) writes.push(r.status() + ' ' + r.request().postData()); });
    await page.reload(); await signedIn(page);
    assert.ok(await waitFor(async () => !(await pending(page))), 'the waiting changes went');
    assert.ok(await waitFor(async () => { const c = await cacheNames(page); return c.includes('split-it-shell-v4') && !c.some(k => /-v3$/.test(k)); }), 'the old caches are gone: ' + (await cacheNames(page)));
    assert.match(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).active.scriptURL), /\/sw\.js$/);
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
    assert.strictEqual(writes.length, 3, 'each one sent once: ' + writes.join('\n'));
    assert.ok(writes.every(w => w.startsWith('200 ')), writes.join('\n'));
    const docs = Object.fromEntries((await h.docs(ana)).map(d => [d.id, d.data]));
    assert.strictEqual(docs.e_old.title, 'Queued and edited');
    assert.ok(docs.e_seed.deletedAt, 'the delete went to the bin');
    assert.deepStrictEqual(await page.evaluate(() => window.HouseSplitOffline.notSaved()), []);
    // the saved copy is Ana's alone
    const data = await waitFor(async () => { const c = (await cacheNames(page)).filter(k => k.startsWith('split-it-data-v4-')); return c.length ? c : null; });
    assert.deepStrictEqual(data, ['split-it-data-v4-' + ana.uid]);
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('Ben private'));
    // and it opens away from wifi straight after the update, not only from the next visit on
    await waitFor(() => page.evaluate(async () => !!(await caches.match('/api/col?path=expenses'))));
    await ctx.setOffline(true);
    await page.reload(); await signedIn(page);
    assert.match(await page.evaluate(() => document.body.innerText), /Hi Ana/);
    await page.click('#tabs [data-tab="activity"]'); await page.waitForTimeout(500);
    assert.match(await page.evaluate(() => document.body.innerText), /Queued and edited/);
    await ctx.setOffline(false);
    assert.deepStrictEqual(errors, []);
  } finally { if (browser) await browser.close(); await h.done(); if (OLD) fs.rmSync(OLD, { recursive: true, force: true }); }
});

test('offline on a phone: add, edit and delete wait, each goes once when back, and a refused one offers Redo', { skip: why, timeout: 120000 }, async () => {
  const h = await house('split-it-pwa-off-');
  let browser;
  try {
    h.addUsers(); await h.start();
    const ana = await h.signIn('Ana'), ben = await h.signIn('Ben'), A = ana.uid, B = ben.uid;
    await profile(h, ana, 'Ana'); await profile(h, ben, 'Ben'); await houseGroup(h, ana, ben);
    await h.put(ana, '/api/batch', set('expenses/e1', expense(A, 'Milk', 1000, [A, B], { groupId: 'g1' })), set('expenses/e2', expense(A, 'Soap', 600, [A, B], { groupId: 'g1' })));
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addCookies([cookieFor(h, ana)]);
    const page = await ctx.newPage(), errors = watch(page);
    const writes = [];
    page.on('response', r => { if (r.request().method() === 'POST' && /\/api\/(write|batch)$/.test(r.url())) writes.push(r.status() + ' ' + r.request().postData()); });
    await page.goto(h.B + '/'); await signedIn(page);
    await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await signedIn(page);
    await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller));

    await ctx.setOffline(true);
    await page.click('[data-group="g1"]'); await page.waitForSelector('[data-exp="e1"]');
    await page.click('#addBtn'); await page.waitForSelector('#amt');
    await page.fill('#amt', '12.34'); await page.fill('#ttl', 'Offline pizza'); await page.click('#save');
    await page.waitForSelector('#netpill'); assert.match(await page.textContent('#netpill'), /Waiting to sync \(\d\)/);
    await page.click('[data-exp="e1"]'); await page.click('.sheet #edit'); await page.waitForSelector('#ttl');
    await page.fill('#ttl', 'Milk and eggs'); await page.click('#save'); await page.waitForTimeout(400);
    await page.click('[data-exp="e2"]'); await page.waitForSelector('.sheet #del'); await page.click('.sheet #del'); await page.click('.sheet #del'); await page.waitForTimeout(400);
    // one the laptop will refuse: the shares no longer add up
    await page.evaluate(async () => { const db = await window.claude.use('db'); await db.doc('expenses/e1').update({ amount: 999999 }); });
    const queued = await pending(page);
    assert.ok(queued >= 4, 'waiting: ' + queued);
    // the phone still opens with all of it while away
    await page.reload(); await signedIn(page);
    const t = await page.evaluate(() => document.body.innerText);
    assert.ok(t.includes('Offline pizza') && t.includes('Milk and eggs') && !t.includes('Soap'), t.slice(0, 300));
    assert.strictEqual(await pending(page), queued);

    await ctx.setOffline(false);
    assert.ok(await waitFor(async () => !(await pending(page))), 'all sent');
    const ok = writes.filter(w => w.startsWith('200 ')), refused = writes.filter(w => w.startsWith('422 '));
    assert.strictEqual(ok.length + refused.length, queued, writes.join('\n'));
    assert.strictEqual(refused.length, 1, writes.join('\n'));
    assert.strictEqual(ok.filter(w => w.includes('Offline pizza')).length, 1, 'added once');
    const docs = await h.docs(ana);
    assert.strictEqual(docs.filter(d => d.data.title === 'Offline pizza').length, 1);
    const by = Object.fromEntries(docs.map(d => [d.id, d.data]));
    assert.strictEqual(by.e1.title, 'Milk and eggs'); assert.strictEqual(by.e1.amount, 1000);
    assert.ok(by.e2.deletedAt);
    // the pill now only says what wasn't saved, and Redo opens the form again
    await page.waitForSelector('#netpill [data-notsaved]');
    assert.match(await page.textContent('#netpill'), /^1 not saved$/);
    await page.click('#netpill [data-notsaved]'); await page.waitForSelector('.sheet [data-redo]');
    assert.match(await page.textContent('.sheet'), /shares don’t add up/);
    await page.click('.sheet [data-redo]'); await page.waitForSelector('.sheet #save');
    assert.match(await page.textContent('.sheet'), /Edit expense/);
    assert.strictEqual(await page.$('#netpill'), null, 'nothing left in the pill');
    assert.deepStrictEqual(errors, []);
  } finally { if (browser) await browser.close(); await h.done(); }
});

test('two people on one phone: nothing of one is sent, shown or notified as the other', { skip: why, timeout: 120000 }, async () => {
  const h = await house('split-it-pwa-two-');
  let browser;
  try {
    h.addUsers(); await h.start();
    const ana = await h.signIn('Ana'), ben = await h.signIn('Ben'), A = ana.uid, B = ben.uid;
    await profile(h, ana, 'Ana'); await profile(h, ben, 'Ben'); await houseGroup(h, ana, ben);
    await h.put(ana, '/api/write', set(`data/users/${A}/root/friends/f_x`, { kind: 'contact', name: 'Zed', addedAt: Date.now() }));
    await h.put(ana, '/api/write', set(`data/users/${A}/root/entries/e_priv`, { ...expense(A, 'Ana private', 1000, [A, 'f_x']), friendId: 'f_x', splitMode: 'exact' }));
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    // this browser can't really subscribe to a push service: stand in for the phone's subscription
    await ctx.addInitScript(() => {
      const sub = { endpoint: 'https://push.example/phone-1', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'x', auth: 'y' } }; }, unsubscribe: async () => { localStorage.setItem('test-push-gone', '1'); return true; } };
      if (window.PushManager) PushManager.prototype.getSubscription = async () => localStorage.getItem('test-push-gone') ? null : sub;
    });
    const page = await ctx.newPage(), errors = watch(page);
    const signInUI = async name => { await page.goto(h.B + '/login'); await page.fill('#n', name); await page.fill('#pw', 'some-password'); await page.keyboard.press('Enter'); await signedIn(page); };
    await signInUI('Ana');
    await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await signedIn(page);
    // Ana's notifications are on for this phone
    const anaNow = { cookie: (await ctx.cookies()).filter(c => c.name === 'hs').map(c => 'hs=' + c.value)[0], uid: A };
    assert.strictEqual((await h.api(anaNow.cookie, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example/phone-1', keys: { p256dh: 'x', auth: 'y' } })).status, 200);
    await page.evaluate(uid => localStorage.setItem('hs-push-by', uid), A);   // as "Turn on" leaves it
    const pushWho = async () => (await h.api(ben.cookie, 'GET', '/api/push/who')).data.uids;
    assert.deepStrictEqual(await pushWho(), [A]);

    // Sign out while offline: refused, and nothing is forgotten or half done
    await ctx.setOffline(true);
    await page.click('#profBtn'); await page.click('#signOut');
    await page.waitForSelector('.toast'); assert.match(await page.textContent('.toast'), /offline/i);
    assert.ok(page.url().startsWith(h.B + '/'), page.url());
    assert.deepStrictEqual(await pushWho(), [A], 'still on: nothing changed');
    await ctx.setOffline(false);
    // Signing out for real ends this phone's notifications and its saved copy
    await page.reload(); await signedIn(page);
    await page.click('#profBtn'); await page.click('#signOut'); await page.waitForURL(/\/login/);
    assert.deepStrictEqual(await pushWho(), [], 'Ana no longer gets notifications on this phone');
    assert.deepStrictEqual((await cacheNames(page)).filter(k => k.startsWith('split-it-data')), []);

    // Ana again, leaves a change waiting and walks away without signing out; Ben signs in on the same phone
    await page.evaluate(() => localStorage.removeItem('test-push-gone'));
    await signInUI('Ana');
    await page.evaluate(uid => localStorage.setItem('hs-push-by', uid), A);
    await page.route(/\/api\/(write|batch)$/, r => r.abort('internetdisconnected'));
    await page.click('[data-group="g1"]'); await page.click('#addBtn'); await page.waitForSelector('#amt');
    await page.fill('#amt', '7'); await page.fill('#ttl', 'Ana left this'); await page.click('#save');
    assert.ok(await waitFor(async () => (await pending(page)) === 1));
    await signInUI('Ben');
    await page.unroute(/\/api\/(write|batch)$/);
    await page.waitForTimeout(1500);
    assert.strictEqual(await pending(page), 0, 'Ana’s change is not Ben’s to send');
    assert.ok(!(await h.docs(ben)).some(d => d.data.title === 'Ana left this'), 'and it was never sent as Ben');
    assert.ok(await waitFor(() => page.evaluate(() => localStorage.getItem('test-push-gone') === '1')), 'Ana’s notifications on this phone were ended');
    const data = await waitFor(async () => { const c = (await cacheNames(page)).filter(k => k.startsWith('split-it-data')); return c.length ? c : null; });
    assert.deepStrictEqual(data, ['split-it-data-v4-' + B], 'only Ben’s copy');
    // Ben offline sees his own things only
    await ctx.setOffline(true);
    await page.reload(); await signedIn(page);
    const t = await page.evaluate(() => document.body.innerText);
    assert.match(t, /Hi Ben/);
    assert.ok(!t.includes('Ana private') && !t.includes('Zed'), t.slice(0, 300));
    await ctx.setOffline(false);
    assert.deepStrictEqual(errors, []);
  } finally { if (browser) await browser.close(); await h.done(); }
});

// The page published as a Claude artifact: the same index.html without the shim and the three link tags,
// with the artifact's shared store instead. A small in-memory stand-in plays that store here.
const ARTIFACT = `(() => {
  const ME = 'viewer_ana', store = window.__store = new Map(), subs = new Set();
  const parentOf = p => p.split('/').slice(0, -1).join('/'), clone = v => v == null ? v : structuredClone(v);
  const snap = (id, d) => ({ id, exists: d != null, data: () => clone(d) ?? undefined });
  const changed = p => { for (const s of subs) if (s.path === parentOf(p) || s.path === p) setTimeout(s.fire, 0); };
  const doc = path => ({ id: path.split('/').pop(), path, collection: c => col(path + '/' + c),
    get: async () => snap(path.split('/').pop(), store.get(path)),
    set: async d => { store.set(path, clone(d)); changed(path); },
    update: async d => { if (!store.has(path)) throw Object.assign(new Error('not found'), { code: 'not_found' }); store.set(path, { ...store.get(path), ...clone(d) }); changed(path); },
    delete: async () => { store.delete(path); changed(path); },
    onSnapshot(cb) { const s = { path, fire: () => cb(snap(path.split('/').pop(), store.get(path))) }; subs.add(s); setTimeout(s.fire, 0); return () => subs.delete(s); } });
  const col = (path, o = {}) => {
    const rows = () => { let r = [...store].filter(([k]) => parentOf(k) === path).map(([k, v]) => ({ id: k.split('/').pop(), data: v }));
      for (const [f, op, v] of o.where || []) r = r.filter(x => op === '==' ? x.data[f] === v : op === 'array-contains' ? (x.data[f] || []).includes(v) : true);
      if (o.limit) r = r.slice(0, o.limit);
      const docs = r.map(x => snap(x.id, x.data)); return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) }; };
    return { path, id: path.split('/').pop(), doc: id => doc(path + '/' + id),
      where: (f, op, v) => col(path, { ...o, where: [...(o.where || []), [f, op, v]] }), orderBy: () => col(path, o), limit: n => col(path, { ...o, limit: n }),
      get: async () => rows(), onSnapshot(cb) { const s = { path, fire: () => cb(rows()) }; subs.add(s); setTimeout(s.fire, 0); return () => subs.delete(s); } };
  };
  const user = { id: async () => ME, isOwner: async () => true, can: async () => true, profiles: async ids => Object.fromEntries(ids.map(id => [id, { name: 'Ana Viewer' }])) };
  window.claude = { use: async n => ({ db: { doc, collection: p => col(p) }, user, downloads: { save: async () => true }, sample: null })[n] ?? null };
})();`;

test('published as a Claude artifact (no shim.js): it starts, and the laptop-only parts stay out of the way', { skip: why, timeout: 90000 }, async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').split('\n');
  const html = src.filter(l => !/<link rel="manifest"|<link rel="icon"|<link rel="apple-touch-icon"|<script src="\/shim\.js"><\/script>/.test(l)).join('\n');
  assert.strictEqual(src.length - html.split('\n').length, 4, 'the preview build removes exactly these 4 lines');
  const srv = http.createServer((req, res) => { if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); } else { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + srv.address().port;
  let browser;
  try {
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.addInitScript(ARTIFACT);
    // The receipt reader comes from jsdelivr here (checked by hash): play the CDN with the copy the laptop serves
    const VENDOR = path.join(ROOT, 'public', 'vendor', 'tesseract'), cdn = [];
    await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\//, r => { const name = r.request().url().split('/').pop(), f = path.join(VENDOR, name); cdn.push(name);
      return fs.existsSync(f) ? r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': name.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' }, body: fs.readFileSync(f) })
        : r.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }); });
    // no other outside hosts here: the rate service just doesn't answer
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|cdn\.jsdelivr\.net)/, r => r.abort());
    const page = await ctx.newPage(), errors = watch(page), local = [];
    page.on('request', r => { const u = new URL(r.url()); if (u.origin === B && u.pathname !== '/' && !u.pathname.startsWith('/art/')) local.push(u.pathname); });
    page.setDefaultTimeout(8000);
    const sheet = () => page.evaluate(() => document.querySelector('.sheet')?.innerText || '');
    const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(250); };
    await page.goto(B + '/');
    await page.click('text=Get started'); await signedIn(page);
    await page.click('#tabs [data-tab="groups"]'); await page.click('text=New group');
    await page.fill('#gn', 'Trip'); await page.fill('#gg', 'Mo'); await page.click('#ggAdd'); await page.click('#sv');   // several writes, one after another (no batch here)
    await page.waitForSelector('#gAdd');
    const store = () => page.evaluate(() => [...window.__store.keys()]);
    assert.strictEqual((await store()).filter(k => /^groups\/[^/]+\/members\//.test(k)).length, 2);
    await page.click('#gAdd'); await page.waitForSelector('#amt'); await page.fill('#amt', '20'); await page.fill('#ttl', 'Pizza'); await page.click('#save');
    await page.waitForSelector('[data-exp]');
    // a foreign currency: the rate service is asked directly and, when it doesn't answer, the page says so
    await page.click('#gAdd'); await page.waitForSelector('#amt'); await page.selectOption('#cur', 'EUR');
    await page.waitForFunction(() => /Couldn’t get a rate/.test(document.querySelector('#rateNote')?.innerText || ''), null, { timeout: 8000 });
    await close();
    await page.click('[data-exp]'); await page.waitForSelector('.sheet #edit');
    await page.click('.sheet #edit'); await page.fill('#ttl', 'Pizza night'); await page.click('#save'); await page.waitForTimeout(400);
    await page.click('[data-exp]'); await page.click('.sheet #del'); await page.click('.sheet #del'); await page.waitForTimeout(400);
    await page.click('#gAct'); await page.waitForTimeout(300);
    assert.match(await sheet(), /removed Pizza night/);
    assert.doesNotMatch(await sheet(), /laptop/i, 'no promises about a laptop that isn’t there');
    await close();
    await page.click('#gStats'); await page.waitForTimeout(300); await close();
    await page.click('#gSettings'); await page.waitForTimeout(300); await close();
    await page.click('#tabs [data-tab="friends"]'); await page.click('text=Add friend'); await page.waitForTimeout(500); await close();
    await page.click('#tabs [data-tab="activity"]'); await page.waitForTimeout(300);
    await page.click('#tabs [data-tab="home"]'); await page.click('#profBtn'); await page.waitForTimeout(300);
    const prof = await sheet();
    assert.match(prof, /Signed in with your Claude account/);
    assert.doesNotMatch(prof, /Sign out|Phone notifications|AI assistants|People, backups and health|Download my data/);
    await close();
    // read a receipt on the phone
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 320; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 320); x.fillStyle = '#000'; x.font = '32px monospace';
      ['FRESH MARKET', 'Bananas        3.50', 'Bread          4.25', 'TOTAL          7.75'].forEach((l, i) => x.fillText(l, 30, 60 + i * 60)); return c.toDataURL('image/png').split(',')[1]; });
    await page.setInputFiles('#receipt', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(() => /Who’s this receipt with/.test(document.querySelector('.sheet')?.innerText || ''), null, { timeout: 60000 });
    assert.ok(cdn.includes('tesseract.min.js') && cdn.includes('eng.traineddata.gz'), cdn.join(' '));
    await close();
    assert.strictEqual(await page.$('#netpill'), null);
    assert.deepStrictEqual(local, [], 'nothing asked of a laptop server that isn’t there');
    assert.deepStrictEqual(errors, []);
  } finally { if (browser) await browser.close(); srv.close(); }
});
