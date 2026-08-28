// Deliberately not an offline app shell. Only this public, self-contained
// fallback is cached. Never cache pages, API responses, accounts or messages.
const CACHE_PREFIX = 'thesocialextra-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/offline.html';
const NAVIGATION_PATHS = new Set(['/', '/index.html', '/privacy.html', OFFLINE_URL]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const request = new Request(new URL(OFFLINE_URL, self.location.origin), {
      cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    const response = await fetch(request);
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
      throw new Error('Static offline page unavailable');
    }
    const cache = await caches.open(CACHE_NAME);
    await cache.put(OFFLINE_URL, response);
  })());
  // No skipWaiting: an update must not interrupt an existing conversation.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  // An API endpoint opened in the address bar is still an API. Do not handle
  // its request, or any asset, map tile, SSE stream, or cross-origin navigation.
  if (url.origin !== self.location.origin || !NAVIGATION_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    try {
      // no-store prevents even the browser's HTTP cache from supplying an old
      // application document. A real HTTP error is returned unchanged.
      return await fetch(request, { cache: 'no-store' });
    } catch {
      try {
        const cache = await caches.open(CACHE_NAME);
        const fallback = await cache.match(OFFLINE_URL);
        if (fallback) return fallback;
      } catch { /* Storage may have been evicted or disabled by the browser. */ }
      return new Response('Connexion nécessaire. Aucune annonce ni conversation disponible hors ligne.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  })());
});
