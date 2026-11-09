// sw.js run as written, in a vm with a scripted network and an in-memory
// Cache Storage, so its fetch rules can be checked without a browser:
//   * opening the app waits NAV_TIMEOUT_MS for the network, then opens the
//     cached shell (it used to wait for as long as the network took);
//   * a page opened from the cache gets its scripts from the same cache, so a
//     cached page never runs a newer release's script;
//   * network answers never overwrite a precached shell file;
//   * a new release's clean-up keeps the photo cache.
// Timers inside the worker run 100x faster (see SCALE), so the 3s wait
// costs 30ms here.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "..", "sw.js"), "utf8");
const CACHE_NAME = /const CACHE_NAME = "([^"]+)"/.exec(code)[1];
// Read from the worker so the test follows any change to it; 3000 if the
// constant is ever renamed, so the checks below still run and say what broke.
const NAV_TIMEOUT_MS = +((/const NAV_TIMEOUT_MS = (\d+)/.exec(code) || [])[1] || 3000);
const SCALE = 0.01;
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

function makeWorker(){
  const handlers = {};
  const stores = new Map();
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
      async addAll(reqs){
        for(const r of reqs) m.set(href(r), new Response("cached " + new URL(r.url).pathname));
      },
      async keys(){ return [...m.keys()].map((k) => new Request(k)); },
      async delete(req){ return m.delete(href(req)); },
    };
  };
  let network = async (req) => new Response("network " + new URL(req.url).pathname);
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      location: new URL("sw.js", BASE),
      skipWaiting(){},
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
    fetch: (req) => network(req),
    setTimeout: (fn, ms) => setTimeout(fn, ms * SCALE),
    clearTimeout, URL, Response, Request: SWRequest, Promise, Set, Map, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  async function lifecycle(type){
    let done;
    handlers[type]({ waitUntil: (p) => { done = p; } });
    await done;
  }
  async function fetchEvent(url, opts){
    opts = opts || {};
    const request = { url: new URL(url, BASE).href, method: "GET", mode: opts.mode || "no-cors" };
    let responded = null;
    handlers.fetch({
      request, clientId: opts.clientId || "", resultingClientId: opts.resultingClientId || "",
      respondWith: (p) => { responded = Promise.resolve(p); },
    });
    if(!responded) return null;
    const res = await responded;
    return res.type === "error" ? "(error)" : await res.text();
  }
  return {
    lifecycle, fetchEvent, stores, cacheFor,
    setNetwork(fn){ network = fn; },
  };
}

const slowly = (ms, body) => async (req) => { await wait(ms); return new Response(body || ("network " + new URL(req.url).pathname)); };
const offline = async () => { throw new TypeError("Failed to fetch"); };
const timeout = NAV_TIMEOUT_MS * SCALE;

(async () => {
  // A fast network still wins, and its page isn't treated as a cached one.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.setNetwork(slowly(1));
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p1" }), "network /app/",
      "opening the app on a good connection uses the network");
    w.setNetwork(slowly(1, "newer app.js"));
    eq(await w.fetchEvent("./app.js?v=v99", { clientId: "p1" }), "newer app.js",
      "that page's scripts come from the network too");
  }

  // Weak signal: the cached shell after NAV_TIMEOUT_MS, and that page stays on
  // the cached scripts even once the network has a newer one.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    // The network takes 1.5s here, against the worker's (scaled) 30ms wait, so
    // the bound below proves the cached page didn't wait for it while leaving
    // a busy machine plenty of room -- a 150ms bound failed under a full run.
    w.setNetwork(slowly(1500));
    const started = Date.now();
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p2" }), "cached /app/index.html",
      "on a slow network, the app opens from the cache");
    const waited = Date.now() - started;
    eq(waited < 750, true, `and it doesn't wait for the slow answer (took ${waited}ms of the network's 1500)`);
    w.setNetwork(slowly(1, "newer app.js"));
    eq(await w.fetchEvent("./app.js?v=v44", { clientId: "p2" }), "cached /app/app.js",
      "a page opened from the cache gets the cached app.js, not a newer release's");
    eq(await w.fetchEvent("./src/schedule.js", { clientId: "p2" }), "cached /app/src/schedule.js",
      "and the cached modules");
    eq(await w.fetchEvent("./not-precached.png", { clientId: "p2" }), "newer app.js",
      "anything the cache doesn't hold still comes from the network");
  }

  // A browser that doesn't report the new page's id: no timeout, so a page and
  // its scripts can't come from two releases.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.setNetwork(slowly(timeout * 3));
    eq(await w.fetchEvent("./", { mode: "navigate" }), "network /app/",
      "without a client id, opening the app waits for the network as before");
  }

  // Slow network and nothing cached yet: keep waiting rather than fail.
  {
    const w = makeWorker();
    w.setNetwork(slowly(timeout * 3));
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p3" }), "network /app/",
      "with no cached shell, a slow network is waited for");
  }

  // Offline: the cached shell, and its scripts from the cache.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.setNetwork(offline);
    eq(await w.fetchEvent("./", { mode: "navigate", resultingClientId: "p4" }), "cached /app/index.html",
      "offline, the app opens from the cache");
    eq(await w.fetchEvent("./app.js?v=v44", { clientId: "p4" }), "cached /app/app.js",
      "offline, app.js comes from the cache");
    eq(await w.fetchEvent("./", { mode: "navigate" }), "cached /app/index.html",
      "offline without a client id: still the cached shell, as before");
  }

  // Network answers fill gaps in the cache but never overwrite the shell.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.setNetwork(slowly(1, "newer"));
    // src/ modules are imported without a version, so they share one cache key
    // with their precached copy: the case where an overwrite could happen.
    eq(await w.fetchEvent("./src/schedule.js", { clientId: "p5" }), "newer",
      "a page from the network gets network files");
    await wait(20);
    const shell = w.cacheFor(CACHE_NAME);
    eq(await (await shell.match("./src/schedule.js")).text(), "cached /app/src/schedule.js",
      "a network answer for a shell file doesn't overwrite the cached copy");
    await w.fetchEvent("./extra.png", { clientId: "p5" });
    await wait(20);
    eq(await (await shell.match("./extra.png")).text(), "newer",
      "a file outside the shell is cached as it arrives");
    await shell.delete("./theme-boot.js");
    await w.fetchEvent("./theme-boot.js", { clientId: "p5" });
    await wait(20);
    eq(await (await shell.match("./theme-boot.js")).text(), "newer",
      "a shell file missing from the cache is filled in");
  }

  // A new release clears old shells but keeps people's photos.
  {
    const w = makeWorker();
    await w.lifecycle("install");
    w.cacheFor("attendance-ledger-shell-v1");
    w.cacheFor("attendance-avatars-v1");
    await w.lifecycle("activate");
    eq([...w.stores.keys()].sort(), ["attendance-avatars-v1", CACHE_NAME].sort(),
      "activate deletes the old shell and keeps the photo cache");
  }

  console.log(`  service-worker  pass ${pass}   fail ${fail}`);
  if(fail){ console.log(failures.map((f) => "    x " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error("service-worker suite crashed:", e); process.exit(1); });
