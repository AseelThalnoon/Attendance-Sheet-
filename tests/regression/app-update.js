// How a new release reaches a page that is already open.
//
// The service worker opens the app from its saved copy and holds a new release
// beside it until a page asks for it (sw.js; held in regression/service-
// worker.js). This is the page's half: noticing that one is waiting, and
// choosing the moment to reload onto it. The moment is the whole design --
//   * never underneath someone in the middle of something;
//   * never on a password-reset link, where a reload would sign the visitor in
//     on their old password;
//   * never twice in a row, whatever the worker does;
//   * and otherwise as soon as it costs them nothing: at launch, on coming
//     back after a break, on Refresh, on the way out of an account.
//
// The browser's service-worker API is stood in for, so the test decides when
// a release is found, when it takes over, and whether it ever does. Its state
// lives in sessionStorage because the thing under test is a reload.
const { boot, settle, goTab, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Una Update", role: "admin" });
const seed = () => ({ profiles: [me], entries: D.entriesFor(me.id, 12).map(e => Object.assign(e, { note: "" })),
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] });

// cfg.controller: a worker was already serving this page when it loaded.
// cfg.waiting: a new release was already saved and waiting at that point.
// cfg.stubborn: the waiting worker never takes over, whatever it is told.
const fakeWorker = cfg => async ({ page }) => {
  await page.addInitScript(cfg => {
    const KEY = "__fakeSW";
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null") ||
      { loads: 0, posted: 0, waiting: !!cfg.waiting, controller: !!cfg.controller, updates: 0 };
    saved.loads++;
    const save = () => sessionStorage.setItem(KEY, JSON.stringify(saved));
    save();

    // A clock the test can move, for "came back after a while".
    const realNow = Date.now.bind(Date);
    window.__skewMs = 0;
    Date.now = () => realNow() + window.__skewMs;

    const pageListeners = {}, regListeners = {};
    const makeWorker = state => {
      const l = {};
      return { state, postMessage(m){ if(m && m.type === "SKIP_WAITING"){ saved.posted++; save(); } },
        addEventListener(type, fn){ l[type] = fn; }, fire(type){ if(l[type]) l[type](); } };
    };
    const reg = {
      waiting: saved.waiting ? makeWorker("installed") : null, installing: null,
      update: async () => { saved.updates++; save(); },
      addEventListener(type, fn){ regListeners[type] = fn; },
      pushManager: { getSubscription: async () => null }
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      get controller(){ return saved.controller ? {} : null; },
      // Never ready, as with service workers blocked: keeps the notifications
      // question off the screen, which is not what this suite is about.
      ready: new Promise(() => {}),
      register: () => Promise.resolve(reg), getRegistration: () => Promise.resolve(reg),
      getRegistrations: () => Promise.resolve([reg]),
      addEventListener(type, fn){ pageListeners[type] = fn; }, removeEventListener(){}
    } });
    window.__sw = {
      state: () => JSON.parse(sessionStorage.getItem(KEY)),
      // The browser found a new sw.js and has finished saving its shell.
      updateFound(){
        const w = makeWorker("installing");
        reg.installing = w;
        if(regListeners.updatefound) regListeners.updatefound();
        w.state = "installed"; reg.installing = null; reg.waiting = w;
        saved.waiting = true; save();
        w.fire("statechange");
      },
      // The new worker takes over this page (because it was told to, or
      // because another tab told it to).
      takeOver(){
        if(cfg.stubborn) return;
        reg.waiting = null; saved.waiting = false; saved.controller = true; save();
        if(pageListeners.controllerchange) pageListeners.controllerchange();
      }
    };
  }, cfg);
};

const sw = page => page.evaluate(() => window.__sw.state());
const toasts = page => page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()));
const clearToasts = page => page.evaluate(() => document.querySelectorAll(".toast").forEach(t => t.remove()));
const activeTab = page => page.evaluate(() => [...document.querySelectorAll(".tab-panel.active")].map(p => p.id).join());
const appShown = page => page.evaluate(() => document.getElementById("appShell").style.display !== "none");
// Out of sight for `minutes`, then back.
const awayFor = (page, minutes) => page.evaluate(m => {
  const set = v => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  set("hidden"); document.dispatchEvent(new Event("visibilitychange"));
  window.__skewMs += m * 60000;
  set("visible"); document.dispatchEvent(new Event("visibilitychange"));
}, minutes);
const untilLoads = (page, n) => page.waitForFunction(n => window.__sw && window.__sw.state().loads >= n, n, { timeout: 15000 });
const untilApp = page => page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });

const open = new Set();
async function start(opts){
  const h = await boot(opts);
  open.add(h);
  const close = h.close;
  h.close = async () => { open.delete(h); await close(); };
  return h;
}

(async () => {
  // ---- A release arrives while the app is in use ------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), beforeLoad: fakeWorker({ controller: true }) });
    await goTab(h.page, "log");
    await h.page.evaluate(() => window.__sw.updateFound());
    await settle(h.page, 400);
    let said = (await toasts(h.page)).join(" | ");
    ok(/new version/i.test(said), "a release saved in the background is announced", said);
    let s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1, "and nothing is reloaded under the person using the app", JSON.stringify(s));
    await clearToasts(h.page);

    await awayFor(h.page, 1);
    await settle(h.page, 300);
    ok((await sw(h.page)).posted === 0, "back after a minute: left alone");

    // Something open: the Settings form.
    await goTab(h.page, "settings");
    await h.page.click("#cnav-hours");
    await h.page.fill("#sLeaveDays", "25");
    await awayFor(h.page, 6);
    await settle(h.page, 300);
    s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1, "back after six minutes with Settings open: still left alone", JSON.stringify(s));
    ok(await h.page.evaluate(() => document.getElementById("sLeaveDays").value) === "25", "and what was typed is still there");

    // The Admin screen holds half-written messages; a reload would lose them.
    await goTab(h.page, "admin");
    await awayFor(h.page, 6);
    await settle(h.page, 300);
    ok((await sw(h.page)).posted === 0, "nor with the Admin screen open");

    // Nothing open: this is the moment.
    await goTab(h.page, "log");
    await awayFor(h.page, 6);
    await settle(h.page, 300);
    s = await sw(h.page);
    ok(s.posted === 1, "back after six minutes with nothing open: the page asks the new release to take over", JSON.stringify(s));
    ok(s.loads === 1, "and waits for it to do so before reloading");
    await h.page.evaluate(() => window.__sw.takeOver());
    await untilLoads(h.page, 2);
    await untilApp(h.page);
    await settle(h.page, 900);
    s = await sw(h.page);
    ok(s.loads === 2 && s.posted === 1, "then reloads, once", JSON.stringify(s));
    ok(await activeTab(h.page) === "tab-log", "and comes back on the tab they were reading, not on Overview", await activeTab(h.page));
    ok((await toasts(h.page)).filter(t => /new version/i.test(t)).length === 0, "with nothing left to announce");
    ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Refresh is asking for it -----------------------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), beforeLoad: fakeWorker({ controller: true }) });
    await h.page.click("#refreshBtn");
    await settle(h.page, 900);
    let s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1 && /Up to date/.test((await toasts(h.page)).join(" ")),
      "(with no release waiting, Refresh is the ordinary refresh)", JSON.stringify(s));
    await h.page.evaluate(() => window.__sw.updateFound());
    await settle(h.page, 200);
    await h.page.click("#refreshBtn");
    await settle(h.page, 300);
    ok((await sw(h.page)).posted === 1, "with one waiting, Refresh takes it");
    await h.page.evaluate(() => window.__sw.takeOver());
    await untilLoads(h.page, 2);
    await untilApp(h.page);
    ok((await sw(h.page)).loads === 2, "and the page reloads onto it");
    await h.close();
  }

  // ---- Already waiting when the app is opened ----------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), waitForApp: false,
      beforeLoad: fakeWorker({ controller: true, waiting: true }) });
    await h.page.waitForFunction(() => window.__sw && window.__sw.state().posted === 1, null, { timeout: 15000 });
    ok(true, "a release that was waiting at launch is taken straight away, before anyone has touched the page");
    // Before anything else starts, not once the page has loaded: the live logs
    // had an iPhone draw the app, renew its sign-in and send its first two
    // dozen requests, and then reload and do all of it again.
    const before = await h.page.evaluate(() => document.getElementById("appShell").style.display === "block");
    ok(!before && h.backend.state.log.length === 0,
      "and taken before the app draws or asks the server for anything",
      JSON.stringify({ drawn: before, requests: h.backend.state.log.map(r => r.path) }));
    await h.page.evaluate(() => window.__sw.takeOver());
    await untilLoads(h.page, 2);
    await untilApp(h.page);
    await settle(h.page, 600);
    const s = await sw(h.page);
    ok(s.loads === 2 && s.posted === 1, "one reload, and the app is up on the new release", JSON.stringify(s));
    await h.close();
  }

  // ---- A worker that will not take over ----------------------------------------
  // The page asks at launch and nothing answers. Reloading would only come
  // back to the same release, so the app starts on the one it has -- and must
  // not ask again, nor fall back to a reload, on the way.
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), waitForApp: false,
      beforeLoad: fakeWorker({ controller: true, waiting: true, stubborn: true }) });
    await untilApp(h.page);
    await settle(h.page, 5200);     // past the point the old 4s fallback reload would have fired
    const s = await sw(h.page);
    ok(s.loads === 1 && s.posted === 1, "a release that never takes over costs a moment's wait, not a reload or a loop", JSON.stringify(s));
    ok(await appShown(h.page), "and the app is usable on the release it has");
    await h.close();
  }

  // ---- A password-reset link is never reloaded ---------------------------------
  // supabase-js has taken the token out of the address by the time the page
  // has loaded. Reload now and the visitor is signed in on their OLD password.
  {
    const RECOVERY = "#access_token=test-access-token&expires_in=3600" +
                     "&refresh_token=test-refresh-token&token_type=bearer&type=recovery";
    const h = await start({ viewport: DESKTOP, seed: seed(), signedOut: true, waitForApp: false, hash: RECOVERY,
      beforeLoad: fakeWorker({ controller: true, waiting: true }) });
    await settle(h.page, 1500);
    let s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1, "arriving on a reset link with a release waiting: no reload at launch", JSON.stringify(s));
    const reset = await h.page.evaluate(() => !!document.getElementById("resetPasswordForm").getClientRects().length);
    ok(reset, "the new-password form is on screen");
    await awayFor(h.page, 10);
    await settle(h.page, 400);
    s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1, "and none on coming back to it, however long it has been", JSON.stringify(s));
    await h.close();
  }

  // ---- The sign-in screen ------------------------------------------------------
  {
    const h = await start({ viewport: DESKTOP, seed: seed(), signedOut: true, waitForApp: false,
      beforeLoad: fakeWorker({ controller: true }) });
    await h.page.waitForSelector("#authScreen");
    await settle(h.page, 600);
    await h.page.evaluate(() => window.__sw.updateFound());
    await settle(h.page, 300);
    ok((await toasts(h.page)).length === 0, "signed out, a waiting release is not announced (there is no Refresh to point at)");
    await h.page.fill("#siEmail", "someone@example.com");
    await awayFor(h.page, 1);
    await settle(h.page, 300);
    ok((await sw(h.page)).posted === 0, "with an address typed in, the sign-in screen is not reloaded");
    await h.page.fill("#siEmail", "");
    await h.page.evaluate(() => document.activeElement && document.activeElement.blur());
    await awayFor(h.page, 1);
    await settle(h.page, 300);
    ok((await sw(h.page)).posted === 1, "empty and untouched, it takes the release at the next glance");
    await h.close();
  }

  // ---- What is not an update ---------------------------------------------------
  {
    // The first worker a browser ever installs "takes control" too.
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), beforeLoad: fakeWorker({ controller: false }) });
    await h.page.evaluate(() => window.__sw.takeOver());
    await settle(h.page, 400);
    let s = await sw(h.page);
    ok(s.loads === 1 && (await toasts(h.page)).length === 0, "a first install taking control is not announced and reloads nothing", JSON.stringify(s));
    await awayFor(h.page, 6);
    await settle(h.page, 400);
    s = await sw(h.page);
    ok(s.posted === 0 && s.loads === 1, "and is not mistaken for a waiting release later");
    ok(s.updates >= 1, "coming back does ask the browser to look for a new release", "update() calls: " + s.updates);
    await h.close();
  }

  // ---- Another tab asked first --------------------------------------------------
  // The new worker is in charge of this page without this page having asked.
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed(), beforeLoad: fakeWorker({ controller: true }) });
    await goTab(h.page, "recap");
    await h.page.evaluate(() => window.__sw.takeOver());
    await settle(h.page, 400);
    let s = await sw(h.page);
    ok(s.loads === 1, "taken over from another tab: this page is not reloaded on the spot", JSON.stringify(s));
    ok(/new version/i.test((await toasts(h.page)).join(" ")), "it says a new version is ready");
    await awayFor(h.page, 6);
    await untilLoads(h.page, 2);
    await untilApp(h.page);
    await settle(h.page, 900);
    s = await sw(h.page);
    ok(s.loads === 2 && s.posted === 0, "and reloads at its own next quiet moment, with nobody left to ask", JSON.stringify(s));
    ok(await activeTab(h.page) === "tab-recap", "back on the tab it was on", await activeTab(h.page));
    await h.close();
  }
})().catch(err => { fail++; failures.push("suite threw: " + (err && err.message || err)); })
  .finally(async () => {
    await Promise.all([...open].map(h => h.close().catch(() => {})));
    console.log(`  app-update  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
