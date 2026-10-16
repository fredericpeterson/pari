const CACHE='paris-tracker-v2';
const FILES=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  // Les appels à l'API de scores (autre domaine) ne passent jamais par le cache.
  if(new URL(e.request.url).origin!==self.location.origin)return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const copy=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});
      return r;
    }).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html')))
  );
});
