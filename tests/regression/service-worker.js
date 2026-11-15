// sw.js run as written, in a vm with a scripted network and an in-memory
// Cache Storage, so its rules can be checked without a browser.
//
// The rules changed on 2026-11-15, on the owner's decision: the worker used to
// ask the network first and fall back to its saved copy after three seconds,
// and now opens the app from the saved copy without asking. What this suite
// holds is everything that trade depends on:
//   * opening the app never waits on the network, slow, fast or absent;
//   * every file of the shell comes from the same saved copy, so a page and
//     its scripts are always one release;
//   * a new release is saved whole or not at all -- a failed or mismatched
//     install leaves the running release's copy exactly as it was;
//   * the new release never takes over by itself, only when a page asks;
//   * and sw.js cannot be left unchanged when the shell changes, which is the
//     only way an installed app ever hears of a release.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..", "..");
const code = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const CACHE_NAME = /const CACHE_NAME = "([^"]+)"/.exec(code)[1];
const BUILD = CACHE_NAME.replace("attendance-ledger-shell-", "");
const BASE = "https://example.test/app/";

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(ok) pass++; else { fail++; failures.push(`${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Relative URLs resolve against the worker's own location, as in a browser.
class SWRequest extends Request {
  constructor(input, init){ super(typeof input === "string" ? new URL(input, BASE).href : input, init); }
}

// What a server holding one release answers. `tag` marks which release, so a
// test can tell a saved file from a freshly fetched one; the page names the
// build the way index.html does.
const release = (tag, build) => async (req) => {
  const p = new URL(req.url).pathname;
  const isPage = p === "/app/" || p === "/app/index.html";
  return new Response(`${tag} ${p}` + (isPage ? ` <script type="module" src="app.js?v=${build || BUILD}"></script>` : ""));
};
const offline = async () => { throw new TypeError("Failed to fetch"); };
const slowly = (ms, inner) => async (req) => { await wait(ms); return inner(req); };

function makeWorker(){
  const handlers = {};
  const stores = new Map();
  let network = release("A");
  const calls = [];
  const href = (req, ignoreSearch) => {
    const u = new URL(typeof req === "string" ? req : req.url, BASE);
    if(ignoreSearch) u.search = "";
    return u.href;
  };
  const cacheFor = (name) => {
    if(!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(req, opts){
        if(m.has(href(req))) return m.get(href(req)).clone();
        if(opts && opts.ignoreSearch){
          for(const [k, v] of m) if(href(k, true) === href(req, true)) return v.clone();
        }
        return undefined;
      },
      async put(req, res){ m.set(href(req), res); },
      // All or nothing, through the network, as the real one is.
      async addAll(reqs){
        const got = await Promise.all(reqs.map(async (r) => {
          const res = await fetchLogged(r);
          if(!res.ok) throw new TypeError("Request failed");
          return [href(r), res];
        }));
        got.forEach(([k, res]) => m.set(k, res));
      },
      async keys(){ return [...m.keys()].map((k) => new Request(k)); },
      async delete(req){ return m.delete(href(req)); },
      size(){ return m.size; },
    };
  };
  const fetchLogged = (req) => { calls.push(new URL(req.url).pathname); return network(req); };
  let skipped = 0;
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      location: new URL("sw.js", BASE),
      skipWaiting(){ skipped++; },
      clients: { claim: async () => {} },
      registration: { scope: BASE },
    },
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (req, opts) => {
        for(const name of stores.keys()){ const hit = await cacheFor(name).match(req, opts); if(hit) return hit; }
        return undefined;
      },
    },
    fetch: (req) => fetchLogged(req),
    setTimeout, clearTimeout, URL, Response, Request: SWRequest, Promise, Set, Map, Error, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // Resolves to null, or to the error the lifecycle step rejected with.
  async function lifecycle(type){
    let done = Promise.resolve();
    handlers[type]({ waitUntil: (p) => { done = p; } });
    try { await done; return null; } catch (e) { return e; }
  }
  // null when the worker leaves the request to the browser.
  async function fetchEvent(url, opts){
    opts = opts || {};
    const request = { url: new URL(url, BASE).href, method: opts.method || "GET", mode: opts.mode || "no-cors" };
    let responded = null;
    handlers.fetch({
      request, clientId: opts.clientId || "", resultingClientId: opts.resultingClientId || "",
      respondWith: (p) => { responded = Promise.resolve(p); },
    });
    if(!responded) return null;
    const res = await responded;
    if(res.type === "error") return "(error)";
    const text = await res.text();
    return res.status === 504 ? "(offline)" : text.replace(/ <script.*$/, "");
  }
  return {
    lifecycle, fetchEvent, stores, cacheFor, calls, handlers,
    setNetwork(fn){ network = fn; },
    skipped: () => skipped,
    message(data){ handlers.message({ data }); },
  };
}

(async () => {
  // ---- Opening the app: the saved copy, and no waiting ------------------------
  {
    const w = makeWorker();
    eq(await w.lifecycle("install"), null, "a release whose files all arrive, and whose page names it, installs");
    // A newer release is out, and the network is slow about it.
    w.setNetwork(slowly(1500, release("B")));
    w.calls.length = 0;
    const started = Date.now();
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p1" }), "A /app/index.html",
      "opening the app is answered from the saved copy");
    const took = Date.now() - started;
    eq(took < 500, true, `at once -- it did not wait on the network (took ${took}ms; the network needed 1500)`);
    eq(w.calls.length, 0, "and the network was not asked at all");
    eq(await w.fetchEvent("./index.html", { mode: "navigate" }), "A /app/index.html",
      "the same by its file name");
    eq(await w.fetchEvent("./index.html?action=in", { mode: "navigate" }), "A /app/index.html",
      "and with a shortcut's ?action= on the address");
    eq(await w.fetchEvent("./index.html?action=out-date&date=2026-11-14", { mode: "navigate" }), "A /app/index.html",
      "or a notification's");
  }

  // ---- One release: the page and every file of it from the same copy ----------
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.setNetwork(release("B"));
    w.calls.length = 0;
    eq(await w.fetchEvent("./app.js?v=" + BUILD, { clientId: "p1" }), "A /app/app.js",
      "app.js comes from the saved copy, not the newer one on the network");
    eq(await w.fetchEvent("./src/schedule.js", { clientId: "p1" }), "A /app/src/schedule.js", "and so do its modules");
    eq(await w.fetchEvent("./theme-boot.js"), "A /app/theme-boot.js", "and the script that sets the theme");
    eq(await w.fetchEvent("./vendor/supabase-js.min.js"), "A /app/vendor/supabase-js.min.js", "and the library");
    eq(await w.fetchEvent("./fonts/Switzer-Bold.woff2"), "A /app/fonts/Switzer-Bold.woff2", "and the fonts");
    eq(await w.fetchEvent("./app.js?v=some-other-label", { clientId: "p9" }), "A /app/app.js",
      "whichever page asks, and whatever label it asks with: one worker serves one release");
    eq(w.calls.length, 0, "none of which touched the network");

    // Offline is the same answers.
    w.setNetwork(offline);
    eq(await w.fetchEvent("./", { mode: "navigate" }), "A /app/index.html", "offline, the app opens from the saved copy");
    eq(await w.fetchEvent("./app.js?v=" + BUILD), "A /app/app.js", "offline, with its scripts");
  }

  // ---- A file that is somehow missing -----------------------------------------
  {
    const w = makeWorker();
    await w.lifecycle("install");
    const shell = w.cacheFor(CACHE_NAME);
    await shell.delete("./theme-boot.js");
    w.setNetwork(release("B"));
    eq(await w.fetchEvent("./theme-boot.js"), "B /app/theme-boot.js", "a shell file the copy has lost is fetched");
    await wait(20);
    eq(((await (await shell.match("./theme-boot.js")).text())), "B /app/theme-boot.js", "and the gap is filled");
    await shell.delete("./theme-boot.js");
    w.setNetwork(offline);
    eq(await w.fetchEvent("./theme-boot.js"), "(offline)", "missing and offline is an honest error response, not a hang");
  }

  // ---- Nothing saved yet -------------------------------------------------------
  {
    const w = makeWorker();
    w.setNetwork(release("B"));
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p3" }), "B /app/",
      "with no saved copy, opening the app goes to the network");
    w.setNetwork(offline);
    eq(await w.fetchEvent("./", { mode: "navigate" }), "(error)", "and with neither, it fails as a failed page load does");
  }

  // ---- What is not the app is left alone ---------------------------------------
  {
    const w = makeWorker();
    await w.lifecycle("install");
    eq(await w.fetchEvent("./README.md", { mode: "navigate" }), null,
      "navigating to some other file under the folder is not answered with the app");
    eq(await w.fetchEvent("./tests/", { mode: "navigate" }), null, "nor is a folder");
    eq(await w.fetchEvent("https://project.supabase.co/rest/v1/entries"), null, "another origin is never touched");
    eq(await w.fetchEvent("./app.js", { method: "POST" }), null, "nor anything that is not a GET");

    // Files outside the shell: network first, kept as they arrive, and the kept
    // copy is the fallback.
    w.setNetwork(release("B"));
    eq(await w.fetchEvent("./splash/1179x2556.png"), "B /app/splash/1179x2556.png", "a file outside the shell comes from the network");
    await wait(20);
    w.setNetwork(offline);
    eq(await w.fetchEvent("./splash/1179x2556.png"), "B /app/splash/1179x2556.png", "and from the copy that kept when offline");
    eq(await w.fetchEvent("./never-seen.png"), "(offline)", "one it never saw is an honest error response");
  }

  // ---- A release is saved whole, and as itself, or not at all -----------------
  {
    // An edge cache a few seconds behind a deploy: the new worker, the old page.
    const w = makeWorker();
    w.setNetwork(release("stale", "v-previous"));
    const err = await w.lifecycle("install");
    eq(!!err && /index\.html is not/.test(String(err.message)), true,
      "a page that names a different build fails the install: " + (err && err.message));
    eq(w.stores.has(CACHE_NAME), false, "and leaves no half-right copy behind to be opened later");

    // One file of twenty does not arrive.
    const w2 = makeWorker();
    w2.setNetwork(async (req) => {
      if(new URL(req.url).pathname.endsWith("/src/time.js")) throw new TypeError("Failed to fetch");
      return release("A")(req);
    });
    eq(!!(await w2.lifecycle("install")), true, "one file failing to arrive fails the install");
    eq(w2.cacheFor(CACHE_NAME).size(), 0, "with nothing saved");

    // And a 404 counts as not arriving.
    const w3 = makeWorker();
    w3.setNetwork(async (req) => new URL(req.url).pathname.endsWith("/manifest.json")
      ? new Response("not found", { status: 404 }) : release("A")(req));
    eq(!!(await w3.lifecycle("install")), true, "a missing file fails the install too");
  }

  // ---- The running release is not disturbed by the next one --------------------
  {
    const w = makeWorker();
    await w.lifecycle("install");
    eq(w.skipped(), 0, "installing does not take over by itself");
    w.message({ type: "something-else" });
    w.message(null);
    eq(w.skipped(), 0, "nor does an unrelated message");
    w.message({ type: "SKIP_WAITING" });
    eq(w.skipped(), 1, "it takes over when a page asks it to");

    // Taking over clears the previous release's copy and keeps people's photos.
    w.cacheFor("attendance-ledger-shell-v1");
    w.cacheFor("attendance-avatars-v1");
    eq(await w.lifecycle("activate"), null, "activating succeeds");
    eq([...w.stores.keys()].sort(), ["attendance-avatars-v1", CACHE_NAME].sort(),
      "activate deletes the old shell and keeps the photo cache");
  }

  // ---- sw.js has to change when the shell does ---------------------------------
  // The one thing all of the above rests on. An installed app learns of a
  // release only by sw.js itself having changed, so sw.js records a
  // fingerprint of the files it saves and this recomputes it. If this fails,
  // a shell file was edited after the release was stamped: run
  //   node tools/stamp-release.mjs
  // which moves the build label on and writes the new fingerprint.
  {
    const { readStamp, shellFiles } = await import(pathToFileURL(path.join(ROOT, "tools", "stamp-release.mjs")).href);
    const stamp = readStamp(ROOT);
    eq(stamp.recorded, stamp.actual,
      `sw.js is stamped for the shell as it is now (release ${stamp.label}) -- if not, run: node tools/stamp-release.mjs`);
    const listed = shellFiles(code);
    eq(listed.length >= 15 && listed.every((f) => fs.existsSync(path.join(ROOT, f))), true,
      "every file sw.js saves exists: " + listed.filter((f) => !fs.existsSync(path.join(ROOT, f))).join(", "));
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    eq(html.includes(`app.js?v=${BUILD}"`), true, "index.html names the same build sw.js checks its saved page for");
    // app.js's own imports must all be saved, or the saved app cannot start.
    const imports = [...fs.readFileSync(path.join(ROOT, "app.js"), "utf8").matchAll(/from\s+"(\.\/src\/[^"]+)"/g)].map((m) => m[1]);
    eq(imports.filter((f) => !listed.includes(f)), [], "every module app.js imports is in the saved shell");
  }

  console.log(`  service-worker  pass ${pass}   fail ${fail}`);
  if(fail){ console.log(failures.map((f) => "    x " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error("service-worker suite crashed:", e); process.exit(1); });
