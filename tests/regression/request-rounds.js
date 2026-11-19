// Round trips, not milliseconds. The database is in Singapore and the team in
// Saudi Arabia: every request is a few hundred milliseconds there and back, so
// what decides how long a screen takes is how many requests have to wait for
// another one to come back first. Measured on 2026-11-19, with 300ms added to
// every request:
//
//   - Admin went out in four rounds (the schedules, then eight together, then
//     Who's Away, then the data checks), the last starting at 1.3s. All of
//     them need only the signed-in admin; two of them are what the others
//     need to DRAW, never to ask. One round now.
//   - An admin's open threw away the "In today" answer the sign-in had just
//     fetched (list_today_presence) and rebuilt it from today's entries and
//     everyone's schedules -- a second round for the same list.
//   - A returning open asked list_today_presence twice in its first round:
//     once from the device copy's draw, once from the sign-in's prefetch.
//   - The bell's history waited two rounds behind the record and the app
//     settings, and the Team Schedule was asked for on its own although the
//     whole app_settings row was already on its way.
//
// This suite delays every request and asserts the shape: who asks, how many
// times, and whether anything that could go in the first round waits.
require("../no-network");
const { boot, settle } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const DELAY = 300;
// A request that started within this of the first one did not wait for any
// other to come back: nothing can come back sooner than DELAY.
const SAME_ROUND = DELAY / 2;

const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = ds(new Date());

const admin = D.profile(1, { full_name: "Boss Admin", role: "admin" });
const inNow = D.profile(2, { full_name: "Sara Still In" });
const done = D.profile(3, { full_name: "Omar Went Home" });
const away = D.profile(4, { full_name: "Lina On Leave" });
const people = [admin, inNow, done, away, D.profile(5, { full_name: "Nobody Today" })];
let id = 0;
const entry = (who, date, type, cin, cout) =>
  ({ id: ++id, user_id: who.id, date, type, clock_in: cin, clock_out: cout, note: "", updated_at: "2026-01-01T00:00:00Z" });

const seed = {
  profiles: people,
  entries: D.entriesFor(admin.id, 60).filter(e => e.date < today).concat([
    entry(inNow, today, "regular", "08:00:00", null),
    entry(done, today, "regular", "07:00:00", "09:00:00"),
    entry(away, today, "leave", null, null)
  ]),
  user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
};

const key = r => r.method + " " + r.path.replace(/^\/rest\/v1\//, "") + (r.search ? decodeURIComponent(r.search) : "");
const since = (h, t0) => h.backend.state.log.filter(r => r.method !== "OPTIONS" && r.at >= t0);
const count = (log, re) => log.filter(r => re.test(key(r))).length;

(async () => {
  const t0 = Date.now();
  const h = await boot({ meId: admin.id, seed, beforeLoad: ({ backend }) => {
    backend.fail("/rest/v1/", { delayMs: DELAY });
    backend.fail("/auth/v1/", { delayMs: DELAY });
  }});
  try {
    await settle(h.page, 2500);

    // ---- An admin's first open ----------------------------------------------
    const open = since(h, t0);
    const first = Math.min(...open.map(r => r.at));
    const startOf = re => { const r = open.find(x => re.test(key(x))); return r ? r.at - first : null; };

    ok(count(open, /rpc\/list_today_presence/) === 1,
      "an admin's open asks for In today once", open.map(key).join(" | "));
    ok(count(open, new RegExp("GET entries\\?select=user_id,date,clock_in,clock_out,type&date=eq\\." + today)) === 0,
      "and does not rebuild it from today's entries");
    ok(count(open, /GET user_settings\?select=user_id,settings/) === 0,
      "or from everyone's schedules");
    const bell = startOf(/rpc\/list_my_notifications/);
    ok(bell !== null && bell < SAME_ROUND,
      "the bell's history goes with the first round", `started ${bell}ms after the first request`);
    ok(count(open, /GET app_settings\?select=default_settings/) === 0,
      "the Team Schedule comes with the app_settings row already being fetched, not on its own");

    const inToday = await h.page.evaluate(() => ({
      names: Array.from(document.querySelectorAll("#todayTeamList .tt-name")).map(n => n.textContent),
      count: document.getElementById("todayTeamCount").textContent
    }));
    ok(inToday.names.join("|") === "Omar Went Home|Sara Still In" && inToday.count === "1 in now · 1 done",
      "an admin's In today lists who clocked in (in arrival order), not who is on leave or has not come in",
      JSON.stringify(inToday));

    // ---- Admin ----------------------------------------------------------------
    const t1 = Date.now();
    await h.page.evaluate(() => document.getElementById("adminBtn").click());
    await settle(h.page, 2500);
    const adm = since(h, t1);
    const a0 = Math.min(...adm.map(r => r.at));
    const late = adm.filter(r => r.at - a0 >= SAME_ROUND).map(r => (r.at - a0) + "ms " + key(r));
    ok(adm.length >= 10 && late.length === 0,
      "every request Admin makes leaves in the first round", `${adm.length} requests; waited: ${late.join(" | ")}`);
    const drawn = await h.page.evaluate(() => ({
      people: document.querySelectorAll("#adminUsersList .admin-user-row, #adminUsersList [data-uid]").length,
      checks: (document.getElementById("adminAttentionList") || {}).textContent || "",
      away: (document.getElementById("awayList") || {}).textContent || ""
    }));
    ok(drawn.people >= people.length,
      "and the People list still draws, every person", JSON.stringify(drawn.people));
    ok(/schedule/i.test(drawn.checks),
      "the data checks still draw, with the schedules they wait for", drawn.checks.slice(0, 120));
    ok(/Lina On Leave/.test(drawn.away),
      "Who's Away still draws, with the people list it waits for", drawn.away.slice(0, 120));

    // ---- A returning open -------------------------------------------------------
    const t2 = Date.now();
    await h.page.reload();
    await h.page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
    await settle(h.page, 2500);
    const back = since(h, t2);
    ok(count(back, /rpc\/list_today_presence/) === 1,
      "a returning open asks for In today once, not once for the device copy and again for the sign-in",
      back.filter(r => /list_today_presence/.test(key(r))).map(r => (r.at - t2) + "ms").join(", "));
    const names = await h.page.evaluate(() =>
      Array.from(document.querySelectorAll("#todayTeamList .tt-name")).map(n => n.textContent).join("|"));
    ok(names === "Omar Went Home|Sara Still In", "and still lists who clocked in", names);

    ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
  } finally {
    await h.close();
  }

  console.log(`  request-rounds  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  x " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
