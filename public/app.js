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
// تصنيفات الوحدات (قابلة للتوسعة بتصنيفات مخصّصة)
const UNIT_TYPES = [
  { key: 'land', icon: '🏞️', label: 'قطعة أرض' },
  { key: 'office', icon: '🏢', label: 'مكتب' },
  { key: 'shop', icon: '🏪', label: 'محل تجاري' },
  { key: 'apartment', icon: '🏠', label: 'شقة سكنية' },
  { key: 'villa', icon: '🏡', label: 'فيلا' },
  { key: 'car', icon: '🚗', label: 'سيارة' },
  { key: 'other', icon: '📦', label: 'أخرى' },
];
function allTypes() { return UNIT_TYPES.concat(state.customTypes || []); }
function unitType(u) { return allTypes().find(t => t.key === (u && u.type)) || { icon: '🏠', label: '' }; }

// أرقام لاتينية (إنجليزية) موحّدة + رموز العملات الرسمية
const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const SYM = { EGP: 'E£', SAR: '﷼', USD: '$' };
function fmtEGP(n) { return NF.format(Math.round(n || 0)) + ' ' + SYM.EGP; }
function fmtSAR(n) { return NF.format(Math.round((n || 0) / state.rate)) + ' ' + SYM.SAR; }
function fmtUSD(n) { return NF.format(Math.round((n || 0) / state.usdRate)) + ' ' + SYM.USD; }
// تحويل مبلغ بعملة ما إلى جنيه مصري
function toEGP(amount, cur) {
  amount = Number(amount) || 0;
  if (cur === 'SAR') return amount * state.rate;
  if (cur === 'USD') return amount * state.usdRate;
  return amount;
}
function fmtCur(amount, cur) {
  const a = Math.round(Number(amount) || 0);
  return NF.format(a) + ' ' + (SYM[cur] || cur);
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
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
function monthKey(iso) {
  const d = new Date(iso + 'T00:00:00');
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' }).format(d);
}
function monthShort(y, m) {
  const d = new Date(y, m, 1);
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'short' }).format(d);
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
  // ترحيل الأرصدة القديمة {usd,egp} إلى قائمة حسابات
  if (!Array.isArray(s.accounts)) {
    s.accounts = [];
    const a = s.assets || {};
    if (Number(a.usd)) s.accounts.push({ id: uid(), name: 'حساب الدولار', amount: Number(a.usd), currency: 'USD' });
    if (Number(a.egp)) s.accounts.push({ id: uid(), name: 'حساب الجنيه', amount: Number(a.egp), currency: 'EGP' });
  }
  s.accounts = s.accounts.map(x => ({ id: x.id || uid(), name: x.name || 'حساب', amount: Number(x.amount) || 0, currency: ['EGP', 'SAR', 'USD'].includes(x.currency) ? x.currency : 'EGP' }));
  delete s.assets;
  if (!Array.isArray(s.customTypes)) s.customTypes = [];
  return s;
}

/* ---------- المحافظ والأدوار ---------- */
let portfolios = [];        // [{ key(ownerUid), role, ownerEmail, self }]
let activePortfolio = null; // المحفظة المعروضة حالياً

function activeKey() { return activePortfolio ? activePortfolio.key : (currentUser ? currentUser.uid : ''); }
function canEdit() { return !activePortfolio || activePortfolio.role !== 'viewer'; }
function portfolioQuery() { return activePortfolio ? `?portfolio=${encodeURIComponent(activePortfolio.key)}` : ''; }
function roleLabel(r) { return r === 'owner' ? 'مالك' : r === 'editor' ? 'محرّر' : 'مشاهد'; }
function applyRoleUI() {
  document.body.classList.toggle('readonly', !canEdit());
  const el = $('#pfIndicator');
  if (el) {
    if (activePortfolio && !activePortfolio.self) {
      el.classList.remove('hidden');
      el.innerHTML = `👁️ محفظة: ${escapeHtml(activePortfolio.ownerEmail || '')} · <b>${roleLabel(activePortfolio.role)}</b>`;
    } else el.classList.add('hidden');
  }
}

// مفتاح تخزين محلي خاص بكل مستخدم/محفظة
function localKey() { return LOCAL_KEY + ':' + activeKey(); }
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
let syncingInitial = false; // أثناء أول مزامنة بلا بيانات محلية → نعرض هياكل تحميل

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
  if (!currentUser || !cloudAvailable || !canEdit()) return;
  pendingSync = true;
  setSync('sync', 'جارٍ الحفظ…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(cloudPush, 600);
}

async function cloudPush() {
  if (!currentUser || !cloudAvailable || !canEdit()) return;
  try {
    const h = await authHeaders();
    if (!h) throw new Error('no-token');
    const res = await fetch(`${API}/state${portfolioQuery()}`, {
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
  const res = await fetch(`${API}/state${portfolioQuery()}`, { headers: h });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  const data = await res.json(); // { state, updatedAt, role }
  if (data.role && activePortfolio) activePortfolio.role = data.role; // الخادم مرجع الدور
  return data;
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

    if (remoteState && Array.isArray(remoteState.units) && (remoteTs >= localTs || !canEdit())) {
      state = withDefaults(remoteState);
      saveLocal();
      setSync('ok', 'مُزامَن سحابياً');
    } else if (state.units.length && canEdit()) {
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
  if (syncingInitial && !state.units.length) {
    $('#summary').innerHTML = Array.from({ length: 4 }, () => `
      <div class="stat skel-card">
        <div class="skel skel-line sm"></div>
        <div class="skel skel-line lg"></div>
        <div class="skel skel-line sm"></div>
      </div>`).join('');
    return;
  }
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
  if (syncingInitial && !state.units.length) {
    el.innerHTML = `
      <div class="card skel-card"><div class="skel skel-line md"></div><div class="skel skel-block"></div></div>
      <div class="card skel-card"><div class="skel skel-line md"></div><div class="skel skel-donut"></div></div>`;
    return;
  }
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
        <div class="unit-title">${unitType(u).icon} ${escapeHtml(u.name)}</div>
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
        <div class="unit-title">${unitType(u).icon} ${escapeHtml(u.name)}</div>
        <div class="unit-project">${unitType(u).label}${u.project ? ' · ' + escapeHtml(u.project) : ''}</div>
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

  const grand = list.reduce((s, i) => s + Number(i.amount || 0), 0);
  const monthsCount = Object.keys(groups).length;
  const summaryCard = `
    <div class="settle-result" style="border-inline-start-color:var(--brand);margin-bottom:14px">
      <div class="sr-row big"><span>إجمالي الأقساط المعروضة</span><b>${fmtEGP(grand)}</b></div>
      <div class="sr-cur big">${fmtSAR(grand)} · ${fmtUSD(grand)}</div>
      <div class="sr-row" style="margin-top:8px"><span>${list.length} قسط · ${monthsCount} شهر</span><span></span></div>
    </div>`;

  wrap.innerHTML = summaryCard + Object.entries(groups).map(([month, items]) => {
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
  const today = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
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
    <div class="pr-sub">التاريخ: ${today}${who ? ' · ' + escapeHtml(who) : ''} · 1 ﷼ = ${state.rate} E£ · 1 $ = ${state.usdRate} E£</div>

    <h2>المؤشرات</h2>
    <div class="pr-kpis">
      <div class="pr-kpi"><div class="k">نسبة السداد</div><div class="v">${pctPaid}%</div></div>
      <div class="pr-kpi"><div class="k">عدد الوحدات</div><div class="v">${state.units.length}</div></div>
      <div class="pr-kpi"><div class="k">أقساط متبقّية</div><div class="v">${unpaid.length}</div></div>
      <div class="pr-kpi"><div class="k">أقساط متأخّرة</div><div class="v">${overdue.length}</div></div>
    </div>
    <div class="pr-bar"><span style="width:${pctPaid}%"></span></div>
    <table>
      <tr><th>المؤشر</th><th class="num">E£</th><th class="num">﷼</th><th class="num">$</th></tr>
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
        <tr><th>#</th><th>الوصف</th><th>الاستحقاق</th><th class="num">المبلغ (E£)</th><th class="num">المبلغ (﷼)</th><th>الحالة</th></tr>
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
let settleFrom = null, settleTo = null;

function accountsEGP() { return state.accounts.reduce((s, a) => s + toEGP(a.amount, a.currency), 0); }
function settleUnpaidFiltered() {
  return allInstallments().filter(i => !i.paid)
    .filter(i => (!settleFrom || i.dueDate >= settleFrom) && (!settleTo || i.dueDate <= settleTo))
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
}

function settleResultHtml() {
  const assetsEGP = accountsEGP();
  const selEGP = allInstallments().filter(i => !i.paid && settleSelected.has(i.id)).reduce((s, i) => s + Number(i.amount || 0), 0);
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

function accountsHtml() {
  const dis = canEdit() ? '' : 'disabled';
  const rows = state.accounts.map(a => `
    <div class="acc-row" data-acc="${a.id}">
      <input class="acc-name" data-acc="${a.id}" type="text" value="${escapeHtml(a.name)}" placeholder="اسم الحساب" ${dis} />
      <input class="acc-amt" data-acc="${a.id}" type="number" min="0" step="0.01" inputmode="decimal" value="${a.amount || ''}" placeholder="0" ${dis} />
      <select class="acc-cur select" data-acc="${a.id}" ${dis}>
        <option value="EGP" ${a.currency === 'EGP' ? 'selected' : ''}>جنيه</option>
        <option value="SAR" ${a.currency === 'SAR' ? 'selected' : ''}>ريال</option>
        <option value="USD" ${a.currency === 'USD' ? 'selected' : ''}>دولار</option>
      </select>
      ${canEdit() ? `<button class="icon-btn" data-act="acc-del" data-id="${a.id}" title="حذف">✕</button>` : ''}
    </div>`).join('');
  return rows + (canEdit() ? `<button class="add-inst-btn" data-act="acc-add" style="margin-top:6px">+ إضافة حساب</button>` : '');
}

function renderSettle() {
  const el = $('#view-settle');
  if (!settleFrom) settleFrom = todayISO();
  if (!settleTo) settleTo = addMonths(todayISO(), 1);

  const list = settleUnpaidFiltered();
  const validIds = new Set(allInstallments().filter(i => !i.paid).map(i => i.id));
  [...settleSelected].forEach(id => { if (!validIds.has(id)) settleSelected.delete(id); });
  const shortfall = accountsEGP() - allInstallments().filter(i => !i.paid && settleSelected.has(i.id)).reduce((s, i) => s + Number(i.amount || 0), 0) < 0;

  const rowsHtml = list.length ? list.map(i => {
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
  }).join('') : '<div class="pf-empty" style="text-align:center;padding:14px">لا أقساط ضمن هذه الفترة.</div>';

  el.innerHTML = `
    <div class="report-block">
      <h3>💰 أرصدة الحسابات</h3>
      <div class="rsub">أضف حساباتك بأي عملة؛ يُقارن مجموعها بالأقساط المختارة.</div>
      <div class="acc-list">${accountsHtml()}</div>
      <div class="rate-note">أسعار اليوم: 1 دولار = ${state.usdRate} E£ · 1 ريال = ${state.rate} E£
        <button class="btn ghost small" data-act="settle-refresh" style="margin-inline-start:8px">⟳ تحديث</button></div>
    </div>

    <div class="report-block">
      <h3>🗓️ فترة الأقساط</h3>
      <div class="row">
        <label>من تاريخ
          <input type="date" id="settleFrom" value="${settleFrom}" />
        </label>
        <label>إلى تاريخ
          <input type="date" id="settleTo" value="${settleTo}" />
        </label>
      </div>
    </div>

    <div class="settle-result ${shortfall ? 'short' : ''}" id="settleResult">${settleResultHtml()}</div>

    <div class="report-block">
      <div class="view-head" style="margin-bottom:8px">
        <h3 style="margin:0">اختر الأقساط (${list.length})</h3>
        <button class="btn ghost small" data-act="settle-clear">إلغاء التحديد</button>
      </div>
      <div class="inst-list">${rowsHtml}</div>
      ${settleSelected.size && canEdit() ? `<button class="btn primary" data-act="settle-pay" style="width:100%;margin-top:12px">✓ تحديد المختار كمدفوع (${settleSelected.size})</button>` : ''}
    </div>`;

  // ربط حقول الحسابات
  const refreshRes = () => { $('#settleResult').innerHTML = settleResultHtml(); };
  const findAcc = id => state.accounts.find(a => a.id === id);
  $$('.acc-name').forEach(inp => inp.addEventListener('input', () => { const a = findAcc(inp.dataset.acc); if (a) { a.name = inp.value; persist(); } }));
  $$('.acc-amt').forEach(inp => inp.addEventListener('input', () => { const a = findAcc(inp.dataset.acc); if (a) { a.amount = Number(inp.value) || 0; persist(); refreshRes(); } }));
  $$('.acc-cur').forEach(sel => sel.addEventListener('change', () => { const a = findAcc(sel.dataset.acc); if (a) { a.currency = sel.value; persist(); refreshRes(); } }));
  // تاريخ الفترة
  const f = $('#settleFrom'), t = $('#settleTo');
  if (f) f.addEventListener('change', () => { settleFrom = f.value; renderSettle(); });
  if (t) t.addEventListener('change', () => { settleTo = t.value; renderSettle(); });
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
  return `<svg class="chart-svg chart-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}${labels}</svg>`;
}

function donutChart(paid, remaining) {
  const total = paid + remaining;
  const pct = total > 0 ? paid / total : 0;
  const R = 70, C = 2 * Math.PI * R, stroke = 26;
  const dash = C * pct;
  return `
  <div class="donut-wrap">
    <svg class="chart-svg donut-svg" viewBox="0 0 180 180" role="img">
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--ok)" stroke-width="${stroke}"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${C * 0.25}" stroke-linecap="round"
        transform="rotate(-90 90 90)"/>
      <text x="90" y="86" text-anchor="middle" style="font-size:26px;font-weight:800;fill:var(--ink)">${Math.round(pct * 100)}%</text>
      <text x="90" y="106" text-anchor="middle" style="font-size:12px">مدفوع</text>
    </svg>
    <div class="legend">
      <span class="lk"><span class="sw" style="background:var(--ok)"></span> مدفوع: ${fmtEGP(paid)} · ${fmtSAR(paid)}</span>
      <span class="lk"><span class="sw" style="background:var(--line)"></span> متبقٍّ: ${fmtEGP(remaining)} · ${fmtSAR(remaining)}</span>
    </div>
  </div>`;
}

function unitsTable() {
  const card = (name, sch, paid, rem, tot) => {
    const pct = sch > 0 ? Math.round((paid / sch) * 100) : 0;
    return `<div class="ureport ${tot ? 'tot' : ''}">
      <div class="ur-head"><span class="ur-name">${escapeHtml(name)}</span><span class="ur-pct">${pct}%</span></div>
      <div class="progress" style="margin:6px 0 10px"><span style="width:${pct}%"></span></div>
      <div class="ur-grid">
        <div><div class="k">مجدول</div><div class="v">${fmtEGP(sch)}</div></div>
        <div><div class="k">مدفوع</div><div class="v" style="color:var(--ok)">${fmtEGP(paid)}</div></div>
        <div><div class="k">متبقٍّ</div><div class="v" style="color:var(--brand)">${fmtEGP(rem)}</div></div>
      </div>
    </div>`;
  };
  const cards = state.units.map(u => card(u.name, unitScheduledTotal(u), unitPaidTotal(u), unitRemaining(u))).join('');
  const tSch = state.units.reduce((s, u) => s + unitScheduledTotal(u), 0);
  const tPaid = state.units.reduce((s, u) => s + unitPaidTotal(u), 0);
  const tRem = state.units.reduce((s, u) => s + unitRemaining(u), 0);
  return `<div class="ureport-list">${cards}${card('الإجمالي', tSch, tPaid, tRem, true)}</div>`;
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
  const fx = $('#fxLine');
  if (fx) fx.classList.add('loading');
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
      persist();
      renderAll();
      updateFxLine();
      if (manual) setSync('ok', `تم تحديث الأسعار`);
    } else if (manual) {
      alert('تعذّر جلب سعر الصرف حالياً.');
    }
  } catch (e) {
    if (manual) alert('تعذّر جلب سعر الصرف: تحقّق من الاتصال.');
  } finally {
    if (fx) fx.classList.remove('loading');
  }
}

function updateFxLine() {
  if ($('#fxUsd')) $('#fxUsd').textContent = state.usdRate;
  if ($('#fxSar')) $('#fxSar').textContent = state.rate;
  if ($('#rateInput')) $('#rateInput').value = state.rate;
}
function updateRateInfoUI() { updateFxLine(); }

/* ---------- الوضع الداكن ---------- */
function applyDark(on) {
  document.body.classList.toggle('dark', on);
  const b = $('#darkBtn');
  if (b) b.textContent = on ? '☀️' : '🌙';
  localStorage.setItem('aksat.dark', on ? '1' : '0');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', on ? '#0b1220' : '#0f766e');
}
function toggleDark() { applyDark(!document.body.classList.contains('dark')); }
function initDark() {
  const saved = localStorage.getItem('aksat.dark');
  const on = saved === null ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) : saved === '1';
  applyDark(!!on);
}

/* ---------- تحية المستخدم ---------- */
function updateGreeting() {
  const el = $('#greeting');
  if (!el) return;
  if (currentView !== 'dashboard' || !state.units.length) { el.innerHTML = ''; return; }
  let name = '';
  if (currentUser) name = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '');
  el.innerHTML = `<h2>مرحبًا ${name ? escapeHtml(name) : 'بك'} 👋</h2><p>هذه نظرة سريعة على التزاماتك اليوم</p>`;
}

/* ==========================================================================
   الأدوات المشتركة
   ========================================================================== */
function emptyState(title, msg, icon) {
  return `<div class="empty"><div class="big">${icon}</div><div style="font-weight:700;color:var(--ink)">${title}</div><div style="margin-top:4px">${msg}</div></div>`;
}

/* ---------- شاشة الترحيب لأول استخدام ---------- */
const ONBOARD_KEY = 'aksat_onboarded';
let onboardStep = 0;
function onboardSlideCount() { return $$('#onboardSlides .onboard-slide').length; }
function maybeShowOnboarding() {
  if (!currentUser) return;
  if (localStorage.getItem(ONBOARD_KEY)) return;
  if (state.units.length) { localStorage.setItem(ONBOARD_KEY, '1'); return; } // مستخدم لديه بيانات (منقولة) → لا حاجة
  onboardStep = 0;
  renderOnboard();
  $('#onboardOverlay').classList.remove('hidden');
}
function renderOnboard() {
  const n = onboardSlideCount();
  $$('#onboardSlides .onboard-slide').forEach((s, i) => s.classList.toggle('on', i === onboardStep));
  const dots = $('#onboardDots');
  if (dots) dots.innerHTML = Array.from({ length: n }, (_, i) => `<span class="odot ${i === onboardStep ? 'on' : ''}"></span>`).join('');
  const last = onboardStep >= n - 1;
  $('#onboardBack').classList.toggle('hidden', onboardStep === 0);
  $('#onboardNext').textContent = last ? 'أضف أول وحدة' : 'التالي';
}
function nextOnboard() {
  if (onboardStep >= onboardSlideCount() - 1) { finishOnboarding(true); return; }
  onboardStep++; renderOnboard();
}
function prevOnboard() { if (onboardStep > 0) { onboardStep--; renderOnboard(); } }
function finishOnboarding(openUnit) {
  localStorage.setItem(ONBOARD_KEY, '1');
  $('#onboardOverlay').classList.add('hidden');
  if (openUnit && canEdit()) openUnitModal(null);
}

function renderAll() {
  renderSummary();
  renderDashboard();
  renderUnits();
  renderUpcoming();
  if (currentView === 'reports') renderReports();
  if (currentView === 'settle') renderSettle();
  updateGreeting();
  updateFxLine();
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
  const sum = $('#summary');
  if (sum) sum.style.display = view === 'dashboard' ? '' : 'none';
  if (view === 'reports') renderReports();
  if (view === 'settle') renderSettle();
  updateGreeting();
  window.scrollTo(0, 0);
}

/* ---------- تأجيل القسط ---------- */
function openPostpone(unitId, instId) {
  const u = findUnit(unitId); if (!u) return;
  const i = u.installments.find(x => x.id === instId); if (!i) return;
  postponeTarget = { unitId, instId };
  $('#postponeInfo').textContent = `القسط: ${fmtEGP(i.amount)} — الاستحقاق الحالي ${fmtDate(i.dueDate)}`;
  clearErrs($('#postponeForm'));
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

let editUnitType = 'apartment';
function renderTypePicker() {
  const el = $('#unitTypePicker');
  el.innerHTML = allTypes().map(t =>
    `<button type="button" class="type-chip ${t.key === editUnitType ? 'on' : ''}" data-type="${t.key}">${t.icon} ${escapeHtml(t.label)}</button>`
  ).join('') + `<button type="button" class="type-chip add" data-type="__add">＋ تصنيف</button>`;
}
function openUnitModal(unit) {
  editingUnitId = unit ? unit.id : null;
  editUnitType = (unit && unit.type) || 'apartment';
  $('#unitModalTitle').textContent = unit ? 'تعديل الوحدة' : 'إضافة وحدة';
  const f = $('#unitForm'); f.reset(); clearErrs(f);
  if (unit) {
    f.name.value = unit.name || ''; f.project.value = unit.project || '';
    f.totalPrice.value = unit.totalPrice || ''; f.downPayment.value = unit.downPayment || '';
    f.notes.value = unit.notes || '';
  }
  renderTypePicker();
  $('#unitModal').classList.remove('hidden');
}
function closeUnitModal() { $('#unitModal').classList.add('hidden'); editingUnitId = null; }

function pickUnitType(key) {
  if (key === '__add') {
    const label = (prompt('اسم التصنيف الجديد:') || '').trim();
    if (!label) return;
    const icon = (prompt('رمز/إيموجي للتصنيف (اختياري):') || '📦').trim() || '📦';
    const k = 'c' + uid();
    state.customTypes.push({ key: k, icon, label });
    editUnitType = k;
    persist();
  } else {
    editUnitType = key;
  }
  renderTypePicker();
}

function openInstModal(unitId) {
  addInstUnitId = unitId;
  $('#singleForm').reset(); $('#scheduleForm').reset();
  clearErrs($('#singleForm')); clearErrs($('#scheduleForm'));
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
  $('#profileName').value = (currentUser && currentUser.displayName) || '';
  $('#newPassword').value = '';
  $('#profileMsg').classList.add('hidden');
  $('#autoRateToggle').checked = !!state.autoRate;
  $('#notifToggle').checked = notifEnabled;
  $('#darkToggle').checked = document.body.classList.contains('dark');
  renderPortfolioList();
  loadMembers();
  $('#accountModal').classList.remove('hidden');
}
function closeAccountModal() { $('#accountModal').classList.add('hidden'); }

function profileMsg(kind, text) { const m = $('#profileMsg'); m.className = 'msg ' + kind; m.textContent = text; m.classList.remove('hidden'); }

async function saveDisplayName() {
  const name = $('#profileName').value.trim();
  if (!currentUser) return;
  profileMsg('info', 'جارٍ الحفظ…');
  try {
    await currentUser.updateProfile({ displayName: name });
    updateGreeting();
    profileMsg('ok', 'تم حفظ الاسم.');
  } catch (e) { profileMsg('err', authErrorMsg(e)); }
}

async function changePassword() {
  const pw = $('#newPassword').value;
  if (!currentUser) return;
  if (!pw || pw.length < 6) { profileMsg('err', 'كلمة المرور ٦ أحرف على الأقل.'); return; }
  profileMsg('info', 'جارٍ تغيير كلمة المرور…');
  try {
    await currentUser.updatePassword(pw);
    $('#newPassword').value = '';
    profileMsg('ok', 'تم تغيير كلمة المرور.');
  } catch (e) {
    const code = (e && (e.code || e.message)) || '';
    if (/requires-recent-login/i.test(code)) {
      const cur = prompt('لأمانك، أدخل كلمة المرور الحالية:');
      if (!cur) { profileMsg('err', 'أُلغي التغيير.'); return; }
      try {
        const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, cur);
        await currentUser.reauthenticateWithCredential(cred);
        await currentUser.updatePassword(pw);
        $('#newPassword').value = '';
        profileMsg('ok', 'تم تغيير كلمة المرور.');
      } catch (e2) { profileMsg('err', authErrorMsg(e2)); }
    } else {
      profileMsg('err', authErrorMsg(e));
    }
  }
}

/* ---------- واجهة المحافظ والمشاركة ---------- */
function renderPortfolioList() {
  const el = $('#portfolioList');
  if (!el) return;
  if (portfolios.length <= 1) {
    el.innerHTML = '<div class="pf-empty">لا توجد محافظ مشتركة معك بعد.</div>';
    return;
  }
  el.innerHTML = portfolios.map(p => {
    const on = activePortfolio && p.key === activePortfolio.key;
    const name = p.self ? 'محفظتي' : (p.ownerEmail || 'محفظة مشتركة');
    return `<div class="pf-item ${on ? 'on' : ''}">
      <div class="pf-info"><div class="pf-name">${on ? '✓ ' : ''}${escapeHtml(name)}</div>
      <div class="pf-role">${roleLabel(p.role)}</div></div>
      ${on ? '<span class="pf-cur">معروضة</span>' : `<button class="btn ghost small" data-act="pf-open" data-id="${escapeHtml(p.key)}">فتح</button>`}
      ${!p.self ? `<button class="icon-btn" data-act="pf-leave" data-id="${escapeHtml(p.key)}" title="مغادرة">✕</button>` : ''}
    </div>`;
  }).join('');
}

async function loadMembers() {
  const el = $('#membersList');
  if (!el || !cloudAvailable) return;
  el.innerHTML = '<div class="pf-empty">جارٍ التحميل…</div>';
  try {
    const h = await authHeaders();
    const res = await fetch(`${API}/shares`, { headers: h });
    const data = await res.json();
    const members = data.members || [];
    if (!members.length) { el.innerHTML = '<div class="pf-empty">لم تشارك محفظتك مع أحد بعد.</div>'; return; }
    el.innerHTML = members.map(m => `
      <div class="pf-item">
        <div class="pf-info"><div class="pf-name">${escapeHtml(m.member_email)}</div>
        <div class="pf-role">${roleLabel(m.role)}${m.status === 'pending' ? ' · بانتظار التسجيل' : ''}</div></div>
        <button class="icon-btn" data-act="member-remove" data-id="${escapeHtml(m.member_email)}" title="إزالة">🗑</button>
      </div>`).join('');
  } catch { el.innerHTML = '<div class="pf-empty">تعذّر تحميل الأعضاء.</div>'; }
}

async function addMember() {
  const email = $('#shareEmail').value.trim();
  const role = $('#shareRole').value;
  const msg = $('#shareMsg');
  if (!email) { msg.className = 'msg err'; msg.textContent = 'أدخل بريد الشخص.'; msg.classList.remove('hidden'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.className = 'msg err'; msg.textContent = 'صيغة البريد غير صحيحة.'; msg.classList.remove('hidden'); return; }
  if (currentUser && email.toLowerCase() === (currentUser.email || '').toLowerCase()) { msg.className = 'msg err'; msg.textContent = 'لا يمكنك دعوة نفسك.'; msg.classList.remove('hidden'); return; }
  msg.className = 'msg info'; msg.textContent = 'جارٍ الإرسال…'; msg.classList.remove('hidden');
  try {
    const h = await authHeaders();
    const res = await fetch(`${API}/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ email, role }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'خطأ');
    $('#shareEmail').value = '';
    msg.className = 'msg ok';
    msg.textContent = data.status === 'pending' ? 'أُضيفت الدعوة — ستُفعّل عند تسجيل هذا الشخص بنفس البريد.' : 'تمت المشاركة بنجاح.';
    loadMembers();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message || 'تعذّرت المشاركة.'; }
}

async function removeMember(email) {
  if (!confirm(`إزالة ${email} من محفظتك؟`)) return;
  try {
    const h = await authHeaders();
    await fetch(`${API}/shares?member=${encodeURIComponent(email)}`, { method: 'DELETE', headers: h });
    loadMembers();
  } catch { /* تجاهل */ }
}

async function leavePortfolio(key) {
  const p = portfolios.find(x => x.key === key);
  if (!p || !confirm(`مغادرة محفظة ${p.ownerEmail || ''}؟`)) return;
  try {
    const h = await authHeaders();
    await fetch(`${API}/shares?leave=${encodeURIComponent(key)}`, { method: 'DELETE', headers: h });
  } catch { /* تجاهل */ }
  await loadPortfolios();
  if (!portfolios.find(x => activePortfolio && x.key === activePortfolio.key)) {
    activePortfolio = portfolios.find(x => x.self) || null;
    await loadActivePortfolio(false);
  }
  renderPortfolioList();
}

/* ---------- Toast بسيط ---------- */
let toastTimer = null;
function toast(text) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- التحقق من المدخلات ورسائل خطأ ودّية ---------- */
function fieldErr(input, msg) {
  if (!input) return;
  input.classList.add('invalid');
  const host = input.closest('label') || input.parentElement;
  let e = host.querySelector('.field-err');
  if (!e) { e = document.createElement('small'); e.className = 'field-err'; host.appendChild(e); }
  e.textContent = msg;
}
function clearErrs(form) {
  form.querySelectorAll('.invalid').forEach(i => i.classList.remove('invalid'));
  form.querySelectorAll('.field-err').forEach(e => e.remove());
}
// checks: [name, isBad(boolean), msg]. يعرض الأخطاء ويركّز أول حقل غير صالح ويرجع true عند السلامة.
function runChecks(form, checks) {
  clearErrs(form);
  let firstBad = null;
  for (const [name, bad, msg] of checks) {
    if (!bad) continue;
    const inp = form.elements[name];
    fieldErr(inp, msg);
    if (!firstBad) firstBad = inp;
  }
  if (firstBad) { if (firstBad.focus) firstBad.focus(); toast('يرجى تصحيح الحقول المميّزة'); return false; }
  return true;
}
// يمسح خطأ الحقل بمجرد أن يبدأ المستخدم بالكتابة فيه.
function clearFieldErrOnInput(form) {
  form.addEventListener('input', e => {
    const t = e.target;
    if (t.classList && t.classList.contains('invalid')) {
      t.classList.remove('invalid');
      const host = t.closest('label') || t.parentElement;
      const er = host && host.querySelector('.field-err');
      if (er) er.remove();
    }
  });
}

let authMode = 'login'; // 'login' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#nameField').classList.toggle('hidden', !signup);
  $('#forgotRow').classList.toggle('hidden', signup);
  $('#loginBtn').textContent = signup ? 'إنشاء حساب' : 'تسجيل الدخول';
  $('#loginPassword').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#authToggleText').textContent = signup ? 'لديك حساب بالفعل؟' : 'ليس لديك حساب؟';
  $('#authToggleBtn').textContent = signup ? 'تسجيل الدخول' : 'أنشئ حسابًا';
  $('#loginMsg').classList.add('hidden');
}

function authErrorMsg(e) {
  const m = (e && (e.code || e.message)) || String(e);
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/i.test(m)) return 'بريد أو كلمة مرور غير صحيحة.';
  if (/email-already-in-use/i.test(m)) return 'هذا البريد مسجّل بالفعل — سجّل الدخول أو استرجع كلمة المرور.';
  if (/weak-password/i.test(m)) return 'كلمة المرور ضعيفة (٦ أحرف على الأقل).';
  if (/invalid-email/i.test(m)) return 'صيغة البريد غير صحيحة.';
  if (/too-many-requests/i.test(m)) return 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة.';
  if (/network/i.test(m)) return 'تعذّر الاتصال بالإنترنت.';
  if (/operation-not-allowed/i.test(m)) return 'إنشاء الحسابات غير مفعّل في الإعدادات.';
  return 'حدث خطأ: ' + m;
}

function loginMsg(kind, text) {
  const msg = $('#loginMsg');
  msg.className = 'msg ' + kind; msg.textContent = text; msg.classList.remove('hidden');
}

async function submitAuth() {
  const name = $('#loginName').value.trim();
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  if (!email || !password) { loginMsg('err', 'أدخل البريد وكلمة المرور.'); return; }
  if (authMode === 'signup' && password.length < 6) { loginMsg('err', 'كلمة المرور ٦ أحرف على الأقل.'); return; }
  const btn = $('#loginBtn'); btn.disabled = true;
  loginMsg('info', authMode === 'signup' ? 'جارٍ إنشاء الحساب…' : 'جارٍ تسجيل الدخول…');
  try {
    if (authMode === 'signup') {
      const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
      if (name && cred.user) { try { await cred.user.updateProfile({ displayName: name }); } catch { /* تجاهل */ } }
      try { await cred.user.sendEmailVerification(); } catch { /* اختياري */ }
      // onAuthStateChanged يكمل الدخول
    } else {
      await fbAuth.signInWithEmailAndPassword(email, password);
    }
    $('#loginMsg').classList.add('hidden');
  } catch (e) {
    loginMsg('err', authErrorMsg(e));
  } finally {
    btn.disabled = false;
  }
}

async function doReset() {
  const email = $('#loginEmail').value.trim();
  if (!email) { loginMsg('err', 'أدخل بريدك أولاً في خانة البريد ثم اضغط «نسيت كلمة المرور».'); return; }
  loginMsg('info', 'جارٍ إرسال رابط الاسترجاع…');
  try {
    await fbAuth.sendPasswordResetEmail(email);
    loginMsg('ok', `أُرسل رابط استرجاع كلمة المرور إلى ${email}. تفقّد بريدك (وصندوق الرسائل غير الهامة).`);
  } catch (e) {
    loginMsg('err', authErrorMsg(e));
  }
}

async function doLogout() {
  try { await fbAuth.signOut(); } catch (e) { /* تجاهل */ }
  closeAccountModal();
  setAuthMode('login');
}

/* عند تغيّر حالة الدخول */
async function onAuthChanged(user) {
  currentUser = user || null;
  if (!currentUser) {
    document.body.classList.remove('authed', 'readonly');
    portfolios = []; activePortfolio = null;
    resetState();
    return;
  }
  document.body.classList.add('authed');
  await detectCloud();
  // حمّل قائمة المحافظ وحدّد محفظتي كافتراضية
  await loadPortfolios();
  activePortfolio = portfolios.find(p => p.self) || null;
  await loadActivePortfolio(true);
  // تلميح: توجد محافظ مشتركة معك
  const sharedCount = portfolios.filter(p => !p.self).length;
  if (sharedCount) setTimeout(() => toast(`لديك ${sharedCount} محفظة مشتركة — افتحها من «الحساب والمزامنة»`), 800);
}

/* تحميل قائمة المحافظ (ملكي + المشتركة معي) */
async function loadPortfolios() {
  if (!cloudAvailable) { portfolios = [{ key: currentUser.uid, role: 'owner', ownerEmail: currentUser.email, self: true }]; return; }
  try {
    const h = await authHeaders();
    const res = await fetch(`${API}/portfolios`, { headers: h });
    if (!res.ok) throw new Error();
    const data = await res.json();
    portfolios = (data.portfolios || []).map(p => ({ ...p }));
    if (!portfolios.length) portfolios = [{ key: currentUser.uid, role: 'owner', ownerEmail: currentUser.email, self: true }];
  } catch {
    portfolios = [{ key: currentUser.uid, role: 'owner', ownerEmail: currentUser.email, self: true }];
  }
}

/* تحميل بيانات المحفظة النشطة وعرضها */
async function loadActivePortfolio(initPrefs) {
  clearTimeout(syncTimer);
  resetState();
  loadLocal();
  $('#rateInput').value = state.rate;
  applyRoleUI();
  syncingInitial = !state.units.length && cloudAvailable && !!currentUser;
  renderAll();

  await syncOnLoad();
  syncingInitial = false;

  if (initPrefs && canEdit() && !state._prefsInit) { state.autoRate = true; state._prefsInit = true; persist(); }

  $('#rateInput').value = state.rate;
  applyRoleUI();
  renderAll();
  updateRateInfoUI();
  if (state.autoRate) fetchAutoRate(false);
  maybeShowBrowserNotif();
  if (initPrefs) maybeShowOnboarding(); // فقط عند أول دخول للجلسة، وليس عند تبديل المحافظ
}

async function switchPortfolio(key) {
  const p = portfolios.find(x => x.key === key);
  if (!p) return;
  activePortfolio = p;
  closeAccountModal();
  await loadActivePortfolio(false);
  toast(p.self ? 'محفظتي' : `محفظة ${p.ownerEmail || ''} (${roleLabel(p.role)})`);
}

/* ==========================================================================
   ربط الأحداث
   ========================================================================== */
function bindEvents() {
  $('#fxLine').addEventListener('click', () => fetchAutoRate(true));
  $('#darkBtn').addEventListener('click', toggleDark);

  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#addUnitBtn').addEventListener('click', () => { if (!canEdit()) return toast('عرض فقط — لا تملك صلاحية التعديل'); openUnitModal(null); });
  $('#unitTypePicker').addEventListener('click', e => { const b = e.target.closest('.type-chip'); if (b) pickUnitType(b.dataset.type); });
  $('#closeUnitModal').addEventListener('click', closeUnitModal);
  $('#cancelUnitBtn').addEventListener('click', closeUnitModal);
  $('#unitModal').addEventListener('click', e => { if (e.target.id === 'unitModal') closeUnitModal(); });

  $('#unitForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    const totalRaw = f.totalPrice.value.trim(), downRaw = f.downPayment.value.trim();
    const total = Number(totalRaw || 0), down = Number(downRaw || 0);
    if (!runChecks(f, [
      ['name', !name, 'أدخل اسم الوحدة'],
      ['totalPrice', totalRaw !== '' && (isNaN(total) || total < 0), 'أدخل قيمة صحيحة (صفر أو أكثر)'],
      ['downPayment', downRaw !== '' && (isNaN(down) || down < 0), 'أدخل قيمة صحيحة (صفر أو أكثر)'],
      ['downPayment', total > 0 && down > total, 'المقدم أكبر من إجمالي السعر'],
    ])) return;
    const data = {
      name, project: f.project.value.trim(),
      totalPrice: total, downPayment: down,
      notes: f.notes.value.trim(), type: editUnitType,
    };
    if (editingUnitId) Object.assign(findUnit(editingUnitId), data);
    else state.units.push({ id: uid(), ...data, installments: [], _open: true });
    closeUnitModal(); persist(); renderAll();
    toast(editingUnitId ? 'تم حفظ التعديلات' : 'تمت إضافة الوحدة');
    if (currentView === 'dashboard') switchView('units');
  });

  $('#closeInstModal').addEventListener('click', closeInstModal);
  $$('.cancel-inst').forEach(b => b.addEventListener('click', closeInstModal));
  $('#installmentModal').addEventListener('click', e => { if (e.target.id === 'installmentModal') closeInstModal(); });
  $$('#instMode .seg-btn').forEach(b => b.addEventListener('click', () => setInstMode(b.dataset.mode)));
  $('#scheduleForm').addEventListener('input', updateScheduleHint);
  ['#unitForm', '#singleForm', '#scheduleForm', '#postponeForm'].forEach(sel => { const el = $(sel); if (el) clearFieldErrOnInput(el); });

  $('#singleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    const amount = Number(f.amount.value || 0);
    if (!runChecks(f, [
      ['amount', !(amount > 0), 'أدخل مبلغ قسط أكبر من صفر'],
      ['dueDate', !f.dueDate.value, 'أدخل تاريخ الاستحقاق'],
    ])) return;
    u.installments.push({ id: uid(), amount, dueDate: f.dueDate.value, label: f.label.value.trim(), paid: false, paidDate: null });
    u._open = true; closeInstModal(); persist(); renderAll();
    toast('تمت إضافة القسط');
  });

  $('#scheduleForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = findUnit(addInstUnitId); if (!u) return;
    const f = e.target;
    const amount = Number(f.amount.value || 0), count = Number(f.count.value || 0), freq = Number(f.frequency.value || 1);
    const start = f.startDate.value;
    if (!runChecks(f, [
      ['amount', !(amount > 0), 'أدخل قيمة قسط أكبر من صفر'],
      ['count', !(count >= 1) || count !== Math.floor(count), 'أدخل عدد أقساط صحيحًا (١ أو أكثر)'],
      ['count', count > 600, 'عدد الأقساط كبير جدًا (٦٠٠ كحدّ أقصى)'],
      ['startDate', !start, 'أدخل تاريخ البداية'],
    ])) return;
    for (let k = 0; k < count; k++) {
      u.installments.push({ id: uid(), amount, dueDate: addMonths(start, k * freq), label: `قسط ${k + 1} من ${count}`, paid: false, paidDate: null });
    }
    u._open = true; closeInstModal(); persist(); renderAll();
    toast(`تمت إضافة ${count} قسط`);
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
    await submitAuth();
    // اطلب إذن الإشعارات بعد الدخول (استجابةً لضغطة المستخدم)
    if (!localStorage.getItem(NOTIF_KEY)) {
      const ok = await enableBrowserNotifications(true);
      notifEnabled = ok; localStorage.setItem(NOTIF_KEY, ok ? '1' : '0');
    }
  });
  $('#forgotLink').addEventListener('click', doReset);
  $('#authToggleBtn').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
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

  // الملف الشخصي والإعدادات
  $('#saveNameBtn').addEventListener('click', saveDisplayName);
  $('#changePwBtn').addEventListener('click', changePassword);
  $('#darkToggle').addEventListener('change', e => applyDark(e.target.checked));

  // المشاركة والمحافظ
  $('#shareAddBtn').addEventListener('click', addMember);

  const EDIT_ACTS = new Set(['add-inst', 'edit-unit', 'del-unit', 'toggle-paid', 'del-inst', 'postpone', 'settle-pay', 'acc-add', 'acc-del']);
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id, uidAttr = btn.dataset.uid;
    if (EDIT_ACTS.has(act) && !canEdit()) { toast('عرض فقط — لا تملك صلاحية التعديل'); return; }
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
      case 'acc-add': state.accounts.push({ id: uid(), name: 'حساب', amount: 0, currency: 'EGP' }); persist(); renderSettle(); break;
      case 'acc-del': state.accounts = state.accounts.filter(a => a.id !== id); persist(); renderSettle(); break;
      case 'pf-open': switchPortfolio(id); break;
      case 'pf-leave': leavePortfolio(id); break;
      case 'member-remove': removeMember(id); break;
    }
  });

  // تأجيل القسط
  $('#closePostponeModal').addEventListener('click', closePostpone);
  $('#cancelPostpone').addEventListener('click', closePostpone);
  $('#postponeModal').addEventListener('click', e => { if (e.target.id === 'postponeModal') closePostpone(); });
  $('#postponeForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    if (!runChecks(f, [['newDate', !f.newDate.value, 'أدخل التاريخ الجديد']])) return;
    savePostpone(f.newDate.value);
  });

  // شاشة الترحيب
  const onNext = $('#onboardNext'), onBack = $('#onboardBack'), onSkip = $('#onboardSkip');
  if (onNext) onNext.addEventListener('click', nextOnboard);
  if (onBack) onBack.addEventListener('click', prevOnboard);
  if (onSkip) onSkip.addEventListener('click', () => finishOnboarding(false));

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
  initDark();
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
