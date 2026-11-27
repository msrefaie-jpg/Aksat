// اختبار سلوك المزامنة في الواجهة بخادم وهمي (بيانات اصطناعية فقط)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = process.argv[2] || '/home/user/Aksat/public';
const srv = http.createServer((q, s) => {
  let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(d); });
}).listen(8765);
const U = (n, extra) => ({ units: Array.from({ length: n }, (_, k) => ({ id: 'u' + k, name: 'وحدة ' + k, installments: [{ id: 'i' + k, amount: 1000, dueDate: '2027-01-0' + (k + 1), paid: false }], ...(extra || {}) })), updatedAt: '2026-01-01T00:00:00Z', _prefsInit: true, autoRate: true });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

async function scenario(name, { remote, getFails, local, base, dirty }, body) {
  const b = await chromium.launch(); const p = await b.newPage();
  const log = { puts: [], gets: 0 };
  const ctl = { getFails: getFails || 0, remote, putStatus: 200, putBody: null };
  p.on('pageerror', e => console.log('   PAGEERR', e.message));
  await p.route(/gstatic|googleapis|firebase|er-api/, r => r.abort());
  await p.route(/\/api\//, async r => {
    const req = r.request(); const url = req.url();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, body: '{}' });
    if (url.includes('/api/portfolios')) return r.fulfill({ status: 200, body: JSON.stringify({ portfolios: [{ key: 'uid1', role: 'owner', ownerEmail: 'a@x.test', self: true }] }) });
    if (url.includes('/api/state') && req.method() === 'GET') { log.gets++;
      if (ctl.getFails > 0) { ctl.getFails--; return r.fulfill({ status: 500, body: '{"error":"x"}' }); }
      return r.fulfill({ status: 200, body: JSON.stringify({ state: ctl.remote || null, updatedAt: ctl.remote ? '2026-02-02T00:00:00Z' : null, role: 'owner' }) }); }
    if (url.includes('/api/state') && req.method() === 'PUT') { const bd = JSON.parse(req.postData()); log.puts.push(bd);
      if (ctl.putStatus === 409 && !bd.allowEmpty) return r.fulfill({ status: 409, body: '{"code":"EMPTY_OVERWRITE"}' });
      return r.fulfill({ status: 200, body: JSON.stringify({ ok: true, updatedAt: '2026-03-03T00:00:00Z' }) }); }
    if (url.includes('/api/rate')) return r.fulfill({ status: 200, body: JSON.stringify({ rate: 14.5, source: 'test' }) });
    return r.fulfill({ status: 500, body: '{}' });
  });
  await p.goto('http://localhost:8765/index.html');
  await p.evaluate(({ local, base, dirty }) => {
    localStorage.setItem('aksat_onboarded', '1');
    if (local) localStorage.setItem('aksat.state.v2:uid1', JSON.stringify(local));
    if (base) localStorage.setItem('aksat_base:uid1', base);
    if (dirty) localStorage.setItem('aksat_dirty:uid1', '1');
  }, { local, base, dirty });
  await p.waitForTimeout(500);
  await p.evaluate(() => onAuthChanged({ uid: 'uid1', email: 'a@x.test', getIdToken: async () => 'tok' }));
  await p.waitForTimeout(1500);
  console.log('▶', name);
  await body(p, log, ctl);
  await b.close();
}

(async () => {
  await scenario('جهاز جديد: فشل التحميل الأول ثم تعديل', { remote: U(2), getFails: 5 }, async (p, log, ctl) => {
    await p.evaluate(() => { state.units.push({ id: 'n1', name: 'جديد', installments: [] }); persist(); });
    await p.waitForTimeout(1200);
    ok(log.puts.length === 0, 'DEC-002: لا PUT بعد فشل التحميل (PUTs=' + log.puts.length + ')');
    ctl.getFails = 0; await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await p.waitForTimeout(1500);
    const conflict = await p.evaluate(() => !document.querySelector('#conflictModal').classList.contains('hidden'));
    ok(log.puts.length === 0 && conflict, 'DEC-002/004: عند عودة الخادم يُعرض حوار التعارض ولا رفع تلقائي');
  });
  await scenario('جهاز قديم ببيانات محلية قديمة وفشل التحميل + تحديث سعر', { remote: U(3), getFails: 5, local: U(1), base: '2026-01-01T00:00:00Z' }, async (p, log) => {
    await p.evaluate(() => fetchAutoRate(false)); await p.waitForTimeout(1500);
    ok(log.puts.length === 0, 'DEC-002/004: تحديث السعر على جهاز قديم لا يرفع نسخة قديمة فوق السحابة');
  });
  await scenario('تشغيل عادي: تحميل ناجح ثم تعديل', { remote: U(2) }, async (p, log) => {
    const n = await p.evaluate(() => state.units.length);
    ok(n === 2, 'اعتماد نسخة السحابة عند التحميل');
    await p.evaluate(() => fetchAutoRate(false)); await p.waitForTimeout(1200);
    ok(log.puts.length === 0, 'DEC-004: فتح التطبيق دون تعديل لا ينتج PUT');
    await p.evaluate(() => { state.units[0].name = 'معدّل'; persist(); }); await p.waitForTimeout(1200);
    ok(log.puts.length === 1 && log.puts[0].state.units[0].name === 'معدّل', 'المزامنة العادية ما زالت تعمل (PUT واحد)');
  });
  await scenario('تعارض: تعديل محلي + تغيّر السحابة', { remote: U(3), local: U(1), base: '2026-01-01T00:00:00Z', dirty: true }, async (p, log) => {
    const conflict = await p.evaluate(() => !document.querySelector('#conflictModal').classList.contains('hidden'));
    ok(conflict, 'يظهر حوار التعارض');
    await p.evaluate(() => { persist(); fetchAutoRate(false); }); await p.waitForTimeout(1500);
    ok(log.puts.length === 0, 'DEC-004: لا PUT أثناء حوار التعارض');
    await p.evaluate(() => resolveConflict(false)); await p.waitForTimeout(800);
    const n = await p.evaluate(() => state.units.length);
    ok(log.puts.length === 0 && n === 3, 'اختيار نسخة السحابة يُحترم ولا يُنقض برفع');
  });
  await scenario('رفض الخادم للتفريغ (409) ثم إلغاء', { remote: U(2) }, async (p, log, ctl) => {
    ctl.putStatus = 409; p.once('dialog', d => d.dismiss());
    await p.evaluate(() => { state.units = []; persist(); }); await p.waitForTimeout(2000);
    const n = await p.evaluate(() => state.units.length);
    ok(n === 2 && !log.puts.some(x => x.allowEmpty), 'DEC-002: عند الرفض والإلغاء تُستعاد بيانات السحابة');
  });
  await scenario('رفض الخادم للتفريغ (409) ثم تأكيد', { remote: U(2) }, async (p, log, ctl) => {
    ctl.putStatus = 409; p.once('dialog', d => d.accept());
    await p.evaluate(() => { state.units = []; persist(); }); await p.waitForTimeout(2000);
    ok(log.puts.some(x => x.allowEmpty === true), 'DEC-002: التأكيد الصريح يرسل allowEmpty');
  });
  await scenario('حذف قسط', { remote: U(1) }, async (p) => {
    p.once('dialog', d => d.dismiss());
    await p.evaluate(() => deleteInstallment('u0', 'i0'));
    let n = await p.evaluate(() => state.units[0].installments.length);
    ok(n === 1, 'DEC-005: إلغاء التأكيد يبقي القسط');
    p.once('dialog', d => d.accept());
    await p.evaluate(() => deleteInstallment('u0', 'i0'));
    n = await p.evaluate(() => state.units[0].installments.length);
    ok(n === 0, 'DEC-005: تأكيد الحذف يحذف القسط');
  });
  const evil = U(1, { type: 'evil' }); evil.customTypes = [{ key: 'evil" onmouseover="window.__x2=1', icon: '<img src=x onerror="window.__xss=1">', label: 'خبيث' }];
  evil.units[0].type = 'evil" onmouseover="window.__x2=1';
  await scenario('أيقونة تصنيف خبيثة', { remote: evil }, async (p) => {
    await p.evaluate(() => { document.querySelector('[data-view="units"]')?.click(); renderAll(); });
    await p.waitForTimeout(800);
    const x = await p.evaluate(() => ({ a: window.__xss, imgs: document.querySelectorAll('img[src="x"]').length }));
    ok(!x.a && x.imgs === 0, 'DEC-006: الأيقونة تُعرض نصاً ولا تُنفَّذ');
  });
  console.log(`\n${pass} نجح، ${fail} فشل`); srv.close(); process.exit(fail ? 1 : 0);
})();
