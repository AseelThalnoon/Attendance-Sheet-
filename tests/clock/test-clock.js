// punchClock(): a double tap must never fire two punches, from ANY of the five
// clock controls (desktop pair, sticky mobile bar, bottom-nav button), for the
// whole duration of the call — including the post-save reload, during which
// updateViewingBanner() re-enables every button before finally{} runs.
//
// Taps are driven as real DOM clicks. Calling punchClock() directly would
// bypass the disabled buttons and prove nothing.
const { chromium } = require("playwright");
const { OUT } = require("./build-harness");

const PAGE = "file://" + OUT;
const IDS = ["clockInBtn", "clockOutBtn", "stickyClockInBtn", "stickyClockOutBtn", "bnClockBtn"];

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if(a === e) pass++;
  else { fail++; failures.push(`${label}\n     expected: ${e}\n     actual:   ${a}`); }
}

const states = page => page.evaluate(ids => {
  const out = {};
  ids.forEach(id => { out[id] = document.getElementById(id).disabled; });
  const bn = document.getElementById("bnClockBtn");
  out._bnHasDisabledClass = bn.classList.contains("disabled");
  out._bnPointerEvents = getComputedStyle(bn).pointerEvents;
  out._bnOpacity = Number(getComputedStyle(bn).opacity);
  return out;
}, IDS);
const allDisabled = s => IDS.every(id => s[id] === true);
const allEnabled = s => IDS.every(id => s[id] === false);

// A disabled button swallows el.click() exactly as it swallows a real tap.
const tapAll = page => page.evaluate(ids => ids.forEach(id => document.getElementById(id).click()), IDS);
const saves = page => page.evaluate(() => window.__saveCalls);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // ---------- baseline ----------
  await page.goto(PAGE);
  await page.evaluate(() => { window.__skipReload = true; });
  const before = await states(page);
  eq(allEnabled(before), true, "all five clock controls start enabled");
  eq(before._bnHasDisabledClass, false, "bottom-nav button starts without .disabled");
  eq(before._bnPointerEvents, "auto", "bottom-nav button starts clickable (measured)");

  // ---------- while the save itself is in flight ----------
  await page.click("#clockInBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  const during = await states(page);
  eq(allDisabled(during), true, "all five disabled while the save is in flight");
  eq(during._bnHasDisabledClass, true, "bottom-nav button gets .disabled in flight");
  eq(during._bnPointerEvents, "none", "bottom-nav button is pointer-inert in flight (measured)");
  eq(during._bnOpacity, 0.45, "bottom-nav button dims to .45 in flight (measured)");

  await tapAll(page);
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "tapping all five during the save fires no second save");

  await page.evaluate(() => window.__resolveSave({ date: "2026-08-14", clockIn: "09:00", type: "regular" }));
  await page.waitForFunction(() => window.__reloadCalls === 1);
  await page.waitForTimeout(60);
  const after = await states(page);
  eq(allEnabled(after), true, "all five re-enabled once the punch completes");
  eq(after._bnPointerEvents, "auto", "bottom-nav button clickable again (measured)");

  // ---------- a caller that doesn't go through the buttons ----------
  // Disabled buttons only stop taps. punchClock is also reachable
  // programmatically, and updateViewingBanner() re-enables every button mid-
  // call (index.html:4895-4901) — so the punchInFlight flag, not the button
  // state, is what actually serialises punches.
  await page.goto(PAGE);
  await page.evaluate(() => { window.__skipReload = true; });
  await page.click("#clockInBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  page.evaluate(() => window.punchClock("in"));
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "a direct punchClock() call during a pending save is refused by the flag");

  // The buttons being re-enabled mid-call must not re-open the window either.
  await page.evaluate(() => {
    ["clockInBtn", "clockOutBtn", "stickyClockInBtn", "stickyClockOutBtn"]
      .forEach(id => { document.getElementById(id).disabled = false; });
    document.getElementById("bnClockBtn").classList.remove("disabled");
  });
  await tapAll(page);
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "taps fire no second save even if the buttons get re-enabled mid-call");
  await page.evaluate(() => window.__resolveSave({ date: "2026-08-14", clockIn: "09:00", type: "regular" }));
  await page.waitForTimeout(60);

  // ---------- failure path: finally{} must restore everything ----------
  await page.goto(PAGE);
  await page.evaluate(() => { window.__skipReload = true; });
  await page.click("#clockOutBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  eq(allDisabled(await states(page)), true, "all five disabled in flight (failure path)");
  // A failure the server WILL keep rejecting — a permission error, not a
  // dropped connection. Queueing this would wedge the outbox forever, so it
  // must still surface as an error the way it always did.
  await page.evaluate(() => window.__rejectSave(new Error("permission denied for table entries")));
  await page.waitForTimeout(60);
  const afterFail = await states(page);
  eq(allEnabled(afterFail), true, "all five re-enabled after a failed save");
  eq(afterFail._bnHasDisabledClass, false, "bottom-nav .disabled removed after failure");
  eq(await page.evaluate(() => window.__toasts.length > 0), true, "a failed save surfaces an error toast");
  eq(await page.evaluate(() => outbox.length), 0, "a rejected punch is NOT queued for retry");

  // A punch must still be possible after a failure — the flag can't wedge on.
  await page.click("#clockInBtn");
  await page.waitForTimeout(60);
  eq(await saves(page), 2, "a new punch works after a failed one (flag was released)");

  // ---------- a punch with no connection ----------
  // The gap this closes: a punch used to be announced as failed and then lost.
  // A clock-in is the one write that cannot be repeated later, because the
  // whole value of it is the minute it happened.
  await page.goto(PAGE);
  await page.evaluate(() => { window.__skipReload = true; });
  await page.click("#clockInBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  await page.evaluate(() => window.__rejectSave(new TypeError("Failed to fetch")));
  await page.waitForTimeout(60);
  eq(await page.evaluate(() => outbox.length), 1, "a punch lost to the network is queued, not dropped");
  eq(await page.evaluate(() => (outbox[0] || {}).field || null), "clockIn", "the queued punch records which half of the shift it is");
  eq(await page.evaluate(() => (outbox[0] || {}).time  || null), "09:00", "the queued punch keeps the time it was made, not the time it uploads");
  eq(await page.evaluate(() => window.__toasts.length), 0, "a queued punch is not reported as an error");
  eq(await page.evaluate(() => window.__notes.length > 0), true, "a queued punch still confirms to the person who made it");

  // Tapping again with no signal must not stack duplicates: the server would
  // have collapsed repeats into one value, so the queue does too.
  await page.click("#clockInBtn");
  await page.waitForTimeout(60);
  eq(await page.evaluate(() => outbox.length), 1, "punching again while offline replaces the queued punch rather than stacking one");

  // navigator.onLine === false must skip the request entirely — a punch should
  // not sit through a fetch timeout before being saved.
  await page.goto(PAGE);
  await page.evaluate(() => {
    window.__skipReload = true;
    Object.defineProperty(window.navigator, "onLine", { get: () => false, configurable: true });
  });
  await page.click("#clockOutBtn");
  await page.waitForTimeout(60);
  eq(await page.evaluate(() => window.__saveCalls), 0, "a known-offline device does not spend a request first");
  eq(await page.evaluate(() => outbox.length), 1, "a known-offline punch goes straight to the queue");

  // ---------- which calendar day a clock-out lands on ----------
  // A shift that starts before midnight and ends after it belongs to the day it
  // STARTED. punchClock used to write every clock-out to today unconditionally,
  // which left the real shift open forever and put a clock-out with no clock-in
  // on today — a row computeEntry returns open:false, workedMin:null for, and
  // the Log draws as a broken line. The harness pins "now" at 2026-08-14 09:00,
  // so a 22:00 clock-in yesterday is an 11-hour overnight shift and an 08:00 one
  // is a 25-hour impossibility.
  const punchOutWith = async (rows) => {
    await page.goto(PAGE);
    await page.evaluate(list => {
      window.__skipReload = true;
      entries.length = 0;
      list.forEach(r => entries.push(r));
    }, rows);
    await page.click("#clockOutBtn");
    await page.waitForFunction(() => window.__saveCalls === 1);
    const saved = await page.evaluate(() => window.__saveArgs[0]);
    await page.evaluate(() => window.__resolveSave({ date: "2026-08-14" }));
    await page.waitForTimeout(30);
    return saved;
  };

  const overnight = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "regular", note: "" }
  ]);
  eq(overnight.date, "2026-08-13", "a clock-out closes yesterday's open shift, not a new row on today");
  eq(overnight.clockIn, "22:00", "closing yesterday keeps the clock-in that opened it");
  eq(overnight.clockOut, "09:00", "closing yesterday writes the clock-out");

  const ownShift = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "regular", note: "" },
    { id: "e2", date: "2026-08-14", clockIn: "08:30", clockOut: "", type: "regular", note: "" }
  ]);
  eq(ownShift.date, "2026-08-14", "a shift open today is closed on today even with yesterday still open");

  const forgotten = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "08:00", clockOut: "", type: "regular", note: "" }
  ]);
  eq(forgotten.date, "2026-08-14", "a clock-in 25 hours old is a forgotten punch, not an overnight shift");

  const excused = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "leave", note: "" }
  ]);
  eq(excused.date, "2026-08-14", "an excused day is never treated as an open shift to close");

  const nothing = await punchOutWith([]);
  eq(nothing.date, "2026-08-14", "with nothing open, a clock-out still lands on today");

  await browser.close();
  console.log(`  clock     pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
