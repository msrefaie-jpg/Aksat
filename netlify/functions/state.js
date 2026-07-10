// دالة مزامنة الحالة مع قاعدة Neon
//   GET  /api/state   → إرجاع حالة المستخدم كاملة (JSON)
//   PUT  /api/state   → حفظ حالة المستخدم كاملة
//
// المصادقة (بالأفضلية):
//   1) ترويسة Authorization: Bearer <Firebase ID token> — تُتحقّق عبر Google،
//      وتُربط البيانات بمعرّف المستخدم (uid) بأمان.
//   2) (توافق قديم) ترويسة x-account-code — مفتاح نصّي بسيط.

const { neon } = require('@neondatabase/serverless');

const DB_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || '';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyC6WTj5rqg4qpbsxHcY1eO9yphOS282W0E';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-account-code',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
function reply(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

let schemaReady = false;
async function ensureSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      user_key    TEXT PRIMARY KEY,
      state       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  schemaReady = true;
}

// يحدّد مفتاح المستخدم من رمز Firebase (بعد التحقق) أو من رمز الحساب القديم
async function resolveUserKey(event) {
  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: m[1] }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const uid = j.users && j.users[0] && j.users[0].localId;
      return uid ? 'fb:' + uid : null;
    } catch { return null; }
  }
  const code = (event.headers['x-account-code'] || event.headers['X-Account-Code'] || '').trim();
  if (code && code.length >= 4) return code;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (!DB_URL) return reply(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });

  const userKey = await resolveUserKey(event);
  if (!userKey) return reply(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });

  try {
    const sql = neon(DB_URL);
    await ensureSchema(sql);

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT state, updated_at FROM app_state WHERE user_key = ${userKey}`;
      if (!rows.length) return reply(200, { state: null, updatedAt: null });
      return reply(200, { state: rows[0].state, updatedAt: rows[0].updated_at });
    }

    if (event.httpMethod === 'PUT') {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); }
      catch { return reply(400, { error: 'صيغة JSON غير صحيحة' }); }
      const state = payload.state;
      if (!state || typeof state !== 'object' || !Array.isArray(state.units)) {
        return reply(400, { error: 'حالة غير صالحة' });
      }
      const rows = await sql`
        INSERT INTO app_state (user_key, state, updated_at)
        VALUES (${userKey}, ${JSON.stringify(state)}::jsonb, now())
        ON CONFLICT (user_key)
        DO UPDATE SET state = EXCLUDED.state, updated_at = now()
        RETURNING updated_at`;
      return reply(200, { ok: true, updatedAt: rows[0].updated_at });
    }

    return reply(405, { error: 'طريقة غير مدعومة' });
  } catch (err) {
    return reply(500, { error: 'خطأ في الخادم: ' + (err.message || String(err)) });
  }
};
