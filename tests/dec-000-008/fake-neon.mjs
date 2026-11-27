// بديل اختبار لـ neon: يوجّه الاستعلامات إلى PGlite في الذاكرة
import { PGlite } from '@electric-sql/pglite';
export const db = new PGlite();
export function neon() {
  const f = async (strings, ...vals) => {
    let text = strings[0];
    for (let k = 0; k < vals.length; k++) text += '$' + (k + 1) + strings[k + 1];
    const r = await db.query(text, vals);
    return r.rows;
  };
  f.query = async (text, vals) => (await db.query(text, vals || [])).rows;
  return f;
}
