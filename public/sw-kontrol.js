// Fenix Kontrol — Service Worker
// Kontrol panelini offline yapma — sadece PWA install için gerekli
const CACHE = 'fenix-kontrol-v1';

self.addEventListener('install', function(e) {
  // Sadece manifest ve ikonları önbelleğe al
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll([
        '/manifest-kontrol.json',
        '/fenix-icon-192.png',
        '/fenix-icon-512.png'
      ]).catch(function() { return; }); // hata varsa geç
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  // Kontrol paneli için her zaman network — admin içerik sürekli değişiyor
  // Sadece statik ikonları cache'le
  var url = e.request.url;
  if (url.includes('fenix-icon') || url.includes('manifest-kontrol')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request);
      })
    );
    return;
  }
  // Diğer her şey: network first
  e.respondWith(fetch(e.request).catch(function() {
    return new Response('Çevrimdışısın', { status: 503 });
  }));
});
