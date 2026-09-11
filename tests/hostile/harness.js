// Boots the real application, signed in, against a scripted backend.
const playwright = require("playwright");
const { chromium } = playwright;
const { start } = require("./server");
const { createBackend } = require("./backend");

const DESKTOP = { width: 1440, height: 900 };
const PHONE   = { width: 393, height: 852 };

// opts.engine picks the browser ("chromium" by default, "webkit" for Safari's
// actual engine) and opts.device takes a Playwright device descriptor --
// devices["iPhone 15 Pro"] and friends, which carry the viewport, DPR, touch
// flags and user agent together. Neither is set by any existing caller, so
// every suite that predates them keeps the Chromium/viewport behaviour it had.
async function boot(opts){
  opts = opts || {};
  const server = await start();
  const engine = playwright[opts.engine || "chromium"];
  if(!engine) throw new Error("unknown engine: " + opts.engine);
  const browser = await engine.launch();
  const context = await browser.newContext(opts.device ? Object.assign({}, opts.device) : {
    viewport: opts.viewport || DESKTOP,
    deviceScaleFactor: opts.viewport === PHONE ? 3 : 1,
    isMobile: opts.viewport === PHONE,
    hasTouch: opts.viewport === PHONE
  });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  page.on("console", m => { if(m.type() === "error") errors.push("console: " + m.text()); });

  const backend = createBackend(opts.seed || {});
  await backend.install(page, opts.meId);
  if(opts.beforeLoad) await opts.beforeLoad({ page, backend });

  await page.goto(server.url + "/index.html");
  if(opts.waitForApp !== false) await page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
  await settle(page);

  return {
    page, backend, errors,
    async close(){ await browser.close(); server.close(); }
  };
}

// The app renders synchronously off state it already holds, so a frame plus a
// beat is enough; there is no spinner to wait on once the fetches have landed.
async function settle(page, ms){
  await page.waitForTimeout(ms == null ? 350 : ms);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// The tab strip is in the DOM but never visible — the rail and the bottom nav
// are the two real surfaces, and both click through it. Drive whichever is on
// screen so the test exercises the path a person actually takes.
async function goTab(page, tab){
  await page.evaluate(name => {
    // Admin is a rail-item keyed by data-rail-action, not data-rail-tab (it
    // opens a panel rather than switching the active tab-strip entry), with
    // #adminBtn in the header as the sub-760px fallback once the rail is gone.
    if(name === "admin"){
      const railAdmin = document.getElementById("railAdminBtn");
      if(railAdmin && railAdmin.getClientRects().length) return railAdmin.click();
      const admin = document.getElementById("adminBtn");
      if(admin && admin.getClientRects().length) return admin.click();
      throw new Error("no nav control for tab admin (not an admin, or button hidden)");
    }
    const rail = document.querySelector(`.rail-item[data-rail-tab="${name}"]`);
    if(rail && rail.getClientRects().length) return rail.click();
    const bn = document.querySelector(`.bn-item[data-bn-tab="${name}"]`);
    if(bn && bn.getClientRects().length) return bn.click();
    const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    if(!btn) throw new Error("no nav control for tab " + name);
    btn.click();
  }, tab);
  await settle(page);
}

module.exports = { boot, settle, goTab, DESKTOP, PHONE };
