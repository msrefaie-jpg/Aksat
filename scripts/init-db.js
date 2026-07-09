// تهيئة قاعدة بيانات Neon يدوياً (اختياري — الدوال تُنشئ الجداول تلقائياً).
// الاستخدام: DATABASE_URL="postgres://..." node scripts/init-db.js
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('اضبط متغيّر البيئة DATABASE_URL أولاً.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  // تنفيذ كل جملة على حدة
  const statements = schema.split(/;\s*\n/).map(s => s.trim()).filter(s => s && !s.startsWith('--'));
  for (const stmt of statements) {
    await sql.query(stmt);
    console.log('✓', stmt.split('\n')[0].slice(0, 60));
  }
  console.log('تمت التهيئة بنجاح.');
})().catch(e => { console.error('فشل:', e.message); process.exit(1); });
