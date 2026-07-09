// دالة جلب سعر الصرف تلقائياً (الريال السعودي → الجنيه المصري)
//   GET /api/rate  → { rate: <عدد الجنيهات لكل ريال>, source, fetchedAt }
//
// تجلب السعر من مزوّد مجاني دون مفتاح، مع تخزين مؤقت لمدة ساعة في Neon
// (إن توفر DATABASE_URL) لتقليل الطلبات. تعمل الدالة أيضاً دون قاعدة بيانات.

const { neon } = require('@neondatabase/serverless');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const PAIR = 'SAR_EGP';
const TTL_MS = 60 * 60 * 1000; // ساعة واحدة

function reply(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

async function fetchLive() {
  // مزوّدان احتياطيان — نجرّب الأول ثم الثاني
  const providers = [
    async () => {
      const r = await fetch('https://open.er-api.com/v6/latest/SAR');
      const j = await r.json();
      const v = j && j.rates && j.rates.EGP;
      if (v) return { rate: Number(v), source: 'open.er-api.com' };
      throw new Error('لا يوجد سعر EGP');
    },
    async () => {
      const r = await fetch('https://api.exchangerate.host/latest?base=SAR&symbols=EGP');
      const j = await r.json();
      const v = j && j.rates && j.rates.EGP;
      if (v) return { rate: Number(v), source: 'exchangerate.host' };
      throw new Error('لا يوجد سعر EGP');
    },
  ];
  let lastErr;
  for (const p of providers) {
    try {
      const out = await p();
      if (out.rate > 0) return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('تعذّر جلب السعر');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});

  const hasDb = !!process.env.DATABASE_URL;
  let sql = null;
  if (hasDb) {
    try { sql = neon(process.env.DATABASE_URL); } catch { sql = null; }
  }

  // محاولة القراءة من التخزين المؤقت
  if (sql) {
    try {
      await sql`CREATE TABLE IF NOT EXISTS fx_cache (pair TEXT PRIMARY KEY, rate NUMERIC NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      const rows = await sql`SELECT rate, fetched_at FROM fx_cache WHERE pair = ${PAIR}`;
      if (rows.length) {
        const age = Date.now() - new Date(rows[0].fetched_at).getTime();
        if (age < TTL_MS) {
          return reply(200, { rate: Number(rows[0].rate), source: 'cache', fetchedAt: rows[0].fetched_at });
        }
      }
    } catch { /* نتجاهل ونجلب مباشرة */ }
  }

  try {
    const { rate, source } = await fetchLive();
    if (sql) {
      try {
        await sql`
          INSERT INTO fx_cache (pair, rate, fetched_at) VALUES (${PAIR}, ${rate}, now())
          ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = now()`;
      } catch { /* التخزين المؤقت اختياري */ }
    }
    return reply(200, { rate, source, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return reply(502, { error: 'تعذّر جلب سعر الصرف: ' + (err.message || String(err)) });
  }
};
