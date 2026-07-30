/* Service Worker لتطبيق «أقساط» — تمكين العمل دون إنترنت (App Shell) */
const CACHE = 'aksat-shell-v2';
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

/* استقبال إشعار Push وعرضه (يعمل والتطبيق مغلق) */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'أقساط';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    tag: d.tag || 'aksat-reminder',
    data: { url: d.url || './' },
  }));
});

/* فتح التطبيق عند الضغط على الإشعار */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

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
