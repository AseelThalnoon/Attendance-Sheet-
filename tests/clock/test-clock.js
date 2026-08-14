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
  await page.evaluate(() => window.__rejectSave(new Error("network down")));
  await page.waitForTimeout(60);
  const afterFail = await states(page);
  eq(allEnabled(afterFail), true, "all five re-enabled after a failed save");
  eq(afterFail._bnHasDisabledClass, false, "bottom-nav .disabled removed after failure");
  eq(await page.evaluate(() => window.__toasts.length > 0), true, "a failed save surfaces an error toast");

  // A punch must still be possible after a failure — the flag can't wedge on.
  await page.click("#clockInBtn");
  await page.waitForTimeout(60);
  eq(await saves(page), 2, "a new punch works after a failed one (flag was released)");

  await browser.close();
  console.log(`  clock     pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
