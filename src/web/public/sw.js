// TaskFlow OS Service Worker (PWA Offline Shell & Fast Load)
const CACHE_NAME = 'taskflow-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/login',
  '/style.css',
  '/app.js',
  '/login.css',
  '/login.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Jangan sentuh atau cegat API, Auth, SSE
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/auth') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Network First, fallback ke cache jika offline
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
