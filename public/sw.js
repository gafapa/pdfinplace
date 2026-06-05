const CACHE_NAME = 'pageforge-cache-v5';
const BASE_PATH = new URL(self.registration.scope).pathname;
const MAX_CACHE_ENTRIES = 80;
const MAX_CACHEABLE_RESPONSE_BYTES = 5 * 1024 * 1024;
const APP_SHELL = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}icon.svg`,
  `${BASE_PATH}pwa-192.png`,
  `${BASE_PATH}pwa-512.png`,
  `${BASE_PATH}apple-touch-icon.png`,
];
const APP_SHELL_PATHS = new Set(APP_SHELL);

const trimCache = async (cache) => {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;

  await Promise.all(keys.slice(0, keys.length - MAX_CACHE_ENTRIES).map((request) => cache.delete(request)));
};

const isCacheableStaticRequest = (request, url) => {
  if (!url.pathname.startsWith(BASE_PATH)) return false;
  if (APP_SHELL_PATHS.has(url.pathname)) return true;
  if (!url.pathname.startsWith(`${BASE_PATH}assets/`)) return false;

  return ['script', 'style', 'worker', 'font', 'image'].includes(request.destination);
};

const shouldCacheResponse = (response) => {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return false;
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  return !Number.isFinite(contentLength) ||
    contentLength === 0 ||
    contentLength <= MAX_CACHEABLE_RESPONSE_BYTES;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (shouldCacheResponse(response)) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(`${BASE_PATH}index.html`, responseClone));
          }
          return response;
        })
        .catch(() => caches.match(`${BASE_PATH}index.html`))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      if (!isCacheableStaticRequest(request, url)) return fetch(request);

      return fetch(request)
        .then((response) => {
          if (!shouldCacheResponse(response)) {
            return response;
          }

          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone).then(() => trimCache(cache)));
          return response;
        })
        .catch(() => cached);
    })
  );
});
