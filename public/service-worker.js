// service-worker.js
const CACHE_NAME = 'kintai-pro-cache-v4';

// 更新即時適用
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

const scopeUrl = new URL(self.registration.scope);
const urlFromScope = (p) => new URL(p, scopeUrl).toString();

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
].map(urlFromScope);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = PRECACHE_URLS.map(u => new Request(u, { cache: 'reload' }));
    await cache.addAll(requests);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k.startsWith('kintai-pro-cache'))
          .map(k => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // config系は常にネットワーク
  if (url.pathname.endsWith('/config.php') || url.pathname.endsWith('/config.json')) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // HTMLナビゲーション
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        return await fetch(req);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(urlFromScope('./index.html'))) || Response.error();
      }
    })());
    return;
  }

  // 静的資産
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    const res = await fetch(req);
    if (url.origin === self.location.origin) {
      cache.put(req, res.clone());
    }
    return res;
  })());
});
