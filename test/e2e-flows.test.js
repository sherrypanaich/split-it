// A household using the real app: three people on their phones (390 wide, one in dark mode), each in their own
// headless Chromium. They make a group, split things every way the form allows, edit one at the same time, delete and
// put back, pay each other, add a bill and a chore, move someone out, bring a name-only member onto the app, and
// one of them deletes their data. Balances are compared between the three phones and the laptop's own numbers,
// and the page must never throw.
// Needs Playwright with Chromium installed. Without it (as on GitHub's test runners) the test is skipped.
// Run with: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
let pw = null, why = false;
try { pw = require('playwright'); if (!fs.existsSync(pw.chromium.executablePath())) why = 'Chromium for Playwright is not installed'; }
catch { why = 'Playwright is not installed'; }

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PW = 'some-password';

test('a household goes through the app together and every phone agrees', { skip: why, timeout: 300000 }, async () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-flows-'));
  const PORT = await freePort(), BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, DATA_DIR: path.join(DIR, 'data'), PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '', RATES_URL: 'http://127.0.0.1:9/none', TZ: 'America/Toronto' };
  for (const name of ['Olivia', 'Ana', 'Ben']) spawnSync(process.execPath, [SERVER, 'add-user', name], { env, input: PW + '\n' });
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  const errors = [];
  try {
    await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
      proc.stdout.on('data', d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }); proc.on('exit', c => rej(new Error('server stopped (' + c + '): ' + out))); });
    const api = async (cookie, method, url, body) => {
      const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) };
    };
    // what the laptop holds right now, as Olivia (who is in everything here) can read it
    let reader = '';
    const dbNow = async () => { const all = {};
      for (const cp of ['groups', 'expenses', 'chores', 'recurring']) for (const d of (await api(reader, 'GET', '/api/col?path=' + cp)).data.docs) all[cp + '/' + d.id] = d.data;
      return all; };
    browser = await pw.chromium.launch();

    // ---------- helpers ----------
    async function phone(name, dark) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
      await ctx.addInitScript(() => { window.__toasts = []; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.innerText); }).observe(document, { childList: true, subtree: true }); });
      if (name) { const r = await api('', 'POST', '/api/login', { name, password: PW }); assert.strictEqual(r.status, 200, name + ' signs in');
        if (!reader) reader = r.cookie; const [k, ...v] = r.cookie.split('='); await ctx.addCookies([{ name: k, value: v.join('='), domain: '127.0.0.1', path: '/' }]); }
      const p = await ctx.newPage(); p.who = name || 'new'; p.setDefaultTimeout(10000);
      p.on('pageerror', e => errors.push(`${p.who}: ${e}`));
      p.on('dialog', d => d.dismiss().catch(() => {}));
      return p;
    }
    const text = p => p.evaluate(() => document.body.innerText);
    const sheetText = p => p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); return s ? s.innerText : ''; });
    const toasts = p => p.evaluate(() => window.__toasts.splice(0).join(' | '));
    const toastSaid = (p, re) => p.waitForFunction(src => window.__toasts.some(t => new RegExp(src).test(t)), re.source);
    async function until(p, re, what, ms = 8000) {   // wait until the page shows something
      const end = Date.now() + ms; let t = '';
      while (Date.now() < end) { t = await text(p); if (re.test(t)) return t; await p.waitForTimeout(150); }
      assert.fail(`${p.who}'s phone never showed ${what} (${re}). It showed:\n${t.slice(0, 1500)}`);
    }
    async function home(p) { await p.goto(BASE + '/'); await p.waitForSelector('#tabs:not([hidden])', { timeout: 15000 }); }
    async function tab(p, t) { await p.click(`[data-tab="${t}"]`); await p.waitForTimeout(200); }
    async function group(p) { await home(p); await tab(p, 'groups'); await p.locator('[data-group]').first().click(); await p.waitForSelector('#gSettings'); }
    async function closeSheets(p) { for (let i = 0; i < 3 && await p.locator('.sheet').count(); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(250); } }
    const row = (p, title) => p.locator('[data-exp]', { hasText: title }).first();
    async function form(p, o) {   // fill the expense form that is open
      const chip = (attr, nm) => p.locator(`[${attr}]`, { hasText: nm }).first();
      if (o.cur) { await p.selectOption('#cur', o.cur); await p.waitForTimeout(300); }
      if (o.rate) await p.fill('#rate', o.rate);
      if (o.amount) await p.fill('#amt', o.amount);
      await p.fill('#ttl', o.title);
      if (o.paidBy) await chip('data-pb', o.paidBy).click();
      if (o.mode) await p.click(`[data-mode="${o.mode}"]`);
      for (const nm of o.leaveOut || []) await p.locator('#rows .srow', { hasText: nm }).locator('input').uncheck();
      for (const [nm, v] of Object.entries(o.each || {})) await p.locator('#rows .srow', { hasText: nm }).locator('input').fill(String(v));
      for (const [i, it] of (o.items || []).entries()) {
        if (i) await p.click('#addItem');
        await p.fill(`[data-in="${i}"]`, it.n); await p.fill(`[data-ip="${i}"]`, it.p);
        if (it.who) for (const b of await p.locator(`[data-iw^="${i}|"]`).all()) {
          const on = (await b.getAttribute('aria-pressed')) === 'true', label = await b.innerText(), want = it.who.some(w => label.includes(w));
          if (on !== want) await b.click(); }
      }
      if (o.tax) await p.fill('#tax', o.tax);
      if (o.two) { await p.click('#twoOn'); await chip('data-pb2', o.two[0]).click(); await p.fill('#paid2', o.two[1]); }
      assert.ok(!(await p.isDisabled('#save')), `${o.title}: Save is on (${await p.innerText('#sn')})`);
    }
    async function add(p, o) {
      await p.click('#app button:has-text("Add expense")'); await p.waitForSelector('#amt');
      await form(p, o); await p.click('#save'); await p.waitForSelector('#amt', { state: 'detached' });
    }
    // the laptop's own balance for each person in a group, in cents
    const netOn = async gid => { const n = {};
      for (const [k, e] of Object.entries(await dbNow())) { if (!/^expenses\/[^/]+$/.test(k) || !e || e.deletedAt || e.groupId !== gid || e.status === 'needs_amount') continue;
        if (e.kind === 'payment') { if (e.confirmed === false) continue; n[e.from] = (n[e.from] || 0) + e.amount; n[e.to] = (n[e.to] || 0) - e.amount; }
        else { n[e.paidBy] = (n[e.paidBy] || 0) + e.amount; for (const [id, c] of Object.entries(e.split || {})) n[id] = (n[id] || 0) - c; } }
      return n; };
    const money = c => '$' + (Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // each phone's group page says the same as the laptop: "you're owed $X", "you owe $X" or all square
    async function agree(phones, gid, uids) {
      const n = await netOn(gid);
      for (const p of phones) {
        await group(p); const v = n[uids[p.who]] || 0;
        await until(p, v > 0 ? new RegExp(`YOU’RE OWED\\s+\\${money(v)}`) : v < 0 ? new RegExp(`YOU OWE\\s+\\${money(v)}`) : /All square/, `a balance of ${v}`);
      }
    }

    const o = await phone('Olivia'), a = await phone('Ana', true), b = await phone('Ben');
    const uids = {};
    for (const p of [o, a, b]) { await p.goto(BASE + '/'); await p.click('text=Get started'); await p.waitForSelector('#tabs:not([hidden])');
      uids[p.who] = (await p.evaluate(() => fetch('/api/me').then(r => r.json()))).uid; }

    // ---------- friends: Ana from the list, Ben by tag; Ben's open page shows the request without a reload ----------
    await home(o); await home(b); await tab(o, 'friends'); await o.click('#addFriend'); await o.locator('[data-p]', { hasText: 'Ana' }).click();
    await tab(o, 'friends'); await o.click('#addFriend'); await o.fill('#ffQ', '@ben'); await o.click('#ffFind'); await o.click('#ffAsk'); await o.waitForSelector('#ffAsk', { state: 'detached' }); await closeSheets(o);
    await until(b, /Olivia wants to be friends/, 'the friend request');
    await b.click('[data-freq$="|1"]');

    // ---------- a group with a name-only member ----------
    await tab(o, 'groups'); await o.click('#app button:has-text("New group")'); await o.fill('#gn', 'Bridge St');
    for (const x of await o.locator('[data-add]').all()) await x.click();
    await o.fill('#gg', 'Mohit'); await o.click('#ggAdd'); await o.click('#sv'); await o.waitForSelector('#gSettings');
    const GID = Object.keys(await dbNow()).find(k => /^groups\/[^/]+$/.test(k)).split('/')[1];
    for (const p of [a, b]) await group(p);

    // ---------- every kind of split ----------
    await add(o, { amount: '90', title: 'Groceries' });
    await add(a, { amount: '40', title: 'Pizza', mode: 'shares', each: { Me: 2, Ben: 1, Olivia: 1, Mohit: 0 } });
    await add(b, { amount: '100', title: 'Hydro', mode: 'exact', each: { Olivia: '30', Ana: '30', Me: '40' } });
    await add(o, { title: 'Costco', mode: 'items', items: [{ n: 'Paper towels', p: '20' }, { n: 'Wine', p: '30', who: ['Me', 'Ana'] }], tax: '6.50' });
    await add(o, { amount: '120', title: 'Dinner', leaveOut: ['Mohit'], two: ['Ana', '50'] });
    await agree([o, a, b], GID, uids);
    const n1 = await netOn(GID);
    assert.deepStrictEqual([n1[uids.Olivia], n1[uids.Ana], n1[uids.Ben]], [9140, -4510, -1815], 'the sums come out as worked by hand');

    // ---------- a trip currency with a card fee, and two people paying in it: still editable afterwards ----------
    await o.click('#gSettings'); await o.selectOption('#gcur', 'USD'); await o.fill('#gfee', '2.5'); await o.click('#sv'); await o.waitForSelector('#gcur', { state: 'detached' });
    await group(b); await b.click('#app button:has-text("Add expense")'); await b.waitForSelector('#amt');
    assert.strictEqual(await b.inputValue('#cur'), 'USD', 'new expenses start in the trip currency');
    await form(b, { amount: '30', title: 'Museum', rate: '1.40', leaveOut: ['Mohit'], two: ['Ana', '10'] });
    assert.match(await b.innerText('#conv'), /\$43\.05 with the 2\.5% card fee/);
    await b.click('#save'); await b.waitForSelector('#amt', { state: 'detached' });
    for (const i of [0, 1]) {
      await b.locator('[data-exp]', { hasText: 'Museum' }).nth(i).click(); await b.click('#edit'); await b.waitForSelector('#amt');
      assert.ok(!(await b.isDisabled('#save')), 'a two-payer part in a trip currency can be saved again: ' + await b.innerText('#sn'));
      await b.click('#save'); await b.waitForSelector('#amt', { state: 'detached' }); await closeSheets(b);
    }
    await o.click('#gSettings'); await o.selectOption('#gcur', 'CAD'); await o.click('#sv'); await o.waitForSelector('#gcur', { state: 'detached' });

    // ---------- the same expense edited on two phones at once ----------
    await group(a); await group(b);
    for (const p of [a, b]) { await row(p, 'Pizza').click(); await p.click('#edit'); await p.waitForSelector('#amt'); }
    await a.fill('#amt', '44'); await a.click('#save'); await a.waitForSelector('#amt', { state: 'detached' });
    await b.fill('#ttl', 'Pizza night'); await b.waitForTimeout(500); await b.click('#save');
    await until(b, /changed this while you had it open/, 'that the expense changed under it');
    await b.waitForSelector('#edit'); await b.waitForFunction(() => !document.querySelector('#amt'));
    assert.match(await sheetText(b), /\$44\.00/, 'and it shows the new version');
    assert.strictEqual(Object.values(await dbNow()).find(e => e && e.title && e.title.startsWith('Pizza')).title, 'Pizza', 'the older save did not overwrite it');
    await closeSheets(b);

    // ---------- delete, the others are told, put back from the bin; both parts of a two-payer bill go together ----------
    await row(o, 'Groceries').click(); await o.click('#del'); await o.click('#del');
    await until(a, /Olivia removed Groceries/, 'that Olivia removed it');
    await row(a, 'Dinner').click(); await a.click('#del'); await a.click('#del');
    await toastSaid(a, /Both parts moved to Recently deleted/);
    const dinners = async () => Object.values(await dbNow()).filter(e => e && e.title === 'Dinner');
    assert.deepStrictEqual((await dinners()).map(e => !!e.deletedAt), [true, true]);
    await tab(a, 'activity'); await a.locator('#app button', { hasText: 'Recently deleted' }).click();
    for (const t of ['Groceries', 'Dinner']) { await row(a, t).click(); await a.click('#res'); await a.waitForSelector('#res', { state: 'detached' }); }
    assert.deepStrictEqual((await dinners()).map(e => !!e.deletedAt), [false, false]);

    // ---------- comments arrive on the other phone while it is open ----------
    await group(a); await group(b);
    await row(b, 'Hydro').click(); await row(a, 'Hydro').click();
    await b.fill('#ci', 'Bill came early'); await b.click('#cs');
    await until(a, /Bill came early/, 'Ben’s comment');
    await closeSheets(a); await closeSheets(b);

    // ---------- payments: three part payments, Mohit's recorded by Ana, then "Yes, got them all" ----------
    await group(a);
    for (const amt of ['10', '5', '3']) { await a.click('#app button:has-text("I paid this")'); await a.fill('#pa', amt); await a.click('#ok'); await a.waitForSelector('#pa', { state: 'detached' }); }
    await a.locator('#app button', { hasText: 'Record it' }).first().click(); await a.click('#ok'); await a.waitForSelector('#pa', { state: 'detached' });
    await home(o); await until(o, /4 payments are waiting for you/, 'four payments to confirm');
    await o.click('#confirmAll'); await o.click('#confirmAll');
    await until(o, /All caught up/, 'nothing left to confirm');
    await agree([o, a, b], GID, uids);

    // ---------- a bill due today posts itself; a chore with a swap ----------
    await group(o); await o.click('#gBill'); await o.waitForSelector('#amt');
    await form(o, { amount: '60', title: 'Internet' }); await o.click('#save'); await o.waitForSelector('#amt', { state: 'detached' });
    await until(o, /Internet[\s\S]*Today, You paid\s+\$60\.00/, 'the bill posted for today');
    await group(a); await a.click('#gChore'); await a.fill('#chT', 'Trash'); await a.click('#chS'); await a.waitForSelector('#chT', { state: 'detached' });
    await group(b); await b.locator('[data-chore]', { hasText: 'Trash' }).click(); await b.locator('[data-sw]', { hasText: 'me' }).click();
    await until(o, /Trash\s+Ben’s turn/, 'Ben taking the chore');

    // ---------- Ben settles up and moves out: off the chore, out of the bills ----------
    await agree([o, a, b], GID, uids);
    const settle = async () => { const n = await netOn(GID);
      for (const p of [a, b]) if ((n[uids[p.who]] || 0) < 0) { await group(p); await p.click('#app button:has-text("I paid this")'); await p.click('#ok'); await p.waitForSelector('#pa', { state: 'detached' }); }
      await home(o); while (await o.locator('[data-confirm][data-ok="1"]').count()) { await o.locator('[data-confirm][data-ok="1"]').first().click(); await o.waitForTimeout(700); } };
    await settle();
    await group(o); await o.click('#gSettings'); await o.locator('[data-m]', { hasText: 'Ben' }).click();
    if (await o.locator('[data-heir]').count()) await o.locator('[data-heir]', { hasText: 'Ana' }).click();
    await o.waitForTimeout(500); await closeSheets(o); await group(o); await o.click('#gSettings'); await o.locator('[data-m]', { hasText: 'Ben' }).click();
    if (await o.isDisabled('#out')) assert.fail('Moving Ben out is blocked: ' + await sheetText(o));
    await o.click('#out'); await o.waitForSelector('#out', { state: 'detached' });
    const chore = Object.entries(await dbNow()).find(([k]) => k.startsWith('chores/'))[1];
    assert.ok(!chore.order.includes(uids.Ben), 'Ben is out of the chore rotation');
    await group(o); assert.doesNotMatch(await text(o), /Trash\s+Ben’s turn/);

    // ---------- Mohit joins with an invite that carries his history, and takes it over ----------
    await o.click('#gSettings'); await o.locator('[data-m]', { hasText: 'Mohit' }).click(); await o.click('[data-handover]');
    await o.click('#hoLink'); const link = await o.inputValue('#lkUrl'); await closeSheets(o);
    const m = await phone(null); await m.goto(link); await m.waitForSelector('#n');
    assert.strictEqual(await m.inputValue('#n'), 'Mohit', 'the join page fills in his name');
    await m.fill('#pw', PW); await m.click('#go'); await m.click('text=Get started'); m.who = 'Mohit';
    await until(m, /Olivia has history for you/, 'the history waiting for him');
    await m.click('[data-claim-open]'); await m.click('button:has-text("Yes, that’s me")');
    await toastSaid(m, /It’s all yours now/);
    assert.strictEqual(await m.locator('.party').count(), 0, 'no “PAID!” celebration: nobody paid anything');
    uids.Mohit = (await m.evaluate(() => fetch('/api/me').then(r => r.json()))).uid;
    await agree([o, a, m], GID, uids);

    // ---------- Mohit deletes his data: the bill he was in pauses, and the group picks who takes over ----------
    await home(m); await m.click('#profBtn'); await m.click('#forgetBtn'); await m.fill('#fgPw', PW); await m.click('#fgGo');
    await m.waitForURL(/\/login/, { timeout: 10000 });
    await group(o);
    const t = await until(o, /is paused/, 'the paused bill');
    assert.doesNotMatch(t, /Former left/, 'a former member is not called “Former”');
    await o.locator('[data-takeover]', { hasText: 'Split it between the rest' }).first().click();
    await until(o, /Internet\s+\$60\.00, your share/, 'the bill running again');
    assert.ok(Object.entries(await dbNow()).filter(([k]) => k.startsWith('recurring/')).every(([, r]) => !r.takeover), 'nothing is left paused');

    // ---------- sign out and back in ----------
    await home(a); await a.click('#profBtn'); await a.click('#signOut'); await a.click('#signOut').catch(() => {});
    await a.waitForURL(/\/login/, { timeout: 10000 });
    await a.fill('input[type="password"]', PW); await a.locator('input:not([type="password"])').first().fill('Ana'); await a.keyboard.press('Enter');
    await a.waitForSelector('#tabs:not([hidden])', { timeout: 15000 });
    await agree([o, a], GID, uids);

    // ---------- nothing overflows a phone screen ----------
    for (const p of [o, a]) { await group(p);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${p.who}'s group page fits the screen`); }
    assert.deepStrictEqual(errors, [], 'the page threw errors');
  } finally {
    if (browser) await browser.close().catch(() => {});
    const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone;
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
