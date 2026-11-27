/* =====================================================================
   حساب مواعيد تذكيرات الأقساط المحلية (DEC-019) — دالة نقية بلا اعتماد على الواجهة.
   تُستخدم في المتصفح (window.AksatReminders) وفي اختبارات Node (module.exports).

   القواعد:
   - لكل قسط غير مسدّد بتاريخ صالح: قبل الاستحقاق بـ 7 أيام، وقبله بيوم، ويوم الاستحقاق،
     وبعده بـ 1 و3 و7 أيام إن بقي غير مسدّد — كلها الساعة 09:00 بالتوقيت المحلي للجهاز.
   - تُجمَّع الأقساط التي تقع في اليوم نفسه وبالنوع نفسه في إشعار واحد.
   - الأقرب أولاً، وبحد أقصى (maxTotal - 1) إشعاراً + إشعار «حارس» واحد.
   - النص عام افتراضياً: لا مبالغ ولا أسماء وحدات ولا عملات (DEC-020).
     ويُضاف المبلغ فقط إن فعّل المستخدم الخيار (showAmount) بالعملة الصريحة ج.م.
   ===================================================================== */
(function (root) {
  'use strict';

  var HOUR = 9;
  var STEPS = [
    { off: -7, kind: 'soon7' },
    { off: -1, kind: 'soon1' },
    { off: 0, kind: 'due' },
    { off: 1, kind: 'over' },
    { off: 3, kind: 'over' },
    { off: 7, kind: 'over' },
  ];

  function parseDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    var dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null; // تاريخ غير صالح
    return { y: y, m: mo, d: d };
  }
  // الساعة 09:00 بالتوقيت المحلي بعد إزاحة أيام — آمن مع التوقيت الصيفي ونهايات الأشهر
  function at9(day, off) { return new Date(day.y, day.m, day.d + off, HOUR, 0, 0, 0); }
  function dayKey(dt) { return dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate(); }

  function textFor(kind, count) {
    var many = count > 1;
    switch (kind) {
      case 'soon7': return many ? 'لديك ' + count + ' أقساط مستحقة خلال أسبوع' : 'لديك قسط مستحق خلال أسبوع';
      case 'soon1': return many ? 'لديك ' + count + ' أقساط مستحقة غداً' : 'لديك قسط مستحق غداً';
      case 'due': return many ? 'لديك ' + count + ' أقساط مستحقة اليوم' : 'لديك قسط مستحق اليوم';
      default: return many ? 'لديك ' + count + ' أقساط متأخرة عن موعدها' : 'لديك قسط متأخر عن موعده';
    }
  }

  /**
   * @param {Array} units   وحدات المحفظة (كل وحدة فيها installments)
   * @param {Date}  now     الوقت الحالي
   * @param {Object} opts   { showAmount, fmtAmount(n), maxTotal=60, guardianDays=14 }
   * @returns {Array<{id:number, at:Date, title:string, body:string, kind:string, count:number}>}
   */
  function computeReminders(units, now, opts) {
    opts = opts || {};
    var maxTotal = opts.maxTotal || 60;
    var guardianDays = opts.guardianDays || 14;
    var fmtAmount = opts.fmtAmount || function (n) { return Math.round(n).toLocaleString('en-US') + ' ج.م'; };
    var nowMs = now.getTime();
    var groups = {};

    (units || []).forEach(function (u) {
      (u && u.installments || []).forEach(function (i) {
        if (!i || i.paid) return;
        var day = parseDay(i.dueDate);
        if (!day) return;
        var amount = Number(i.amount) || 0;
        STEPS.forEach(function (s) {
          var at = at9(day, s.off);
          if (at.getTime() <= nowMs) return;
          var key = dayKey(at) + '|' + s.kind;
          var g = groups[key] || (groups[key] = { at: at, kind: s.kind, count: 0, sum: 0, ids: {} });
          if (g.ids[i.id || (u.id + ':' + i.dueDate)]) return; // لا ازدواج للقسط نفسه في المجموعة
          g.ids[i.id || (u.id + ':' + i.dueDate)] = 1;
          g.count += 1; g.sum += amount;
        });
      });
    });

    var list = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return a.at - b.at; })
      .slice(0, Math.max(0, maxTotal - 1))
      .map(function (g) {
        var body = textFor(g.kind, g.count);
        if (opts.showAmount && g.sum > 0) body += ' — ' + fmtAmount(g.sum);
        return { at: g.at, kind: g.kind, count: g.count, title: 'أقساط — تذكير', body: body + '. افتح التطبيق للتفاصيل.' };
      });

    // الإشعار الحارس: يُدفع للأمام عند كل إعادة جدولة؛ إن وصل فالتذكيرات لم تُحدَّث منذ مدة
    var today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    list.push({
      at: at9(today, guardianDays), kind: 'guardian', count: 0,
      title: 'أقساط',
      body: 'لم تُحدَّث تذكيراتك منذ ' + guardianDays + ' يوماً، افتح التطبيق لتحديثها.',
    });

    list.forEach(function (x, k) { x.id = k + 1; });
    return list;
  }

  var api = { computeReminders: computeReminders, HOUR: HOUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AksatReminders = api;
})(typeof window !== 'undefined' ? window : this);
