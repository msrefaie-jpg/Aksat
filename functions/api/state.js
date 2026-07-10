// Cloudflare Pages Function — مزامنة حالة المستخدم مع Neon
//   GET  /api/state  → إرجاع الحالة
//   PUT  /api/state  → حفظ الحالة
// المصادقة عبر Authorization: Bearer <Firebase ID token> (أو x-account-code قديم)

import { neon, json, dbUrl, resolveUserKey, ensureSchema } from './_lib.js';

export async function onRequestOptions() { return json(200, {}); }

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });
  const key = await resolveUserKey(request, env);
  if (!key) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });
  try {
    const sql = neon(url);
    await ensureSchema(sql);
    const rows = await sql`SELECT state, updated_at FROM app_state WHERE user_key = ${key}`;
    if (!rows.length) return json(200, { state: null, updatedAt: null });
    return json(200, { state: rows[0].state, updatedAt: rows[0].updated_at });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط في إعدادات الاستضافة' });
  const key = await resolveUserKey(request, env);
  if (!key) return json(401, { error: 'الهوية غير صالحة — سجّل الدخول من جديد' });

  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { error: 'صيغة JSON غير صحيحة' }); }
  const st = payload && payload.state;
  if (!st || typeof st !== 'object' || !Array.isArray(st.units)) {
    return json(400, { error: 'حالة غير صالحة' });
  }
  try {
    const sql = neon(url);
    await ensureSchema(sql);
    const rows = await sql`
      INSERT INTO app_state (user_key, state, updated_at)
      VALUES (${key}, ${JSON.stringify(st)}::jsonb, now())
      ON CONFLICT (user_key)
      DO UPDATE SET state = EXCLUDED.state, updated_at = now()
      RETURNING updated_at`;
    return json(200, { ok: true, updatedAt: rows[0].updated_at });
  } catch (e) {
    return json(500, { error: 'خطأ في الخادم: ' + (e.message || String(e)) });
  }
}
