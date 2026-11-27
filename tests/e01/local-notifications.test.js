// اختبار تكامل التذكيرات المحلية في الواجهة مع إضافة LocalNotifications محاكاة (بيانات اصطناعية)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = process.argv[2] || '/home/user/Aksat/public';
const srv = http.createServer((q, s) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(d); }); }).listen(8767);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + m); };
const BAN = /[0-9٠-٩]{3,}|£|ج\.م|EGP|SAR|ر\.س/;
const day = (k) => { const d = new Date(); d.setDate(d.getDate() + k); return d.toISOString().slice(0, 10); };
const REMOTE = { _prefsInit: true, autoRate: false, units: [
  { id: 'u1', name: 'شقة التجمع', installments: [{ id: 'i1', amount: 150000, dueDate: day(10), paid: false }, { id: 'i2', amount: 42875, dueDate: day(20), paid: false }, { id: 'i3', amount: 9000, dueDate: day(-30), paid: true }] },
  { id: 'u2', name: 'فيلا الساحل', installments: Array.from({ length: 30 }, (_, k) => ({ id: 'v' + k, amount: 1000 + k, dueDate: day(30 + k * 5), paid: false })) },
] };
async function boot({ plugin = true, native = true } = {}) {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route(/gstatic|googleapis|firebase|er-api/, r => r.abort());
  await p.route(/\/api\//, async r => { const q = r.request(), u = q.url();
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 200, body: '{}' });
    if (u.includes('/api/portfolios')) return r.fulfill({ status: 200, body: JSON.stringify({ portfolios: [{ key: 'uid1', role: 'owner', ownerEmail: 'a@x.test', self: true }, { key: 'uid2', role: 'editor', ownerEmail: 'b@x.test', self: false }] }) });
    if (u.includes('/api/state') && q.method() === 'GET') return r.fulfill({ status: 200, body: JSON.stringify({ state: REMOTE, updatedAt: '2026-01-01T00:00:00Z', role: 'owner' }) });
    if (u.includes('/api/state') && q.method() === 'PUT') return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, updatedAt: '2026-01-02T00:00:00Z' }) });
    return r.fulfill({ status: 404, body: '{}' }); });
  await p.addInitScript(({ plugin, native }) => {
    window.__ln = { pending: [], reqPerm: 0, perm: 'prompt' };
    const LN = {
      checkPermissions: async () => ({ display: window.__ln.perm }),
      requestPermissions: async () => { window.__ln.reqPerm++; window.__ln.perm = 'granted'; return { display: 'granted' }; },
      getPending: async () => ({ notifications: window.__ln.pending.map(n => ({ id: n.id })) }),
      cancel: async ({ notifications }) => { const ids = new Set(notifications.map(n => n.id)); window.__ln.pending = window.__ln.pending.filter(n => !ids.has(n.id)); },
      schedule: async ({ notifications }) => { notifications.forEach(n => { window.__ln.pending = window.__ln.pending.filter(x => x.id !== n.id); window.__ln.pending.push({ id: n.id, title: n.title, body: n.body, at: new Date(n.schedule.at).toISOString() }); }); },
    };
    window.Capacitor = { isNativePlatform: () => native, isPluginAvailable: (n) => plugin && n === 'LocalNotifications', Plugins: plugin ? { LocalNotifications: LN } : {} };
    localStorage.setItem('aksat_onboarded', '1');
  }, { plugin, native });
  await p.goto('http://localhost:8767/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => onAuthChanged({ uid: 'uid1', email: 'a@x.test', getIdToken: async () => 't' }));
  await p.waitForTimeout(1800);
  return { b, p, errs };
}
const pend = (p) => p.evaluate(() => window.__ln.pending);
(async () => {
  let { b, p, errs } = await boot();
  ok((await p.evaluate(() => window.__ln.reqPerm)) === 0 && (await pend(p)).length === 0, 'لا طلب إذن ولا جدولة عند الإقلاع قبل تفعيل المفتاح');
  await p.evaluate(() => openAccountModal && openAccountModal());
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !document.querySelector('#lnRow').classList.contains('hidden')), 'صف التذكيرات ظاهر في التطبيق الأصلي');
  await p.evaluate(() => { const t = document.querySelector('#lnToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(800);
  let L = await pend(p);
  ok((await p.evaluate(() => window.__ln.reqPerm)) === 1, 'طلب الإذن مرة واحدة عند تفعيل المفتاح');
  ok(L.length > 0 && L.length <= 60, 'عدد المجدول ' + L.length + ' (≤ 60)');
  ok(L.some(n => /لم تُحدَّث تذكيراتك/.test(n.body)), 'الإشعار الحارس موجود');
  ok(L.every(n => !BAN.test(n.title + n.body) && !/التجمع|الساحل/.test(n.body)), 'DEC-020: لا مبالغ ولا عملات ولا أسماء وحدات افتراضياً');
  ok(L.every(n => new Date(n.at).getHours() === 9), 'كل المواعيد الساعة 09:00 محلياً');
  ok(await p.evaluate(() => /المجدول: \d+/.test(document.querySelector('#lnInfo').textContent)), 'الإعدادات تعرض وقت آخر جدولة والعدد');
  // سداد قسط: يختفي من المجدول
  const dueI1 = (arr) => arr.filter(n => /مستحق اليوم/.test(n.body) && new Date(n.at).toDateString() === new Date(Date.now() + 10 * 86400000).toDateString()).length;
  const before = dueI1(L);
  await p.evaluate(() => { const i = state.units[0].installments.find(x => x.id === 'i1'); i.paid = true; persist(); });
  await p.waitForTimeout(1200);
  L = await pend(p);
  ok(before === 1 && dueI1(L) === 0, 'بعد السداد يختفي تذكير يوم استحقاق القسط (قبل: ' + before + '، بعد: ' + dueI1(L) + ')');
  // خيار المبلغ
  await p.evaluate(() => { const t = document.querySelector('#lnAmountToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(800);
  L = await pend(p);
  ok(L.some(n => /42,875 ج\.م/.test(n.body)) && L.every(n => !/التجمع|الساحل|£/.test(n.body)), 'مع الخيار: يظهر المبلغ بـ ج.م دون اسم الوحدة');
  // الإشعار التجريبي يبقى بعد إعادة الجدولة
  await p.evaluate(() => sendLocalTestReminder()); await p.waitForTimeout(200);
  await p.evaluate(() => persist()); await p.waitForTimeout(1200);
  ok((await pend(p)).some(n => n.id === 99999), 'الإشعار التجريبي لا يُلغى بإعادة الجدولة');
  // محفظة مشتركة: لا جدولة لها
  const snap = JSON.stringify(await pend(p));
  await p.evaluate(() => { activePortfolio = portfolios.find(x => !x.self); state.units.push({ id: 'x', name: 'مشترك', installments: [{ id: 'x1', amount: 5, dueDate: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10), paid: false }] }); persist(); });
  await p.waitForTimeout(1200);
  ok(JSON.stringify(await pend(p)) === snap, 'عرض محفظة مشتركة لا يغيّر التذكيرات ولا يجدول لها');
  // الخروج
  await p.evaluate(() => { activePortfolio = portfolios.find(x => x.self); });
  await p.evaluate(() => doLogout()); await p.waitForTimeout(500);
  ok((await pend(p)).length === 0, 'بعد الخروج: لا تذكيرات معلّقة');
  ok(errs.length === 0, 'لا أخطاء JavaScript' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  // بناء قديم بلا الإضافة
  ({ b, p, errs } = await boot({ plugin: false }));
  await p.evaluate(() => openAccountModal && openAccountModal()); await p.waitForTimeout(300);
  const old = await p.evaluate(() => ({ t: document.querySelector('#lnToggle').disabled, msg: document.querySelector('#lnInfo').textContent }));
  ok(old.t && /حدّث التطبيق من Xcode/.test(old.msg) && errs.length === 0, 'بناء قديم بلا الإضافة: رسالة بديلة ولا استثناء');
  await b.close();
  // نسخة الويب: الصف مخفي
  ({ b, p, errs } = await boot({ plugin: false, native: false }));
  await p.evaluate(() => openAccountModal && openAccountModal()); await p.waitForTimeout(300);
  ok(await p.evaluate(() => document.querySelector('#lnRow').classList.contains('hidden')) && errs.length === 0, 'نسخة الويب: صف التذكيرات المحلية مخفي');
  await b.close();
  console.log(`\n${pass} نجح، ${fail} فشل`); srv.close(); process.exit(fail ? 1 : 0);
})();
