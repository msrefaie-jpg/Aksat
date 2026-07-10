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
    return ok ? payload : null;   // نُرجع الحمولة كاملة (تتضمّن sub وemail)
  } catch { return null; }
}

// هوية المستخدم من رمز Firebase (المفضّل) أو رمز حساب قديم
//   → { uid, email, legacy } أو null
export async function authUser(request, env) {
  const authz = request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const p = await verifyToken(m[1].trim(), projectId(env));
    if (!p || !p.sub) return null;
    return { uid: p.sub, email: (p.email || '').toLowerCase() || null, legacy: false };
  }
  const code = (request.headers.get('x-account-code') || '').trim();
  if (code && code.length >= 4) return { uid: code, email: null, legacy: true };
  return null;
}

// مفتاح صف الحالة لمحفظة يملكها المستخدم
export function stateKey(user) { return user.legacy ? user.uid : 'fb:' + user.uid; }

// توافق قديم
export async function resolveUserKey(request, env) {
  const u = await authUser(request, env);
  return u ? stateKey(u) : null;
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
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      uid        TEXT PRIMARY KEY,
      email      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS shares (
      id           TEXT PRIMARY KEY,
      owner_uid    TEXT NOT NULL,
      member_uid   TEXT,
      member_email TEXT NOT NULL,
      role         TEXT NOT NULL,
      status       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (owner_uid, member_email)
    )`;
  schemaReady = true;
}

export function newId() {
  return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}

// يسجّل بريد↔معرّف المستخدم، ويحوّل الدعوات المعلّقة لهذا البريد إلى فعّالة
export async function registerUser(sql, user) {
  if (!user || user.legacy) return;
  if (user.email) {
    await sql`INSERT INTO users (uid, email, updated_at) VALUES (${user.uid}, ${user.email}, now())
      ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`;
    await sql`UPDATE shares SET member_uid = ${user.uid}, status = 'active'
      WHERE member_uid IS NULL AND lower(member_email) = ${user.email}`;
  } else {
    await sql`INSERT INTO users (uid) VALUES (${user.uid}) ON CONFLICT (uid) DO NOTHING`;
  }
}

// يحدّد دور المستخدم على محفظة مالكها ownerUid ('owner' | 'editor' | 'viewer' | null)
export async function roleFor(sql, requesterUid, ownerUid) {
  if (requesterUid === ownerUid) return 'owner';
  const rows = await sql`SELECT role FROM shares WHERE owner_uid = ${ownerUid} AND member_uid = ${requesterUid} AND status = 'active'`;
  return rows.length ? rows[0].role : null;
}
