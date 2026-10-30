const CACHE = 'double-y-static-orange-v3';
const FILES = [
  '/offline.html',
  '/brand/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];
self.addEventListener('install', (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/'))
    return;
  if (e.request.mode === 'navigate')
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
  else if (FILES.includes(u.pathname))
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
});
