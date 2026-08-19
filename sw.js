// Service worker for the Attendance Ledger PWA.
//
// Caches the app shell so an installed PWA can boot without a network. That now
// genuinely works: the only runtime dependency is vendored (vendor/supabase-js.min.js)
// instead of imported from a third-party CDN, so there is no cross-origin fetch
// standing between "the shell loaded" and "the app can run". Previously the shell
// was served from cache offline and the app then died silently on the CDN import,
// leaving a sign-in screen with no listeners attached and no error message.
//
// Attendance data itself still requires a connection — this does NOT implement
// offline data access, which would need a sync/queue layer.

const CACHE_NAME = "attendance-ledger-shell-v5";

// Every file needed to boot. Both "./" and "./index.html" are listed: the app is
// served from a directory root on GitHub Pages, so a navigation request arrives
// for the directory and would never match a cache entry keyed to index.html.
//
// The theme stylesheets are <link>ed from index.html (see themes/*/theme.css),
// not inlined, so they're listed here too — otherwise an offline boot would
// render Kinetic/Velocity unstyled. Each theme's font files are not precached:
// they're a progressive enhancement behind font-display:swap, so a missed
// fetch offline just falls back to the next font in the stack instead of
// breaking anything, and it's not worth the cache weight to guarantee them.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./vendor/supabase-js.min.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon-32.png",
  "./favicon-16.png",
  "./apple-touch-icon.png",
  "./themes/ledger/theme.css",
  "./themes/kinetic/theme.css",
  "./themes/velocity/theme.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  // Take over straight away. The shell is self-consistent (index.html, app.js and
  // the vendored library are cached together as one unit), so there is no risk of
  // serving a half-updated pair.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Supabase REST, auth and realtime traffic
  // goes straight to the network untouched — the previous version claimed to do
  // this in a comment but actually intercepted every GET on every origin.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a deployed update is picked up, falling back
  // to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("./index.html")) ||
               (await cache.match("./")) ||
               Response.error();
      })
    );
    return;
  }

  // Same-origin assets: network first, cache as a fallback. respondWith is never
  // handed an undefined — an uncached miss returns a real error response instead
  // of a confusing generic network failure.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        return hit || new Response("Offline and not cached", {
          status: 504,
          statusText: "Offline",
          headers: { "Content-Type": "text/plain" }
        });
      })
  );
});
