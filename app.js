/* ==========================================================================
   أقساط — إدارة الالتزامات المالية (الأقساط العقارية)
   • مزامنة سحابية عبر Neon (خلف دوال Netlify) مع نسخة محلية للعمل دون إنترنت.
   • سعر صرف تلقائي محدّث من الإنترنت (الريال → الجنيه).
   • تنبيهات للأقساط المستحقة والمتأخّرة (داخل التطبيق + إشعارات المتصفح).
   • تقارير ورسوم بيانية (SVG) لتوزيع الأقساط ونسب السداد.
   العملة الأساسية: الجنيه المصري (ج.م) مع عرض المقابل بالريال السعودي (﷼).
   ========================================================================== */

'use strict';

const LOCAL_KEY = 'aksat.state.v2';
const NOTIF_KEY = 'aksat.notifEnabled';
const LASTNOTIF_KEY = 'aksat.lastNotifDate';
const DEFAULT_RATE = 13.3;      // جنيه لكل ريال
const DEFAULT_USD_RATE = 50;    // جنيه لكل دولار
const API = '/api';

// إعداد Firebase للمصادقة (قيَم عامة publishable)
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC6WTj5rqg4qpbsxHcY1eO9yphOS282W0E',
  authDomain: 'estatemanager-eecaa.firebaseapp.com',
  projectId: 'estatemanager-eecaa',
  storageBucket: 'estatemanager-eecaa.firebasestorage.app',
  messagingSenderId: '459313113006',
  appId: '1:459313113006:web:4b45bf439d8718b7914a3f',
};

/* ---------- الحالة ---------- */
let state = {
  updatedAt: null,     // ختم زمني (ISO) يُضبط عند كل تعديل — يُستخدم للمزامنة
  rate: DEFAULT_RATE,  // عدد الجنيهات لكل ريال
  usdRate: DEFAULT_USD_RATE, // عدد الجنيهات لكل دولار
  autoRate: false,     // تحديث السعر تلقائياً
  rateInfo: null,      // { source, fetchedAt }
  assets: { usd: 0, egp: 0 }, // أرصدة الحسابات المصرية
  units: [],           // [{ id, name, project, totalPrice, downPayment, notes, installments:[] }]
};

let fbAuth = null;       // Firebase Auth
let currentUser = null;  // المستخدم المسجّل (Firebase)
let cloudAvailable = false;
let notifEnabled = false;

/* ---------- أدوات ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
const nowISO = () => new Date().toISOString();

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
function fmtUSD(n) {
  const usd = (n || 0) / state.usdRate;
  return '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(usd));
}
function fmtCompact(n) {
  n = Math.round(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
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
function monthShort(y, m) {
  const d = new Date(y, m, 1);
  return new Intl.DateTimeFormat('ar-EG', { month: 'short' }).format(d);
}
function daysBetween(iso) {
  const t = new Date(todayISO() + 'T00:00:00');
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ==========================================================================
   طبقة التخزين والمزامنة
   ========================================================================== */
// دمج القيَم الافتراضية مع أي حالة محمّلة (للتوافق مع النسخ الأقدم)
function withDefaults(obj) {
  const s = Object.assign(
    { updatedAt: null, rate: DEFAULT_RATE, usdRate: DEFAULT_USD_RATE, autoRate: false, rateInfo: null, assets: { usd: 0, egp: 0 }, units: [] },
    obj || {}
  );
  if (!s.rate || s.rate <= 0) s.rate = DEFAULT_RATE;
  if (!s.usdRate || s.usdRate <= 0) s.usdRate = DEFAULT_USD_RATE;
  if (!s.assets || typeof s.assets !== 'object') s.assets = { usd: 0, egp: 0 };
  s.assets.usd = Number(s.assets.usd) || 0;
  s.assets.egp = Number(s.assets.egp) || 0;
  return s;
}

// مفتاح تخزين محلي خاص بكل مستخدم
function localKey() { return LOCAL_KEY + (currentUser ? ':' + currentUser.uid : ''); }
function saveLocal() {
  try { localStorage.setItem(localKey(), JSON.stringify(state)); } catch (e) { /* تجاهل */ }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(localKey());
    if (raw) state = withDefaults(JSON.parse(raw));
  } catch (e) { /* تجاهل */ }
}
function resetState() {
  state = withDefaults({ autoRate: true });
}

let syncTimer = null;
let pendingSync = false;

function touch() { state.updatedAt = nowISO(); }

/* ترويسة المصادقة عبر رمز Firebase */
async function authHeaders() {
  if (!currentUser) return null;
  try {
    const token = await currentUser.getIdToken();
    return { Authorization: 'Bearer ' + token };
  } catch { return null; }
}

/* حفظ محلي فوري + دفع مؤجّل للسحابة */
function persist() {
  touch();
  saveLocal();
  scheduleCloudPush();
}
function scheduleCloudPush() {
  if (!currentUser || !cloudAvailable) return;
  pendingSync = true;
  setSync('sync', 'جارٍ الحفظ…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(cloudPush, 600);
}

async function cloudPush() {
  if (!currentUser || !cloudAvailable) return;
  try {
    const h = await authHeaders();
    if (!h) throw new Error('no-token');
    const res = await fetch(`${API}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    pendingSync = false;
    setSync('ok', 'محفوظ سحابياً');
  } catch (e) {
    pendingSync = true;
    setSync('warn', 'غير متزامن — سيُعاد المحاولة');
  }
}

async function cloudPull() {
  if (!currentUser || !cloudAvailable) return null;
  const h = await authHeaders();
  if (!h) return null;
  const res = await fetch(`${API}/state`, { headers: h });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json(); // { state, updatedAt }
}

/* اكتشاف توفر الخادم السحابي */
async function detectCloud() {
  try {
    const res = await fetch(`${API}/state`, { method: 'OPTIONS' });
    cloudAvailable = res.ok || res.status === 200;
  } catch { cloudAvailable = false; }
  return cloudAvailable;
}

/* دمج بمبدأ «الأحدث يفوز» على مستوى المستند بأكمله */
async function syncOnLoad() {
  if (!currentUser || !cloudAvailable) {
    setSync('warn', 'الخادم غير متاح — محلي فقط');
    return;
  }
  setSync('sync', 'جارٍ المزامنة…');
  try {
    const remote = await cloudPull();
    const localTs = state.updatedAt || '';
    const remoteState = remote && remote.state;
    const remoteTs = (remoteState && remoteState.updatedAt) || '';

    if (remoteState && Array.isArray(remoteState.units) && remoteTs >= localTs) {
      state = withDefaults(remoteState);
      saveLocal();
      setSync('ok', 'مُزامَن سحابياً');
    } else if (state.units.length) {
      await cloudPush();
    } else {
      setSync('ok', 'مُزامَن سحابياً');
    }
  } catch (e) {
    setSync('err', 'تعذّرت المزامنة — محلي فقط');
  }
}

function setSync(kind, text) {
  const el = $('#syncStatus');
  if (el) el.innerHTML = `<span class="dot ${kind}"></span>${text}`;
}

/* إعادة المحاولة عند عودة الاتصال أو التركيز */
window.addEventListener('online', () => { if (pendingSync) cloudPush(); });
window.addEventListener('focus', () => { if (pendingSync) cloudPush(); });

/* ==========================================================================
   الحسابات
   ========================================================================== */
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
   العرض — الملخص ولوحة التحكم والوحدات والقادمة
   ========================================================================== */
function renderSummary() {
  const unpaid = allInstallments().filter(i => !i.paid);
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
  const upcoming = allInstallments()
    .filter(i => !i.paid && daysBetween(i.dueDate) >= 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const nextOne = upcoming[0];
  const totalPaid = state.units.reduce((s, u) => s + unitPaidTotal(u), 0);
  const totalRemaining = state.units.reduce((s, u) => s + unitRemaining(u), 0);
  let html = '';
  if (nextOne) {
    const d = daysBetween(nextOne.dueDate);
    html += `
      <div class="unit-card next-card">
        <div class="label" style="font-size:12.5px;opacity:.85">القسط القادم</div>
        <div style="font-size:26px;font-weight:800;margin:4px 0">${fmtEGP(nextOne.amount)}</div>
        <div style="font-size:13px;opacity:.9">${fmtSAR(nextOne.amount)} · ${fmtUSD(nextOne.amount)} · ${escapeHtml(nextOne.unit.name)}</div>
        <div style="font-size:13px;margin-top:6px">🗓️ ${fmtDate(nextOne.dueDate)} — ${d === 0 ? 'اليوم' : `بعد ${d} يوم`}</div>
      </div>`;
  }

  // رسوم بيانية للوحة التحكم
  html += `
    <div class="dash-charts">
      <div class="report-block">
        <h3>المستحق شهرياً — ٦ أشهر</h3>
        <div class="chart-scroll">${monthlyBarChart(6)}</div>
      </div>
      <div class="report-block">
        <h3>نسبة السداد الإجمالية</h3>
        ${donutChart(totalPaid, totalRemaining)}
      </div>
    </div>`;

  html += '<div class="units-list" style="margin-top:14px">';
  state.units.forEach(u => {
    const scheduled = unitScheduledTotal(u), paid = unitPaidTotal(u), remaining = unitRemaining(u);
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
  const scheduled = unitScheduledTotal(u), paid = unitPaidTotal(u), remaining = unitRemaining(u);
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
      ${!i.paid ? `<button class="icon-btn" data-act="postpone" data-uid="${u.id}" data-id="${i.id}" title="تأجيل">⏳</button>` : ''}
      <button class="icon-btn" data-act="del-inst" data-uid="${u.id}" data-id="${i.id}" title="حذف">✕</button>
    </div>`;
}

function renderUpcoming() {
  const range = Number($('#upcomingRange').value);
  let list = allInstallments().filter(i => !i.paid);
  if (range > 0) list = list.filter(i => daysBetween(i.dueDate) <= range);
  list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const wrap = $('#upcomingList');
  if (!list.length) { wrap.innerHTML = emptyState('لا توجد أقساط', 'لا أقساط مستحقة ضمن هذه الفترة.', '✅'); return; }
  const groups = {};
  list.forEach(i => { (groups[monthKey(i.dueDate)] ||= []).push(i); });
  wrap.innerHTML = Object.entries(groups).map(([month, items]) => {
    const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
    return `
      <div class="month-group">
        <h3>${month} — <span class="month-total">${fmtEGP(total)} · ${fmtSAR(total)}</span></h3>
        <div class="inst-list">
          ${items.map(i => {
            const d = daysBetween(i.dueDate), over = d < 0;
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

/* ==========================================================================
   التقارير والرسوم البيانية (SVG بدون مكتبات)
   ========================================================================== */
function renderReports() {
  const el = $('#view-reports');
  if (!state.units.length) {
    el.innerHTML = emptyState('لا توجد بيانات للتقارير', 'أضف وحدات وأقساطاً لعرض التقارير.', '📊');
    return;
  }
  const totalScheduled = state.units.reduce((s, u) => s + unitScheduledTotal(u), 0);
  const totalPaid = state.units.reduce((s, u) => s + unitPaidTotal(u), 0);
  const totalRemaining = state.units.reduce((s, u) => s + unitRemaining(u), 0);

  el.innerHTML = `
    <div class="view-head">
      <h2 style="font-size:16px">التقارير</h2>
      <button class="btn primary" data-act="print">🖨️ طباعة التقرير</button>
    </div>
    <div class="summary" style="margin-bottom:16px">
      <div class="stat"><div class="label">إجمالي مجدول</div><div class="value">${fmtEGP(totalScheduled)}</div><div class="sub">${fmtSAR(totalScheduled)}</div></div>
      <div class="stat"><div class="label">إجمالي مدفوع</div><div class="value" style="color:var(--ok)">${fmtEGP(totalPaid)}</div><div class="sub">${fmtSAR(totalPaid)}</div></div>
      <div class="stat"><div class="label">إجمالي متبقٍّ</div><div class="value egp">${fmtEGP(totalRemaining)}</div><div class="sub">${fmtSAR(totalRemaining)}</div></div>
    </div>

    <div class="report-block">
      <h3>المستحق شهرياً — ١٢ شهراً قادمة</h3>
      <div class="rsub">مجموع الأقساط غير المدفوعة حسب شهر الاستحقاق (المبالغ بالجنيه)</div>
      <div class="chart-scroll">${monthlyBarChart()}</div>
    </div>

    <div class="report-block">
      <h3>نسبة السداد الإجمالية</h3>
      <div class="rsub">المدفوع مقابل المتبقّي من إجمالي قيمة الوحدات</div>
      ${donutChart(totalPaid, totalRemaining)}
    </div>

    <div class="report-block">
      <h3>تفصيل الوحدات</h3>
      <div class="chart-scroll">${unitsTable()}</div>
    </div>`;
}

/* ---------- تقرير قابل للطباعة ---------- */
function printReport() {
  const today = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const who = currentUser ? (currentUser.email || '') : '';
  const tSch = state.units.reduce((s, u) => s + unitScheduledTotal(u), 0);
  const tPaid = state.units.reduce((s, u) => s + unitPaidTotal(u), 0);
  const tRem = state.units.reduce((s, u) => s + unitRemaining(u), 0);
  const pctPaid = tSch > 0 ? Math.round(tPaid / tSch * 100) : 0;

  // مؤشرات
  const unpaid = allInstallments().filter(i => !i.paid);
  const overdue = unpaid.filter(i => daysBetween(i.dueDate) < 0);
  const overdueSum = overdue.reduce((s, i) => s + Number(i.amount || 0), 0);
  const next90 = unpaid.filter(i => { const d = daysBetween(i.dueDate); return d >= 0 && d <= 90; });
  const next90Sum = next90.reduce((s, i) => s + Number(i.amount || 0), 0);
  const nextOne = unpaid.filter(i => daysBetween(i.dueDate) >= 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

  let html = `<h1>تقرير الأقساط — أقساط</h1>
    <div class="pr-sub">التاريخ: ${today}${who ? ' · ' + escapeHtml(who) : ''} · ١ ريال = ${state.rate} ج.م · ١ دولار = ${state.usdRate} ج.م</div>

    <h2>المؤشرات</h2>
    <div class="pr-kpis">
      <div class="pr-kpi"><div class="k">نسبة السداد</div><div class="v">${pctPaid}%</div></div>
      <div class="pr-kpi"><div class="k">عدد الوحدات</div><div class="v">${state.units.length}</div></div>
      <div class="pr-kpi"><div class="k">أقساط متبقّية</div><div class="v">${unpaid.length}</div></div>
      <div class="pr-kpi"><div class="k">أقساط متأخّرة</div><div class="v">${overdue.length}</div></div>
    </div>
    <div class="pr-bar"><span style="width:${pctPaid}%"></span></div>
    <table>
      <tr><th>المؤشر</th><th class="num">ج.م</th><th class="num">﷼</th><th class="num">$</th></tr>
      <tr class="pr-tot"><td>إجمالي مجدول</td><td class="num">${fmtEGP(tSch)}</td><td class="num">${fmtSAR(tSch)}</td><td class="num">${fmtUSD(tSch)}</td></tr>
      <tr><td>إجمالي مدفوع</td><td class="num">${fmtEGP(tPaid)}</td><td class="num">${fmtSAR(tPaid)}</td><td class="num">${fmtUSD(tPaid)}</td></tr>
      <tr class="pr-tot"><td>إجمالي متبقٍّ</td><td class="num">${fmtEGP(tRem)}</td><td class="num">${fmtSAR(tRem)}</td><td class="num">${fmtUSD(tRem)}</td></tr>
      <tr><td>مستحق خلال ٩٠ يوماً (${next90.length})</td><td class="num">${fmtEGP(next90Sum)}</td><td class="num">${fmtSAR(next90Sum)}</td><td class="num">${fmtUSD(next90Sum)}</td></tr>
      <tr><td>متأخّر (${overdue.length})</td><td class="num">${fmtEGP(overdueSum)}</td><td class="num">${fmtSAR(overdueSum)}</td><td class="num">${fmtUSD(overdueSum)}</td></tr>
    </table>
    ${nextOne ? `<div class="pr-sub">القسط القادم: ${fmtEGP(nextOne.amount)} — ${fmtDate(nextOne.dueDate)} (${escapeHtml(nextOne.unit.name)})</div>` : ''}`;

  state.units.forEach(u => {
    const rem = unitRemaining(u);
    const insts = (u.installments || []).slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    html += `<h2>${escapeHtml(u.name)}${u.project ? ' — ' + escapeHtml(u.project) : ''}</h2>
      <div class="pr-sub">المتبقّي: ${fmtEGP(rem)} (${fmtSAR(rem)}) · عدد الأقساط: ${insts.length}</div>
      <table>
        <tr><th>#</th><th>الوصف</th><th>الاستحقاق</th><th class="num">المبلغ (ج.م)</th><th class="num">المبلغ (﷼)</th><th>الحالة</th></tr>
        ${insts.map((i, k) => `<tr>
          <td>${k + 1}</td>
          <td>${escapeHtml(i.label || '')}</td>
          <td>${fmtDate(i.dueDate)}</td>
          <td class="num">${fmtEGP(i.amount)}</td>
          <td class="num">${fmtSAR(i.amount)}</td>
          <td>${i.paid ? 'مدفوع' : (daysBetween(i.dueDate) < 0 ? 'متأخّر' : 'مستحق')}</td>
        </tr>`).join('')}
      </table>`;
  });

  if (!state.units.length) html += '<p>لا توجد بيانات.</p>';
  $('#printArea').innerHTML = html;
  window.print();
}

/* ==========================================================================
   شاشة السداد / التسوية
   ========================================================================== */
let settleSelected = new Set();

function settleResultHtml() {
  const unpaid = allInstallments().filter(i => !i.paid);
  const assetsEGP = (Number(state.assets.usd) || 0) * state.usdRate + (Number(state.assets.egp) || 0);
  const selEGP = unpaid.filter(i => settleSelected.has(i.id)).reduce((s, i) => s + Number(i.amount || 0), 0);
  const remainEGP = assetsEGP - selEGP;
  const shortfall = remainEGP < 0;
  return `
    <div class="sr-row"><span>إجمالي الأصول</span><b>${fmtEGP(assetsEGP)}</b></div>
    <div class="sr-cur">${fmtSAR(assetsEGP)} · ${fmtUSD(assetsEGP)}</div>
    <div class="sr-row"><span>الأقساط المختارة (${settleSelected.size})</span><b style="color:var(--danger)">− ${fmtEGP(selEGP)}</b></div>
    <div class="sr-cur">${fmtSAR(selEGP)} · ${fmtUSD(selEGP)}</div>
    <hr class="sep" />
    <div class="sr-row big"><span>${shortfall ? 'العجز' : 'المتبقّي بعد السداد'}</span><b style="color:${shortfall ? 'var(--danger)' : 'var(--ok)'}">${fmtEGP(Math.abs(remainEGP))}</b></div>
    <div class="sr-cur big">${fmtSAR(Math.abs(remainEGP))} · ${fmtUSD(Math.abs(remainEGP))}</div>
    ${shortfall ? '<div class="sr-warn">⚠️ الأصول لا تكفي لسداد الأقساط المختارة</div>' : ''}`;
}

function renderSettle() {
  const el = $('#view-settle');
  const unpaid = allInstallments().filter(i => !i.paid)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const validIds = new Set(unpaid.map(i => i.id));
  [...settleSelected].forEach(id => { if (!validIds.has(id)) settleSelected.delete(id); });

  const usd = Number(state.assets.usd) || 0, egp = Number(state.assets.egp) || 0;
  const shortfall = (usd * state.usdRate + egp) - unpaid.filter(i => settleSelected.has(i.id)).reduce((s, i) => s + Number(i.amount || 0), 0) < 0;

  const rowsHtml = unpaid.length ? unpaid.map(i => {
    const on = settleSelected.has(i.id);
    const over = daysBetween(i.dueDate) < 0;
    return `
      <div class="inst-row ${on ? 'sel' : ''}" data-act="settle-toggle" data-id="${i.id}">
        <span class="inst-check ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
        <div class="inst-main">
          <div class="inst-amt">${fmtEGP(i.amount)}<span class="sar">${fmtSAR(i.amount)} · ${fmtUSD(i.amount)}</span></div>
          <div class="inst-date ${over ? 'overdue-txt' : ''}">${escapeHtml(i.unit.name)} · ${fmtDate(i.dueDate)}</div>
        </div>
      </div>`;
  }).join('') : emptyState('لا أقساط غير مدفوعة', 'كل الأقساط مسدّدة 🎉', '✅');

  el.innerHTML = `
    <div class="report-block">
      <h3>💰 أرصدة حساباتي المصرية</h3>
      <div class="rsub">أدخل رصيد كل حساب، واختر الأقساط لتعرف المتبقّي بعد سدادها.</div>
      <div class="row">
        <label>حساب الدولار ($)
          <input type="number" id="assetUsd" min="0" step="0.01" inputmode="decimal" value="${usd || ''}" placeholder="0" />
        </label>
        <label>حساب الجنيه (ج.م)
          <input type="number" id="assetEgp" min="0" step="0.01" inputmode="decimal" value="${egp || ''}" placeholder="0" />
        </label>
      </div>
      <div class="rate-note">أسعار اليوم: ١ دولار = ${state.usdRate} ج.م · ١ ريال = ${state.rate} ج.م
        <button class="btn ghost small" data-act="settle-refresh" style="margin-inline-start:8px">⟳ تحديث</button></div>
    </div>

    <div class="settle-result ${shortfall ? 'short' : ''}" id="settleResult">${settleResultHtml()}</div>

    <div class="report-block">
      <div class="view-head" style="margin-bottom:8px">
        <h3 style="margin:0">اختر الأقساط المراد سدادها</h3>
        <button class="btn ghost small" data-act="settle-clear">إلغاء التحديد</button>
      </div>
      <div class="inst-list">${rowsHtml}</div>
      ${settleSelected.size ? `<button class="btn primary" data-act="settle-pay" style="width:100%;margin-top:12px">✓ تحديد المختار كمدفوع (${settleSelected.size})</button>` : ''}
    </div>`;

  const uEl = $('#assetUsd'), eEl = $('#assetEgp');
  if (uEl) uEl.addEventListener('input', () => { state.assets.usd = Number(uEl.value) || 0; persist(); $('#settleResult').innerHTML = settleResultHtml(); });
  if (eEl) eEl.addEventListener('input', () => { state.assets.egp = Number(eEl.value) || 0; persist(); $('#settleResult').innerHTML = settleResultHtml(); });
}

function paySelected() {
  if (!settleSelected.size) return;
  if (!confirm(`تحديد ${settleSelected.size} قسط كمدفوع؟`)) return;
  state.units.forEach(u => (u.installments || []).forEach(i => {
    if (settleSelected.has(i.id)) { i.paid = true; i.paidDate = todayISO(); }
  }));
  settleSelected.clear();
  persist(); renderAll();
}

function monthlyBarChart(months) {
  const N = months || 12;
  const now = new Date();
  const buckets = [];
  for (let k = 0; k < N; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    buckets.push({ y: d.getFullYear(), m: d.getMonth(), sum: 0 });
  }
  allInstallments().filter(i => !i.paid).forEach(i => {
    const d = new Date(i.dueDate + 'T00:00:00');
    if (isNaN(d.getTime())) return;
    let idx = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
    if (idx < 0) idx = 0;
    if (idx > N - 1 || !buckets[idx]) return;
    buckets[idx].sum += Number(i.amount || 0);
  });

  const W = N <= 6 ? 360 : 640, H = 240, padB = 46, padT = 20, padX = 12;
  const max = Math.max(1, ...buckets.map(b => b.sum));
  const bw = (W - padX * 2) / N;
  const chartH = H - padB - padT;

  let bars = '', labels = '', grid = '';
  // خطوط شبكية أفقية
  for (let g = 0; g <= 4; g++) {
    const y = padT + chartH * (g / 4);
    grid += `<line class="grid" x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}"/>`;
    grid += `<text x="${W - padX}" y="${y - 3}" text-anchor="end">${fmtCompact(max * (1 - g / 4))}</text>`;
  }
  buckets.forEach((b, k) => {
    const h = b.sum > 0 ? Math.max(2, (b.sum / max) * chartH) : 0;
    const x = padX + k * bw + bw * 0.18;
    const w = bw * 0.64;
    const y = padT + chartH - h;
    bars += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="var(--brand)"><title>${monthShort(b.y, b.m)} ${b.y}: ${fmtEGP(b.sum)}</title></rect>`;
    if (b.sum > 0) bars += `<text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" style="font-weight:700">${fmtCompact(b.sum)}</text>`;
    labels += `<text x="${padX + k * bw + bw / 2}" y="${H - padB + 18}" text-anchor="middle">${monthShort(b.y, b.m)}</text>`;
    if (k === 0 || b.m === 0) labels += `<text x="${padX + k * bw + bw / 2}" y="${H - padB + 32}" text-anchor="middle" style="opacity:.7">${b.y}</text>`;
  });
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${grid}${bars}${labels}</svg>`;
}

function donutChart(paid, remaining) {
  const total = paid + remaining;
  const pct = total > 0 ? paid / total : 0;
  const R = 70, C = 2 * Math.PI * R, stroke = 26;
  const dash = C * pct;
  return `
  <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <svg class="chart-svg" viewBox="0 0 180 180" width="180" height="180">
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--ok)" stroke-width="${stroke}"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${C * 0.25}" stroke-linecap="round"
        transform="rotate(-90 90 90)"/>
      <text x="90" y="86" text-anchor="middle" style="font-size:26px;font-weight:800;fill:var(--ink)">${Math.round(pct * 100)}%</text>
      <text x="90" y="106" text-anchor="middle" style="font-size:12px">مدفوع</text>
    </svg>
    <div class="legend" style="flex-direction:column;gap:10px">
      <span class="lk"><span class="sw" style="background:var(--ok)"></span> مدفوع: ${fmtEGP(paid)} · ${fmtSAR(paid)}</span>
      <span class="lk"><span class="sw" style="background:var(--line)"></span> متبقٍّ: ${fmtEGP(remaining)} · ${fmtSAR(remaining)}</span>
    </div>
  </div>`;
}

function unitsTable() {
  const rows = state.units.map(u => {
    const sch = unitScheduledTotal(u), paid = unitPaidTotal(u), rem = unitRemaining(u);
    const pct = sch > 0 ? Math.round((paid / sch) * 100) : 0;
    return `<tr>
      <td>${escapeHtml(u.name)}</td>
      <td class="num">${fmtEGP(sch)}</td>
      <td class="num" style="color:var(--ok)">${fmtEGP(paid)}</td>
      <td class="num" style="color:var(--brand)">${fmtEGP(rem)}</td>
      <td class="num">${pct}%</td>
    </tr>`;
  }).join('');
  const tSch = state.units.reduce((s, u) => s + unitScheduledTotal(u), 0);
  const tPaid = state.units.reduce((s, u) => s + unitPaidTotal(u), 0);
  const tRem = state.units.reduce((s, u) => s + unitRemaining(u), 0);
  return `<table class="rtable">
    <thead><tr><th>الوحدة</th><th style="text-align:end">مجدول</th><th style="text-align:end">مدفوع</th><th style="text-align:end">متبقٍّ</th><th style="text-align:end">%</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr style="font-weight:800">
      <td>الإجمالي</td>
      <td class="num">${fmtEGP(tSch)}</td>
      <td class="num" style="color:var(--ok)">${fmtEGP(tPaid)}</td>
      <td class="num" style="color:var(--brand)">${fmtEGP(tRem)}</td>
      <td class="num">${tSch > 0 ? Math.round(tPaid / tSch * 100) : 0}%</td>
    </tr></tfoot>
  </table>`;
}

/* ==========================================================================
   التنبيهات
   ========================================================================== */
function computeAlerts() {
  const unpaid = allInstallments().filter(i => !i.paid);
  const overdue = unpaid.filter(i => daysBetween(i.dueDate) < 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const soon = unpaid.filter(i => { const d = daysBetween(i.dueDate); return d >= 0 && d <= 30; })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { overdue, soon, urgentCount: overdue.length + soon.filter(i => daysBetween(i.dueDate) <= 7).length };
}

function refreshBell() {
  const { urgentCount } = computeAlerts();
  const badge = $('#bellCount');
  if (urgentCount > 0) { badge.textContent = urgentCount; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

function toggleNotifPanel() {
  const p = $('#notifPanel');
  if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
  const { overdue, soon } = computeAlerts();
  let html = '<h4>🔔 التنبيهات</h4>';
  if (!overdue.length && !soon.length) {
    html += '<div class="notif-item"><span class="ic">✅</span><div><div class="t">لا تنبيهات</div><div class="s">لا أقساط متأخّرة أو مستحقة قريباً.</div></div></div>';
  } else {
    overdue.forEach(i => {
      html += `<div class="notif-item over"><span class="ic">⚠️</span><div><div class="t">متأخّر: ${fmtEGP(i.amount)}</div><div class="s">${escapeHtml(i.unit.name)} · ${fmtDate(i.dueDate)} (فات ${Math.abs(daysBetween(i.dueDate))} يوم)</div></div></div>`;
    });
    soon.forEach(i => {
      const d = daysBetween(i.dueDate);
      html += `<div class="notif-item soon"><span class="ic">🗓️</span><div><div class="t">مستحق: ${fmtEGP(i.amount)}</div><div class="s">${escapeHtml(i.unit.name)} · ${fmtDate(i.dueDate)} (${d === 0 ? 'اليوم' : `بعد ${d} يوم`})</div></div></div>`;
    });
  }
  p.innerHTML = html;
  p.classList.remove('hidden');
}

async function enableBrowserNotifications(silent) {
  if (!('Notification' in window)) { if (!silent) alert('متصفحك لا يدعم الإشعارات.'); return false; }
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { return false; } }
  if (perm !== 'granted') { if (!silent) alert('لم يتم منح إذن الإشعارات.'); return false; }
  return true;
}

function maybeShowBrowserNotif() {
  if (!notifEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  // مرة واحدة يومياً كحدّ أقصى
  const last = localStorage.getItem(LASTNOTIF_KEY);
  if (last === todayISO()) return;
  const { overdue, soon } = computeAlerts();
  const urgent = soon.filter(i => daysBetween(i.dueDate) <= 7);
  if (!overdue.length && !urgent.length) return;
  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} قسط متأخّر`);
  if (urgent.length) parts.push(`${urgent.length} مستحق خلال أسبوع`);
  const sum = [...overdue, ...urgent].reduce((s, i) => s + Number(i.amount || 0), 0);
  try {
    new Notification('أقساط — تنبيه استحقاق', {
      body: `${parts.join(' · ')} — الإجمالي ${fmtEGP(sum)} (${fmtSAR(sum)})`,
      dir: 'rtl', lang: 'ar',
    });
    localStorage.setItem(LASTNOTIF_KEY, todayISO());
  } catch (e) { /* تجاهل */ }
}

/* ==========================================================================
   سعر الصرف التلقائي
   ========================================================================== */
async function fetchAutoRate(manual) {
  const btn = $('#rateRefresh');
  if (btn) btn.classList.add('spin');
  try {
    // جلب أسعار الدولار كأساس نشتقّ منه سعري الريال والدولار مقابل الجنيه
    let usdEgp = null, usdSar = null, source = '';
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const j = await r.json();
      if (j && j.rates) { usdEgp = Number(j.rates.EGP); usdSar = Number(j.rates.SAR); source = 'open.er-api.com'; }
    } catch { /* نجرّب دالة الخادم */ }
    if (!usdEgp) {
      try {
        const res = await fetch(`${API}/rate`);
        if (res.ok) { const d = await res.json(); if (d.rate > 0) { state.rate = Number(Number(d.rate).toFixed(4)); source = d.source || 'تلقائي'; } }
      } catch { /* تجاهل */ }
    }
    if (usdEgp > 0) {
      state.usdRate = Number(usdEgp.toFixed(4));
      if (usdSar > 0) state.rate = Number((usdEgp / usdSar).toFixed(4)); // جنيه لكل ريال
    }
    if (usdEgp > 0 || source) {
      state.rateInfo = { source, fetchedAt: nowISO() };
      if ($('#rateInput')) $('#rateInput').value = state.rate;
      persist();
      renderAll();
      updateRateInfoUI();
      if (manual) flashFooter(`تم التحديث: ١ ريال = ${state.rate} ج.م · ١ دولار = ${state.usdRate} ج.م`);
    } else if (manual) {
      alert('تعذّر جلب سعر الصرف حالياً.');
    }
  } catch (e) {
    if (manual) alert('تعذّر جلب سعر الصرف: تحقّق من الاتصال.');
  } finally {
    if (btn) btn.classList.remove('spin');
  }
}

function updateRateInfoUI() {
  const note = $('#footerNote');
  if (state.rateInfo && state.rateInfo.fetchedAt) {
    const t = new Date(state.rateInfo.fetchedAt);
    const when = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t);
    note.textContent = `آخر تحديث للسعر: ${when} (${state.rateInfo.source || 'تلقائي'})`;
  }
}

function flashFooter(msg) {
  const note = $('#footerNote');
  const prev = note.textContent;
  note.textContent = msg;
  note.style.color = 'var(--ok)';
  setTimeout(() => { note.style.color = ''; updateRateInfoUI(); if (note.textContent === msg) note.textContent = prev; }, 3000);
}

/* ==========================================================================
   الأدوات المشتركة
   ========================================================================== */
function emptyState(title, msg, icon) {
  return `<div class="empty"><div class="big">${icon}</div><div style="font-weight:700;color:var(--ink)">${title}</div><div style="margin-top:4px">${msg}</div></div>`;
}

function renderAll() {
  renderSummary();
  renderDashboard();
  renderUnits();
  renderUpcoming();
  if (currentView === 'reports') renderReports();
  if (currentView === 'settle') renderSettle();
  refreshBell();
  saveLocal();
}

/* ==========================================================================
   التنقّل والنوافذ
   ========================================================================== */
let currentView = 'dashboard';
let editingUnitId = null;
let addInstUnitId = null;
let postponeTarget = null; // { unitId, instId }

function switchView(view) {
  currentView = view;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  if (view === 'reports') renderReports();
  if (view === 'settle') renderSettle();
}

/* ---------- تأجيل القسط ---------- */
function openPostpone(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  const i = u.installments.find(x => x.id === instId); if (!i) return;
  postponeTarget = { unitId, instId };
  $('#postponeInfo').textContent = `القسط: ${fmtEGP(i.amount)} — الاستحقاق الحالي ${fmtDate(i.dueDate)}`;
  $('#postponeForm').querySelector('[name=newDate]').value = i.dueDate;
  $('#postponeModal').classList.remove('hidden');
}
function closePostpone() { $('#postponeModal').classList.add('hidden'); postponeTarget = null; }
function savePostpone(newDate) {
  if (!postponeTarget || !newDate) return;
  const u = findUnit(postponeTarget.unitId); if (!u) return;
  const i = u.installments.find(x => x.id === postponeTarget.instId); if (!i) return;
  i.dueDate = newDate;
  if (!/تأجيل/.test(i.label || '')) i.label = (i.label ? i.label + ' ' : '') + '(مؤجّل)';
  closePostpone(); persist(); renderAll();
}

function openUnitModal(unit) {
  editingUnitId = unit ? unit.id : null;
  $('#unitModalTitle').textContent = unit ? 'تعديل الوحدة' : 'إضافة وحدة';
  const f = $('#unitForm'); f.reset();
  if (unit) {
    f.name.value = unit.name || ''; f.project.value = unit.project || '';
    f.totalPrice.value = unit.totalPrice || ''; f.downPayment.value = unit.downPayment || '';
    f.notes.value = unit.notes || '';
  }
  $('#unitModal').classList.remove('hidden');
}
function closeUnitModal() { $('#unitModal').classList.add('hidden'); editingUnitId = null; }

function openInstModal(unitId) {
  addInstUnitId = unitId;
  $('#singleForm').reset(); $('#scheduleForm').reset();
  $('#singleForm').querySelector('[name=dueDate]').value = todayISO();
  $('#scheduleForm').querySelector('[name=startDate]').value = todayISO();
  setInstMode('single'); updateScheduleHint();
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
  const amount = Number(f.amount.value || 0), count = Number(f.count.value || 0), freq = Number(f.frequency.value || 1);
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
  if (d.getDate() !== day) d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- عمليات البيانات ---------- */
function findUnit(id) { return state.units.find(u => u.id === id); }
function togglePaid(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  const i = u.installments.find(x => x.id === instId); if (!i) return;
  i.paid = !i.paid; i.paidDate = i.paid ? todayISO() : null;
  persist(); renderAll();
}
function deleteInstallment(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  u.installments = u.installments.filter(x => x.id !== instId);
  persist(); renderAll();
}
function deleteUnit(id) {
  const u = findUnit(id); if (!u) return;
  if (!confirm(`حذف الوحدة «${u.name}» وكل أقساطها؟`)) return;
  state.units = state.units.filter(x => x.id !== id);
  persist(); renderAll();
}

/* ==========================================================================
   المصادقة (Firebase) والمزامنة
   ========================================================================== */
function openAccountModal() {
  $('#accountUserLine').textContent = currentUser ? `مسجّل الدخول: ${currentUser.email || currentUser.uid}` : 'غير مسجّل';
  $('#autoRateToggle').checked = !!state.autoRate;
  $('#notifToggle').checked = notifEnabled;
  $('#accountModal').classList.remove('hidden');
}
function closeAccountModal() { $('#accountModal').classList.add('hidden'); }

async function doLogin(email, password) {
  const msg = $('#loginMsg');
  const btn = $('#loginBtn');
  btn.disabled = true;
  msg.className = 'msg info'; msg.textContent = 'جارٍ تسجيل الدخول…'; msg.classList.remove('hidden');
  try {
    await fbAuth.signInWithEmailAndPassword(email, password);
    // تُكمل onAuthStateChanged بقية العمل
    msg.classList.add('hidden');
  } catch (e) {
    let m = e.message || String(e);
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/i.test(m)) m = 'بريد أو كلمة مرور غير صحيحة.';
    else if (/too-many-requests/i.test(m)) m = 'محاولات كثيرة — انتظر قليلاً.';
    else if (/network/i.test(m)) m = 'تعذّر الاتصال بالإنترنت.';
    msg.className = 'msg err'; msg.textContent = m; msg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function doLogout() {
  try { await fbAuth.signOut(); } catch (e) { /* تجاهل */ }
  closeAccountModal();
}

/* عند تغيّر حالة الدخول */
async function onAuthChanged(user) {
  currentUser = user || null;
  if (!currentUser) {
    document.body.classList.remove('authed');
    resetState();
    return;
  }
  // مستخدم مسجّل: حمّل بياناته المحلية ثم السحابية
  document.body.classList.add('authed');
  resetState();
  loadLocal();
  $('#rateInput').value = state.rate;
  renderAll();

  await detectCloud();
  await syncOnLoad();

  // فعّل سعر الصرف التلقائي مرة واحدة لكل حساب (يُحفظ للحساب)
  if (!state._prefsInit) { state.autoRate = true; state._prefsInit = true; persist(); }

  $('#rateInput').value = state.rate;
  renderAll();
  updateRateInfoUI();

  if (state.autoRate) fetchAutoRate(false);
  maybeShowBrowserNotif();
}

/* ==========================================================================
   ربط الأحداث
   ========================================================================== */
function bindEvents() {
  const rateInput = $('#rateInput');
  rateInput.value = state.rate;
  rateInput.addEventListener('input', () => {
    const v = Number(rateInput.value);
    if (v > 0) { state.rate = v; state.rateInfo = null; persist(); renderAll(); }
  });
  $('#rateRefresh').addEventListener('click', () => fetchAutoRate(true));

  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#addUnitBtn').addEventListener('click', () => openUnitModal(null));
  $('#closeUnitModal').addEventListener('click', closeUnitModal);
  $('#cancelUnitBtn').addEventListener('click', closeUnitModal);
  $('#unitModal').addEventListener('click', e => { if (e.target.id === 'unitModal') closeUnitModal(); });

  $('#unitForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const data = {
      name: f.name.value.trim(), project: f.project.value.trim(),
      totalPrice: Number(f.totalPrice.value || 0), downPayment: Number(f.downPayment.value || 0),
      notes: f.notes.value.trim(),
    };
    if (!data.name) return;
    if (editingUnitId) Object.assign(findUnit(editingUnitId), data);
    else state.units.push({ id: uid(), ...data, installments: [], _open: true });
    closeUnitModal(); persist(); renderAll();
    if (currentView === 'dashboard') switchView('units');
  });

  $('#closeInstModal').addEventListener('click', closeInstModal);
  $$('.cancel-inst').forEach(b => b.addEventListener('click', closeInstModal));
  $('#installmentModal').addEventListener('click', e => { if (e.target.id === 'installmentModal') closeInstModal(); });
  $$('#instMode .seg-btn').forEach(b => b.addEventListener('click', () => setInstMode(b.dataset.mode)));
  $('#scheduleForm').addEventListener('input', updateScheduleHint);

  $('#singleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    u.installments.push({ id: uid(), amount: Number(f.amount.value || 0), dueDate: f.dueDate.value, label: f.label.value.trim(), paid: false, paidDate: null });
    u._open = true; closeInstModal(); persist(); renderAll();
  });

  $('#scheduleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    const amount = Number(f.amount.value || 0), count = Number(f.count.value || 0), freq = Number(f.frequency.value || 1);
    const start = f.startDate.value;
    if (!amount || !count || !start) return;
    for (let k = 0; k < count; k++) {
      u.installments.push({ id: uid(), amount, dueDate: addMonths(start, k * freq), label: `قسط ${k + 1} من ${count}`, paid: false, paidDate: null });
    }
    u._open = true; closeInstModal(); persist(); renderAll();
  });

  $('#upcomingRange').addEventListener('change', renderUpcoming);

  // التنبيهات
  $('#bellBtn').addEventListener('click', toggleNotifPanel);
  document.addEventListener('click', e => {
    const p = $('#notifPanel');
    if (!p.classList.contains('hidden') && !p.contains(e.target) && e.target.id !== 'bellBtn' && !$('#bellBtn').contains(e.target)) p.classList.add('hidden');
  });

  // تسجيل الدخول والخروج
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email || !password) return;
    await doLogin(email, password);
    // اطلب إذن الإشعارات بعد الدخول (استجابةً لضغطة المستخدم)
    if (!localStorage.getItem(NOTIF_KEY)) {
      const ok = await enableBrowserNotifications(true);
      notifEnabled = ok; localStorage.setItem(NOTIF_KEY, ok ? '1' : '0');
    }
  });
  $('#logoutBtn').addEventListener('click', doLogout);

  // الحساب
  $('#accountBtn').addEventListener('click', openAccountModal);
  $('#closeAccountModal').addEventListener('click', closeAccountModal);
  $('#accountModal').addEventListener('click', e => { if (e.target.id === 'accountModal') closeAccountModal(); });

  $('#autoRateToggle').addEventListener('change', e => {
    state.autoRate = e.target.checked; persist();
    if (state.autoRate) fetchAutoRate(true);
  });
  $('#notifToggle').addEventListener('change', async e => {
    if (e.target.checked) {
      const ok = await enableBrowserNotifications();
      notifEnabled = ok; e.target.checked = ok;
    } else notifEnabled = false;
    localStorage.setItem(NOTIF_KEY, notifEnabled ? '1' : '0');
    if (notifEnabled) maybeShowBrowserNotif();
  });

  $('#exportBtn2').addEventListener('click', exportData);
  $('#importBtn2').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importData);

  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id, uidAttr = btn.dataset.uid;
    switch (act) {
      case 'toggle': { const u = findUnit(id); if (u) { u._open = !u._open; renderUnits(); } break; }
      case 'add-inst': openInstModal(id); break;
      case 'edit-unit': openUnitModal(findUnit(id)); break;
      case 'del-unit': deleteUnit(id); break;
      case 'toggle-paid': togglePaid(uidAttr, id); break;
      case 'del-inst': deleteInstallment(uidAttr, id); break;
      case 'postpone': openPostpone(uidAttr, id); break;
      case 'print': printReport(); break;
      case 'settle-toggle': { settleSelected.has(id) ? settleSelected.delete(id) : settleSelected.add(id); renderSettle(); break; }
      case 'settle-clear': settleSelected.clear(); renderSettle(); break;
      case 'settle-pay': paySelected(); break;
      case 'settle-refresh': fetchAutoRate(true); break;
    }
  });

  // تأجيل القسط
  $('#closePostponeModal').addEventListener('click', closePostpone);
  $('#cancelPostpone').addEventListener('click', closePostpone);
  $('#postponeModal').addEventListener('click', e => { if (e.target.id === 'postponeModal') closePostpone(); });
  $('#postponeForm').addEventListener('submit', e => {
    e.preventDefault();
    savePostpone(e.target.querySelector('[name=newDate]').value);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeUnitModal(); closeInstModal(); closeAccountModal(); closePostpone(); $('#notifPanel').classList.add('hidden'); }
  });
}

/* ---------- تصدير / استيراد ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `aksat-backup-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(url);
}
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.units)) throw new Error('صيغة غير صحيحة');
      if (!confirm('سيتم استبدال البيانات الحالية بالكامل. متابعة؟')) return;
      state = withDefaults(parsed);
      $('#rateInput').value = state.rate;
      persist(); renderAll();
      alert('تم الاستيراد بنجاح.');
    } catch (err) { alert('تعذّر قراءة الملف: ' + err.message); }
  };
  reader.readAsText(file); e.target.value = '';
}

/* ==========================================================================
   بيانات تجريبية عند أول استخدام (تظهر فقط إن لم توجد بيانات محلية ولا سحابية)
   ========================================================================== */
/* ---------- الإقلاع ---------- */
function init() {
  notifEnabled = localStorage.getItem(NOTIF_KEY) === '1';
  bindEvents();
  switchView('dashboard');
  renderAll();

  // تهيئة Firebase للمصادقة
  if (typeof firebase === 'undefined' || !firebase.auth) {
    $('#loginMsg').className = 'msg err';
    $('#loginMsg').textContent = 'تعذّر تحميل نظام الدخول — تحقّق من الاتصال بالإنترنت.';
    $('#loginMsg').classList.remove('hidden');
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbAuth.onAuthStateChanged(onAuthChanged);
  } catch (e) {
    $('#loginMsg').className = 'msg err';
    $('#loginMsg').textContent = 'خطأ في تهيئة الدخول: ' + (e.message || e);
    $('#loginMsg').classList.remove('hidden');
  }
}
document.addEventListener('DOMContentLoaded', init);
