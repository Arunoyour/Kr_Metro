// Service worker: precaches the whole app shell so it keeps working with
// zero network access after the first successful load. Everything here is
// static (station data, routing logic) — nothing needs a live network call
// to function, so a straightforward cache-first strategy is enough.

const CACHE_NAME = "kr-metro-v7";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./data.js",
  "./timings.js",
  "./router.js",
  "./geo.js",
  "./map.js",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline and never cached: for a page navigation, fall back to
          // the app shell rather than showing the browser's error page.
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return undefined;
        });
    })
  );
});
