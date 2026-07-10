// Cloudflare Pages Function — أداة فحص قاعدة البيانات (قراءة فقط)
//   GET /api/inspect?token=XXXX
// تعمل فقط إذا ضُبط MIGRATE_TOKEN وطابق ?token=. احذف المتغيّر بعد الانتهاء.

import { neon, json, dbUrl } from './_lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get('token') || '';
  const expected = env.MIGRATE_TOKEN || '';
  if (!expected) return json(403, { error: 'الأداة معطّلة — اضبط MIGRATE_TOKEN لتفعيلها مؤقتاً' });
  if (token !== expected) return json(401, { error: 'رمز غير صحيح' });
  const url = dbUrl(env);
  if (!url) return json(500, { error: 'رابط قاعدة البيانات غير مضبوط' });

  try {
    const sql = neon(url);
    const info = await sql`SELECT current_database() AS db, current_user AS usr`;
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
      ORDER BY schema_name`;
    const tables = await sql`
      SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
      ORDER BY table_schema, table_name`;

    const out = [];
    for (const t of tables) {
      const schema = t.table_schema, name = t.table_name;
      const cols = await sql`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = ${name}
        ORDER BY ordinal_position`;
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
