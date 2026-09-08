// consumeShortcutAction() is the one thing standing between a push
// notification's "Clock Out" action button (sw.js's notificationclick
// navigates to ?action=out-date&date=YYYY-MM-DD) and an actual write — this
// suite is what protects that dispatch from silently breaking, since nothing
// else in the app would notice a regression here until someone tapped the
// button on a real device.
//
// What this suite deliberately does NOT cover: whether a push is actually
// delivered. That needs a real push service and a real device, and is
// listed as a manual verification step in the push-notifications plan —
// send-push and check-clockout-reminders (Supabase Edge Functions) have no
// local equivalent to run them against here.
const { chromium } = require("playwright");
const { OUT } = require("./build-harness");

const PAGE = "file://" + OUT;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if(a === e) pass++;
  else { fail++; failures.push(`${label}\n     expected: ${e}\n     actual:   ${a}`); }
}

async function run(browser, query, entries){
  const page = await browser.newPage();
  await page.goto(PAGE + query);
  if(entries) await page.evaluate((list) => window.setEntries(list), entries);
  await page.evaluate(() => window.consumeShortcutAction());
  const state = await page.evaluate(() => ({
    punchCalls: window.__punchCalls,
    upsertCalls: window.__upsertCalls,
    applyCalls: window.__applyCalls,
    search: location.search,
  }));
  await page.close();
  return state;
}

(async () => {
  const browser = await chromium.launch();

  {
    const s = await run(browser, "?action=in", []);
    eq(s.punchCalls, ["in"], "?action=in still reaches punchClock (manifest shortcut, unchanged)");
    eq(s.upsertCalls.length, 0, "?action=in never touches sbUpsertEntry directly");
    eq(s.search, "", "the query string is stripped after ?action=in");
  }
  {
    const s = await run(browser, "?action=out", []);
    eq(s.punchCalls, ["out"], "?action=out still reaches punchClock (manifest shortcut, unchanged)");
  }
  {
    const entries = [{ id:"e1", date:"2026-08-13", clockIn:"22:00", clockOut:"", type:"regular", note:"" }];
    const s = await run(browser, "?action=out-date&date=2026-08-13", entries);
    eq(s.punchCalls.length, 0, "a push's Clock Out action never goes through punchClock");
    eq(s.upsertCalls.length, 1, "it finds the matching open entry and saves it");
    eq(s.upsertCalls[0].payload.date, "2026-08-13", "closing the exact day named in the notification, not today");
    eq(s.upsertCalls[0].payload.clockIn, "22:00", "the original clock-in survives the close");
    eq(s.upsertCalls[0].payload.clockOut, "16:00", "closes at the person's own standard end time");
    eq(s.upsertCalls[0].existingId, "e1", "updates the existing row rather than inserting a new one");
    eq(s.search, "", "the query string is stripped even for the out-date case");
  }
  {
    // No entry for that date at all -- a stale notification tapped after the
    // day was already fixed by hand some other way.
    const s = await run(browser, "?action=out-date&date=2026-08-13", []);
    eq(s.upsertCalls.length, 0, "no matching entry means no write is attempted");
    eq(s.search, "", "the query string is still stripped so a refresh can't retry a stale action");
  }
  {
    // Already closed -- the same day-was-already-fixed case, but the row
    // exists this time instead of being entirely gone.
    const entries = [{ id:"e1", date:"2026-08-13", clockIn:"22:00", clockOut:"06:00", type:"regular", note:"" }];
    const s = await run(browser, "?action=out-date&date=2026-08-13", entries);
    eq(s.upsertCalls.length, 0, "an already-closed shift is never re-written");
  }
  {
    const s = await run(browser, "", []);
    eq(s.punchCalls.length, 0, "no action param means nothing fires");
    eq(s.upsertCalls.length, 0, "no action param means nothing fires (upsert)");
  }

  await browser.close();
  console.log(`  push      pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
