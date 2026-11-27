// اختبارات وحدة لدالة جدولة التذكيرات (DEC-019) — بيانات اصطناعية فقط.
// التشغيل: TZ=Africa/Cairo node tests/e01/reminders.test.js   (ثم TZ=Asia/Riyadh)
const { computeReminders } = require('../../public/reminders.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + m); };
const BAN = /[0-9٠-٩]{3,}|£|ج\.م|EGP|SAR|ر\.س/;
const U = (insts, name) => ({ id: 'u' + Math.random(), name: name || 'شقة التجمع', installments: insts });
const I = (id, due, amount, paid) => ({ id, dueDate: due, amount: amount || 150000, paid: !!paid });
const hm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const now = new Date(2026, 10, 27, 10, 0); // 27 نوفمبر 2026 الساعة 10 صباحاً

// 1) يوم الاستحقاق 09:00
let r = computeReminders([U([I('a', '2026-12-10')])], now);
let due = r.find(x => x.kind === 'due');
ok(due && ymd(due.at) === '2026-12-10' && hm(due.at) === '9:00', 'تذكير يوم الاستحقاق الساعة 09:00 محلياً');
ok(r.some(x => x.kind === 'soon7' && ymd(x.at) === '2026-12-03') && r.some(x => x.kind === 'soon1' && ymd(x.at) === '2026-12-09'), 'تذكيرا قبل 7 أيام وقبل يوم');
ok(r.filter(x => x.kind === 'over').map(x => ymd(x.at)).join() === '2026-12-11,2026-12-13,2026-12-17', 'تذكيرات التأخر بعد 1 و3 و7 أيام');
// 2) المسدّد لا يُجدول
r = computeReminders([U([I('a', '2026-12-10', 1, true)])], now);
ok(r.length === 1 && r[0].kind === 'guardian', 'القسط المسدّد لا يُجدول (يبقى الحارس فقط)');
// 3) المحذوف (غير موجود في البيانات) لا يُجدول
r = computeReminders([U([])], now);
ok(r.length === 1, 'بلا أقساط: الحارس فقط');
// 4) متأخر قبل اليوم: تذكيرات التأخر المستقبلية فقط
r = computeReminders([U([I('a', '2026-11-25')])], now);
ok(r.filter(x => x.kind === 'over').map(x => ymd(x.at)).join() === '2026-11-28,2026-12-02', 'قسط متأخر: تُجدول تذكيرات التأخر المتبقية فقط');
// 5) اليوم نفسه بعد 09:00 لا يُجدول للماضي
r = computeReminders([U([I('a', '2026-11-27')])], now);
ok(!r.some(x => x.at <= now), 'لا يوجد أي إشعار في الماضي');
// 6) نهاية الشهر
r = computeReminders([U([I('a', '2027-03-31')])], now);
ok(r.some(x => x.kind === 'soon7' && ymd(x.at) === '2027-03-24') && r.some(x => x.kind === 'over' && ymd(x.at) === '2027-04-01'), 'نهاية الشهر: الإزاحة صحيحة (24 مارس، 1 أبريل)');
// 7) يوم تغيّر التوقيت الصيفي المصري (آخر جمعة في أبريل 2027 = 30 أبريل) وما حوله
r = computeReminders([U([I('a', '2027-04-30'), I('b', '2027-05-01'), I('c', '2027-10-29')])], now);
ok(r.filter(x => x.kind !== 'guardian').every(x => x.at.getHours() === 9 && x.at.getMinutes() === 0), 'كل المواعيد 09:00 حتى أيام تغيّر التوقيت الصيفي');
// 8) تاريخ غير صالح يُتجاهل دون استثناء
r = computeReminders([U([I('a', '2026-02-30'), I('b', 'abc'), I('c', '')])], now);
ok(r.length === 1, 'التواريخ غير الصالحة تُتجاهل');
// 9) أكثر من 64 حدثاً: الحد 60، الأقرب أولاً، والحارس موجود
const many = []; for (let k = 0; k < 40; k++) { const d = new Date(2026, 11, 1 + k * 3); many.push(I('m' + k, ymd(d))); }
r = computeReminders([U(many)], now);
const ev = r.filter(x => x.kind !== 'guardian');
ok(r.length === 60 && r.filter(x => x.kind === 'guardian').length === 1, '240 حدثاً → 60 إشعاراً بالضبط مع الحارس (' + r.length + ')');
ok(ev.every((x, k) => k === 0 || ev[k - 1].at <= x.at), 'الأقرب أولاً');
ok(new Set(r.map(x => x.id)).size === r.length && r.every(x => Number.isInteger(x.id) && x.id > 0), 'معرّفات فريدة صحيحة');
// 10) التجميع: قسطان في اليوم نفسه = إشعار واحد
r = computeReminders([U([I('a', '2026-12-10')]), U([I('b', '2026-12-10')], 'فيلا')], now);
due = r.filter(x => x.kind === 'due');
ok(due.length === 1 && due[0].count === 2 && /2 أقساط/.test(due[0].body), 'قسطان في اليوم نفسه يُجمعان في إشعار واحد');
// 11) DEC-020: لا مبالغ ولا عملات ولا أسماء وحدات افتراضياً
r = computeReminders([U([I('a', '2026-12-10', 987654)], 'شقة التجمع'), U([I('b', '2026-12-20', 42875)], '3Sides')], now);
ok(r.every(x => !BAN.test(x.title + x.body)), 'الافتراضي: لا يطابق أي نص التعبير الممنوع');
ok(r.every(x => !/التجمع|3Sides/.test(x.title + x.body)), 'الافتراضي: لا يظهر اسم أي وحدة');
// 12) خيار إظهار المبلغ: المبلغ بالعملة الصريحة، دون اسم الوحدة
r = computeReminders([U([I('a', '2026-12-10', 987654)], 'شقة التجمع')], now, { showAmount: true });
due = r.find(x => x.kind === 'due');
ok(/987,654 ج\.م/.test(due.body) && !/التجمع|£/.test(due.body), 'مع الخيار: يظهر المبلغ بـ ج.م دون اسم الوحدة');
// 13) الحارس بعد 14 يوماً الساعة 09:00
r = computeReminders([], now);
ok(r[0].kind === 'guardian' && ymd(r[0].at) === '2026-12-11' && hm(r[0].at) === '9:00', 'الحارس بعد 14 يوماً الساعة 09:00');
console.log(`\n[TZ=${process.env.TZ || 'default'}] ${pass} نجح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
