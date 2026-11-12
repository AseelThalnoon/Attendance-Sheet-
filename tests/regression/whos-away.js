// Admin -> Who's Away: everyone not in the office, week by week.
//
// Seeds a week (Sun-Thu work week, the app's default) with the shapes that
// matter: a multi-day leave that must collapse to one line, two different
// types for one person, a stretch across the weekend, a holiday the whole
// team shares (said once, as "Everyone"), ordinary Regular days that must not
// appear, a deactivated person who must not appear, and next week's leave.
const { boot, settle, goTab } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const sun = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); // week starts Sunday
const day = n => { const d = new Date(sun); d.setDate(d.getDate() + n); return ds(d); };

const admin = D.profile(1, { full_name: "Boss Admin", role: "admin" });
const sara = D.profile(2, { full_name: "Sara Ali" });
const omar = D.profile(3, { full_name: "Omar Haddad" });
const lina = D.profile(4, { full_name: "Lina Noor" });
const gone = D.profile(5, { full_name: "Gone Person", deactivated: true });
const people = [admin, sara, omar, lina, gone];
let id = 0;
const e = (who, date, type) => ({ id: "w" + (++id), user_id: who.id, date, type,
  clock_in: type === "regular" ? "08:00" : "", clock_out: type === "regular" ? "16:00" : "", note: "" });
const entries = [
  e(sara, day(0), "leave"), e(sara, day(1), "leave"), e(sara, day(2), "leave"),   // Sun-Tue
  e(omar, day(1), "wfh"), e(omar, day(3), "trip"), e(omar, day(4), "trip"),           // Mon; Wed-Thu
  e(lina, day(-3), "sick"), e(lina, day(0), "sick"),                                   // last Thu + Sun: one stretch
  e(lina, day(1), "regular"), e(admin, day(1), "regular"),                             // not shown
  e(gone, day(1), "leave"),                                                           // deactivated
  e(sara, day(9), "training")                                                          // next week (Tue)
];
// Wednesday is a public holiday for everyone active.
[admin, sara, omar, lina].forEach(p => { if(p !== omar) entries.push(e(p, day(3), "holiday")); });
entries.push(e(omar, day(3) , "holiday"));
// Omar's Wednesday trip is replaced by the holiday: keep one entry per day.
const omarWedTrip = entries.findIndex(x => x.user_id === omar.id && x.date === day(3) && x.type === "trip");
entries.splice(omarWedTrip, 1);

const short = s => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
  .format(new Date(s + "T00:00:00"));

const read = page => page.evaluate(() => ({
  title: document.getElementById("awayWeekTitle").textContent,
  range: document.getElementById("awayWeekRange").textContent,
  today: !document.getElementById("awayTodayBtn").hidden,
  nav: document.getElementById("cnavDescAway").textContent,
  rows: [...document.querySelectorAll("#awayList .away-row")].map(r => ({
    name: r.querySelector(".away-name").textContent,
    spans: [...r.querySelectorAll(".away-span")].map(s => s.innerText.replace(/\s+/g, " ").trim())
  })),
  empty: (document.querySelector("#awayList .away-empty") || {}).textContent || ""
}));

(async () => {
  for(const [label, vp] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }],
                            ["small phone", { width: 320, height: 640 }]]){
    const h = await boot({ viewport: vp, meId: admin.id, seed: { profiles: people, entries,
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })) } });
    await goTab(h.page, "admin");
    await settle(h.page, 1200);
    await h.page.evaluate(() => document.getElementById("cnav-admin-away").click());
    await settle(h.page, 900);
    const v = await read(h.page);
    const row = name => v.rows.find(r => r.name === name) || { spans: [] };

    if(label === "desktop"){
      ok(v.title === "This week" && !v.today, "opens on this week", JSON.stringify([v.title, v.range]));
      ok(v.rows[0] && v.rows[0].name === "Everyone" && v.rows[0].spans.length === 1 &&
         /Public Holiday/.test(v.rows[0].spans[0]) && v.rows[0].spans[0].includes(short(day(3))),
        "a holiday the whole team shares is one line, under Everyone", JSON.stringify(v.rows[0]));
      ok(JSON.stringify(row("Sara Ali").spans) === JSON.stringify([`Annual Leave ${short(day(0))} – ${short(day(2))}`]),
        "three days of leave collapse to one line with a date range", JSON.stringify(row("Sara Ali").spans));
      ok(row("Omar Haddad").spans.length === 2 && /^Remotely/.test(row("Omar Haddad").spans[0]) &&
         /^Business Trip/.test(row("Omar Haddad").spans[1]) && row("Omar Haddad").spans[1].includes(short(day(4))),
        "two types for one person, in date order", JSON.stringify(row("Omar Haddad").spans));
      ok(row("Lina Noor").spans.length === 1 && /Sick Leave/.test(row("Lina Noor").spans[0]),
        "a sick day this week shows; Regular days do not", JSON.stringify(row("Lina Noor").spans));
      ok(!v.rows.some(r => r.name === "Boss Admin") && !v.rows.some(r => /Gone/.test(r.name)),
        "people only at work are not listed, nor is a deactivated person", JSON.stringify(v.rows.map(r => r.name)));
      ok(v.rows.every(r => !r.spans.some(s => /Regular/.test(s))), "no Regular days anywhere");
      ok(v.nav === "3 people away this week", "the menu line counts the people away", v.nav);

      await h.page.evaluate(() => document.getElementById("awayNextBtn").click());
      await settle(h.page, 700);
      const n = await read(h.page);
      ok(n.title === "Next week" && n.today, "› steps to next week, with a way back", JSON.stringify([n.title, n.today]));
      ok(n.rows.length === 1 && n.rows[0].name === "Sara Ali" && /Training/.test(n.rows[0].spans[0]),
        "next week shows next week's plans", JSON.stringify(n.rows));
      await h.page.evaluate(() => document.getElementById("awayNextBtn").click());
      await settle(h.page, 700);
      const n2 = await read(h.page);
      ok(n2.rows.length === 0 && /Nobody is away/.test(n2.empty), "an empty week says so", n2.empty);
      await h.page.evaluate(() => document.getElementById("awayTodayBtn").click());
      await settle(h.page, 700);
      const back = await read(h.page);
      ok(back.title === "This week" && back.rows.length === v.rows.length, "This week returns", back.title);
      await h.page.evaluate(() => document.getElementById("awayPrevBtn").click());
      await settle(h.page, 700);
      const last = await read(h.page);
      ok(last.title === "Last week" && last.rows.some(r => r.name === "Lina Noor"), "‹ steps back a week", JSON.stringify(last));
    }

    const fit = await h.page.evaluate(() => {
      const sec = document.getElementById("csec-admin-away");
      const over = [...sec.querySelectorAll("*")].filter(el => {
        const b = el.getBoundingClientRect();
        return b.width && (b.right > innerWidth + 0.5 || b.left < -0.5);
      }).map(el => el.className || el.tagName);
      return { over, scrollX: document.documentElement.scrollWidth > innerWidth };
    });
    ok(!fit.over.length && !fit.scrollX, `${label}: nothing runs off the screen`, JSON.stringify(fit));
    ok(h.errors.length === 0, `${label}: no script errors`, h.errors.join(" | "));
    await h.page.screenshot({ path: require("path").join(require("os").tmpdir(), `whos-away-${label.replace(" ", "-")}.png`) });
    await h.close();
  }

  // An employee has no Admin screen, so no Who's Away either.
  {
    const h = await boot({ meId: sara.id, seed: { profiles: people, entries,
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })) } });
    await settle(h.page, 700);
    const visible = await h.page.evaluate(() => {
      const b = document.getElementById("cnav-admin-away");
      return !!b && b.getClientRects().length > 0;
    });
    ok(!visible, "an employee never sees Who's Away");
    await h.close();
  }

  console.log(`  whos-away  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
