// The free quick-add parser, exactly as the page runs it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = name => { const m = html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm')); if (!m) throw new Error('no ' + name); return m[0]; };
const line = re => { const m = html.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
const src = [
  `const HOME = 'CAD';`, line(/^const plainCents = .*$/m), line(/^const amtBad = .*$/m),
  line(/^const CAT_WORDS = [\s\S]*?\]\];$/m), line(/^const guessCat = .*$/m), line(/^const pad = .*$/m), line(/^const dateStr = .*$/m), line(/^const today = .*$/m),
  // a tiny house: Sam (me), Aman and Priya in one group
  `const myUid = 'u_me'; const people = { u_me: 'Sam', u_aman: 'Aman', u_priya: 'Priya' };
   const nameOf = id => people[id] || id; const myGroups = () => [{ id: 'g1', name: 'House' }];
   const activeIn = () => Object.keys(people).map(id => ({ id })); const friendIds = () => ['u_aman', 'u_priya']; const isGuestOnly = () => false;`,
  grab('localParse')
].join('\n');
const localParse = new Function(src + '\nreturn localParse;')();
const d = () => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

test('amount and title', () => { const r = localParse('groceries 54.20'); assert.equal(r.amount, 54.2); assert.match(r.title, /groceries/i); assert.equal(r.category, 'groceries'); });
test('dollar sign and commas', () => { assert.equal(localParse('rent $2,400').amount, 2400); });
test('a named friend picks the one-on-one context', () => { const r = localParse('pizza with Aman 30'); assert.equal(r.amount, 30); assert.ok(r.where === 'f:u_aman' || (r.participants || []).includes('u_aman')); });
test('yesterday', () => { const r = localParse('coffee 4.50 yesterday'); const y = new Date(); y.setDate(y.getDate() - 1); assert.equal(r.date, `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`); });
test('today by default', () => { assert.equal(localParse('bagels 12').date, d()); });
test('no amount means no amount', () => { assert.ok(!localParse('dinner with everyone').amount); });
test('monthly makes a repeating bill', () => { assert.equal(localParse('netflix 16.99 monthly').repeatMonthly, true); });

test('amounts: a decimal comma is cents, a thousands comma is not', () => {
  const { toCents } = amounts;
  assert.equal(toCents('12,50'), 1250);
  assert.equal(toCents('12,5'), 1250);
  assert.equal(toCents('1,250.00'), 125000);
  assert.equal(toCents('1,250'), 125000);
  assert.equal(toCents('$54.20'), 5420);
  assert.equal(toCents(''), 0);
});

const amounts = new Function([/^const plainCents = .*$/m, /^const toCents = .*$/m, /^const amtBad = .*$/m].map(line).join('\n') + '\nreturn { toCents, amtBad };')();
test('amounts: plain ones are read exactly', () => {
  const { toCents, amtBad } = amounts;
  for (const [typed, cents] of [['1,234.56', 123456], ['$12', 1200], ['12.5', 1250], ['12.', 1200], ['.5', 50], ['0.29', 29], ['  54.20 ', 5420], ['€9,99', 999], ['1,000,000', 100000000]]) {
    assert.equal(toCents(typed), cents, typed);
  }
  assert.equal(amtBad(''), false, 'an empty box is just empty');
  assert.equal(amtBad('12.5'), false);
});
test('amounts: anything that is not a plain amount is refused, not guessed', () => {
  const { toCents, amtBad } = amounts;
  for (const typed of ['1.234,56', '10-15', '12.345', '1 234', '1e5', '-5', '12.3.4', 'abc', '12,345.6.7', '1,23,456', '.', '1.005', '99999999999']) {
    assert.equal(toCents(typed), 0, typed + ' gives no amount');
    assert.equal(amtBad(typed), true, typed + ' is flagged');
  }
});
test('quick add: an unclear amount is left empty and flagged, a plain one still works', () => {
  for (const note of ['dinner 1.234,56', 'pizza 10-15', 'paint 12.345']) {
    const r = localParse(note);
    assert.ok(!r.amount, note + ' should not guess an amount, got ' + r.amount);
    assert.ok(r.unclear, note + ' is flagged as unclear');
  }
  assert.equal(localParse('dinner 1.234,56').unclear, '1.234,56');
  assert.equal(localParse('groceries 54.20.').amount, 54.2, 'a full stop after the amount is fine');
  assert.equal(localParse('rent $2,400 monthly').amount, 2400);
  assert.ok(!localParse('groceries 54.20').unclear);
});

// CSV export: what a spreadsheet would run as a formula is shown as text instead
const csvCell = new Function(grab('csvCell') + '\nreturn csvCell;')();
test('CSV cells that start like a formula get a leading quote mark', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
  for (const t of ['+1+2', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '=1']) assert.ok(csvCell(t).startsWith(`"'`), JSON.stringify(t));
  assert.equal(csvCell('Groceries'), '"Groceries"');
  assert.equal(csvCell('-12.50'), '"-12.50"', 'money in stays a number');
  assert.equal(csvCell('12.00'), '"12.00"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});
