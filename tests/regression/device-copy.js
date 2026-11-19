// Opening the app, and the first day in it (2026-11-17).
//
// Opening: every open showed the sign-in form first, for 0.8s on office Wi-Fi
// and longer on mobile data, and with no signal it stayed there, so nobody
// could clock in. The signed-in person's own record is now kept on the device
// and the app opens straight into it while the real load runs behind it.
//
// Day one: the first clock-in swapped the welcome card for a row of zeros,
// the calendar marked every earlier workday of the month "Not logged" on an
// account opened that morning, and the welcome card's big "+" opened the
// hand-entry form under a sentence saying to clock in.
const { boot, settle, goTab, PHONE, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const people = D.roster(3);
const me = people[1];
const today = D.dateStr(new Date());
const COPY = "attendance.record.v1";
const seed = extra => Object.assign({
  profiles: people,
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
  entries: D.entriesFor(me.id, 30)
}, extra || {});

// Watches, from the first frame, whether the sign-in form is ever visible
// before the app appears. Measured in the page: it lasts a fraction of a
// second, which round trips from here would miss.
const watchFirstPaint = page => page.addInitScript(() => {
  window.__authSeen = false;
  const look = () => {
    const auth = document.getElementById("authScreen"), shell = document.getElementById("appShell");
    if(auth && shell){
      if(shell.style.display === "block") return;
      const cs = getComputedStyle(auth);
      if(cs.display !== "none" && cs.visibility !== "hidden") window.__authSeen = true;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
const view = page => page.evaluate(copyKey => ({
  shell: document.getElementById("appShell").style.display === "block",
  avg: document.getElementById("monthAvg").textContent,
  greet: document.getElementById("headGreeting").textContent,
  banner: document.getElementById("loadFailBanner").classList.contains("show")
    ? document.getElementById("loadFailTitle").textContent : "",
  copy: JSON.parse(localStorage.getItem(copyKey) || "null"),
  authSeen: window.__authSeen
}), COPY);

(async () => {
  // ---- Saved, reopened from, and kept when the server cannot be reached ------
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed(), beforeLoad: ({ page }) => watchFirstPaint(page) });
    const p = h.page;
    try {
      await settle(p, 900);
      const first = await view(p);
      ok(!!first.copy && first.copy.userId === me.id && first.copy.entries.length === 30 &&
         first.copy.profile.full_name === me.full_name, "the signed-in person's record is kept on the device",
         JSON.stringify(first.copy && { user: first.copy.userId, n: first.copy.entries.length }));

      // The record takes three seconds to come back: the app is already there.
      h.backend.fail("rest/v1/entries", { delayMs: 3000 }, 1);
      await p.reload({ waitUntil: "domcontentloaded" });
      await settle(p, 900);
      const early = await view(p);
      ok(early.shell && early.avg === first.avg && /Hello/.test(early.greet) && early.greet !== "Hello",
        "reopened, the record is on screen before the server has answered", JSON.stringify(early));
      ok(early.authSeen === false, "and the sign-in form never showed", "authSeen=" + early.authSeen);
      ok(await p.evaluate(() => !document.documentElement.hasAttribute("data-opening")), "the opening mark is cleared");

      // The same days arriving from the server do not redraw the Day Types
      // ring: it was emptied and swept in a second time on every open.
      await p.evaluate(() => { document.getElementById("formatDial").firstElementChild.__fromCopy = true; });
      await settle(p, 3200);
      ok(await p.evaluate(() => document.getElementById("formatDial").firstElementChild.__fromCopy === true),
        "the record arriving unchanged leaves the Day Types ring as it was drawn from the copy");
      await goTab(p, "log");
      await goTab(p, "overview");
      ok(await p.evaluate(() => !document.getElementById("formatDial").firstElementChild.__fromCopy),
        "coming back to Overview still draws it in");

      // No connection to the database at all: the copy stays, and says so.
      h.backend.fail("rest/v1/", { mode: "offline" });
      await p.reload({ waitUntil: "domcontentloaded" });
      await settle(p, 2000);
      const off = await view(p);
      ok(off.shell && off.avg === first.avg, "offline, the app still opens on the record", JSON.stringify(off));
      ok(off.banner === "Showing the copy saved on this device", "with a notice that it is the device's copy", off.banner);
      ok(!!off.copy && off.copy.entries.length === 30, "and the copy is not emptied by the failed load");
      // Settings will not save a schedule it has not read from the server.
      await goTab(p, "settings");
      const writes = h.backend.state.log.filter(r => r.path.includes("user_settings") && r.method !== "GET").length;
      await p.evaluate(() => document.getElementById("saveSettingsBtn").click());
      await settle(p, 500);
      ok(h.backend.state.log.filter(r => r.path.includes("user_settings") && r.method !== "GET").length === writes,
        "Settings refuses to save over the server from the copy");
      await goTab(p, "overview");

      h.backend.clearFaults();
      await p.evaluate(() => document.getElementById("loadFailRetryBtn").click());
      await settle(p, 1200);
      ok(!(await view(p)).banner, "Try Again reads the record and the notice goes");

      // Sign out: the copy goes with the session.
      await p.evaluate(() => document.getElementById("logoutBtn").click());
      await settle(p, 400);
      await p.evaluate(() => document.querySelector(".modal-overlay .modal-confirm").click());
      await p.waitForFunction(() => getComputedStyle(document.getElementById("authScreen")).display !== "none", null, { timeout: 15000 });
      await settle(p, 600);
      ok(await p.evaluate(k => localStorage.getItem(k) === null, COPY), "signing out removes the copy from the device");
      ok(h.errors.filter(e => !/Failed to load resource|Failed to fetch/.test(e)).length === 0,
        "device copy: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // ---- A punch while the session is still being restored ----------------------
  // The stored token has expired and the refresh never answers: the app is
  // drawn from the copy, and a punch is kept on the device rather than sent
  // into a request that would wait on the sign-in.
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed({ entries: D.entriesFor(me.id, 10).filter(e => e.date !== today) }) });
    const p = h.page;
    try {
      await settle(p, 900);
      await p.evaluate(() => {
        const k = Object.keys(localStorage).find(x => /^sb-.*-auth-token$/.test(x));
        const s = JSON.parse(localStorage.getItem(k));
        s.expires_at = Math.floor(Date.now() / 1000) - 60;
        localStorage.setItem(k, JSON.stringify(s));
      });
      h.backend.fail("/auth/v1/token", { mode: "hang" });
      await p.reload({ waitUntil: "domcontentloaded" });
      await settle(p, 1200);
      const shown = await p.evaluate(() => document.getElementById("appShell").style.display === "block");
      ok(shown, "an expired session still opens on the copy while it is renewed");
      // The phone's tab bar does not wait for the renewal either. It held only
      // the clock button until the server had answered: 2.5s on the live
      // logs' timings, 7s on the slowest renewal they show.
      const bar = await p.evaluate(() => [...document.querySelectorAll("#bottomNav .bn-item")]
        .filter(el => el.getClientRects().length).map(el => el.getAttribute("data-bn-tab")).join());
      ok(bar === "overview,log,trends,calendar", "and its tab bar is there to move about in", bar);
      await p.evaluate(() => document.querySelector('#bottomNav .bn-item[data-bn-tab="log"]').click());
      await settle(p, 500);
      ok(await p.evaluate(() => document.getElementById("tab-log").classList.contains("active")),
        "a tab can be opened before the sign-in is renewed");
      await p.evaluate(() => document.querySelector('#bottomNav .bn-item[data-bn-tab="overview"]').click());
      await settle(p, 400);
      await p.evaluate(() => document.getElementById("bnClockBtn").click());
      await settle(p, 900);
      const st = await p.evaluate(() => ({
        outbox: JSON.parse(localStorage.getItem("attendance.outbox") || "[]"),
        enabled: !document.getElementById("bnClockBtn").classList.contains("disabled"),
        action: document.getElementById("bnClockBtn").getAttribute("data-clock-action")
      }));
      ok(st.outbox.length === 1 && st.outbox[0].field === "clockIn", "the clock-in is kept on the device", JSON.stringify(st.outbox));
      ok(st.enabled && st.action === "out", "and the clock is free again, offering Clock Out", JSON.stringify(st));
    } finally { await h.close(); }
  }

  // ---- Someone else's copy is never shown ------------------------------------
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed() });
    const p = h.page;
    try {
      await settle(p, 900);
      await p.evaluate(([k, other]) => {
        const c = JSON.parse(localStorage.getItem(k));
        c.userId = other.id; c.profile = Object.assign({}, c.profile, { id: other.id, full_name: "Someone Else" });
        localStorage.setItem(k, JSON.stringify(c));
      }, [COPY, people[2]]);
      h.backend.fail("rest/v1/entries", { delayMs: 1500 }, 1);
      await p.reload({ waitUntil: "domcontentloaded" });
      await settle(p, 400);
      const g = await p.evaluate(() => document.getElementById("headGreeting").textContent);
      ok(!/Someone/.test(g), "a copy that is not the signed-in person's is not drawn", g);
      await settle(p, 2000);
      const c = await p.evaluate(k => JSON.parse(localStorage.getItem(k) || "null"), COPY);
      ok(!!c && c.userId === me.id, "and is replaced by this person's own", c && c.userId);
    } finally { await h.close(); }
  }

  // ---- Day one: the welcome card lasts through the first shift ---------------
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed({ entries: [] }) });
    const p = h.page;
    const card = () => p.evaluate(() => ({
      firstRun: document.getElementById("tab-overview").classList.contains("is-first-run"),
      title: document.getElementById("firstRunTitle").textContent,
      sub: document.getElementById("firstRunSub").textContent,
      label: document.getElementById("firstRunClockLabel").textContent,
      stats: !!document.getElementById("statsRow").getClientRects().length
    }));
    try {
      const before = await card();
      ok(before.firstRun && before.label === "Clock In" && !before.stats, "day one: the card's big control is Clock In", JSON.stringify(before));
      await p.evaluate(() => document.getElementById("firstRunClockBtn").click());
      await settle(p, 2900);
      const open = await card();
      ok(open.firstRun && /underway/.test(open.title) && /Clocked in at/.test(open.sub) && open.label === "Clock Out" && !open.stats,
        "after the first clock-in the card stays, says the day is underway and offers Clock Out — no row of zeros",
        JSON.stringify(open));
      await p.keyboard.press("Escape");   // the once-only notifications question, if this browser asks
      await settle(p, 400);
      await p.evaluate(() => document.getElementById("firstRunClockBtn").click());
      await settle(p, 2900);
      const done = await card();
      ok(!done.firstRun && done.stats, "the first clock-out ends day one and the figures take over", JSON.stringify(done));
      ok(h.errors.length === 0, "day one: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // ---- The calendar starts at the first logged day ----------------------------
  {
    const d = new Date();
    const back = n => D.dateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
    const row = (date, id) => ({ id, user_id: me.id, date, clock_in: "08:00:00", clock_out: "16:00:00",
      type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z" });
    // Today, and six days ago: the days between are real gaps, the days
    // before are before the record began.
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed({ entries: [row(back(6), 1), row(today, 2)] }) });
    const p = h.page;
    try {
      await goTab(p, "calendar");
      await settle(p, 600);
      const cal = await p.evaluate(([first, sched]) => {
        const cells = [...document.querySelectorAll("#calendarGrid .cal-cell[data-date]")];
        const notLogged = c => /Not logged/.test(c.textContent);
        return {
          beforeMarked: cells.filter(c => c.dataset.date < first && notLogged(c)).length,
          beforeCells: cells.filter(c => c.dataset.date < first && c.classList.contains("cal-before")).length,
          gapMarked: cells.filter(c => c.dataset.date > first && c.classList.contains("cal-missing") && notLogged(c)).length,
          label: (cells.find(c => c.classList.contains("cal-before")) || {}).getAttribute
            ? cells.find(c => c.classList.contains("cal-before")).getAttribute("aria-label") : ""
        };
      }, [back(6)]);
      ok(cal.beforeMarked === 0, "no workday before the first logged one is marked \"Not logged\"", JSON.stringify(cal));
      // Only checkable when the month has scheduled days before the first entry.
      if(cal.beforeCells) ok(/before your first logged day/.test(cal.label), "and a screen reader hears why", cal.label);
      if(d.getDate() > 7) ok(cal.gapMarked >= 1, "a workday missed after it still is", JSON.stringify(cal));
    } finally { await h.close(); }
  }

  // ---- A month with no workday yet: the sentence wraps instead of being cut ---
  {
    const leave = { id: 1, user_id: me.id, date: today, clock_in: null, clock_out: null, type: "leave",
      note: "", updated_at: "2026-01-01T00:00:00Z" };
    const h = await boot({ viewport: { width: 375, height: 812 }, meId: me.id, seed: seed({ entries: [leave] }) });
    try {
      const lab = await h.page.evaluate(() => {
        const el = document.getElementById("monthAvgDetail");
        const fill = document.getElementById("heroProgressFill");
        return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1,
          // Nothing to draw: the bar is there, empty, rather than gone.
          empty: /scaleX\(0\)/.test(fill.style.transform) && !!fill.getClientRects().length,
          inside: el.getBoundingClientRect().right <= el.closest(".stat-card").getBoundingClientRect().right };
      });
      ok(lab.empty && !lab.clipped && lab.inside && /No workdays logged yet this month/.test(lab.text),
        "\"No workdays logged yet this month\" is read in full on an iPhone-width tile", JSON.stringify(lab));
    } finally { await h.close(); }
  }

  console.log(`  device-copy  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
