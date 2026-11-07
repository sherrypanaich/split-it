// Run with: node --test test/*.test.js
// Checks the split engine and balance rules on the server, and that the page uses the very same rules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'split-it-test-'));
const S = require('../server.js');

// The same functions as the page sees them, pulled out of index.html so they can't drift apart.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = name => { const m = html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm')); if (!m) throw new Error('no ' + name + ' in page'); return m[0]; };
const line = re => { const m = html.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
const pageSrc = [line(/^const hash = .*$/m), line(/^const sumOf = .*$/m), line(/^const alive = .*$/m), line(/^const counts = .*$/m), ...['splitEqual', 'splitShares', 'itemsSplit', 'computeSplit', 'netOf', 'pairwiseOf', 'simplified'].map(grab)].join('\n');
const P = new Function(pageSrc + '\nreturn { splitEqual, splitShares, itemsSplit, computeSplit, netOf, pairwiseOf, simplified };')();

const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

test('equal split: every cent assigned, never more than a cent apart', () => {
  for (const amount of [1, 2, 99, 100, 1000, 12345, 99999]) for (const n of [1, 2, 3, 4, 7]) {
    const ids = Array.from({ length: n }, (_, i) => 'u' + i), out = S.splitEqual(amount, ids, 'seed');
    assert.equal(sum(out), amount, `${amount} / ${n}`);
    const vals = Object.values(out); assert.ok(Math.max(...vals) - Math.min(...vals) <= 1);
  }
});
test('equal split: the odd cent moves around with the seed, so the same person does not always pay it', () => {
  const ids = ['a', 'b', 'c'], who = new Set();
  for (let i = 0; i < 30; i++) { const out = S.splitEqual(100, ids, 'e' + i); who.add(Object.keys(out).find(k => out[k] === 34)); }
  assert.ok(who.size > 1);
});
test('equal split: duplicates and empty input', () => {
  assert.deepEqual(S.splitEqual(300, ['a', 'a', 'b'], 'x'), { a: 150, b: 150 });
  assert.deepEqual(S.splitEqual(300, [], 'x'), {});
  assert.deepEqual(S.splitEqual(0, ['a'], 'x'), {});
});
test('shares split: proportional, adds up, ignores zero shares', () => {
  const out = S.splitShares(10000, { a: 2, b: 1, c: 1, d: 0 }, 's');
  assert.deepEqual(out, { a: 5000, b: 2500, c: 2500 });
  for (const amount of [1, 7, 101, 99999]) assert.equal(sum(S.splitShares(amount, { a: 3, b: 2, c: 2 }, 'q')), amount);
});
test('percent split goes through shares', () => {
  assert.deepEqual(S.computeSplit(5000, 'pct', { pct: { a: 70, b: 30 } }, 'p'), { a: 3500, b: 1500 });
});
test('exact split keeps what was typed, drops zeros', () => {
  assert.deepEqual(S.computeSplit(5000, 'exact', { exact: { a: 1234, b: 3766, c: 0 } }, 'x'), { a: 1234, b: 3766 });
});
test('items split: tax and tip shared in proportion to what each person ordered', () => {
  const input = { items: [{ p: 2000, ids: ['a'] }, { p: 1000, ids: ['b'] }, { p: 1000, ids: ['a', 'b'] }], tax: 400, tip: 600 };
  const out = S.itemsSplit(5000, input, 'i');
  assert.equal(sum(out), 5000);
  assert.equal(out.a, 2500 + 625); assert.equal(out.b, 1500 + 375);
});
test('items split: a total above the items spreads the rest; items with nobody are ignored', () => {
  const out = S.itemsSplit(1000, { items: [{ p: 500, ids: ['a'] }, { p: 300, ids: [] }] }, 'z');
  assert.deepEqual(out, { a: 1000 });
});
test('page and server split the same way', () => {
  const cases = [
    [12345, 'equal', { ids: ['a', 'b', 'c'] }],
    [99999, 'shares', { shares: { a: 3, b: 2, c: 2 } }],
    [5000, 'pct', { pct: { a: 33.33, b: 33.33, c: 33.34 } }],
    [777, 'items', { items: [{ p: 300, ids: ['a', 'b'] }, { p: 200, ids: ['c'] }], tax: 100, tip: 177 }],
    [500, 'exact', { exact: { a: 200, b: 300 } }]
  ];
  for (const [amount, mode, input] of cases) for (const seed of ['r_1_2026-03', 'e9x', 'preview'])
    assert.deepEqual(P.computeSplit(amount, mode, input, seed), S.computeSplit(amount, mode, input, seed), `${mode} ${seed}`);
});
test('net balances: payer up, sharers down, unconfirmed payments ignored', () => {
  const list = [
    { kind: 'expense', paidBy: 'a', amount: 3000, split: { a: 1000, b: 1000, c: 1000 } },
    { kind: 'payment', from: 'b', to: 'a', amount: 1000 },
    { kind: 'payment', from: 'c', to: 'a', amount: 1000, confirmed: false }
  ];
  assert.deepEqual(S.netOf(list), { a: 1000, b: 0, c: -1000 });
  assert.deepEqual(P.netOf(list), S.netOf(list));
});
test('simplified settle-up clears every balance with the fewest transfers', () => {
  const net = { a: 5000, b: -2000, c: -3000, d: 0 };
  const plan = S.simplified(net);
  assert.equal(plan.length, 2);
  const after = { ...net }; for (const p of plan) { after[p.from] += p.amount; after[p.to] -= p.amount; }
  assert.ok(Object.values(after).every(v => v === 0));
  assert.deepEqual(P.simplified(net), plan);
});
test('pairwise settle-up: each person pays back exactly who covered them', () => {
  const list = [
    { kind: 'expense', paidBy: 'a', amount: 2000, split: { a: 1000, b: 1000 } },
    { kind: 'expense', paidBy: 'b', amount: 600, split: { b: 300, c: 300 } }
  ];
  const plan = S.pairwiseOf(list);
  assert.deepEqual(plan.sort((x, y) => x.from.localeCompare(y.from)), [{ from: 'b', to: 'a', amount: 1000 }, { from: 'c', to: 'b', amount: 300 }]);
  assert.deepEqual(P.pairwiseOf(list).sort((x, y) => x.from.localeCompare(y.from)), plan);
});
test('bills: monthly keys and dates, short months clamp the day', () => {
  const r = { day: 31, startMonth: '2026-01' };
  assert.equal(S.billFirstKey(r), '2026-01');
  assert.equal(S.billNextKey(r, '2026-01'), '2026-02');
  assert.equal(S.billDate(r, '2026-02'), '2026-02-28');
  assert.equal(S.billDate(r, '2026-12'), '2026-12-31');
  assert.equal(S.billNextKey(r, '2026-12'), '2027-01');
});
test('bills: weekly and yearly', () => {
  const w = { every: 'week', startDate: '2026-03-09' };
  assert.equal(S.billFirstKey(w), '2026-03-09'); assert.equal(S.billNextKey(w, '2026-03-09'), '2026-03-16'); assert.equal(S.billDate(w, '2026-03-16'), '2026-03-16');
  assert.equal(S.billDueOn(w, new Date('2026-03-23T12:00:00')), true); assert.equal(S.billDueOn(w, new Date('2026-03-24T12:00:00')), false);
  const y = { every: 'year', startMonth: '2026-02', month: 2, day: 29 };
  assert.equal(S.billFirstKey(y), '2026'); assert.equal(S.billDate(y, '2026'), '2026-02-28'); assert.equal(S.billDate(y, '2028'), '2028-02-29');
});
test('zip: what goes in comes out, with a correct crc', () => {
  const entries = [{ name: 'db.json', data: Buffer.from('{"docs":{}}') }, { name: 'photos/a.jpg', data: Buffer.from([0xff, 0xd8, 1, 2, 3]) }];
  const zip = S.zipWrite(entries), back = S.zipRead(zip);
  assert.deepEqual(Object.keys(back).sort(), ['db.json', 'photos/a.jpg']);
  assert.equal(back['db.json'].toString(), '{"docs":{}}');
  assert.equal(S.crc32(Buffer.from('123456789')), 0xCBF43926);
});
