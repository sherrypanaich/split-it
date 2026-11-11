// Text that people type is shown back on other people's phones, and the page allows inline scripts.
// This saves script-like text in every free-text field through the API, opens the page in a real
// (headless) Chromium as a signed-in person, walks through the screens that show that text, and
// checks that none of it ever ran.
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

// Every field gets its own marker, so the test can also tell which ones it actually saw on screen.
const evil = tag => `<img src=x onerror=window.__xss=1>${tag}"><img src=x onerror=window.__xss=1>'><script>window.__xss=1</script><svg onload=window.__xss=1>`;
const FIELDS = ['GROUPNAME', 'GUESTNAME', 'NICKBEN', 'NICKANA', 'ETRANSFER', 'EXPTITLE', 'EXPNOTE', 'ITEMNAME', 'COMMENT', 'PAYNOTE', 'CHORE', 'BILL', 'DIRECTTITLE', 'FRIENDNAME', 'PRIVTITLE', 'LOGINNAME'];

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('text people type never runs as code on the page', { skip: why, timeout: 240000 }, async () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-it-xss-'));
  const PORT = await freePort();
  const env = { ...process.env, DATA_DIR: path.join(DIR, 'data'), PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: '', RESEND_API_KEY: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '' };
  // sign-in names are cut to 30 characters, so this one is short
  for (const name of ['Ana', 'Ben', '<svg onload=__xss=1>LOGINNAME']) spawnSync(process.execPath, [SERVER, 'add-user', name], { env, input: 'some-password\n' });
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
      proc.stdout.on('data', d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }); proc.on('exit', c => rej(new Error('server stopped (' + c + '): ' + out))); });

    const api = async (cookie, method, url, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) };
    };
    const signIn = async name => { const r = await api('', 'POST', '/api/login', { name, password: 'some-password' }); assert.strictEqual(r.status, 200);
      return { cookie: r.cookie, uid: (await api(r.cookie, 'GET', '/api/me')).data.uid }; };
    const ana = await signIn('Ana'), ben = await signIn('Ben');
    const put = async (who, ...ops) => { const r = await api(who.cookie, 'POST', '/api/write', { ops }); assert.strictEqual(r.status, 200, JSON.stringify(ops[0].path) + ' ' + JSON.stringify(r.data)); };
    const set = (path, data) => ({ op: 'set', path, data });
    const now = Date.now(), day = new Date().toISOString().slice(0, 10), G = 'g_xss', A = ana.uid, B = ben.uid;

    await put(ana, set('groups/' + G, { name: evil('GROUPNAME'), createdBy: A, createdAt: now }));
    await put(ana, set(`groups/${G}/members/${A}`, { kind: 'account', active: true, joinedAt: now }), set(`groups/${G}/members/${B}`, { kind: 'account', active: true, joinedAt: now }),
      set(`groups/${G}/members/guest_x`, { kind: 'guest', name: evil('GUESTNAME'), active: true }));
    await put(ben, set('people/' + B, { nickname: evil('NICKBEN'), etransfer: evil('ETRANSFER'), joinedAt: now }));
    await put(ana, set('people/' + A, { nickname: evil('NICKANA'), joinedAt: now }));
    await put(ana, set('expenses/e_x1', { kind: 'expense', title: evil('EXPTITLE'), note: evil('EXPNOTE'), amount: 3000, paidBy: A, split: { [A]: 1000, [B]: 1000, guest_x: 1000 },
      splitMode: 'items', splitInput: { items: [{ n: evil('ITEMNAME'), p: 3000, ids: [A, B, 'guest_x'] }], tax: 0, tip: 0 },
      people: [A, B, 'guest_x'], groupId: G, date: day, createdAt: now, addedBy: A, category: 'groceries' }));
    await put(ben, set('expenses/e_x1/comments/c1', { text: evil('COMMENT'), by: B, at: now }));
    await put(ben, set('expenses/p_x1', { kind: 'payment', from: B, to: A, amount: 500, note: evil('PAYNOTE'), date: day, createdAt: now + 1, addedBy: B, people: [B, A], groupId: G, confirmed: false }));
    await put(ana, set('chores/c_x1', { groupId: G, title: evil('CHORE'), every: 7, order: [A, B], due: day, turn: 0, createdAt: now, addedBy: A }));
    await put(ana, set('recurring/r_x1', { title: evil('BILL'), amount: 8000, paidBy: A, groupId: G, splitMode: 'equal', splitInput: { ids: [A, B] }, every: 'month', day: 1, category: 'internet' }));
    await put(ben, set('expenses/e_x2', { kind: 'expense', title: evil('DIRECTTITLE'), amount: 6000, paidBy: B, split: { [A]: 5000, [B]: 1000 }, splitMode: 'exact', people: [A, B], groupId: null, date: day, createdAt: now, addedBy: B }));
    await put(ana, set(`data/users/${A}/root/friends/f_x`, { kind: 'contact', name: evil('FRIENDNAME'), addedAt: now }));
    await put(ana, set(`data/users/${A}/root/entries/e_x3`, { kind: 'expense', title: evil('PRIVTITLE'), amount: 1000, paidBy: A, split: { [A]: 500, f_x: 500 }, splitMode: 'exact', people: [A, 'f_x'], friendId: 'f_x', date: day, createdAt: now, addedBy: A }));

    browser = await pw.chromium.launch();
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: ana.cookie.split('=')[0], value: ana.cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    const seen = new Set(), pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', d => d.dismiss().catch(() => {}));
    const look = async where => {
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ xss: window.__xss, text: document.body.innerText + ' ' + [...document.querySelectorAll('input,textarea')].map(i => i.value).join(' ') }));
      assert.strictEqual(r.xss, undefined, 'script-like text ran on: ' + where);
      for (const f of FIELDS) if (r.text.includes(f)) seen.add(f);
    };
    const home = async () => { await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForSelector('#tabs:not([hidden])', { timeout: 15000 }); await look('home'); };
    const clickAll = async (sel, where, then) => {
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) {
        const el = page.locator(sel).nth(i); if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 5000 }).catch(() => {}); await look(`${where} ${sel} #${i}`);
        if (then) await then(); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      }
    };

    await home();
    await page.click('#profBtn'); await look('your profile');
    // the owner's screen lists everyone by their sign-in name
    await page.click('#adminBtn'); await page.waitForSelector('[data-adm]', { timeout: 10000 }); await look('owner screen');
    await clickAll('[data-adm]', 'owner screen');
    await home();
    for (const tab of ['home', 'groups', 'friends', 'activity']) {
      await page.click(`[data-tab="${tab}"]`); await look(tab);
      await clickAll('[data-exp]', tab);
      await clickAll('[data-bill]', tab);
      await clickAll('[data-chore]', tab);
    }
    // Each group and each friend page, and everything that opens from them
    for (const [tab, sel] of [['groups', '[data-group]'], ['friends', '[data-friend]']]) {
      await home(); await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(200);
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) {
        await home(); await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(200);
        await page.locator(sel).nth(i).click(); await look(`${tab} page #${i}`);
        await clickAll('[data-exp]', `${tab} page #${i}`, async () => {
          // the edit form of an entry shows its title, note and items in boxes
          const edit = page.getByRole('button', { name: /^Edit$/ }).first();
          if (await edit.isVisible().catch(() => false)) { await edit.click().catch(() => {}); await look(`${tab} page #${i} edit`); await page.keyboard.press('Escape'); }
        });
        await clickAll('[data-bill]', `${tab} page #${i}`);
        await clickAll('[data-chore]', `${tab} page #${i}`);
        // sheets opened by plain buttons on the page: settle up, balances, members, group settings
        const labels = await page.locator('#app button').evaluateAll(bs => bs.map(b => b.innerText.trim()).filter(t => /settle|balance|member|people|setting|record|pay|remind|more|all|summary|stats/i.test(t) && !/delete|remove|leave|archive|sign out/i.test(t)));
        for (const l of [...new Set(labels)].slice(0, 12)) {
          const b = page.locator('#app button', { hasText: l }).first();
          if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 5000 }).catch(() => {}); await look(`${tab} page #${i} "${l}"`); await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
        }
      }
    }
    assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
    // The walk must actually reach the text; otherwise a pass means nothing.
    const missing = FIELDS.filter(f => !seen.has(f));
    assert.deepStrictEqual(missing, [], 'these fields were never seen on screen, so they were not checked: ' + missing.join(', '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone;
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
