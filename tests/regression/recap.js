// The Recap tab, which replaced the Calendar on 2026-11-22.
//
// Two halves. The first runs the shipping modules themselves -- src/recap.js
// (the arithmetic) and src/recap-view.js (the cards) -- against records built
// for the purpose, with a fixed "today" so a run in any month asserts the
// same thing. The second boots the app and drives the tab the way a person
// does: the bottom bar, the Month/Year switch, the arrows, the keyboard, a
// missed day's Add, and the dot that says a new month's recap is ready.
//
// Since 2026-11-23 the tab is one page, not a carousel (owner: "really
// complicated ... understood from the first look"): a headline, then four
// area cards -- side by side on a desktop, stacked on a phone.
//
// What it holds the tab to is what the owner chose, question by question:
// compared with "your usual" (the three months before), a tip only where an
// area slipped, no figure the Overview already shows, the Year picture
// starting where logging did, and last year compared on the same months only.
require("../no-network");
const path = require("path");
const { pathToFileURL } = require("url");
const { boot, settle, goTab, PHONE, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const text = h => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
// The page's parts: the headline, then each area card, as text.
const heroOf = h => text((h.match(/<header class="recap-hero">[\s\S]*?<\/header>/) || [""])[0]);
const areasOf = h => h.split('<section class="card recap-area').slice(1).map(x => text('<section class="' + x));

// A record: every Sun-Thu workday from `from` to `to`, each made by `make`.
// Rows carry createdAt in local time, the way rowToEntry hands them over.
function record(from, to, make){
  const out = [];
  for(let d = new Date(from + "T00:00:00"); ds(d) <= to; d.setDate(d.getDate() + 1)){
    if(d.getDay() === 5 || d.getDay() === 6) continue;
    const e = make(ds(d), d.getDay());
    if(e) out.push(Object.assign({ date: ds(d), type: "regular", clockIn: "", clockOut: "", note: "" }, e));
  }
  return out;
}
const day = (date, start, len, extra) => Object.assign({
  clockIn: hm(start), clockOut: hm(start + len), createdAt: date + "T" + hm(start + 1) + ":00"
}, extra || {});

(async () => {
  const { makeSchedule } = await import(pathToFileURL(path.join(ROOT, "src/schedule.js")).href);
  const { makeRecap } = await import(pathToFileURL(path.join(ROOT, "src/recap.js")).href);
  const { monthPage, yearPage } = await import(pathToFileURL(path.join(ROOT, "src/recap-view.js")).href);
  const settings = { workDays: [0, 1, 2, 3, 4], targetMin: 480, standardIn: "08:00", standardOut: "16:00", periods: [] };
  const sch = makeSchedule(() => settings);
  const R = makeRecap(sch);

  // ---- A month against the usual ------------------------------------------
  // Aug-Oct: in at 7:58, 8h 6m a day, every one clocked live. November so
  // far: in at 7:46 -- but a half day left at 2h 30m, and two late Mondays
  // ran short. Punctuality better, hours slipped, logging steady.
  {
    const TODAY = "2026-11-22";
    const usual = record("2026-08-02", "2026-10-31", (d) => day(d, 478, 486));
    const nov = record("2026-11-01", "2026-11-19", (d, dow) => {
      if(d === "2026-11-12") return Object.assign(day(d, 466, 150), { type: "halfleave" });
      if(d === "2026-11-09" || d === "2026-11-16") return day(d, 500, 470);
      return day(d, 466, 490);
    });
    const entries = usual.concat(nov, [Object.assign(day("2026-11-22", 467, 0), { clockOut: "" })]);
    const m = R.monthRecap(entries, "2026-11", TODAY);
    ok(m.base && m.base.from === "2026-08-02", "the usual is the three months before", m.base && m.base.from);
    ok(m.verdicts && m.verdicts.punctuality === "better" && m.verdicts.hours === "slipped" && m.verdicts.consistency === "steady",
      "verdicts: earlier starts better, short days slipped, logging steady", JSON.stringify(m.verdicts));
    ok(m.tips.hours && m.tips.hours.kind === "halfDay" && m.tips.hours.date === "2026-11-12",
      "the one tip is about the half day that made most of the shortfall", JSON.stringify(m.tips.hours));
    ok(!m.tips.punctuality && !m.tips.consistency, "no tip for an area that held or improved", JSON.stringify(m.tips));
    ok(m.cur.workdays === 15 && !m.cur.days.some(d => d.date === TODAY),
      "today's open shift is not counted as a finished day", m.cur.workdays + " " + JSON.stringify(m.cur.days.slice(-1)));
    ok(m.cur.missing.length === 0, "and a morning still in progress is not a missed day", JSON.stringify(m.cur.missing));

    const page = monthPage(m, "Compared with your average for Aug – Oct");
    const areas = areasOf(page);
    ok(areas.length === 4, "four area cards on one page", areas.length);
    ok(/^Earlier starts, but your hours slipped\. Compared with your average/.test(heroOf(page)), "the headline says it in one line, and what it is held against", heroOf(page));
    ok(/^Start time Better/.test(areas[0]) && /^Hours Slipped/.test(areas[1]) && /^Logging Steady/.test(areas[2]) && /^Time off \d/.test(areas[3]),
      "each card leads with its area and verdict; time off is not judged", areas.map(a => a.slice(0, 20)).join(" | "));
    ok(/Try this/.test(areas[1]) && /half day/.test(areas[1]), "the Hours card carries the tip", areas[1]);
    ok(!/Try this/.test(areas[0]) && /Well done/.test(areas[0]), "Start time gets a well-done, not advice", areas[0]);
    ok(/earlier than your usual 7:58 AM/.test(areas[0]), "the start is compared with the usual one, named", areas[0].slice(0, 120));
    const slides = [text(page)];
    // The Overview's figures stay on the Overview: the month's average a day
    // (8h 1m here) never appears, only how it moved.
    const avg = Math.round(m.cur.avgMin), avgStr = Math.floor(avg / 60) + "h " + (avg % 60) + "m";
    ok(!slides.join(" ").includes(avgStr), "no card repeats the Overview's average a day", avgStr);
    ok(!/undefined|NaN|null/.test(slides.join(" ")), "nothing on the cards reads undefined or NaN");
  }

  // ---- Somebody who started on the 15th -----------------------------------
  {
    const entries = record("2026-03-15", "2026-03-24", (d) => day(d, 475, 485));
    const m = R.monthRecap(entries, "2026-03", "2026-03-25");
    ok(m.cur.missing.length === 0, "no workday before the first entry counts as not logged", JSON.stringify(m.cur.missing));
    ok(m.base === null && m.verdicts === null, "with no usual yet, nothing is judged", JSON.stringify(m.verdicts));
    const s = text(monthPage(m, ""));
    ok(!/Better|Steady|Slipped/.test(s), "and no card carries a verdict", s.slice(0, 200));
    ok(!/Try this|Well done/.test(s), "no verdict boxes without a usual");
    const gap = R.monthRecap(entries.filter(e => e.date !== "2026-03-18"), "2026-03", "2026-03-25");
    ok(gap.cur.missing.length === 1 && gap.cur.missing[0] === "2026-03-18", "a day missed after the start still is", JSON.stringify(gap.cur.missing));
    ok(R.monthRecap([], "2026-03", "2026-03-25").cur.workdays === 0, "an empty record has nothing to count");
    ok(/first recap/i.test(text(monthPage(R.monthRecap([], "2026-03", "2026-03-25"), ""))), "and says its first recap is coming");
    // A missed day carries its own Add, on that date.
    ok(/data-recap-add="2026-03-18"/.test(monthPage(gap, "")), "a day not logged carries an Add for that date");
  }

  // ---- Which month opens ---------------------------------------------------
  {
    const entries = record("2026-10-01", "2026-12-08", (d) => day(d, 475, 485));
    ok(R.defaultMonth(entries, "2026-12-02") === "2026-11", "on 2 Dec it opens on November, finished");
    ok(R.defaultMonth(entries, "2026-12-09") === "2026-12", "once a week of December is in, December");
  }

  // ---- The year: where logging started, and same months only ---------------
  // An imported spring of 2025, leave rows in April 2026, then daily logging
  // from 11 Aug 2026. The picture starts at 11 Aug; last year logged none of
  // Aug-Nov, so there is nothing to compare.
  {
    const spring = record("2025-01-01", "2025-08-14", (d) => day(d, 470, 490, { createdAt: "2026-08-12T10:00:00" }));
    const leave = record("2026-04-06", "2026-04-30", () => ({ type: "leave", createdAt: "2026-08-12T10:00:00" }));
    const logged = record("2026-08-11", "2026-11-19", (d) => day(d, 476, 488));
    const holiday = [{ date: "2026-09-23", type: "holiday", clockIn: "", clockOut: "", note: "", createdAt: "2026-08-12T10:00:00" }];
    const entries = spring.concat(leave, logged.filter(e => e.date !== "2026-09-23"), holiday);
    const y = R.yearRecap(entries, "2026", "2026-11-22", settings.workDays, sch.weekStartDate);
    ok(y.from === "2026-08-11", "the year picture starts where logging did", y.from);
    ok(y.months[0].key === "2026-08", "so no blank January to July", y.months.map(m => m.key).join());
    ok(y.pairs.length === 0 && y.verdicts === null, "no overlapping months, no comparison", JSON.stringify(y.pairs));
    ok(y.off.total === 19, "time off covers the whole year, public holidays left out", y.off.total);
    const yp = yearPage(y), ya = areasOf(yp);
    ok(/class="card recap-year"/.test(yp) && ya.length === 4, "the year: its picture, then the four areas", ya.length);
    ok(/Nothing from last year to compare yet/.test(heroOf(yp)), "and the headline's line says why there is no comparison", heroOf(yp));
    ok(!/Your 2026 so far/.test(heroOf(yp)), "the headline says what the year shows, not its name again", heroOf(yp));
    ok(/^Time off 19 days away/.test(ya[3]) && /Apr \d+ days/.test(ya[3]), "the year's time off says where it went, April included", ya[3].slice(0, 160));

    const y25 = R.yearRecap(entries, "2025", "2026-11-22", settings.workDays, sch.weekStartDate);
    ok(y25.from === "2025-01-01" && y25.to === "2025-08-14", "a past year runs to its last logged day", y25.from + ".." + y25.to);

    // Two logged Augusts are compared, and only those.
    const aug25 = record("2025-08-01", "2025-08-31", (d) => day(d, 485, 470));
    const both = R.yearRecap(spring.concat(aug25.filter(e => e.date > "2025-08-14"), logged), "2026", "2026-11-22", settings.workDays, sch.weekStartDate);
    ok(both.pairs.length === 1 && both.pairs[0][0] === "2026-08", "same months only: August against August", JSON.stringify(both.pairs));
    ok(both.verdicts && both.verdicts.punctuality === "better", "and the verdict comes from those months", JSON.stringify(both.verdicts));
  }

  // ---- A weekday pattern in time off ---------------------------------------
  {
    const entries = record("2026-08-02", "2026-11-19", (d, dow) => {
      if(dow === 4 && ["2026-09-03", "2026-09-17", "2026-10-08", "2026-10-22", "2026-11-05"].includes(d)) return { type: "other", createdAt: d + "T09:00:00" };
      if(d === "2026-09-23") return { type: "holiday", createdAt: d + "T09:00:00" };
      return day(d, 476, 488);
    });
    const m = R.monthRecap(entries, "2026-11", "2026-11-22");
    ok(m.away.top === 4 && m.away.total === 5, "five days away, all Thursdays: a pattern (the holiday left out)", JSON.stringify(m.away));
    ok(/falls on Thursdays/.test(areasOf(monthPage(m, ""))[3]), "and the Time off card says so");
  }

  // ---- The tab itself --------------------------------------------------------
  const me = D.profile(1, { role: "admin", full_name: "Recap Tester" });
  const other = D.profile(2, { full_name: "Someone Else" });
  const now = new Date();
  const back = n => ds(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  const rows = [];
  // One workday about six weeks back is left out: a missed day, for its Add.
  let missed = null;
  for(let n = 120; n >= 1; n--){
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    if(d.getDay() === 5 || d.getDay() === 6) continue;
    if(!missed && n <= 45){ missed = back(n); continue; }
    const date = back(n), start = 470 + (n % 9) * 2;
    rows.push({ id: "r" + n, user_id: me.id, date, type: "regular", clock_in: hm(start), clock_out: hm(start + 484),
      note: "", created_at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, start + 1).toISOString(),
      updated_at: "2026-01-01T00:00:00Z" });
  }
  const seed = {
    profiles: [me, other], entries: rows,
    user_settings: [me, other].map(p => ({ user_id: p.id, settings: D.SETTINGS }))
  };

  for(const [label, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]){
    const h = await boot({ viewport, meId: me.id, seed });
    const p = h.page;
    try {
      await settle(p, 700);
      // Last month has entries and nobody has opened its recap: the dot is up.
      const dotBefore = await p.evaluate(() => [...document.querySelectorAll('.bn-item[data-bn-tab="recap"], .rail-item[data-rail-tab="recap"]')]
        .some(el => el.classList.contains("has-new") && el.getClientRects().length));
      ok(dotBefore, `${label}: a new month's recap shows a dot on the Recap item`);
      await goTab(p, "recap");
      await settle(p, 600);
      const s = await p.evaluate(() => {
        const areas = [...document.querySelectorAll("#recapBody .recap-area")].map(el => el.getBoundingClientRect());
        return {
          active: document.getElementById("tab-recap").classList.contains("active"),
          cardHidden: document.getElementById("tabContentCard").hidden,
          areas: areas.length,
          tops: areas.map(r => Math.round(r.top)),
          bottoms: areas.map(r => Math.round(r.bottom)),
          headline: (document.querySelector("#recapBody .recap-headline") || {}).textContent || "",
          title: document.getElementById("recapTitle").textContent,
          heading: document.getElementById("headTabName") ? document.getElementById("headTabName").textContent : "",
          dot: [...document.querySelectorAll(".has-new")].length,
          scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      });
      ok(s.active && s.cardHidden, `${label}: Recap opens on the page, outside the tab card`, JSON.stringify(s));
      ok(s.areas === 4 && /\S/.test(s.title) && /\S/.test(s.headline), `${label}: a headline and four area cards under a period title`, JSON.stringify(s));
      if(label === "desktop") ok(new Set(s.tops).size === 1, "desktop: the four areas sit side by side, in one look", JSON.stringify(s.tops));
      else ok(s.tops.every((t, i) => i === 0 || t >= s.bottoms[i - 1]), "phone: the four areas stack, one under the next", JSON.stringify(s.tops));
      ok(s.heading === "Recap", `${label}: the header names the tab`, s.heading);
      ok(s.dot === 0, `${label}: opening it clears the dot`, s.dot);
      ok(!s.scrollX, `${label}: nothing scrolls the page sideways`);

      // The left arrow key steps back a month, the way the arrow button does.
      const before = s.title;
      await p.focus("#tab-recap");
      await p.keyboard.press("ArrowLeft");
      await settle(p, 300);
      const stepped = await p.evaluate(() => document.getElementById("recapTitle").textContent);
      ok(stepped !== before && !/so far/.test(stepped), `${label}: the left arrow key goes back a month, to a finished one`, before + " -> " + stepped);
      await p.keyboard.press("ArrowRight");
      await settle(p, 300);
      ok(await p.evaluate(() => document.getElementById("recapTitle").textContent) === before, `${label}: and the right one comes forward again`);

      await p.click('[data-recap-mode="year"]');
      await settle(p, 500);
      const y = await p.evaluate(() => ({
        areas: document.querySelectorAll("#recapBody .recap-area").length,
        picture: document.querySelectorAll("#recapBody .recap-year .recap-pic").length,
        pressed: document.querySelector('[data-recap-mode="year"]').getAttribute("aria-pressed"),
        title: document.getElementById("recapTitle").textContent,
        prevLabel: document.getElementById("recapPrevBtn").getAttribute("aria-label")
      }));
      ok(y.areas === 4 && y.picture === 1 && y.pressed === "true" && /\d{4}/.test(y.title), `${label}: Year shows the year's picture and its four areas`, JSON.stringify(y));
      ok(y.prevLabel === "Previous year", `${label}: the arrows say what they step`, y.prevLabel);
      await p.click('[data-recap-mode="month"]');
      await settle(p, 300);

      // The missed day: page back to its month and press its Add.
      for(let i = 0; i < 4; i++){
        if(await p.$(`[data-recap-add="${missed}"]`)) break;
        await p.click("#recapPrevBtn");
        await settle(p, 250);
      }
      const add = await p.$(`[data-recap-add="${missed}"]`);
      ok(!!add, `${label}: the missed day ${missed} is listed with an Add`);
      if(add){
        await add.click();
        await settle(p, 500);
        const form = await p.evaluate(() => ({ open: !document.getElementById("entryModal").hidden, date: document.getElementById("fDate").value }));
        ok(form.open && form.date === missed, `${label}: and Add opens the entry form on that date`, JSON.stringify(form));
        await p.keyboard.press("Escape");
        await settle(p, 300);
      }
      ok(h.errors.length === 0, `${label}: no script errors`, h.errors.join(" | "));
    } finally { await h.close(); }
  }

  console.log(`  recap  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
