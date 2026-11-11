// accounts.js on its own (Budget it copies it word for word), with stand-ins for what the app hands it:
// friend notifications aren't sent over and over, built-in names can't be asked, and the lookup limit stays small.
// Run with: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const makeAccounts = require('../accounts');

function setup() {
  const store = { users: { u_a: { name: 'Ana', tag: 'ana' }, u_b: { name: 'Ben', tag: 'ben', friendToken: 'tok-ben-123456' } }, sessions: {} };
  const docs = {}, told = [];
  let body = {};
  const h = { users: () => store, saveUsers() {}, docs: () => docs, saveDb() {}, broadcast() {}, hashPw: () => ({}), findUser: () => undefined,
    setCookie() {}, cookies: () => ({}), clientIp: () => '1.2.3.4', misses: new Map(), tooManyTries: () => null, nameFor: id => store.users[id]?.name || 'Someone',
    readBody: async () => body, send: (res, code, data) => { res.code = code; res.data = data; }, file() {}, secure: () => false, SESSION_DAYS: 90,
    endSessions() {}, notify: (uids, msg) => { told.push({ uids, title: msg.title }); return Promise.resolve(1); } };
  const handle = makeAccounts(h);
  const call = async (uid, p, b, method = 'POST') => { body = b; const res = {}; await handle({ method, headers: {} }, res, new URL('http://x' + p), uid); return res; };
  return { store, docs, told, call };
}

test('asking, taking it back and asking again tells the other person once', async () => {
  const { told, call, store } = setup();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await call('u_a', '/api/friends/request', { to: 'u_b' })).data.asked, true);
    const id = Object.keys(store.friendReqs)[0];
    assert.strictEqual((await call('u_a', '/api/friends/answer', { id, yes: false })).code, 200);   // Ana takes it back
  }
  assert.strictEqual(told.filter(t => /wants to be friends/.test(t.title)).length, 1);
});

test('using a friend link again, when already friends, sends nothing', async () => {
  const { told, call } = setup();
  for (let i = 0; i < 3; i++) assert.strictEqual((await call('u_a', '/api/friends/link/use', { token: 'tok-ben-123456' })).code, 200);
  assert.strictEqual(told.filter(t => /added you/.test(t.title)).length, 1);
});

test('no friend request to built-in names like __proto__', async () => {
  const { call, store } = setup();
  for (const to of ['__proto__', 'constructor', 'toString']) assert.strictEqual((await call('u_a', '/api/friends/request', { to })).code, 400, to);
  assert.deepStrictEqual(Object.values(store.friendReqs || {}), []);
});

test('the lookup limit stops at 30 tries and doesn’t keep counting past it', async () => {
  const { call } = setup();
  const codes = [];
  for (let i = 0; i < 200; i++) codes.push((await call('u_a', '/api/people/find', { q: '@nobody' + i })).code);
  assert.deepStrictEqual([...new Set(codes.slice(0, 30))], [404]);
  assert.deepStrictEqual([...new Set(codes.slice(30))], [429]);
});
