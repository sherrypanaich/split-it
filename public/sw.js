// Split it service worker: lets phones install the app, keeps a copy of the app and the
// latest data so it opens away from wifi, and shows notifications.
// The data copy belongs to one person: it lives in a cache named after them, and a different person
// signing in on the same phone (or anyone signing out) clears it, so nobody sees someone else's numbers offline.
const SHELL = 'split-it-shell-v4', DATA_PREFIX = 'split-it-data-v4-', WHO_KEY = '/__split-it-who';
const PRECACHE = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/shim.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE).catch(() => {}))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL && !k.startsWith(DATA_PREFIX)) await caches.delete(k);
  await self.clients.claim();
})()));

// If the laptop can't be reached and nothing is saved yet, show a friendly page instead of a browser error.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Split it</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F1E8;color:#14112A;font:16px system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:2.2rem;font-weight:800">Can’t reach Split it</div>
<p>Check your internet, or the laptop at home might be off or asleep.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:700;padding:12px 20px;border:2.5px solid #14112A;border-radius:12px;background:#FFD23F;box-shadow:3px 3px 0 #14112A">Try again</button></div>`;

const cacheable = r => r && r.ok && !r.redirected && r.type === 'basic';
const fromCache = r => { if (!r) return r; const h = new Headers(r.headers); h.set('X-From-Cache', '1'); return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h }); };
// Network first, remember the answer, fall back to the remembered one.
async function networkFirst(req, cacheName, key) {
  const c = await caches.open(cacheName);
  try { const r = await fetch(req); if (cacheable(r)) c.put(key || req, r.clone()); return r; }
  catch (e) { const hit = await c.match(key || req); if (hit) return fromCache(hit); throw e; }
}
// Serve what we have, refresh it quietly for next time.
async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName), hit = await c.match(req);
  const net = fetch(req).then(r => { if (cacheable(r)) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
// Whose data the cache holds: remembered in the app cache, since the worker itself can be stopped any time.
let who;
async function getWho() {
  if (who !== undefined) return who;
  const hit = await (await caches.open(SHELL)).match(WHO_KEY);
  return (who = hit ? await hit.text() : '');
}
async function clearData() {
  for (const k of await caches.keys()) if (k.startsWith(DATA_PREFIX) || k === 'split-it-data-v3') await caches.delete(k);
}
async function setWho(uid) {
  uid = uid || '';
  if (uid === await getWho()) return;
  await clearData();   // someone else now: the last person's copy goes
  who = uid;
  await (await caches.open(SHELL)).put(WHO_KEY, new Response(uid));
}
// Reads are kept per person. /api/me says who is signed in; other reads carry the page's X-Hs-User
// and are only saved, or served offline, when that matches.
async function dataRead(req, url) {
  const isMe = url.pathname === '/api/me', isPhoto = url.pathname.startsWith('/api/photo/');
  const tag = req.headers.get('X-Hs-User') || '';
  try {
    const r = await fetch(req);
    if (isMe) {
      if (r.ok) { const d = await r.clone().json().catch(() => null); if (d && d.uid) await setWho(d.uid); }
      else if (r.status === 401) await setWho('');
    }
    const u = await getWho();
    if (u && cacheable(r) && (isMe || isPhoto || tag === u)) await (await caches.open(DATA_PREFIX + u)).put(req, r.clone());
    return r;
  } catch (e) {
    const u = await getWho();
    if (u && (isMe || isPhoto || tag === u)) { const hit = await (await caches.open(DATA_PREFIX + u)).match(req); if (hit) return fromCache(hit); }
    throw e;
  }
}
const READ_API = /^\/api\/(col|doc|me|profiles|auth-options|push\/who|push\/key)(\?|$)/;
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return;
  if (url.pathname === '/api/logout') { e.respondWith(setWho('').then(() => fetch(req))); return; }
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await networkFirst(req, SHELL, url.pathname === '/' || url.pathname === '/index.html' ? '/' : undefined); }
      catch { return (await caches.match('/')) || new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    })());
    return;
  }
  if (url.pathname === '/shim.js') return e.respondWith(networkFirst(req, SHELL));
  if (url.pathname.startsWith('/api/photo/')) return e.respondWith(dataRead(req, url));   // receipts are personal: kept with the person's data
  if (/^\/(art\/|vendor\/tesseract\/|icon|apple-touch-icon|manifest\.webmanifest)/.test(url.pathname)) return e.respondWith(staleWhileRevalidate(req, SHELL));
  if (READ_API.test(url.pathname + url.search)) return e.respondWith(dataRead(req, url));
});

// Sent by the page on sign-out: forget the saved data and whose it was.
self.addEventListener('message', e => {
  if (e.data === 'clear-data') e.waitUntil(setWho('').then(clearData));
});

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Split it', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: m.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate && c.url !== new URL(url, self.location).href && c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
