const CACHE = 'trivial-pages-v1';
const ASSETS = ['./','./index.html','./styles.css','./manifest.webmanifest','./src/app.js','./src/db.js','./src/domain.js','./src/import-export.js','./src/stats.js'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
