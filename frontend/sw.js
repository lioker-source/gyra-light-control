/* Service Worker fuer das Atrium-Pult.
   Zweck ist vor allem die Installierbarkeit als App auf dem Tablet und ein
   kurzes Ueberbruecken von Netz-Aussetzern. Die Bedienung selbst haengt am
   WebSocket - der laeuft am Service Worker vorbei und wird hier nie beruehrt.

   Strategie: network-first fuer alles aus dem eigenen Ursprung. Ein frisch
   deployter Stand gewinnt damit immer; der Cache ist nur der Fallback, wenn
   der Server gerade nicht antwortet. Fremde Ursprünge (Google Fonts) werden
   cache-first bedient, damit das Pult auch ohne Internet startet. */

const VERSION = 'atrium-light-v5';
const SHELL = [
  './',
  './index.php',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './app-icons/icon-192.png',
  './app-icons/icon-512.png',
  './app-icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Einzeln, damit ein fehlendes Teil nicht die ganze Installation kippt.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // Navigationsanfrage ohne Treffer: wenigstens die Startseite anbieten.
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.php', { ignoreSearch: true });
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Fonts kommen als opaque Response - trotzdem brauchbar zum Ausliefern.
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
  return res;
}
