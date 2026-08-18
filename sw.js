const CACHE = 'trivial-pages-build-2026-08-19.3-seed-2026-08-19.3';
const ASSETS = [
  './','./index.html','./styles.css','./styles-extra.css','./manifest.webmanifest','./icons/trivial.svg',
  './src/app.js','./src/config.js','./src/db.js','./src/domain.js','./src/csv.js','./src/seed.js','./src/backup.js','./src/diagnostics.js','./src/stats.js','./src/import-export.js',
  './data/meta.csv','./data/banks.csv','./data/categories.csv','./data/levels.csv',
  './data/questions-AL.csv','./data/questions-LI.csv','./data/questions-FI.csv','./data/questions-HI.csv','./data/questions-IN.csv','./data/questions-NE.csv',
  './data/players.csv','./data/matches.csv','./data/participants.csv',
  './data/attempts-J1.csv','./data/attempts-J2.csv','./data/attempts-J3.csv','./data/exposures.csv','./data/events.csv'
];
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)))});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))])));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request,{cache:'no-cache'}).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}return response}).catch(async()=>await caches.match(event.request)??await caches.match('./index.html')))});
