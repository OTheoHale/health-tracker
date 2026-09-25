/* Health Tracker service worker.
 *
 * Scoping rule, learned the expensive way on skabone.github.io: Gena's worker deleted EVERY cache
 * on its origin, so each Gena release evicted NFL FantasyCast's offline shell. A worker must only
 * ever delete caches it owns. This one touches nothing that does not start with SHELL_PREFIX, and
 * it never touches localStorage or IndexedDB, which is where the records actually live.
 *
 * Health Tracker publishes to its own host for the same family of reasons, so today it is alone
 * there — but a worker that only cleans up after itself stays correct if that ever changes.
 */
const BUILD = '2026-09-25-V2.1';                      // ship.sh stamps this in step with delivery.js
const SHELL_PREFIX = 'health-tracker-shell-';
const SHELL = SHELL_PREFIX + BUILD;

/* Only the application shell. No record, export or body asset is ever cached here: records live
   in IndexedDB and localStorage, and body files never leave the Mac. */
const SHELL_FILES = [
  './', 'index.html', 'delivery.js',
  'health-domain.js', 'health-store.js', 'hae-adapter.js', 'body-view.js',
  'meal-water.js', 'quarter-points.js', 'scoring-v5.js', 'eotc-calendar.js', 'workspace-proposal.js', 'convert-starter.js',
  'model-viewer.min.js', 'body-view.css', 'manifest.webmanifest', 'offline.html',
  'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)));
  /* Deliberately NOT skipWaiting: a new shell waits for an explicit restart from the page, so a
     release never swaps the app out from under someone mid-entry. */
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(SHELL_PREFIX) && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'restart') self.skipWaiting();     // the page asked, explicitly
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  /* Anything off this origin, and the body scheme, is none of this worker's business. */
  if (url.origin !== self.location.origin) return;
  /* The page's version check asks for the network copy; answering it from this cache would always
     report the running build and no update would ever be noticed. */
  if (request.cache === 'no-store') return;
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    try { return await fetch(request); }
    catch (_) {
      const fallback = await caches.match('offline.html');
      return fallback || new Response('Offline', {status: 503, headers: {'Content-Type': 'text/plain'}});
    }
  })());
});
