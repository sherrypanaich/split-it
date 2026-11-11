// Split it connector for AI assistants (Meta Muse, Claude, ChatGPT...), using MCP.
// No dependencies. server.js sends /mcp, /oauth/* and /.well-known/* here.
//
// The assistant signs in the same way a person does: it opens a Split it sign-in page,
// you type your name and password, and it can then act as you. Two ways to connect:
//   1. OAuth (what Muse and Claude use): give the assistant https://YOUR-ADDRESS/mcp
//   2. A key, for assistants that ask for an API key or bearer token:
//      node server.js mcp-key NAME   prints a key. Send it as "Authorization: Bearer KEY",
//      or as a last resort put it in the link: https://YOUR-ADDRESS/mcp?key=KEY
//      node server.js mcp-revoke NAME  signs every assistant out for that person.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCESS_DAYS = 30, REFRESH_DAYS = 365;
const IDLE_DAYS = 90;              // a key or assistant sign-in nobody used for this long stops working
const MAX_CLIENTS = 500, REG_PER_HOUR = 20, UNUSED_CLIENT_HOURS = 24;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = function makeMcp(h) {
  // h: helpers from server.js
  const FILE = path.join(h.DATA_DIR, 'oauth.json');
  // Kept in data/oauth.json. Re-read when it changes on disk, so `node server.js mcp-key` works without a restart.
  let store = {}, loadedAt = -1;
  const fresh = () => {
    let m = 0; try { m = fs.statSync(FILE).mtimeMs; } catch {}
    if (m !== loadedAt) { try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = {}; } loadedAt = m; }
    store.clients = store.clients || {}; store.codes = store.codes || {}; store.tokens = store.tokens || {};
  };
  const saveStore = () => { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(store)); fs.renameSync(t, FILE); try { loadedAt = fs.statSync(FILE).mtimeMs; } catch {} };
  fresh();
  // When an assistant (or key) was last used. An assistant's access and refresh tokens count together,
  // so one that keeps refreshing, or keeps using its access token, stays connected.
  const lastUse = () => { const m = new Map();
    for (const t of Object.values(store.tokens)) { const k = t.kind === 'key' ? t : t.uid + '|' + t.client; m.set(k, Math.max(m.get(k) || 0, t.used || 0, t.at || 0)); }
    return t => m.get(t.kind === 'key' ? t : t.uid + '|' + t.client) || 0; };
  const idle = (t, last) => Date.now() - last(t) > IDLE_DAYS * 864e5;
  const tidy = () => {
    const now = Date.now(), last = lastUse();
    for (const [k, c] of Object.entries(store.codes)) if (c.exp < now) delete store.codes[k];
    for (const [k, t] of Object.entries(store.tokens)) if ((t.exp && t.exp < now) || idle(t, last)) delete store.tokens[k];
    // Apps that registered but never got as far as someone signing in go after a day.
    for (const [id, c] of Object.entries(store.clients)) if (!c.used && now - (c.at || 0) > UNUSED_CLIENT_HOURS * 3600e3) delete store.clients[id];
  };
  // The list of apps is full: make room by dropping the oldest ones nobody is connected through.
  const makeRoom = () => {
    const live = new Set([...Object.values(store.tokens), ...Object.values(store.codes)].map(t => t.client));
    const spare = Object.entries(store.clients).filter(([id]) => !live.has(id)).sort((a, b) => (a[1].used || a[1].at || 0) - (b[1].used || b[1].at || 0));
    while (Object.keys(store.clients).length >= MAX_CLIENTS && spare.length) delete store.clients[spare.shift()[0]];
    return Object.keys(store.clients).length < MAX_CLIENTS;
  };
  const regHits = new Map();   // address -> times it registered an app in the last hour

  // This app's public address, e.g. https://old-laptop.tail1234.ts.net. Set PUBLIC_URL if it comes out wrong.
  const base = req => {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const local = /^(localhost|127\.|\[::1\]|10\.|192\.168\.)/.test(host);
    return `${h.secure(req) || !local ? 'https' : 'http'}://${host}`;
  };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' };
  const json = (res, code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readText = req => new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > 1e6) { no(new Error('too big')); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c).toString()));
  });
  const readForm = async req => {
    const t = await readText(req);
    if (/json/.test(req.headers['content-type'] || '')) { try { return JSON.parse(t || '{}'); } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(t));
  };

  // ---------- keys and tokens ----------
  function issue(uid, client, kind, days, more = {}) {
    const t = (kind === 'key' ? 'hsk_' : '') + rand();
    store.tokens[sha(t)] = { uid, client, kind, at: Date.now(), exp: days ? Date.now() + days * 864e5 : null, ...more };
    return t;
  }
  function whoIs(req, url) {
    const m = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
    const t = m ? m[1] : url.searchParams.get('key');
    const rec = t && store.tokens[sha(t)];
    if (!rec || rec.kind === 'refresh' || (rec.exp && rec.exp < Date.now()) || !h.users().users[rec.uid]) return null;
    if (idle(rec, lastUse())) { tidy(); saveStore(); return null; }
    if (Date.now() - (rec.used || 0) > 3600e3) { rec.used = Date.now(); saveStore(); }   // "last used", at most once an hour
    return rec.uid;
  }
  // How many assistants act as this person, and a way to sign them all out (used by the owner's admin page).
  const connected = uid => { fresh(); const last = lastUse(); return Object.values(store.tokens).filter(t => t.uid === uid && t.kind !== 'refresh' && !idle(t, last)).length; };
  const revoke = uid => { fresh(); let n = 0; for (const [k, t] of Object.entries(store.tokens)) if (t.uid === uid) { delete store.tokens[k]; n++; } if (n) saveStore(); return n; };
  // ---------- each person's own assistants (the "AI assistants" part of the app's settings) ----------
  // One row per assistant that signed in (Claude, Muse...) and one per key. Ids never reveal a token.
  function mine(uid) {
    fresh();
    const rows = {}, now = Date.now(), last = lastUse();
    for (const [k, t] of Object.entries(store.tokens)) {
      if (t.uid !== uid || (t.exp && t.exp < now) || idle(t, last)) continue;
      const key = t.kind === 'key', id = key ? 'k_' + k.slice(0, 16) : 'a_' + sha(t.client).slice(0, 16);
      const r = rows[id] = rows[id] || { id, kind: key ? 'key' : 'app', name: key ? (t.label || 'Key made on the laptop') : (store.clients[t.client]?.name || 'An assistant'), since: t.since || t.at, used: 0 };
      r.since = Math.min(r.since, t.since || t.at); r.used = Math.max(r.used, t.used || 0);
    }
    return Object.values(rows).sort((a, b) => Math.max(b.used, b.since) - Math.max(a.used, a.since));
  }
  function makeKey(uid, label) {
    fresh();
    const name = String(label || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'My assistant';
    if (Object.values(store.tokens).filter(t => t.uid === uid && t.kind === 'key').length >= 10) throw new Error('You already have 10 keys. Remove one you don’t use first.');
    const k = issue(uid, 'key', 'key', 0, { label: name }); saveStore();
    return k;
  }
  // Disconnect one row from mine(), or every assistant when id is 'all'. Only ever touches this person's tokens.
  function removeMine(uid, id) {
    fresh();
    let n = 0;
    for (const [k, t] of Object.entries(store.tokens)) {
      if (t.uid !== uid) continue;
      const tid = t.kind === 'key' ? 'k_' + k.slice(0, 16) : 'a_' + sha(t.client).slice(0, 16);
      if (id === 'all' || tid === id) { delete store.tokens[k]; n++; }
    }
    if (n) saveStore();
    return n;
  }

  function cli(cmd, name) {
    if (cmd !== 'mcp-key' && cmd !== 'mcp-revoke') return false;
    fresh();
    const found = h.findUser(name || '');
    if (!found) { if (name) console.log(`No user called ${name}.`); else console.log(`Usage: node server.js ${cmd} NAME`); return true; }
    if (cmd === 'mcp-key') {
      const k = issue(found[0], 'key', 'key', 0); saveStore();
      console.log(`Key for ${found[1].name} (shown once, keep it private):\n\n  ${k}\n\nIt acts as ${found[1].name}. Remove it with: node server.js mcp-revoke ${found[1].name}`);
    } else {
      let n = 0; for (const [k, t] of Object.entries(store.tokens)) if (t.uid === found[0]) { delete store.tokens[k]; n++; }
      saveStore(); console.log(`Signed out ${n ? 'every assistant' : 'nothing (no assistants were connected)'} for ${found[1].name}.`);
    }
    return true;
  }

  // ---------- OAuth: just enough for MCP clients ----------
  // Where the assistant may be sent back to: https, http on this computer, or an app link like myapp://
  const okRedirect = u => { try { const x = new URL(u), s = x.protocol.slice(0, -1);
    return s === 'https' || (s === 'http' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) || !['http', 'javascript', 'data', 'file', 'vbscript', 'blob'].includes(s); } catch { return false; } };
  const page = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' }); res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Split it</title><style>
:root{--bg:#F5F1E8;--surface:#fff;--ink:#14112A;--muted:#5D5870;--hl:#FFD23F;--owe:#E0243C}
@media (prefers-color-scheme:dark){:root{--bg:#13111C;--surface:#1E1B2C;--ink:#F1EEFF;--muted:#A9A3C2;--owe:#FF6B7D}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
form,.box{width:100%;max-width:420px;background:var(--surface);border:2.5px solid var(--ink);border-radius:14px;box-shadow:5px 5px 0 var(--ink);padding:22px}
h1{margin:0 0 6px;font-size:1.5rem}p{margin:0 0 14px;color:var(--muted)}label{display:block;font-weight:600;font-size:.88rem;color:var(--muted);margin:12px 0 6px}
input{width:100%;font:inherit;font-size:1rem;padding:12px 14px;border:2.5px solid var(--ink);border-radius:12px;background:var(--surface);color:var(--ink)}
button{width:100%;margin-top:18px;font:inherit;font-weight:800;font-size:1rem;padding:13px;border:2.5px solid var(--ink);border-radius:12px;background:var(--hl);color:#14112A;box-shadow:3px 3px 0 var(--ink);cursor:pointer}
.err{color:var(--owe);margin:12px 0 0}
.box form,form.plain{max-width:none;border:0;box-shadow:none;padding:0;background:none}
.dest{border:2.5px dashed var(--ink);border-radius:12px;padding:10px 12px;margin:0 0 10px;overflow-wrap:anywhere}.dest span{display:block;font-size:.85rem;color:var(--muted)}.dest strong{font-size:1.15rem}
.small{font-size:.88rem}details{margin-top:16px}summary{cursor:pointer;font-weight:600;color:var(--muted)}a{color:inherit;font-weight:700}</style></head><body>${body}</body></html>`); };

  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const allowToken = (who, q) => sha(['allow', who.key, q.client_id, q.redirect_uri, q.code_challenge].join('|'));
  // Where the key goes, in words a person can check: the website's address, or "an app on this computer".
  function destination(uri) {
    let x; try { x = new URL(uri); } catch { return { where: String(uri), note: '' }; }
    if (x.protocol === 'https:') return { where: x.host, note: 'the website' };
    if (x.protocol === 'http:') return { where: x.host, note: 'an app on this computer at' };
    return { where: x.protocol + '//' + (x.host || x.pathname.split('/')[0]), note: 'an app on this device:' };
  }
  function authorizeForm(res, q, client, who, err) {
    const keys = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];
    const hidden = keys.map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
    const d = destination(q.redirect_uri), name = client.name || 'an assistant';
    const here = '/oauth/authorize?' + new URLSearchParams([['response_type', 'code'], ...keys.filter(k => q[k]).map(k => [k, String(q[k])])]);
    const login = `<label for="n">Name</label><input id="n" name="name" autocomplete="username" required>
  <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required>
  <label for="cd">Sign-in code <span style="font-weight:400">(only if you turned one on)</span></label><input id="cd" name="code" inputmode="numeric" autocomplete="one-time-code">
  <button>Sign in and allow</button>`;
    page(res, err ? 401 : 200, `<div class="box">
  <h1>Connect ${esc(name)}</h1>
  <p>It will be able to see your balances and expenses and add expenses for you in Split it.</p>
  <div class="dest"><span>Your key will be sent to ${esc(d.note)}</span><strong>${esc(d.where)}</strong></div>
  <p class="small">Only allow this if you started connecting from there just now. The name above is what the app calls itself; the address is where the key really goes.</p>
  ${who ? `<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="allow" value="${esc(allowToken(who, q))}">
  <p class="small">Signed in as <b>${esc(who.name)}</b>.</p><button>Allow</button></form>
  <details><summary>Not you? Sign in as someone else</summary><form method="post" action="/oauth/authorize" class="plain">${hidden}${login}</form></details>`
  : `<form method="post" action="/oauth/authorize" class="plain">${hidden}${login}</form>
  <p class="small">Sign in with Google or an email link? <a href="/login?next=${encodeURIComponent(here)}">Sign in to Split it first</a>, then you can allow it with one tap.</p>`}
  ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}</div>`);
  }

  async function oauth(req, res, url) {
    const p = url.pathname, b = base(req);
    if (req.method === 'OPTIONS') return json(res, 204);
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: b + '/mcp', authorization_servers: [b], bearer_methods_supported: ['header'], resource_name: 'Split it' });
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))
      return json(res, 200, {
        issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token', registration_endpoint: b + '/oauth/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['split-it']
      });
    if (p === '/oauth/register' && req.method === 'POST') {
      const m = await readForm(req);
      const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.map(String) : [];
      if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) return json(res, 400, { error: 'invalid_redirect_uri' });
      const ip = h.clientIp ? h.clientIp(req) : req.socket.remoteAddress, hour = Date.now() - 3600e3;
      const hits = (regHits.get(ip) || []).filter(t => t > hour);
      if (hits.length >= REG_PER_HOUR) return json(res, 429, { error: 'slow_down', error_description: 'too many registrations from this address, try again in an hour' }, { 'Retry-After': '3600' });
      hits.push(Date.now()); regHits.set(ip, hits);
      if (regHits.size > 5000) for (const [k, v] of regHits) if (!v.some(t => t > hour)) regHits.delete(k);
      tidy();
      if (!makeRoom()) return json(res, 503, { error: 'temporarily_unavailable', error_description: 'too many connected apps' });
      const id = 'c_' + rand(12), method = ['client_secret_post', 'client_secret_basic'].includes(m.token_endpoint_auth_method) ? m.token_endpoint_auth_method : 'none';
      const secret = method === 'none' ? null : rand();
      store.clients[id] = { name: String(m.client_name || '').slice(0, 60), redirect_uris: uris, secret: secret && sha(secret), at: Date.now() };
      saveStore();
      return json(res, 201, { client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: store.clients[id].name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method });
    }
    if (p === '/oauth/authorize') {
      const q = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
      const c = store.clients[q.client_id];
      if (!c) return page(res, 400, `<div class="box"><h1>Unknown app</h1><p>Try connecting Split it from your assistant again.</p></div>`);
      if (!c.redirect_uris.includes(q.redirect_uri)) return page(res, 400, `<div class="box"><h1>That link doesn’t match</h1><p>Try connecting again from your assistant.</p></div>`);
      const back = params => { const u = new URL(q.redirect_uri); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v); res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' }); res.end(); };
      if (req.method === 'GET' && q.response_type !== 'code') return back({ error: 'unsupported_response_type', state: q.state });
      if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE S256 required', state: q.state });
      const who = h.session ? h.session(req) : null;
      if (req.method !== 'POST') return authorizeForm(res, q, c, who);
      let uid;
      if (q.allow) {
        // One tap: already signed in to the app in this browser. The form carries a value tied to this sign-in,
        // this app and this return address, so another page can't post it for you.
        if (!who || !same(String(q.allow), allowToken(who, q))) return authorizeForm(res, q, c, who, 'That took too long. Try again.');
        uid = who.uid;
      } else {
        const wait = h.tooManyTries(req);
        if (wait) return authorizeForm(res, q, c, who, wait);
        uid = await h.checkLogin(req, q.name, q.password);
        if (!uid) return authorizeForm(res, q, c, who, 'That name and password don’t match.');
        if (h.needsCode && h.needsCode(uid)) {
          if (h.slowDown) await h.slowDown(uid);
          if (!h.checkCode(uid, q.code)) { h.noteMiss(req, uid); return authorizeForm(res, q, c, who, 'Enter the 6-digit code from your authenticator app.'); }
        }
      }
      tidy();
      c.used = Date.now();
      const code = rand();
      store.codes[sha(code)] = { uid, client: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, exp: Date.now() + 10 * 60e3 };
      saveStore();
      return back({ code, state: q.state });
    }
    if (p === '/oauth/token' && req.method === 'POST') {
      const m = await readForm(req);
      const basic = /^Basic\s+(\S+)/i.exec(req.headers.authorization || '');
      if (basic) { const [i, s] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent); m.client_id = m.client_id || i; m.client_secret = m.client_secret || s; }
      const c = store.clients[m.client_id];
      if (!c || (c.secret && sha(m.client_secret || '') !== c.secret)) return json(res, 401, { error: 'invalid_client' });
      let uid, since = Date.now();
      if (m.grant_type === 'authorization_code') {
        const k = sha(m.code || ''), rec = store.codes[k];
        delete store.codes[k];
        const challenge = crypto.createHash('sha256').update(String(m.code_verifier || '')).digest('base64url');
        if (!rec || rec.exp < Date.now() || rec.client !== m.client_id || (m.redirect_uri && m.redirect_uri !== rec.redirect_uri) || challenge !== rec.challenge) {
          saveStore(); return json(res, 400, { error: 'invalid_grant' });
        }
        uid = rec.uid;
      } else if (m.grant_type === 'refresh_token') {
        const k = sha(m.refresh_token || ''), rec = store.tokens[k];
        if (!rec || rec.kind !== 'refresh' || rec.client !== m.client_id || rec.exp < Date.now() || idle(rec, lastUse())) return json(res, 400, { error: 'invalid_grant' });
        delete store.tokens[k];
        uid = rec.uid; since = rec.since || rec.at;
      } else return json(res, 400, { error: 'unsupported_grant_type' });
      if (!h.users().users[uid]) return json(res, 400, { error: 'invalid_grant' });
      tidy(); c.used = Date.now();
      const access = issue(uid, m.client_id, 'access', ACCESS_DAYS, { since }), refresh = issue(uid, m.client_id, 'refresh', REFRESH_DAYS, { since });
      saveStore();
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_DAYS * 86400, refresh_token: refresh, scope: 'split-it' });
    }
    return json(res, 404, { error: 'not_found' });
  }

  // ---------- reading Split it data ----------
  const docs = () => h.db().docs;
  const segs = h.segs;
  const cad = h.cad;
  const memberDocs = gid => Object.entries(docs()).filter(([k, m]) => k.startsWith(`groups/${gid}/members/`) && m).map(([k, m]) => ({ id: k.split('/')[3], ...m }));
  const groupsOf = uid => Object.entries(docs())
    .filter(([k, g]) => segs(k).length === 2 && segs(k)[0] === 'groups' && g && docs()[`groups/${segs(k)[1]}/members/${uid}`]?.active !== false && docs()[`groups/${segs(k)[1]}/members/${uid}`])
    .map(([k, g]) => ({ id: segs(k)[1], ...g }));
  // Private one-on-ones live under data/users/{uid}/root/: friends/{id} (people not on the app, or your own
  // notes about someone who is) and entries/{id} (expenses and payments with them). Only that person sees them.
  const privRoot = uid => `data/users/${uid}/root/`;
  const under = (pre, n) => Object.entries(docs()).filter(([k, v]) => v && k.startsWith(pre) && segs(k).length === n);
  const privFriends = uid => under(privRoot(uid) + 'friends/', 6).map(([k, f]) => ({ id: segs(k)[5], ...f }));
  const privEntries = uid => under(privRoot(uid) + 'entries/', 6).filter(([, e]) => !e.deletedAt && e.status !== 'needs_amount')
    .map(([k, e]) => ({ ...e, _key: k, people: e.people || (e.kind === 'payment' ? [e.from, e.to] : [...new Set([e.paidBy, ...Object.keys(e.split || {})])]) }));
  const isContact = (uid, id) => !h.users().users[id] && !!docs()[privRoot(uid) + 'friends/' + id];
  // + means they owe uid, per other person, from uid's private entries (same rule as the page)
  function privOwed(uid) {
    const per = {};
    for (const e of privEntries(uid)) {
      if (e.carried) continue;   // handed over to someone who joined: counted once, in the shared "carried over" line
      if (e.kind === 'payment') { if (e.confirmed === false) continue;
        if (e.from === uid) per[e.to] = (per[e.to] || 0) + e.amount; else if (e.to === uid) per[e.from] = (per[e.from] || 0) - e.amount; continue; }
      for (const [id, c] of Object.entries(e.split || {})) {
        if (e.paidBy === uid && id !== uid) per[id] = (per[id] || 0) + c;
        else if (id === uid && e.paidBy !== uid) per[e.paidBy] = (per[e.paidBy] || 0) - c;
      }
    }
    return per;
  }
  let viewer = null;   // who is asking, while a tool runs, so their private friends' names can be used
  function nameOf(id) {
    if (h.users().users[id]) return h.nameFor(id);
    if (viewer) { const f = docs()[privRoot(viewer) + 'friends/' + id]; if (f?.name) return f.name; }
    for (const [k, m] of Object.entries(docs())) if (k.endsWith('/members/' + id) && m?.name) return m.name;
    return 'Someone';
  }
  const label = (id, me) => id === me ? 'you' : nameOf(id);
  const norm = s => String(s || '').trim().toLowerCase();
  // Find a person by name among a list of ids (accounts and guests). Exact name, then first name, then prefix.
  function pick(name, ids) {
    const n = norm(name); if (!n) return { err: 'No name given.' };
    if (['me', 'i', 'myself', 'you'].includes(n)) return { id: '__me__' };
    const named = ids.map(id => ({ id, all: [nameOf(id), h.users().users[id]?.name].filter(Boolean).map(norm) }));
    for (const test of [x => x === n, x => x.split(/\s+/)[0] === n, x => x.startsWith(n)]) {
      const hits = [...new Set(named.filter(p => p.all.some(test)).map(p => p.id))];
      if (hits.length === 1) return { id: hits[0] };
      if (hits.length > 1) return { err: `More than one person matches "${name}": ${hits.map(nameOf).join(', ')}. Use the full name.` };
    }
    return { err: `No one called "${name}" here. People you can use: ${ids.map(nameOf).join(', ') || 'none'}.` };
  }
  function findGroup(uid, name) {
    const n = norm(name), gs = groupsOf(uid).filter(g => !g.archived);
    const hit = gs.filter(g => norm(g.name) === n);
    const loose = hit.length ? hit : gs.filter(g => norm(g.name).includes(n));
    if (loose.length === 1) return { g: loose[0] };
    return { err: loose.length ? `More than one group matches "${name}": ${loose.map(g => g.name).join(', ')}.` : `You’re not in a group called "${name}". Your groups: ${gs.map(g => g.name).join(', ') || 'none'}.` };
  }
  const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  function splitEqual(amount, ids) {
    const n = ids.length, b = Math.floor(amount / n), out = {}, start = crypto.randomInt(n);
    ids.forEach(id => out[id] = b);
    for (let k = 0; k < amount - b * n; k++) out[ids[(start + k) % n]]++;
    return out;
  }
  function save(uid, id, data, priv) {
    if (priv) { const p = privRoot(uid) + 'entries/' + id; docs()[p] = data; h.saveDb(); h.broadcast([p]); return; }   // only this person sees it, so nobody to tell
    const p = 'expenses/' + id, before = { [p]: docs()[p] };
    docs()[p] = data;
    h.saveDb(); h.broadcast([p]);
    h.tellPeople(uid, [{ op: 'set', path: p, data }], before).catch(e => console.error(e));
  }
  const CATS = ['groceries', 'rent', 'utilities', 'internet', 'household', 'food', 'drinks', 'transport', 'travel', 'tickets', 'gift', 'fun', 'other'];

  // ---------- tools ----------
  const tools = [
    { name: 'get_balances', title: 'Who owes whom',
      description: 'Shows what the signed-in person owes and is owed in Split it, one line per person, across all groups, one-on-one expenses and their private one-on-ones with friends who are not on the app, in Canadian dollars.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
      run(uid) {
        const per = privOwed(uid);   // + they owe you
        for (const [k, amt] of Object.entries(h.allDebts())) {
          const [from, to] = k.split('|');
          if (from === uid) per[to] = (per[to] || 0) - amt;
          if (to === uid) per[from] = (per[from] || 0) + amt;
        }
        const lines = []; let net = 0;
        for (const [id, v] of Object.entries(per).filter(([, v]) => v).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))) {
          lines.push(v > 0 ? `${nameOf(id)} owes you ${cad(v)}` : `You owe ${nameOf(id)} ${cad(-v)}`); net += v;
        }
        if (!lines.length) return `${h.nameFor(uid)}, you’re all square with everyone.`;
        return `Balances for ${h.nameFor(uid)}:\n- ${lines.join('\n- ')}\nOverall: ${net > 0 ? 'you’re owed ' + cad(net) : net < 0 ? 'you owe ' + cad(-net) : 'all square'}.`;
      } },
    { name: 'list_groups', title: 'My groups',
      description: 'Lists the Split it groups the signed-in person is in, with members and their balance in each group.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
      run(uid) {
        const gs = groupsOf(uid).filter(g => !g.archived), list = h.sharedEntries();
        if (!gs.length) return 'You’re not in any groups yet.';
        return gs.map(g => {
          const members = memberDocs(g.id).filter(m => m.active !== false).map(m => label(m.id, uid));
          const v = h.netOf(list.filter(e => e.groupId === g.id))[uid] || 0;
          return `${g.name}: ${members.join(', ')}. ${v > 0 ? 'You’re owed ' + cad(v) : v < 0 ? 'You owe ' + cad(-v) : 'You’re all square'} in this group.`;
        }).join('\n');
      } },
    { name: 'recent_expenses', title: 'Recent expenses',
      description: 'Lists recent Split it expenses and payments that include the signed-in person, newest first, including private one-on-ones with friends who are not on the app. Optionally only one group.',
      inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'Group name (optional)' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run(uid, a) {
        let gid;
        if (a.group) { const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err); gid = r.g.id; }
        const list = [...h.sharedEntries().filter(e => (e.people || []).includes(uid) && (!gid || e.groupId === gid)), ...(gid ? [] : privEntries(uid))]
          .sort((x, y) => (y.date || '').localeCompare(x.date || '') || (y.createdAt || 0) - (x.createdAt || 0))
          .slice(0, Math.min(50, Math.max(1, a.limit || 10)));
        if (!list.length) return 'No expenses yet.';
        const gname = (id, e) => id ? docs()['groups/' + id]?.name || 'a group' : e?._key ? 'one-on-one with ' + nameOf(e.friendId || e.people.find(p => p !== uid)) : 'one-on-one';
        return list.map(e => e.kind === 'payment'
          ? `${e.date}: ${label(e.from, uid)} paid ${label(e.to, uid)} ${cad(e.amount)}${e.confirmed === false ? ' (not confirmed yet)' : ''} [${gname(e.groupId, e)}]`
          : `${e.date}: ${e.title || 'Expense'} ${cad(e.amount)}, paid by ${label(e.paidBy, uid)}, your share ${cad((e.split || {})[uid] || 0)} [${gname(e.groupId, e)}]`).join('\n');
      } },
    { name: 'add_expense', title: 'Add an expense',
      description: 'Adds a shared expense to Split it. Give either a group name, or one person (for a one-on-one expense). By default the signed-in person paid and everyone active in the group (or both people) shares it equally. For an uneven split give shares (weights, like 2 for a couple and 1 for a single) or exact_amounts (dollars per person, adding up to the total). Confirm the details with the user before calling. Amounts are Canadian dollars.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'amount'], properties: {
        title: { type: 'string', description: 'What it was for, e.g. "Groceries"' },
        amount: { type: 'number', description: 'Total in dollars, e.g. 54.20' },
        group: { type: 'string', description: 'Group name. Leave out for a one-on-one expense with one person.' },
        with_person: { type: 'string', description: 'For a one-on-one expense (no group): the other person’s name.' },
        paid_by: { type: 'string', description: 'Who paid. Defaults to the signed-in person.' },
        split_between: { type: 'array', items: { type: 'string' }, description: 'Names of who shares it. Defaults to everyone in the group, or both people. Include "me" for the signed-in person.' },
        shares: { type: 'object', additionalProperties: { type: 'number' }, description: 'Uneven split by weight: name to weight, e.g. {"me": 2, "Alex": 1}. Use instead of split_between.' },
        exact_amounts: { type: 'object', additionalProperties: { type: 'number' }, description: 'Uneven split by dollars: name to amount, e.g. {"me": 30, "Alex": 24.20}. Must add up to the total. Use instead of split_between.' },
        category: { type: 'string', enum: CATS },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        note: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run(uid, a) {
        const amount = Math.round(Number(a.amount) * 100);
        if (!(amount > 0) || amount > 1e8) throw new Error('Amount must be more than $0.');
        const title = String(a.title || '').trim().slice(0, 60); if (!title) throw new Error('A title is needed.');
        const date = a.date || today(); if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('Date must look like 2026-11-06.');
        let g = null, pool;
        if (a.group) { const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err); g = r.g; pool = memberDocs(g.id).filter(m => m.active !== false).map(m => m.id); }
        else {
          if (!a.with_person) throw new Error('Give a group, or with_person for a one-on-one expense.');
          const others = [...new Set([...Object.keys(h.users().users).filter(id => id !== uid), ...privFriends(uid).filter(f => f.kind === 'contact').map(f => f.id)])];
          const r = pick(a.with_person, others); if (r.err) throw new Error(r.err + ' (Add them as a friend in the app first, or use a group.)');
          if (r.id === '__me__') throw new Error('with_person is the other person, not you.');
          pool = [uid, r.id];
        }
        const who = n => { const r = pick(n, pool); if (r.err) throw new Error(r.err); return r.id === '__me__' ? uid : r.id; };
        const paidBy = a.paid_by ? who(a.paid_by) : uid;
        if (!pool.includes(paidBy)) throw new Error('You’re not an active member of that group.');
        const id = 'e' + rand(6).replace(/[^A-Za-z0-9]/g, '') + Date.now().toString(36).slice(-3);
        const byName = (o, f) => { const out = {}; for (const [n, v] of Object.entries(o)) { const x = f(Number(v)); if (x > 0) out[who(n)] = (out[who(n)] || 0) + x; } return out; };
        let ids, split, splitMode = 'equal', splitInput, how = 'split equally between';
        if (a.shares && Object.keys(a.shares).length && a.exact_amounts && Object.keys(a.exact_amounts).length) throw new Error('Give shares or exact_amounts, not both.');
        if (a.exact_amounts && Object.keys(a.exact_amounts).length) {
          const exact = byName(a.exact_amounts, v => Math.round(v * 100)), sum = Object.values(exact).reduce((t, v) => t + v, 0);
          if (sum !== amount) throw new Error(`Those amounts add up to ${cad(sum)}, but the total is ${cad(amount)}.`);
          split = exact; ids = Object.keys(exact); splitMode = 'exact'; splitInput = { exact: { ...exact } }; how = 'split between';
        } else if (a.shares && Object.keys(a.shares).length) {
          const shares = byName(a.shares, v => Math.round(v * 100) / 100);
          if (!Object.keys(shares).length) throw new Error('Give each person a share above zero.');
          split = h.computeSplit(amount, 'shares', { shares }, id); ids = Object.keys(split); splitMode = 'shares'; splitInput = { shares }; how = 'split by shares between';
        } else {
          ids = [...new Set(a.split_between?.length ? a.split_between.map(who) : pool)];
          split = splitEqual(amount, ids); splitInput = { ids };
        }
        if (!g && ids.some(id => !pool.includes(id))) throw new Error('A one-on-one expense can only be split between the two of you.');
        const priv = !g && isContact(uid, pool[1]);
        save(uid, id, { kind: 'expense', title, amount, paidBy, split, splitMode, splitInput, category: CATS.includes(a.category) ? a.category : 'other',
          date, note: String(a.note || '').slice(0, 200), orig: null, photo: null, people: [...new Set([paidBy, ...ids])],
          ...(priv ? { friendId: pool[1] } : { groupId: g ? g.id : null }), createdAt: Date.now(), addedBy: uid, via: 'assistant' }, priv);
        return `Added "${title}" ${cad(amount)}${g ? ' in ' + g.name : ' with ' + nameOf(pool[1])}, paid by ${label(paidBy, uid)}, ${how} ${ids.map(i => label(i, uid)).join(', ')} (${ids.map(i => cad(split[i])).join(' / ')}). ${split[uid] ? 'Your share: ' + cad(split[uid]) + '.' : 'You’re not in this split.'}`;
      } },
    { name: 'record_payment', title: 'Record a payment',
      description: 'Records that the signed-in person paid someone back (for example by e-Transfer). If the other person uses the app, they confirm it there. Confirm with the user before calling.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['to', 'amount'], properties: {
        to: { type: 'string', description: 'Who was paid' }, amount: { type: 'number', description: 'Dollars' },
        group: { type: 'string', description: 'Group it was for. Leave out for one-on-one.' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run(uid, a) {
        const amount = Math.round(Number(a.amount) * 100);
        if (!(amount > 0) || amount > 1e8) throw new Error('Amount must be more than $0.');
        let g = null, pool;
        if (a.group) { const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err); g = r.g; pool = memberDocs(g.id).filter(m => m.active !== false).map(m => m.id); }
        else pool = [...new Set([...Object.keys(h.users().users), ...privFriends(uid).filter(f => f.kind === 'contact').map(f => f.id)])];
        const r = pick(a.to, pool.filter(id => id !== uid)); if (r.err) throw new Error(r.err); if (r.id === '__me__') throw new Error('You can’t pay yourself. Give the name of the person you paid.');
        const to = r.id, confirmed = !h.users().users[to], priv = !g && isContact(uid, to);
        const id = 'p' + rand(6).replace(/[^A-Za-z0-9]/g, '') + Date.now().toString(36).slice(-3);
        save(uid, id, { kind: 'payment', from: uid, to, amount, date: today(), createdAt: Date.now(), addedBy: uid, confirmed, people: [uid, to], ...(priv ? { friendId: to } : { groupId: g ? g.id : null }), via: 'assistant' }, priv);
        return `Recorded: you paid ${nameOf(to)} ${cad(amount)}${g ? ' for ' + g.name : ''}.${confirmed ? '' : ` ${nameOf(to)} will be asked to confirm it in Split it.`}`;
      } },
    { name: 'settle_up_plan', title: 'Who should pay whom',
      description: 'Works out the payments that would settle a Split it group: who should pay whom, and how much. It only suggests; nothing is recorded. Use record_payment after someone has actually paid.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'string', description: 'Group name' } } },
      annotations: { readOnlyHint: true },
      run(uid, a) {
        const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err);
        const list = h.sharedEntries().filter(e => e.groupId === r.g.id);
        const plan = r.g.simplify === false ? h.pairwiseOf(list) : h.simplified(h.netOf(list));
        if (!plan.length) return `${r.g.name} is all square. Nobody owes anything.`;
        const waiting = list.filter(e => e.kind === 'payment' && e.confirmed === false);
        return `To settle ${r.g.name}:\n- ${plan.map(p => `${label(p.from, uid) === 'you' ? 'You pay' : nameOf(p.from) + ' pays'} ${label(p.to, uid)} ${cad(p.amount)}`).join('\n- ')}`
          + (waiting.length ? `\n${waiting.length} payment${waiting.length === 1 ? ' is' : 's are'} recorded but not confirmed yet, so ${waiting.length === 1 ? 'it isn’t' : 'they aren’t'} counted above.` : '');
      } },
    { name: 'list_bills', title: 'Bills coming up',
      description: 'Lists the repeating bills (rent, hydro, internet, subscriptions) in the signed-in person’s Split it groups: amount, who pays, how often and when each is next due. Optionally only one group.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { group: { type: 'string', description: 'Group name (optional)' } } },
      annotations: { readOnlyHint: true },
      run(uid, a) {
        let gs = groupsOf(uid).filter(g => !g.archived);
        if (a.group) { const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err); gs = [r.g]; }
        const gname = Object.fromEntries(gs.map(g => [g.id, g.name])), rows = [];
        for (const [k, b] of Object.entries(docs())) {
          if (segs(k)[0] !== 'recurring' || segs(k).length !== 2 || !b || !gname[b.groupId]) continue;
          const key = b.lastPosted ? h.billNextKey(b, b.lastPosted) : h.billFirstKey(b);
          rows.push({ due: b.paused || !key ? null : h.billDate(b, key), text: `${b.title || 'Bill'}: ${b.variable ? 'amount changes each time' : cad(b.amount)}, ${b.every === 'week' ? 'weekly' : b.every === 'year' ? 'yearly' : 'monthly'}, ${b.paidBy ? label(b.paidBy, uid) + (b.paidBy === uid ? ' pay' : ' pays') : 'nobody set to pay'} [${gname[b.groupId]}]` });
        }
        if (!rows.length) return 'No repeating bills are set up.';
        rows.sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999'));
        return rows.map(x => `${x.due ? 'Next due ' + x.due : 'Paused'}: ${x.text}`).join('\n');
      } },
    { name: 'month_summary', title: 'A month in a group',
      description: 'Sums up one month of spending in a Split it group: the total, the signed-in person’s share, what they paid, spending by category and the biggest expenses. Defaults to the current month.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'string', description: 'Group name' }, month: { type: 'string', description: 'YYYY-MM, defaults to this month' } } },
      annotations: { readOnlyHint: true },
      run(uid, a) {
        const r = findGroup(uid, a.group); if (r.err) throw new Error(r.err);
        const ym = a.month || today().slice(0, 7); if (!/^\d{4}-\d\d$/.test(ym)) throw new Error('Month must look like 2026-11.');
        const list = h.sharedEntries().filter(e => e.groupId === r.g.id && e.kind !== 'payment' && (e.date || '').startsWith(ym));
        if (!list.length) return `Nothing was spent in ${r.g.name} in ${ym}.`;
        const total = list.reduce((t, e) => t + e.amount, 0), mine = list.reduce((t, e) => t + ((e.split || {})[uid] || 0), 0), paid = list.filter(e => e.paidBy === uid).reduce((t, e) => t + e.amount, 0);
        const cats = {}; for (const e of list) cats[e.category || 'other'] = (cats[e.category || 'other'] || 0) + e.amount;
        const top = [...list].sort((x, y) => y.amount - x.amount).slice(0, 3);
        return `${r.g.name} in ${ym}: ${cad(total)} across ${list.length} expense${list.length === 1 ? '' : 's'}. Your share was ${cad(mine)} and you paid ${cad(paid)}.`
          + `\nBy category: ${Object.entries(cats).sort((x, y) => y[1] - x[1]).map(([c, v]) => `${c} ${cad(v)}`).join(', ')}.`
          + `\nBiggest: ${top.map(e => `${e.title || 'Expense'} ${cad(e.amount)}`).join(', ')}.`;
      } },
    { name: 'delete_last_expense', title: 'Undo my last entry',
      description: 'Removes the most recent expense or payment the signed-in person added through an assistant in the last 10 minutes, for when the amount or the people were wrong. Older entries stay; fix those in the app.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run(uid) {
        const cutoff = Date.now() - 10 * 60e3;
        const mine = Object.entries(docs()).filter(([k, e]) => ((k.startsWith('expenses/') && k.split('/').length === 2) || (k.startsWith(privRoot(uid) + 'entries/') && segs(k).length === 6)) && e && !e.deletedAt && e.addedBy === uid && e.via === 'assistant' && e.createdAt > cutoff)
          .sort((a, b) => b[1].createdAt - a[1].createdAt);
        if (!mine.length) return 'Nothing to undo: you haven’t added anything through an assistant in the last 10 minutes.';
        const [k, e] = mine[0];
        docs()[k] = { ...e, deletedAt: Date.now(), deletedBy: uid };
        h.saveDb(); h.broadcast([k]);
        return `Removed ${e.kind === 'payment' ? 'the payment of ' + cad(e.amount) + ' to ' + nameOf(e.to) : (e.title || 'the expense') + ' (' + cad(e.amount) + ')'}. It can be restored from the bin in the app within 30 days.`;
      } }
  ];

  // ---------- MCP over streamable HTTP (stateless, plain JSON replies) ----------
  const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  function rpc(uid, msg) {
    const { id, method, params = {} } = msg || {};
    const ok = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
    if (id === undefined) return null;   // a notification: nothing to send back
    if (method === 'initialize') return ok({
      protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'split-it', title: 'Split it by Budget it', version: h.version || '2.2.0' },
      instructions: 'Split it tracks shared house expenses between housemates, in Canadian dollars. Tools act as the person who signed in ("you"). Before adding an expense or payment, check the details with the user.'
    });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: tools.map(({ run, ...t }) => t) });
    if (method === 'tools/call') {
      const t = tools.find(x => x.name === params.name);
      if (!t) return fail(-32602, 'Unknown tool: ' + params.name);
      viewer = uid;
      try { return ok({ content: [{ type: 'text', text: t.run(uid, params.arguments || {}) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: e.message }], isError: true }); }
      finally { viewer = null; }
    }
    return fail(-32601, 'Method not found: ' + method);
  }
  async function mcp(req, res, url) {
    if (req.method === 'OPTIONS') return json(res, 204);
    const uid = whoIs(req, url);
    if (!uid) return json(res, 401, { error: 'invalid_token', error_description: 'Sign in to Split it first.' },
      { 'WWW-Authenticate': `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"` });
    if (req.method === 'GET') return json(res, 405, { error: 'This server only answers POST.' }, { Allow: 'POST' });
    if (req.method === 'DELETE') return json(res, 200, {});
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, { Allow: 'POST' });
    let body;
    try { body = JSON.parse(await readText(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const out = Array.isArray(body) ? body.map(m => rpc(uid, m)).filter(Boolean) : rpc(uid, body);
    if (!out || (Array.isArray(out) && !out.length)) return json(res, 202);
    return json(res, 200, out);
  }

  return {
    cli, connected, revoke, mine, makeKey, removeMine, address: req => base(req) + '/mcp',
    // Returns true when it handled the request.
    async handle(req, res) {
      const url = new URL(req.url, 'http://x'), p = url.pathname;
      if (p === '/mcp' || p === '/mcp/' || p.startsWith('/oauth/') || p.startsWith('/.well-known/')) fresh();
      if (p === '/mcp' || p === '/mcp/') { await mcp(req, res, url); return true; }
      if (p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth-') || p === '/.well-known/openid-configuration') { await oauth(req, res, url); return true; }
      return false;
    }
  };
};
