// The global crash handler (app.js, "CRASH REPORTING") is the one piece of
// this app whose whole job is to work when the rest of it does not, so reading
// the source proves nothing useful: what matters is whether a real browser
// raising a real ErrorEvent puts a real banner on a real page. Every check
// below drives the actual listeners registered at module scope.
//
// The four negative cases are the ones worth keeping. A handler that shouts on
// every event is worse than no handler at all — people learn to dismiss it, and
// then it is not there for the crash that mattered. So: ResizeObserver's
// harmless loop notice, a missing image, a second copy of a failure already on
// screen, and anything at all while offline must all stay quiet.
// Answers anything this suite does not route itself to *.supabase.co, so a
// direct run never reaches the live project (it did, until 2026-11-08).
require("../no-network");
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8955;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json",
  ".png":"image/png", ".css":"text/css", ".woff2":"font/woff2"};

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; return; }
  fail++;
  failures.push(name + (detail ? "  [" + detail + "]" : ""));
}

// Every case wants a page that has finished booting but has not yet crashed,
// and several want their own console log, so this is the unit of the suite.
async function freshPage(browser){
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const logs = [];
  page.on("console", m => logs.push(m.text()));
  await page.goto(`http://localhost:${PORT}/index.html`);
  // The banner is raised from a listener, not from render, so waiting on the
  // app's own readiness would be waiting for the wrong thing. Settling the
  // module's top-level await is enough.
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForTimeout(400);
  return { page, logs };
}

const banners = page => page.locator(".crash-notice").count();

(async () => {
  const server = http.createServer((req, res) => {
    let u = req.url.split("?")[0];
    if(u === "/") u = "/index.html";
    const f = path.join(ROOT, u);
    if(!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"content-type": MIME[path.extname(f)] || "text/plain"});
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();

  // ---- An uncaught exception is announced, once, with a way out ----
  {
    const { page, logs } = await freshPage(browser);
    ok(await banners(page) === 0, "a clean load raises no crash banner");

    // setTimeout rather than a bare throw: this has to reach window.onerror
    // the way a failure inside a render or a click handler would, not be
    // caught by the evaluate() call's own promise.
    await page.evaluate(() => { setTimeout(() => { throw new Error("boom-sync"); }, 0); });
    await page.waitForTimeout(250);

    ok(await banners(page) === 1, "an uncaught error raises the crash banner");
    ok(await page.locator('.crash-notice[role="alert"]').count() === 1,
      "the banner is role=alert, so a screen reader is told too");
    ok((await page.locator(".crash-notice .crash-notice-btn").innerText()).trim() === "Reload",
      "the banner offers a way out, not just bad news");
    ok(logs.some(l => l.includes("[crash]") && l.includes("error")),
      "the crash reaches the console whatever the network is doing");

    // A render that throws every frame must not paper the screen in banners.
    await page.evaluate(() => { setTimeout(() => { throw new Error("boom-two"); }, 0); });
    await page.waitForTimeout(250);
    ok(await banners(page) === 1, "a second failure does not stack a second banner");

    await page.locator(".crash-notice .crash-notice-close").click();
    await page.waitForTimeout(150);
    ok(await banners(page) === 0, "the banner can be dismissed");
    await page.close();
  }

  // ---- A rejected promise is a crash too ----
  {
    const { page, logs } = await freshPage(browser);
    await page.evaluate(() => { Promise.reject(new Error("rejected-boom")); });
    await page.waitForTimeout(250);
    ok(await banners(page) === 1, "an unhandled rejection raises the banner");
    ok(logs.some(l => l.includes("unhandledrejection")),
      "an unhandled rejection is recorded as its own kind, not as an error");
    await page.close();
  }

  // ---- The quiet cases ----
  {
    const { page } = await freshPage(browser);

    // Browsers fire this as a genuine ErrorEvent, in bursts, and it means
    // nothing. Banner it and the app cries wolf at its own layout.
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error",
        {message: "ResizeObserver loop completed with undelivered notifications."}));
    });
    await page.waitForTimeout(200);
    ok(await banners(page) === 0, "ResizeObserver's loop notice is not treated as a crash");

    // Shares the event name with a real exception but not the meaning: a
    // missing asset is a bad deploy or a stale shell, not broken code.
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "/definitely-missing-" + Date.now() + ".png";
      document.body.appendChild(img);
    });
    await page.waitForTimeout(400);
    ok(await banners(page) === 0, "a missing asset is recorded without alarming anyone");
    await page.close();
  }

  {
    const { page } = await freshPage(browser);
    // Offline already has its own vocabulary here — the outbox queues the
    // punch and the notice panel explains it. A crash banner on top of that
    // is both wrong and a second message about the same thing.
    await page.context().setOffline(true);
    await page.evaluate(() => { setTimeout(() => { throw new Error("offline-boom"); }, 0); });
    await page.waitForTimeout(250);
    ok(await banners(page) === 0, "being offline does not masquerade as a crash");
    await page.close();
  }

  // ---- One build label, and every report carries it ----
  // index.html loads app.js?v=<label> and the crash reporter reads the label
  // back off its own URL. It sat at "primary-invert-1" for 67 commits, so
  // every report named the same build and a fresh page could be handed a
  // weeks-old cached script under an unchanged URL. It is now the service
  // worker's cache version, which is bumped every release; this keeps them
  // from drifting apart again.
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const label = (html.match(/src="app\.js\?v=([^"]+)"/) || [])[1];
  const cacheSuffix = (sw.match(/const CACHE_NAME = "attendance-ledger-shell-([^"]+)";/) || [])[1];
  ok(label && cacheSuffix && label === cacheSuffix,
    "app.js?v= in index.html is the service worker's cache version",
    `index.html ?v=${label}, sw.js CACHE_NAME suffix ${cacheSuffix}`);

  // ---- A page missing an element still starts ----
  // 2026-11-03: a browser paired a new index.html with a cached app.js from
  // before #backupNowBtn was removed. The script's top-level
  // getElementById("backupNowBtn").addEventListener threw, and since it threw
  // at the top of the app's one big function, nothing after it ran — eleven
  // dead boots. The same stale pairing is replayed here with
  // #forgotPasswordBtn, which is wired midway through startup.
  {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    const reports = [];
    await page.route(/supabase\.co\/rest\/v1\/client_errors/, route => {
      reports.push(JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({status: 201, contentType: "application/json", body: ""});
    });
    await page.route(/\/index\.html$/, async route => {
      const res = await route.fetch();
      const body = (await res.text()).replace('id="forgotPasswordBtn"', 'id="forgotPasswordBtnRemoved"');
      return route.fulfill({response: res, body});
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => document.readyState === "complete");
    await page.waitForTimeout(900);

    const after = await page.evaluate(() => ({
      copyright: document.getElementById("copyrightLineAuth").textContent.trim(),
      signIn: !!document.getElementById("signInForm").getClientRects().length
    }));
    ok(after.copyright.length > 0,
      "startup runs to the end even though an element it wires is missing",
      "#copyrightLineAuth is still empty: startup stopped where the element was missing");
    ok(after.signIn, "and the sign-in screen is up");
    ok(await banners(page) === 1, "the person is told something is off, with a reload");
    const report = reports.find(r => /out of step/i.test(r.message || ""));
    ok(report && /#forgotPasswordBtn\b/.test(report.message),
      "one report names the missing element", JSON.stringify(reports.map(r => r.message)));
    ok(report && report.build === label,
      "and carries the build label, so it can be traced to a release", report && report.build);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`  crash-handler  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
