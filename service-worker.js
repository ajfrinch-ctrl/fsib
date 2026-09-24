/* FSIB Branch Marketing Report — service worker.

   Two jobs: keep the app usable with no network at all, and never let a phone
   run yesterday's copy of the app.

   The shell is network-first. index.html is where the sync client lives, and a
   cache-first shell is how a device keeps "working" while silently running a
   build from before real-time sync existed — which looks exactly like "device A
   saved something and device B never shows it". Network-first means a normal
   launch always gets the current build, and an offline launch still falls back
   to the cached one. Static assets (icons, manifest) stay cache-first: they do
   not change between releases, and the cache name is bumped when they do.

   /api/ is never touched — a cached GET would hand a device a stale cloud
   version, and a stale `version` makes every following write fail. */

const CACHE_NAME = "fsib-branch-marketing-v11";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* The app shell: a navigation, the shell itself, or the manifest. */
function isShellRequest(request, url) {
  if (request.mode === "navigate") return true;
  const path = url.pathname;
  return path.endsWith("/") || path.endsWith("/index.html") || path.endsWith("/manifest.json");
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  /* Never touch the API. A cached GET would hand a device yesterday's cloud
     state — and a stale `version` makes every following write fail.
     /api/live matters even more: a cached answer (or one served from a dying
     cache) would silently stop the real-time channel. */
  if (url.pathname.indexOf("/api/") !== -1) return;

  /* Network-first for the shell: a phone must never run an old build. Offline,
     the cached copy is served instead, so the app still opens with no signal. */
  if (isShellRequest(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type !== "opaque") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  /* Everything else: cache-first, then network. */
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {

      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then(response => {

          if (
            !response ||
            response.status !== 200 ||
            response.type === "opaque"
          ) {
            return response;
          }

          const copy = response.clone();

          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, copy));

          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
