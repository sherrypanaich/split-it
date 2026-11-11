// The phone's data layer (public/shim.js), run in a pretend browser: the offline queue, what happens
// when the laptop refuses a change or keeps failing, batches, and forgetting everything on sign-out.
// Run with: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'shim.js'), 'utf8');

// A browser with just enough in it: localStorage, events, fetch answered by `server`, and timers that wait to be run.
function phone(server, store = new Map()) {
  const listeners = {}, events = [], timers = [], sent = [];
  const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const window = {
    addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    dispatchEvent: ev => { events.push(ev); for (const f of listeners[ev.type] || []) f(ev); },
  };
  class CustomEvent { constructor(type, o = {}) { this.type = type; this.detail = o.detail; } }
  class Event { constructor(type) { this.type = type; } }
  class EventSource { constructor() { this.listeners = {}; } addEventListener() {} close() {} }
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (body) sent.push({ url, body });
    const r = await server(url, body);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    const status = r.status || 200, text = JSON.stringify(r.body ?? {});
    return { status, ok: status < 300, statusText: '', headers: { get: k => (r.headers || {})[k] || null }, json: async () => JSON.parse(text), text: async () => text };
  };
  const ctx = { window, localStorage, fetch, CustomEvent, Event, EventSource, console: { warn() {}, error() {}, log() {} },
    setTimeout: (f, ms) => { timers.push(f); return timers.length; }, clearTimeout() {}, AbortController, structuredClone, location: { href: '/' },
    navigator: {}, encodeURIComponent, URL, Blob: class {}, document: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const off = window.HouseSplitOffline;
  return { ctx, window, off, events, timers, sent, store, db: () => ctx.window.claude.use('db'), user: () => ctx.window.claude.use('user'),
    dropped: () => events.filter(e => e.type === 'hs-dropped').map(e => e.detail) };
}
// A laptop that can be switched off, and answers writes with whatever `answer` says.
function laptop(uid = 'u_ana') {
  const s = { up: true, answer: () => ({ body: { ok: true } }), writes: [] };
  s.handle = async (url, body) => {
    if (!s.up) return 'offline';
    if (url === '/api/me') return { body: { uid, isOwner: false } };
    if (url.startsWith('/api/col')) return { body: { docs: [] } };
    if (url.startsWith('/api/doc')) return { body: { data: null } };
    if (body) { const r = s.answer(url, body); if (!r || r.status === undefined || r.status < 300) s.writes.push({ url, body }); return r; }
    return { body: {} };
  };
  return s;
}
const settle = () => new Promise(r => setImmediate(r));   // let a send already under way finish
const plain = x => JSON.parse(JSON.stringify(x));   // values from the pretend browser, as plain ones
const expense = (title, amount) => ({ kind: 'expense', title, amount, paidBy: 'u_ana', split: { u_ana: amount }, splitMode: 'equal', groupId: 'g1', date: '2026-11-10' });

test('a change made offline waits, and is sent when the laptop is back', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  srv.up = false;
  const db = await p.db();
  const r = await db.doc('expenses/e1').set(expense('Pizza', 2400));
  assert.strictEqual(r.queued, true);
  assert.strictEqual(p.off.pending(), 1);
  srv.up = true;
  await p.off.flush();
  assert.strictEqual(p.off.pending(), 0);
  assert.deepStrictEqual(srv.writes.map(w => w.body.ops[0].path), ['expenses/e1']);
  assert.ok(p.off.lastSynced() > 0, 'remembers when it last caught up');
});

test('a change the laptop refuses is set aside with the reason, and the rest still go', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  const db = await p.db();
  srv.up = false;
  await db.doc('expenses/bad').set(expense('Pizza', 2400));
  await db.doc('expenses/good').set(expense('Milk', 500));
  await db.doc('expenses/stale').update({ title: 'Old edit', v: 1 });
  await settle(); srv.up = true;
  srv.answer = (url, body) => body.ops[0].path === 'expenses/bad' ? { status: 422, body: { error: 'The shares don’t add up to the total.' } }
    : body.ops[0].path === 'expenses/stale' ? { status: 409, body: { error: 'This changed since you opened it. Have a look again.', code: 'stale' } } : { body: { ok: true } };
  await p.off.flush();
  assert.strictEqual(p.off.pending(), 0, 'nothing is stuck behind the refused change');
  assert.deepStrictEqual(srv.writes.map(w => w.body.ops[0].path), ['expenses/good']);
  const d = p.dropped();
  assert.deepStrictEqual(d.map(x => [x.ops[0].path, x.reason, x.code]), [['expenses/bad', 'refused', 'failed_precondition'], ['expenses/stale', 'refused', 'stale']]);
  assert.match(d[0].message, /don’t add up/);
  assert.strictEqual(d[0].ops[0].data.title, 'Pizza', 'the page gets the whole change, to name it and redo it');
  assert.strictEqual(p.off.notSaved().length, 2, 'kept in the "not saved" list');
  p.off.dismiss(d[0].id);
  assert.deepStrictEqual(plain(p.off.notSaved().map(x => x.ops[0].path)), ['expenses/stale']);
});

test('a refusal is not tried again; a laptop error is, a few times, then set aside so the rest can go', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  const db = await p.db();
  srv.up = false;
  await db.doc('expenses/stuck').set(expense('Rent', 100000));
  await db.doc('expenses/next').set(expense('Milk', 500));
  await settle(); srv.up = true;
  let tries = 0;
  srv.answer = (url, body) => body.ops[0].path === 'expenses/stuck' ? (tries++, { status: 500, body: { error: 'boom' } }) : { body: { ok: true } };
  for (let i = 0; i < 4; i++) { await p.off.flush(); assert.strictEqual(p.off.pending(), 2, 'still waiting after try ' + (i + 1)); }
  assert.ok(p.timers.length >= 1, 'a retry is scheduled, with a wait in between');
  await p.off.flush();
  assert.strictEqual(tries, 5);
  assert.strictEqual(p.off.pending(), 0);
  assert.deepStrictEqual(srv.writes.map(w => w.body.ops[0].path), ['expenses/next']);
  assert.deepStrictEqual(p.dropped().map(x => [x.ops[0].path, x.reason]), [['expenses/stuck', 'stuck']]);
  // with no connection at all, nothing counts against the change: it just waits
  srv.up = false;
  await db.doc('expenses/later').set(expense('Bread', 400));
  for (let i = 0; i < 8; i++) await p.off.flush();
  assert.strictEqual(p.off.pending(), 1);
  assert.strictEqual(p.dropped().length, 1);
});

test('a batch goes to /api/batch in one call, and waits offline as one item', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  const db = await p.db();
  await db.batch().update(db.doc('expenses/p1'), { confirmed: true }).update(db.doc('expenses/p2'), { confirmed: true }).commit('Confirming 2 payments');
  assert.deepStrictEqual(srv.writes.map(w => [w.url, w.body.ops.length, w.body.label]), [['/api/batch', 2, 'Confirming 2 payments']]);
  srv.up = false;
  const r = await db.batch().set(db.doc('expenses/a'), expense('A', 100)).set(db.doc('expenses/b'), expense('B', 200)).commit('Two entries');
  assert.strictEqual(r.queued, true);
  assert.strictEqual(p.off.pending(), 1, 'one item for the whole batch');
  srv.up = true;
  srv.answer = () => ({ status: 403, body: { error: 'not allowed' } });
  await p.off.flush();
  const [d] = p.dropped();
  assert.strictEqual(d.label, 'Two entries');
  assert.strictEqual(d.ops.length, 2, 'the whole batch is set aside together');
  assert.strictEqual(d.code, 'invalid_argument');
});

test('changes another person left waiting on this phone are never sent as the next person', async () => {
  const store = new Map([['hs-queue', JSON.stringify([{ op: 'set', path: 'expenses/x', data: expense('Theirs', 100), by: 'u_ben' }])],
    ['hs-aside', JSON.stringify([{ id: 'a1', ops: [], by: 'u_ben', message: 'no' }])]]);
  const srv = laptop('u_ana'), p = phone(srv.handle, store);
  await (await p.user()).id();
  await p.off.flush();
  assert.strictEqual(srv.writes.length, 0);
  assert.strictEqual(p.off.pending(), 0);
  assert.strictEqual(p.off.notSaved().length, 0, 'their "not saved" list is not shown, or kept');
});

test('signing out forgets the waiting changes, the "not saved" list and the sync time', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  const db = await p.db();
  srv.up = false;
  await db.doc('expenses/e1').set(expense('Pizza', 2400));
  assert.ok(p.store.has('hs-queue'));
  await p.off.forget();
  for (const k of ['hs-queue', 'hs-aside', 'hs-synced']) assert.ok(!p.store.has(k), k + ' is gone');
  assert.strictEqual(p.off.pending(), 0);
});

test('a change whose sending keeps breaking off is set aside too, once the laptop is clearly answering other things', async () => {
  const srv = laptop(), p = phone(srv.handle);
  await (await p.user()).id();
  const db = await p.db();
  srv.up = false;
  await db.doc('expenses/huge').set(expense('Huge', 100));
  await settle(); srv.up = true;
  srv.answer = () => 'offline';   // the connection drops on this one every time
  for (let i = 0; i < 6; i++) { await p.off.flush(); await new Promise(r => setTimeout(r, 2)); await db.doc('people/u_ana').get(); }
  assert.strictEqual(p.off.pending(), 0);
  assert.deepStrictEqual(plain(p.dropped().map(x => x.reason)), ['stuck']);
});
