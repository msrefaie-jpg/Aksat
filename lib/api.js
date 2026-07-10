// معالجات مسارات /api لتطبيق أقساط (Cloudflare Worker)
import { neon, json, dbUrl, resolveUserKey, ensureSchema } from './auth.js';

/* ---------- /api/state ---------- */
export async function handleState(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });
  const key = await resolveUserKey(request, env);
  if (!key) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });

  const sql = neon(url);
  try {
    await ensureSchema(sql);
    if (request.method === 'GET') {
      const rows = await sql`SELECT state, updated_at FROM app_state WHERE user_key = ${key}`;
      if (!rows.length) return json(200, { state: null, updatedAt: null });
      return json(200, { state: rows[0].state, updatedAt: rows[0].updated_at });
    }
    if (request.method === 'PUT') {
      let payload;
      try { payload = await request.json(); }
      catch { return json(400, { error: 'صيغة JSON غير صحيحة' }); }
      const st = payload && payload.state;
      if (!st || typeof st !== 'object' || !Array.isArray(st.units)) {
        return json(400, { error: 'حالة غير صالحة' });
      }
      const rows = await sql`
        INSERT INTO app_state (user_key, state, updated_at)
        VALUES (${key}, ${JSON.stringify(st)}::jsonb, now())
        ON CONFLICT (user_key)
        DO UPDATE SET state = EXCLUDED.state, updated_at = now()
        RETURNING updated_at`;
      return json(200, { ok: true, updatedAt: rows[0].updated_at });
    }
    return json(405, { error: 'طريقة غير مدعومة' });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}

/* ---------- /api/rate ---------- */
const FX_TTL = 60 * 60 * 1000;
async function fetchLiveFx() {
  const r = await fetch('https://open.er-api.com/v6/latest/USD');
  const j = await r.json();
  const usdEgp = j && j.rates && Number(j.rates.EGP);
  const usdSar = j && j.rates && Number(j.rates.SAR);
  if (!usdEgp) throw new Error('لا يوجد سعر EGP');
  return { rate: usdSar ? Number((usdEgp / usdSar).toFixed(4)) : null, usdRate: Number(usdEgp.toFixed(4)), source: 'open.er-api.com' };
}
export async function handleRate(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  let sql = null;
  if (url) { try { sql = neon(url); } catch { sql = null; } }
  if (sql) {
    try {
      await sql`CREATE TABLE IF NOT EXISTS fx_cache (pair TEXT PRIMARY KEY, rate NUMERIC, usd_rate NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      const rows = await sql`SELECT rate, usd_rate, fetched_at FROM fx_cache WHERE pair = 'USD_BASE'`;
      if (rows.length && Date.now() - new Date(rows[0].fetched_at).getTime() < FX_TTL) {
        return json(200, { rate: Number(rows[0].rate), usdRate: Number(rows[0].usd_rate), source: 'cache', fetchedAt: rows[0].fetched_at });
      }
    } catch { /* نتجاهل */ }
  }
  try {
    const { rate, usdRate, source } = await fetchLiveFx();
    if (sql) {
      try {
        await sql`INSERT INTO fx_cache (pair, rate, usd_rate, fetched_at) VALUES ('USD_BASE', ${rate}, ${usdRate}, now())
          ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate, usd_rate = EXCLUDED.usd_rate, fetched_at = now()`;
      } catch { /* اختياري */ }
    }
    return json(200, { rate, usdRate, source, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return json(502, { error: 'تعذّر جلب سعر الصرف: ' + (e.message || String(e)) });
  }
}

/* ---------- /api/inspect ---------- */
export async function handleInspect(request, env) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const expected = env.MIGRATE_TOKEN || '';
  if (!expected) return json(403, { error: 'الأداة معطّلة — اضبط MIGRATE_TOKEN لتفعيلها مؤقتاً' });
  if (token !== expected) return json(401, { error: 'رمز غير صحيح' });
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط' });
  try {
    const sql = neon(url);
    const info = await sql`SELECT current_database() AS db, current_user AS usr`;
    const schemas = await sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY schema_name`;
    const tables = await sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY table_schema, table_name`;
    const out = [];
    for (const t of tables) {
      const schema = t.table_schema, name = t.table_name;
      const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${name} ORDER BY ordinal_position`;
      let count = 0, sample = [];
      try {
        const c = await sql.query(`SELECT count(*)::int AS n FROM "${schema}"."${name}"`);
        count = (c[0] && c[0].n) || 0;
        sample = await sql.query(`SELECT * FROM "${schema}"."${name}" LIMIT 5`);
      } catch { /* نتجاهل */ }
      out.push({ schema, table: name, columns: cols.map(c => ({ name: c.column_name, type: c.data_type })), rowCount: count, sample });
    }
    return json(200, { database: info[0].db, user: info[0].usr, schemas: schemas.map(s => s.schema_name), tableCount: out.length, tables: out });
  } catch (e) {
    return json(500, { error: 'خطأ: ' + (e.message || String(e)) });
  }
}
