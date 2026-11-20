// Bump VERSION whenever the list of shell files changes.
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const TILES = 'tiles';
const TILE_LIMIT = 3000;

const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/favicon.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // cache: 'reload' skips the browser HTTP cache (GitHub Pages caches files ~10 min)
    await (await caches.open(SHELL)).addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' })));
    // cache trip index + every trip file so the whole plan works offline
    const data = await caches.open(DATA);
    try {
      const res = await fetch('data/trips.json', { cache: 'no-cache' });
      const { trips = [] } = await res.clone().json();
      await data.put('data/trips.json', res);
      await Promise.all(trips.map(t => data.add(t.file).catch(() => {})));
    } catch (e) { /* offline during install: data cached on first use */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [SHELL, DATA, TILES];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(tileCacheFirst(req));
  } else if (url.origin === location.origin && url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(req, DATA));
  } else if (url.origin === location.origin) {
    event.respondWith(networkFirst(req, SHELL, 3000));
  }
});

// fresh copy when online; cached copy when offline or the network is slower than timeoutMs
async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const net = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const fallback = async () => {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    return hit || net;
  };
  if (!timeoutMs) return net.catch(fallback);
  const timer = new Promise(r => setTimeout(r, timeoutMs, 'timeout'));
  try {
    const first = await Promise.race([net, timer]);
    if (first !== 'timeout') return first;
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || net;
  } catch (e) {
    return fallback();
  }
}


async function tileCacheFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await cache.delete(keys[i]);
}
