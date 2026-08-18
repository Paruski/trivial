const CACHE = 'trivial-pages-v3';
const ASSETS = [
  './','./index.html','./styles.css','./styles-extra.css','./manifest.webmanifest',
  './data/meta.json','./data/questions-AL.json','./data/questions-LI.json','./data/questions-FI.json','./data/questions-HI.json','./data/questions-IN.json','./data/questions-NE.json',
  './data/attempts-J1.json','./data/attempts-J2.json','./data/attempts-J3.json',
  './src/app.js','./src/db.js','./src/domain.js','./src/import-export.js','./src/stats.js'
];
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  ]));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
