// Fenix Service Worker — PWA kurulum ve offline cache
const CACHE = 'fenix-v1';
const PRECACHE = [
  '/satici',
  '/manifest.json',
  '/fenix-icon-192.png',
  '/fenix-icon-512.png'
];

// Kurulumda temel dosyaları cache'le
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

// Aktifleşince eski cache'leri temizle
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first, offline'da cache
self.addEventListener('fetch', e => {
  // API çağrılarını cache'leme
  if (e.request.url.includes('/api/')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Başarılıysa cache'e de yaz
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
