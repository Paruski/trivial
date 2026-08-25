const CACHE='trivial-pages-static-2026-08-25.1';
const RELATIVE_ASSETS=[
  './','./index.html','./styles.css','./manifest.webmanifest','./icons/trivial.svg',
  './src/app.js','./src/pages-db.js','./src/pages-engine.js','./src/seed.js','./src/csv.js','./src/config.js',
  './data/meta.csv','./data/banks.csv','./data/categories.csv','./data/levels.csv','./data/players.csv','./data/matches.csv','./data/participants.csv','./data/attempts-J1.csv','./data/attempts-J2.csv','./data/attempts-J3.csv','./data/exposures.csv','./data/events.csv',
  './data/questions-AL.csv','./data/questions-LI.csv','./data/questions-FI.csv','./data/questions-HI.csv','./data/questions-IN.csv','./data/questions-NE.csv'
];
const ASSETS=RELATIVE_ASSETS.map(path=>new URL(path,self.location).href);
const INDEX=new URL('./index.html',self.location).href;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))])));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  event.respondWith(fetch(event.request,{cache:'no-cache'}).then(response=>{
    if(response.ok) caches.open(CACHE).then(cache=>cache.put(event.request,response.clone()));
    return response;
  }).catch(async()=>await caches.match(event.request)||await caches.match(INDEX)));
});
