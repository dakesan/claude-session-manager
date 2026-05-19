// Service Worker for CSM PWA
// Network-first strategy: always try fresh data, fall back to cache

const CACHE_NAME = "csm-v2";
const PRECACHE = ["/", "/styles.css", "/icons.jsx", "/pieces.jsx", "/drawer.jsx", "/app.jsx", "/data.js", "/tweaks-panel.jsx", "/icon.png", "/icon-192.png", "/icon-512.png", "/favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Skip WebSocket and non-GET requests
  if (e.request.method !== "GET" || e.request.url.includes("/ws/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
