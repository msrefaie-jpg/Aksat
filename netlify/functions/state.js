// دالة مزامنة الحالة مع قاعدة Neon
//   GET  /api/state   → إرجاع حالة الحساب كاملة (JSON)
//   PUT  /api/state   → حفظ حالة الحساب كاملة
//
// المصادقة: ترويسة x-account-code تحدد «رمز الحساب» (user_key).
//   بيانات كل رمز معزولة عن غيرها؛ لا يمكن قراءتها دون معرفة الرمز.
//   يُنصح باستخدام رمز طويل عشوائي (يولّده التطبيق تلقائياً).

const { neon } = require('@neondatabase/serverless');

// يقبل رابط القاعدة من DATABASE_URL أو من متغيّر تكامل Netlify‑Neon
const DB_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-account-code',
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});

  if (!DB_URL) {
    return reply(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });
  }

  const code = (event.headers['x-account-code'] || event.headers['X-Account-Code'] || '').trim();
  if (!code || code.length < 4) {
    return reply(401, { error: 'رمز الحساب مفقود أو قصير جداً' });
  }

  try {
    const sql = neon(DB_URL);
    await ensureSchema(sql);

    if (event.httpMethod === 'GET') {
      const rows = await sql`SELECT state, updated_at FROM app_state WHERE user_key = ${code}`;
      if (!rows.length) {
        return reply(200, { state: null, updatedAt: null });
      }
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
        VALUES (${code}, ${JSON.stringify(state)}::jsonb, now())
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
