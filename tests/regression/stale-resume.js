// A page that outlives its copy of the record.
//
// An installed app is resumed, not reopened: the page loaded yesterday is
// still the page, holding yesterday's read of the server. Nothing re-read the
// record unless someone asked, so a day clocked in from the desktop was not on
// the phone that afternoon -- the phone offered "Clock In", and pressing it
// tried to insert a second row for a day that already had one. What came back
// was the database's refusal, which pressing the button again only repeats.
//
// Two behaviours are held here, against the real app and the scripted backend:
//   * a save refused BECAUSE the screen was out of step reloads the record and
//     says so in terms of the day, instead of showing the refusal;
//   * coming back to the app after a few minutes reads the record again,
//     quietly -- and stands down rather than trample anything in progress.
//
// "Another device" is played by writing straight into the backend's tables
// after the app has loaded. Time is moved by shifting Date.now() forward in
// the page; todayStr() reads new Date(), so the calendar day stays put.
const { boot, settle, goTab, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Sam Stale" });
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ds(new Date());

// Twelve ordinary days ending yesterday. Nothing for today: that is the row
// "another device" is about to add.
function history(){
  const out = [];
  for(let i = 12; i >= 1; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push({ id: "h" + i, user_id: me.id, date: ds(d), clock_in: "08:00", clock_out: "16:00",
      type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z" });
  }
  return out;
}
const seed = () => ({ profiles: [me], entries: history(),
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] });

const entryReads = h => h.backend.state.log.filter(l => l.method === "GET" && l.path === "/rest/v1/entries").length;
const toasts = page => page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()));
const clockAction = page => page.evaluate(() => document.getElementById("qcClockBtn").getAttribute("data-clock-action"));
const elsewhereClockIn = h => h.backend.state.entries.push({ id: "other-device", user_id: me.id, date: TODAY,
  clock_in: "08:02", clock_out: null, type: "regular", note: "", updated_at: new Date().toISOString() });

// Minutes pass. Cumulative, so a second call moves on from the first.
const passMinutes = (page, minutes) => page.evaluate(m => {
  window.__skewMs = (window.__skewMs || 0) + m * 60000;
  if(!window.__realNow){
    window.__realNow = Date.now.bind(Date);
    Date.now = () => window.__realNow() + window.__skewMs;
  }
}, minutes);
// What the browser fires when the app comes back to the front.
const comeBack = async (page, ms) => {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await settle(page, ms == null ? 700 : ms);
};

// Every app this suite opens, so the ones still open can be closed if a step
// throws: a failure has to fail the run, not leave a browser up and the
// process waiting on it for ever.
const open = new Set();
async function start(opts){
  const h = await boot(opts);
  open.add(h);
  const close = h.close;
  h.close = async () => { open.delete(h); await close(); };
  return h;
}

(async () => {
  // ---- A punch against a day another device already started -----------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    ok(await clockAction(h.page) === "in", "nothing logged today: the clock offers Clock In");
    elsewhereClockIn(h);
    await h.page.click("#qcClockBtn");
    await settle(h.page, 900);
    const said = (await toasts(h.page)).join(" | ");
    ok(/changed somewhere else/i.test(said), "the refusal is explained as the day having changed elsewhere", said);
    ok(!/already exists|duplicate key|23505/i.test(said), "and not as the database's own error", said);
    ok(await clockAction(h.page) === "out", "the record was read again: the clock now offers Clock Out");
    const todays = h.backend.state.entries.filter(e => e.user_id === me.id && e.date === TODAY);
    ok(todays.length === 1 && todays[0].clock_in === "08:02",
      "the other device's clock-in is untouched, and there is still one row for today", JSON.stringify(todays));
    const locked = await h.page.evaluate(() => document.getElementById("qcClockBtn").disabled);
    ok(locked === false, "the clock is usable again once the reload has finished");
    ok(h.errors.filter(e => !/409/.test(e)).length === 0, "stale punch: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Saving an edit to a day that was deleted elsewhere -------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    await goTab(h.page, "log");
    const before = await h.page.evaluate(() => document.querySelectorAll("#logBody tr[data-entry-id]").length);
    const editedId = await h.page.evaluate(() => {
      const btn = document.querySelector("#logBody button[data-edit]");
      btn.click();
      return btn.getAttribute("data-edit");
    });
    await settle(h.page, 400);
    h.backend.state.entries = h.backend.state.entries.filter(e => String(e.id) !== String(editedId));
    await h.page.fill("#fNote", "typed while the row was being deleted elsewhere");
    await h.page.click("#submitBtn");
    await settle(h.page, 900);
    const said = (await toasts(h.page)).join(" | ");
    ok(/changed somewhere else/i.test(said), "saving over a deleted day is explained the same way", said);
    ok(!/JSON object requested|PGRST116|Cannot read/i.test(said), "and never as PostgREST's wording", said);
    const after = await h.page.evaluate(() => document.querySelectorAll("#logBody tr[data-entry-id]").length);
    ok(after === before - 1, "the Log was read again and no longer lists the deleted day", `${before} -> ${after}`);
    const kept = await h.page.evaluate(() => document.getElementById("fNote").value);
    ok(/typed while/.test(kept), "what was typed is still in the form, to be saved again or dropped", kept);
    await h.close();
  }

  // ---- Coming back to the app -----------------------------------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    elsewhereClockIn(h);

    let reads = entryReads(h);
    await comeBack(h.page);
    ok(entryReads(h) === reads, "back within moments: the copy on screen is fresh enough, nothing is re-read",
      `reads ${reads} -> ${entryReads(h)}`);
    ok(await clockAction(h.page) === "in", "(so the other device's punch is not on screen yet)");

    await passMinutes(h.page, 6);
    await comeBack(h.page, 900);
    ok(entryReads(h) === reads + 1, "back after six minutes: the record is read again, once",
      `reads ${reads} -> ${entryReads(h)}`);
    ok(await clockAction(h.page) === "out", "and the clock picks up the punch made on the other device");
    const said = await toasts(h.page);
    ok(said.length === 0, "quietly: no toast for a refresh nobody asked for", said.join(" | "));
    const skeleton = await h.page.evaluate(() => !!document.querySelector(".is-loading"));
    ok(!skeleton, "and no loading skeletons left on the screen");

    reads = entryReads(h);
    await comeBack(h.page);
    ok(entryReads(h) === reads, "a second return straight after does not read it all again");
    ok(h.errors.length === 0, "resume: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- It stands down for a form somebody is filling in ----------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    await goTab(h.page, "settings");
    await h.page.click("#cnav-hours");
    await settle(h.page, 300);
    await h.page.fill("#sTargetH", "6");
    await passMinutes(h.page, 6);
    let reads = entryReads(h);
    await comeBack(h.page);
    ok(entryReads(h) === reads, "Settings open: no background refresh");
    const typed = await h.page.evaluate(() => document.getElementById("sTargetH").value);
    ok(typed === "6", "so a half-edited schedule is not refilled from the saved one", "sTargetH=" + typed);

    await goTab(h.page, "overview");
    reads = entryReads(h);
    await comeBack(h.page, 900);
    ok(entryReads(h) === reads + 1, "off Settings, the next return catches up");
    await h.close();
  }

  // ---- A refresh that fails leaves the screen as it was ----------------------
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    await goTab(h.page, "log");
    const before = await h.page.evaluate(() => document.querySelectorAll("#logBody tr[data-entry-id]").length);
    h.backend.fail("/rest/v1/entries", { status: 500, message: "boom" });
    await passMinutes(h.page, 6);
    await comeBack(h.page, 900);
    const state = await h.page.evaluate(() => ({
      rows: document.querySelectorAll("#logBody tr[data-entry-id]").length,
      failNotice: document.getElementById("loadFailBanner").classList.contains("show"),
      toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent.trim())
    }));
    ok(state.rows === before && before > 0, "a failed background refresh keeps the days already on screen",
      `${before} -> ${state.rows}`);
    ok(!state.failNotice && state.toasts.length === 0,
      "and raises neither the failed-load notice nor a toast", JSON.stringify(state));
    h.backend.clearFaults();
    await h.close();
  }

  // ---- A refresh overtaken by a punch is thrown away -------------------------
  // The request is in the air when the person clocks in with no connection.
  // That punch is on this device only; the answer still on its way from the
  // server does not have it, and painting it would show "not clocked in" to
  // someone who just clocked in.
  {
    const h = await start({ viewport: DESKTOP, meId: me.id, seed: seed() });
    await passMinutes(h.page, 6);
    h.backend.fail("/rest/v1/entries", { delayMs: 900 }, 1);
    await h.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await h.page.waitForTimeout(120);
    await h.page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", { get: () => false, configurable: true });
    });
    await h.page.click("#qcClockBtn");
    await settle(h.page, 300);
    ok(await clockAction(h.page) === "out", "clocked in offline while a refresh was in the air");
    await settle(h.page, 1400);
    ok(await clockAction(h.page) === "out", "the late answer does not wipe the punch off the screen");
    const waiting = await h.page.evaluate(() => document.getElementById("outboxBanner").classList.contains("show"));
    ok(waiting, "and the punch is still listed as waiting to upload");
    await h.close();
  }

})().catch(err => { fail++; failures.push("suite threw: " + (err && err.message || err)); })
  .finally(async () => {
    await Promise.all([...open].map(h => h.close().catch(() => {})));
    console.log(`  stale-resume  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
