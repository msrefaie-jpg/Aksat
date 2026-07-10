// أداة فحص قاعدة البيانات (للقراءة فقط) — لتسهيل نقل البيانات من التطبيق القديم.
//   GET /api/inspect?token=XXXX
// تُرجع قائمة الجداول وأعمدتها وعدد صفوفها وعيّنة من الصفوف، لفهم مخطط قاعدتك
// الحالية وكتابة عملية النقل بدقّة. لا تُعدّل أي شيء.
//
// الحماية: تعمل فقط إذا ضُبط متغيّر البيئة MIGRATE_TOKEN وطابق قيمة ?token=.
// بعد الانتهاء من النقل، احذف المتغيّر MIGRATE_TOKEN لتعطيل الأداة.

const { neon } = require('@neondatabase/serverless');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};
function reply(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body, null, 2) };
}

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).token || '';
  const expected = process.env.MIGRATE_TOKEN || '';
  if (!expected) return reply(403, { error: 'الأداة معطّلة — اضبط MIGRATE_TOKEN لتفعيلها مؤقتاً' });
  if (token !== expected) return reply(401, { error: 'رمز غير صحيح' });
  if (!process.env.DATABASE_URL) return reply(500, { error: 'DATABASE_URL غير مضبوط' });

  try {
    const sql = neon(process.env.DATABASE_URL);

    // معلومات عامة عن القاعدة الحالية
    const info = await sql`SELECT current_database() AS db, current_schema() AS schema, current_user AS usr`;
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
      ORDER BY schema_name`;

    // جداول في كل المخططات غير النظامية
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
        const s = await sql.query(`SELECT * FROM "${schema}"."${name}" LIMIT 5`);
        sample = s;
      } catch (e) { /* نتجاهل جداول يصعب قراءتها */ }
      out.push({
        schema,
        table: name,
        columns: cols.map(c => ({ name: c.column_name, type: c.data_type })),
        rowCount: count,
        sample,
      });
    }
    return reply(200, {
      database: info[0].db,
      user: info[0].usr,
      schemas: schemas.map(s => s.schema_name),
      tableCount: out.length,
      tables: out,
    });
  } catch (err) {
    return reply(500, { error: 'خطأ: ' + (err.message || String(err)) });
  }
};
