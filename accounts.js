// Accounts for Split it: invite links, email (through Resend), password reset,
// email sign-in links, Sign in with Google, change password, sign out everywhere.
//
// It stays private: nobody can sign up on their own. A new account needs an
// invite link from someone already in. Google and email only sign in people
// who already have an account (or who hold an invite).
//
// Settings (environment variables, or a split-it.env file next to server.js):
//   PUBLIC_URL            the address people use, e.g. https://laptop.tail1234.ts.net
//   RESEND_API_KEY        from resend.com, turns on emails
//   MAIL_FROM             e.g. "Split it <hello@yourdomain.com>" (a domain verified in Resend)
//   GOOGLE_CLIENT_ID      from Google Cloud, turns on "Continue with Google"
//   GOOGLE_CLIENT_SECRET
'use strict';
const crypto = require('crypto');

module.exports = function accounts(h) {
  const { users, saveUsers, docs, saveDb, broadcast, hashPw, findUser, setCookie, cookies, clientIp, misses,
    tooManyTries, nameFor, readBody, send, file, secure, SESSION_DAYS } = h;
  const env = k => (process.env[k] || '').trim();
  const RESEND = env('RESEND_API_KEY'), FROM = env('MAIL_FROM') || 'Split it <onboarding@resend.dev>';
  const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');
  const G_AUTH = env('GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth';
  const G_TOKEN = env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
  const RESEND_URL = env('RESEND_URL') || 'https://api.resend.com/emails';
  const now = () => Date.now();
  const U = () => users();
  const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
  const cleanEmail = e => String(e || '').trim().toLowerCase();
  const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(e) && e.length <= 254;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function base(req) {
    const set = env('PUBLIC_URL').replace(/\/+$/, '');
    if (set) return set;
    return (secure(req) ? 'https://' : 'http://') + String(req.headers.host || 'localhost');
  }
  function miss(req) {
    const ip = clientIp(req), m = misses.get(ip);
    misses.set(ip, { n: (m && now() - m.at < 15 * 60e3 ? m.n : 0) + 1, at: now() });
  }
  function startSession(req, res, uid) {
    const t = crypto.randomBytes(32).toString('hex');
    for (const [k, s] of Object.entries(U().sessions)) if (s.exp < now()) delete U().sessions[k];
    U().sessions[t] = { uid, exp: now() + SESSION_DAYS * 864e5 };
    saveUsers();
    setCookie(req, res, t, SESSION_DAYS * 86400);
  }
  const userByEmail = e => Object.entries(U().users).find(([, u]) => u.emailVerified && u.email === cleanEmail(e));
  const userByGoogle = sub => Object.entries(U().users).find(([, u]) => u.google === sub);

  // ---------- one-time codes (stored hashed) ----------
  function makeCode(kind, data, minutes) {
    U().codes = U().codes || {};
    for (const [k, c] of Object.entries(U().codes)) if (c.exp < now() - 864e5) delete U().codes[k];
    const t = rand();
    U().codes[sha(t)] = { kind, ...data, exp: now() + minutes * 60e3 };
    saveUsers();
    return t;
  }
  function takeCode(kind, t, peek) {
    const k = sha(t), c = (U().codes || {})[k];
    if (!c || c.kind !== kind || c.used || c.exp < now()) return null;
    if (!peek) { c.used = now(); saveUsers(); }
    return c;
  }

  // ---------- email ----------
  async function mail(to, subject, lines, link, button) {
    if (!RESEND) throw new Error('Email isn’t set up on this Split it yet.');
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#14112A">
      <h2 style="margin:0 0 4px">Split it</h2><p style="margin:0 0 18px;color:#5D5870;font-size:13px">by Budget it</p>
      ${lines.map(l => `<p>${esc(l)}</p>`).join('')}
      <p style="margin:24px 0"><a href="${esc(link)}" style="background:#FFD23F;color:#14112A;padding:12px 20px;border-radius:10px;border:2px solid #14112A;font-weight:700;text-decoration:none">${esc(button)}</a></p>
      <p style="color:#5D5870;font-size:13px">If the button doesn’t work, copy this link: ${esc(link)}</p>
      <p style="color:#5D5870;font-size:13px">Didn’t ask for this? You can ignore this email.</p></div>`;
    const text = `${lines.join('\n\n')}\n\n${button}: ${link}\n\nDidn’t ask for this? You can ignore this email.`;
    const r = await fetch(RESEND_URL, { method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }) });
    if (!r.ok) { console.error('Resend error', r.status, await r.text().catch(() => '')); throw new Error('The email didn’t send. Try again in a minute.'); }
  }
  const lastMail = new Map();   // person + kind -> time, so nobody can be flooded with emails
  const tooSoon = (uid, kind) => { const k = uid + ':' + kind, t = lastMail.get(k); if (t && now() - t < 60e3) return true; lastMail.set(k, now()); return false; };

  // ---------- new accounts (only through an invite) ----------
  function liveInvite(token) {
    const inv = typeof token === 'string' && Object.hasOwn(U().invites || {}, token) ? U().invites[token] : null;
    return inv && !inv.used && inv.exp > now() ? inv : null;
  }
  function uniqueName(n) {
    n = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 30) || 'Friend';
    if (!findUser(n)) return n;
    for (let i = 2; i < 100; i++) if (!findUser(`${n} ${i}`)) return `${n} ${i}`;
    return `${n} ${rand(3)}`;
  }
  function createFromInvite(inv, fields) {
    const id = 'u_' + crypto.randomBytes(11).toString('hex');
    U().users[id] = { owner: false, invitedBy: inv.by, createdAt: now(), ...fields };
    inv.used = now(); inv.uid = id;
    saveUsers();
    if (U().users[inv.by]) {   // friends with whoever sent the link, both ways
      const a = `data/users/${inv.by}/root/friends/${id}`, b = `data/users/${id}/root/friends/${inv.by}`;
      docs()[a] = { kind: 'account', addedAt: now() }; docs()[b] = { kind: 'account', addedAt: now() };
      saveDb(); broadcast([a, b]);
    }
    return id;
  }

  // ---------- Google ----------
  const gStates = new Map();   // state -> { mode, uid, invite, exp }
  function googleStart(req, res, mode, uid, invite) {
    for (const [k, v] of gStates) if (v.exp < now()) gStates.delete(k);
    const state = rand(24);
    gStates.set(state, { mode, uid, invite, exp: now() + 10 * 60e3 });
    res.setHeader('Set-Cookie', `gst=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure(req) ? '; Secure' : ''}`);
    const q = new URLSearchParams({ client_id: G_ID, redirect_uri: base(req) + '/auth/google/callback', response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account' });
    res.writeHead(302, { Location: `${G_AUTH}?${q}` }); res.end();
  }
  const back = (res, where, msg) => { res.writeHead(302, { Location: msg ? `${where}#msg=${encodeURIComponent(msg)}` : where }); res.end(); };
  async function googleCallback(req, res, url) {
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    const st = gStates.get(state); gStates.delete(state);
    res.setHeader('Set-Cookie', `gst=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0`);
    if (!st || st.exp < now() || cookies(req).gst !== state) return back(res, '/login', 'That Google sign-in timed out. Try again.');
    if (!code) return back(res, st.mode === 'link' ? '/' : '/login', 'Google sign-in was cancelled.');
    let p;
    try {
      const r = await fetch(G_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: G_ID, client_secret: G_SECRET, redirect_uri: base(req) + '/auth/google/callback', grant_type: 'authorization_code' }) });
      const d = await r.json();
      if (!r.ok || !d.id_token) throw new Error('no token');
      // The token came straight from Google over HTTPS, so its contents can be trusted; still check who it's for.
      p = JSON.parse(Buffer.from(String(d.id_token).split('.')[1], 'base64url').toString());
      if (p.aud !== G_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) || p.exp * 1000 < now() || !p.sub) throw new Error('bad token');
    } catch (e) { console.error('Google sign-in failed:', e.message); return back(res, st.mode === 'link' ? '/' : '/login', 'Google sign-in didn’t work. Try again.'); }
    const email = p.email_verified ? cleanEmail(p.email) : '';
    const taken = userByGoogle(p.sub);
    if (st.mode === 'link') {
      const me = U().users[st.uid];
      if (!me) return back(res, '/login');
      if (taken && taken[0] !== st.uid) return back(res, '/', 'That Google account is already used by someone else on Split it.');
      me.google = p.sub; me.googleEmail = email || undefined;
      if (email && !me.emailVerified && !userByEmail(email)) { me.email = email; me.emailVerified = true; delete me.pendingEmail; }
      saveUsers();
      return back(res, '/', 'Google is connected. You can sign in with it now.');
    }
    if (st.mode === 'join') {
      const inv = liveInvite(st.invite);
      if (taken) { startSession(req, res, taken[0]); return back(res, '/'); }   // already in, just sign in
      if (!inv) return back(res, '/login', 'This invite link has expired or was already used. Ask your friend for a new one.');
      const fields = { name: uniqueName(p.given_name || p.name || (email || '').split('@')[0]), google: p.sub, googleEmail: email || undefined };
      if (email && !userByEmail(email)) { fields.email = email; fields.emailVerified = true; }
      startSession(req, res, createFromInvite(inv, fields));
      return back(res, '/');
    }
    // sign in: Google account already connected, or its email matches a checked email on an account
    let found = taken;
    if (!found && email) { found = userByEmail(email); if (found) { found[1].google = p.sub; found[1].googleEmail = email; saveUsers(); } }
    if (!found) return back(res, '/login', 'That Google account isn’t on Split it. Ask a friend for an invite link, or sign in another way.');
    startSession(req, res, found[0]);
    return back(res, '/');
  }

  // ---------- requests ----------
  const handle = async function handle(req, res, url, uid) {
    const p = url.pathname, m = req.method;
    const me = uid && U().users[uid];

    if (p === '/api/auth-options' && m === 'GET') return send(res, 200, { google: !!(G_ID && G_SECRET), email: !!RESEND }), true;

    // invite links
    if (p === '/join' && m === 'GET') return file(res, 'join.html', 'text/html; charset=utf-8'), true;
    if (p === '/api/join' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token, name, password } = await readBody(req);
      const inv = liveInvite(token);
      if (!inv) { miss(req); return send(res, 410, { error: 'This invite link has expired or was already used. Ask your friend for a new one.' }), true; }
      if (name === undefined) return send(res, 200, { ok: true, from: nameFor(inv.by), google: !!(G_ID && G_SECRET) }), true;
      const n = String(name || '').trim().replace(/\s+/g, ' ');
      if (n.length < 2 || n.length > 30) return send(res, 400, { error: 'Pick a name between 2 and 30 characters.' }), true;
      if (n.includes('@')) return send(res, 400, { error: 'Use a name, not an email. You can add your email after.' }), true;
      if (findUser(n)) return send(res, 409, { error: 'Someone already uses that name. Try adding your last initial.' }), true;
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for your password.' }), true;
      startSession(req, res, createFromInvite(inv, { name: n, ...hashPw(String(password)) }));
      return send(res, 200, { ok: true }), true;
    }

    // Google
    if (p === '/auth/google' && m === 'GET') {
      if (!G_ID || !G_SECRET) return back(res, '/login', 'Google sign-in isn’t set up on this Split it yet.'), true;
      const mode = url.searchParams.get('mode');
      if (mode === 'link') { if (!me) return back(res, '/login'), true; googleStart(req, res, 'link', uid); return true; }
      if (mode === 'join') { googleStart(req, res, 'join', null, url.searchParams.get('invite') || ''); return true; }
      googleStart(req, res, 'login'); return true;
    }
    if (p === '/auth/google/callback' && m === 'GET') { await googleCallback(req, res, url); return true; }

    // forgot password and email sign-in links (always the same answer, so nobody can probe who has an account)
    if ((p === '/api/forgot' || p === '/api/email-link') && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      if (!RESEND) return send(res, 400, { error: 'Email isn’t set up on this Split it yet. Ask whoever runs it to reset your password.' }), true;
      const { who } = await readBody(req);
      miss(req);   // counts toward the 5-per-15-minutes limit either way
      const found = findUser(String(who || ''));
      const u = found && found[1];
      if (u && u.emailVerified && u.email && !tooSoon(found[0], p)) {
        const reset = p === '/api/forgot';
        const t = makeCode(reset ? 'reset' : 'signin', { uid: found[0] }, reset ? 60 : 15);
        try {
          await mail(u.email, reset ? 'Reset your Split it password' : 'Your Split it sign-in link',
            reset ? [`Hi ${u.name}, someone asked to reset your Split it password.`, 'The link works once, for the next hour.']
                  : [`Hi ${u.name}, here’s your link to sign in to Split it.`, 'The link works once, for the next 15 minutes.'],
            `${base(req)}/login#${reset ? 'reset' : 'signin'}=${t}`, reset ? 'Pick a new password' : 'Sign in');
        } catch (e) { console.error(e.message); }
      }
      return send(res, 200, { ok: true, note: 'If that account has a checked email, a link is on its way. Check your inbox and spam folder.' }), true;
    }
    if (p === '/api/email-link/use' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token } = await readBody(req);
      const c = takeCode('signin', String(token || ''));
      if (!c || !U().users[c.uid]) { miss(req); return send(res, 410, { error: 'This sign-in link has expired or was already used. Ask for a new one.' }), true; }
      startSession(req, res, c.uid);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/reset' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token, password } = await readBody(req);
      const c = takeCode('reset', String(token || ''), true);
      if (!c || !U().users[c.uid]) { miss(req); return send(res, 410, { error: 'This reset link has expired or was already used. Ask for a new one.' }), true; }
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters.' }), true;
      takeCode('reset', String(token));
      Object.assign(U().users[c.uid], hashPw(String(password)));
      for (const [k, s] of Object.entries(U().sessions)) if (s.uid === c.uid) delete U().sessions[k];   // sign out everywhere else
      startSession(req, res, c.uid);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/auth/verify' && m === 'GET') {
      const c = takeCode('verify', url.searchParams.get('t') || '');
      const u = c && U().users[c.uid];
      if (!u || u.pendingEmail !== c.email) return back(res, uid ? '/' : '/login', 'That email link has expired. Add your email again to get a new one.'), true;
      if (userByEmail(c.email)) return back(res, uid ? '/' : '/login', 'That email is already on another account.'), true;
      u.email = c.email; u.emailVerified = true; delete u.pendingEmail; saveUsers();
      return back(res, uid ? '/' : '/login', 'Email checked. You can use it to sign in and reset your password.'), true;
    }

    if (!me) return false;   // everything below needs a signed-in person

    if (p === '/api/invite' && m === 'POST') {
      U().invites = U().invites || {};
      for (const [k, v] of Object.entries(U().invites)) if (v.exp < now() - 30 * 864e5) delete U().invites[k];
      const open = Object.values(U().invites).filter(v => v.by === uid && !v.used && v.exp > now()).length;
      if (open >= 20) return send(res, 429, { error: 'You have 20 unused invite links. Wait for some to be used or to expire.' }), true;
      const token = rand(18);
      U().invites[token] = { by: uid, at: now(), exp: now() + 7 * 864e5 };
      saveUsers();
      return send(res, 200, { token, exp: U().invites[token].exp }), true;
    }
    if (p === '/api/account' && m === 'GET') {
      return send(res, 200, { name: me.name, email: me.emailVerified ? me.email : null, pendingEmail: me.pendingEmail || null,
        google: !!me.google, googleEmail: me.googleEmail || null, hasPassword: !!me.hash,
        options: { google: !!(G_ID && G_SECRET), email: !!RESEND } }), true;
    }
    if (p === '/api/account/email' && m === 'POST') {
      const { email } = await readBody(req);
      const e = cleanEmail(email);
      if (!e) { delete me.pendingEmail; if (me.google || me.hash) { delete me.email; delete me.emailVerified; } saveUsers(); return send(res, 200, { ok: true }), true; }
      if (!okEmail(e)) return send(res, 400, { error: 'That doesn’t look like an email address.' }), true;
      const other = userByEmail(e); if (other && other[0] !== uid) return send(res, 409, { error: 'That email is already on another account.' }), true;
      if (me.emailVerified && me.email === e) return send(res, 200, { ok: true }), true;
      if (!RESEND) return send(res, 400, { error: 'Email isn’t set up on this Split it yet.' }), true;
      if (tooSoon(uid, 'verify')) return send(res, 429, { error: 'Wait a minute before asking for another email.' }), true;
      me.pendingEmail = e; saveUsers();
      const t = makeCode('verify', { uid, email: e }, 24 * 60);
      try { await mail(e, 'Check your email for Split it', [`Hi ${me.name}, tap below to add this email to your Split it account.`, 'Then you can sign in with it and reset your password if you forget it.'], `${base(req)}/auth/verify?t=${t}`, 'Yes, this is my email'); }
      catch (err) { return send(res, 502, { error: err.message }), true; }
      return send(res, 200, { ok: true, pending: e }), true;
    }
    if (p === '/api/account/password' && m === 'POST') {
      const { current, next } = await readBody(req);
      if (me.hash) {
        const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
        const h2 = Buffer.from(crypto.scryptSync(String(current || ''), me.salt, 64).toString('hex')), want = Buffer.from(me.hash);
        if (h2.length !== want.length || !crypto.timingSafeEqual(h2, want)) { miss(req); return send(res, 401, { error: 'Your current password isn’t right.' }), true; }
      }
      if (String(next || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for the new password.' }), true;
      Object.assign(me, hashPw(String(next)));
      const mine = cookies(req).hs;
      for (const [k, s] of Object.entries(U().sessions)) if (s.uid === uid && k !== mine) delete U().sessions[k];
      saveUsers();
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/google' && m === 'DELETE') {
      if (!me.hash && !(me.emailVerified && RESEND)) return send(res, 400, { error: 'Set a password first, so you can still sign in.' }), true;
      delete me.google; delete me.googleEmail; saveUsers();
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/signout-all' && m === 'POST') {
      for (const [k, s] of Object.entries(U().sessions)) if (s.uid === uid) delete U().sessions[k];
      saveUsers(); setCookie(req, res, '', 0);
      return send(res, 200, { ok: true }), true;
    }
    return false;
  };
  handle.base = base;
  // A one-time reset link the owner can hand to someone who is locked out (works for a day).
  handle.resetLink = (req, uid) => `${base(req)}/login#reset=${makeCode('reset', { uid }, 60 * 24)}`;
  return handle;
};
