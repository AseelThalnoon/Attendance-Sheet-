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

// activate() deletes every cache whose key is not this one, so a bump is what
// forces an installed PWA to drop the old shell and precache the new one.
// The suffix is also the release's build label: index.html loads
// "app.js?v=<suffix>", crash reports carry it, and tests/regression/
// crash-handler.js fails when the two differ. This comment used to ask for
// the two to be bumped together; nothing checked, and the ?v= sat unchanged
// for 67 commits while this went from v1x to v40.
const CACHE_NAME = "attendance-ledger-shell-v45";

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
  // app.js is an ES module and these are its static imports, so they are not
  // optional extras — a miss here fails the module graph and the app never
  // executes, which is the same silent dead-shell failure the vendored
  // Supabase build was moved in-tree to prevent. Every new file under src/
  // has to be added here as it is extracted.
  "./src/constants.js",
  "./src/entries.js",
  "./src/errors.js",
  "./src/schedule.js",
  "./src/storage.js",
  "./src/time.js",
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      // cache:"reload" fetches each file from the network, bypassing the HTTP
      // cache. Without it addAll() was served from that cache, and GitHub Pages
      // lets the browser keep a file for ten minutes (max-age=600) — so a worker
      // installed just after a deploy could precache a fresh app.js beside a
      // stale index.html, and every offline boot after that ran a script against
      // a page it did not match.
      SHELL_FILES.map((url) => new Request(url, { cache: "reload" }))
    )).catch(() => {})
  );
  // Take over straight away. The shell is self-consistent (index.html, app.js and
  // the vendored library are fetched fresh and cached together as one unit), so
  // there is no risk of serving a half-updated pair.
  self.skipWaiting();
});

// The page's own cache of people's photos (see AVATAR_CACHE in app.js). It is
// not part of any release, so a new worker must not throw it away with the
// old shell; app.js empties it on sign-out.
const AVATAR_CACHE = "attendance-avatars-v1";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== AVATAR_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// How long opening the app waits on the network before using the cached
// shell. It used to wait for as long as the network took, falling back only
// when the request failed outright -- so on weak signal, which is slow rather
// than absent, opening the app was slow too.
const NAV_TIMEOUT_MS = 3000;

// Pages opened from the cached shell, by client id. Their scripts and styles
// then come from the same cache, so a cached page never runs a script from a
// newer release that it does not match (the stale-copy crash of 2026-11-03,
// from the other direction). Kept in memory: a page's module imports all
// arrive in its first seconds, long before an idle worker could be stopped.
const cachedShellClients = new Set();

// The precached files, as paths. Network responses for these never overwrite
// a cached copy -- they only fill one in that is missing -- so the cache stays
// the one consistent snapshot install() took, and a page opened from it gets
// the scripts that belong to it.
const SHELL_PATHS = new Set(SHELL_FILES.map((f) => new URL(f, self.location.href).pathname));

function cachedShell(){
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match("./index.html").then((hit) => hit || cache.match("./")));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Supabase REST, auth and realtime traffic
  // goes straight to the network untouched — the previous version claimed to do
  // this in a comment but actually intercepted every GET on every origin.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a deployed update is picked up, falling back
  // to the cached shell when offline -- or when the network hasn't answered
  // within NAV_TIMEOUT_MS and there is a cached shell to open instead.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const network = fetch(req);
      const fromCache = async () => {
        const hit = await cachedShell();
        if (hit && event.resultingClientId) cachedShellClients.add(event.resultingClientId);
        return hit;
      };
      // A browser that doesn't say which page this navigation creates gives
      // no way to keep a cached page on its own scripts, so it waits for the
      // network as it always did.
      let timer;
      const slow = event.resultingClientId
        ? new Promise((resolve) => { timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS); })
        : new Promise(() => {});
      try {
        const first = await Promise.race([network, slow]);
        if (first) return first;
      } catch (e) {
        return (await fromCache()) || Response.error();
      } finally {
        clearTimeout(timer);
      }
      // Still waiting on the network: open the cached copy if there is one.
      // The request carries on, unawaited, so a slow answer isn't an error.
      const hit = await fromCache();
      if (hit) { network.catch(() => {}); return hit; }
      try { return await network; } catch (e) { return Response.error(); }
    })());
    return;
  }

  // A page opened from the cached shell takes its files from the same cache,
  // so its scripts match it; anything not cached still comes from the network.
  if (event.clientId && cachedShellClients.has(event.clientId)) {
    event.respondWith(
      caches.open(CACHE_NAME)
        .then((c) => c.match(req, { ignoreSearch: true }))
        .then((hit) => hit || fetch(req))
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
          caches.open(CACHE_NAME).then(async (c) => {
            if (SHELL_PATHS.has(url.pathname) && await c.match(req, { ignoreSearch: true })) return;
            return c.put(req, copy);
          }).catch(() => {});
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
