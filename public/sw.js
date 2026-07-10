/* Service Worker لتطبيق «أقساط» — تمكين العمل دون إنترنت (App Shell) */
const CACHE = 'aksat-shell-v1';
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).catch(() => {})) // لا تفشل التثبيت إن غاب أصل
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cachePut(req, res) {
  caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // مسارات الـ API دائماً من الشبكة — لا تُخزَّن أبداً
  if (url.pathname.startsWith('/api/')) return;

  // طلبات التنقّل: الشبكة أولاً مع الرجوع للصفحة المخزّنة عند انقطاع الإنترنت
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { cachePut(req, r.clone()); return r; })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // بقية أصول GET (سكربتات، أنماط، خطوط، أيقونات): stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((r) => { if (r && (r.ok || r.type === 'opaque')) cachePut(req, r.clone()); return r; })
        .catch(() => cached);
      return cached || net;
    })
  );
});
