// Vided service worker: works offline, and refreshes files in the background.
// If something looks stale after an update, bump the version below (v7 -> v8).
const CACHE = 'vided-v13';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'mux.js', 'demux.js', 'export.js', 'imgedit.js', 'audio.js', 'captions.js', 'voice.js', 'quick.js', 'cutout.js', 'whisper-worker.js', 'store.js', 'config.js', 'native.js', 'fx.js', 'pro.js', 'pro2.js', 'pro3.js', 'pro4.js', 'pro5.js', 'layout.js', 'gif.js', 'account.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Stale-while-revalidate: answer from cache instantly, refresh the cache in the background.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    )
  );
});
