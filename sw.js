// Minimal service worker for PWA installability.
//
// This intentionally does NOT implement offline data access — the app talks
// to Supabase for everything, so working offline would need a much bigger
// sync/queue layer. All this does is:
//   1. Satisfy the browser's "has a fetch handler" installability check.
//   2. Cache the app shell (this HTML file + icons) so the app's icon and
//      name are available instantly once installed, even on a slow network.
//
// Every real request still goes to the network first; the cache is only a
// fallback if that specific request fails (e.g. a flaky connection).

const CACHE_NAME = "attendance-ledger-shell-v3";
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
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
  // Only handle our own shell files; let every Supabase/API call go straight
  // to the network untouched.
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
