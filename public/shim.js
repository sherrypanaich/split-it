// Stands in for the Claude artifact runtime (claude.use) so the page runs
// unchanged against this laptop's own server.
(() => {
  // Errors carry a .code like the hosted store, so the page knows when a retry can help.
  const fail = (msg, code) => Object.assign(new Error(msg), { code });
  const WRITE_TIMEOUT = 20000;
  let lastAnswer = 0;   // when the laptop last answered (not the phone's saved copy)
  const api = async (url, body) => {
    let r;
    const ctl = body === undefined ? null : new AbortController(), t = ctl && setTimeout(() => ctl.abort(), WRITE_TIMEOUT);
    try {
      r = await fetch(url, body === undefined ? { headers: who ? { 'X-Hs-User': who } : {} } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal
      });
    } catch (e) { throw Object.assign(fail(e.message || 'network error', 'unavailable'), { offline: true }); }
    finally { if (t) clearTimeout(t); }
    if (r.headers.get('X-From-Cache')) offlineNow(true); else { lastAnswer = Date.now(); offlineNow(false); }
    if (r.status === 401) { location.href = '/login'; throw fail('signed out', 'unauthenticated'); }
    if (r.status === 422 || r.status === 409) {   // the server checked it and said why it can't be saved (409: it changed since you opened it)
      const d = await r.json().catch(() => ({}));
      throw fail(d.error || 'That can’t be saved as it is.', r.status === 409 ? 'stale' : 'failed_precondition');
    }
    if (!r.ok) {
      let msg = (await r.text().catch(() => '')) || r.statusText;
      try { const d = JSON.parse(msg); if (d && d.error) msg = d.error; } catch {}
      throw fail(msg, r.status === 403 ? 'invalid_argument' : r.status === 404 ? 'not_found' : r.status >= 500 || r.status === 429 ? 'unavailable' : 'invalid_argument');
    }
    if (!r.headers.get('X-From-Cache') && !queue().length) synced();
    return r.json();
  };
  const q = p => encodeURIComponent(p);
  const parentOf = p => p.split('/').slice(0, -1).join('/');

  // ---------- offline ----------
  // Away from the laptop, reads come from the service worker's copy and writes wait in a
  // queue (kept in localStorage) that is sent, in order, as soon as the laptop answers again.
  // Each item in the queue is one change, or one batch of changes that are saved all together.
  // A change the laptop refuses, or one that keeps failing, is set aside (not lost) so the rest can go,
  // and the page is told so it can say which one and offer to redo it.
  const QKEY = 'hs-queue', AKEY = 'hs-aside', SKEY = 'hs-synced';
  const MAX_TRIES = 5;   // the laptop answered but couldn't save it (busy, error): this many tries, then it is set aside
  const ls = {
    get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del: k => { try { localStorage.removeItem(k); } catch {} }
  };
  const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // older versions kept one change per item: {op, path, data, by}
  const norm = it => it && Array.isArray(it.ops) ? it : { id: newKey(), ops: [{ op: it.op, path: it.path, data: it.data }], by: it.by || null, tries: 0, at: Date.now() };
  // An old item is converted once and stored back, so it keeps the same id (and is sent once) from then on.
  const queue = () => {
    const qq = ls.get(QKEY, []); if (!Array.isArray(qq)) return [];
    const raw = qq.filter(Boolean), out = raw.map(norm);
    if (out.some((x, i) => x !== raw[i])) ls.set(QKEY, out);
    return out;
  };
  const setQueue = qq => { ls.set(QKEY, qq); window.dispatchEvent(new CustomEvent('hs-queue', { detail: { pending: qq.length } })); };
  const aside = () => { const a = ls.get(AKEY, []); return Array.isArray(a) ? a : []; };
  const setAside = a => { ls.set(AKEY, a.slice(-30)); window.dispatchEvent(new CustomEvent('hs-aside', { detail: { count: a.length } })); };
  let syncedAt = ls.get(SKEY, null), syncedSaved = 0;
  const synced = () => { syncedAt = Date.now(); if (syncedAt - syncedSaved > 15000) { syncedSaved = syncedAt; ls.set(SKEY, syncedAt); } };
  // Each queued change remembers who made it, so it is never sent under someone else's sign-in on a shared phone.
  let who = null;
  let offline = null;
  const offlineNow = v => { if (offline === v) return; offline = v; window.dispatchEvent(new Event(v ? 'hs-offline' : 'hs-online')); if (!v) flush(); };
  const allOps = () => queue().flatMap(it => it.ops);
  // What the queue says a collection looks like, laid over what the server last sent.
  const overlay = (path, rows) => {
    for (const op of allOps()) {
      if (parentOf(op.path) !== path) continue;
      const id = op.path.split('/').pop(), i = rows.findIndex(r => r.id === id);
      if (op.op === 'delete') { if (i >= 0) rows.splice(i, 1); }
      else if (op.op === 'set') { if (i >= 0) rows[i] = { id, data: op.data }; else rows.push({ id, data: op.data }); }
      else if (i >= 0) rows[i] = { id, data: { ...rows[i].data, ...op.data } };
    }
    return rows;
  };
  // Take a change off the queue and keep it in the "not saved" list, then tell the page.
  const putAside = (item, reason, message, code) => {
    setQueue(queue().filter(x => x.id !== item.id));
    const entry = { id: item.id, ops: item.ops, by: item.by || who, label: item.label || null, reason, message, code: code || null, at: Date.now() };
    setAside([...aside().filter(x => x.id !== item.id), entry]);
    console.warn('A change made offline was set aside:', message, item);
    window.dispatchEvent(new CustomEvent('hs-dropped', { detail: entry }));
  };
  let flushing = false, retryTimer = null, backoff = 0;
  const retryLater = () => {
    if (retryTimer) return;
    const ms = Math.min(60000, 2000 * 2 ** Math.min(backoff++, 5)) * (0.75 + Math.random() / 2);
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, ms);
  };
  async function flush() {
    if (flushing || !queue().length) return; flushing = true;
    let sent = false;
    try {
      if (!who) { try { await getMe(); } catch {} if (!who) return; }
      while (queue().length) {
        // re-read after each wait: changes made while this one was sending were added to the stored queue
        const [item] = queue();
        if (item.by && item.by !== who) { console.warn('Dropped a change another person made offline on this phone'); setQueue(queue().slice(1)); continue; }
        try {
          await api(item.ops.length > 1 ? '/api/batch' : '/api/write', { ops: item.ops, label: item.label || undefined });
          setQueue(queue().filter(x => x.id !== item.id)); backoff = 0; sent = true;
        } catch (e) {
          if (e.code === 'unauthenticated') break;   // signed out: keep it for when they sign back in
          // The laptop can't be reached: keep it and try again later. That doesn't count against the change,
          // unless the laptop has answered something else since this change last failed, so it's this change that keeps failing.
          const busy = e.code === 'unavailable' && (!e.offline || (item.failAt && lastAnswer > item.failAt));
          if (e.offline && !busy) { setQueue(queue().map(x => x.id === item.id ? { ...x, failAt: Date.now() } : x)); retryLater(); break; }
          if (busy) {
            const tries = (item.tries || 0) + 1;
            if (tries < MAX_TRIES) { setQueue(queue().map(x => x.id === item.id ? { ...x, tries, failAt: Date.now() } : x)); retryLater(); break; }
            putAside(item, 'stuck', 'It didn’t go through after several tries.', e.code);
            continue;
          }
          // The server said no for good (not allowed, the numbers don't add up, it changed, it's gone): set it aside and go on.
          putAside(item, 'refused', e.message, e.code);
        }
      }
      if (!queue().length) { synced(); ls.set(SKEY, syncedAt); }
      if (sent || !queue().length) subs.forEach(s => s.refresh());
    } finally { flushing = false; window.dispatchEvent(new CustomEvent('hs-queue', { detail: { pending: queue().length } })); }
  }
  window.addEventListener('online', () => { flush(); subs.forEach(s => s.refresh()); });
  // show the change right away, as if the server had confirmed it
  const showNow = ops => {
    for (const op of ops) for (const s of subs) {
      if (s.path !== parentOf(op.path) || !s.patch) continue;
      const id = op.path.split('/').pop();
      if (op.op === 'delete') s.patch([[id, null]]);
      else if (op.op === 'set') s.patch([[id, op.data]]);
      else { const cur = s.current && s.current(id); if (cur) s.patch([[id, { ...cur, ...op.data }]]); }
    }
  };
  async function write(ops, label) {
    // While older changes are still waiting, new ones wait behind them, so they reach the laptop in order.
    const waiting = queue().length > 0;
    try {
      if (waiting) throw Object.assign(fail('waiting for older changes', 'unavailable'), { offline: true });
      return await api(ops.length > 1 ? '/api/batch' : '/api/write', { ops, label: label || undefined });
    } catch (e) {
      if (!e.offline) throw e;
      setQueue([...queue(), { id: newKey(), ops, by: who, label: label || null, tries: 0, at: Date.now() }]);
      if (waiting) flush(); else { offlineNow(true); retryLater(); }
      showNow(ops);
      return { ok: true, queued: true };
    }
  }
  // Several changes saved together: all of them, or none (a move-out, "confirm all", a new group).
  // Offline, the batch waits in the queue as one item.
  const batch = () => {
    const ops = [];
    const path = ref => typeof ref === 'string' ? ref : ref.path;
    const b = {
      set: (ref, data) => { ops.push({ op: 'set', path: path(ref), data }); return b; },
      update: (ref, data) => { ops.push({ op: 'update', path: path(ref), data }); return b; },
      delete: ref => { ops.push({ op: 'delete', path: path(ref) }); return b; },
      get size() { return ops.length; },
      commit: async label => ops.length ? write(ops.slice(), label) : { ok: true }
    };
    return b;
  };
  // Signing out on a shared phone: forget this person's saved copy, waiting changes and "not saved" list.
  async function forget() {
    try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clear-data'); } catch {}
    try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (reg && reg.active) reg.active.postMessage('clear-data'); } catch {}
    try { if (window.caches) for (const k of await caches.keys()) if (/^split-it-data-/.test(k)) await caches.delete(k); } catch {}
    for (const k of [QKEY, AKEY, SKEY]) ls.del(k);
  }
  window.HouseSplitOffline = {
    pending: () => queue().length, flush, offline: () => !!offline,
    lastSynced: () => syncedAt,
    // changes that couldn't be saved, for the person signed in now
    notSaved: () => aside().filter(x => !x.by || !who || x.by === who),
    dismiss: id => setAside(aside().filter(x => x.id !== id)),
    forget,
    signOut: async (to = '/api/logout') => { await forget(); location.href = to; }
  };

  // ---------- live updates ----------
  // Every write on the server sends a "change" event carrying the changed documents
  // themselves. Listeners patch what they already hold instead of downloading their
  // whole collection again; a listener that has nothing yet simply loads.
  const subs = new Set();
  let es = null, dropped = false;
  const connect = () => {
    if (es) return;
    es = new EventSource('/api/events');
    es.addEventListener('change', ev => {
      const { paths, docs } = JSON.parse(ev.data);
      for (const s of subs) {
        const hit = paths.filter(p => parentOf(p) === s.path);
        if (!hit.length) continue;
        if (!docs || !s.patch) { s.refresh(); continue; }
        s.patch(hit.map(p => [p.split('/').pop(), docs[p]]));
      }
    });
    es.addEventListener('reload', () => setTimeout(() => location.reload(), 800));
    es.addEventListener('refresh', () => subs.forEach(s => s.refresh()));   // joined or left a group
    es.onopen = () => { if (dropped) { dropped = false; subs.forEach(s => s.refresh()); } lastAnswer = Date.now(); offlineNow(false); window.dispatchEvent(new Event('hs-online')); flush(); };
    es.onerror = () => { es.close(); es = null; dropped = true; window.dispatchEvent(new Event('hs-offline')); setTimeout(connect, 3000); };
  };

  const docSnap = (id, data) => ({ id, exists: data != null, data: () => data == null ? undefined : structuredClone(data) });
  const colSnap = rows => {
    const docs = rows.map(r => docSnap(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
  };

  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id, path,
      collection: sub => colRef(path + '/' + sub),
      get: async () => docSnap(id, (await api('/api/doc?path=' + q(path))).data),
      set: data => write([{ op: 'set', path, data }]),
      update: data => write([{ op: 'update', path, data }]),
      delete: () => write([{ op: 'delete', path }]),
      onSnapshot(cb, err) {
        let last;
        const s = { path: parentOf(path), current: () => last,
          refresh: () => this.get().then(snap => { last = snap.exists ? snap.data() : undefined; cb(snap); }, err || console.error),
          patch: rows => { for (const [rid, data] of rows) if (rid === id) { last = data == null ? undefined : data; cb(docSnap(id, data)); } } };
        subs.add(s); connect(); s.refresh();
        return () => subs.delete(s);
      }
    };
  }

  function colRef(path, opts = {}) {
    const shape = rows => {
      for (const [f, op, v] of (opts.where || [])) rows = rows.filter(r => {
        const x = r.data[f];
        if (op === '==') return x === v; if (op === '!=') return x !== v;
        if (op === 'in') return (v || []).includes(x); if (op === 'not-in') return !(v || []).includes(x);
        if (op === 'array-contains') return Array.isArray(x) && x.includes(v);
        if (x === undefined || x === null) return false;
        return op === '>' ? x > v : op === '>=' ? x >= v : op === '<' ? x < v : op === '<=' ? x <= v : true;
      });
      if (opts.orderBy) {
        const { field, dir } = opts.orderBy;
        // documents missing the field go last, like the hosted store
        const val = r => r.data[field] ?? null;
        rows = [...rows].sort((a, b) => { const x = val(a), y = val(b);
          if (x === null || y === null) return (x === null) - (y === null);
          return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'desc' ? -1 : 1); });
      }
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return colSnap(rows);
    };
    const fetchAll = async () => (await api('/api/col?path=' + q(path))).docs;
    return {
      path, id: path.split('/').pop(),
      doc: id => docRef(path + '/' + id),
      limit: n => colRef(path, { ...opts, limit: n }),
      where: (f, op, v) => colRef(path, { ...opts, where: [...(opts.where || []), [f, op, v]] }),
      orderBy: (field, dir = 'asc') => colRef(path, { ...opts, orderBy: { field, dir } }),
      get: async () => shape(await fetchAll()),
      onSnapshot(cb, err) {
        let all = null;   // every document in the collection, before where/order/limit
        const s = { path, current: id => all?.find(r => r.id === id)?.data,
          refresh: () => fetchAll().then(rows => { all = overlay(path, rows); cb(shape(all)); }, err || console.error),
          patch: changes => {
            if (!all) return s.refresh();
            for (const [id, data] of changes) {
              const i = all.findIndex(r => r.id === id);
              if (data == null) { if (i >= 0) all.splice(i, 1); }
              else if (i >= 0) all[i] = { id, data }; else all.push({ id, data });
            }
            cb(shape(all));
          } };
        subs.add(s); connect(); s.refresh();
        return () => subs.delete(s);
      }
    };
  }

  const db = { doc: docRef, collection: p => colRef(p), batch };

  let me = null;
  const getMe = () => me || (me = api('/api/me').then(m => { who = m.uid; forgetOthers(); return m; }, e => { me = null; throw e; }));
  // Someone else used this phone before and didn't sign out: what they left waiting here is theirs, not this person's.
  const forgetOthers = () => {
    if (!who) return;
    const qq = queue(); if (qq.some(x => x.by && x.by !== who)) setQueue(qq.filter(x => !x.by || x.by === who));
    const a = aside(); if (a.some(x => x.by && x.by !== who)) setAside(a.filter(x => !x.by || x.by === who));
  };
  const user = {
    id: async () => (await getMe()).uid,
    isOwner: async () => (await getMe()).isOwner,
    can: async () => true,
    profiles: async ids => api('/api/profiles?ids=' + q(ids.join(',')))
  };

  const downloads = {
    save: async ({ filename, data, mimeType }) => {
      const url = URL.createObjectURL(new Blob([data], { type: mimeType || 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: filename || 'download.txt' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  };

  // Quick add hook. Leave as null and the page falls back to its own parser for
  // typed entries. To turn an AI model on, set window.HouseSplitQuickAdd before this
  // file loads to an object with:
  //   json(prompt, {images, signal}) -> Promise<object>   (same shape the page asks for)
  //   limits() -> Promise<{images: boolean}>
  const sample = () => window.HouseSplitQuickAdd || null;

  window.claude = {
    use: async name => ({ db, user, downloads, sample: sample() })[name] ?? null
  };
})();
