// Service worker for the Attendance Ledger PWA.
//
// It keeps a copy of the app -- the "shell": the page, its scripts, its fonts --
// and opens the app from that copy. The only runtime dependency is vendored
// (vendor/supabase-js.min.js), so there is no cross-origin fetch standing
// between "the shell loaded" and "the app can run".
//
// Attendance data itself still requires a connection -- this does NOT implement
// offline data access, which would need a sync/queue layer.
//
// ---------------------------------------------------------------------------
// How the app opens, and how a new release reaches it (changed 2026-11-15)
// ---------------------------------------------------------------------------
// Until then this worker asked the network first, every time, and fell back
// to its copy only when the network failed or took three seconds. That bought
// "always the latest" at the price of every launch waiting on a request for a
// 500KB page before anything could draw -- on the phone, on the way in, which
// is the moment this app exists for. The owner chose the other trade:
//
//   * Opening the app is answered from the saved copy, at once. The network is
//     not asked.
//   * Every file of the shell comes from that same copy, for every page. So a
//     page and its scripts are always one release -- the mismatch that crashed
//     the app on 2026-11-03 cannot be assembled out of this cache.
//   * A new release arrives as a new version of this file. The browser fetches
//     it in the background after a launch, and install() below saves the whole
//     new shell beside the old one. Nothing running is touched.
//   * The new shell takes over when the app is next opened, or sooner if the
//     page asks (it does when the person comes back after a break, or presses
//     Refresh -- see "New releases" at the foot of app.js). It never takes over
//     underneath a page that is in use: this worker no longer calls
//     skipWaiting() on its own.
//
// What that asks of a release: THIS FILE MUST CHANGE whenever any file of the
// shell does, or nobody who has the app installed will ever receive the
// change. The line below is how that is enforced.

// activate() deletes every shell cache whose key is not this one.
// The suffix is also the release's build label: index.html loads
// "app.js?v=<suffix>", crash reports carry it, and tests/regression/
// crash-handler.js fails when the two differ.
const CACHE_NAME = "attendance-ledger-shell-v59";

// A fingerprint of every file in SHELL_FILES, as it was when this release was
// stamped. The worker does not read it. It is here so that this file's bytes
// change whenever the shell's do: tests/regression/service-worker.js recomputes
// it and fails when they differ, and `node tools/stamp-release.mjs` is what
// moves the label on and writes the new value. With the old network-first
// worker a forgotten bump cost only the offline copy; now it would leave every
// installed copy of the app on the previous release.
const SHELL_FINGERPRINT = "4c64ac6b9c9824c9";

// Every file needed to boot. Both "./" and "./index.html" are listed: the app is
// served from a directory root on GitHub Pages, so a navigation request arrives
// for the directory and would never match a cache entry keyed to index.html.
//
// Switzer is precached. It is behind font-display:swap so a miss is
// survivable, but it is the entire typographic identity, and 72KB is cheap
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

// The build label on its own ("v47"), as index.html spells it.
const BUILD = CACHE_NAME.slice("attendance-ledger-shell-".length);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:"reload" fetches each file from the network, bypassing the HTTP
    // cache. Without it addAll() was served from that cache, and GitHub Pages
    // lets the browser keep a file for ten minutes (max-age=600) -- so a worker
    // installed just after a deploy could save a fresh app.js beside a stale
    // index.html.
    //
    // No catch. addAll() is all-or-nothing, and a failure here used to be
    // swallowed: the worker installed anyway with an empty cache, activated,
    // and deleted the previous release's complete one. A failed install now
    // stays failed. The browser discards this worker, the one already running
    // keeps serving its own intact copy, and the next launch tries again.
    await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "reload" })));

    // The page that was just saved has to be the page of THIS release. A copy
    // of index.html still naming the previous build -- an edge cache a few
    // seconds behind a deploy -- would be opened beside this release's scripts
    // from now until the next one, with nothing to replace it in between.
    const page = await cache.match("./index.html");
    const html = page ? await page.text() : "";
    if (html.indexOf("app.js?v=" + BUILD + '"') === -1) {
      await caches.delete(CACHE_NAME);
      throw new Error("sw.js is release " + BUILD + " and index.html is not");
    }
  })());
  // Deliberately no skipWaiting(): see the head of this file. A first install
  // has nobody to wait for and activates by itself.
});

// The page's way of saying "take over now" -- sent when it is about to reload
// itself onto the new release, so there is no moment at which an old page is
// left running under a new worker.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
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

// The saved files, as paths, and the two addresses that open the app.
const SHELL_PATHS = new Set(SHELL_FILES.map((f) => new URL(f, self.location.href).pathname));
const APP_ROOT = new URL("./", self.location.href).pathname;
const APP_ENTRIES = new Set([APP_ROOT, APP_ROOT + "index.html"]);

function cachedShell(){
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match("./index.html").then((hit) => hit || cache.match("./")));
}

const OFFLINE_RESPONSE = () => new Response("Offline and not cached", {
  status: 504,
  statusText: "Offline",
  headers: { "Content-Type": "text/plain" }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Supabase REST, auth and realtime traffic
  // goes straight to the network untouched.
  if (url.origin !== self.location.origin) return;

  // Opening the app: the saved copy, at once, whatever the network is doing.
  // Only for the app's own two addresses (with any ?action=... a shortcut or a
  // notification put on them): anything else under this folder that someone
  // navigates to is a file, not the app, and is left to the network.
  if (req.mode === "navigate") {
    if (!APP_ENTRIES.has(url.pathname)) return;
    event.respondWith((async () => {
      const hit = await cachedShell();
      if (hit) return hit;
      // Nothing saved -- a first visit that beat install(), or storage the
      // browser reclaimed. The network is the only place left to ask.
      try { return await fetch(req); } catch (e) { return Response.error(); }
    })());
    return;
  }

  // A file of the shell: from the same saved copy the page came from, so the
  // two are one release. ignoreSearch, because index.html asks for
  // "app.js?v=..." while the copy is saved under the bare path. The network is
  // asked only for a file that is somehow missing, and the answer fills the gap.
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        return OFFLINE_RESPONSE();
      }
    })());
    return;
  }

  // Everything else on this origin (a launch image, say): network first, the
  // cache as a fallback, and a real error response rather than an undefined
  // when neither has it.
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
        const hit = await caches.match(req, {ignoreSearch: true});
        return hit || OFFLINE_RESPONSE();
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
    // The two reminders carry an action button -- Clock Out, and Clock In --
    // and only when they also carry the label to put on it: an action with no
    // title would render as a blank, tappable button.
    actions: ((payload.action === "clock_out" || payload.action === "clock_in") && data.label)
      ? [{ action: payload.action, title: data.label }]
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
  // The clock-in reminder's button: the installed icon's own Clock In
  // shortcut, so it punches at the minute it is pressed. Tapping the
  // notification itself only opens the app.
  if (event.action === "clock_in") {
    url = "./index.html?action=in";
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
