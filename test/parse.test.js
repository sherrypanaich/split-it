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
