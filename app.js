/* ==========================================================================
   أقساط — إدارة الالتزامات المالية (الأقساط العقارية)
   تطبيق يعمل بالكامل على الجهاز، يحفظ البيانات محلياً (localStorage).
   العملة الأساسية: الجنيه المصري (ج.م) — مع عرض المقابل بالريال السعودي (﷼).
   ========================================================================== */

'use strict';

const STORE_KEY = 'aksat.data.v1';
const DEFAULT_RATE = 13.3; // ١ ريال = كم جنيه (قابل للتعديل)

/* ---------- الحالة ---------- */
let state = {
  rate: DEFAULT_RATE,          // عدد الجنيهات لكل ريال واحد
  units: [],                    // [{ id, name, project, totalPrice, downPayment, notes, installments: [] }]
};

/* installment: { id, amount, dueDate (YYYY-MM-DD), label, paid (bool), paidDate } */

/* ---------- أدوات مساعدة ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function fmtEGP(n) {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 0 }).format(Math.round(n || 0)) + ' ج.م';
}
function fmtSAR(n) {
  const sar = (n || 0) / state.rate;
  return '﷼ ' + new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 0 }).format(Math.round(sar));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
function monthKey(iso) {
  const d = new Date(iso + 'T00:00:00');
  return new Intl.DateTimeFormat('ar-EG', { month: 'long', year: 'numeric' }).format(d);
}
function daysBetween(iso) {
  const t = new Date(todayISO() + 'T00:00:00');
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

/* ---------- التخزين ---------- */
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('تعذّر الحفظ', e); }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = Object.assign({ rate: DEFAULT_RATE, units: [] }, parsed);
      if (!state.rate || state.rate <= 0) state.rate = DEFAULT_RATE;
    }
  } catch (e) { console.warn('تعذّر التحميل', e); }
}

/* ---------- الحسابات ---------- */
function allInstallments() {
  const list = [];
  state.units.forEach(u => (u.installments || []).forEach(i => list.push({ ...i, unit: u })));
  return list;
}
function unitRemaining(u) {
  return (u.installments || []).filter(i => !i.paid).reduce((s, i) => s + Number(i.amount || 0), 0);
}
function unitPaidTotal(u) {
  const inst = (u.installments || []).filter(i => i.paid).reduce((s, i) => s + Number(i.amount || 0), 0);
  return inst + Number(u.downPayment || 0);
}
function unitScheduledTotal(u) {
  return (u.installments || []).reduce((s, i) => s + Number(i.amount || 0), 0) + Number(u.downPayment || 0);
}

/* ==========================================================================
   العرض
   ========================================================================== */
function renderSummary() {
  const all = allInstallments();
  const unpaid = all.filter(i => !i.paid);
  const totalRemaining = unpaid.reduce((s, i) => s + Number(i.amount || 0), 0);
  const overdue = unpaid.filter(i => daysBetween(i.dueDate) < 0);
  const overdueSum = overdue.reduce((s, i) => s + Number(i.amount || 0), 0);
  const next90 = unpaid.filter(i => { const d = daysBetween(i.dueDate); return d >= 0 && d <= 90; });
  const next90Sum = next90.reduce((s, i) => s + Number(i.amount || 0), 0);

  const cards = [
    { label: 'إجمالي المتبقّي', value: fmtEGP(totalRemaining), sub: fmtSAR(totalRemaining), cls: '' },
    { label: 'مستحق خلال ٩٠ يوماً', value: fmtEGP(next90Sum), sub: `${next90.length} قسط · ${fmtSAR(next90Sum)}`, cls: 'warn-stat' },
    { label: 'متأخّر (فات موعده)', value: fmtEGP(overdueSum), sub: overdue.length ? `${overdue.length} قسط · ${fmtSAR(overdueSum)}` : 'لا يوجد', cls: overdue.length ? 'alert' : '' },
    { label: 'عدد الوحدات', value: String(state.units.length), sub: `${unpaid.length} قسط متبقٍّ`, cls: '' },
  ];

  $('#summary').innerHTML = cards.map(c => `
    <div class="stat ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls ? '' : 'egp'}">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

function renderDashboard() {
  const el = $('#view-dashboard');
  if (!state.units.length) {
    el.innerHTML = emptyState('لا توجد وحدات بعد', 'أضف أول وحدة عقارية لتبدأ متابعة أقساطك.', '🏠');
    return;
  }

  // القسط القادم لكل وحدة + رسم بياني بسيط لتوزيع الأشهر القادمة
  const upcoming = allInstallments()
    .filter(i => !i.paid && daysBetween(i.dueDate) >= 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const nextOne = upcoming[0];
  let html = '';

  if (nextOne) {
    const d = daysBetween(nextOne.dueDate);
    html += `
      <div class="unit-card" style="border-inline-start:4px solid var(--brand)">
        <div class="label" style="font-size:12.5px;color:var(--ink-soft)">القسط القادم</div>
        <div style="font-size:24px;font-weight:800;color:var(--brand);margin:4px 0">${fmtEGP(nextOne.amount)}</div>
        <div style="font-size:13px;color:var(--ink-soft)">${fmtSAR(nextOne.amount)} · ${nextOne.unit.name}</div>
        <div style="font-size:13px;margin-top:6px">🗓️ ${fmtDate(nextOne.dueDate)} — ${d === 0 ? 'اليوم' : `بعد ${d} يوم`}</div>
      </div>`;
  }

  // ملخص كل وحدة
  html += '<div class="units-list" style="margin-top:14px">';
  state.units.forEach(u => {
    const scheduled = unitScheduledTotal(u);
    const paid = unitPaidTotal(u);
    const remaining = unitRemaining(u);
    const pct = scheduled > 0 ? Math.min(100, Math.round((paid / scheduled) * 100)) : 0;
    const nextUnpaid = (u.installments || []).filter(i => !i.paid).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    html += `
      <div class="unit-card">
        <div class="unit-title">${escapeHtml(u.name)}</div>
        ${u.project ? `<div class="unit-project">${escapeHtml(u.project)}</div>` : ''}
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="progress-meta"><span>مدفوع ${pct}%</span><span>متبقٍّ ${fmtEGP(remaining)}</span></div>
        ${nextUnpaid ? `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:8px">القسط التالي: ${fmtEGP(nextUnpaid.amount)} — ${fmtDate(nextUnpaid.dueDate)}</div>` : `<div style="font-size:12.5px;color:var(--ok);margin-top:8px">✓ تم سداد كل الأقساط</div>`}
      </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderUnits() {
  const wrap = $('#unitsList');
  if (!state.units.length) {
    wrap.innerHTML = emptyState('لا توجد وحدات', 'اضغط «إضافة وحدة» لإضافة أول وحدة.', '🏠');
    return;
  }
  wrap.innerHTML = state.units.map(u => unitCardHtml(u)).join('');
}

function unitCardHtml(u) {
  const scheduled = unitScheduledTotal(u);
  const paid = unitPaidTotal(u);
  const remaining = unitRemaining(u);
  const pct = scheduled > 0 ? Math.min(100, Math.round((paid / scheduled) * 100)) : 0;
  const insts = (u.installments || []).slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const expanded = u._open;

  const instHtml = insts.length
    ? insts.map(i => installmentRowHtml(u, i)).join('')
    : '<div style="font-size:13px;color:var(--ink-soft);text-align:center;padding:8px">لا توجد أقساط مسجّلة</div>';

  return `
  <div class="unit-card" data-unit="${u.id}">
    <div class="unit-top">
      <div>
        <div class="unit-title">${escapeHtml(u.name)}</div>
        ${u.project ? `<div class="unit-project">${escapeHtml(u.project)}</div>` : ''}
      </div>
      <div class="unit-actions">
        <button class="icon-btn" data-act="edit-unit" data-id="${u.id}" title="تعديل">✎</button>
        <button class="icon-btn" data-act="del-unit" data-id="${u.id}" title="حذف">🗑</button>
      </div>
    </div>

    <div class="unit-figures">
      <div class="fig"><div class="k">إجمالي السعر</div><div class="v">${u.totalPrice ? fmtEGP(u.totalPrice) : '—'}</div>${u.totalPrice ? `<div class="v sar">${fmtSAR(u.totalPrice)}</div>` : ''}</div>
      <div class="fig"><div class="k">المتبقّي</div><div class="v" style="color:var(--brand)">${fmtEGP(remaining)}</div><div class="v sar">${fmtSAR(remaining)}</div></div>
      <div class="fig"><div class="k">مدفوع</div><div class="v">${fmtEGP(paid)}</div><div class="v sar">${fmtSAR(paid)}</div></div>
    </div>

    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="progress-meta"><span>نسبة السداد ${pct}%</span><span>${insts.filter(i=>i.paid).length}/${insts.length} أقساط</span></div>

    <button class="inst-toggle" data-act="toggle" data-id="${u.id}">
      ${expanded ? '▲ إخفاء الأقساط' : `▼ عرض الأقساط (${insts.length})`}
    </button>

    ${expanded ? `
      <div class="inst-list">
        ${instHtml}
        <button class="add-inst-btn" data-act="add-inst" data-id="${u.id}">+ إضافة قسط / جدول أقساط</button>
      </div>` : ''}
  </div>`;
}

function installmentRowHtml(u, i) {
  const d = daysBetween(i.dueDate);
  const isOverdue = !i.paid && d < 0;
  const isDueSoon = !i.paid && d >= 0 && d <= 30;
  let badge = '';
  if (i.paid) badge = '<span class="badge ok">مدفوع</span>';
  else if (isOverdue) badge = `<span class="badge over">متأخّر ${Math.abs(d)} يوم</span>`;
  else if (isDueSoon) badge = `<span class="badge due">خلال ${d} يوم</span>`;

  return `
    <div class="inst-row ${i.paid ? 'paid' : isOverdue ? 'overdue' : ''}">
      <button class="inst-check ${i.paid ? 'on' : ''}" data-act="toggle-paid" data-uid="${u.id}" data-id="${i.id}" title="${i.paid ? 'إلغاء السداد' : 'تحديد كمدفوع'}">${i.paid ? '✓' : ''}</button>
      <div class="inst-main">
        <div class="inst-amt">${fmtEGP(i.amount)}<span class="sar">${fmtSAR(i.amount)}</span></div>
        <div class="inst-date ${isOverdue ? 'overdue-txt' : ''}">🗓️ ${fmtDate(i.dueDate)}${i.label ? ` · ${escapeHtml(i.label)}` : ''}</div>
      </div>
      ${badge}
      <button class="icon-btn" data-act="del-inst" data-uid="${u.id}" data-id="${i.id}" title="حذف">✕</button>
    </div>`;
}

function renderUpcoming() {
  const range = Number($('#upcomingRange').value);
  let list = allInstallments().filter(i => !i.paid);
  if (range > 0) list = list.filter(i => daysBetween(i.dueDate) <= range);
  list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const wrap = $('#upcomingList');
  if (!list.length) {
    wrap.innerHTML = emptyState('لا توجد أقساط', 'لا أقساط مستحقة ضمن هذه الفترة.', '✅');
    return;
  }

  // تجميع حسب الشهر
  const groups = {};
  list.forEach(i => { (groups[monthKey(i.dueDate)] ||= []).push(i); });

  wrap.innerHTML = Object.entries(groups).map(([month, items]) => {
    const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
    return `
      <div class="month-group">
        <h3>${month} — <span class="month-total">${fmtEGP(total)} · ${fmtSAR(total)}</span></h3>
        <div class="inst-list">
          ${items.map(i => {
            const d = daysBetween(i.dueDate);
            const over = d < 0;
            return `
            <div class="inst-row ${over ? 'overdue' : ''}">
              <button class="inst-check" data-act="toggle-paid" data-uid="${i.unit.id}" data-id="${i.id}" title="تحديد كمدفوع"></button>
              <div class="inst-main">
                <div class="inst-amt">${fmtEGP(i.amount)}<span class="sar">${fmtSAR(i.amount)}</span></div>
                <div class="inst-date ${over ? 'overdue-txt' : ''}">${escapeHtml(i.unit.name)} · ${fmtDate(i.dueDate)}</div>
              </div>
              ${over ? `<span class="badge over">متأخّر</span>` : `<span class="badge due">${d} يوم</span>`}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

function emptyState(title, msg, icon) {
  return `<div class="empty"><div class="big">${icon}</div><div style="font-weight:700;color:var(--ink)">${title}</div><div style="margin-top:4px">${msg}</div></div>`;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAll() {
  renderSummary();
  renderDashboard();
  renderUnits();
  renderUpcoming();
  save();
}

/* ==========================================================================
   التحكم والأحداث
   ========================================================================== */
let currentView = 'dashboard';
let editingUnitId = null;
let addInstUnitId = null;

function switchView(view) {
  currentView = view;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
}

/* ----- نافذة الوحدة ----- */
function openUnitModal(unit) {
  editingUnitId = unit ? unit.id : null;
  $('#unitModalTitle').textContent = unit ? 'تعديل الوحدة' : 'إضافة وحدة';
  const f = $('#unitForm');
  f.reset();
  if (unit) {
    f.name.value = unit.name || '';
    f.project.value = unit.project || '';
    f.totalPrice.value = unit.totalPrice || '';
    f.downPayment.value = unit.downPayment || '';
    f.notes.value = unit.notes || '';
  }
  $('#unitModal').classList.remove('hidden');
}
function closeUnitModal() { $('#unitModal').classList.add('hidden'); editingUnitId = null; }

/* ----- نافذة القسط ----- */
function openInstModal(unitId) {
  addInstUnitId = unitId;
  $('#singleForm').reset();
  $('#scheduleForm').reset();
  $('#singleForm').querySelector('[name=dueDate]').value = todayISO();
  $('#scheduleForm').querySelector('[name=startDate]').value = todayISO();
  setInstMode('single');
  updateScheduleHint();
  $('#installmentModal').classList.remove('hidden');
}
function closeInstModal() { $('#installmentModal').classList.add('hidden'); addInstUnitId = null; }
function setInstMode(mode) {
  $$('#instMode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#singleForm').classList.toggle('hidden', mode !== 'single');
  $('#scheduleForm').classList.toggle('hidden', mode !== 'schedule');
}
function updateScheduleHint() {
  const f = $('#scheduleForm');
  const amount = Number(f.amount.value || 0);
  const count = Number(f.count.value || 0);
  const freq = Number(f.frequency.value || 1);
  if (amount > 0 && count > 0) {
    const total = amount * count;
    const freqTxt = { 1: 'شهرياً', 3: 'كل ٣ أشهر', 6: 'كل ٦ أشهر', 12: 'سنوياً' }[freq];
    $('#scheduleHint').textContent = `${count} قسط × ${fmtEGP(amount)} ${freqTxt} = إجمالي ${fmtEGP(total)} (${fmtSAR(total)})`;
  } else {
    $('#scheduleHint').textContent = 'سيتم إنشاء الأقساط تلقائياً بالتواريخ حسب التكرار المحدّد.';
  }
}

function addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // معالجة نهاية الشهر (مثلاً ٣١ → ٣٠)
  if (d.getDate() !== day) d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ----- عمليات البيانات ----- */
function findUnit(id) { return state.units.find(u => u.id === id); }

function togglePaid(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  const i = u.installments.find(x => x.id === instId); if (!i) return;
  i.paid = !i.paid;
  i.paidDate = i.paid ? todayISO() : null;
  renderAll();
}
function deleteInstallment(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  u.installments = u.installments.filter(x => x.id !== instId);
  renderAll();
}
function deleteUnit(id) {
  const u = findUnit(id);
  if (!u) return;
  if (!confirm(`حذف الوحدة «${u.name}» وكل أقساطها؟`)) return;
  state.units = state.units.filter(x => x.id !== id);
  renderAll();
}

/* ==========================================================================
   ربط الأحداث
   ========================================================================== */
function bindEvents() {
  // سعر الصرف
  const rateInput = $('#rateInput');
  rateInput.value = state.rate;
  rateInput.addEventListener('input', () => {
    const v = Number(rateInput.value);
    if (v > 0) { state.rate = v; renderAll(); }
  });

  // التبويبات
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  // إضافة وحدة
  $('#addUnitBtn').addEventListener('click', () => openUnitModal(null));
  $('#closeUnitModal').addEventListener('click', closeUnitModal);
  $('#cancelUnitBtn').addEventListener('click', closeUnitModal);
  $('#unitModal').addEventListener('click', e => { if (e.target.id === 'unitModal') closeUnitModal(); });

  $('#unitForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const data = {
      name: f.name.value.trim(),
      project: f.project.value.trim(),
      totalPrice: Number(f.totalPrice.value || 0),
      downPayment: Number(f.downPayment.value || 0),
      notes: f.notes.value.trim(),
    };
    if (!data.name) return;
    if (editingUnitId) {
      Object.assign(findUnit(editingUnitId), data);
    } else {
      state.units.push({ id: uid(), ...data, installments: [], _open: true });
    }
    closeUnitModal();
    renderAll();
    if (currentView === 'dashboard') switchView('units');
  });

  // نافذة القسط
  $('#closeInstModal').addEventListener('click', closeInstModal);
  $$('.cancel-inst').forEach(b => b.addEventListener('click', closeInstModal));
  $('#installmentModal').addEventListener('click', e => { if (e.target.id === 'installmentModal') closeInstModal(); });
  $$('#instMode .seg-btn').forEach(b => b.addEventListener('click', () => setInstMode(b.dataset.mode)));
  $('#scheduleForm').addEventListener('input', updateScheduleHint);

  // حفظ قسط واحد
  $('#singleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    u.installments.push({
      id: uid(),
      amount: Number(f.amount.value || 0),
      dueDate: f.dueDate.value,
      label: f.label.value.trim(),
      paid: false, paidDate: null,
    });
    u._open = true;
    closeInstModal();
    renderAll();
  });

  // حفظ جدول أقساط
  $('#scheduleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    const amount = Number(f.amount.value || 0);
    const count = Number(f.count.value || 0);
    const freq = Number(f.frequency.value || 1);
    let start = f.startDate.value;
    if (!amount || !count || !start) return;
    for (let k = 0; k < count; k++) {
      u.installments.push({
        id: uid(),
        amount,
        dueDate: addMonths(start, k * freq),
        label: `قسط ${k + 1} من ${count}`,
        paid: false, paidDate: null,
      });
    }
    u._open = true;
    closeInstModal();
    renderAll();
  });

  // الفترة في تبويب القادمة
  $('#upcomingRange').addEventListener('change', renderUpcoming);

  // تفويض الأحداث للقوائم الديناميكية
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const uidAttr = btn.dataset.uid;
    switch (act) {
      case 'toggle': { const u = findUnit(id); if (u) { u._open = !u._open; renderUnits(); } break; }
      case 'add-inst': openInstModal(id); break;
      case 'edit-unit': openUnitModal(findUnit(id)); break;
      case 'del-unit': deleteUnit(id); break;
      case 'toggle-paid': togglePaid(uidAttr, id); break;
      case 'del-inst': deleteInstallment(uidAttr, id); break;
    }
  });

  // تصدير / استيراد
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importData);

  // إغلاق النوافذ بمفتاح Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeUnitModal(); closeInstModal(); }
  });
}

/* ----- تصدير / استيراد ----- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aksat-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.units)) throw new Error('صيغة غير صحيحة');
      if (!confirm('سيتم استبدال البيانات الحالية بالكامل. متابعة؟')) return;
      state = Object.assign({ rate: DEFAULT_RATE, units: [] }, parsed);
      if (!state.rate || state.rate <= 0) state.rate = DEFAULT_RATE;
      $('#rateInput').value = state.rate;
      renderAll();
      alert('تم الاستيراد بنجاح.');
    } catch (err) {
      alert('تعذّر قراءة الملف: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ==========================================================================
   بيانات تجريبية عند أول استخدام
   ========================================================================== */
function seedIfEmpty() {
  if (state.units.length) return;
  const start = todayISO();
  const unit = {
    id: uid(),
    name: 'شقة تجريبية — عدّلها أو احذفها',
    project: 'مثال توضيحي',
    totalPrice: 2000000,
    downPayment: 400000,
    notes: 'هذه وحدة تجريبية لتوضيح طريقة الاستخدام.',
    installments: [],
    _open: true,
  };
  for (let k = 0; k < 6; k++) {
    unit.installments.push({
      id: uid(),
      amount: 50000,
      dueDate: addMonths(start, k * 3 - 3),
      label: `قسط ${k + 1} من 6`,
      paid: k === 0,
      paidDate: k === 0 ? start : null,
    });
  }
  state.units.push(unit);
  save();
}

/* ---------- الإقلاع ---------- */
function init() {
  load();
  seedIfEmpty();
  bindEvents();
  switchView('dashboard');
  renderAll();
}
document.addEventListener('DOMContentLoaded', init);
