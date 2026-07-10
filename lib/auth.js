// مكتبة مشتركة لدوال Cloudflare Pages (الملفات التي تبدأ بـ _ ليست مسارات)
// تتضمّن: اتصال Neon، ردود JSON+CORS، والتحقق من رمز Firebase عبر Web Crypto.

import { neon } from '@neondatabase/serverless';
export { neon };

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-account-code',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: CORS });

export function dbUrl(env) {
  return env.DATABASE_URL || env.NETLIFY_DATABASE_URL || env.NETLIFY_DATABASE_URL_UNPOOLED || '';
}
export function projectId(env) {
  return env.FIREBASE_PROJECT_ID || 'estatemanager-eecaa';
}

/* ---------- التحقق من رمز Firebase (RS256 عبر Web Crypto) ---------- */
const JWK_URL = 'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';
let jwkCache = { at: 0, keys: null };

async function getKeys() {
  if (jwkCache.keys && Date.now() - jwkCache.at < 3600 * 1000) return jwkCache.keys;
  const r = await fetch(JWK_URL);
  if (!r.ok) throw new Error('jwk fetch failed');
  const j = await r.json();
  const map = {};
  (j.keys || []).forEach(k => { map[k.kid] = k; });
  jwkCache = { at: Date.now(), keys: map };
  return map;
}

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

export async function verifyToken(idToken, pid) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.aud !== pid) return null;
  if (payload.iss !== 'https://securetoken.google.com/' + pid) return null;
  if (!payload.sub) return null;
  if (header.alg !== 'RS256' || !header.kid) return null;

  let keys;
  try { keys = await getKeys(); } catch { return null; }
  const jwk = keys[header.kid];
  if (!jwk) return null;

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    return ok ? payload.sub : null;
  } catch { return null; }
}

// يحدّد مفتاح المستخدم من رمز Firebase (المفضّل) أو من رمز حساب قديم
export async function resolveUserKey(request, env) {
  const authz = request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const uid = await verifyToken(m[1].trim(), projectId(env));
    return uid ? 'fb:' + uid : null;
  }
  const code = (request.headers.get('x-account-code') || '').trim();
  if (code && code.length >= 4) return code;
  return null;
}

let schemaReady = false;
export async function ensureSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      user_key    TEXT PRIMARY KEY,
      state       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  schemaReady = true;
}
