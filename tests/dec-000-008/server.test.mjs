import { db } from '@neondatabase/serverless';
const PID = 'test-proj';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey); jwk.kid = 'k1';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).includes('securetoken') ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(u, o);
const b64u = (b) => Buffer.from(b).toString('base64url');
async function token(sub, email, verified) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const now = Math.floor(Date.now()/1000);
  const p = b64u(JSON.stringify({ sub, email, email_verified: verified, aud: PID, iss: 'https://securetoken.google.com/' + PID, exp: now + 3600, iat: now }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
  return h + '.' + p + '.' + b64u(sig);
}
const worker = (await import('./app/worker.js')).default;
const env = { DATABASE_URL: 'fake://', FIREBASE_PROJECT_ID: PID, ASSETS: { fetch: async () => new Response('ASSET', { status: 200 }) } };
const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request('https://x.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil(){} });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const A = await token('uidA', 'a@x.test', true);
const auth = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const unitsN = (n) => ({ units: Array.from({ length: n }, (_, k) => ({ id: 'u' + k, name: 'U' + k, installments: [] })) });

// DEC-000
let r = await call('/api/state', { method: 'PUT', headers: auth(A), body: { state: unitsN(2) } });
ok(r.status === 200, 'PUT بحساب Firebase يعمل');
r = await call('/api/state', { headers: { 'x-account-code': 'fb:uidA' } });
ok(r.status === 401, 'DEC-000: GET بترويسة x-account-code وحدها → 401 (كان: ' + r.status + ')');
r = await call('/api/state', { method: 'PUT', headers: { 'x-account-code': 'fb:uidA', 'Content-Type': 'application/json' }, body: { state: { units: [] } } });
ok(r.status === 401, 'DEC-000: PUT بترويسة x-account-code → 401');
r = await call('/api/state', { method: 'OPTIONS' });
ok(!(r.headers.get('access-control-allow-headers') || '').includes('x-account-code'), 'DEC-000: الترويسة أُزيلت من CORS');
r = await call('/api/state', { headers: auth(A) }); let j = await r.json();
ok(r.status === 200 && j.state.units.length === 2, 'GET بحساب Firebase يعيد البيانات');

// DEC-002
r = await call('/api/state', { method: 'PUT', headers: auth(A), body: { state: { units: [] } } }); j = await r.json();
ok(r.status === 409 && j.code === 'EMPTY_OVERWRITE', 'DEC-002: تفريغ محفظة فيها وحدات → 409');
r = await call('/api/state', { headers: auth(A) }); j = await r.json();
ok(j.state.units.length === 2, 'DEC-002: البيانات لم تُمسح بعد الرفض');
r = await call('/api/state', { method: 'PUT', headers: auth(A), body: { state: { units: [] }, allowEmpty: true } });
ok(r.status === 200, 'DEC-002: التفريغ بتأكيد صريح allowEmpty يُقبل');

// DEC-003
const B = await token('uidB', 'b@x.test', true);
for (let k = 1; k <= 3; k++) await call('/api/state', { method: 'PUT', headers: auth(B), body: { state: unitsN(k) } });
let h = (await db.query(`SELECT state FROM app_state_history WHERE user_key='fb:uidB' ORDER BY id`)).rows;
ok(h.length === 2 && h[0].state.units.length === 1 && h[1].state.units.length === 2, 'DEC-003: بعد 3 كتابات يوجد نسختان سابقتان صحيحتان');
// استعادة تجريبية: إرجاع النسخة الأولى
await db.query(`UPDATE app_state SET state = (SELECT state FROM app_state_history WHERE user_key='fb:uidB' ORDER BY id LIMIT 1), updated_at = now() WHERE user_key='fb:uidB'`);
r = await call('/api/state', { headers: auth(B) }); j = await r.json();
ok(j.state.units.length === 1, 'DEC-003: الاستعادة من السجل تعمل (عدنا لوحدة واحدة)');
for (let k = 0; k < 55; k++) await call('/api/state', { method: 'PUT', headers: auth(B), body: { state: unitsN(1) } });
h = (await db.query(`SELECT count(*)::int n FROM app_state_history WHERE user_key='fb:uidB'`)).rows;
ok(h[0].n === 50, 'DEC-003: الاحتفاظ بآخر 50 نسخة فقط (' + h[0].n + ')');

// DEC-007 ب: دعوة لبريد ثم تسجيل غير مُتحقق
r = await call('/api/shares', { method: 'POST', headers: auth(A), body: { email: 'victim@x.test', role: 'editor' } }); j = await r.json();
ok(j.status === 'pending', 'دعوة لبريد غير مسجّل → معلّقة');
const Evil = await token('uidEvil', 'victim@x.test', false);
await call('/api/portfolios', { headers: auth(Evil) });
r = await call('/api/state?portfolio=uidA', { headers: auth(Evil) });
ok(r.status === 403, 'DEC-007ب: حساب ببريد غير مُتحقق لا يستلم الدعوة (' + r.status + ')');
r = await call('/api/shares', { method: 'POST', headers: auth(A), body: { email: 'victim@x.test', role: 'editor' } }); j = await r.json();
ok(j.status === 'pending', 'DEC-007ب: مشاركة مع بريد غير مُتحقق تبقى معلّقة');
const Real = await token('uidReal', 'victim@x.test', true);
await call('/api/portfolios', { headers: auth(Real) });
r = await call('/api/state?portfolio=uidA', { headers: auth(Real) });
ok(r.status === 200, 'DEC-007ب: صاحب البريد المُتحقق يستلم الدعوة');

// DEC-007 أ
r = await call('/api/inspect?token=anything');
ok((await r.text()) === 'ASSET', 'DEC-007أ: /api/inspect لم يعد مساراً للخادم');

console.log(`\n${pass} نجح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
