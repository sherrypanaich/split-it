// Claims: someone who joins (or is already on Split it) takes over the history that a friend logged
// under their name before they had an account. Two kinds of name-only records can move:
//   - a member of a group who isn't on the app (groups/{gid}/members/g_...), seen by the whole group
//   - a private contact (data/users/{uid}/root/friends/{id} with kind 'contact') and the private
//     entries with them (data/users/{uid}/root/entries/{id}), seen only by the person who logged them
//
// It takes two yeses. The person who logged the history sends a claim, either inside a personal invite
// link or as a request to someone already on the app. The person it is for sees what is waiting and
// answers "Yes, that's me" or "Not me". Only a yes moves anything, all in one step, and only if every
// balance comes out exactly the same afterwards. Either of them can undo it for 7 days, as long as
// nobody has changed those entries since.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OPEN_DAYS = 14, UNDO_DAYS = 7;

module.exports = function claims(h) {
  const { DATA_DIR, docs, users, saveDb, saveUsers, broadcast, refresh, notify, nameFor, segs, memberOf, cad, readBody, send } = h;
  const FILE = path.join(DATA_DIR, 'claims.json');
  let store = { claims: {} };
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!store.claims) store = { claims: {} }; } catch (e) { if (e.code !== 'ENOENT') console.error('claims.json:', e.message); }
  const save = () => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, FILE); };
  const now = () => Date.now();
  const U = () => users();
  const all = () => Object.values(store.claims);
  const priv = uid => `data/users/${uid}/root/`;
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- what a claim covers ----------
  const peopleOf = e => e.people || (e.kind === 'payment' ? [e.from, e.to] : [...new Set([e.paidBy, ...Object.keys(e.split || {})])]);
  const involves = (e, id) => peopleOf(e).includes(id) || e.friendId === id || [e.paidBy, e.from, e.to, e.addedBy, e.editedBy, e.deletedBy].includes(id)
    || Object.prototype.hasOwnProperty.call(e.split || {}, id);
  const counts = e => e && !e.deletedAt && e.status !== 'needs_amount';
  const swapKeys = (o, a, b) => { if (!o || typeof o !== 'object') return o; const r = {}; for (const [k, v] of Object.entries(o)) { const k2 = k === a ? b : k; r[k2] = typeof v === 'number' && typeof r[k2] === 'number' ? r[k2] + v : v; } return r; };
  function swapEntry(e, a, b) {
    const x = clone(e), sw = v => v === a ? b : v;
    for (const k of ['paidBy', 'from', 'to', 'addedBy', 'editedBy', 'deletedBy', 'friendId']) if (x[k] === a) x[k] = b;
    if (Array.isArray(x.people)) x.people = [...new Set(x.people.map(sw))];
    if (x.split) x.split = swapKeys(x.split, a, b);
    if (Array.isArray(x.payers)) x.payers = x.payers.map(p => p && p.id === a ? { ...p, id: b } : p);
    const si = x.splitInput;
    if (si && typeof si === 'object') {
      if (Array.isArray(si.ids)) si.ids = [...new Set(si.ids.map(sw))];
      for (const k of ['shares', 'exact', 'percent', 'adjust']) if (si[k]) si[k] = swapKeys(si[k], a, b);
      if (Array.isArray(si.items)) si.items = si.items.map(it => it && Array.isArray(it.ids) ? { ...it, ids: [...new Set(it.ids.map(sw))] } : it);
    }
    return x;
  }
  // + means `a` is owed by `b`, from the pairs in these entries (same rule as the page's one-on-one totals)
  function pairOwed(list, a, b) {
    let v = 0;
    for (const e of list) {
      if (!counts(e)) continue;
      if (e.kind === 'payment') { if (e.confirmed === false) continue; if (e.from === a && e.to === b) v += e.amount; else if (e.from === b && e.to === a) v -= e.amount; continue; }
      for (const [id, c] of Object.entries(e.split || {})) { if (e.paidBy === a && id === b) v += c; else if (e.paidBy === b && id === a) v -= c; }
    }
    return v;
  }
  function netOf(list) {
    const net = {};
    for (const e of list) {
      if (!counts(e)) continue;
      if (e.kind === 'payment') { if (e.confirmed === false) continue; net[e.from] = (net[e.from] || 0) + e.amount; net[e.to] = (net[e.to] || 0) - e.amount; continue; }
      net[e.paidBy] = (net[e.paidBy] || 0) + e.amount;
      for (const [id, c] of Object.entries(e.split || {})) net[id] = (net[id] || 0) - c;
    }
    for (const k of Object.keys(net)) if (!net[k]) delete net[k];
    return net;
  }
  const docsUnder = (pre, n) => Object.entries(docs()).filter(([k, v]) => v && k.startsWith(pre) && segs(k).length === n);
  const groupName = gid => docs()['groups/' + gid]?.name || 'a group';

  // Is this a name-only person `by` may hand over? -> the record, or a reason it isn't
  function checkTargets(by, { contact, guests }) {
    const out = { contact: null, guests: [] };
    if (contact) {
      const f = docs()[priv(by) + 'friends/' + contact];
      if (!f || f.kind !== 'contact' || U().users[contact]) return { error: 'That person isn’t one of your contacts.' };
      out.contact = { id: contact, name: f.name || 'Friend' };
    }
    const seen = new Set();
    for (const g of Array.isArray(guests) ? guests.slice(0, 20) : []) {
      const gid = String(g?.gid || ''), id = String(g?.id || '');
      if (seen.has(gid)) return { error: 'Pick one person per group.' }; seen.add(gid);
      const m = docs()[`groups/${gid}/members/${id}`];
      if (!m || m.kind !== 'guest' || U().users[id]) return { error: 'That person isn’t a name-only member of the group.' };
      if (!memberOf(by, gid) || docs()[`groups/${gid}/members/${by}`]?.kind !== 'account') return { error: 'You can only hand over people in groups you’re in.' };
      out.guests.push({ gid, id, name: m.name || 'Friend' });
    }
    if (!out.contact && !out.guests.length) return { error: 'Pick who this is for.' };
    return out;
  }

  // Everything that would change if `to` takes this claim: { changes: {path: after|null}, before: {path: doc|null}, summary }
  function plan(c, to) {
    const D = docs(), changes = {}, put = (p, v) => { changes[p] = v; };
    const summary = { groups: [], oneOnOne: null };
    for (const g of c.guests) {
      const gid = g.gid, gone = g.id;
      const m = D[`groups/${gid}/members/${gone}`];
      if (!m || m.kind !== 'guest') throw new Error(`${g.name} is no longer a name-only member of ${groupName(gid)}.`);
      const entries = docsUnder('expenses/', 2).filter(([, e]) => e.groupId === gid);
      const beforeNet = netOf(entries.map(([, e]) => e));
      let n = 0;
      for (const [k, e] of entries) if (involves(e, gone)) { put(k, swapEntry(e, gone, to)); n++; }
      // the same group, with the name-only person and the account counted as one
      const want = netOf(entries.map(([, e]) => involves(e, gone) ? swapEntry(e, gone, to) : e));
      const merged = swapKeys(beforeNet, gone, to); for (const k of Object.keys(merged)) if (!merged[k]) delete merged[k];
      if (!same(Object.entries(merged).sort(), Object.entries(want).sort())) throw new Error(`Balances in ${groupName(gid)} wouldn’t add up, so nothing moved.`);
      const mine = beforeNet[gone] || 0;   // what the name-only person stood at: + is owed
      for (const [k, r] of docsUnder('recurring/', 2)) if (r.groupId === gid && (r.paidBy === gone || JSON.stringify(r.splitInput || {}).includes('"' + gone + '"') || Object.prototype.hasOwnProperty.call(r.split || {}, gone)))
        put(k, swapEntry(r, gone, to));
      for (const [k, ch] of docsUnder('chores/', 2)) if (ch.groupId === gid && JSON.stringify(ch).includes('"' + gone + '"')) {
        const x = clone(ch), sw = v => v === gone ? to : v;
        if (Array.isArray(x.order)) x.order = x.order.map(sw);
        for (const f of ['lastBy', 'addedBy']) if (x[f] === gone) x[f] = to;
        if (x.swap) for (const f of ['by', 'from', 'to']) if (x.swap[f] === gone) x.swap[f] = to;
        put(k, x);
      }
      const acct = D[`groups/${gid}/members/${to}`];
      put(`groups/${gid}/members/${gone}`, null);
      put(`groups/${gid}/members/${to}`, acct && acct.kind === 'account' ? { ...acct, active: acct.active !== false || m.active !== false }
        : { kind: 'account', active: m.active !== false, joinedAt: m.joinedAt || now(), addedBy: c.by, ...(m.leftAt ? { leftAt: m.leftAt } : {}) });
      summary.groups.push({ gid, name: groupName(gid), as: g.name, entries: n, balance: mine });
    }
    if (c.contact) {
      const fid = c.contact.id, by = c.by, all = docsUnder(priv(by) + 'entries/', 6).filter(([, e]) => involves(e, fid));
      const moved = [], carriedFrom = [];
      let photos = 0, notes = 0, n = 0, pays = 0;
      for (const [k, e] of all) {
        const others = peopleOf(e).concat(Object.keys(e.split || {}), [e.paidBy, e.from, e.to]).filter(x => x && x !== by && x !== fid);
        if (!others.length) {   // just the two of you: becomes a normal shared entry between you
          const id = segs(k)[5], key = D['expenses/' + id] || changes['expenses/' + id] ? `expenses/${id}_${c.id.slice(0, 6)}` : 'expenses/' + id;
          const x = swapEntry(e, fid, to); delete x.friendId; delete x._priv;
          x.groupId = null; x.people = [by, to]; x.claimedFrom = c.id;
          put(key, x); put(k, null); moved.push(x);
          if (e.photo) photos++; if (e.note || e.notes) notes++; if (e.kind === 'payment') pays++; else n++;
        } else {   // with other people too: stays yours in full, and counts once through the carried-over line
          const x = swapEntry(e, fid, to); x.carried = c.id; put(k, x);
          if (counts(e)) carriedFrom.push(e);
        }
      }
      const carried = pairOwed(carriedFrom, by, fid);
      if (carried) {
        const owed = carried > 0, amount = Math.abs(carried), id = 'expenses/x' + c.id.slice(0, 12);
        put(id, { kind: 'expense', title: 'Carried over from before you joined', amount, paidBy: owed ? by : to, split: { [owed ? to : by]: amount },
          splitMode: 'exact', splitInput: { exact: { [owed ? to : by]: amount } }, people: [by, to], groupId: null, date: today(), createdAt: now(), addedBy: by,
          category: 'other', claimedFrom: c.id, note: carriedFrom.slice(0, 12).map(e => `${e.title || (e.kind === 'payment' ? 'Payment' : 'Expense')} (${e.date || ''})`).join(', ').slice(0, 280) || null });
      }
      const before = pairOwed(all.map(([, e]) => e), by, fid);
      const after = pairOwed([...moved, ...(carried ? [changes['expenses/x' + c.id.slice(0, 12)]] : [])], by, to);
      if (before !== after) throw new Error('The one-on-one balance wouldn’t add up, so nothing moved.');
      // friends both ways, and the contact goes
      put(priv(by) + 'friends/' + fid, null);
      if (!D[priv(by) + 'friends/' + to]) put(priv(by) + 'friends/' + to, { kind: 'account', addedAt: now() });
      if (!D[priv(to) + 'friends/' + by]) put(priv(to) + 'friends/' + by, { kind: 'account', addedAt: now() });
      summary.oneOnOne = { name: c.contact.name, expenses: n, payments: pays, carried: carriedFrom.length, photos, notes, balance: -before };   // + = the claimer is owed
    }
    const before = {}; for (const p of Object.keys(changes)) before[p] = clone(D[p] ?? null);
    return { changes, before, summary };
  }
  // what the claimer sees before saying yes (and the inviter, before sending)
  function preview(c, to) {
    const D = docs(), stand = to || '__claimer__';
    const p = plan(c, stand), items = [];
    for (const [k, x] of Object.entries(p.changes)) {
      if (!x || segs(k)[0] !== 'expenses' || x.deletedAt || x.status === 'needs_amount') continue;
      const yours = x.kind === 'payment' ? (x.from === stand ? x.amount : x.to === stand ? -x.amount : 0) : (x.split || {})[stand] || 0;
      items.push({ title: x.title || (x.kind === 'payment' ? 'Payment' : 'Expense'), date: x.date || '', amount: x.amount, kind: x.kind, yours,
        where: x.groupId ? groupName(x.groupId) : x.carried ? 'carried over' : 'just you two', photo: !!x.photo });
    }
    items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const total = p.summary.groups.reduce((t, g) => t + g.balance, 0) + (p.summary.oneOnOne?.balance || 0);
    return { from: nameFor(c.by), groups: p.summary.groups.map(({ gid, ...g }) => g), oneOnOne: p.summary.oneOnOne, items: items.slice(0, 60), count: items.length, total };
  }

  // ---------- doing it, and undoing it ----------
  function apply(changes) {
    const D = docs(), before = {};
    for (const [p, v] of Object.entries(changes)) { before[p] = D[p] ?? null; if (v == null) delete D[p]; else D[p] = v; }
    saveDb(); broadcast(Object.keys(changes), null, before);
  }
  function accept(c, to) {
    const p = plan(c, to);
    c.changes = Object.entries(p.changes).map(([path, after]) => ({ path, before: p.before[path], after: clone(after) }));
    c.summary = p.summary; c.status = 'yes'; c.to = to; c.answeredAt = now();
    save();
    apply(p.changes);
    refresh([c.by, to]);
    return p.summary;
  }
  function undo(c) {
    const D = docs(), changed = c.changes.filter(ch => !same(D[ch.path], ch.after));
    if (changed.length) return `${changed.length} of those entries changed since, so undo would mix things up. Fix them by hand instead.`;
    const back = {}; for (const ch of c.changes) back[ch.path] = clone(ch.before);
    apply(back);
    c.status = 'undone'; c.undoneAt = now(); delete c.changes; save();
    refresh([c.by, c.to]);
    return null;
  }

  // ---------- invites carry a claim ----------
  const live = c => c && c.status === 'open' && c.exp > now();
  function forInvite(inv) {   // what the join page may show before an account exists: names and counts, never amounts
    const c = inv && inv.claim && store.claims[inv.claim];
    if (!live(c)) return null;
    try { const pv = preview(c); return { name: c.contact?.name || c.guests[0]?.name || '', expenses: pv.count, groups: pv.groups.length }; } catch { return null; }
  }
  function onJoin(inv, uid) {   // the new account is who the claim is for; they still answer it
    const c = inv && inv.claim && store.claims[inv.claim];
    if (live(c) && !c.to) { c.to = uid; save(); }
  }
  function cancel(c, why) { c.status = 'cancelled'; c.answeredAt = now(); if (why) c.why = why;
    if (c.invite && U().invites?.[c.invite] && !U().invites[c.invite].used) { delete U().invites[c.invite]; saveUsers(); } save(); }
  function prune() {
    let n = 0;
    for (const [id, c] of Object.entries(store.claims)) {
      if (c.status === 'open' && c.exp < now()) { c.status = 'expired'; n++; }
      if (c.status === 'yes' && c.changes && now() - c.answeredAt > UNDO_DAYS * 864e5) { delete c.changes; n++; }
      if (c.status !== 'open' && now() - (c.answeredAt || c.at) > 120 * 864e5) { delete store.claims[id]; n++; }
    }
    if (n) save();
  }
  const view = (c, uid) => ({ id: c.id, status: c.status, at: c.at, exp: c.exp, answeredAt: c.answeredAt || null, by: c.by, byName: nameFor(c.by),
    to: c.to || null, toName: c.to ? nameFor(c.to) : null, viaLink: !!c.invite, name: c.contact?.name || c.guests[0]?.name || '',
    groups: c.guests.map(g => groupName(g.gid)), contact: !!c.contact, summary: c.summary || null,
    canUndo: c.status === 'yes' && !!c.changes && now() - c.answeredAt < UNDO_DAYS * 864e5 && (uid === c.by || uid === c.to) });

  // ---------- requests ----------
  async function handle(req, res, url, uid) {
    const p = url.pathname, m = req.method;
    if (!p.startsWith('/api/claims')) return false;
    prune();
    if (p === '/api/claims' && m === 'GET') {
      const incoming = all().filter(c => live(c) && c.to === uid).map(c => { let pv = null; try { pv = preview(c, uid); } catch (e) { pv = { error: e.message }; } return { ...view(c, uid), preview: pv }; });
      const sent = all().filter(c => c.by === uid && c.status !== 'cancelled').sort((a, b) => b.at - a.at).slice(0, 30).map(c => view(c, uid));
      const got = all().filter(c => c.to === uid && c.status === 'yes').sort((a, b) => b.at - a.at).slice(0, 10).map(c => view(c, uid));
      return send(res, 200, { incoming, sent, got }), true;
    }
    if (p === '/api/claims' && m === 'POST') {   // { contact?, guests?: [{gid,id}], to? (someone on the app) | link: true, dry? }
      const b = await readBody(req);
      const t = checkTargets(uid, b || {});
      if (t.error) return send(res, 400, { error: t.error }), true;
      const to = b.to ? String(b.to) : null;
      if (to && (!U().users[to] || to === uid)) return send(res, 400, { error: 'Pick someone else on Split it.' }), true;
      if (!to && !b.link && !b.dry) return send(res, 400, { error: 'Send it as a link or to someone on Split it.' }), true;
      const c = { id: crypto.randomBytes(9).toString('base64url'), by: uid, at: now(), exp: now() + (to ? OPEN_DAYS : 7) * 864e5, to, contact: t.contact, guests: t.guests, status: 'open' };
      let pv; try { pv = preview(c, to); } catch (e) { return send(res, 409, { error: e.message }), true; }
      if (b.dry) return send(res, 200, { preview: pv }), true;
      // one open claim per name-only person: a new one replaces the last
      for (const o of all()) if (live(o) && o.by === uid && ((t.contact && o.contact?.id === t.contact.id) || t.guests.some(g => o.guests.some(x => x.gid === g.gid && x.id === g.id)))) cancel(o, 'replaced');
      if (!to) {
        U().invites = U().invites || {};
        const open = Object.values(U().invites).filter(v => v.by === uid && !v.used && v.exp > now()).length;
        if (open >= 20) return send(res, 429, { error: 'You have 20 unused invite links. Cancel some first.' }), true;
        c.invite = crypto.randomBytes(18).toString('base64url');
        U().invites[c.invite] = { by: uid, at: now(), exp: c.exp, claim: c.id, name: c.contact?.name || c.guests[0]?.name || '' };
        saveUsers();
      }
      store.claims[c.id] = c; save();
      if (to) notify([to], { title: `${nameFor(uid)} has some history for you`, body: `${pv.count} ${pv.count === 1 ? 'entry' : 'entries'} you two logged before. Open Split it to check and take them over.`, tag: 'claim-' + c.id });
      if (to) refresh([to]);
      return send(res, 200, { id: c.id, token: c.invite || null, exp: c.exp, preview: pv }), true;
    }
    const b = m === 'POST' ? await readBody(req) : {};
    const c = b && typeof b.id === 'string' && Object.hasOwn(store.claims, b.id) ? store.claims[b.id] : null;
    if (!c) return send(res, 404, { error: 'That request is gone.' }), true;
    if (p === '/api/claims/answer' && m === 'POST') {
      if (c.to !== uid || !live(c)) return send(res, 410, { error: 'That request has expired or was answered already.' }), true;
      if (!b.yes) {
        c.status = 'no'; c.answeredAt = now(); save();
        notify([c.by], { title: `${nameFor(uid)} said it’s not them`, body: `Nothing moved. The history you logged for ${c.contact?.name || c.guests[0]?.name} stays as it was.`, tag: 'claim-' + c.id });
        refresh([c.by]);
        return send(res, 200, { ok: true }), true;
      }
      try {
        const s = accept(c, uid);
        notify([c.by], { title: `${nameFor(uid)} took over their history`, body: `Everything you logged for ${c.contact?.name || c.guests[0]?.name} is now with ${nameFor(uid)}. Balances are the same.`, tag: 'claim-' + c.id });
        const others = new Set(); for (const g of s.groups) for (const [k, mm] of Object.entries(docs())) if (k.startsWith(`groups/${g.gid}/members/`) && mm?.kind === 'account' && mm.active !== false) others.add(segs(k)[3]);
        others.delete(uid); others.delete(c.by);
        if (others.size) notify([...others], { title: `${nameFor(uid)} joined ${s.groups.map(g => g.name).join(', ')}`, body: `${nameFor(uid)} took over the history logged as ${s.groups[0].as}. Nothing else changed.`, tag: 'claim-' + c.id });
        return send(res, 200, { ok: true, summary: s }), true;
      } catch (e) { return send(res, 409, { error: e.message }), true; }
    }
    if (p === '/api/claims/cancel' && m === 'POST') {
      if (c.by !== uid || c.status !== 'open') return send(res, 400, { error: 'Only an open request you sent can be cancelled.' }), true;
      cancel(c); if (c.to) refresh([c.to]);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/claims/undo' && m === 'POST') {
      if (uid !== c.by && uid !== c.to) return send(res, 404, { error: 'That request is gone.' }), true;
      if (c.status !== 'yes' || !c.changes || now() - c.answeredAt > UNDO_DAYS * 864e5) return send(res, 410, { error: `This can only be undone for ${UNDO_DAYS} days.` }), true;
      const why = undo(c);
      if (why) return send(res, 409, { error: why }), true;
      notify([uid === c.by ? c.to : c.by], { title: `${nameFor(uid)} undid a hand-over`, body: 'Those entries are back the way they were before.', tag: 'claim-' + c.id });
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 404, { error: 'not found' }), true;
  }
  handle.forInvite = forInvite;
  handle.onJoin = onJoin;
  handle.cancelById = id => { const c = Object.hasOwn(store.claims, id) ? store.claims[id] : null; if (c && c.status === 'open') { cancel(c); if (c.to) refresh([c.to]); } };
  handle.file = FILE;
  handle.reload = () => { try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = { claims: {} }; } };
  return handle;
};
