// One person's hours must never be measured against another person's week.
//
// The Team roster renders everyone's figures, and each person has their own
// working days, target and grace. It gets there by swapping the value app.js
// holds in `settings`, reading, and restoring in a finally -- summarizeAs,
// scheduledFor and computeEntryAs in app.js all do exactly that. src/schedule.js
// was extracted out from under that pattern, and it only keeps working because
// the module reads settings through a GETTER: it sees whatever is current at
// the moment of the call rather than a copy taken when it was built.
//
// That distinction is invisible. Hand the module a settings object at
// construction, or give it its own synced copy, and every assertion in the
// suite still passes while the roster quietly reports Bob's Friday against
// Alice's working week -- a wrong number that looks entirely reasonable. This
// file exists to make that failure loud, because nothing else in the suite
// would notice it.
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label){
  if(cond) pass++;
  else { fail++; failures.push(label); }
}

(async () => {
  const root = new URL("../../src/", `file://${__dirname}/`).href;
  const { makeSchedule } = await import(root + "schedule.js");
  const { DEFAULT_SETTINGS } = await import(root + "constants.js");

  // Mirrors app.js: one owner variable, read through a getter.
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  const S = makeSchedule(() => settings);

  const alice = Object.assign({}, DEFAULT_SETTINGS, { workDays:[0,1,2,3,4], targetMin:480 });
  const bob   = Object.assign({}, DEFAULT_SETTINGS, { workDays:[1,2,3,4,5], targetMin:300 });

  // 2026-09-13 is a Sunday; 2026-09-18 a Friday. Alice works Sun-Thu, Bob Mon-Fri,
  // so each day is a working day for exactly one of them.
  const SUN = "2026-09-13", FRI = "2026-09-18";

  // The same shape app.js uses, down to the finally.
  function as(personSettings, fn){
    const saved = settings;
    settings = personSettings;
    try { return fn(); } finally { settings = saved; }
  }

  ok(as(alice, () => S.isScheduled(SUN)) === true,  "Sunday is a working day for Alice");
  ok(as(bob,   () => S.isScheduled(SUN)) === false, "Sunday is not a working day for Bob");
  ok(as(alice, () => S.isScheduled(FRI)) === false, "Friday is not a working day for Alice");
  ok(as(bob,   () => S.isScheduled(FRI)) === true,  "Friday is a working day for Bob");

  ok(as(alice, () => S.targetMinPerDay()) === 480, "Alice's target comes from Alice's settings");
  ok(as(bob,   () => S.targetMinPerDay()) === 300, "Bob's target comes from Bob's settings");

  // The restore half matters as much as the swap: a swap that never came back
  // would leave every later read on the last person rendered.
  settings = alice;
  as(bob, () => S.targetMinPerDay());
  ok(S.targetMinPerDay() === 480, "the swap is undone afterwards, not left on Bob");

  // A whole entry, not just the predicates -- computeEntry is what the roster
  // actually calls, and it reads target, grace and working days together.
  const day = { date: FRI, clockIn: "09:00", clockOut: "14:00", type: "regular" };
  const aliceDay = as(alice, () => S.computeEntry(day));
  const bobDay   = as(bob,   () => S.computeEntry(day));
  ok(aliceDay.targetMin === 0, "a Friday Alice does not work owes her no target");
  ok(bobDay.targetMin === 300, "the same Friday owes Bob his own 300-minute target");
  ok(bobDay.workedMin === 300, "five hours worked is five hours");

  console.log(`  settings-swap  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
