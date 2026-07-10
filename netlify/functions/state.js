// دالة مزامنة الحالة مع قاعدة Neon
//   GET  /api/state   → إرجاع حالة المستخدم كاملة (JSON)
//   PUT  /api/state   → حفظ حالة المستخدم كاملة
//
// المصادقة: ترويسة Authorization: Bearer <Firebase ID token>.
//   يُتحقّق من توقيع الرمز عبر شهادات Google العامة (RS256) والمطالبات،
//   ثم تُربط البيانات بمعرّف المستخدم (uid) بأمان. (توافق قديم: x-account-code)

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const DB_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || '';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'estatemanager-eecaa';
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-account-code',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
function reply(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

/* ---- التحقق من رمز Firebase (RS256 عبر شهادات Google) ---- */
let certCache = { at: 0, certs: null };
async function getCerts() {
  if (certCache.certs && Date.now() - certCache.at < 3600 * 1000) return certCache.certs;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error('cert fetch failed');
  const certs = await res.json();
  certCache = { at: Date.now(), certs };
  return certs;
}
function b64urlBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

async function verifyFirebaseToken(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlBuf(parts[1]).toString('utf8'));
  } catch { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.aud !== PROJECT_ID) return null;
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) return null;
  if (!payload.sub) return null;
  if (header.alg !== 'RS256' || !header.kid) return null;

  let certs;
  try { certs = await getCerts(); } catch { return null; }
  const pem = certs[header.kid];
  if (!pem) return null;

  try {
    const pub = crypto.createPublicKey(pem);
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const sig = b64urlBuf(parts[2]);
    const ok = crypto.verify('RSA-SHA256', data, pub, sig);
    return ok ? payload.sub : null;
  } catch { return null; }
}

async function resolveUserKey(event) {
  const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const uid = await verifyFirebaseToken(m[1].trim());
    return uid ? 'fb:' + uid : null;
  }
  const code = (event.headers['x-account-code'] || event.headers['X-Account-Code'] || '').trim();
  if (code && code.length >= 4) return code;
  return null;
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
      const st = payload.state;
      if (!st || typeof st !== 'object' || !Array.isArray(st.units)) {
        return reply(400, { error: 'حالة غير صالحة' });
      }
      const rows = await sql`
        INSERT INTO app_state (user_key, state, updated_at)
        VALUES (${userKey}, ${JSON.stringify(st)}::jsonb, now())
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
