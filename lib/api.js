// معالجات مسارات /api لتطبيق أقساط (Cloudflare Worker)
import { neon, json, dbUrl, ensureSchema, authUser, registerUser, roleFor, newId } from './auth.js';

/* ---------- /api/state (مع دعم المحافظ المشتركة) ---------- */
export async function handleState(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });
  const user = await authUser(request, env);
  if (!user) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });

  const sql = neon(url);
  try {
    await ensureSchema(sql);
    const ownerUid = new URL(request.url).searchParams.get('portfolio') || user.uid;
    const role = user.legacy
      ? (ownerUid === user.uid ? 'owner' : null)
      : await roleFor(sql, user.uid, ownerUid);
    if (!role) return json(403, { error: 'لا تملك صلاحية على هذه المحفظة' });
    const key = user.legacy ? user.uid : 'fb:' + ownerUid;

    if (request.method === 'GET') {
      const rows = await sql`SELECT state, updated_at FROM app_state WHERE user_key = ${key}`;
      if (!rows.length) return json(200, { state: null, updatedAt: null, role });
      return json(200, { state: rows[0].state, updatedAt: rows[0].updated_at, role });
    }
    if (request.method === 'PUT') {
      if (role === 'viewer') return json(403, { error: 'صلاحيتك للعرض فقط' });
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
      return json(200, { ok: true, updatedAt: rows[0].updated_at, role });
    }
    return json(405, { error: 'طريقة غير مدعومة' });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}

/* ---------- /api/portfolios ---------- */
export async function handlePortfolios(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط' });
  const user = await authUser(request, env);
  if (!user || user.legacy) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });
  const sql = neon(url);
  try {
    await ensureSchema(sql);
    await registerUser(sql, user);
    const own = { key: user.uid, role: 'owner', ownerEmail: user.email, self: true };
    const shared = await sql`
      SELECT s.owner_uid, s.role, u.email AS owner_email
      FROM shares s JOIN users u ON u.uid = s.owner_uid
      WHERE s.member_uid = ${user.uid} AND s.status = 'active'
      ORDER BY s.created_at`;
    const list = [own, ...shared.map(r => ({ key: r.owner_uid, role: r.role, ownerEmail: r.owner_email, self: false }))];
    return json(200, { portfolios: list, me: { uid: user.uid, email: user.email } });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}

/* ---------- /api/shares ---------- */
export async function handleShares(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط' });
  const user = await authUser(request, env);
  if (!user || user.legacy) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });
  const sql = neon(url);
  try {
    await ensureSchema(sql);
    await registerUser(sql, user);
    const q = new URL(request.url).searchParams;

    if (request.method === 'GET') {
      const rows = await sql`SELECT id, member_email, role, status FROM shares WHERE owner_uid = ${user.uid} ORDER BY created_at`;
      return json(200, { members: rows });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'صيغة JSON غير صحيحة' }); }
      const email = (body.email || '').trim().toLowerCase();
      const role = body.role === 'editor' ? 'editor' : 'viewer';
      if (!email || !/.+@.+\..+/.test(email)) return json(400, { error: 'بريد إلكتروني غير صحيح' });
      if (email === user.email) return json(400, { error: 'لا يمكنك مشاركة محفظتك مع نفسك' });
      const found = await sql`SELECT uid FROM users WHERE lower(email) = ${email} LIMIT 1`;
      const memberUid = found.length ? found[0].uid : null;
      const status = memberUid ? 'active' : 'pending';
      await sql`
        INSERT INTO shares (id, owner_uid, member_uid, member_email, role, status)
        VALUES (${newId()}, ${user.uid}, ${memberUid}, ${email}, ${role}, ${status})
        ON CONFLICT (owner_uid, member_email)
        DO UPDATE SET role = EXCLUDED.role, member_uid = EXCLUDED.member_uid, status = EXCLUDED.status`;
      return json(200, { ok: true, status });
    }
    if (request.method === 'DELETE') {
      const member = (q.get('member') || '').trim().toLowerCase();
      const leave = q.get('leave');
      if (leave) {
        await sql`DELETE FROM shares WHERE owner_uid = ${leave} AND member_uid = ${user.uid}`;
        return json(200, { ok: true });
      }
      if (member) {
        await sql`DELETE FROM shares WHERE owner_uid = ${user.uid} AND lower(member_email) = ${member}`;
        return json(200, { ok: true });
      }
      return json(400, { error: 'حدّد العضو المراد إزالته' });
    }
    return json(405, { error: 'طريقة غير مدعومة' });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}

/* ---------- /api/report (رابط تقرير للقراءة فقط) ---------- */
export async function handleReport(request, env) {
  if (request.method === 'OPTIONS') return json(200, {});
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط' });
  const sql = neon(url);
  const q = new URL(request.url).searchParams;

  // GET عام: جلب لقطة التقرير عبر المعرّف (بدون مصادقة)
  if (request.method === 'GET') {
    const id = (q.get('id') || '').trim();
    if (!id) return json(400, { error: 'معرّف مفقود' });
    try {
      await ensureSchema(sql);
      const rows = await sql`SELECT data, created_at, expires_at FROM reports WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'التقرير غير موجود أو أُلغي' });
      const r = rows[0];
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
        return json(410, { error: 'انتهت صلاحية هذا الرابط' });
      }
      return json(200, { data: r.data, createdAt: r.created_at });
    } catch (e) {
      return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
    }
  }

  // بقية العمليات تتطلّب مصادقة المالك
  const user = await authUser(request, env);
  if (!user) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });
  try {
    await ensureSchema(sql);

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'صيغة JSON غير صحيحة' }); }
      const data = body && body.data;
      if (!data || typeof data !== 'object') return json(400, { error: 'بيانات التقرير غير صالحة' });
      const id = newId();
      const days = 90;
      const expires = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
      await sql`INSERT INTO reports (id, owner_uid, data, expires_at)
        VALUES (${id}, ${user.uid}, ${JSON.stringify(data)}::jsonb, ${expires})`;
      return json(200, { id, expiresAt: expires });
    }

    if (request.method === 'DELETE') {
      const id = (q.get('id') || '').trim();
      if (!id) return json(400, { error: 'معرّف مفقود' });
      await sql`DELETE FROM reports WHERE id = ${id} AND owner_uid = ${user.uid}`;
      return json(200, { ok: true });
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
