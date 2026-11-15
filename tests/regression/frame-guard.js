// The app inside somebody else's page, and the few lines of <head> that speak
// for it before any script runs.
//
// Clickjacking is normally answered by a response header, and this app's host
// cannot send one. theme-boot.js answers it from the page instead: a copy that
// finds itself in a frame marks itself, draws nothing, and app.js declines to
// start. What is checked here is that it holds where it has to (another site,
// and another page on this same origin), that it leaves an ordinary visit
// alone, and that it lets a frame on this machine through, where previews and
// design tools live.
//
// The app is opened under made-up hostnames, mapped to this machine by the
// browser's own resolver, because the guard deliberately steps aside for
// localhost and that is the only name a test server otherwise has.
require("../no-network");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { start } = require("../hostile/server");
const { createBackend } = require("../hostile/backend");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const admin = D.profile(1, { full_name: "Ada Admin", role: "admin" });
const seed = () => ({ profiles: [admin], entries: D.entriesFor(admin.id, 5).map(e => Object.assign(e, { note: "" })),
  user_settings: [{ user_id: admin.id, settings: D.SETTINGS }] });
const settle = (page, ms) => page.waitForTimeout(ms == null ? 1200 : ms);

let browser = null, server = null;
const HOLDER_DIR = path.join(__dirname, "frame-holder");

// A signed-in administrator's browser, with the scripted backend behind it.
async function open(){
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const backend = createBackend(seed());
  await backend.install(page, admin.id);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  return { page, backend, errors, close: () => context.close() };
}
const inspect = frame => frame.evaluate(() => ({
  framed: document.documentElement.hasAttribute("data-framed"),
  bodyDisplay: getComputedStyle(document.body).display,
  appShown: document.getElementById("appShell").style.display !== "none",
  palette: document.documentElement.getAttribute("data-palette"),
  clickable: !!document.elementFromPoint(200, 200)
}));
const backendCalls = h => h.backend.state.log.length;

(async () => {
  server = await start();
  const port = new URL(server.url).port;
  browser = await chromium.launch({ args: [
    "--host-resolver-rules=MAP app.test 127.0.0.1, MAP other.test 127.0.0.1" ] });
  const APP = `http://app.test:${port}/index.html`;
  const LOCAL = `http://127.0.0.1:${port}/index.html`;
  // The page doing the framing. A real file from the same test server rather
  // than a scripted response: Chromium refuses to let a page it cannot place
  // on the local network frame one that is (ERR_BLOCKED_BY_LOCAL_NETWORK_
  // ACCESS_CHECKS), and a scripted response has no address to place. Named
  // harness.html so the repository's ignore rule for generated test pages
  // already covers it; in a folder of its own because suites run side by side.
  fs.mkdirSync(HOLDER_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOLDER_DIR, "harness.html"), `<!doctype html><title>holder</title>
<body style="margin:0"><iframe id="f" style="width:1000px;height:700px;border:0"></iframe>
<script>document.getElementById("f").src = new URLSearchParams(location.search).get("src");</script>`);
  const holder = (host, src) => `http://${host}:${port}/tests/regression/frame-holder/harness.html?src=${encodeURIComponent(src)}`;

  // ---- An ordinary visit is left alone ----------------------------------------
  {
    const h = await open();
    await h.page.goto(APP);
    await h.page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
    const v = await inspect(h.page.mainFrame());
    ok(!v.framed && v.appShown && v.bodyDisplay !== "none" && v.palette,
      "opened as its own page, the app starts as it always did", JSON.stringify(v));
    ok(backendCalls(h) > 0, "(and talks to its backend)");
    await h.close();
  }

  // ---- Inside another site's page ---------------------------------------------
  {
    const h = await open();
    await h.page.goto(holder("other.test", APP));
    await settle(h.page, 1800);
    const frame = h.page.frames().find(f => f.url() === APP);
    ok(!!frame, "(the other site did load the app in its frame)");
    const v = await inspect(frame);
    ok(v.framed, "framed by another site: the page marks itself", JSON.stringify(v));
    ok(v.bodyDisplay === "none" && !v.appShown, "and draws nothing at all", JSON.stringify(v));
    ok(backendCalls(h) === 0, "no session is restored and no request is made from it",
      JSON.stringify(h.backend.state.log.slice(0, 4)));
    const listeners = await frame.evaluate(() => {
      // Sign In is the first thing a hidden copy would otherwise have wired.
      const btn = document.getElementById("signInBtn");
      return { disabled: btn.disabled, text: btn.textContent };
    });
    ok(listeners.text === "Sign In" && !listeners.disabled, "app.js never ran: the form is as the markup left it",
      JSON.stringify(listeners));
    await h.close();
  }

  // ---- Inside another page on this same origin --------------------------------
  // A github.io address is shared by every project the account publishes, and
  // the browser's own protection for framed pages (separate storage) does not
  // apply between pages of one origin.
  {
    const h = await open();
    await h.page.goto(holder("app.test", APP));
    await settle(h.page, 1800);
    const frame = h.page.frames().find(f => f.url() === APP);
    const v = frame ? await inspect(frame) : null;
    ok(v && v.framed && v.bodyDisplay === "none" && !v.appShown,
      "framed by a page on its own origin: refused just the same", JSON.stringify(v));
    ok(backendCalls(h) === 0, "and silent just the same");
    await h.close();
  }

  // ---- A frame on this machine is let through ----------------------------------
  {
    const h = await open();
    await h.page.goto(holder("127.0.0.1", LOCAL));
    const frame = await (async () => {
      for(let i = 0; i < 40; i++){
        const f = h.page.frames().find(x => x.url() === LOCAL);
        if(f) return f;
        await h.page.waitForTimeout(100);
      }
      return null;
    })();
    await frame.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
    const v = await inspect(frame);
    ok(!v.framed && v.appShown, "a local preview that frames the app still works", JSON.stringify(v));
    await h.close();
  }

  // ---- What the page says before any script runs -------------------------------
  {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(APP);
    const head = await page.$$eval("meta", ms => {
      const get = (attr, name) => (ms.find(m => m.getAttribute(attr) === name) || { content: "" }).content;
      return { description: get("name", "description"), robots: get("name", "robots"),
        ogTitle: get("property", "og:title"), ogImage: get("property", "og:image"), ogDesc: get("property", "og:description") };
    });
    ok(head.description.length >= 50 && head.description.length <= 160,
      "the page describes itself, at a length a preview shows whole", `${head.description.length}: ${head.description}`);
    ok(/noindex/.test(head.robots), "and asks search engines to leave an internal tool out", head.robots);
    ok(head.ogTitle && head.ogDesc && /^https:\/\/.+\.png$/.test(head.ogImage),
      "a shared link has a title, a sentence and an absolute image address", JSON.stringify(head));
    const icon = new URL(head.ogImage).pathname.split("/").pop();
    ok(fs.existsSync(path.join(__dirname, "..", "..", icon)),
      "the image it names is a file that ships", icon);

    const notice = await page.evaluate(() => {
      const el = [...document.querySelectorAll("noscript")].map(n => n.textContent).join(" ");
      return el;
    });
    ok(/JavaScript/.test(notice), "with scripts off, the sign-in screen says why nothing will happen", notice.trim().slice(0, 120));
    // Measured, not found by its text: Playwright's text matching skips what
    // is inside <noscript>, even in a browser that is rendering it.
    const box = await page.evaluate(() => {
      const el = document.querySelector("noscript .auth-config-warning");
      if(!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, display: getComputedStyle(el).display, top: r.top, viewport: innerHeight };
    });
    ok(box && box.w > 200 && box.h > 20 && box.display !== "none" && box.top >= 0 && box.top < box.viewport,
      "and the notice is actually on screen, not just in the markup", JSON.stringify(box));
    await context.close();
  }

  console.log(`  frame-guard  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exitCode = 1; }
})().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    if(browser) await browser.close().catch(() => {});
    if(server) server.close();
    fs.rmSync(HOLDER_DIR, { recursive: true, force: true });
  });
