const CACHE = 'trivial-pages-v5-csv';
const ASSETS = [
  './','./index.html','./styles.css','./styles-extra.css','./manifest.webmanifest',
  './src/app.js','./src/db.js','./src/domain.js','./src/csv.js','./src/import-export.js',
  './data/meta.csv','./data/banks.csv','./data/categories.csv','./data/levels.csv',
  './data/questions-AL.csv','./data/questions-LI.csv','./data/questions-FI.csv','./data/questions-HI.csv','./data/questions-IN.csv','./data/questions-NE.csv',
  './data/players.csv','./data/matches.csv','./data/participants.csv',
  './data/attempts-J1.csv','./data/attempts-J2.csv','./data/attempts-J3.csv','./data/exposures.csv','./data/events.csv'
];
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)))});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))])));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response}).catch(()=>caches.match(event.request)))});
