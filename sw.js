/* ---------------------------------------------------------------------------
 * Service worker — offline support for the public library.
 *
 * Strategy:
 *   App shell (HTML/CSS/JS/vendor)  -> stale-while-revalidate, so the site
 *                                      opens instantly and updates quietly.
 *   Library data (apps.json etc.)   -> network-first with a cache fallback,
 *                                      so students see fresh files when
 *                                      online and the last known list when not.
 *   Downloads (/apps/*)             -> cache-first once fetched, so a file
 *                                      opened at school stays available at home.
 *   Counter / GitHub API traffic    -> never cached.
 * ------------------------------------------------------------------------- */

const VERSION = 'v1.3.3';
const SHELL_CACHE = `schoolcloud-shell-${VERSION}`;
const DATA_CACHE = `schoolcloud-data-${VERSION}`;
const FILE_CACHE = `schoolcloud-files-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './offline.html',
  './assets/css/app.css',
  './assets/js/app.js',
  './assets/js/config.js',
  './assets/js/lib/metadata.js',
  './assets/js/lib/search.js',
  './assets/js/lib/counters.js',
  './assets/js/lib/format.js',
  './assets/js/lib/preview.js',
  './assets/js/lib/submissions.js',
  './assets/js/lib/fileStore.js',
  './assets/js/lib/credentials.js',
  './assets/js/lib/githubPublish.js',
  './assets/vendor/alpine.min.js',
  './assets/vendor/lucide.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is atomic: one 404 would leave us with no shell at all, so add
    // each asset independently and tolerate individual failures.
    await Promise.all(SHELL_ASSETS.map(async asset => {
      try {
        await cache.add(new Request(asset, { cache: 'reload' }));
      } catch (error) {
        console.warn('[sw] could not precache', asset, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, FILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map(name => (keep.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

/** Let the page trigger an immediate update. */
self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isLibraryData(url) {
  return url.pathname.endsWith('/apps.json') || url.pathname.endsWith('/library.json');
}

function isDownloadableFile(url) {
  return /\/apps\/.+\.(?:html?|pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname);
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(response => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await network) || Response.error();
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache counter or GitHub API traffic — it must always be live.
  if (url.hostname.endsWith('supabase.co') ||
      url.hostname.includes('abacus') ||
      url.hostname === 'api.github.com') {
    return;
  }

  // The shared publishing token must never be served from a cache: when the
  // administrator saves, replaces or deletes it, every device has to see the
  // change on the next load, not whatever was cached before.
  if (url.pathname.endsWith('/assets/data/cloud-token.json')) return;

  // Cross-origin requests (e.g. the Office viewer) go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Blob URLs (teacher submission previews and downloads created at runtime)
  // must pass straight through — they cannot be cached and are short-lived.
  if (url.protocol === 'blob:') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await networkFirst(request, SHELL_CACHE);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./offline.html')) ||
               Response.error();
      }
    })());
    return;
  }

  if (isLibraryData(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE).catch(async () => {
      const cache = await caches.open(DATA_CACHE);
      return (await cache.match(request)) ||
             new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  if (isDownloadableFile(url)) {
    event.respondWith(cacheFirst(request, FILE_CACHE).catch(() => Response.error()));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});
