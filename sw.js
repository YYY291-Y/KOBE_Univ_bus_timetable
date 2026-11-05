const CACHE_NAME = 'kobe-bus-shell-v10';
const APP_SHELL = './';

self.addEventListener('install', event => {
  // 新しい版を待機させず、直ちに有効化する。
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('kobe-bus-shell-') && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // HTMLはネットワーク優先。公開版が更新されていれば最新HTMLを取得。
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) {
          await cache.put(request, response.clone());
          return response;
        }
        throw new Error('Network response was not ok');
      } catch (error) {
        return (await cache.match(request)) ||
               (await cache.match(APP_SHELL)) ||
               new Response('オフラインです。通信が回復したら再読み込みしてください。', {
                 status: 503,
                 headers: { 'Content-Type': 'text/plain; charset=utf-8' }
               });
      }
    })());
    return;
  }

  // 同一オリジンのその他のファイルはキャッシュ優先、未キャッシュなら取得。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      return new Response('', { status: 503 });
    }
  })());
});
