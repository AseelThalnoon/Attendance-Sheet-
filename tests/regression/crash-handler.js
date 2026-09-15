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

  await browser.close();
  server.close();
  console.log(`  crash-handler  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
