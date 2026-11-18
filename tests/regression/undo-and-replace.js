// Protecting the record (2026-11-17): the things one tap could lose, and the
// one copy of everything that did not exist.
//
//   * Clock Out ended the day in one tap with no way back but the entry form;
//     its message now offers Undo, for a saved punch and for one still
//     waiting on the device.
//   * Add Entry pressed with nothing typed saved an empty Regular day without
//     a word, and "An entry for 17 Nov already exists. Replace it?" wiped the
//     morning's clock-in without saying that was what it held, and with no
//     Undo.
//   * Messages sat on the phone's bottom bar for four to eight seconds.
//   * Nothing held a copy of the team's records outside the live database;
//     Admin > Backup & Storage has Download Team Backup.
//
// Each case drives the real page against the scripted backend.
const fs = require("fs");
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
// A shift opened a minute after midnight, so a clock-out "now" is always
// after it, whenever this runs.
const openToday = { id: 5, user_id: me.id, date: today, clock_in: "00:01:00", clock_out: null,
  type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z" };
const seed = extra => Object.assign({
  profiles: people,
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
  entries: D.entriesFor(me.id, 12).filter(e => e.date !== today).concat([Object.assign({}, openToday)])
}, extra || {});
const toasts = page => page.evaluate(() => [...document.querySelectorAll(".toast")].map(t =>
  t.querySelector(".toast-msg").textContent + (t.querySelector(".toast-action") ? " [" + t.querySelector(".toast-action").textContent + "]" : "")));
const lastAction = page => page.evaluate(() => {
  const a = [...document.querySelectorAll(".toast-action")].pop();
  if(a) a.click();
  return !!a;
});
const todayRow = h => h.backend.state.entries.find(e => e.user_id === me.id && e.date === today);

(async () => {
  // ---- Clock out, then Undo (phone) -----------------------------------------
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed() });
    try {
      await h.page.evaluate(() => document.getElementById("bnClockBtn").click());
      await settle(h.page, 700);
      ok(!!todayRow(h).clock_out, "clock-out saved", JSON.stringify(todayRow(h)));
      ok(!(await toasts(h.page)).some(t => /Undo/.test(t)), "the Undo waits while the flood covers the screen",
        JSON.stringify(await toasts(h.page)));
      await settle(h.page, 2200);
      const t = await toasts(h.page);
      ok(t.some(x => /^Clocked out at .* worked \[Undo\]$/.test(x)), "then the clock-out's message offers Undo", JSON.stringify(t));
      ok(t.filter(x => /Clocked out/.test(x)).length === 1, "one message, not two", JSON.stringify(t));

      // Messages clear the bottom bar and its raised clock button.
      const geo = await h.page.evaluate(() => {
        const toast = document.querySelector(".toast.show").getBoundingClientRect();
        const clock = document.getElementById("bnClockBtn").getBoundingClientRect();
        return { toastBottom: Math.round(toast.bottom), clockTop: Math.round(clock.top) };
      });
      ok(geo.toastBottom <= geo.clockTop, "the message sits above the bottom bar's clock button", JSON.stringify(geo));

      await lastAction(h.page);
      await settle(h.page, 800);
      ok(todayRow(h).clock_out == null, "Undo puts the day back open on the server", JSON.stringify(todayRow(h)));
      const after = await h.page.evaluate(() => ({
        action: document.getElementById("bnClockBtn").getAttribute("data-clock-action"),
        msgs: [...document.querySelectorAll(".toast-msg")].map(t => t.textContent)
      }));
      ok(after.action === "out", "and the clock offers Clock Out again", JSON.stringify(after));
      ok(after.msgs.some(m => /undone.*clocked in since 12:01 AM/.test(m)), "and says so", JSON.stringify(after.msgs));
      ok(h.errors.length === 0, "clock-out undo: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // ---- A day changed since: Undo leaves it alone -----------------------------
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed() });
    try {
      await h.page.evaluate(() => document.getElementById("qcClockBtn").click());
      await settle(h.page, 900);
      // On a desktop the flood stays inside the panel, so the message is up at once.
      ok((await toasts(h.page)).some(t => /Clocked out.*\[Undo\]/.test(t)), "desktop: Undo offered straight away");
      // Edited elsewhere meanwhile (the screen hears of it through a reload).
      todayRow(h).clock_out = "23:58:00";
      await h.page.evaluate(() => document.getElementById("refreshBtn").click());
      await settle(h.page, 900);
      await lastAction(h.page);
      await settle(h.page, 700);
      ok(todayRow(h).clock_out === "23:58:00", "Undo does not write over a newer change", JSON.stringify(todayRow(h)));
      ok((await toasts(h.page)).some(t => /changed since/.test(t)), "and says why", JSON.stringify(await toasts(h.page)));
    } finally { await h.close(); }
  }

  // ---- Clock out with no connection, then Undo -------------------------------
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed() });
    try {
      await h.page.context().setOffline(true);
      await h.page.evaluate(() => document.getElementById("bnClockBtn").click());
      await settle(h.page, 2900);
      const queued = await h.page.evaluate(() => JSON.parse(localStorage.getItem("attendance.outbox") || "[]"));
      ok(queued.length === 1 && queued[0].field === "clockOut", "offline: the clock-out waits on the device", JSON.stringify(queued));
      ok((await toasts(h.page)).some(t => /saved on this device.*\[Undo\]/.test(t)), "and its message offers Undo too",
        JSON.stringify(await toasts(h.page)));
      await lastAction(h.page);
      await settle(h.page, 600);
      const state = await h.page.evaluate(() => ({
        outbox: JSON.parse(localStorage.getItem("attendance.outbox") || "[]").length,
        banner: document.getElementById("outboxBanner").classList.contains("show"),
        action: document.getElementById("bnClockBtn").getAttribute("data-clock-action")
      }));
      ok(state.outbox === 0 && !state.banner && state.action === "out",
        "Undo takes it out of the queue and the day is open again", JSON.stringify(state));
      await h.page.context().setOffline(false);
      ok(todayRow(h).clock_out == null, "nothing reached the server", JSON.stringify(todayRow(h)));
    } finally { await h.close(); }
  }

  // ---- The entry form: blank days, Replace, Undo ------------------------------
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed() });
    const p = h.page;
    const form = (vals) => p.evaluate(v => {
      for(const [id, val] of Object.entries(v)) document.getElementById(id).value = val;
      document.getElementById("submitBtn").click();
    }, vals);
    try {
      await goTab(p, "log");
      await p.evaluate(() => document.getElementById("addEntryBtn").click());
      await settle(p);
      const rows = h.backend.state.entries.length;
      await form({ fIn: "", fOut: "", fType: "regular" });
      await settle(p);
      ok(h.backend.state.entries.length === rows, "a blank Regular day is not saved");
      ok((await toasts(p)).some(t => /Add the time you clocked in/.test(t)), "and the form says what is missing");
      ok(await p.evaluate(() => document.getElementById("fIn").getAttribute("aria-invalid") === "true"), "on the clock-in field");
      await form({ fIn: "", fOut: "17:00", fType: "regular" });
      await settle(p);
      ok(h.backend.state.entries.length === rows, "nor one with only a clock-out");
      ok((await toasts(p)).some(t => /clock-in time too/.test(t)), "which is explained as well");

      // A day off needs no times.
      const free = D.dateStr(new Date(Date.now() - 20 * 864e5));
      await form({ fDate: free, fToDate: free, fIn: "", fOut: "", fType: "leave" });
      await settle(p, 700);
      ok(h.backend.state.entries.some(e => e.date === free && e.type === "leave"), "Annual Leave saves without times");

      // Replace today's open shift: the question says what is there and what replaces it.
      await p.evaluate(() => document.getElementById("addEntryBtn").click());
      await settle(p);
      await form({ fDate: today, fToDate: today, fIn: "09:00", fOut: "17:00", fType: "regular" });
      await settle(p);
      const ask = await p.evaluate(() => { const c = document.querySelector(".modal-card"); return c ? c.innerText.replace(/\s+/g, " ") : ""; });
      ok(/Replace this day\?/.test(ask) && /already has Regular · in 12:01 AM, still open/.test(ask) &&
         /Replace it with Regular · 9:00 AM – 5:00 PM\?/.test(ask), "Replace says what it is about to write over", ask);
      await p.evaluate(() => document.querySelector(".modal-confirm").click());
      await settle(p, 800);
      ok(todayRow(h).clock_in.slice(0, 5) === "09:00" && todayRow(h).clock_out.slice(0, 5) === "17:00", "Replace saves the new day");
      ok((await toasts(p)).some(t => /^Replaced .*\[Undo\]$/.test(t)), "and offers Undo", JSON.stringify(await toasts(p)));
      await lastAction(p);
      await settle(p, 800);
      ok(todayRow(h).clock_in.slice(0, 5) === "00:01" && todayRow(h).clock_out == null,
        "Undo puts this morning's open shift back", JSON.stringify(todayRow(h)));
      ok(h.errors.length === 0, "entry form: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // ---- Export everything (Admin > Data & Backup) ----------------------------------
  {
    const admin = Object.assign({}, people[0]);
    const all = people.flatMap((pp, i) => D.entriesFor(pp.id, 5 + i).map((e, k) => Object.assign(e, { id: i * 1000 + k + 1 })));
    const h = await boot({ viewport: DESKTOP, meId: admin.id, seed: {
      profiles: people, entries: all,
      user_settings: people.map(pp => ({ user_id: pp.id, settings: D.SETTINGS }))
    } });
    const p = h.page;
    try {
      await goTab(p, "admin");
      await p.evaluate(() => document.getElementById("cnav-admin-data").click());
      await settle(p, 600);
      const before = await p.evaluate(() => ({
        nav: document.getElementById("cnavDescAdminData").textContent,
        attention: document.getElementById("cnav-admin-data").classList.contains("needs-attention"),
        shown: !!document.getElementById("exportAllBtn").getClientRects().length
      }));
      ok(before.shown, "Admin > Data & Backup has Download Team Backup");
      ok(/No backup yet/.test(before.nav) && before.attention,
        "with no backup yet, the Data & Backup row says so and asks for attention", JSON.stringify(before));
      const [download] = await Promise.all([
        p.waitForEvent("download", { timeout: 15000 }),
        p.evaluate(() => document.getElementById("exportAllBtn").click())
      ]);
      const file = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
      ok(/^attendance-organisation-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()),
        "the file is named for the day", download.suggestedFilename());
      ok(file.kind === "attendance-organisation-backup" && file.version === 1, "it says what it is");
      ok(file.entries.length === all.length && file.profiles.length === people.length &&
         file.user_settings.length === people.length && !!file.app_settings,
        "every account, every entry, every schedule and the organisation settings",
        JSON.stringify(file.counts));
      ok(new Set(file.entries.map(e => e.user_id)).size === people.length, "everyone's entries, not only the admin's");
      await settle(p, 400);
      const after = await p.evaluate(() => ({
        nav: document.getElementById("cnavDescAdminData").textContent,
        attention: document.getElementById("cnav-admin-data").classList.contains("needs-attention"),
        status: document.getElementById("exportAllStatus").textContent
      }));
      // The row shares its dot with the data checks, so once the backup is
      // done the dot is theirs alone: on when there are records to fix.
      ok(/Backed up today/.test(after.nav) && after.attention === /to fix/.test(after.nav) &&
         /Last downloaded on this device/.test(after.status),
        "afterwards the row says it was done today", JSON.stringify(after));
      // A month on, the row asks again.
      await p.evaluate(() => localStorage.setItem("attendance.orgBackupAt", String(Date.now() - 31 * 864e5)));
      // The header's refresh reloads the Admin console too: it no longer has
      // a refresh button of its own.
      await p.evaluate(() => document.getElementById("refreshBtn").click());
      await settle(p, 800);
      const stale = await p.evaluate(() => ({
        nav: document.getElementById("cnavDescAdminData").textContent,
        attention: document.getElementById("cnav-admin-data").classList.contains("needs-attention")
      }));
      ok(/Backed up 31d ago/.test(stale.nav) && stale.attention, "a month later it asks for a fresh copy", JSON.stringify(stale));
      ok(h.errors.length === 0, "export: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  console.log(`  undo-and-replace  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
