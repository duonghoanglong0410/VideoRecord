// PackingProof Web — Safe App Shell Service Worker
// Policy:
// 1. Caches ONLY same-origin static App Shell assets (/, /index.html, /manifest.webmanifest, /icons/*, /assets/*.js, /assets/*.css).
// 2. STRICTLY BYPASSES all non-GET requests (POST/PATCH/PUT/DELETE/HEAD), all requests with a Range header,
//    all cross-origin requests, and all /api/*, /health/*, /openapi/*, or media stream/download URLs.
// 3. Never caches private API responses or video bytes, and never claims background/offline recording or upload guarantees.

const APP_SHELL_CACHE = 'packingproof-app-shell-v1';
const PRECACHE_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/icons/icon-maskable.svg'
];

function isForbiddenDynamicOrMediaPath(pathname) {
  const lower = pathname.toLowerCase();
  if (lower === '/api' || lower.startsWith('/api/')) {
    return true;
  }
  if (lower === '/health' || lower.startsWith('/health/')) {
    return true;
  }
  if (lower === '/openapi' || lower.startsWith('/openapi/')) {
    return true;
  }
  if (lower === '/sw.js') {
    return true;
  }
  if (/\.(mp4|webm|mkv|mov)$/i.test(lower)) {
    return true;
  }
  return false;
}

function isCacheableStaticShellAssetRequest(request, currentOrigin) {
  if (!request || request.method !== 'GET') {
    return false;
  }

  if (
    request.headers &&
    (request.headers.has('Range') || request.headers.has('range'))
  ) {
    return false;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return false;
  }

  if (parsedUrl.origin !== currentOrigin) {
    return false;
  }

  const pathname = parsedUrl.pathname;
  if (isForbiddenDynamicOrMediaPath(pathname)) {
    return false;
  }

  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/manifest.webmanifest'
  ) {
    return true;
  }

  if (pathname.startsWith('/icons/') && /\.(svg|png|ico)$/i.test(pathname)) {
    return true;
  }

  if (pathname.startsWith('/assets/') && /\.(js|css)$/i.test(pathname)) {
    return true;
  }

  return false;
}

function isCacheableResponse(response) {
  if (!response || !response.ok || response.status !== 200) {
    return false;
  }

  if (response.type && response.type !== 'basic' && response.type !== 'default') {
    return false;
  }

  const cacheControl = (
    (response.headers && response.headers.get('Cache-Control')) ||
    ''
  ).toLowerCase();

  if (cacheControl.includes('no-store') || cacheControl.includes('private')) {
    return false;
  }

  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => undefined)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== APP_SHELL_CACHE)
            .map((staleKey) => caches.delete(staleKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const isCacheableStaticAsset = isCacheableStaticShellAssetRequest(
    event.request,
    self.location.origin
  );

  // STRICT BYPASS: never intercept /api/*, /health/*, /openapi/*, Range requests, or non-GET uploads!
  if (!isCacheableStaticAsset) {
    return;
  }

  const parsedUrl = new URL(event.request.url);
  const isImmutableBundle = parsedUrl.pathname.startsWith('/assets/');

  if (isImmutableBundle) {
    // Hashed /assets/*.js and /assets/*.css: Cache-first with safe network fill
    event.respondWith(
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          return cached;
        }

        const networkResponse = await fetch(event.request);
        if (isCacheableResponse(networkResponse)) {
          await cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      })
    );
    return;
  }

  // App shell HTML, manifest, and icons: Network-first so deployments update immediately, falling back to cache
  event.respondWith(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      try {
        const networkResponse = await fetch(event.request);
        if (isCacheableResponse(networkResponse)) {
          await cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        const cached = await cache.match(event.request);
        if (cached) {
          return cached;
        }
        throw err;
      }
    })
  );
});
