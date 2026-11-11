#!/usr/bin/env node
// Split it server. No dependencies, needs Node 18 or newer.
//
//   node server.js                 start the app (PORT, HOST, DATA_DIR env vars are optional)
//   node server.js add-user NAME   add a housemate (asks for a password); or send an invite link from the app
//   node server.js set-password NAME
//   node server.js list-users
//   node server.js remove-user NAME   (signs them out everywhere; their past expenses stay)
//   node server.js code-off NAME      turn off someone's sign-in code (they lost their phone)
//   node server.js backup FILE.zip    write a full backup (data, sign-ins, photos) to a zip file (locked when BACKUP_PASSPHRASE is set)
//   node server.js restore FILE       put a backup back (.zip, .locked or a daily db .json), from a file on this computer
// These work while the app is running: the command hands the job to the running app.
//
// The owner can do all of the people and backup things from the app too: tap your picture, then "Run Split it".
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const zlib = require('zlib');
const push = require('./push');

const VERSION = '2.2.0';
const STARTED = Date.now();

// Optional settings file next to this one: KEY=value per line (see split-it.env.example).
try {
  for (const line of fs.readFileSync(path.join(__dirname, 'split-it.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) { if (e.code !== 'ENOENT') console.error('Couldn’t read split-it.env:', e.message); }
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const PUSH_KEYS_FILE = path.join(DATA_DIR, 'push-keys.json');
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'mailto:split-it@example.com';
const REMIND_HOUR = +process.env.REMIND_HOUR || 9;   // bill reminders go out after this hour, in the TZ time zone
// A second place for backups that isn't this laptop's data folder: a USB drive, or a folder a sync app
// (Dropbox, Syncthing, Nextcloud...) sends elsewhere. The records go there every 6 hours (one file a day, 14 days kept),
// and each receipt photo is copied into its photos/ folder once.
const BACKUP_COPY_DIR = (process.env.BACKUP_COPY_DIR || '').trim() ? path.resolve(process.env.BACKUP_COPY_DIR.trim()) : null;
// With BACKUP_PASSPHRASE set, those copies (and downloads, if asked) are locked with it, the same way Budget it does.
const BACKUP_PASSPHRASE = process.env.BACKUP_PASSPHRASE || '';
const KEEP_COPIES = 14;
const KEEP_BACKUPS = 30;          // daily copies
const KEEP_WEEKLY = 52;           // Sunday copies, kept a year
const KEEP_RECENT = 12;           // the 6-hourly and at-start copies (about 3 days)
const SNAPSHOT_HOURS = 6;
// "Today" on the server. Every date the server works out (bills due, reminders, backup names) uses local time,
// which is the TZ setting (TZ=America/Toronto). Never new Date().toISOString().slice(0, 10): that is UTC.
const pad2 = n => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localStamp = (d = new Date()) => `${localDay(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
const serverZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const SESSION_DAYS = 90;
const PHOTOS_PER_DAY = 40;        // per person
const PHOTO_KEEP_DELETED_DAYS = 730;

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });
// Uploads being restored and downloads being made sit here for a moment; anything left from a crash goes when the app starts.
const WORK_DIR = path.join(BACKUP_DIR, 'work');
fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
const workFile = kind => path.join(WORK_DIR, `${kind}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.part`);

// ---------- storage: plain JSON files, written atomically ----------
// A missing file means a fresh start. A damaged one never does: we fall back to the newest good
// copy (users.json.bak, or the latest backup of db.json), and refuse to start if there is none,
// so a bad file can't quietly be replaced by an empty house. When that happens the owner is told
// (which copy, and when it was taken) until they dismiss it: see ownerAlerts().
const RECOVERED_FILE = path.join(DATA_DIR, 'recovered.json');
let recovered = []; try { recovered = JSON.parse(fs.readFileSync(RECOVERED_FILE, 'utf8')); if (!Array.isArray(recovered)) recovered = []; } catch {}
function load(file, empty, fallbacks = [], looksRight = () => true) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return empty; throw e; }
  let why;
  try { const data = JSON.parse(text); if (looksRight(data)) return data; why = 'it parses, but isn’t shaped like Split it data'; } catch (e) { why = e.message; }
  console.error(`${path.basename(file)} is damaged (${why}).`);
  for (const fb of fallbacks) {
    try {
      const data = JSON.parse(fs.readFileSync(fb, 'utf8'));
      if (!looksRight(data)) continue;
      const copyAt = fs.statSync(fb).mtimeMs;
      const keep = file + '.damaged-' + Date.now();
      fs.renameSync(file, keep);
      fs.copyFileSync(fb, file);
      console.error(`Restored it from ${path.basename(fb)}. The damaged file was kept as ${path.basename(keep)}.`);
      recovered.push({ file: path.basename(file), from: path.basename(fb), copyAt, at: Date.now(), kept: path.basename(keep) });
      try { fs.writeFileSync(RECOVERED_FILE, JSON.stringify(recovered)); } catch {}
      return data;
    } catch {}
  }
  console.error(`No good copy found. Split it won't start, so nothing gets overwritten. Fix or replace ${file}, then start it again.`);
  process.exit(1);
}
const isPlainObject = o => !!o && typeof o === 'object' && !Array.isArray(o);
// What a db.json has to look like before it may replace what's here. Strict for a restore, loose at start.
function dataProblem(d, strict = true) {
  if (!isPlainObject(d)) return 'it isn’t Split it data';
  if (!isPlainObject(d.docs)) return 'it has no list of records (“docs”)';
  if (strict) for (const [k, v] of Object.entries(d.docs)) {
    if (!/^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)*$/.test(k) || k.split('/').length % 2) return `it has a record with an odd name (${k.slice(0, 60)})`;
    if (!isPlainObject(v)) return `the record ${k.slice(0, 60)} is empty or broken`;
  }
  return null;
}
function usersProblem(u) {
  if (!isPlainObject(u) || !isPlainObject(u.users)) return 'it has no list of people';
  for (const [id, x] of Object.entries(u.users)) if (!isPlainObject(x) || typeof x.name !== 'string') return `the person ${String(id).slice(0, 40)} is broken`;
  return null;
}
const newestBackups = () => { try { return fs.readdirSync(BACKUP_DIR).filter(f => /^db-(weekly-)?\d{4}-\d\d-\d\d(-\d{4})?\.json$/.test(f))
  .sort((a, b) => { const k = f => f.replace('weekly-', '').replace(/\.json$/, '').padEnd(18, '0'); return k(b).localeCompare(k(a)); })
  .map(f => path.join(BACKUP_DIR, f)); } catch { return []; } };
// A write that fails (the disk is full, the drive went read-only) never stops the app. It keeps serving what it has
// in memory, refuses new changes with a clear message (status 507), tries again, and the owner sees a warning.
const storage = { failing: {}, retryAt: 0 };   // file name -> { code, message, at, obj }
const diskMessage = e => e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')
  ? 'The laptop’s disk is full, so this wasn’t saved. Nothing already saved is lost. Free some space on the laptop, then try again.'
  : `Split it couldn’t write to its data folder${e && e.code ? ` (${e.code})` : ''}, so this wasn’t saved. Try again in a moment.`;
const diskError = e => { if (e && typeof e === 'object' && !e.storage) { e.storage = true; e.storageMessage = diskMessage(e); } return e; };
const save = (file, obj) => {
  const tmp = file + '.tmp', name = path.basename(file);
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);   // on disk before it replaces the old file, so a power cut leaves one good copy
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    diskError(e);
    if (!storage.failing[name]) console.error(`Couldn’t save ${name}:`, e.message);
    storage.failing[name] = { code: e.code || null, message: e.storageMessage, at: storage.failing[name]?.at || Date.now(), file, obj };
    throw e;
  }
  delete storage.failing[name];
};
// The reason writes are refused right now, or null. Tries the failed saves again (at most every 3 seconds) first.
function storageProblem() {
  if (!Object.keys(storage.failing).length) return null;
  if (Date.now() >= storage.retryAt) {
    storage.retryAt = Date.now() + 3e3;
    for (const [name, f] of Object.entries(storage.failing)) {
      if (name === 'db.json') { if (dbDirty) flushDb(); else delete storage.failing[name]; }
      else try { save(f.file, f.obj); } catch {}
    }
  }
  const f = Object.values(storage.failing)[0]; return f ? f.message : null;
}
let db = load(DB_FILE, { docs: {} }, newestBackups(), d => !dataProblem(d, false));          // { docs: { "groups/g1/members/u1": {...} } }
let users = load(USERS_FILE, { users: {}, sessions: {} }, [USERS_FILE + '.bak'], u => isPlainObject(u) && isPlainObject(u.users));
let pushes = load(PUSH_FILE, { subs: {}, remindedOn: null }, [PUSH_FILE + '.bak']);   // subs: { uid: [subscription, ...] }
// db.json is the big one, so quick bursts of writes are batched into one save a moment later.
// Money entries (expenses and payments) are the exception: they're on disk before the phone hears "saved" (commitDb).
let dbTimer = null, dbDirty = false, dbRetry = null;
const flushDb = () => {   // -> true when what's in memory is on disk
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; }
  if (!dbDirty) return true;
  try { save(DB_FILE, db); dbDirty = false; return true; }
  catch { if (!dbRetry) { dbRetry = setTimeout(() => { dbRetry = null; flushDb(); }, 30e3); dbRetry.unref?.(); } return false; }
};
const saveDb = () => { dbDirty = true; if (!dbTimer) dbTimer = setTimeout(flushDb, 600); };
const isMoneyPath = p => /^expenses\/[^/]+$/.test(String(p || ''));
// After a change to db: written now when it touches an expense or payment, a moment later otherwise. -> false when the disk refused it.
function commitDb(paths = []) {
  if (paths.some(isMoneyPath)) { dbDirty = true; return flushDb(); }
  saveDb(); return !storage.failing['db.json'];
}
const saveUsers = () => save(USERS_FILE, users);
const savePushes = () => save(PUSH_FILE, pushes);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { flushDb(); dropLock(); process.exit(0); });
process.on('beforeExit', () => { flushDb(); });

// ---------- passwords ----------
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) => {
  if (!u.hash || !u.salt) return false;   // signs in with Google or email only
  const h = Buffer.from(crypto.scryptSync(pw, u.salt, 64).toString('hex'));
  const want = Buffer.from(u.hash);
  return h.length === want.length && crypto.timingSafeEqual(h, want);
};
const findUser = who => {   // by name, or by a checked email
  const x = String(who || '').trim().toLowerCase();
  if (!x) return undefined;
  return Object.entries(users.users).find(([, u]) => u.name.toLowerCase() === x)
    || Object.entries(users.users).find(([, u]) => u.emailVerified && u.email === x);
};
// Taking someone out: signs them out everywhere, turns off their phones, revokes assistants. Their expenses stay.
function removeUser(id) {
  const u = users.users[id]; if (!u) return null;
  mcp.revoke(id);
  let n = 0;
  for (const [t, sess] of Object.entries(users.sessions)) if (sess.uid === id) { delete users.sessions[t]; n++; }
  delete users.users[id];
  saveUsers();
  const subs = (pushes.subs[id] || []).length;
  delete pushes.subs[id]; savePushes();
  for (const [res, uid] of listeners) if (uid === id) { try { res.end(); } catch {} listeners.delete(res); }
  return { sessions: n, subs };
}
const onlyOwner = id => users.users[id]?.owner && Object.values(users.users).filter(x => x.owner).length === 1 && Object.keys(users.users).length > 1;

// ---------- command line ----------
const ask = (q) => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); res(a); });
});
async function cli([cmd, ...rest]) {
  const name = rest.join(' ').trim();
  if (mcp.cli(cmd, name)) return;
  if (cmd === 'list-users') {
    for (const [id, u] of Object.entries(users.users)) console.log(`${u.name}${u.owner ? ' (owner)' : ''}  ${id}`);
    return;
  }
  if (cmd === 'backup') {
    const pass = BACKUP_PASSPHRASE, file = name || `split-it-backup-${localDay()}.${pass ? 'locked' : 'zip'}`;
    try { writeBackup(file, { pass }); } catch (e) { return console.log(`Couldn’t write ${file}: ${e.storage ? e.storageMessage : e.message}`); }
    return console.log(`Wrote ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)${pass ? ', locked with BACKUP_PASSPHRASE. Without it nobody can open it, you included' : ''}.`);
  }
  if (cmd === 'restore') {   // reads a file on this computer, so a big backup never has to go through the website
    if (!name || !fs.existsSync(name)) return console.log('Usage: node server.js restore FILE  (a .zip or .locked backup, or a daily db-....json)');
    const file = path.resolve(name), job = { cmd: 'restore', file, pass: '' };
    if (isLockedFile(file)) job.pass = BACKUP_PASSPHRASE || await ask('Passphrase for this backup: ');
    console.log(`Restoring ${path.basename(file)}…`);
    // A running app does it itself, so what it holds in memory can't be written back over the restore.
    const answer = await askServer(job, 30 * 60e3);
    if (answer && answer.text) return console.log(answer.text);
    if (answer) return console.log('The app is running but didn’t answer in time. It may still be restoring: look at the owner’s page in a minute.');
    return console.log(localCommand(job).text);
  }
  if (!['add-user', 'set-password', 'remove-user', 'code-off'].includes(cmd)) return console.log('Commands: add-user NAME, set-password NAME, remove-user NAME, code-off NAME, list-users, backup FILE.zip, restore FILE, mcp-key NAME, mcp-revoke NAME');
  if (!name) return console.log(`Usage: node server.js ${cmd} NAME`);
  const found = findUser(name), job = { cmd, name };
  if (cmd === 'add-user' && found) return console.log(`${name} already exists. Use set-password to change it.`);
  if (cmd !== 'add-user' && !found) return console.log(`No user called ${name}.`);
  if (cmd === 'remove-user') {
    if (onlyOwner(found[0])) return console.log(`${found[1].name} is the owner. Make someone else the owner first, or remove the others.`);
    const ok = await ask(`Remove ${found[1].name}? They can’t sign in again, but their past expenses stay. Type yes: `);
    if (ok.trim().toLowerCase() !== 'yes') return console.log('Nothing changed.');
  }
  if (cmd === 'add-user' || cmd === 'set-password') {
    job.password = await ask(`Password for ${name} (8+ characters): `);
    if (job.password.length < 8) return console.log('Too short, nothing saved.');
  }
  // A running app keeps sign-ins in memory and would write its own copy back over ours, so it does the job itself.
  const answer = await askServer(job);
  if (answer && answer.text) return console.log(answer.text);
  console.log(localCommand(job).text + (answer ? ' The app is running but didn’t answer, so restart it to pick this up.' : ''));
}
// What those commands do. Used here when the app is stopped, and by the running app when it is asked (see /api/local/cli).
function localCommand({ cmd, name, password, file, pass }) {
  if (cmd === 'restore') {
    try {
      const r = restoreFile(String(file || ''), String(pass || ''), { photosDir: path.join(path.dirname(String(file || '')), 'photos') });
      return { text: `Restored ${r.docs} records${r.users != null ? `, ${r.users} people` : ''} and ${r.photos} receipt photo${r.photos === 1 ? '' : 's'}. What was there before is kept in ${BACKUP_DIR} (before-restore-...).` };
    } catch (e) { return { text: `Nothing was restored. ${e.storage ? e.storageMessage : e.message}${e.locked && BACKUP_PASSPHRASE ? ' (BACKUP_PASSPHRASE was tried. To type another one: BACKUP_PASSPHRASE= node server.js restore FILE)' : ''}` }; }
  }
  const found = findUser(name || '');
  if (cmd === 'add-user') {
    if (found) return { text: `${name} already exists. Use set-password to change it.` };
    if (String(password || '').length < 8) return { text: 'Too short, nothing saved.' };
    const clean = String(name).trim().replace(/\s+/g, ' ').slice(0, 30);
    users.users['u_' + crypto.randomBytes(11).toString('hex')] = { name: clean, owner: !Object.keys(users.users).length, createdAt: Date.now(), ...hashPw(String(password)) };
    saveUsers();
    return { text: `Added ${clean}. They can sign in now.` };
  }
  if (!found) return { text: `No user called ${name}.` };
  const [id, u] = found;
  if (cmd === 'set-password') {
    if (String(password || '').length < 8) return { text: 'Too short, nothing saved.' };
    Object.assign(u, hashPw(String(password)));
    const n = endSessions(id, { assistants: true });
    return { text: `New password saved for ${u.name}. Signed out ${n} session${n === 1 ? '' : 's'} and any AI assistant.` };
  }
  if (cmd === 'remove-user') {
    if (onlyOwner(id)) return { text: `${u.name} is the owner. Make someone else the owner first, or remove the others.` };
    const r = removeUser(id);
    return { text: `Removed ${u.name}. Signed out ${r.sessions} session${r.sessions === 1 ? '' : 's'} and turned off ${r.subs} phone notification${r.subs === 1 ? '' : 's'}.` };
  }
  if (cmd === 'code-off') return { text: accounts.codeOff(id) ? `Sign-in code turned off for ${u.name}. They can sign in with just their password and turn it on again.` : `${u.name} didn’t have a sign-in code on.` };
  return { text: 'Unknown command.' };
}
// The running app writes data/server.lock: where it listens and a secret only this computer's user can read.
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
let localToken = null;
function claimLock() {
  localToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, token: localToken }), { mode: 0o600 });
}
const dropLock = () => { try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} };
async function askServer(job, wait = 8000) {   // -> the running app's answer, null when none is running, {} when it didn't answer
  let lock; try { lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); process.kill(lock.pid, 0); } catch { return null; }
  try {
    const r = await fetch(`http://127.0.0.1:${lock.port}/api/local/cli`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': lock.token },
      body: JSON.stringify(job), signal: AbortSignal.timeout(wait) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}
// ---------- sessions ----------
const unesc = v => { try { return decodeURIComponent(v); } catch { return v; } };   // another app's odd cookie must not break sign-in
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';')
  .map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, unesc(v.join('='))]));
function sessionUid(req) {
  const t = cookies(req).hs, s = t && users.sessions[t];
  if (!s || s.exp < Date.now() || !users.users[s.uid]) return null;
  return s.uid;
}
const pruneSessions = () => { let n = 0; for (const [t, s] of Object.entries(users.sessions)) if (s.exp < Date.now() || !users.users[s.uid]) { delete users.sessions[t]; n++; } if (n) saveUsers(); };
const secure = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
const setCookie = (req, res, val, maxAge) => res.setHeader('Set-Cookie',
  `hs=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`);

// Slow down password guessing: 5 misses per address, then a 15 minute wait.
const misses = new Map();
// Only trust X-Forwarded-For when the request comes from this machine (a tunnel or proxy),
// and then only its last entry, which the proxy itself added.
const isLocal = a => /^(127\.|::1$|::ffff:127\.)/.test(a || '');
const clientIp = req => {
  const a = req.socket.remoteAddress || '', fwd = req.headers['x-forwarded-for'];
  if (!fwd || !isLocal(a)) return a;
  return String(fwd).split(',').map(x => x.trim()).filter(Boolean).pop() || a;
};
// The same goes for one account: 10 misses from anywhere, then a 15 minute wait, so guessing from many addresses is slow too.
const recent = k => { const m = misses.get(k); return m && Date.now() - m.at < 15 * 60e3 ? m.n : 0; };
const bump = k => { misses.set(k, { n: recent(k) + 1, at: Date.now() }); if (misses.size > 5000) for (const [key, m] of misses) if (Date.now() - m.at > 15 * 60e3) misses.delete(key); };
const noteMiss = (req, uid) => { bump(clientIp(req)); if (uid) bump('acct:' + uid); };
const tooManyTries = (req, uid) => recent(clientIp(req)) >= 5 || (uid && recent('acct:' + uid) >= 10) ? 'Too many tries. Wait 15 minutes.' : null;
function checkLogin(req, name, password) {   // returns the uid, or null (and counts the miss)
  const found = findUser(name || '');
  if (found && !tooManyTries(req, found[0]) && checkPw(String(password || ''), found[1])) { misses.delete(clientIp(req)); return found[0]; }
  noteMiss(req, found && found[0]);
  return null;
}

// ---------- access rules ----------
const segs = p => String(p || '').split('/').filter(Boolean);
const validPath = p => /^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)*$/.test(p) && !segs(p).some(s => s === '.' || s === '..');
// Who sees what. Your private data is yours alone. Groups, and everything in them (expenses,
// bills, chores, comments), are seen only by the people in that group. An expense outside a group
// is seen only by the people in it. Profiles (names, colours) are seen by everyone signed in.
const memberOf = (uid, gid) => !!gid && (db.docs[`groups/${gid}/members/${uid}`] != null || db.docs['groups/' + gid]?.createdBy === uid);
function inEntry(uid, e) {
  if (!e) return false;
  if (e.groupId) return memberOf(uid, e.groupId);
  return e.addedBy === uid || e.paidBy === uid || e.from === uid || e.to === uid
    || (e.people || []).includes(uid) || Object.prototype.hasOwnProperty.call(e.split || {}, uid);
}
// doc: the document as it is (or was, for a delete). Leave it out to use what is stored now.
function canRead(uid, p, doc) {
  const s = segs(p);
  if (s[0] === 'data') return s[1] === 'users' && s[2] === uid;   // private per person
  if (s[0] === 'groups') {
    if (memberOf(uid, s[1])) return true;
    const g = s.length === 2 ? (doc === undefined ? db.docs[p] : doc) : undefined;
    return s.length === 2 && (g == null || g.createdBy === uid);   // a new group, before anyone is in it
  }
  if (s[0] === 'expenses') {
    if (s.length > 2) return inEntry(uid, db.docs['expenses/' + s[1]]);   // comments follow their expense
    const e = doc === undefined ? db.docs[p] : doc;
    return e == null || inEntry(uid, e);
  }
  if (s[0] === 'recurring' || s[0] === 'chores') {
    const d = doc === undefined ? db.docs[p] : doc;
    return d == null || !d.groupId || memberOf(uid, d.groupId);
  }
  return true;
}
// A write must be allowed for the document as it is now and as it will be after.
function canWrite(uid, p, after) {
  const s = segs(p);
  if (!canRead(uid, p)) return false;
  if (after !== undefined && !canRead(uid, p, after)) return false;
  if (s[0] === 'people' && s.length === 2) return s[1] === uid;   // only your own profile
  return true;
}

// ---------- money rules, checked on every save ----------
// The page already follows these. Checking them here too means nobody can save shares that don't
// add up, or mark a payment to someone else as received, by talking to the server directly.
// Only the parts of an entry that carry money are checked, and only when they are new or changed,
// so older entries can still be commented on, moved or deleted exactly as they are.
const sameJson = (a, b) => { const norm = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]])); return norm(a) === norm(b); };
function entryProblem(uid, p, before, after, alsoNew = new Set()) {   // -> what's wrong in plain words, or null
  const s = segs(p);
  if (s[0] !== 'expenses' || s.length !== 2 || after == null) return null;
  const fresh = before == null, pay = after.kind === 'payment';
  if (after.kind !== 'expense' && !pay) return fresh || before.kind !== after.kind ? 'An entry is either an expense or a payment.' : null;
  const changed = fresh || before.kind !== after.kind || before.amount !== after.amount || (pay
    ? before.from !== after.from || before.to !== after.to || (before.confirmed === false) !== (after.confirmed === false)
    : before.paidBy !== after.paidBy || !sameJson(before.split, after.split));
  if (!changed) return null;
  const gid = after.groupId || null;
  const known = id => typeof id === 'string' && !!id && (gid ? db.docs[`groups/${gid}/members/${id}`] != null || alsoNew.has(`groups/${gid}/members/${id}`) : !!users.users[id]);
  const was = new Set(fresh ? [] : [before.paidBy, before.from, before.to, ...Object.keys(before.split || {})]);
  const who = id => known(id) || was.has(id);   // someone already on the entry may stay, even if they have since left
  if (!Number.isSafeInteger(after.amount) || Math.abs(after.amount) > 1e11) return 'The amount has to be a whole number of cents.';
  if (fresh && after.addedBy != null && after.addedBy !== uid) return 'An entry is logged under the person who adds it.';
  if (pay) {
    if (after.amount <= 0) return 'A payment has to be more than zero.';
    if (!who(after.from) || !who(after.to)) return gid ? 'Both people in a payment have to be in the group.' : 'Both people in a payment need an account.';
    if (after.from === after.to) return 'A payment goes from one person to another.';
    // Only the person who was paid can say the money arrived. Someone without an account can't confirm, so theirs counts right away.
    const nowCounts = after.confirmed !== false && (fresh || before.confirmed === false || before.amount < after.amount);
    if (nowCounts && users.users[after.to] && after.to !== uid) return `Only ${nameFor(after.to)} can confirm they got this payment.`;
    return null;
  }
  if (after.status === 'needs_amount' && !after.amount && !Object.keys(after.split || {}).length) return who(after.paidBy) ? null : 'The person who pays has to be in the group.';
  const split = after.split;
  if (!split || typeof split !== 'object' || Array.isArray(split)) return 'An expense needs a share for at least one person.';
  if (!who(after.paidBy)) return gid ? 'The person who paid has to be in the group.' : 'The person who paid needs an account.';
  let sum = 0;
  for (const [id, c] of Object.entries(split)) {
    if (!Number.isSafeInteger(c) || (after.amount >= 0 ? c < 0 : c > 0)) return 'Each share has to be a whole number of cents.';
    if (!who(id)) return gid ? 'Everyone sharing an expense has to be in the group.' : 'Everyone sharing an expense needs an account.';
    sum += c;
  }
  if (sum !== after.amount) return 'The shares don’t add up to the total.';
  return null;
}

// ---------- live updates ----------
// Every open page keeps one event stream. A change carries the documents themselves,
// so phones patch them in place instead of downloading whole collections again.
const listeners = new Map(); // res -> uid
const streamToken = new Map(); // res -> the session it was opened with
// Sign a person out: their sessions (all, or all but `keep`), the live streams those sessions opened,
// and, when `assistants` is set, any AI assistant they connected. Used by reset, sign out everywhere and the owner tools.
function endSessions(uid, { keep = null, assistants = false } = {}) {
  let n = 0;
  for (const [t, s] of Object.entries(users.sessions)) if (s.uid === uid && t !== keep) { delete users.sessions[t]; n++; }
  saveUsers();
  for (const [res, who] of listeners) if (who === uid && streamToken.get(res) !== keep) { try { res.end(); } catch {} listeners.delete(res); streamToken.delete(res); }
  if (assistants) mcp.revoke(uid);
  return n;
}
function broadcast(paths, extra, before = {}) {
  for (const [res, uid] of listeners) {
    const visible = paths.filter(p => canRead(uid, p, db.docs[p] ?? before[p] ?? null));
    // joined or left a group: what this person can see changed, so their phone reloads its lists
    if (paths.some(p => { const s = segs(p); return s[0] === 'groups' && s[2] === 'members' && s[3] === uid && (p in before) && (before[p] == null) !== (db.docs[p] == null); }))
      res.write('event: refresh\ndata: {}\n\n');
    // taken off an expense (or it moved to a group they're not in): to them it's gone
    const gone = paths.filter(p => !visible.includes(p) && before[p] != null && db.docs[p] != null && canRead(uid, p, before[p]));
    if (!visible.length && !gone.length && !extra) continue;
    const docs = {}; for (const p of visible) docs[p] = db.docs[p] ?? null; for (const p of gone) docs[p] = null;
    res.write(`event: change\ndata: ${JSON.stringify({ paths: [...visible, ...gone], docs, ...(extra || {}) })}\n\n`);
  }
}
const tellEveryone = (event, data) => { for (const res of listeners.keys()) res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); };

// ---------- backups ----------
// In data/backups: a copy of db.json every 6 hours and at every start (so each update starts with one), 12 kept;
// the first one of each day (30 kept); and one each Sunday (a year kept). Runs hourly. A failure (full disk) is
// caught, logged and shown to the owner; the app carries on.
let lastBackupAt = null, lastSnapshotAt = 0;
const backupState = { error: null, at: null };
try { const n = newestBackups()[0]; if (n) lastBackupAt = fs.statSync(n).mtimeMs; } catch {}
function backup(atStart) {
  try {
    if (!flushDb()) throw diskError(Object.assign(new Error('db.json couldn’t be saved'), { code: storage.failing['db.json']?.code }));
    if (!fs.existsSync(DB_FILE)) save(DB_FILE, db);   // a brand-new install: the first copy still has something to copy
    const now = new Date(), day = localDay(now);
    {
      const daily = path.join(BACKUP_DIR, `db-${day}.json`);
      if (!fs.existsSync(daily)) { fs.copyFileSync(DB_FILE, daily); lastBackupAt = Date.now(); }
      const weekly = path.join(BACKUP_DIR, `db-weekly-${day}.json`);
      if (now.getDay() === 0 && !fs.existsSync(weekly)) fs.copyFileSync(DB_FILE, weekly);
      if (atStart || Date.now() - lastSnapshotAt >= SNAPSHOT_HOURS * 3600e3) {
        lastSnapshotAt = Date.now();
        const recent = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d\d-\d\d-\d{4}\.json$/.test(f)).sort().pop();
        const same = recent && fs.readFileSync(path.join(BACKUP_DIR, recent)).equals(fs.readFileSync(DB_FILE));   // nothing changed since: no new copy
        if (!same) fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `db-${localStamp(now)}.json`));
        lastBackupAt = Date.now();
      }
    }
    const trim = (re, keep) => { const old = fs.readdirSync(BACKUP_DIR).filter(f => re.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f)); };
    trim(/^db-\d{4}-\d\d-\d\d\.json$/, KEEP_BACKUPS);
    trim(/^db-weekly-\d{4}-\d\d-\d\d\.json$/, KEEP_WEEKLY);
    trim(/^db-\d{4}-\d\d-\d\d-\d{4}\.json$/, KEEP_RECENT);
    for (const f of [USERS_FILE, PUSH_FILE]) try { JSON.parse(fs.readFileSync(f, 'utf8')); fs.copyFileSync(f, f + '.bak'); } catch {}
    pruneSessions();
    prunePhotos();
    backupState.error = null; backupState.at = Date.now();
  } catch (e) {
    diskError(e);
    backupState.error = e.code === 'ENOSPC' || e.code === 'EDQUOT' ? 'The laptop’s disk is full, so no backup could be made.' : `The backup didn’t work: ${e.message}`;
    console.error('Backup:', e.message);
  }
  copyOut(false, atStart);
}
// The copy that survives this laptop's disk, in BACKUP_COPY_DIR: today's records (db.json, users.json, oauth.json) in one
// file, refreshed every 6 hours, 14 days kept; and photos/, where each receipt photo is copied once, the first time it's seen.
// With BACKUP_PASSPHRASE the day's file is a .locked one, and so is each photo.
const copyState = { at: null, error: null };
const copyRe = /^split-it-backup-\d{4}-\d\d-\d\d\.(zip|locked)$/;
const copyName = day => `split-it-backup-${day}.${BACKUP_PASSPHRASE ? 'locked' : 'zip'}`;
function copyOut(force, atStart) {
  if (!BACKUP_COPY_DIR) return null;
  try {
    const mine = () => fs.readdirSync(BACKUP_COPY_DIR).filter(f => copyRe.test(f)).sort();
    const file = path.join(BACKUP_COPY_DIR, copyName(localDay()));
    const age = fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : Infinity;
    // hourly, the copy is only made when today's is missing or 6 hours old, or the last try failed (a drive unplugged)
    if (!force && !atStart && age < SNAPSHOT_HOURS * 3600e3 && !copyState.error) return copyState;
    fs.mkdirSync(BACKUP_COPY_DIR, { recursive: true });
    const key = BACKUP_PASSPHRASE ? lockSession(BACKUP_PASSPHRASE) : null;   // one slow key per run, for the file and every photo
    writeBackup(file, { photos: false, pass: BACKUP_PASSPHRASE, key });
    copyPhotosOut(key);
    const all = mine(); for (const f of all.slice(0, Math.max(0, all.length - KEEP_COPIES))) fs.unlinkSync(path.join(BACKUP_COPY_DIR, f));
    copyState.at = fs.statSync(path.join(BACKUP_COPY_DIR, mine().pop())).mtimeMs; copyState.error = null;
  } catch (e) {
    copyState.error = e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EROFS' ? `Can’t write to ${BACKUP_COPY_DIR}. Is the drive plugged in?`
      : e.code === 'ENOSPC' || e.code === 'EDQUOT' ? `The backup drive (${BACKUP_COPY_DIR}) is full.` : e.message;
    console.error('Backup copy:', e.message);
  }
  return copyState;
}
// Receipt photos never change (a new photo gets a new name), so each goes to the copy folder once.
function copyPhotosOut(key) {
  const dir = path.join(BACKUP_COPY_DIR, 'photos'); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(PHOTO_DIR)) {
    if (!/^[a-f0-9]{24}\.jpg$/.test(f)) continue;
    const plain = path.join(dir, f), locked = plain + '.locked';
    if (key) {
      if (fs.existsSync(locked)) continue;
      const tmp = locked + '.part'; fs.writeFileSync(tmp, lockBuf(fs.readFileSync(path.join(PHOTO_DIR, f)), key), { mode: 0o600 }); fs.renameSync(tmp, locked);
      try { fs.unlinkSync(plain); } catch {}   // a passphrase was set later: the unlocked copy goes once the locked one is there
    } else if (!fs.existsSync(plain) && !fs.existsSync(locked)) {
      const tmp = plain + '.part'; fs.copyFileSync(path.join(PHOTO_DIR, f), tmp); fs.renameSync(tmp, plain);
    }
  }
}
const backupList = () => fs.readdirSync(BACKUP_DIR).filter(f => /^db-(weekly-)?\d{4}-\d\d-\d\d(-\d{4})?\.json$/.test(f))
  .sort((a, b) => { const k = f => f.replace('weekly-', '').replace(/\.json$/, '').padEnd(18, '0'); return k(b).localeCompare(k(a)); })
  .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, bytes: st.size, at: st.mtimeMs }; });
// How full the data folder's disk is, and what the owner should hear about now (shown on their page and as a banner).
const diskUse = () => { try { const st = fs.statfsSync(DATA_DIR), total = st.blocks * st.bsize, free = st.bavail * st.bsize; return { free, total, used: total ? 1 - free / total : 0 }; } catch { return null; } };
const whenText = t => new Date(t).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function ownerAlerts() {
  const out = [], sp = storageProblem(), d = diskUse();
  if (sp) out.push({ kind: 'disk', text: `Changes can’t be saved right now. ${sp}` });
  else if (d && d.used >= 0.9) out.push({ kind: 'disk', text: `The laptop’s disk is ${Math.round(d.used * 100)}% full (${(d.free / 1e9).toFixed(1)} GB left). When it’s full, Split it can’t save anything new. Free some space soon.` });
  for (const r of recovered) out.push({ kind: 'recovered', dismiss: true, text: `${r.file} was damaged when Split it started on ${whenText(r.at)}, so it was put back from the copy ${r.from}, taken ${whenText(r.copyAt)}. Anything added after that copy is missing: check recent expenses and add them again. The damaged file was kept as ${r.kept}.` });
  if (backupState.error) out.push({ kind: 'backup', text: backupState.error });
  return out;
}
// Photos stay with their expense. Once an expense has been in the bin for two years, its photo goes too.
function prunePhotos() {
  const cutoff = Date.now() - PHOTO_KEEP_DELETED_DAYS * 864e5; let n = 0;
  for (const [k, e] of Object.entries(db.docs)) {
    if (!e || !e.photo || !e.deletedAt || e.deletedAt > cutoff || segs(k)[0] !== 'expenses') continue;
    try { fs.unlinkSync(path.join(PHOTO_DIR, e.photo + '.jpg')); } catch {}
    db.docs[k] = { ...e, photo: null }; n++;
  }
  if (n) saveDb();
}

// ---------- zip files (store only, no compression library needed) ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
// Writes a zip one entry at a time into a sink ({ write(buf), end() }), so a backup never sits whole in memory:
// only one file (one photo) at a time. Store only. Plain zip, so it stops at 4 GB and 65535 files.
function zipStream(sink) {
  const central = []; let off = 0, count = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return {
    add(name, data) {
      const n = Buffer.from(name, 'utf8'), crc = crc32(data);
      if (off + 30 + n.length + data.length > 0xFFFFFFFF || count >= 0xFFFF) throw new Error('The backup is bigger than a zip can hold (4 GB). Copy the data folder by hand instead.');
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
      local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
      c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(off, 42);
      sink.write(local); sink.write(n); sink.write(data); central.push(c, n); off += local.length + n.length + data.length; count++;
    },
    end() {
      const cd = Buffer.concat(central), end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(0, 20);
      sink.write(cd); sink.write(end); sink.end();
    },
  };
}
function zipWrite(entries) {   // entries: [{name, data: Buffer}] -> the zip in memory (small things and the tests)
  const parts = [], z = zipStream({ write: b => parts.push(b), end() {} });
  for (const { name, data } of entries) z.add(name, data);
  z.end(); return Buffer.concat(parts);
}
function zipRead(buf) {   // -> { name: Buffer }, understands stored and deflated entries
  let i = buf.length - 22; while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(i + 10); let p = buf.readUInt32LE(i + 16); const out = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const ln = buf.readUInt16LE(lo + 26), lx = buf.readUInt16LE(lo + 28), start = lo + 30 + ln + lx, raw = buf.slice(start, start + csize);
    if (!name.endsWith('/')) out[name] = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : (() => { throw new Error('unsupported zip entry ' + name); })();
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
// ---------- locked backups ----------
// The same layout Budget it uses: a 6-byte mark, 16 bytes of salt, a 12-byte nonce, a 16-byte seal, then the zip encrypted
// with AES-256-GCM. The key comes from the passphrase through scrypt, so guessing is slow. Split it's mark is SIBK1,
// Budget it's is BIBK1, so a backup of one app put into the other gets a plain answer.
const LOCK_MAGIC = Buffer.from('SIBK1\n'), BUDGET_MAGIC = Buffer.from('BIBK1\n'), LOCK_HEAD = 6 + 16 + 12 + 16;
const lockKey = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
const lockSession = pass => { const salt = crypto.randomBytes(16); return { salt, key: lockKey(pass, salt) }; };
const lockedError = msg => Object.assign(new Error(msg), { locked: true });
function lockBuf(buf, k) {   // k: a lockSession
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k.key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([LOCK_MAGIC, k.salt, iv, c.getAuthTag(), enc]);
}
const isLocked = buf => buf.length > LOCK_HEAD && buf.subarray(0, 6).equals(LOCK_MAGIC);
function unlockBuf(buf, pass, keys = new Map()) {   // keys: salt -> key, so files locked in one run cost one scrypt
  if (!pass) throw lockedError('This backup is locked. Enter its passphrase.');
  const salt = buf.subarray(6, 22), id = salt.toString('hex');
  if (!keys.has(id)) keys.set(id, lockKey(pass, salt));
  const d = crypto.createDecipheriv('aes-256-gcm', keys.get(id), buf.subarray(22, 34)); d.setAuthTag(buf.subarray(34, 50));
  try { return Buffer.concat([d.update(buf.subarray(LOCK_HEAD)), d.final()]); } catch { throw lockedError('That passphrase doesn’t open this backup.'); }
}
const readAt = (fd, len, pos) => { const b = Buffer.alloc(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (!n) break; got += n; } return got === len ? b : b.subarray(0, got); };
const fileHead = (file, n) => { const fd = fs.openSync(file, 'r'); try { return readAt(fd, n, 0); } finally { fs.closeSync(fd); } };
const isLockedFile = file => { try { return fileHead(file, 6).equals(LOCK_MAGIC); } catch { return false; } };
// Where a backup is written: straight to a file, locked on the way when there's a passphrase. The seal is only known
// at the end, so its place in the header is filled in last.
function fileSink(file, pass, k) {
  const fd = fs.openSync(file, 'w', 0o600);
  const raw = buf => { let o = 0; while (o < buf.length) o += fs.writeSync(fd, buf, o, buf.length - o); };
  let cipher = null;
  if (pass) { k = k || lockSession(pass); const iv = crypto.randomBytes(12); cipher = crypto.createCipheriv('aes-256-gcm', k.key, iv); raw(Buffer.concat([LOCK_MAGIC, k.salt, iv, Buffer.alloc(16)])); }
  return {
    write(buf) { const b = cipher ? cipher.update(buf) : buf; if (b.length) raw(b); },
    end() { if (cipher) { const f = cipher.final(); if (f.length) raw(f); fs.writeSync(fd, cipher.getAuthTag(), 0, 16, 34); } fs.fsyncSync(fd); fs.closeSync(fd); },
    abort() { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} },
  };
}
// What a backup holds. Left out on purpose: sign-ins (sessions) and open invite links, which could be used to get in,
// one-time assistant sign-in codes, and phone notification subscriptions and their sending key (phones turn
// notifications on again after a move). A restore keeps the ones this laptop has now.
const BACKUP_FILES = ['db.json', 'users.json', 'oauth.json'];
function backupBytes(name) {
  const fp = path.join(DATA_DIR, name); if (!fs.existsSync(fp)) return null;
  const buf = fs.readFileSync(fp);
  try {
    if (name === 'users.json') { const u = JSON.parse(buf.toString('utf8')); u.sessions = {}; delete u.invites; return Buffer.from(JSON.stringify(u)); }
    if (name === 'oauth.json') { const o = JSON.parse(buf.toString('utf8')); if (o && o.codes) o.codes = {}; return Buffer.from(JSON.stringify(o)); }
  } catch {}
  return buf;
}
// A full backup written to a file as it's made (photos one at a time), then put in place. Throws on a full disk.
function writeBackup(file, { photos = true, pass = '', key = null } = {}) {
  if (!flushDb()) throw diskError(Object.assign(new Error('db.json couldn’t be saved'), { code: storage.failing['db.json']?.code }));
  if (!fs.existsSync(DB_FILE)) save(DB_FILE, db);   // a brand-new install: a backup still holds a (nearly empty) records file
  const tmp = file + '.part', sink = fileSink(tmp, pass, key);
  try {
    const z = zipStream(sink);
    for (const f of BACKUP_FILES) { const b = backupBytes(f); if (b) z.add(f, b); }
    let n = 0;
    if (photos) for (const f of fs.readdirSync(PHOTO_DIR)) if (/^[a-f0-9]{24}\.jpg$/.test(f)) { z.add('photos/' + f, fs.readFileSync(path.join(PHOTO_DIR, f))); n++; }
    z.add('README.txt', Buffer.from(`Split it backup, ${new Date().toString()}\n`
      + (photos ? '' : 'Receipt photos are not in this file: they are in the photos folder next to it, each copied once.\n')
      + 'To restore: on the laptop, run  node server.js restore THIS-FILE  (it finds the photos folder next to it by itself),\n'
      + 'or in the app: tap your picture, People, backups and health, Restore a backup.\n'
      + 'Sign-ins are not in a backup, so after a restore on a new laptop everyone signs in again with their password.\n'));
    z.end();
    fs.renameSync(tmp, file);
    return { photos: n };
  } catch (e) { sink.abort(); throw diskError(e); }
}

// ---------- restoring ----------
// Reads a zip from a file without loading all of it: the list first, then one entry at a time.
function zipOpen(fd) {
  const size = fs.fstatSync(fd).size, tailLen = Math.min(size, 22 + 65535), tail = readAt(fd, tailLen, size - tailLen);
  let i = tail.length - 22; while (i >= 0 && tail.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('That file isn’t a Split it backup (it isn’t a zip).');
  const count = tail.readUInt16LE(i + 10), cdSize = tail.readUInt32LE(i + 12), cdOff = tail.readUInt32LE(i + 16);
  if (cdOff + cdSize > size) throw new Error('That backup is cut short or damaged.');
  const cd = readAt(fd, cdSize, cdOff), entries = new Map(); let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('That backup is damaged.');
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), lo = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (!name.endsWith('/')) entries.set(name, { method, csize, lo });
    p += 46 + nlen + xlen + clen;
  }
  const read = name => {
    const e = entries.get(name); if (!e) return null;
    const h = readAt(fd, 30, e.lo); if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new Error('That backup is damaged.');
    const raw = readAt(fd, e.csize, e.lo + 30 + h.readUInt16LE(26) + h.readUInt16LE(28));
    if (e.method === 8) return zlib.inflateRawSync(raw);
    if (e.method === 0) return raw;
    throw new Error('That zip uses a kind of compression this can’t read.');
  };
  return { names: [...entries.keys()], read };
}
// A locked file, unlocked into a work file a piece at a time. Nothing is used unless the seal checks out at the end.
function unlockFile(src, pass, dest) {
  const fd = fs.openSync(src, 'r');
  try {
    const head = readAt(fd, LOCK_HEAD, 0);
    if (!pass) throw lockedError('This backup is locked. Enter its passphrase.');
    const d = crypto.createDecipheriv('aes-256-gcm', lockKey(pass, head.subarray(6, 22)), head.subarray(22, 34)); d.setAuthTag(head.subarray(34, 50));
    const out = fs.openSync(dest, 'w', 0o600);
    try {
      const write = b => { let o = 0; while (o < b.length) o += fs.writeSync(out, b, o, b.length - o); };
      for (let pos = LOCK_HEAD; ;) { const chunk = readAt(fd, 1 << 20, pos); if (!chunk.length) break; write(d.update(chunk)); pos += chunk.length; }
      try { write(d.final()); } catch { throw lockedError('That passphrase doesn’t open this backup.'); }
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(fd); }
}
// Put a backup back: a full zip, a locked one, or a plain db.json (one of the daily copies). Everything is read and
// checked first, and what is here now is kept in data/backups (before-restore-...), so a restore can itself be undone.
// photosDir: a folder of photos to bring back too (the photos/ folder next to a copy off the laptop).
function restoreFile(file, pass = '', { photosDir = null } = {}) {
  let src = file, tmp = null, fd = null;
  try {
    const head = fileHead(file, 8);
    if (head.subarray(0, 6).equals(BUDGET_MAGIC)) throw new Error('That’s a Budget it backup, not a Split it one.');
    if (head.subarray(0, 6).equals(LOCK_MAGIC)) { if (!pass) throw lockedError('This backup is locked. Enter its passphrase.'); tmp = workFile('unlocked'); unlockFile(file, pass, tmp); src = tmp; }
    const got = {};
    const parse = (name, buf) => { try { return JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error(`${name} in that backup is damaged, so nothing was changed.`); } };
    let zip = null;
    if (/^\s*[{[]/.test(fileHead(src, 8).toString('utf8').replace(/^﻿/, ''))) got.db = parse('That file', fs.readFileSync(src));   // a plain db.json
    else {
      fd = fs.openSync(src, 'r'); zip = zipOpen(fd);
      const d = zip.read('db.json'); if (!d) throw new Error('That backup has no db.json in it, so nothing was changed.');
      got.db = parse('db.json', d);
      const u = zip.read('users.json'); if (u) got.users = parse('users.json', u);
      const o = zip.read('oauth.json'); if (o) { parse('oauth.json', o); got.oauth = o; }
      const pk = zip.read('push-keys.json'); if (pk) try { const k = JSON.parse(pk.toString('utf8')); if (k.publicKey && k.privateJwk) got.pushKeys = pk; } catch {}
      const pj = zip.read('push.json'); if (pj) try { const x = JSON.parse(pj.toString('utf8')); if (isPlainObject(x)) got.push = x; } catch {}
    }
    const bad = dataProblem(got.db); if (bad) throw new Error(`That can’t be restored: ${bad}. Nothing was changed.`);
    const badU = got.users && usersProblem(got.users); if (badU) throw new Error(`That can’t be restored: in users.json ${badU}. Nothing was changed.`);
    // keep what we have first (if the disk is full this fails here, before anything is replaced)
    if (!flushDb()) throw diskError(Object.assign(new Error('db.json couldn’t be saved'), { code: storage.failing['db.json']?.code }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { for (const f of ['db.json', 'users.json', 'push.json', 'oauth.json']) { const fp = path.join(DATA_DIR, f); if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(BACKUP_DIR, `before-restore-${stamp}-${f}`)); } }
    catch (e) { throw diskError(e); }
    const was = db; db = got.db; dbDirty = true;
    if (!flushDb()) { db = was; dbDirty = false; throw diskError(Object.assign(new Error('db.json couldn’t be saved'), { code: storage.failing['db.json']?.code })); }
    // Sign-ins and open invites are not in a backup: the ones here now keep working if that person is still there.
    if (got.users) { const now = users; users = got.users; users.sessions = {};
      for (const [t, s] of Object.entries(now.sessions || {})) if (users.users[s.uid]) users.sessions[t] = s;
      if (!users.invites && now.invites) users.invites = now.invites;
      saveUsers(); }
    if (got.pushKeys) { fs.writeFileSync(PUSH_KEYS_FILE, got.pushKeys, { mode: 0o600 }); pushKeys = push.loadKeys(PUSH_KEYS_FILE); }
    if (got.push) { pushes = { subs: {}, ...got.push }; savePushes(); }
    if (got.oauth) fs.writeFileSync(path.join(DATA_DIR, 'oauth.json'), got.oauth, { mode: 0o600 });
    let photos = 0;
    if (zip) for (const name of zip.names) if (/^photos\/[a-f0-9]{24}\.jpg$/.test(name)) { fs.writeFileSync(path.join(PHOTO_DIR, name.slice(7)), zip.read(name)); photos++; }
    if (photosDir && fs.existsSync(photosDir)) {
      const keys = new Map();
      for (const f of fs.readdirSync(photosDir)) {
        const m = f.match(/^([a-f0-9]{24}\.jpg)(\.locked)?$/); if (!m) continue;
        const to = path.join(PHOTO_DIR, m[1]); if (fs.existsSync(to)) continue;
        try { const b = fs.readFileSync(path.join(photosDir, f)); fs.writeFileSync(to, m[2] ? unlockBuf(b, pass, keys) : b); photos++; }
        catch (e) { if (!e.locked) throw e; }   // a photo locked with another passphrase is skipped
      }
    }
    tellEveryone('reload', { why: 'restore' });
    return { docs: Object.keys(db.docs).length, users: got.users ? Object.keys(got.users.users).length : null, photos };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    if (tmp) try { fs.unlinkSync(tmp); } catch {}
  }
}

// ---------- is there a newer Split it? ----------
// Asked only when the owner opens their page, at most twice a day. It reads the public release list on GitHub
// and sends nothing about this house. UPDATE_CHECK=off turns it off.
const RELEASES_URL = process.env.RELEASES_URL || 'https://api.github.com/repos/sherrypanaich/split-it/releases/latest';
const newerThan = (a, b) => { const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let release = { at: 0, data: { current: VERSION, latest: null, newer: false, url: null } };
async function latestRelease() {
  if ((process.env.UPDATE_CHECK || '').toLowerCase() === 'off') return { ...release.data, off: true };
  if (Date.now() - release.at < 12 * 3600e3) return release.data;
  release.at = Date.now();
  try {
    const r = await fetch(RELEASES_URL, { headers: { 'User-Agent': 'split-it', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) });
    const d = r.ok ? await r.json() : null;
    if (d && /^v?\d+\.\d+\.\d+$/.test(d.tag_name || '')) release.data = { current: VERSION, latest: String(d.tag_name).replace(/^v/, ''), newer: newerThan(d.tag_name, VERSION),
      url: /^https:\/\/github\.com\//.test(d.html_url || '') ? d.html_url : null, name: String(d.name || '').slice(0, 120) };
  } catch {}
  return release.data;
}

// ---------- phone notifications ----------
let pushKeys = push.loadKeys(PUSH_KEYS_FILE);
const nudges = new Map();
const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const cad = cents => money.format((cents || 0) / 100);
const nameFor = id => db.docs['people/' + id]?.nickname || users.users[id]?.name || 'Someone';
async function notify(uids, message) {
  let sent = 0, changed = false;
  for (const id of new Set(uids)) {
    for (const sub of [...(pushes.subs[id] || [])]) {
      const r = await push.sendOne(pushKeys, sub, { url: '/', ...message }, PUSH_CONTACT);
      if (r === 'ok') sent++;
      if (r === 'gone') { pushes.subs[id] = pushes.subs[id].filter(s => s !== sub); changed = true; }
    }
  }
  if (changed) savePushes();
  return sent;
}
const activeMembers = gid => { const prefix = `groups/${gid}/members/`;
  return Object.entries(db.docs).filter(([mk, m]) => mk.startsWith(prefix) && m && m.active !== false).map(([mk]) => mk.slice(prefix.length)).filter(id => users.users[id]); };
// Tell housemates about things that involve them: new expenses, payments to confirm, comments,
// a variable bill that got its amount, an expense whose amount or split changed, and budgets being used up.
async function tellPeople(uid, ops, before) {
  for (const o of ops) {
    const s = segs(o.path), prev = before[o.path], d = db.docs[o.path];
    // a chore swap: whoever now has the turn hears about it
    if (s[0] === 'chores' && s.length === 2 && d && prev && d.swap && d.swap.at !== prev.swap?.at && Array.isArray(d.order) && d.order.length) {
      const who = d.order[(d.turn || 0) % d.order.length];
      const what = d.title || 'A chore', other = d.swap.from;
      if (who && who !== uid && users.users[who]) await notify([who], { title: `${nameFor(uid)} swapped a chore with you`, body: `${what} is yours this time${d.due ? ', due ' + d.due : ''}. ${nameFor(other)} takes your turn instead.`, tag: 'chore-' + s[1] });
      else if (other && other !== uid && users.users[other]) await notify([other], { title: `${nameFor(uid)} took your turn`, body: `${what} is theirs this time. You take their turn instead.`, tag: 'chore-' + s[1] });
      continue;
    }
    if (s[0] !== 'expenses' || !d) continue;
    const fresh = o.op === 'set' && prev == null;
    if (fresh && s.length === 2 && d.kind === 'payment' && d.confirmed === false && d.to && d.to !== uid) {
      await notify([d.to], { title: `${nameFor(d.from)} says they paid you ${cad(d.amount)}`, body: 'Open Split it to confirm you got it.', tag: 'pay-' + s[1] });
    } else if (fresh && s.length === 2 && d.kind === 'expense' && !d.recurringId && !d.deletedAt) {
      for (const id of (d.people || []).filter(x => x !== uid)) {
        const share = (d.split || {})[id] || 0;
        const body = d.paidBy === id ? `${cad(d.amount)}, you paid` : share ? `${cad(d.amount)}, your share is ${cad(share)}` : cad(d.amount);
        await notify([id], { title: `${nameFor(uid)} added ${d.title || 'an expense'}`, body, tag: 'exp-' + s[1] });
      }
      await budgetCheck(d, prev, uid);
    } else if (fresh && s.length === 4 && s[2] === 'comments' && d.text) {
      const e = db.docs['expenses/' + s[1]];
      if (!e) continue;
      await notify((e.people || []).filter(x => x !== uid), { title: `${nameFor(uid)} commented on ${e.title || "an expense"}`, body: String(d.text).slice(0, 140), tag: 'cmt-' + s[1] });
    } else if (!fresh && prev && s.length === 2 && d.kind === 'expense' && !d.deletedAt && d.status !== 'needs_amount') {
      const was = prev.status === 'needs_amount';
      const changed = was || prev.amount !== d.amount || JSON.stringify(prev.split || {}) !== JSON.stringify(d.split || {});
      if (!changed) continue;
      for (const id of (d.people || []).filter(x => x !== uid)) {
        const share = (d.split || {})[id] || 0, mine = d.paidBy === id;
        const title = was ? `${nameFor(uid)} entered ${d.title || 'a bill'}: ${cad(d.amount)}` : `${nameFor(uid)} changed ${d.title || 'an expense'}`;
        await notify([id], { title, body: mine ? `${cad(d.amount)}, you paid` : share ? `Now ${cad(d.amount)}, your share is ${cad(share)}` : `Now ${cad(d.amount)}; you’re no longer in it`, tag: 'exp-' + s[1] });
      }
      await budgetCheck(d, prev, uid);
    }
  }
}
// Optional monthly caps per category per group: a quiet nudge at 80%, another at 100%, each once a month.
async function budgetCheck(e, prev, uid) {
  if (!e.groupId || e.kind !== 'expense' || !e.category) return;
  const g = db.docs['groups/' + e.groupId], cap = g?.budgets?.[e.category]; if (!cap) return;
  const ym = (e.date || '').slice(0, 7); if (!ym) return;
  const total = sharedEntries().filter(x => x.groupId === e.groupId && x.kind !== 'payment' && x.category === e.category && (x.date || '').startsWith(ym)).reduce((t, x) => t + x.amount, 0);
  const wasTotal = total - e.amount + (prev && prev.category === e.category && (prev.date || '').startsWith(ym) ? prev.amount : 0);
  pushes.budgetNotes = pushes.budgetNotes || {};
  for (const pct of [80, 100]) {
    const line = cap * pct / 100, key = `${e.groupId}|${e.category}|${ym}|${pct}`;
    if (total < line || wasTotal >= line || pushes.budgetNotes[key]) continue;
    pushes.budgetNotes[key] = Date.now(); savePushes();
    const label = catLabel(e.category);
    await notify(activeMembers(e.groupId), { title: pct >= 100 ? `${label} budget is used up` : `${label} budget at ${pct}%`,
      body: `${g.name}: ${cad(total)} of ${cad(cap)} this month${pct >= 100 ? '. Over by ' + cad(total - cap) + '.' : '.'}`, tag: `budget-${e.groupId}-${e.category}-${ym}` });
  }
  // tidy old notes
  for (const k of Object.keys(pushes.budgetNotes)) if (Date.now() - pushes.budgetNotes[k] > 70 * 864e5) delete pushes.budgetNotes[k];
}
const CAT_LABELS = { groceries: 'Groceries', rent: 'Rent', utilities: 'Utilities', internet: 'Internet', household: 'Household', food: 'Food out', drinks: 'Drinks', transport: 'Transport', travel: 'Travel', tickets: 'Tickets', gift: 'Gift', fun: 'Fun', other: 'Other' };
const catLabel = c => CAT_LABELS[c] || 'Other';

// ---------- bills: post them even when nobody opens the app ----------
// Same split rules and ids as the page (r_<bill>_<period>), so whichever runs first wins and the other skips it.
// A bill repeats every month (the default), every week or every year.
const hash = str => { let h = 2166136261; for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function splitEqual(amount, ids, seed) {
  ids = [...new Set(ids)]; const n = ids.length; if (!n || amount <= 0) return {};
  const base = Math.floor(amount / n), rem = amount - base * n, out = {}, start = hash(seed || '') % n;
  ids.forEach(id => out[id] = base);
  for (let k = 0; k < rem; k++) out[ids[(start + k) % n]]++;
  return out;
}
function splitShares(amount, shares, seed) {
  const ids = Object.keys(shares || {}).filter(id => shares[id] > 0);
  const W = ids.reduce((t, id) => t + shares[id], 0); if (!W || amount <= 0) return {};
  const raw = ids.map(id => ({ id, v: amount * shares[id] / W })), out = {}; let used = 0;
  raw.forEach(r => { out[r.id] = Math.floor(r.v); used += out[r.id]; });
  raw.sort((a, b) => ((b.v % 1) - (a.v % 1)) || (hash(a.id + seed) - hash(b.id + seed))).slice(0, amount - used).forEach(r => out[r.id]++);
  return out;
}
function itemsSplit(amount, input, seed) {
  const sub = {}; let itemsTotal = 0;
  (input?.items || []).forEach((it, i) => { if (!it.p || !it.ids?.length) return; itemsTotal += it.p; for (const [k, v] of Object.entries(splitEqual(it.p, it.ids, seed + '#' + i))) sub[k] = (sub[k] || 0) + v; });
  const extra = Math.max(0, amount - itemsTotal), add = splitShares(extra, sub, seed + 'x'), out = { ...sub };
  for (const [k, v] of Object.entries(add)) out[k] = (out[k] || 0) + v;
  return out;
}
function computeSplit(amount, mode, input, seed) {
  if (mode === 'items') return itemsSplit(amount, input, seed);
  if (mode === 'pct') return splitShares(amount, input?.pct, seed);
  if (mode === 'shares') return splitShares(amount, input?.shares, seed);
  if (mode === 'exact') { const o = {}; for (const [k, v] of Object.entries(input?.exact || {})) if (v > 0) o[k] = v; return o; }
  return splitEqual(amount, input?.ids || [], seed);
}
function billMode(r) {   // older bills stored mode/weights/exact instead of splitMode/splitInput
  if (r.splitMode) return [r.splitMode, r.splitInput];
  if (r.mode === 'exact' && r.exact) return ['exact', { exact: { ...r.exact } }];
  if (r.mode === 'shares') return ['shares', { shares: { ...(r.weights || {}) } }];
  return ['equal', { ids: Object.keys(r.weights || {}) }];
}
const ymd = localDay;   // a date's day in the TZ time zone (pad2 and localDay are up with the settings)
const nextYm = ym => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return y + '-' + pad2(m); };
const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// The periods of a bill, oldest first: each is { key, date } where key goes in the expense id.
function billFirstKey(r) {
  if (r.every === 'week') return r.startDate || null;
  if (r.every === 'year') return r.startMonth ? r.startMonth.slice(0, 4) : null;
  return r.startMonth || null;
}
function billNextKey(r, key) {
  if (r.every === 'week') return addDays(key, 7);
  if (r.every === 'year') return String(+key + 1);
  return nextYm(key);
}
function billDate(r, key) {
  if (r.every === 'week') return key;
  if (r.every === 'year') { const ym = `${key}-${pad2(r.month || 1)}`; return `${ym}-${pad2(Math.min(r.day || 1, daysIn(ym)))}`; }
  return `${key}-${pad2(Math.min(r.day || 1, daysIn(key)))}`;
}
function postDueBills() {
  const today = localDay(), changed = [];
  for (const [k, r] of Object.entries(db.docs)) {
    const s = segs(k);
    if (s[0] !== 'recurring' || s.length !== 2 || !r || r.paused || !r.groupId || !r.paidBy) continue;
    const rid = s[1], [mode, input] = billMode(r);
    let key = r.lastPosted ? billNextKey(r, r.lastPosted) : billFirstKey(r), last = null, n = 0;
    if (!key) continue;
    while (n < 6) {
      const date = billDate(r, key);
      if (date > today) break;
      const id = 'r_' + rid + '_' + key, p = 'expenses/' + id;
      const base = { kind: 'expense', groupId: r.groupId, title: r.title, paidBy: r.paidBy, category: r.category, date,
        splitMode: mode, splitInput: input, createdAt: Date.now(), recurringId: rid };
      if (db.docs[p] == null) {
        if (r.variable) db.docs[p] = { ...base, amount: 0, split: {}, people: [r.paidBy], status: 'needs_amount' };
        else {
          const split = computeSplit(r.amount, mode, input, rid + key);
          if (!Object.keys(split).length) break;
          db.docs[p] = { ...base, amount: r.amount, split, people: [...new Set([r.paidBy, ...Object.keys(split)])] };
        }
        changed.push(p);
      }
      last = key; key = billNextKey(r, key); n++;
    }
    if (last) { db.docs[k] = { ...r, lastPosted: last }; changed.push(k); }
  }
  if (changed.length) { saveDb(); broadcast(changed); }
}
// Is this bill due on that day?
function billDueOn(r, d) {
  const s = ymd(d);
  if (r.every === 'week') return !!r.startDate && s >= r.startDate && d.getDay() === new Date(r.startDate + 'T12:00:00').getDay();
  if (r.every === 'year') return (!r.startMonth || r.startMonth.slice(0, 4) <= String(d.getFullYear())) && billDate(r, String(d.getFullYear())) === s;
  const ym = s.slice(0, 7);
  return (!r.startMonth || r.startMonth <= ym) && billDate(r, ym) === s;
}
// Once a day after REMIND_HOUR: bills due today or tomorrow, chores due today, and the monthly extras.
let lastBillRun = null;
async function billReminders() {
  try { postDueBills(); lastBillRun = Date.now(); } catch (e) { console.error(e); }
  const now = new Date(), today = ymd(now);
  if (now.getHours() < REMIND_HOUR || pushes.remindedOn === today) return;
  pushes.remindedOn = today; savePushes();
  for (const [k, r] of Object.entries(db.docs)) {
    const s = segs(k);
    if (s[0] !== 'recurring' || s.length !== 2 || !r || r.paused || !r.groupId) continue;
    for (const [when, d] of [['today', now], ['tomorrow', new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)]]) {
      if (!billDueOn(r, d)) continue;
      const g = db.docs['groups/' + r.groupId], members = activeMembers(r.groupId);
      const needsAmount = r.variable && !r.amount;
      const body = needsAmount ? `${g?.name || 'Your group'}: someone needs to enter this ${r.every === 'week' ? 'week' : r.every === 'year' ? 'year' : 'month'}’s amount.`
        : `${cad(r.amount)} for ${g?.name || 'your group'}. ${r.paidBy ? nameFor(r.paidBy) + ' pays this one.' : ''}`.trim();
      await notify(members, { title: `${r.title || 'A bill'} is due ${when}`, body, tag: 'bill-' + s[1] + '-' + ymd(d) });
    }
  }
  await choreReminders(today);
  if (now.getDate() === 1) await monthlySummaries(now);
  if (now.getDate() === 1 || now.getDate() === 15) await owedReminders();
}

// Chores due today: tell whoever's turn it is.
async function choreReminders(today) {
  for (const [k, c] of Object.entries(db.docs)) {
    const s = segs(k);
    if (s[0] !== 'chores' || s.length !== 2 || !c || c.due !== today || !Array.isArray(c.order) || !c.order.length) continue;
    const who = c.order[(c.turn || 0) % c.order.length];
    if (!users.users[who]) continue;
    const g = db.docs['groups/' + c.groupId];
    await notify([who], { title: `Your turn: ${c.title || 'a chore'}`, body: `Due today${g?.name ? ' for ' + g.name : ''}. Tap Done in Split it when it’s finished.`, tag: 'chore-' + s[1] });
  }
}

// ---------- balances (same rules as the page) ----------
const sharedEntries = () => Object.entries(db.docs)
  .filter(([k, e]) => { const s = segs(k); return s[0] === 'expenses' && s.length === 2 && e && !e.deletedAt && e.status !== 'needs_amount'; })
  .map(([, e]) => e);
function netOf(list) {
  const net = {};
  for (const e of list) {
    if (e.kind === 'payment') { if (e.confirmed === false) continue; net[e.from] = (net[e.from] || 0) + e.amount; net[e.to] = (net[e.to] || 0) - e.amount; continue; }
    net[e.paidBy] = (net[e.paidBy] || 0) + e.amount;
    for (const [id, c] of Object.entries(e.split || {})) net[id] = (net[id] || 0) - c;
  }
  return net;
}
function pairwiseOf(list) {
  const owe = {};
  const add = (a, b, c) => { if (a === b || !c) return; const k = a < b ? a + '|' + b : b + '|' + a, sg = a < b ? 1 : -1; owe[k] = (owe[k] || 0) + sg * c; };
  for (const e of list) {
    if (e.kind === 'payment') { if (e.confirmed !== false) add(e.to, e.from, e.amount); continue; }
    for (const [id, c] of Object.entries(e.split || {})) add(id, e.paidBy, c);
  }
  const plan = [];
  for (const [k, v] of Object.entries(owe)) { if (!v) continue; const [a, b] = k.split('|'); plan.push(v > 0 ? { from: a, to: b, amount: v } : { from: b, to: a, amount: -v }); }
  return plan;
}
function simplified(net) {
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(net)) { if (v > 0) cred.push({ id, v }); else if (v < 0) debt.push({ id, v: -v }); }
  cred.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id)); debt.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));
  const plan = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i].v, cred[j].v);
    if (amt > 0) plan.push({ from: debt[i].id, to: cred[j].id, amount: amt });
    debt[i].v -= amt; cred[j].v -= amt; if (!debt[i].v) i++; if (!cred[j].v) j++;
  }
  return plan;
}
// Who owes whom across all groups and one-on-one expenses: { "debtor|creditor": cents }
function allDebts() {
  const list = sharedEntries(), byGroup = {}, direct = [], debts = {};
  for (const e of list) (e.groupId ? (byGroup[e.groupId] = byGroup[e.groupId] || []) : direct).push(e);
  const addPlan = plan => { for (const p of plan) { const k = p.from + '|' + p.to, r = p.to + '|' + p.from;
    if (debts[r]) { const m = Math.min(debts[r], p.amount); debts[r] -= m; p.amount -= m; if (!debts[r]) delete debts[r]; }
    if (p.amount) debts[k] = (debts[k] || 0) + p.amount; } };
  for (const [gid, l] of Object.entries(byGroup)) addPlan(db.docs['groups/' + gid]?.simplify === false ? pairwiseOf(l) : simplified(netOf(l)));
  addPlan(pairwiseOf(direct));
  return debts;
}

// On the 1st: last month's share and where you stand now.
async function monthlySummaries(now) {
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1), ym = `${last.getFullYear()}-${pad2(last.getMonth() + 1)}`;
  const monthName = last.toLocaleDateString('en-CA', { month: 'long' });
  const list = sharedEntries(), net = netOf(list);
  for (const uid of Object.keys(pushes.subs)) {
    if (!users.users[uid] || !pushes.subs[uid].length) continue;
    const share = list.filter(e => e.kind !== 'payment' && (e.date || '').startsWith(ym)).reduce((t, e) => t + ((e.split || {})[uid] || 0), 0);
    const v = net[uid] || 0;
    if (!share && !v) continue;
    const stand = v > 0 ? `You’re owed ${cad(v)} overall.` : v < 0 ? `You owe ${cad(-v)} overall.` : 'You’re all square.';
    await notify([uid], { title: `Your ${monthName} in Split it`, body: `Your share was ${cad(share)}. ${stand}`, tag: 'summary-' + ym });
  }
}

// On the 1st and 15th: a friendly nudge to anyone who owes $5+ to someone who has reminders on.
async function owedReminders() {
  const per = {}, pending = {};
  // a payment still waiting for the other person to confirm counts as paid here, so nobody gets nagged for it
  for (const e of sharedEntries()) if (e.kind === 'payment' && e.confirmed === false) pending[e.from + '|' + e.to] = (pending[e.from + '|' + e.to] || 0) + e.amount;
  for (const [k, owed] of Object.entries(allDebts())) {
    const [from, to] = k.split('|'), amt = owed - (pending[k] || 0);
    if (amt < 500 || !users.users[from] || !users.users[to] || db.docs['people/' + to]?.autoRemind === false) continue;
    (per[from] = per[from] || []).push({ to, amt });
  }
  for (const [from, list] of Object.entries(per)) {
    list.sort((a, b) => b.amt - a.amt);
    const parts = list.map(x => `${nameFor(x.to)} ${cad(x.amt)}`);
    const body = 'You owe ' + (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]) + '. Settle up in Split it when you can.';
    await notify([from], { title: 'Friendly reminder', body, tag: 'owed' });
  }
}

// ---------- calendar feed (.ics): bills and chores for the phone's calendar app ----------
function icsFor(uid) {
  const groups = Object.entries(db.docs).filter(([k]) => segs(k)[0] === 'groups' && segs(k).length === 2).map(([k, g]) => ({ id: segs(k)[1], ...g }))
    .filter(g => !g.archived && activeMembers(g.id).includes(uid));
  const gid = new Set(groups.map(g => g.id)), gname = id => groups.find(g => g.id === id)?.name || 'Split it';
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
  const ev = (id, date, title, desc) => { const d = date.replace(/-/g, ''); const next = addDays(date, 1).replace(/-/g, '');
    return `BEGIN:VEVENT\r\nUID:${id}@split-it\r\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z\r\nDTSTART;VALUE=DATE:${d}\r\nDTEND;VALUE=DATE:${next}\r\nSUMMARY:${esc(title)}\r\nDESCRIPTION:${esc(desc)}\r\nEND:VEVENT\r\n`; };
  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Budget it//Split it//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Split it\r\nREFRESH-INTERVAL;VALUE=DURATION:PT12H\r\n';
  const today = localDay();
  for (const [k, r] of Object.entries(db.docs)) {
    const s = segs(k);
    if (s[0] !== 'recurring' || s.length !== 2 || !r || r.paused || !gid.has(r.groupId)) continue;
    let key = r.lastPosted ? billNextKey(r, r.lastPosted) : billFirstKey(r); if (!key) continue;
    for (let n = 0; n < 12; n++) { const date = billDate(r, key);
      if (date >= today) out += ev(`${s[1]}-${key}`, date, `${r.title || 'Bill'}${r.variable ? '' : ' ' + cad(r.amount)}`, `${gname(r.groupId)}. ${r.paidBy ? nameFor(r.paidBy) + ' pays it.' : ''}`);
      key = billNextKey(r, key); }
  }
  for (const [k, c] of Object.entries(db.docs)) {
    const s = segs(k);
    if (s[0] !== 'chores' || s.length !== 2 || !c || !c.due || !gid.has(c.groupId) || !Array.isArray(c.order) || !c.order.length) continue;
    let due = c.due, turn = c.turn || 0;
    for (let n = 0; n < 8; n++) { const who = c.order[turn % c.order.length];
      if (due >= today) out += ev(`${s[1]}-${due}`, due, `${c.title}: ${who === uid ? 'your turn' : nameFor(who)}`, gname(c.groupId));
      due = c.every === 30 ? (() => { const d = new Date(due + 'T12:00:00'); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, daysIn(ymd(d).slice(0, 7)))); return ymd(d); })() : addDays(due, c.every || 7);
      turn++; }
  }
  return out + 'END:VCALENDAR\r\n';
}

// ---------- http ----------
const gzOk = req => /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '');
const compressible = type => /json|text|javascript|xml|svg|calendar|manifest/.test(type);
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://api.frankfurter.app https://api.frankfurter.dev; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://accounts.google.com"
};
// One place that sends bytes: gzip when the phone accepts it, plus the security headers.
function out(res, code, headers, body) {
  const req = res.req, h = { ...SECURITY, ...headers };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  if (buf.length > 800 && compressible(h['Content-Type'] || '') && gzOk(req)) { buf = zlib.gzipSync(buf, { level: 6 }); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(req && req.method === 'HEAD' ? undefined : buf);
}
const send = (res, code, body, type = 'application/json') =>
  out(res, code, { 'Content-Type': type, 'Cache-Control': 'no-store' }, typeof body === 'string' ? body : JSON.stringify(body));
const readBody = req => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 2e6) { rej(new Error('too big')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { rej(e); } });
});
const readRaw = (req, limit) => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { rej(new Error('too big')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks)));
});
// A request body written straight to a file (backups to restore can be hundreds of MB).
const receiveToFile = (req, file, limit) => new Promise((res, rej) => {
  let n = 0, done = false; const ws = fs.createWriteStream(file, { mode: 0o600 });
  const fail = e => { if (done) return; done = true; ws.destroy(); req.resume(); rej(e); };
  ws.on('error', fail); req.on('error', fail);
  req.on('data', c => { if (done) return; n += c.length;
    if (n > limit) return fail(Object.assign(new Error('That file is too big to send through the website. Use  node server.js restore FILE  on the laptop.'), { tooBig: true }));
    if (!ws.write(c)) { req.pause(); ws.once('drain', () => req.resume()); } });
  req.on('end', () => { if (done) return; ws.end(); ws.on('close', () => { if (!done) { done = true; res(n); } }); });
});
// Files from public/, cached in memory and sent with an ETag so a phone that already has them gets a tiny 304.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const fileCache = new Map();
function staticFile(name) {
  const fp = path.join(PUBLIC, name);
  if (!fp.startsWith(PUBLIC + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return null;
  const mtime = fs.statSync(fp).mtimeMs, hit = fileCache.get(name);
  if (hit && hit.mtime === mtime) return hit;
  const data = fs.readFileSync(fp), etag = '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20) + '"';
  const entry = { data, etag, mtime, type: TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream' };
  fileCache.set(name, entry); return entry;
}
function file(res, name, type, cache) {
  const f = staticFile(name); if (!f) return send(res, 404, { error: 'not found' });
  const h = { 'Content-Type': type || f.type, 'Cache-Control': cache || 'no-cache', ETag: f.etag };
  if (res.req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ...SECURITY, ETag: f.etag, 'Cache-Control': h['Cache-Control'] }); return res.end(); }
  out(res, 200, h, f.data);
}
// Files anyone can fetch without signing in: what the phone needs to install the app, and the guide art for the sign-in pages.
const PUBLIC_FILES = new Set(['/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/offline.html']);
const photoCount = new Map();   // uid|day -> uploads today

const isOwner = uid => !!users.users[uid]?.owner;
async function handle(req, res) {
  // Laptop commands (node server.js set-password NAME ...) reach the running app here. Only from this computer,
  // never through a tunnel or proxy, and only with the secret from data/server.lock.
  if (req.url === '/api/local/cli') {
    const tok = Buffer.from(String(req.headers['x-local-token'] || '')), want = Buffer.from(localToken || '');
    const direct = isLocal(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
    if (req.method !== 'POST' || !direct || !want.length || tok.length !== want.length || !crypto.timingSafeEqual(tok, want)) return send(res, 404, { error: 'not found' });
    return send(res, 200, localCommand(await readBody(req)));
  }
  if (await mcp.handle(req, res)) return;   // AI assistant connector (mcp.js)
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const uid = sessionUid(req);

  if (PUBLIC_FILES.has(p)) return file(res, p.slice(1), null, p === '/sw.js' ? 'no-cache' : 'public, max-age=86400');
  if (/^\/art\/[a-z0-9-]+\.(webp|png)$/.test(p)) return file(res, p.slice(1), null, 'public, max-age=604800');
  const cal = p.match(/^\/cal\/([A-Za-z0-9_-]{20,})\.ics$/);
  if (cal) {
    const who = Object.entries(users.users).find(([, u]) => u.calToken === cal[1]);
    if (!who) return send(res, 404, 'Not found', 'text/plain');
    return out(res, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=3600' }, icsFor(who[0]));
  }
  if (p === '/login' && req.method === 'GET') return file(res, 'login.html');
  if (p === '/api/login' && req.method === 'POST') {
    const { name, password } = await readBody(req);
    const found = findUser(name || '');
    const wait = tooManyTries(req, found && found[0]); if (wait) return send(res, 429, { error: wait });
    if (!found || !checkPw(String(password || ''), found[1])) {
      noteMiss(req, found && found[0]);
      return send(res, 401, { error: 'That name and password don’t match.' });
    }
    misses.delete(clientIp(req));
    // a sign-in code is on for this person: the password was step one, the code is step two (accounts.js)
    if (accounts.needsCode(found[0])) return send(res, 200, { need: 'code', ticket: accounts.codeTicket(found[0]) });
    const token = crypto.randomBytes(32).toString('hex');
    for (const [t, s] of Object.entries(users.sessions)) if (s.exp < Date.now()) delete users.sessions[t];
    users.sessions[token] = { uid: found[0], exp: Date.now() + SESSION_DAYS * 864e5 };
    saveUsers();
    setCookie(req, res, token, SESSION_DAYS * 86400);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/logout') {
    const t = cookies(req).hs; if (t) { delete users.sessions[t]; saveUsers(); }
    setCookie(req, res, '', 0);
    res.writeHead(302, { Location: '/login' }); return res.end();
  }

  if (await accounts(req, res, url, uid)) return;   // invites, email, Google, password reset (accounts.js)

  if (!uid) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'signed out' });
    res.writeHead(302, { Location: '/login' }); return res.end();
  }
  const me = users.users[uid];
  if (!me.lastSeen || Date.now() - me.lastSeen > 3600e3) { me.lastSeen = Date.now(); try { saveUsers(); } catch {} }   // a full disk mustn't stop reading

  if (p === '/' || p === '/index.html') return file(res, 'index.html', null, 'private, no-cache');
  if (p === '/shim.js') return file(res, 'shim.js', null, 'private, no-cache');

  // ---------- receipt photos ----------
  if (p === '/api/photo' && req.method === 'POST') {
    if (!/^image\/jpeg/.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'jpeg only' });
    const key = uid + '|' + localDay(), n = photoCount.get(key) || 0;
    if (n >= PHOTOS_PER_DAY) return send(res, 429, { error: `That’s ${PHOTOS_PER_DAY} photos today. Try again tomorrow.` });
    const buf = await readRaw(req, 6e6);
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'not a jpeg' });
    const id = crypto.randomBytes(12).toString('hex');
    try { fs.writeFileSync(path.join(PHOTO_DIR, id + '.jpg'), buf); }
    catch (e) { try { fs.unlinkSync(path.join(PHOTO_DIR, id + '.jpg')); } catch {} return send(res, 507, { error: diskMessage(e) }); }
    photoCount.set(key, n + 1); if (photoCount.size > 500) photoCount.clear();
    return send(res, 200, { id });
  }
  const ph = p.match(/^\/api\/photo\/([a-f0-9]{24})$/);
  if (ph) {
    const f = path.join(PHOTO_DIR, ph[1] + '.jpg');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    return out(res, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' }, fs.readFileSync(f));
  }

  // ---------- phone notifications ----------
  if (p === '/api/push/key') return send(res, 200, { key: pushKeys.publicKey });
  if (p === '/api/push/who') return send(res, 200, { uids: Object.keys(pushes.subs).filter(id => pushes.subs[id].length) });
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const sub = await readBody(req);
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth)
      return send(res, 400, { error: 'bad subscription' });
    for (const id in pushes.subs) pushes.subs[id] = pushes.subs[id].filter(s => s.endpoint !== sub.endpoint);
    (pushes.subs[uid] = pushes.subs[uid] || []).push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    savePushes();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const { endpoint } = await readBody(req);
    if (pushes.subs[uid]) { pushes.subs[uid] = pushes.subs[uid].filter(s => s.endpoint !== endpoint); savePushes(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const n = await notify([uid], { title: 'Split it', body: 'Notifications are on. You’ll hear about bills, new expenses and payments here.', tag: 'test' });
    return send(res, 200, { sent: n });
  }
  if (p === '/api/push/nudge' && req.method === 'POST') {
    const { to, amount } = await readBody(req);
    if (!users.users[to] || to === uid || !(amount > 0)) return send(res, 400, { error: 'bad nudge' });
    const k = uid + '>' + to, last = nudges.get(k) || 0;
    if (Date.now() - last < 6 * 3600e3) return send(res, 429, { error: 'You already sent a reminder recently.' });
    nudges.set(k, Date.now());
    const n = await notify([to], { title: `${nameFor(uid)} sent a reminder`, body: `You owe ${nameFor(uid)} ${cad(amount)} on Split it.`, tag: 'nudge-' + uid });
    return send(res, 200, { sent: n });
  }

  // ---------- your own AI assistants: the link, keys you make, and disconnecting them (see mcp.js) ----------
  if (p === '/api/assistants' && req.method === 'GET') return send(res, 200, { url: mcp.address(req), list: mcp.mine(uid) });
  if (p === '/api/assistants/key' && req.method === 'POST') {
    const { name } = await readBody(req);
    try { return send(res, 200, { key: mcp.makeKey(uid, name), url: mcp.address(req) }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/assistants/remove' && req.method === 'POST') {
    const { id } = await readBody(req);
    if (typeof id !== 'string' || !id) return send(res, 400, { error: 'Pick an assistant.' });
    return send(res, 200, { ok: true, removed: mcp.removeMine(uid, id) });
  }
  // ---------- calendar subscription ----------
  if (p === '/api/calendar' && req.method === 'POST') {
    if (!me.calToken) { me.calToken = crypto.randomBytes(24).toString('base64url'); saveUsers(); }
    return send(res, 200, { url: `${accounts.base(req)}/cal/${me.calToken}.ics` });
  }
  if (p === '/api/calendar.ics') return out(res, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="split-it.ics"', 'Cache-Control': 'no-store' }, icsFor(uid));

  // ---------- running it: the owner's admin tools ----------
  if (p.startsWith('/api/admin/')) {
    if (!isOwner(uid)) return send(res, 403, { error: 'Only the owner can do that.' });
    if (p === '/api/admin/overview') {
      flushDb();
      const pushOn = id => (pushes.subs[id] || []).length;
      const sessions = {}; for (const s of Object.values(users.sessions)) if (s.exp > Date.now()) sessions[s.uid] = (sessions[s.uid] || 0) + 1;
      const people = Object.entries(users.users).map(([id, u]) => ({ id, name: u.name, nickname: db.docs['people/' + id]?.nickname || null, owner: !!u.owner, email: u.emailVerified ? u.email : null,
        hasPassword: !!u.hash, google: !!u.google, code: accounts.needsCode(id), createdAt: u.createdAt || null, lastSeen: u.lastSeen || null, push: pushOn(id), sessions: sessions[id] || 0, mcp: mcp.connected(id) }));
      let photos = 0, photoBytes = 0; for (const f of fs.readdirSync(PHOTO_DIR)) { try { photoBytes += fs.statSync(path.join(PHOTO_DIR, f)).size; photos++; } catch {} }
      const disk = diskUse();
      const invites = Object.values(users.invites || {}).filter(v => !v.used && v.exp > Date.now()).length;
      return send(res, 200, { people, backups: backupList().slice(0, 40), invites, alerts: ownerAlerts(),
        health: { version: VERSION, node: process.version, uptime: Date.now() - STARTED, dbBytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0, docs: Object.keys(db.docs).length,
          photos, photoBytes, disk, lastBillRun, lastBackupAt, backupError: backupState.error, remindHour: REMIND_HOUR, copyDir: BACKUP_COPY_DIR, copyAt: copyState.at, copyError: copyState.error, copyLocked: !!BACKUP_PASSPHRASE,
          timeZone: serverZone(), tzSet: !!process.env.TZ, serverTime: localStamp(), publicUrl: process.env.PUBLIC_URL || null, email: !!process.env.RESEND_API_KEY, google: !!process.env.GOOGLE_CLIENT_ID, listeners: listeners.size, dataDir: DATA_DIR } });
    }
    if (p === '/api/admin/reset-link' && req.method === 'POST') {
      const { id } = await readBody(req); if (!users.users[id]) return send(res, 404, { error: 'No such person.' });
      return send(res, 200, { url: accounts.resetLink(req, id), name: users.users[id].name });
    }
    if (p === '/api/admin/remove' && req.method === 'POST') {
      const { id } = await readBody(req); if (!users.users[id]) return send(res, 404, { error: 'No such person.' });
      if (id === uid) return send(res, 400, { error: 'You can’t remove yourself. Make someone else the owner first.' });
      const r = removeUser(id);
      return send(res, 200, { ok: true, ...r });
    }
    if (p === '/api/admin/owner' && req.method === 'POST') {
      const { id, owner } = await readBody(req); if (!users.users[id]) return send(res, 404, { error: 'No such person.' });
      if (!owner && users.users[id].owner && Object.values(users.users).filter(x => x.owner).length === 1) return send(res, 400, { error: 'Split it needs at least one owner.' });
      users.users[id].owner = !!owner; saveUsers();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/rename' && req.method === 'POST') {
      const { id, name } = await readBody(req); const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (!users.users[id] || !n) return send(res, 400, { error: 'Give a name.' });
      const taken = findUser(n); if (taken && taken[0] !== id) return send(res, 400, { error: 'Someone already has that name.' });
      users.users[id].name = n; saveUsers();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/signout' && req.method === 'POST') {
      const { id } = await readBody(req);
      return send(res, 200, { ok: true, sessions: endSessions(id, { assistants: true }) });
    }
    if (p === '/api/admin/code-off' && req.method === 'POST') {   // someone lost the phone with their authenticator app
      const { id } = await readBody(req); if (!users.users[id]) return send(res, 404, { error: 'No such person.' });
      return send(res, 200, { ok: true, was: accounts.codeOff(id) });
    }
    if (p === '/api/admin/copy-now' && req.method === 'POST') {
      if (!BACKUP_COPY_DIR) return send(res, 400, { error: 'No second backup place is set. Add BACKUP_COPY_DIR to split-it.env and restart.' });
      const st = copyOut(true);
      return st.error ? send(res, 500, { error: st.error }) : send(res, 200, { ok: true, at: st.at });
    }
    if (p === '/api/admin/update') return send(res, 200, await latestRelease());
    if (p === '/api/admin/alerts' && req.method === 'GET') return send(res, 200, { alerts: ownerAlerts() });
    if (p === '/api/admin/alerts/dismiss' && req.method === 'POST') { recovered = []; try { fs.unlinkSync(RECOVERED_FILE); } catch {} return send(res, 200, { ok: true }); }
    if (p === '/api/admin/backup' && (req.method === 'GET' || req.method === 'POST')) {
      // GET ?lock=1 locks it with BACKUP_PASSPHRASE; POST {passphrase} locks it with one typed in. Written to disk, then sent.
      let pass = '';
      if (req.method === 'POST') { const { passphrase } = await readBody(req); pass = String(passphrase || ''); if (pass.length < 8) return send(res, 400, { error: 'Use at least 8 characters for the passphrase.' }); }
      else if (url.searchParams.get('lock') === '1') { if (!BACKUP_PASSPHRASE) return send(res, 400, { error: 'No BACKUP_PASSPHRASE is set.' }); pass = BACKUP_PASSPHRASE; }
      const tmp = workFile('download');
      try { writeBackup(tmp, { pass }); } catch (e) { return send(res, e.storage && /^E(NOSPC|DQUOT|ROFS|IO)$/.test(e.code || '') ? 507 : 500, { error: e.storage ? e.storageMessage : e.message }); }
      res.writeHead(200, { ...SECURITY, 'Content-Type': pass ? 'application/octet-stream' : 'application/zip', 'Content-Length': fs.statSync(tmp).size,
        'Content-Disposition': `attachment; filename="split-it-backup-${localDay()}.${pass ? 'locked' : 'zip'}"`, 'Cache-Control': 'no-store' });
      const rs = fs.createReadStream(tmp), gone = () => fs.rm(tmp, { force: true }, () => {});
      rs.on('error', () => res.destroy()); res.on('close', gone); rs.pipe(res);
      return;
    }
    const bk = p.match(/^\/api\/admin\/backup\/(db(?:-weekly)?-\d{4}-\d\d-\d\d(?:-\d{4})?\.json)$/);
    if (bk) { const fp = path.join(BACKUP_DIR, bk[1]); if (!fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
      return out(res, 200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${bk[1]}"`, 'Cache-Control': 'no-store' }, fs.readFileSync(fp)); }
    if (p === '/api/admin/restore' && req.method === 'POST') {
      // The upload goes to a work file as it arrives, then restoreFile checks all of it before anything is replaced.
      let pass = ''; try { pass = decodeURIComponent(String(req.headers['x-backup-passphrase'] || '')); } catch {}
      const tmp = workFile('upload');
      try {
        try { await receiveToFile(req, tmp, 400e6); } catch (e) { return send(res, e.tooBig ? 413 : 507, { error: e.tooBig ? e.message : diskMessage(e) }); }
        const r = restoreFile(tmp, pass);
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        if (e.locked) return send(res, 401, { error: e.message, locked: true });
        if (e.storage || /^E(NOSPC|DQUOT|ROFS|IO)$/.test(e.code || '')) return send(res, 507, { error: diskMessage(e) });
        return send(res, 400, { error: e.message || 'Couldn’t restore that.' });
      } finally { fs.rm(tmp, { force: true }, () => {}); }
    }
    if (p === '/api/admin/test-push' && req.method === 'POST') { const n = await notify(Object.keys(users.users), { title: 'Split it check', body: `${nameFor(uid)} is checking that notifications work.`, tag: 'admin-test' }); return send(res, 200, { sent: n }); }
    return send(res, 404, { error: 'not found' });
  }

  if (p === '/api/me') return send(res, 200, { uid, name: me.name, isOwner: !!me.owner, version: VERSION });
  if (p === '/api/profiles') {
    const outp = {};
    for (const id of (url.searchParams.get('ids') || '').split(',')) if (users.users[id]) outp[id] = { name: users.users[id].name };
    return send(res, 200, outp);
  }
  if (p === '/api/doc') {
    const dp = url.searchParams.get('path');
    if (!validPath(dp) || segs(dp).length % 2) return send(res, 400, { error: 'bad path' });
    if (!canRead(uid, dp)) return send(res, 403, { error: 'not allowed' });
    return send(res, 200, { data: db.docs[dp] ?? null });
  }
  if (p === '/api/col') {
    const cp = url.searchParams.get('path');
    if (!validPath(cp) || !(segs(cp).length % 2)) return send(res, 400, { error: 'bad path' });
    const cs = segs(cp);
    if (cs[0] === 'data' && !canRead(uid, cp + '/x')) return send(res, 403, { error: 'not allowed' });
    const prefix = cp + '/', docs = [];
    for (const [k, v] of Object.entries(db.docs))
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && canRead(uid, k)) docs.push({ id: k.slice(prefix.length), data: v });
    return send(res, 200, { docs });
  }
  if (p === '/api/write' && req.method === 'POST') {
    const { ops } = await readBody(req);
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) return send(res, 400, { error: 'bad ops' });
    const full = storageProblem(); if (full) return send(res, 507, { error: full });
    for (const o of ops) {
      if (!validPath(o.path) || segs(o.path).length % 2) return send(res, 400, { error: 'bad path' });
      if (o.op !== 'delete' && (typeof o.data !== 'object' || !o.data || Array.isArray(o.data))) return send(res, 400, { error: 'bad data' });
      if (o.op === 'update' && db.docs[o.path] == null) return send(res, 404, { error: 'not found: ' + o.path });
      const after = o.op === 'set' ? o.data : o.op === 'update' ? { ...db.docs[o.path], ...o.data } : undefined;
      if (!canWrite(uid, o.path, after)) return send(res, 403, { error: 'not allowed' });
      const wrong = entryProblem(uid, o.path, db.docs[o.path], after, new Set(ops.filter(x => x.op === 'set').map(x => x.path)));
      if (wrong) return send(res, 422, { error: wrong });
    }
    const before = Object.fromEntries(ops.map(o => [o.path, db.docs[o.path]]));
    for (const o of ops) {
      if (o.op === 'set') db.docs[o.path] = o.data;
      else if (o.op === 'update') db.docs[o.path] = { ...db.docs[o.path], ...o.data };
      else if (o.op === 'delete') delete db.docs[o.path];
    }
    if (!commitDb(ops.map(o => o.path))) {   // the disk refused it: put memory back as it was and say so
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete db.docs[k]; else db.docs[k] = v;
      return send(res, 507, { error: storageProblem() || diskMessage(null) });
    }
    broadcast(ops.map(o => o.path), null, before);
    send(res, 200, { ok: true });
    tellPeople(uid, ops, before).catch(e => console.error(e));
    if (ops.some(o => segs(o.path)[0] === 'recurring')) setImmediate(() => { try { postDueBills(); } catch (e) { console.error(e); } });   // a new bill due today shows up now
    return;
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`: hi\nevent: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
    listeners.set(res, uid); streamToken.set(res, cookies(req).hs || null);
    req.on('close', () => { listeners.delete(res); streamToken.delete(res); });
    return;
  }
  send(res, 404, { error: 'not found' });
}

const accounts = require('./accounts')({ appName: 'Split it', envFile: 'split-it.env', cookieName: 'hs', tagline: 'by Budget it',
  users: () => users, saveUsers, endSessions, docs: () => db.docs, saveDb, broadcast, hashPw, findUser,
  setCookie, cookies, clientIp, misses, noteMiss, tooManyTries, nameFor, readBody, send, file, secure, SESSION_DAYS });

// AI assistant connector (Muse, Claude...): see mcp.js
const mcp = require('./mcp')({ DATA_DIR, db: () => db, users: () => users, saveDb, broadcast, tellPeople, allDebts, sharedEntries, netOf,
  nameFor, cad, segs, secure, findUser, tooManyTries, checkLogin, noteMiss, computeSplit, billDate, billNextKey, billFirstKey, simplified, pairwiseOf, version: VERSION,
  needsCode: uid => accounts.needsCode(uid), checkCode: (uid, code) => accounts.checkCode(uid, code) });

// The split engine and balance rules, for the tests (node --test test/*.test.js).
module.exports = { splitEqual, splitShares, itemsSplit, computeSplit, netOf, pairwiseOf, simplified, billDate, billNextKey, billFirstKey, billDueOn, zipWrite, zipRead, crc32, newerThan, lockBuf, lockSession, unlockBuf, isLocked, dataProblem, localDay };

if (require.main === module) {
  if (process.argv[2]) {
    cli(process.argv.slice(2));
  } else {
    if (!Object.keys(users.users).length) console.log('No users yet. Add one with: node server.js add-user YOURNAME');
    if (+process.versions.node.split('.')[0] < 22) console.log(`Heads-up: this is Node ${process.version}. Split it is tested on Node 22 and 24; older ones no longer get security fixes.`);
    claimLock(); process.on('exit', dropLock);
    for (const f of fs.readdirSync(WORK_DIR)) fs.rm(path.join(WORK_DIR, f), { force: true }, () => {});   // left by a crash
    if (process.env.TZ === undefined && serverZone() === 'UTC') console.log('Heads-up: the clock here is on UTC. Set TZ (for example TZ=America/Toronto) so reminders and "today" follow your time.');
    backup(true); setInterval(() => backup(false), 60 * 60e3);   // a copy at every start, then every 6 hours
    setInterval(() => billReminders().catch(e => console.error(e)), 10 * 60e3); setTimeout(() => billReminders().catch(e => console.error(e)), 5000);
    setInterval(() => { for (const res of listeners.keys()) res.write(': ping\n\n'); }, 25000);
    http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) e && e.storage ? send(res, 507, { error: e.storageMessage }) : send(res, 500, { error: 'server error' }); }))
      .listen(PORT, HOST, () => console.log(`Split it ${VERSION} running at http://${HOST}:${PORT}`));
  }
}
