// Asking for notifications on iPhone and iPad, in Safari's own engine.
//
// The app asks each time it is opened until notifications are on for the
// device in hand. iOS is where that is hardest to get right:
//   - In a Safari tab there is no Notification, no PushManager and no service
//     worker at all (iOS 16.4+ gives them only to an app on the Home Screen),
//     so the only useful thing to say is how to install it.
//   - iPadOS Safari calls itself a Mac, so a user-agent test alone misses it.
//   - The installed app's user agent has no "Safari" in it.
//   - iOS shows its permission sheet ONLY from a tap. A request made at
//     launch, outside a tap, gets no sheet -- which is how the first open of
//     a new install used to pass with no question.
//
// WebKit on Linux in a tab already looks like iPhone Safari in a tab (no
// worker, no push, no Notification), so those cases run as-is. For the
// installed app, the three are stood in for the way iOS supplies them, with
// iOS's rule enforced: requestPermission() outside a tap shows nothing.
const { devices } = require("playwright");
const { boot, settle, goTab } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

// What the Home Screen app reports: no "Version/… Safari/…" at the end.
const STANDALONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
// iPadOS Safari's default "desktop" user agent.
const IPAD_AS_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

// cfg.installed: opened from the Home Screen icon.
// cfg.push: the push APIs exist (iOS 16.4+ installed app).
// cfg.permission: the starting Notification.permission.
// cfg.answer: what the person picks on iOS's sheet ("granted", "denied", or
//   "default" for closing it without choosing).
// cfg.swDelayMs: how long the service worker takes to start.
// cfg.touchPoints: navigator.maxTouchPoints (an iPad reports 5).
const ios = cfg => async ({ page }) => {
  await page.addInitScript(cfg => {
    if(cfg.touchPoints != null){
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => cfg.touchPoints });
    }
    // Clock the test can move, for "came back after a while".
    const realNow = Date.now.bind(Date);
    window.__skewMs = 0;
    Date.now = () => realNow() + window.__skewMs;

    if(cfg.installed){
      Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, onchange: null, addListener(){}, removeListener(){},
            addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } }
        : mm(q);
    }
    if(!cfg.push){
      delete window.Notification; delete window.PushManager;
      return;
    }

    // iOS remembers the answer and the subscription across launches.
    const KEY = "__fakeIOSPush";
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    let permission = saved ? saved.permission : cfg.permission;
    let subscribed = !!(saved && saved.subscribed);
    const save = () => sessionStorage.setItem(KEY, JSON.stringify({ permission, subscribed }));
    window.__push = { requests: [], setPermission(p){ permission = p; save(); } };

    // Inside a tap: between the capture and bubble phases of its click.
    let inTap = false;
    window.addEventListener("click", () => { inTap = true; }, true);
    window.addEventListener("click", () => { inTap = false; }, false);

    function Notification(){}
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = () => {
      window.__push.requests.push({ inTap, before: permission });
      // iOS: no tap, no sheet -- the answer stays what it was.
      if(inTap && permission === "default"){ permission = cfg.answer || "granted"; save(); }
      return Promise.resolve(permission);
    };
    window.Notification = Notification;
    window.PushManager = function PushManager(){};

    const sub = { endpoint: "https://web.push.apple.com/QEXAMPLE-device", options: null,
      toJSON(){ return { endpoint: this.endpoint, keys: { p256dh: "p256dh", auth: "auth" } }; },
      unsubscribe: async () => { subscribed = false; save(); return true; } };
    const reg = { pushManager: {
      getSubscription: async () => (subscribed ? sub : null),
      subscribe: async () => {
        if(permission !== "granted") throw new DOMException("not allowed", "NotAllowedError");
        subscribed = true; save(); return sub;
      }
    } };
    const ready = new Promise(r => setTimeout(() => r(reg), cfg.swDelayMs || 0));
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      ready, controller: null,
      register: () => Promise.resolve(reg), getRegistration: () => Promise.resolve(reg),
      getRegistrations: () => Promise.resolve([reg]),
      addEventListener(){}, removeEventListener(){}
    } });
  }, cfg);
};

const me = { id: D.UUID(3), email: "ios@example.com", full_name: "Ios Person", role: "user",
  avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" };
const seed = extra => Object.assign({ profiles: [me], entries: [],
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] }, extra || {});

const dialog = page => page.evaluate(() => {
  const o = document.querySelector(".modal-overlay");
  if(!o || !o.querySelector(".push-prompt-every")) return null;
  const err = o.querySelector(".push-prompt-error");
  return { title: o.querySelector(".modal-title").textContent,
    msg: o.querySelector(".modal-msg").textContent,
    every: o.querySelector(".push-prompt-every").textContent,
    error: err && !err.hidden ? err.textContent : "",
    buttons: [...o.querySelectorAll(".modal-actions .btn")].map(b => b.textContent.trim()) };
});
const awayFor = (page, ms) => page.evaluate(ms => {
  const set = v => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  set("hidden"); document.dispatchEvent(new Event("visibilitychange"));
  window.__skewMs += ms;
  set("visible"); document.dispatchEvent(new Event("visibilitychange"));
}, ms);
const tapButton = (page, sel) => page.tap(".modal-overlay " + sel);
const registered = h => h.backend.state.push_subscriptions.filter(r => r.user_id === me.id);
const start = async (device, cfg, extra) => {
  const d = Object.assign({}, devices[device]);
  if(cfg.ua) d.userAgent = cfg.ua;
  const h = await boot({ engine: "webkit", device: d, meId: me.id, seed: seed(extra), beforeLoad: ios(cfg) });
  await settle(h.page, 1200);
  return h;
};
const noErrors = (h, label) => ok(h.errors.length === 0, label + ": no script errors", h.errors.join(" | "));

(async () => {
  try {
    const { webkit } = require("playwright");
    const b = await webkit.launch();
    await b.close();
  } catch (err) {
    console.log("  ios-push  SKIPPED — WebKit cannot launch on this host (see apple/devices.js)");
    return;
  }

  // ---- iPhone, Safari tab: explain the Home Screen, every launch ----------
  {
    const h = await start("iPhone 15 Pro", { push: false });
    const d = await dialog(h.page);
    ok(!!d && /Home Screen/.test(d.msg) && /Share/.test(d.msg) && /iOS Settings/.test(d.msg),
      "iPhone Safari tab: told to add the app to the Home Screen", JSON.stringify(d));
    ok(!!d && d.buttons.join() === "Got It", "with one Got It button, nothing pretending it can ask", d && d.buttons.join());
    ok(!!d && /each time you open the app/.test(d.every), "and told it will keep asking");
    await tapButton(h.page, ".modal-confirm");
    await settle(h.page, 400);
    ok(!(await dialog(h.page)), "Got It closes it");
    await awayFor(h.page, 60 * 1000); await settle(h.page, 600);
    ok(!(await dialog(h.page)), "a one-minute switch away does not bring it back");
    await awayFor(h.page, 11 * 60 * 1000); await settle(h.page, 800);
    ok(!!(await dialog(h.page)), "coming back after ten minutes does");
    await h.page.reload(); await settle(h.page, 1200);
    ok(!!(await dialog(h.page)), "and so does every launch");
    noErrors(h, "iPhone tab");
    await h.close();
  }

  // ---- iPad, Safari tab: both user agents ---------------------------------
  {
    const h = await start("iPad Pro 11", { push: false });
    const d = await dialog(h.page);
    ok(!!d && /Home Screen/.test(d.msg), "iPad Safari tab (iPad user agent): Home Screen steps", JSON.stringify(d));
    noErrors(h, "iPad tab");
    await h.close();

    const m = await start("iPad Pro 11", { push: false, ua: IPAD_AS_MAC_UA, touchPoints: 5 });
    const dm = await dialog(m.page);
    ok(!!dm && /Home Screen/.test(dm.msg) && !/Dock/.test(dm.msg),
      "iPad Safari tab that calls itself a Mac: still the Home Screen steps", JSON.stringify(dm));
    noErrors(m, "iPad-as-Mac tab");
    await m.close();
  }

  // ---- Installed, never asked: the first open asks --------------------------
  for(const device of ["iPhone SE", "iPhone 15 Pro", "iPhone 14 Pro Max"]){
    const h = await start(device, { installed: true, push: true, permission: "default", ua: STANDALONE_UA });
    const d = await dialog(h.page);
    ok(!!d && /Turn on notifications/.test(d.title) && d.buttons.join() === "Not Now,Turn On",
      `${device} installed: the first open asks`, JSON.stringify(d));
    ok(!!d && /this device/.test(d.every), `${device}: says it will keep asking on this device`, d && d.every);
    const launchAsks = await h.page.evaluate(() => window.__push.requests.length);
    ok(launchAsks === 0, `${device}: never asks iOS at launch, outside a tap (it would show nothing)`, "requests=" + launchAsks);

    // Fits the screen, and the buttons are big enough to tap.
    const fit = await h.page.evaluate(() => {
      const card = document.querySelector(".modal-overlay .modal-card").getBoundingClientRect();
      const btns = [...document.querySelectorAll(".modal-overlay .modal-actions .btn")].map(b => b.getBoundingClientRect());
      return { vw: innerWidth, vh: innerHeight, left: card.left, right: card.right, top: card.top, bottom: card.bottom,
        minH: Math.min(...btns.map(b => b.height)),
        inside: btns.every(b => b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight),
        scrollX: document.documentElement.scrollWidth > innerWidth };
    });
    ok(fit.left >= 0 && fit.right <= fit.vw && fit.top >= 0 && fit.bottom <= fit.vh && fit.inside && !fit.scrollX,
      `${device}: the dialog fits the screen`, JSON.stringify(fit));
    ok(fit.minH >= 44, `${device}: buttons are at least 44pt tall`, "min=" + fit.minH);

    await tapButton(h.page, ".modal-confirm");
    await settle(h.page, 900);
    const reqs = await h.page.evaluate(() => window.__push.requests);
    ok(reqs.length === 1 && reqs[0].inTap, `${device}: Turn On asks iOS from inside the tap`, JSON.stringify(reqs));
    const rows = registered(h);
    ok(rows.length === 1 && rows[0].endpoint.includes("web.push.apple.com") && /iPhone/.test(rows[0].user_agent),
      `${device}: this iPhone is registered`, JSON.stringify(rows));
    ok(!(await dialog(h.page)), `${device}: and the question closes`);
    const toast = await h.page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" "));
    ok(/on for this device/.test(toast), `${device}: confirmed with a toast`, toast);

    await goTab(h.page, "settings"); await settle(h.page, 600);
    const box = await h.page.evaluate(() => { const b = document.getElementById("sPushEnabled"); return b && b.checked; });
    ok(box === true, `${device}: Settings shows notifications on`);

    await h.page.reload(); await settle(h.page, 1200);
    ok(!(await dialog(h.page)), `${device}: once on, the next launch does not ask`);
    await awayFor(h.page, 11 * 60 * 1000); await settle(h.page, 800);
    ok(!(await dialog(h.page)), `${device}: nor does coming back later`);
    noErrors(h, device + " installed");
    await h.close();
  }

  // ---- Not Now: back next time, never snoozed ------------------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "default", ua: STANDALONE_UA });
    await tapButton(h.page, ".modal-cancel"); await settle(h.page, 400);
    ok(!(await dialog(h.page)), "Not Now closes it");
    await awayFor(h.page, 11 * 60 * 1000); await settle(h.page, 800);
    ok(!!(await dialog(h.page)), "Not Now: asked again on coming back after ten minutes");
    await tapButton(h.page, ".modal-cancel"); await settle(h.page, 400);
    await h.page.reload(); await settle(h.page, 1200);
    ok(!!(await dialog(h.page)), "Not Now: asked again on the next launch");
    noErrors(h, "Not Now");
    await h.close();
  }

  // ---- Closing iOS's sheet without choosing --------------------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "default", answer: "default", ua: STANDALONE_UA });
    await tapButton(h.page, ".modal-confirm"); await settle(h.page, 700);
    const d = await dialog(h.page);
    ok(!!d && /wasn't granted/i.test(d.error), "sheet closed without an answer: the dialog says so", JSON.stringify(d));
    const enabled = await h.page.evaluate(() => !document.querySelector(".modal-overlay .modal-confirm").disabled);
    ok(enabled, "and Turn On can be tapped again");
    ok(registered(h).length === 0, "nothing registered");
    noErrors(h, "sheet dismissed");
    await h.close();
  }

  // ---- Don't Allow, then fixing it in iOS Settings ---------------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "default", answer: "denied", ua: STANDALONE_UA });
    await tapButton(h.page, ".modal-confirm"); await settle(h.page, 700);
    const d = await dialog(h.page);
    ok(!!d && /blocked/i.test(d.error), "Don't Allow: the dialog says notifications are blocked", JSON.stringify(d));
    await h.page.reload(); await settle(h.page, 1200);
    const b = await dialog(h.page);
    ok(!!b && /blocked/i.test(b.title) && /iOS Settings/.test(b.msg) && b.buttons.join() === "Got It",
      "next launch: how to allow them in iOS Settings, no button pretending to ask", JSON.stringify(b));
    ok(!!b && /until notifications are allowed/.test(b.every), "and it will keep reminding", b && b.every);
    await tapButton(h.page, ".modal-confirm"); await settle(h.page, 400);

    // Off to iOS Settings and straight back: picked up at once, no question.
    await h.page.evaluate(() => window.__push.setPermission("granted"));
    await awayFor(h.page, 20 * 1000); await settle(h.page, 900);
    ok(!(await dialog(h.page)), "allowed in iOS Settings: no question on coming back");
    ok(registered(h).length === 1, "and this iPhone is registered by itself");
    const toast = await h.page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" "));
    ok(/on for this device/.test(toast), "with a toast saying so", toast);
    noErrors(h, "blocked then fixed");
    await h.close();
  }

  // ---- On for another device, but not this iPhone: still asked --------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "default", ua: STANDALONE_UA },
      { push_subscriptions: [{ id: 1, user_id: me.id, endpoint: "https://fcm.googleapis.com/laptop",
        p256dh: "x", auth: "y", user_agent: "Mozilla/5.0 (Windows NT 10.0)" }] });
    ok(!!(await dialog(h.page)), "notifications on a laptop already: this iPhone is still asked");
    await h.close();
  }

  // ---- Allowed, but the device was removed from the list ---------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "granted", ua: STANDALONE_UA });
    ok(!(await dialog(h.page)), "allowed already: no question");
    ok(registered(h).length === 1, "and the missing registration is put back quietly");
    const asked = await h.page.evaluate(() => window.__push.requests.filter(r => !r.inTap && r.before !== "granted").length);
    ok(asked === 0, "without a request iOS would ignore");
    await h.close();
  }

  // ---- First open of a new install: the worker starts late -------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: true, permission: "default", swDelayMs: 5000, ua: STANDALONE_UA });
    ok(!(await dialog(h.page)), "worker still starting: nothing yet");
    await settle(h.page, 4500);
    ok(!!(await dialog(h.page)), "asked as soon as the worker is up, in the same visit");
    noErrors(h, "late worker");
    await h.close();
  }

  // ---- Installed on an iOS too old for push ---------------------------------
  {
    const h = await start("iPhone 15 Pro", { installed: true, push: false, ua: STANDALONE_UA });
    ok(!(await dialog(h.page)), "installed on iOS before 16.4: no misleading Add to Home Screen steps");
    noErrors(h, "old iOS installed");
    await h.close();
  }

  console.log(`  ios-push  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
