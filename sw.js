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

// Bump alongside the ?v= query on app.js in index.html. activate() deletes
// every cache whose key is not this one, so a bump is what forces an
// installed PWA to drop the old shell and precache the new one.
const CACHE_NAME = "attendance-ledger-shell-v8";

// Every file needed to boot. Both "./" and "./index.html" are listed: the app is
// served from a directory root on GitHub Pages, so a navigation request arrives
// for the directory and would never match a cache entry keyed to index.html.
//
// The theme stylesheets that used to be listed here are gone: the app ships one
// design system (Meridian) and its CSS is inline in index.html. Leaving the three
// dead paths in place was worse than it looked — cache.addAll rejects if ANY
// entry 404s, and the .catch() below swallows that, so three missing files
// meant nothing at all got precached and offline boot failed silently.
//
// Switzer is precached, unlike the old themes' fonts. It is behind
// font-display:swap so a miss is survivable, but it is now the entire
// typographic identity rather than one theme's flourish, and 72KB is cheap
// insurance against an offline boot rendering in Arial.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  // Blocking, in <head>, and the reason an offline boot does not flash the
  // default palette before settling on the chosen one. A miss here is not
  // survivable the way a font miss is: the page would paint Atrium at someone
  // who chose dark.
  "./theme-boot.js",
  "./vendor/supabase-js.min.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon-32.png",
  "./favicon-16.png",
  "./apple-touch-icon.png",
  "./fonts/Switzer-Regular.woff2",
  "./fonts/Switzer-Medium.woff2",
  "./fonts/Switzer-Bold.woff2",
  "./fonts/Switzer-Black.woff2"
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
        // ignoreSearch, because index.html requests app.js with a cache-busting
        // version query while the shell precaches the bare path. Without it an
        // offline boot misses on "app.js?v=..." and the app dies with the shell
        // already on screen — the exact silent failure this worker exists to
        // prevent. It also means a version bump costs nothing here.
        const hit = await caches.match(req, {ignoreSearch: true});
        return hit || new Response("Offline and not cached", {
          status: 504,
          statusText: "Offline",
          headers: { "Content-Type": "text/plain" }
        });
      })
  );
});

// ---------- Push notifications ----------
// The payload is whatever send-push (a Supabase Edge Function) put in the
// Web Push message: {title, body, action, data}. action/data are only
// present for a system reminder's "Clock Out" button today, but the shape
// leaves room for other action types without a service worker change.
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }

  const title = payload.title || "Attendance Ledger";
  const data = Object.assign({ action: payload.action || null }, payload.data || {});
  const options = {
    body: payload.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: data,
    // Only a clock-out reminder carries an action button today, and only
    // when it also carries the label to put on it -- an action with no
    // title would render as a blank, tappable button.
    actions: (payload.action === "clock_out" && data.label)
      ? [{ action: "clock_out", title: data.label }]
      : []
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// All the actual clock-out logic stays in app.js (quickClockOut, reached via
// consumeShortcutAction's ?action=out-date&date=... case) — this worker
// never talks to Supabase or holds a session token. Navigating an already-
// open tab to that URL is a real page load, which re-runs the same boot
// sequence a cold launch from the manifest shortcut already goes through.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  var url = "./index.html";
  if (event.action === "clock_out" && data.date) {
    url = "./index.html?action=out-date&date=" + encodeURIComponent(data.date);
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Reuse an already-open tab showing this app rather than stacking a
        // second one -- but only if it actually is this app, not some other
        // same-origin page the browser happens to have open.
        if (client.url.indexOf(self.registration.scope) === 0 && "focus" in client) {
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
