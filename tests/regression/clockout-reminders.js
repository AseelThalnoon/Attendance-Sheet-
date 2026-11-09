// The clock-out reminder rules in supabase/functions/check-clockout-reminders,
// run as written: the pure part of that file -- from RIYADH_OFFSET_MS down to
// Deno.serve -- is cut out, its TypeScript types stripped by Node, and run in
// a vm against fixed clocks. Nothing here talks to Supabase.
//
// Written for the 2026-11-09 fix: a shift left open on an earlier day was
// reminded on the first hourly run after midnight Riyadh time, and again
// every night until somebody fixed it, however old the shift was.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { stripTypeScriptTypes } = require("module");

const SRC = path.join(__dirname, "..", "..", "supabase", "functions", "check-clockout-reminders", "index.ts");
const ts = fs.readFileSync(SRC, "utf8");
const from = ts.indexOf("const RIYADH_OFFSET_MS");
const to = ts.indexOf("Deno.serve(");
if(from === -1 || to === -1 || to < from){
  throw new Error("check-clockout-reminders/index.ts: extraction anchors not found");
}

// stripTypeScriptTypes is marked experimental and says so on stderr; that is
// about the API, not about anything this suite checks.
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const js = stripTypeScriptTypes(ts.slice(from, to));
process.emitWarning = emitWarning;

const sandbox = { Date, Math, JSON, Number, String, Array, Object, Map, Set, isFinite };
vm.createContext(sandbox);
vm.runInContext(js, sandbox);
const { dueReminders } = sandbox;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(ok) pass++; else { fail++; failures.push(`${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// A Riyadh wall-clock time, as the instant the cron run happens at.
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+03:00`);
const shift = (date, clockIn, extra) =>
  Object.assign({ id: date, user_id: "u1", date, clock_in: clockIn, type: "regular" }, extra);
const sent = (entryDate, sentOn) => ({ user_id: "u1", entry_date: entryDate, sent_on: sentOn });
const mine = (settings) => new Map([["u1", settings || {}]]);
const titles = (res) => res.notifications.map(n => n.title);

// 8 Nov 2026 is a Sunday. Defaults: Sun-Thu, 08:00-16:00, remind after 9h.
{
  const open = [shift("2026-11-09", "08:00")];
  eq(titles(dueReminders(open, mine(), {}, [], at("2026-11-09", "16:30"))), [],
    "same day: nothing before remindAfterHours have passed");
  const r = dueReminders(open, mine(), {}, [], at("2026-11-09", "17:00"));
  eq(titles(r), ["Still clocked in"], "same day: reminded once the 9 hours are up");
  eq(r.guards, [sent("2026-11-09", "2026-11-09")], "same day: recorded against today");
  eq(r.notifications[0].action_payload, { date: "2026-11-09", standard_out: "16:00", label: "Clock Out at 4:00 PM" },
    "same day: the Clock Out action carries the day and its standard end");
  eq(titles(dueReminders(open, mine(), {}, [sent("2026-11-09", "2026-11-09")], at("2026-11-09", "18:00"))), [],
    "same day: not again on the next hourly run");
}

{
  const open = [shift("2026-11-08", "08:00")];
  const sameDay = [sent("2026-11-08", "2026-11-08")];
  eq(titles(dueReminders(open, mine(), {}, sameDay, at("2026-11-09", "00:00"))), [],
    "earlier day: nothing at midnight");
  eq(titles(dueReminders(open, mine(), {}, sameDay, at("2026-11-09", "07:59"))), [],
    "earlier day: nothing before the person's start time");
  const r = dueReminders(open, mine(), {}, sameDay, at("2026-11-09", "08:00"));
  eq(titles(r), ["You never clocked out"],
    "earlier day: reminded at the start time, whether or not the same-day reminder went");
  eq(r.guards, [sent("2026-11-08", "2026-11-09")], "earlier day: recorded against the day it went out");
  eq(titles(dueReminders(open, mine(), {}, sameDay.concat([sent("2026-11-08", "2026-11-09")]), at("2026-11-10", "08:00"))), [],
    "earlier day: once only -- not again the next morning");
  eq(titles(dueReminders(open, mine(), {}, [sent("2026-11-08", "2026-11-09")], at("2026-11-12", "09:00"))), [],
    "earlier day: not days later either");
}

{
  // Left open on Thursday 12 Nov; Friday and Saturday are days off.
  const open = [shift("2026-11-12", "08:00")];
  eq(titles(dueReminders(open, mine(), {}, [], at("2026-11-13", "09:00"))), [],
    "earlier day: not on a day off (Friday)");
  eq(titles(dueReminders(open, mine(), {}, [], at("2026-11-14", "09:00"))), [],
    "earlier day: not on a day off (Saturday)");
  eq(titles(dueReminders(open, mine(), {}, [], at("2026-11-15", "08:00"))), ["You never clocked out"],
    "earlier day: on the next working morning (Sunday)");
}

{
  // A seasonal period moves the start and end times, as it does in the app.
  const ramadan = { periods: [{ start: "2026-11-01", end: "2026-11-30", standardIn: "10:00", standardOut: "15:00" }] };
  const open = [shift("2026-11-08", "10:00")];
  eq(titles(dueReminders(open, mine(ramadan), {}, [], at("2026-11-09", "09:30"))), [],
    "seasonal hours: waits for the period's own start time");
  const r = dueReminders(open, mine(ramadan), {}, [], at("2026-11-09", "10:00"));
  eq(titles(r), ["You never clocked out"], "seasonal hours: reminded at the period's start time");
  eq(r.notifications[0].action_payload.standard_out, "15:00",
    "seasonal hours: the Clock Out action uses the period's end time");
}

{
  // No user_settings row: the organisation default applies, whole.
  const open = [shift("2026-11-08", "08:00", { user_id: "nobody" })];
  const org = { standardIn: "09:00", workDays: [0, 1, 2, 3, 4] };
  eq(titles(dueReminders(open, mine(), org, [], at("2026-11-09", "08:30"))), [],
    "no settings row: the org default's start time applies");
  eq(titles(dueReminders(open, mine(), org, [], at("2026-11-09", "09:00"))), ["You never clocked out"],
    "no settings row: reminded at the org default's start time");
}

{
  eq(titles(dueReminders([shift("2026-11-08", "08:00", { type: "sick" })], mine(), {}, [], at("2026-11-09", "08:00"))), [],
    "excused days are never reminded");
  // A night shift from yesterday evening isn't "never clocked out" at 2am:
  // the hours threshold applies whatever the shift's date.
  eq(titles(dueReminders([shift("2026-11-08", "22:00")], mine({ standardIn: "00:00" }), {}, [], at("2026-11-09", "02:00"))), [],
    "a shift under remindAfterHours old is left alone");
}

console.log(`  clockout-reminders  pass ${pass}   fail ${fail}`);
if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
