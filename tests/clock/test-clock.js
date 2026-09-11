// punchClock(): a double tap must never fire two punches, from ANY of the three
// clock controls (Overview panel, sticky mobile bar, bottom-nav button), for the
// whole duration of the call. There were five until the panel and the sticky bar
// stopped offering a fixed In/Out pair and started carrying the one action that
// is actually available — same guarantee, one state model instead of two. The buttons are re-disabled synchronously and
// re-enabled in finally{} — but punchInFlight, not button state, is the real
// guard (see the "caller that doesn't go through the buttons" block below),
// and stays true regardless of what anything else does to the buttons in
// between.
//
// Taps are driven as real DOM clicks. Calling punchClock() directly would
// bypass the disabled buttons and prove nothing.
const { chromium } = require("playwright");
const { OUT } = require("./build-harness");

const PAGE = "file://" + OUT;
const IDS = ["qcClockBtn", "stickyClockBtn", "bnClockBtn"];

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
  const before = await states(page);
  eq(allEnabled(before), true, "all three clock controls start enabled");
  eq(before._bnHasDisabledClass, false, "bottom-nav button starts without .disabled");
  eq(before._bnPointerEvents, "auto", "bottom-nav button starts clickable (measured)");

  // ---------- while the save itself is in flight ----------
  await page.click("#qcClockBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  const during = await states(page);
  eq(allDisabled(during), true, "all three disabled while the save is in flight");
  eq(during._bnHasDisabledClass, true, "bottom-nav button gets .disabled in flight");
  eq(during._bnPointerEvents, "none", "bottom-nav button is pointer-inert in flight (measured)");
  eq(during._bnOpacity, 0.45, "bottom-nav button dims to .45 in flight (measured)");

  await tapAll(page);
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "tapping all five during the save fires no second save");

  await page.evaluate(() => window.__resolveSave({ date: "2026-08-14", clockIn: "09:00", type: "regular" }));
  await page.waitForFunction(() => window.__applyCalls === 1);
  await page.waitForTimeout(60);
  const after = await states(page);
  eq(allEnabled(after), true, "all five re-enabled once the punch completes");
  eq(after._bnPointerEvents, "auto", "bottom-nav button clickable again (measured)");

  // ---------- a caller that doesn't go through the buttons ----------
  // Disabled buttons only stop taps, and punchClock is also reachable
  // programmatically — so the punchInFlight flag, not the button state, is
  // what actually serialises punches. Proven below by re-enabling the buttons
  // out from under a pending save and showing a second tap still fires nothing.
  await page.goto(PAGE);
  await page.click("#qcClockBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  page.evaluate(() => window.punchClock("in"));
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "a direct punchClock() call during a pending save is refused by the flag");

  // The buttons being re-enabled mid-call must not re-open the window either.
  await page.evaluate(() => {
    ["qcClockBtn", "stickyClockBtn"]
      .forEach(id => { document.getElementById(id).disabled = false; });
    const bn = document.getElementById("bnClockBtn");
    bn.classList.remove("disabled"); bn.disabled = false;
  });
  await tapAll(page);
  await page.waitForTimeout(60);
  eq(await saves(page), 1, "taps fire no second save even if the buttons get re-enabled mid-call");
  await page.evaluate(() => window.__resolveSave({ date: "2026-08-14", clockIn: "09:00", type: "regular" }));
  await page.waitForTimeout(60);

  // ---------- failure path: finally{} must restore everything ----------
  await page.goto(PAGE);
  await page.click("#qcClockBtn");
  await page.waitForFunction(() => window.__saveCalls === 1);
  eq(allDisabled(await states(page)), true, "all three disabled in flight (failure path)");
  // A failure the server WILL keep rejecting — a permission error, not a
  // dropped connection. Queueing this would wedge the outbox forever, so it
  // must still surface as an error the way it always did.
  await page.evaluate(() => window.__rejectSave(new Error("permission denied for table entries")));
  await page.waitForTimeout(60);
  const afterFail = await states(page);
  eq(allEnabled(afterFail), true, "all three re-enabled after a failed save");
  eq(afterFail._bnHasDisabledClass, false, "bottom-nav .disabled removed after failure");
  eq(await page.evaluate(() => window.__toasts.length > 0), true, "a failed save surfaces an error toast");
  eq(await page.evaluate(() => outbox.length), 0, "a rejected punch is NOT queued for retry");

  // A punch must still be possible after a failure — the flag can't wedge on.
  await page.click("#qcClockBtn");
  await page.waitForTimeout(60);
  eq(await saves(page), 2, "a new punch works after a failed one (flag was released)");

  // ---------- a punch with no connection ----------
  // The gap this closes: a punch used to be announced as failed and then lost.
  // A clock-in is the one write that cannot be repeated later, because the
  // whole value of it is the minute it happened.
  await page.goto(PAGE);
  await page.click("#qcClockBtn");
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
  await page.click("#qcClockBtn");
  await page.waitForTimeout(60);
  eq(await page.evaluate(() => outbox.length), 1, "punching again while offline replaces the queued punch rather than stacking one");

  // navigator.onLine === false must skip the request entirely — a punch should
  // not sit through a fetch timeout before being saved.
  await page.goto(PAGE);
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, "onLine", { get: () => false, configurable: true });
  });
  await page.click("#qcClockBtn");
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
  // Driven through window.punchClock("out") rather than a button, because the
  // buttons are no longer able to ask for a clock-out that isn't available —
  // and because these two callers genuinely exist and have no button in
  // between: the installed icon's ?action=out shortcut (consumeShortcutAction)
  // and the push notification's "Clock Out" action. They are the reason the
  // guard lives in punchClock and not in the renderer.
  const punchOutWith = async (rows) => {
    await page.goto(PAGE);
    await page.evaluate(list => {
      entries.length = 0;
      list.forEach(r => entries.push(r));
      renderClockControls();
    }, rows);
    const state = await page.evaluate(() => clockSurfaceState());
    const offered = await page.evaluate(() =>
      document.getElementById("qcClockBtn").getAttribute("data-clock-action"));
    page.evaluate(() => window.punchClock("out"));
    await page.waitForTimeout(120);
    if(!await page.evaluate(() => window.__saveCalls > 0)){
      return { refused: true, state, offered,
               toast: await page.evaluate(() => window.__toasts[0] || null) };
    }
    const saved = await page.evaluate(() => window.__saveArgs[0]);
    await page.evaluate(() => window.__resolveSave({ date: "2026-08-14" }));
    await page.waitForTimeout(30);
    return { refused: false, state, offered, saved };
  };

  const overnight = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "regular", note: "" }
  ]);
  eq(overnight.refused, false, "an overnight shift can still be closed");
  eq(overnight.saved.date, "2026-08-13", "a clock-out closes yesterday's open shift, not a new row on today");
  eq(overnight.saved.clockIn, "22:00", "closing yesterday keeps the clock-in that opened it");
  eq(overnight.saved.clockOut, "09:00", "closing yesterday writes the clock-out");
  eq(overnight.state, "out", "the controls read an overnight shift as closeable");
  eq(overnight.offered, "out", "and offer exactly that action");

  const ownShift = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "regular", note: "" },
    { id: "e2", date: "2026-08-14", clockIn: "08:30", clockOut: "", type: "regular", note: "" }
  ]);
  eq(ownShift.saved.date, "2026-08-14", "a shift open today is closed on today even with yesterday still open");

  // ---------- the row punchClock must never write ----------
  // These three cases used to assert the opposite: that a clock-out with
  // nothing open "still lands on today". What that produced was a permanent
  // row with a clock-out and no clock-in — workedMin null, drawn as missing on
  // the calendar, removable only by hand. resolveOvernightTarget's own comment
  // says it exists to prevent exactly that shape; its guard only ever fired
  // when yesterday HAD an open shift, so every other path fell straight
  // through. The behaviour is the fix, and these now pin it down.
  const forgotten = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "08:00", clockOut: "", type: "regular", note: "" }
  ]);
  eq(forgotten.refused, true, "a clock-in 25 hours old is a forgotten punch: refused, not written onto today");
  eq(forgotten.state, "in", "and the controls offer a clock-in instead");
  eq(/still open/i.test(forgotten.toast || ""), true,
     "the refusal points at the reminder that owns a forgotten punch: " + JSON.stringify(forgotten.toast));

  const excused = await punchOutWith([
    { id: "e1", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "leave", note: "" }
  ]);
  eq(excused.refused, true, "an excused day is never an open shift to close");
  eq(excused.state, "in", "and the controls offer a clock-in");

  const nothing = await punchOutWith([]);
  eq(nothing.refused, true, "with nothing open at all, a clock-out is refused rather than writing an orphan row");
  eq(/no open shift/i.test(nothing.toast || ""), true,
     "and says why: " + JSON.stringify(nothing.toast));

  // ---------- the three states the controls can be in ----------
  const stateFor = async (rows) => {
    await page.goto(PAGE);
    return page.evaluate(list => {
      entries.length = 0;
      list.forEach(r => entries.push(r));
      renderClockControls();
      const qc = document.getElementById("qcClockBtn");
      return {
        state: clockSurfaceState(),
        action: qc.getAttribute("data-clock-action"),
        clockHidden: qc.hidden,
        editHidden: document.getElementById("qcEditBtn").hidden,
        doneHidden: document.getElementById("qcDoneText").hidden,
        doneText: document.getElementById("qcDoneText").textContent,
        label: document.getElementById("qcClockLabel").textContent,
        aria: document.getElementById("bnClockBtn").getAttribute("aria-label")
      };
    }, rows);
  };

  const fresh = await stateFor([]);
  eq(fresh.state, "in", "an empty day is in the clock-in state");
  eq(fresh.label, "Clock In Now", "and the button says so");
  eq(fresh.clockHidden, false, "the punch button is present");
  eq(fresh.editHidden, true, "with no edit affordance");
  eq(fresh.aria, "Clock in", "the nav button announces the action, not a static label");

  const open = await stateFor([
    { id: "e1", date: "2026-08-14", clockIn: "08:30", clockOut: "", type: "regular", note: "" }
  ]);
  eq(open.state, "out", "an open shift is in the clock-out state");
  eq(open.label, "Clock Out Now", "and the button says so");
  eq(open.aria, "Clock out", "the nav button follows");

  // The state that did not exist before: a finished day. The old model knew
  // only open/not-open, so it showed "Clock In" here — and pressing it offered
  // to overwrite the day's own start time.
  const done = await stateFor([
    { id: "e1", date: "2026-08-14", clockIn: "08:30", clockOut: "17:00", type: "regular", note: "" }
  ]);
  eq(done.state, "done", "a day with both punches is finished");
  eq(done.clockHidden, true, "the punch button steps aside rather than offering to overwrite the shift");
  eq(done.editHidden, false, "an explicit edit takes its place");
  eq(done.doneHidden, false, "and the panel reports the shift");
  eq(/Clocked out 17:00/.test(done.doneText), true, "naming the time it ended: " + JSON.stringify(done.doneText));
  eq(done.action, "edit", "so a tap edits the day instead of punching it");

  // A control must never offer an action the punch would refuse.
  await page.goto(PAGE);
  const agree = await page.evaluate(() => {
    const cases = [
      [],
      [{ id: "a", date: "2026-08-14", clockIn: "08:30", clockOut: "", type: "regular", note: "" }],
      [{ id: "b", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "regular", note: "" }],
      [{ id: "c", date: "2026-08-13", clockIn: "08:00", clockOut: "", type: "regular", note: "" }],
      [{ id: "d", date: "2026-08-13", clockIn: "22:00", clockOut: "", type: "leave", note: "" }],
      [{ id: "e", date: "2026-08-14", clockIn: "08:30", clockOut: "17:00", type: "regular", note: "" }]
    ];
    return cases.every(list => {
      entries.length = 0;
      list.forEach(r => entries.push(r));
      renderClockControls();
      const offersOut = document.getElementById("qcClockBtn").getAttribute("data-clock-action") === "out";
      const canClose  = openShiftTarget(todayStr(), nowTimeStr()) !== null;
      return offersOut === canClose;
    });
  });
  eq(agree, true, "the control offers 'out' exactly when openShiftTarget says a shift can be closed");

  await browser.close();
  console.log(`  clock     pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
