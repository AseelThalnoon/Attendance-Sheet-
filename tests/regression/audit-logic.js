// Regression tests for the calculation defects found in the 2026-08-15 audit.
//
// Every subject is extracted verbatim from the shipping source (see
// ../extract.js) rather than reimplemented — an earlier version of this suite
// reimplemented the streak loop and the leave sum and consequently could not see
// the fixes at all, which is exactly the trap these anchors avoid.
const vm = require("vm");
const { slice } = require("../extract");

const code = [
  slice('var DAY_NAMES = ["Sun"', "var THEME_KEY"),
  slice("var DEFAULT_SETTINGS = {", "// ---------- Auth"),
  "var settings = Object.assign({}, DEFAULT_SETTINGS);",
  "var entries = [];",
  slice("function pad2(n)", "// Display-only."),
  slice("function timeToMinutes(t)", "// Display-only."),
  slice("function formatTime12(t)", "function minutesToHoursStr"),
  slice("function minutesToHoursStr(mins)", "// For values that are naturally"),
  slice("function dateFromStr(s)", "function fmtDate(s)"),
  slice("function isScheduled(dateStr)", "// Resolves the schedule"),
  slice("function scheduleFor(dateStr)", "function scheduleSummary()"),
  slice("function computeEntry(e)", "function weekStartDow"),
  slice("function weekStartDow()", "function weekKey(dateStr)"),
  slice("function summarize(list)", "function groupBy(list, keyFn)"),
  slice("function yearKey(dateStr)", "function monthLabel(key)"),
  "var __prompted = null;",
  "function showConfirm(msg, opts){ __prompted = {msg:msg, opts:opts}; return Promise.resolve(true); }",
  slice("var LONG_SHIFT_MIN", 'document.getElementById("cancelEditBtn")'),
].join("\n");

const sandbox = { Date, Math, JSON, String, Number, isFinite, isNaN, parseFloat, parseInt, Array, Object };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const { computeEntry, summarize, minutesToHoursStr, isScheduled,
        dateToStr, confirmLongShift, weekStartDow, settings } = sandbox;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(ok) pass++; else { fail++; failures.push(`${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function ok(cond, name, detail){
  if(cond) pass++; else { fail++; failures.push(`${name}${detail ? "\n      " + detail : ""}`); }
}

const entry = (o) => Object.assign({clockIn:"", clockOut:"", type:"regular", note:""}, o);

(async () => {

// ---------------------------------------------------------------- C-4
// The three figures printed side by side on every period card must reconcile.
// Regression: a Regular day with no usable hours used to add its target to
// targetSum while contributing nothing to diffSum, so a card could read
// Total 16h / Target 32h / Overtime 0h, and a fully missed workday moved the
// overtime bank by exactly zero.
{
  const shapes = [
    [entry({date:"2026-08-10", clockIn:"08:00", clockOut:"16:00"}),
     entry({date:"2026-08-11", clockIn:"08:00"}),                       // never clocked out
     entry({date:"2026-08-12"})],                                        // blank imported row
    [entry({date:"2026-08-10", clockIn:"08:00", clockOut:"17:00", type:"wfh"}),
     entry({date:"2026-08-11", clockIn:"09:00", clockOut:"13:00", type:"halfleave"}),
     entry({date:"2026-08-12", type:"leave"})],
    [entry({date:"2026-08-10", clockIn:"22:00", clockOut:"06:00"}),      // overnight
     entry({date:"2026-08-13", clockIn:"08:00", clockOut:"16:00", type:"training"})],
    [],
  ];
  shapes.forEach((list, i) => {
    const s = summarize(list);
    ok(s.workedSum - s.targetSum === s.diffSum,
      `C-4 shape ${i+1}: Total - Target === Diff`,
      `${s.workedSum} - ${s.targetSum} !== ${s.diffSum}`);
  });
}

// A whole missed workday must move the overtime bank.
{
  const a = summarize([entry({date:"2026-08-10", clockIn:"08:00", clockOut:"16:00"})]);
  const b = summarize([entry({date:"2026-08-10", clockIn:"08:00", clockOut:"16:00"}),
                       entry({date:"2026-08-11"})]);
  ok(b.diffSum < a.diffSum, "C-4 an unlogged workday reduces the overtime bank",
    `with=${b.diffSum} without=${a.diffSum}`);
  eq(b.incompleteDays, 1, "C-4 the incomplete day is counted and surfaced");
}

// Work done away from the desk still counts as work.
{
  const s = summarize([
    entry({date:"2026-08-10", clockIn:"08:00", clockOut:"17:00", type:"wfh"}),
    entry({date:"2026-08-11", clockIn:"08:00", clockOut:"17:00", type:"trip"}),
    entry({date:"2026-08-12", clockIn:"08:00", clockOut:"17:00", type:"training"}),
  ]);
  eq(s.loggedDays, 3, "C-4 WFH / trip / training count toward the average");
  eq(s.workedSum, 27 * 60, "C-4 their hours reach the monthly total");
}

// ---------------------------------------------------------------- B-11
// A trip or training day with no clock times is credited, not booked as a
// full-day shortfall — but a genuinely unlogged Regular day still is.
{
  const week = ["2026-08-09","2026-08-10","2026-08-11","2026-08-12","2026-08-13"];
  const training = summarize(week.map(d => entry({date:d, type:"training"})));
  eq(training.diffSum, 0, "B-11 a training week is not a week of missed target");
  eq(training.incompleteDays, 0, "B-11 credited days are not flagged incomplete");

  const missed = summarize(week.map(d => entry({date:d})));
  ok(missed.diffSum < 0, "B-11 a genuinely unlogged week is still a shortfall",
    `diffSum=${missed.diffSum}`);
  eq(missed.incompleteDays, 5, "B-11 all five are flagged incomplete");
}

// ---------------------------------------------------------------- B-6
// An in-progress day is held back rather than scored as on time, so the On Time
// tab cannot report a clean record that flips to "late" after clock-out.
{
  const open = computeEntry(entry({date:"2026-08-10", clockIn:"11:30"}));
  eq(open.pending, true, "B-6 an open day is marked pending");

  const s = summarize([entry({date:"2026-08-10", clockIn:"11:30"})]);
  eq([s.ratedDays, s.onTimeDays, s.pendingDays], [0, 0, 1],
    "B-6 a pending day is excluded from the on-time rate");

  const closed = summarize([entry({date:"2026-08-10", clockIn:"11:30", clockOut:"15:00"})]);
  eq([closed.ratedDays, closed.lateDays], [1, 1],
    "B-6 once clocked out short, the day is assessed as late");
}

// ---------------------------------------------------------------- H-14
// Leave is charged against scheduled workdays only. "Apply to Everyone" writes
// every calendar day in its range, which used to bill weekends against the
// employee's statutory entitlement.
{
  const range = [];
  for(let d = 9; d <= 15; d++) range.push(entry({date:`2026-08-${String(d).padStart(2,"0")}`, type:"leave"}));
  const charged = range.filter(e => isScheduled(e.date)).length;
  eq(charged, 5, "H-14 only the five scheduled workdays in a Sun-Sat range are chargeable");
}

// ---------------------------------------------------------------- H-5
// Transposed clock times are caught before saving; genuine shifts are not
// interrupted.
{
  const prompt = () => sandbox.__prompted;
  const reset  = () => { sandbox.__prompted = null; };

  reset(); await confirmLongShift({clockIn:"16:00", clockOut:"08:00"});
  ok(prompt() && /swapped/.test(prompt().msg),
    "H-5 a transposed 16:00/08:00 entry prompts before saving");

  reset(); await confirmLongShift({clockIn:"08:00", clockOut:"16:00"});
  eq(prompt(), null, "H-5 a normal 8h day saves without a prompt");

  reset(); await confirmLongShift({clockIn:"22:00", clockOut:"06:00"});
  eq(prompt(), null, "H-5 a routine 8h night shift saves without a prompt");

  reset();
  const confirmed = await confirmLongShift({clockIn:"20:00", clockOut:"10:00"});
  ok(prompt() !== null && confirmed === true,
    "H-5 a genuinely long shift prompts but can be confirmed through");
}

// ---------------------------------------------------------------- B-7
// The week starts on the first configured working day, not always Sunday.
{
  const cases = [
    [[0,1,2,3,4], 0, "Sun-Thu"],
    [[1,2,3,4,5], 1, "Mon-Fri"],
    [[6,0,1,2,3], 6, "Sat-Wed (wraps the week boundary)"],
    [[1,3,5],     1, "Mon/Wed/Fri (non-contiguous)"],
    [[2],         2, "Tue only"],
  ];
  for(const [workDays, expected, label] of cases){
    settings.workDays = workDays;
    eq(weekStartDow(), expected, `B-7 week starts correctly for ${label}`);
  }
  settings.workDays = [0,1,2,3,4];
}

// ---------------------------------------------------------------- H-7 display
// An unrecognised day type must not render as the literal word "undefined".
{
  eq(sandbox.typeLabel("regular"), "Regular", "H-7 known types keep their label");
  eq(sandbox.typeLabel("nonsense"), "nonsense", "H-7 unknown types fall back to the raw value");
  eq(sandbox.typeLabel(""), "Regular", "H-7 an empty type falls back to Regular");
  ok(String(sandbox.typeLabel("zzz")).indexOf("undefined") === -1,
    "H-7 no code path renders the literal string 'undefined'");
}

console.log(`  audit-logic  pass ${pass}   fail ${fail}`);
if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
})();
