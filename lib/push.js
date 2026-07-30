// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) بتنفيذ Web Crypto فقط — بلا مكتبات.
// يعمل داخل Cloudflare Worker وأيضاً في Node 22 (نفس واجهة crypto.subtle).

/* ---------- ترميز base64url ---------- */
export function b64uEncode(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  str += '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);

/* ---------- توليد مفاتيح VAPID (ECDSA P-256) ---------- */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);       // 65 bytes (uncompressed)
  const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);      // { crv, d, x, y, kty }
  return { publicKey: b64uEncode(rawPub), privateJwk: jwkPriv };
}

/* ---------- توقيع JWT الخاص بـ VAPID ---------- */
export async function vapidJwt(endpoint, privateJwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(utf8(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || 'mailto:notify@aksat.app',
  })));
  const signingInput = header + '.' + payload;
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput)); // raw r||s (64B)
  return signingInput + '.' + b64uEncode(sig);
}

/* ---------- HKDF عبر Web Crypto ---------- */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* ---------- تشفير الحمولة (aes128gcm) ---------- */
export async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const uaPublic = b64uDecode(p256dhB64u);   // 65 bytes
  const authSecret = b64uDecode(authB64u);    // 16 bytes
  const plaintext = utf8(plaintextStr);

  // زوج ECDH مؤقّت للخادم
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as)
  const keyInfo = concatBytes(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concatBytes(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concatBytes(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const record = concatBytes(plaintext, new Uint8Array([2])); // سجل واحد أخير → فاصل 0x02
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // ترويسة aes128gcm: salt(16) || rs(4, big-endian) || idlen(1)=65 || as_public(65)
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  const header = concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concatBytes(header, ct);
}

/* ---------- إرسال إشعار واحد ---------- */
export async function sendPush(sub, payloadObj, vapid) {
  const body = await encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(sub.endpoint, vapid.privateJwk);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'normal',
    },
    body,
  });
  return res.status; // 201 نجاح · 404/410 اشتراك منتهٍ
}
