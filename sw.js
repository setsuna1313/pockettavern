// Service worker: makes the app installable and usable offline.
// Network-first for app files, so updates show up on the next launch.
const CACHE = 'pockettavern-v31-narrative-db';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/card.js', './js/prompt.js', './js/api.js',
  './js/narrative-db.js', './js/macros.js', './js/worldinfo.js', './js/regex.js', './js/preset.js', './js/render.js', './js/stscript.js', './js/enhance.js', './js/memory.js', './js/stimport.js', './js/extras.js', './js/instruct.js', './js/theme.js', './js/vault.js', './js/vendor/purify.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Never touch API calls or other origins.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Always check GitHub for a newer copy (cache: 'no-cache'), so an update shows
  // up the next time the app opens instead of up to 10 minutes later.
  const fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
