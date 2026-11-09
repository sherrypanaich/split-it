// Stands in for the Claude artifact runtime (claude.use) so the page runs
// unchanged against this laptop's own server.
(() => {
  // Errors carry a .code like the hosted store, so the page knows when a retry can help.
  const fail = (msg, code) => Object.assign(new Error(msg), { code });
  const api = async (url, body) => {
    let r;
    try {
      r = await fetch(url, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch (e) { throw Object.assign(fail(e.message || 'network error', 'unavailable'), { offline: true }); }
    if (r.headers.get('X-From-Cache')) offlineNow(true); else offlineNow(false);
    if (r.status === 401) { location.href = '/login'; throw fail('signed out', 'unauthenticated'); }
    if (!r.ok) {
      const msg = (await r.text().catch(() => '')) || r.statusText;
      throw fail(msg, r.status === 403 ? 'invalid_argument' : r.status === 404 ? 'not_found' : r.status >= 500 || r.status === 429 ? 'unavailable' : 'invalid_argument');
    }
    return r.json();
  };
  const q = p => encodeURIComponent(p);
  const parentOf = p => p.split('/').slice(0, -1).join('/');

  // ---------- offline ----------
  // Away from the laptop, reads come from the service worker's copy and writes wait in a
  // queue (kept in localStorage) that is sent, in order, as soon as the laptop answers again.
  const QKEY = 'hs-queue';
  const queue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
  const setQueue = qq => { try { localStorage.setItem(QKEY, JSON.stringify(qq)); } catch {} window.dispatchEvent(new CustomEvent('hs-queue', { detail: { pending: qq.length } })); };
  let offline = null;
  const offlineNow = v => { if (offline === v) return; offline = v; window.dispatchEvent(new Event(v ? 'hs-offline' : 'hs-online')); if (!v) flush(); };
  // What the queue says a collection looks like, laid over what the server last sent.
  const overlay = (path, rows) => {
    for (const op of queue()) {
      if (parentOf(op.path) !== path) continue;
      const id = op.path.split('/').pop(), i = rows.findIndex(r => r.id === id);
      if (op.op === 'delete') { if (i >= 0) rows.splice(i, 1); }
      else if (op.op === 'set') { if (i >= 0) rows[i] = { id, data: op.data }; else rows.push({ id, data: op.data }); }
      else if (i >= 0) rows[i] = { id, data: { ...rows[i].data, ...op.data } };
    }
    return rows;
  };
  let flushing = false;
  async function flush() {
    if (flushing || !queue().length) return; flushing = true;
    try {
      while (queue().length) {
        const [first, ...rest] = queue();
        try { await api('/api/write', { ops: [first] }); setQueue(rest); }
        catch (e) {
          // Not reachable, signed out, or the laptop is busy: keep the change and try again later.
          if (e.offline || e.code === 'unauthenticated' || e.code === 'unavailable') break;
          // The server said no for good (not allowed, or the thing is gone): skip it, and say so.
          console.warn('Skipped a change made offline:', e.message, first); setQueue(rest);
          window.dispatchEvent(new CustomEvent('hs-dropped', { detail: { message: e.message } }));
        }
      }
      if (!queue().length) subs.forEach(s => s.refresh());
    } finally { flushing = false; }
  }
  window.addEventListener('online', () => { flush(); subs.forEach(s => s.refresh()); });
  async function write(ops) {
    // While older changes are still waiting, new ones wait behind them, so they reach the laptop in order.
    const waiting = queue().length > 0;
    try { if (waiting) throw Object.assign(fail('waiting for older changes', 'unavailable'), { offline: true }); return await api('/api/write', { ops }); }
    catch (e) {
      if (!e.offline) throw e;
      setQueue([...queue(), ...ops]); if (waiting) flush(); else offlineNow(true);
      // show the change right away, as if the server had confirmed it
      for (const op of ops) for (const s of subs) {
        if (s.path !== parentOf(op.path) || !s.patch) continue;
        const id = op.path.split('/').pop();
        if (op.op === 'delete') s.patch([[id, null]]);
        else if (op.op === 'set') s.patch([[id, op.data]]);
        else { const cur = s.current && s.current(id); if (cur) s.patch([[id, { ...cur, ...op.data }]]); }
      }
      return { ok: true, queued: true };
    }
  }
  window.HouseSplitOffline = { pending: () => queue().length, flush, offline: () => !!offline };

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
    es.onopen = () => { if (dropped) { dropped = false; subs.forEach(s => s.refresh()); } window.dispatchEvent(new Event('hs-online')); };
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

  const db = { doc: docRef, collection: p => colRef(p) };

  let me = null;
  const getMe = () => me || (me = api('/api/me'));
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
