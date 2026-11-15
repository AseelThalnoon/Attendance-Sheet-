// What is left of one person when the next one signs in on the same machine.
//
// Signing out hid the app; it did not empty it. An administrator who signed
// out while looking at the Admin screen left that screen in the page -- every
// account's name and address, the activity log -- and the next sign-in in the
// same window opened on it: the tab was still the active one, and nothing
// redraws a tab the new person has no right to draw. The database refused
// them every row. The page had kept a copy.
//
// Three things are held here:
//   * after a sign-out the page starts over, so nothing drawn or loaded for
//     the last person is anywhere in it;
//   * where it cannot start over (no connection, nothing cached to reload
//     from), the places that hold other people's data are emptied by hand and
//     the app goes back to Overview;
//   * the device stops receiving the last person's notifications.
const { boot, settle, goTab, DESKTOP } = require("../hostile/harness");
const { HOST } = require("../hostile/backend");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const admin = D.profile(1, { full_name: "Ada Admin", role: "admin", email: "ada.admin@example.com" });
const emp   = D.profile(2, { full_name: "Emre Employee", email: "emre.employee@example.com" });
const third = D.profile(3, { full_name: "Thea Third", email: "thea.third@example.com" });
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device";

const seed = () => ({
  profiles: [admin, emp, third],
  entries: [admin, emp, third].flatMap(p => D.entriesFor(p.id, 10).map(e => Object.assign(e, { id: p.id.slice(-2) + e.id, note: "" }))),
  user_settings: [admin, emp, third].map(p => ({ user_id: p.id, settings: D.SETTINGS })),
  audit_log: [{ id: 1, actor_email: admin.email, action: "update", table_name: "entries", record_id: "x",
    target_email: third.email, entry_date: "2026-11-01", old_values: { note: "" }, new_values: { note: "fixed" },
    created_at: new Date().toISOString() }],
  push_subscriptions: [{ id: 1, user_id: admin.id, endpoint: ENDPOINT, p256dh: "p", auth: "a",
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130", created_at: new Date().toISOString() }]
});

// A browser that already holds a push subscription for this device, and
// remembers across page loads whether it was told to drop it.
const withPush = async ({ page }) => {
  await page.addInitScript(endpoint => {
    // Headless Chromium answers "denied" whatever the context was granted, and
    // the app would open on its "notifications are blocked" dialog.
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
    const KEY = "__fakePush";
    const state = JSON.parse(sessionStorage.getItem(KEY) || '{"subscribed":true,"unsubscribed":0}');
    const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
    const sub = { endpoint, options: null,
      toJSON(){ return { endpoint, keys: { p256dh: "p", auth: "a" } }; },
      unsubscribe: async () => { state.subscribed = false; state.unsubscribed++; save(); return true; } };
    const reg = { pushManager: {
      getSubscription: async () => (state.subscribed ? sub : null),
      subscribe: async () => { state.subscribed = true; save(); return sub; } } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      ready: Promise.resolve(reg), controller: null,
      register: () => Promise.resolve(reg), getRegistration: () => Promise.resolve(reg),
      getRegistrations: () => Promise.resolve([reg]),
      addEventListener(){}, removeEventListener(){} } });
  }, ENDPOINT);
};

// The next person's sign-in, answered as Supabase Auth would.
const letIn = (page, who) => page.route(`${HOST}/auth/v1/token**`, route => route.fulfill({
  status: 200, contentType: "application/json",
  headers: { "Access-Control-Allow-Origin": "*", "X-Supabase-Api-Version": "2024-01-01" },
  body: JSON.stringify({ access_token: "test-access-token", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "test-refresh-token",
    user: { id: who.id, aud: "authenticated", role: "authenticated", email: who.email,
      app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" } }) }));

const signOut = async page => {
  await page.evaluate(() => document.getElementById("logoutBtn").click());
  await page.waitForSelector(".modal-overlay .modal-confirm", { timeout: 5000 });
  await page.evaluate(() => document.querySelector(".modal-overlay .modal-confirm").click());
};
const signInAs = async (h, who) => {
  h.backend.state.meId = who.id;
  await h.page.fill("#siEmail", who.email);
  await h.page.fill("#siPassword", "correct horse battery");
  await h.page.click("#signInBtn");
  await h.page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
  await settle(h.page, 1200);
};
// Everything the page is holding, drawn or not.
const pageText = page => page.evaluate(() => document.documentElement.innerHTML);
const view = page => page.evaluate(() => ({
  auth: getComputedStyle(document.getElementById("authScreen")).display !== "none",
  app: document.getElementById("appShell").style.display !== "none",
  activePanels: [...document.querySelectorAll(".tab-panel.active")].map(p => p.id),
  adminRows: document.getElementById("adminUsersList").children.length,
  auditRows: document.getElementById("auditBody").children.length,
  teamCards: document.getElementById("teamList").children.length,
  viewerOptions: document.getElementById("viewerSelect").options.length,
  marker: window.__sameDocument === true,
  title: document.title
}));

const open = new Set();
async function start(opts){
  const h = await boot(opts);
  open.add(h);
  const close = h.close;
  h.close = async () => { open.delete(h); await close(); };
  return h;
}

(async () => {
  // ---- The ordinary case: the page starts over --------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: admin.id, seed: seed(), beforeLoad: withPush });
    await goTab(h.page, "team");
    await settle(h.page, 600);
    await goTab(h.page, "admin");
    await h.page.click("#cnav-admin-people");
    await settle(h.page, 900);
    let v = await view(h.page);
    let html = await pageText(h.page);
    ok(v.adminRows >= 3 && html.includes(third.email),
      "(an administrator, on the Admin screen: every account is listed)", JSON.stringify(v));
    ok(/Admin/.test(v.title), "the title names the screen", v.title);
    ok(h.backend.state.push_subscriptions.length === 1, "(and this device is registered for their notifications)");

    await h.page.evaluate(() => { window.__sameDocument = true; });
    await signOut(h.page);
    await h.page.waitForFunction(() => window.__sameDocument !== true, null, { timeout: 15000 });
    await h.page.waitForSelector("#authScreen", { timeout: 15000 });
    await settle(h.page, 900);

    v = await view(h.page);
    html = await pageText(h.page);
    ok(!v.marker, "signing out loads the page afresh");
    ok(v.auth && !v.app, "on the sign-in screen", JSON.stringify(v));
    ok(v.adminRows === 0 && v.auditRows === 0 && v.teamCards === 0 && v.viewerOptions === 0,
      "with nothing of the last person drawn behind it", JSON.stringify(v));
    ok(!html.includes(third.email) && !html.includes(emp.email) && !html.includes(admin.email),
      "and no account's address anywhere in the page");
    ok(v.title === "Attendance Ledger", "the title is the app's own again", v.title);

    ok(h.backend.state.push_subscriptions.length === 0,
      "the device is no longer registered for the last person's notifications",
      JSON.stringify(h.backend.state.push_subscriptions));
    const fake = await h.page.evaluate(() => JSON.parse(sessionStorage.getItem("__fakePush")));
    ok(fake && fake.unsubscribed === 1 && fake.subscribed === false,
      "and the browser's own subscription was dropped with it", JSON.stringify(fake));

    // The next person, in the same window.
    await letIn(h.page, emp);
    await signInAs(h, emp);
    v = await view(h.page);
    html = await pageText(h.page);
    ok(v.app && v.activePanels.join() === "tab-overview", "an employee who signs in next lands on Overview",
      JSON.stringify(v.activePanels));
    ok(v.adminRows === 0 && v.auditRows === 0 && v.teamCards === 0 && v.viewerOptions === 0,
      "with no trace of the administrator's screens", JSON.stringify(v));
    ok(!html.includes(third.email) && !html.includes(admin.email),
      "and nobody else's address in the page");
    ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- No way to reload: emptied by hand ---------------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: admin.id, seed: seed() });
    await goTab(h.page, "team");
    await settle(h.page, 600);
    await goTab(h.page, "admin");
    await h.page.click("#cnav-admin-people");
    await settle(h.page, 900);
    ok((await view(h.page)).adminRows >= 3, "(the Admin screen is drawn)");

    // Offline, and no service worker in control to serve a cached shell: a
    // reload here would land on the browser's own error page.
    await h.page.evaluate(() => {
      window.__sameDocument = true;
      Object.defineProperty(window.navigator, "onLine", { get: () => false, configurable: true });
    });
    await signOut(h.page);
    await h.page.waitForFunction(() => getComputedStyle(document.getElementById("authScreen")).display !== "none" &&
      document.getElementById("appShell").style.display === "none", null, { timeout: 15000 });
    await settle(h.page, 600);
    let v = await view(h.page);
    let html = await pageText(h.page);
    ok(v.marker, "with no connection and nothing cached, the page is not reloaded");
    ok(v.auth && !v.app, "the sign-in screen is shown", JSON.stringify(v));
    ok(v.adminRows === 0 && v.auditRows === 0 && v.teamCards === 0 && v.viewerOptions === 0,
      "and the screens that held other people are emptied in place", JSON.stringify(v));
    ok(v.activePanels.join() === "tab-overview", "the open tab goes back to Overview", JSON.stringify(v.activePanels));
    ok(!html.includes(third.email), "no teammate's address is left in the page");

    await letIn(h.page, emp);
    await signInAs(h, emp);
    v = await view(h.page);
    html = await pageText(h.page);
    ok(v.app && v.activePanels.join() === "tab-overview", "the next person lands on Overview here too",
      JSON.stringify(v.activePanels));
    ok(v.adminRows === 0 && v.teamCards === 0 && !html.includes(third.email) && !html.includes(admin.email),
      "and sees none of the administrator's data", JSON.stringify(v));
    await h.close();
  }
})().catch(err => { fail++; failures.push("suite threw: " + (err && err.message || err)); })
  .finally(async () => {
    await Promise.all([...open].map(h => h.close().catch(() => {})));
    console.log(`  sign-out-clean  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
