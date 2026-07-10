// Cloudflare Pages Function — سعر الصرف (احتياطي للواجهة)
//   GET /api/rate → { rate: جنيه/ريال, usdRate: جنيه/دولار, source, fetchedAt }

import { neon, json, dbUrl } from './_lib.js';

const TTL_MS = 60 * 60 * 1000;

async function fetchLive() {
  const r = await fetch('https://open.er-api.com/v6/latest/USD');
  const j = await r.json();
  const usdEgp = j && j.rates && Number(j.rates.EGP);
  const usdSar = j && j.rates && Number(j.rates.SAR);
  if (!usdEgp) throw new Error('لا يوجد سعر EGP');
  const rate = usdSar ? Number((usdEgp / usdSar).toFixed(4)) : null; // جنيه لكل ريال
  return { rate, usdRate: Number(usdEgp.toFixed(4)), source: 'open.er-api.com' };
}

export async function onRequestOptions() { return json(200, {}); }

export async function onRequestGet(context) {
  const { env } = context;
  const url = dbUrl(env);
  let sql = null;
  if (url) { try { sql = neon(url); } catch { sql = null; } }

  if (sql) {
    try {
      await sql`CREATE TABLE IF NOT EXISTS fx_cache (pair TEXT PRIMARY KEY, rate NUMERIC, usd_rate NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      const rows = await sql`SELECT rate, usd_rate, fetched_at FROM fx_cache WHERE pair = 'USD_BASE'`;
      if (rows.length) {
        const age = Date.now() - new Date(rows[0].fetched_at).getTime();
        if (age < TTL_MS) {
          return json(200, { rate: Number(rows[0].rate), usdRate: Number(rows[0].usd_rate), source: 'cache', fetchedAt: rows[0].fetched_at });
        }
      }
    } catch { /* نتجاهل ونجلب مباشرة */ }
  }

  try {
    const { rate, usdRate, source } = await fetchLive();
    if (sql) {
      try {
        await sql`
          INSERT INTO fx_cache (pair, rate, usd_rate, fetched_at) VALUES ('USD_BASE', ${rate}, ${usdRate}, now())
          ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate, usd_rate = EXCLUDED.usd_rate, fetched_at = now()`;
      } catch { /* التخزين المؤقت اختياري */ }
    }
    return json(200, { rate, usdRate, source, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return json(502, { error: 'تعذّر جلب سعر الصرف: ' + (e.message || String(e)) });
  }
}
