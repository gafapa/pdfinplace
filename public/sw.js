const CACHE_PREFIX = 'pageforge-cache-';
const CACHE_NAME = `${CACHE_PREFIX}v8`;
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

  const removableKeys = keys.filter((request) => {
    const pathname = new URL(request.url).pathname;
    return !APP_SHELL_PATHS.has(pathname);
  });
  await Promise.all(
    removableKeys
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .map((request) => cache.delete(request))
  );
};

const isCacheableStaticRequest = (request, url) => {
  if (!url.pathname.startsWith(BASE_PATH)) return false;
  if (APP_SHELL_PATHS.has(url.pathname)) return true;
  const isBuildAsset = url.pathname.startsWith(`${BASE_PATH}assets/`);
  const isPdfJsAsset = url.pathname.startsWith(`${BASE_PATH}pdfjs/`);
  if (!isBuildAsset && !isPdfJsAsset) return false;

  return (
    ['script', 'style', 'worker', 'font', 'image'].includes(request.destination) ||
    /\.(?:bcmap|icc|wasm|ttf|pfb)$/i.test(url.pathname)
  );
};

const isPdfJsRequest = (url) =>
  url.pathname.startsWith(`${BASE_PATH}pdfjs/`);

const fetchAndCache = async (request) => {
  const response = await fetch(request);
  if (!await shouldCacheResponse(response)) return response;

  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  await trimCache(cache);
  return response;
};

const shouldCacheResponse = async (response) => {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return false;
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = Number(contentLengthHeader);
  if (contentLengthHeader && Number.isFinite(contentLength) && contentLength >= 0) {
    return contentLength <= MAX_CACHEABLE_RESPONSE_BYTES;
  }

  const responseSize = (await response.clone().blob()).size;
  return responseSize <= MAX_CACHEABLE_RESPONSE_BYTES;
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
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
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
        .then(async (response) => {
          const isAppShellNavigation =
            url.pathname === BASE_PATH ||
            url.pathname === `${BASE_PATH}index.html`;
          const isHtml = response.headers.get('content-type')?.toLowerCase().includes('text/html');
          if (isAppShellNavigation && isHtml && await shouldCacheResponse(response)) {
            const responseClone = response.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put(`${BASE_PATH}index.html`, responseClone);
          }
          return response;
        })
        .catch(() => caches.match(`${BASE_PATH}index.html`))
    );
    return;
  }

  if (isPdfJsRequest(url)) {
    event.respondWith(
      fetchAndCache(request).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error('PDF.js asset is unavailable.');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      if (!isCacheableStaticRequest(request, url)) return fetch(request);

      return fetchAndCache(request)
        .catch((error) => {
          if (cached) return cached;
          throw error;
        });
    })
  );
});
