// CSV import parsing: date and time cells.
//
// The functions under test are extracted verbatim from index.html at run time
// (see ../extract.js) and evaluated here, so these assertions run against the
// shipping code.
const vm = require("vm");
const { slice } = require("../extract");

const code = slice("// Real days in a given month", "// Maps a label like");
const sandbox = { pad2: n => String(n).padStart(2, "0") };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { daysInMonth, parseDateCell, isAmbiguousDate, parseTimeCell } = sandbox;

for(const [name, fn] of Object.entries({ daysInMonth, parseDateCell, isAmbiguousDate, parseTimeCell })){
  if(typeof fn !== "function") throw new Error(`extraction failed: ${name} is not a function`);
}

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label){
  if(actual === expected){ pass++; }
  else { fail++; failures.push(`${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
}
const T = (input, expected) => eq(parseTimeCell(input), expected, `parseTimeCell(${JSON.stringify(input)})`);
const D = (input, expected, dayFirst = false) => eq(parseDateCell(input, dayFirst), expected, `parseDateCell(${JSON.stringify(input)}, dayFirst=${dayFirst})`);

// ---------- daysInMonth ----------
eq(daysInMonth(2026,1), 31, "daysInMonth Jan");
eq(daysInMonth(2026,2), 28, "daysInMonth Feb non-leap");
eq(daysInMonth(2024,2), 29, "daysInMonth Feb leap");
eq(daysInMonth(2000,2), 29, "daysInMonth Feb 2000 (400-year leap)");
eq(daysInMonth(1900,2), 28, "daysInMonth Feb 1900 (century non-leap)");
eq(daysInMonth(2026,4), 30, "daysInMonth Apr");
eq(daysInMonth(2026,12), 31, "daysInMonth Dec");

// ---------- REGRESSION: date formats that already worked ----------
D("2026-08-09", "2026-08-09");
D("2026-8-9", "2026-08-09");
D("9/8/2026", "2026-09-08");             // M/D default
D("9/8/2026", "2026-08-09", true);       // D/M when dayFirst
D("25/12/2026", "2026-12-25");           // first > 12 -> must be a day
D("12/25/2026", "2026-12-25", true);     // second > 12 -> must be a month
D("9.8.2026", "2026-09-08");             // period separator
D("", "");
D("—", "");

// ---------- month-length validation ----------
D("2026-02-30", "");                     // Feb 30 never exists
D("2026-02-29", "");                     // 2026 is not a leap year
D("2024-02-29", "2024-02-29");           // 2024 is
D("2026-04-31", "");                     // April has 30
D("2026-06-31", "");
D("2026-09-31", "");
D("2026-11-31", "");
D("2026-01-31", "2026-01-31");           // a valid 31-day month still passes
D("2026-12-32", "");
D("2026-13-01", "");                     // month out of range
D("2026-00-10", "");
D("2026-01-00", "");
D("31/04/2026", "");                     // slash form, April 31
D("29/02/2026", "");                     // slash form, Feb 29 non-leap
D("29/02/2024", "2024-02-29", true);     // slash form, Feb 29 leap

// ---------- isAmbiguousDate (untouched; guards against drift) ----------
eq(isAmbiguousDate("9/8/2026"), true, "isAmbiguousDate both <= 12 and differing");
eq(isAmbiguousDate("25/12/2026"), false, "isAmbiguousDate first > 12");
eq(isAmbiguousDate("5/5/2026"), false, "isAmbiguousDate equal halves");

// ---------- REGRESSION: time formats that already worked ----------
T("8:00 AM", "08:00");
T("08:00", "08:00");
T("8:00am", "08:00");
T("16:00", "16:00");
T("4 PM", "16:00");
T("12:00 AM", "00:00");                  // midnight
T("12:00 PM", "12:00");                  // noon
T("12:30 AM", "00:30");
T("11:59 PM", "23:59");
T("", "");
T("—", "");
T("-", "");

// ---------- seconds accepted and ignored ----------
T("3:00:00 PM", "15:00");
T("15:30:45", "15:30");
T("8:05:09 am", "08:05");

// ---------- period as separator ----------
T("8.00 AM", "08:00");
T("16.45", "16:45");
T("8.00.00 AM", "08:00");

// ---------- compact, no separator ----------
T("0800", "08:00");
T("800", "08:00");
T("1630", "16:30");
T("0000", "00:00");
T("2359", "23:59");
T("2400", "");                           // hour out of range
T("1265", "");                           // minutes out of range
T("960", "");                            // 9:60 is invalid

// ---------- bare hour ----------
T("8", "08:00");
T("16", "16:00");
T("0", "00:00");
T("23", "23:00");
T("24", "");
T("99", "");

// ---------- Excel day-fraction decimals ----------
T("0.5", "12:00");                       // noon
T(".5", "12:00");
T("0.25", "06:00");
T("0.75", "18:00");
T("0.0", "00:00");                       // a day-fraction of zero is midnight
T("0.999999", "");                       // rounds to 24:00, out of range

// ---------- invalid input stays rejected ----------
T("25:00", "");
T("12:60", "");
T("13:00 PM", "");                       // 13 is not a valid 12-hour clock hour
T("0:00 AM", "");                        // nor is 0
T("8:99 AM", "");
T("abc", "");
T("8:00 XM", "");

console.log(`  parsers   pass ${pass}   fail ${fail}`);
if(failures.length){
  failures.forEach(f => console.log("  FAIL " + f));
  process.exit(1);
}
