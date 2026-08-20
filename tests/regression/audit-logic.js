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

const { computeEntry, summarize, minutesToHoursStr, isScheduled, scheduleFor,
        targetMinPerDay, dateToStr, todayStr, confirmLongShift, weekStartDow, settings } = sandbox;

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

// A blank row (no clock times at all) is incomplete data, not a confirmed
// shortfall — it must not move the overtime bank, only be surfaced as a count.
{
  const a = summarize([entry({date:"2026-08-10", clockIn:"08:00", clockOut:"16:00"})]);
  const b = summarize([entry({date:"2026-08-10", clockIn:"08:00", clockOut:"16:00"}),
                       entry({date:"2026-08-11"})]);
  eq(b.diffSum, a.diffSum, "C-4 a blank row does not move the overtime bank");
  eq(b.incompleteDays, 1, "C-4 the incomplete day is still counted and surfaced");
}

// WFH / trip / training are neutral: logged hours on these days must not
// move the average or the monthly total either way.
{
  const s = summarize([
    entry({date:"2026-08-10", clockIn:"08:00", clockOut:"17:00", type:"wfh"}),
    entry({date:"2026-08-11", clockIn:"08:00", clockOut:"17:00", type:"trip"}),
    entry({date:"2026-08-12", clockIn:"08:00", clockOut:"17:00", type:"training"}),
  ]);
  eq(s.loggedDays, 0, "C-4 WFH / trip / training do not count toward the average");
  eq(s.workedSum, 0, "C-4 their hours do not reach the monthly total");
}

// ---------------------------------------------------------------- B-11
// A trip or training day with no clock times is excused, not booked as a
// full-day shortfall — and neither is a blank Regular row: incomplete data
// never moves the bank, only the incompleteDays count.
{
  const week = ["2026-08-09","2026-08-10","2026-08-11","2026-08-12","2026-08-13"];
  const training = summarize(week.map(d => entry({date:d, type:"training"})));
  eq(training.diffSum, 0, "B-11 a training week is not a week of missed target");
  eq(training.incompleteDays, 0, "B-11 credited days are not flagged incomplete");

  const missed = summarize(week.map(d => entry({date:d})));
  eq(missed.diffSum, 0, "B-11 a week of blank rows does not move the bank");
  eq(missed.incompleteDays, 5, "B-11 all five are still flagged incomplete");
}

// ---------------------------------------------------------------- B-6
// An in-progress day is held back rather than scored against target, so the
// Shortfall tab cannot report a clean record that flips to "short" after
// clock-out.
{
  const open = computeEntry(entry({date:"2026-08-10", clockIn:"11:30"}));
  eq(open.pending, true, "B-6 an open day is marked pending (suppresses Log highlighting)");

  const savedWorkDays = settings.workDays;
  settings.workDays = [0,1,2,3,4,5,6]; // guarantee "today" is scheduled, whenever the suite runs
  const today = todayStr();
  const s = summarize([entry({date: today, clockIn:"11:30"})]);
  eq([s.ratedDays, s.metDays, s.pendingDays], [0, 0, 1],
    "B-6 a day still in progress today is excluded from the target-met rate");
  settings.workDays = savedWorkDays;

  const closed = summarize([entry({date:"2026-08-10", clockIn:"11:30", clockOut:"15:00"})]);
  eq([closed.ratedDays, closed.shortDays], [1, 1],
    "B-6 once clocked out short, the day is assessed as short");
}

// ---------------------------------------------------------------- Shortfall tab redo
// The Shortfall tab measures whether a scheduled day reached its target
// hours — never when the person clocked in or out. A late arrival made up
// by staying later is not a shortfall; a punctual arrival that still falls
// short of the hours is, even though nothing about the clock times looks
// wrong; and a day nobody logged at all is the clearest shortfall there is,
// not an invisible one the old arrival-only check could never see.
{
  const madeUp = summarize([entry({date:"2026-08-10", clockIn:"10:00", clockOut:"19:00"})]);
  eq([madeUp.ratedDays, madeUp.shortDays, madeUp.metDays], [1, 0, 1],
    "a late arrival made up in full is not a shortfall");

  const punctualButShort = summarize([entry({date:"2026-08-10", clockIn:"08:00", clockOut:"15:00"})]);
  eq([punctualButShort.ratedDays, punctualButShort.shortDays], [1, 1],
    "a punctual day that still falls short of target is now flagged");

  const blank = summarize([entry({date:"2026-08-10"})]);
  eq([blank.ratedDays, blank.shortDays, blank.missedDays], [1, 1, 1],
    "a scheduled day with no entry at all counts as a full shortfall, not an invisible one");
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

// ---------------------------------------------------------------- overtime bank: open day in progress
// A shift still running right now hasn't failed to meet anything yet — the
// day isn't over, so it must not already read as a missed day in the bank.
// A clock-in left open from a PAST day is incomplete data too — there's no
// way to know what was actually worked — so it must not move the bank
// either; it's still surfaced via incompleteDays so it stays visible.
{
  const savedWorkDays = settings.workDays;
  settings.workDays = [0,1,2,3,4,5,6]; // guarantee "today" is scheduled, whenever the suite runs
  const today = todayStr();

  const runningToday = summarize([entry({date:today, clockIn:"09:00"})]);
  eq([runningToday.diffSum, runningToday.incompleteDays], [0, 0],
    "an in-progress shift today is held out of the bank, not booked as a miss");

  const forgottenPast = summarize([entry({date:"2026-08-10", clockIn:"09:00"})]);
  eq([forgottenPast.diffSum, forgottenPast.incompleteDays], [0, 1],
    "a stale open day from a past date does not move the bank either, but is still flagged incomplete");

  settings.workDays = savedWorkDays;
}

// ---------------------------------------------------------------- overtime bank: WFH/trip/training have no fixed target
// These are excused from a fixed daily target, and (unlike the old
// "credited" behavior) don't roll into the bank at all — 10 hours logged or
// zero, neither moves the target-accomplished rate, the average or the bank.
{
  const wfhShort = summarize([entry({date:"2026-08-10", clockIn:"09:00", clockOut:"11:00", type:"wfh"})]);
  eq([wfhShort.targetSum, wfhShort.diffSum], [0, 0],
    "a WFH day never affects the target sum or the bank, however many hours are logged");

  const tripShort = summarize([entry({date:"2026-08-11", clockIn:"09:00", clockOut:"10:00", type:"trip"})]);
  eq([tripShort.targetSum, tripShort.diffSum], [0, 0],
    "a business-trip day never affects the target sum or the bank either");

  const trainingShort = summarize([entry({date:"2026-08-12", clockIn:"09:00", clockOut:"09:30", type:"training"})]);
  eq([trainingShort.targetSum, trainingShort.diffSum], [0, 0],
    "a training day never affects the target sum or the bank either");

  const regularShort = summarize([entry({date:"2026-08-13", clockIn:"09:00", clockOut:"11:00"})]);
  ok(regularShort.diffSum < 0,
    "a Regular day held to the same hours is still a shortfall", JSON.stringify(regularShort));

  // Still an open day like any other if there's a clock-in with no clock-out —
  // the zero target is not a free pass to look closed.
  const openWfh = computeEntry(entry({date:"2026-08-10", clockIn:"09:00", type:"wfh"}));
  eq(openWfh.open, true, "an in-progress WFH day is still flagged open");
}

// ---------------------------------------------------------------- "other" is excused, same as sick
// Real usage of "other" is a catch-all excused absence (marriage leave,
// bereavement, etc.) logged with no clock times — not miscellaneous work. It
// must behave exactly like Sick Leave: no target owed, no shortfall, whether
// or not clock times happen to be present.
{
  const sick = summarize([entry({date:"2026-08-10", type:"sick"})]);
  const other = summarize([entry({date:"2026-08-10", type:"other"})]);
  eq(
    [other.loggedDays, other.targetSum, other.diffSum, other.incompleteDays],
    [sick.loggedDays, sick.targetSum, sick.diffSum, sick.incompleteDays],
    "an 'other' day is excused exactly like a sick day"
  );
  eq([other.targetSum, other.diffSum, other.incompleteDays], [0, 0, 0],
    "an unlogged 'other' day owes nothing and is not booked as a shortfall");

  // Even if someone still fills in clock times on an excused "other" day,
  // it must not turn into a shortfall the way a Regular day would.
  const otherWithHours = summarize([entry({date:"2026-08-11", clockIn:"09:00", clockOut:"11:00", type:"other"})]);
  eq([otherWithHours.targetSum, otherWithHours.diffSum], [0, 0],
    "an 'other' day with clock times still owes no target");

  eq(computeEntry(entry({date:"2026-08-10", type:"other"})).excused, true,
    "computeEntry marks 'other' excused, same flag sick gets");
}

// ---------------------------------------------------------------- mixed seasonal targets
// A month/week that mixes a reduced seasonal target (e.g. Ramadan's 5h) with
// the regular 8h target must be judged against each day's own target, not a
// single flat constant — someone who exactly met a reduced-hours day every
// day of the period must read as 100%, not as short.
{
  const savedPeriods = settings.periods, savedTarget = settings.targetMin;
  settings.targetMin = 480; // 8h base
  settings.periods = [{start:"2026-08-10", end:"2026-08-11", targetMin:300, name:"Short hours"}]; // 5h

  eq(scheduleFor("2026-08-10").targetMin, 300, "a date inside the seasonal period uses its target");
  eq(scheduleFor("2026-08-12").targetMin, 480, "a date outside the period falls back to the base target");

  const s = summarize([
    entry({date:"2026-08-10", clockIn:"08:00", clockOut:"13:00"}), // 5h worked on a 5h day
    entry({date:"2026-08-11", clockIn:"08:00", clockOut:"13:00"}), // 5h worked on a 5h day
    entry({date:"2026-08-12", clockIn:"08:00", clockOut:"16:00"}), // 8h worked on an 8h day
  ]);
  eq(s.diffSum, 0, "every day exactly met its own (mixed) target, so the bank is untouched");

  // This is the formula renderStats()/renderWeekly()/renderTrendChart() use
  // for their per-bucket target (targetSum averaged over logged days) —
  // it must land on 100%, not the ~75% a flat 8h constant would have produced
  // against a 6h true average target ((300+300+480)/3).
  const weightedTargetPerDay = s.targetSum / s.loggedDays;
  eq(weightedTargetPerDay, 360, "the weighted average target reflects the 5h/5h/8h mix, not a flat 8h");
  const accomplishedPct = Math.round((s.avgMin / weightedTargetPerDay) * 100);
  eq(accomplishedPct, 100, "three days each meeting their own target reads as 100% accomplished");

  const flatConstantPct = Math.round((s.avgMin / settings.targetMin) * 100);
  ok(flatConstantPct < 100, "a flat 8h constant would have wrongly read this as short",
    `flatConstantPct=${flatConstantPct}`);

  settings.periods = savedPeriods;
  settings.targetMin = savedTarget;
}

// ---------------------------------------------------------------- off-days (weekends) are neutral
// A day outside the configured work days must not move the average, the bank
// or the target-accomplished rate either way — 20 hours logged on a Friday or
// nothing logged at all must have the exact same (zero) effect.
{
  const savedWorkDays = settings.workDays;
  settings.workDays = [0,1,2,3,4]; // Fri/Sat off, the org default

  let friday = null;
  for(let i=0;i<14;i++){
    const d = new Date(2026,7,1+i);
    if(d.getDay() === 5){ friday = dateToStr(d); break; }
  }

  const baseline = summarize([]);
  const workedHard = summarize([entry({date:friday, clockIn:"06:00", clockOut:"23:00"})]); // 17h logged
  const blank = summarize([entry({date:friday})]);

  eq([workedHard.workedSum, workedHard.diffSum, workedHard.loggedDays],
     [baseline.workedSum, baseline.diffSum, baseline.loggedDays],
     "hours logged on an off-day do not move the totals, bank or average");
  eq([blank.workedSum, blank.diffSum, blank.loggedDays, blank.incompleteDays],
     [baseline.workedSum, baseline.diffSum, baseline.loggedDays, baseline.incompleteDays],
     "a blank off-day entry does not register as a shortfall either");

  eq(computeEntry(entry({date:friday, clockIn:"06:00", clockOut:"23:00"})).diffMin, 0,
     "an individual off-day row shows no credit or shortfall diff either");

  settings.workDays = savedWorkDays;
}

console.log(`  audit-logic  pass ${pass}   fail ${fail}`);
if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
})();
