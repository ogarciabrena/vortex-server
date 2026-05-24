/**
 * VORTEX Service Worker
 * Caché de assets estáticos para carga rápida en red local lenta
 */
const CACHE = 'vortex-v1';
const ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Solo cachear assets estáticos, no WebSocket ni API
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/admin')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
