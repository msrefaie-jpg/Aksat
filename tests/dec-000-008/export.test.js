const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = '/home/user/Aksat/public';
const srv = http.createServer((q, s) => { let f = path.join(ROOT, q.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); s.end(d); }); }).listen(8766);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✅' : '❌', m); };
(async () => {
  const b = await chromium.launch();
  const mk = async () => { const ctx = await b.newContext({ acceptDownloads: true }); const p = await ctx.newPage();
    await p.route(/gstatic|googleapis|firebase|er-api|\/api\//, r => r.abort());
    await p.goto('http://localhost:8766/index.html'); await p.waitForTimeout(800);
    await p.evaluate(() => { state = withDefaults({ units: [{ id: 'u1', name: 'شقة', installments: [{ id: 'i1', amount: 1000, dueDate: '2027-01-01', paid: false }] }] }); });
    return p; };
  // 1) متصفح عادي: تنزيل
  let p = await mk();
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.evaluate(() => exportData())]);
  const fn = dl.suggestedFilename(); const content = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(/^aksat-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fn) && content.units[0].name === 'شقة', 'المتصفح: تنزيل ملف JSON صحيح (' + fn + ')');
  const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.evaluate(() => exportCSV())]);
  ok(/\.csv$/.test(dl2.suggestedFilename()), 'المتصفح: تنزيل CSV');
  // 2) مشاركة المتصفح
  p = await mk();
  const r2 = await p.evaluate(async () => { let got = null; navigator.canShare = () => true; navigator.share = async (d) => { got = d.files[0].name; };
    await exportData(); return got; });
  ok(r2 && r2.endsWith('.json'), 'مشاركة المتصفح: تُستخدم إن كانت متاحة');
  // 3) التطبيق الأصلي (Capacitor) — إضافات محاكاة
  p = await mk();
  const r3 = await p.evaluate(async () => { const calls = [];
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      Filesystem: { writeFile: async (o) => { calls.push(['write', o.path, o.directory, o.encoding, JSON.parse(o.data).units.length]); return { uri: 'file:///cache/' + o.path }; } },
      Share: { share: async (o) => { calls.push(['share', o.url]); } } } };
    await exportData(); return calls; });
  ok(r3.length === 2 && r3[0][0] === 'write' && r3[0][2] === 'CACHE' && r3[0][4] === 1 && r3[1][1].startsWith('file:///cache/aksat-backup'), 'التطبيق الأصلي: كتابة الملف ثم فتح نافذة المشاركة');
  // 4) إلغاء المستخدم للمشاركة الأصلية لا يُسقط التطبيق ولا ينزّل
  p = await mk();
  const r4 = await p.evaluate(async () => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Filesystem: { writeFile: async () => ({ uri: 'file:///x' }) }, Share: { share: async () => { throw new Error('Share canceled'); } } } };
    return await saveFile('x.json', '{}', 'application/json'); });
  console.log('r4=', JSON.stringify(r4)); ok(r4 === false, 'التطبيق الأصلي: إلغاء المشاركة يُعامل بهدوء');
  console.log(`\n${pass} نجح، ${fail} فشل`); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
})();
