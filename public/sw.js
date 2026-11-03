const CACHE_PREFIX = 'pageforge-cache-';
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const PDFJS_CACHE_PREFIX = 'pageforge-pdfjs-';
const MAX_PDFJS_CACHE_VERSIONS = 3;
const BASE_PATH = new URL(self.registration.scope).pathname;
const MAX_CACHE_ENTRIES = 80;
const MAX_CACHEABLE_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CACHEABLE_FONT_BYTES = 20 * 1024 * 1024;
// Files shared to the installed app wait here until the page reads them (src/hooks/useLaunchedFiles.ts).
const SHARE_TARGET_CACHE = 'pageforge-share-target';
const SHARE_TARGET_PATH = `${BASE_PATH}share-target`;
const MAX_SHARED_FILES = 20;
const MAX_SHARED_FILE_BYTES = 75 * 1024 * 1024;
const MAX_SHARED_TOTAL_BYTES = 250 * 1024 * 1024;
const SHARED_FILE_TTL_MS = 60 * 60 * 1000;
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
  const isBundledFont = url.pathname.startsWith(`${BASE_PATH}fonts/`);
  if (!isBuildAsset && !isPdfJsAsset && !isBundledFont) return false;

  return (
    ['script', 'style', 'worker', 'font', 'image'].includes(request.destination) ||
    /\.(?:bcmap|icc|wasm|ttf|otf|pfb)$/i.test(url.pathname)
  );
};

const isPdfJsRequest = (url) =>
  url.pathname.startsWith(`${BASE_PATH}pdfjs/`);

const trimPdfJsCaches = async () => {
  const keys = await caches.keys();
  const pdfJsCaches = keys.filter((key) => key.startsWith(PDFJS_CACHE_PREFIX));
  await Promise.all(pdfJsCaches.slice(0, -MAX_PDFJS_CACHE_VERSIONS).map((key) => caches.delete(key)));
};

const fetchAndCache = async (request, url) => {
  const response = await fetch(request);
  const maxBytes = url.pathname.startsWith(`${BASE_PATH}fonts/`)
    ? MAX_CACHEABLE_FONT_BYTES
    : MAX_CACHEABLE_RESPONSE_BYTES;
  if (!await shouldCacheResponse(response, maxBytes)) return response;

  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    await trimCache(cache);
  } catch {
    // A full/denied cache must not hide a successful network response.
  }
  return response;
};

const fetchAndCachePdfJs = async (request, url) => {
  const response = await fetch(request);
  if (!await shouldCacheResponse(response)) return response;

  // The versioned URL is immutable. Keeping previous version caches lets an
  // already-open application continue using the worker/resources it loaded.
  const version = url.pathname.slice(`${BASE_PATH}pdfjs/`.length).split('/')[0];
  try {
    const cache = await caches.open(`${PDFJS_CACHE_PREFIX}${version}`);
    await cache.put(request, response.clone());
    await trimPdfJsCaches();
  } catch {
    // Resource caching is optional while the network is available.
  }
  return response;
};

const shouldCacheResponse = async (response, maxBytes = MAX_CACHEABLE_RESPONSE_BYTES) => {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return false;
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = Number(contentLengthHeader);
  if (contentLengthHeader && Number.isFinite(contentLength) && contentLength >= 0) {
    return contentLength <= maxBytes;
  }

  const responseSize = (await response.clone().blob()).size;
  return responseSize <= maxBytes;
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
      .then((keys) => {
        const expiredShellCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
        return Promise.all(expiredShellCaches.map((key) => caches.delete(key)));
      })
      .then(trimPdfJsCaches)
      .then(() => self.clients.claim())
  );
});

const receiveSharedFiles = async (request) => {
  let cache;
  const stagedRequests = [];
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((value) => typeof value !== 'string');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (!files.length || files.length > MAX_SHARED_FILES ||
        files.some((file) => file.size > MAX_SHARED_FILE_BYTES) || totalBytes > MAX_SHARED_TOTAL_BYTES) {
      return new Response('Shared files exceed the supported file count or size limits.', { status: 413 });
    }
    cache = await caches.open(SHARE_TARGET_CACHE);
    const receivedAt = Date.now();
    for (const key of await cache.keys()) {
      const stored = await cache.match(key);
      const timestamp = Number(stored?.headers.get('x-shared-at'));
      if (timestamp > 0 && receivedAt - timestamp > SHARED_FILE_TTL_MS) await cache.delete(key);
    }
    const batchId = crypto.randomUUID();
    for (const [index, file] of files.entries()) {
      const key = new Request(new URL(`${BASE_PATH}__shared-files/${batchId}/${index}`, self.location.origin));
      stagedRequests.push(key);
      await cache.put(key, new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
          'x-shared-at': String(receivedAt),
        },
      }));
    }
    const destination = new URL(BASE_PATH, self.location.origin);
    destination.searchParams.set('shared-files', batchId);
    return Response.redirect(destination.href, 303);
  } catch (error) {
    if (cache) await Promise.all(stagedRequests.map((key) => cache.delete(key).catch(() => false)));
    console.error('Could not receive the shared files:', error);
    return new Response('Shared files could not be received. Please open the app and import them again.', { status: 503 });
  }
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(receiveSharedFiles(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const isAppShellNavigation =
            url.pathname === BASE_PATH ||
            url.pathname === `${BASE_PATH}index.html`;
          const isHtml = response.headers.get('content-type')?.toLowerCase().includes('text/html');
          if (isAppShellNavigation && isHtml && await shouldCacheResponse(response)) {
            try {
              const cache = await caches.open(CACHE_NAME);
              await cache.put(`${BASE_PATH}index.html`, response.clone());
            } catch {
              // Keep returning fresh HTML when optional offline storage fails.
            }
          }
          return response;
        })
        .catch(() => caches.match(`${BASE_PATH}index.html`))
    );
    return;
  }

  if (isPdfJsRequest(url)) {
    event.respondWith(
      fetchAndCachePdfJs(request, url).catch(async () => {
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

      return fetchAndCache(request, url)
        .catch((error) => {
          if (cached) return cached;
          throw error;
        });
    })
  );
});
