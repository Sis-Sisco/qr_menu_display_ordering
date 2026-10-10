// ---------------------------------------------------------------------------
// Service Worker — Customer-Only Safe Assets
// Admin code and sensitive APIs are strictly NEVER cached.
// ---------------------------------------------------------------------------
const CACHE_NAME = "qr-order-cache-v4";

const APP_SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/customer.js",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache admin pages, admin scripts, or administrative APIs
  if (
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/js/admin") ||
    url.pathname.startsWith("/api/admin") ||
    url.pathname.startsWith("/api/table-session")
  ) {
    return;
  }

  // Customer Menu & Product Images: Network-First with Cache Fallback
  if (
    url.pathname === "/api/menu" ||
    url.pathname.startsWith("/uploads/") ||
    request.destination === "image"
  ) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Do not cache customer transactional order submission/payment
  if (url.pathname.startsWith("/api/orders")) {
    return;
  }

  // Customer App Shell: Cache-First, Network Fallback
  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return res;
          })
          .catch(() => caches.match("/index.html"))
      );
    })
  );
});