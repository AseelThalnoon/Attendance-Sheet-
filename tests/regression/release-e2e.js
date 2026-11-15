// One release replacing another, in a real browser with the real service
// worker -- the whole path the other suites cover in pieces.
//
// regression/service-worker.js runs sw.js in a vm with a scripted platform,
// and regression/app-update.js runs the page against a stand-in for the
// service-worker API. Each is exact about its own half and takes the other
// half on trust. This is the two of them together, with nothing stood in for:
// Chromium, service workers allowed, a server whose folder can be swapped for
// the next release's while the app is open.
//
//   1. The published copy is opened. The worker installs and takes the page.
//   2. Opened again: not one request for the app reaches the server.
//   3. The server is switched to a new release. Opened again, the app is
//      still the old release, at once, and still makes no request for itself;
//      the new one is fetched behind it and waits.
//   4. The page says a new version is ready, and Refresh moves onto it.
//   5. With the server gone altogether, the new release still opens.
//
// It runs on the BUILT copy (tools/build.mjs), since that is what a browser
// in the field is given, so it is also the only place the minified worker is
// ever executed as a worker.
require("../no-network");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const { createBackend } = require("../hostile/backend");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Rae Release" });
const seed = () => ({ profiles: [me], entries: D.entriesFor(me.id, 8).map(e => Object.assign(e, { note: "" })),
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2" };

// A static server whose folder can be changed under a running browser, and
// which remembers what it was asked for.
function startServer(){
  const state = { root: null, up: true, log: [] };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      state.log.push(rel);
      if(!state.up){ req.socket.destroy(); return; }
      const file = path.join(state.root, rel === "/" ? "index.html" : rel);
      if(!file.startsWith(state.root)){ res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if(err){ res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ state, url: `http://localhost:${server.address().port}`, close: () => server.close() }));
  });
}

let browser = null, server = null, dirA = null, dirB = null;

(async () => {
  const { build } = await import(pathToFileURL(path.join(ROOT, "tools", "build.mjs")).href);
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-release-a-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-release-b-"));
  const A = (await build(dirA)).label;
  // The next release: the same build under its own label. What differs
  // between two real releases is the files; what this suite needs is that
  // the page and the worker of each agree, and that the two can be told apart.
  const B = A.replace(/-[0-9a-f]{8}$/, "-0000beef");
  fs.cpSync(dirA, dirB, { recursive: true });
  for(const file of ["index.html", "sw.js"]){
    const p = path.join(dirB, file);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").split(A).join(B));
  }

  server = await startServer();
  server.state.root = dirA;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  // No push in this browser, so the app has no notifications question to ask
  // once its worker is up (a headless browser reports them blocked).
  await page.addInitScript(() => { try { delete window.PushManager; } catch (e) {} });
  const backend = createBackend(seed());
  await backend.install(page, me.id);

  const APP = server.url + "/index.html";
  const appUp = () => page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 20000 });
  const label = () => page.evaluate(() => new URL(document.querySelector('script[type="module"]').src).searchParams.get("v"));
  const worker = () => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { controlled: !!navigator.serviceWorker.controller, waiting: !!(reg && reg.waiting),
      active: !!(reg && reg.active), caches: (await caches.keys()).sort() };
  });
  const appRequests = () => server.state.log.filter(p => p !== "/sw.js");
  const toasts = () => page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()));

  // ---- 1. First visit ----------------------------------------------------------
  await page.goto(APP);
  await appUp();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  let w = await worker();
  ok(await label() === A, "the published copy opens as release " + A, await label());
  ok(w.controlled && w.active && !w.waiting, "its worker installs and takes the page", JSON.stringify(w));
  ok(w.caches.includes("attendance-ledger-shell-" + A), "and has saved the shell under that release's name", w.caches.join(", "));

  // ---- 2. Opened again: nothing is asked of the server -------------------------
  server.state.log.length = 0;
  let started = Date.now();
  await page.goto(APP);
  await appUp();
  ok(appRequests().length === 0, "opening the app again makes no request for the app at all",
    appRequests().slice(0, 6).join(", "));
  ok(await label() === A, "(still " + A + ")");

  // ---- 3. A new release is published -------------------------------------------
  server.state.root = dirB;
  server.state.log.length = 0;
  await page.goto(APP);
  await appUp();
  ok(await label() === A, "with a new release on the server, the app still opens as the one it has", await label());
  // Polled from here, not with waitForFunction: that takes an async
  // predicate's promise for a truthy answer and returns at once. The browser
  // leaves a second or so after a navigation before it looks for a new worker.
  for(let i = 0; i < 80; i++){
    w = await worker();
    if(w.waiting) break;
    await page.waitForTimeout(250);
  }
  ok(w.waiting && w.controlled, "the new one is fetched behind it and waits", JSON.stringify(w));
  ok(w.caches.includes("attendance-ledger-shell-" + A) && w.caches.includes("attendance-ledger-shell-" + B),
    "saved beside the running release's copy, not over it", w.caches.join(", "));
  ok(await label() === A, "and the open page has not been touched");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some(t => /new version/i.test(t.textContent)),
    null, { timeout: 10000 }).catch(() => {});
  ok(/new version/i.test((await toasts()).join(" ")), "the page says a new version is ready", (await toasts()).join(" | "));

  // ---- 4. Refresh moves onto it -------------------------------------------------
  await page.evaluate(() => { window.__before = true; });
  await page.click("#refreshBtn");
  await page.waitForFunction(() => window.__before !== true, null, { timeout: 20000 });
  await appUp();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  ok(await label() === B, "Refresh reloads the app as release " + B, await label());
  w = await worker();
  ok(!w.waiting && w.controlled, "nothing is left waiting", JSON.stringify(w));
  ok(!w.caches.includes("attendance-ledger-shell-" + A) && w.caches.includes("attendance-ledger-shell-" + B),
    "and the previous release's copy is gone", w.caches.join(", "));

  // ---- 5. No server at all ------------------------------------------------------
  server.state.up = false;
  server.state.log.length = 0;
  await page.goto(APP);
  await page.waitForSelector("#authScreen, #appShell", { state: "attached", timeout: 20000 });
  await page.waitForFunction(() => document.title.length > 0 && !!document.getElementById("signInBtn"), null, { timeout: 20000 });
  ok(await label() === B, "with the server unreachable, the app still opens, as " + B, await label());
  const booted = await page.evaluate(() => {
    const warn = document.getElementById("authConfigWarning");
    return { failure: !!warn && warn.style.display === "block" && /Couldn't load the application/.test(warn.textContent),
      palette: document.documentElement.getAttribute("data-palette") };
  });
  ok(!booted.failure && !!booted.palette, "and its scripts ran from the saved copy (no \"couldn't load the application\")",
    JSON.stringify(booted));

  ok(errors.length === 0, "no script errors along the way", errors.join(" | "));
})().catch(err => { fail++; failures.push("suite threw: " + (err && err.stack || err)); })
  .finally(async () => {
    if(browser) await browser.close().catch(() => {});
    if(server) server.close();
    for(const d of [dirA, dirB]){ if(d) fs.rmSync(d, { recursive: true, force: true }); }
    console.log(`  release-e2e  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
