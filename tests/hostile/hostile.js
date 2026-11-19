// Hardening regression suite: hostile data, failure states, races and
// concurrency the golden path never exercises. Each case here was a defect
// found by driving the real app (see harness.js/backend.js) against extreme
// names, dropped connections, and rapid double-clicks — this file locks the
// fix down so a later change can't quietly reopen it.
//
// initialsOf() is pulled verbatim from app.js the way the other suites pull
// from index.html (see ../extract.js); everything else boots the real page
// against a scripted Supabase (see harness.js) because the bugs here are in
// how the app reacts to network conditions and viewer switches, not in a
// pure function.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { boot, goTab, settle, DESKTOP, PHONE } = require("./harness");
const D = require("./data");
// This file keeps its own extraction logic below (it needs a brace-matched
// grab that extract.js does not offer), but it must not keep its own idea of
// WHERE the app's JavaScript lives. It read app.js directly, and the day
// VAPID_PUBLIC_KEY moved to src/constants.js that read silently returned
// nothing: the key came back undefined and the suite died in
// urlBase64ToUint8Array rather than reporting a missing constant. source()
// is the one place that knows about src/, so the next extraction cannot
// break this the same way.
const { source } = require("../extract");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

async function run(){
  // ---- initialsOf: astral emoji must not produce a lone surrogate --------
  {
    const src = source();
    const start = src.findIndex(l => l.trim().startsWith("function initialsOf(name){"));
    if(start === -1) throw new Error("extract: initialsOf not found in app.js");
    const end = start + src.slice(start).findIndex(l => l.trim() === "}");
    const code = src.slice(start, end + 1).join("\n");
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const hasLoneSurrogate = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    const cases = [D.EMOJI_NAME, D.CJK_NAME, D.RTL_NAME, "", null, "   ", "Ana"];
    for(const name of cases){
      const result = sandbox.initialsOf(name);
      ok(!hasLoneSurrogate(result), `initialsOf(${JSON.stringify(name)}) has no unpaired surrogate`,
        `got ${JSON.stringify(result)}`);
    }
    ok(sandbox.initialsOf(null) === "?", "initialsOf(null) falls back to \"?\"");
  }

  // ---- A failed push subscription has to say something actionable --------
  // pushManager.subscribe() reports its failures as one opaque sentence, and
  // "Registration failed - push service error" was being shown to the person
  // verbatim. It names no cause and no next step, and the usual cause is not
  // the app: each browser registers with its own vendor's push service, and a
  // network that cannot reach that one fails exactly here.
  //
  // subscriptionMatchesKey is in the same block because it guards the other
  // half of the same feature: a subscription held over from a different VAPID
  // key produces a row nothing can ever deliver to, silently.
  {
    const lines = source();
    const grab = (startsWith, endsWith) => {
      const s = lines.findIndex(l => l.trim().startsWith(startsWith));
      if(s === -1) throw new Error("extract: not found: " + startsWith);
      const e = s + lines.slice(s).findIndex(l => l.trim().startsWith(endsWith));
      return lines.slice(s, e).join("\n");
    };
    const VAPID = (lines.find(l => l.includes("var VAPID_PUBLIC_KEY")) || "").split('"')[1];
    ok(!!VAPID && VAPID.length > 80, "the VAPID public key constant is present in app.js");

    const build = ua => {
      const sandbox = {
        navigator: { userAgent: ua },
        atob: s => Buffer.from(s, "base64").toString("binary"),
        Uint8Array,
        VAPID_PUBLIC_KEY: VAPID,
        isSafariBrowser: () => /^((?!chrome|android|crios|fxios|edgios|opios).)*safari/i.test(ua)
      };
      vm.createContext(sandbox);
      vm.runInContext(
        grab("function urlBase64ToUint8Array", "function pushSupported") + "\n" +
        grab("function subscriptionMatchesKey", "// pushManager.subscribe()") + "\n" +
        grab("function describeSubscribeFailure", "async function subscribeToPush"),
        sandbox);
      return sandbox;
    };

    const chrome = build("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36");
    const chromeMsg = chrome.describeSubscribeFailure(new Error("Registration failed - push service error"));
    ok(!/Registration failed - push service error/.test(chromeMsg),
      "the raw browser string is not what the person is shown", chromeMsg);
    ok(/Google's/.test(chromeMsg) && /network/i.test(chromeMsg),
      "it names the push service that failed and points at the usual cause", chromeMsg);

    const ff = build("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0");
    ok(/Mozilla's/.test(ff.describeSubscribeFailure(new Error("Registration failed - push service error"))),
      "the named service follows the browser, since they each use a different one");

    ok(/blocked/i.test(chrome.describeSubscribeFailure({name:"NotAllowedError", message:"NotAllowedError"})),
      "a blocked permission is reported as a permission problem, not a network one");

    // A subscription made with this key is reusable; one made with any other
    // is not, and reusing it would write a row send-push can never deliver to.
    const mine = chrome.urlBase64ToUint8Array(VAPID);
    const theirs = chrome.urlBase64ToUint8Array(
      "BEl2b8ZQ0OPBoBiRurCz-tUEDcOEuUAPCPmvbCV0PdrgRDROIPBIGFOouKMYLYtLLKvMbNBBGCEBLPBLRMDPPBg");
    ok(chrome.subscriptionMatchesKey({options:{applicationServerKey: mine.buffer}}) === true,
      "a subscription made with the current key is kept");
    ok(chrome.subscriptionMatchesKey({options:{applicationServerKey: theirs.buffer}}) === false,
      "a subscription made with a different key is replaced, not reused");
    ok(chrome.subscriptionMatchesKey({}) === true,
      "a browser that does not expose the key keeps its subscription rather than churning it");

    // friendlyError translates the errors that are not written for a person.
    // It must not translate the ones that are: its patterns match on wording,
    // and the push-service explanation says the cause is usually the network,
    // which its own /network/i catch-all replaced with "Couldn't reach the
    // server" -- burying the specific explanation under the generic one it
    // was written to replace. That shipped, and this is what it cost:
    // enabling notifications reported a connection problem that was not one.
    const fe = build("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36");
    vm.runInContext(
      // Ends at the export list, not at the Bulk-operation guard banner it
      // used to name: explainedError/friendlyError moved to src/errors.js and
      // that banner stayed in app.js, so the old pair straddled two files.
      // Every module ends in an export block, and errors.js's own is the first
      // one after explainedError, so this lands on the end of that file.
      grab("function explainedError", "export {"), fe);
    const explained = fe.explainedError(
      fe.describeSubscribeFailure(new Error("Registration failed - push service error")));
    ok(/push service \(Google's\)/.test(fe.friendlyError(explained)),
      "an already-explained error reaches the person as written",
      fe.friendlyError(explained).slice(0, 90));
    ok(!/Couldn't reach the server/.test(fe.friendlyError(explained)),
      "the generic network message does not overwrite an explanation that mentions the network");
    // The translations that must survive: these errors are not written for
    // anyone and still need turning into English.
    ok(/Couldn't reach the server/.test(fe.friendlyError(new TypeError("Failed to fetch"))),
      "a real fetch failure still translates");
    ok(/permission/i.test(fe.friendlyError({code:"42501", message:"row-level security"})),
      "a Postgres error still translates");
  }

  // ---- Viewer-switch race: the last-clicked person must win ---------------
  {
    const people = D.roster(6), me = people[0], A = people[1], B = people[2];
    const h = await boot({ meId: me.id, seed: {
      profiles: people,
      entries: [].concat(D.entriesFor(me.id, 5), D.entriesFor(A.id, 60), D.entriesFor(B.id, 2)),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    h.backend.fail("/rest/v1/entries", { delayMs: 1200 }, 1);   // A's load crawls
    await h.page.selectOption("#viewerSelect", A.id);
    await h.page.waitForTimeout(120);
    await h.page.selectOption("#viewerSelect", B.id);           // B's load is instant
    await settle(h.page, 2500);
    const s = await h.page.evaluate(() => ({
      select: document.getElementById("viewerSelect").value,
      rows: document.querySelectorAll("#logBody tr").length
    }));
    ok(s.select === B.id, "viewer switcher shows the last-selected person after a race");
    // B has 2 entries; A's 60 must never land after B was selected.
    ok(s.rows <= 2, "log shows the last-selected person's data, not a slower earlier load",
      `rows on screen: ${s.rows}`);
    await h.close();
  }

  // ---- Team month-navigation race: the last-clicked month must win --------
  // Same bug class as the viewer-switch race above, in renderTeam() instead
  // of loadDataForViewedUser(): Prev/Next Month awaits a network fetch with
  // no generation guard, so a slower response for a month already navigated
  // away from can land after a faster later one and silently overwrite the
  // screen — the header naming the month you're looking at while the cards
  // underneath it are someone else's.
  {
    const pad2 = n => String(n).padStart(2, "0");
    const dstr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    // A day whose weekday falls inside D.SETTINGS.workDays ([0..4], Sun-Thu):
    // an entry on an unscheduled day contributes nothing to the totals below
    // (see summarize()'s own isScheduled() gate), which would make this test
    // pass for the wrong reason.
    const scheduledDateIn = (year, month1) => {
      for(let day = 1; day <= 27; day++){
        const d = new Date(year, month1 - 1, day);
        if(D.SETTINGS.workDays.includes(d.getDay())) return d;
      }
    };
    const people = D.roster(4), me = people[0];
    const today = new Date();
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevStart = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}-01`;
    const curSched = scheduledDateIn(today.getFullYear(), today.getMonth() + 1);
    const prevSched = scheduledDateIn(prev.getFullYear(), prev.getMonth() + 1);

    // people is D.roster(4)'s full 7-person base list, all clocked 8h on the
    // current month's scheduled day.
    const entries = people.map((p, i) => ({
      id: 1000 + i, user_id: p.id, date: dstr(curSched),
      clock_in: "08:00:00", clock_out: "16:00:00", type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z"
    }));
    entries.push({
      id: 9999, user_id: me.id, date: dstr(prevSched),
      clock_in: "08:00:00", clock_out: "09:00:00", type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z"
    });

    const h = await boot({ meId: me.id, seed: {
      profiles: people, entries,
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await goTab(h.page, "team");
    await settle(h.page, 400);

    h.backend.fail(`gte.${prevStart}`, { delayMs: 1500 }, 1);   // the month navigated away from crawls
    await h.page.evaluate(() => document.getElementById("teamPrevMonth").click());
    await h.page.waitForTimeout(150);
    await h.page.evaluate(() => document.getElementById("teamNextMonth").click());  // back to current, instant

    await settle(h.page, 2200);   // let the slow, stale prev-month response land, if it's going to
    const t = await h.page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("#teamSummary .stat-card"));
      const hours = cards.find(c => c.querySelector(".stat-label").textContent.includes("Avg / Day"));
      return {
        label: document.getElementById("teamMonthLabel").textContent,
        hoursWorked: hours ? hours.querySelector(".stat-value").textContent : null
      };
    });
    const expectedLabel = today.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    ok(t.label === expectedLabel, "team month label reads the last-clicked month after a race",
      `label: ${t.label}`);
    // All 7 of D.roster(4)'s base list worked 8h on the current month's one
    // scheduled day, so the team averages 8h across 7 logged days. The stale
    // prev-month response is one person's single 1h day, which would read as
    // 1h — a different enough number that this cannot pass by coincidence.
    ok(t.hoursWorked === "8h", "team totals show the last-clicked month's data, not a slower earlier load",
      `Avg / Day: ${t.hoursWorked}`);
    await h.close();
  }

  // ---- A failed load must not be presented as an empty/real account -------
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: D.entriesFor(me.id, 40),
      user_settings: [{ user_id: me.id, settings: Object.assign({}, D.SETTINGS, { targetMin: 390, workDays: [1,2,3,4,5] }) }]
    }, beforeLoad: ({ backend }) => backend.fail("/rest/v1/entries", { status: 500, message: "boom" }, 1) });
    await settle(h.page, 900);

    const snap = await h.page.evaluate(() => {
      const b = document.getElementById("loadFailBanner");
      const r = b.getBoundingClientRect();
      const retry = document.getElementById("loadFailRetryBtn");
      return {
        failBanner: b.classList.contains("show"),
        // On the page since 2026-11-17, not inside Alerts: the notice that
        // says the figures cannot be trusted is where the figures are.
        onScreen: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
        retryShown: !!retry.getClientRects().length,
        figures: ["monthAvg", "otBank", "streak", "leaveBalance"].map(id => document.getElementById(id).textContent),
        toasts: [...document.querySelectorAll(".toast-msg")].map(t => t.textContent)
      };
    });
    ok(snap.failBanner, "a failed load shows the persistent failure banner");
    ok(snap.onScreen && snap.retryShown, "on the screen, with its Try Again button, without opening anything", JSON.stringify(snap));
    ok(snap.figures.every(f => f === "—"),
      "the four figures say \"—\", not zeros that read as an empty account", JSON.stringify(snap.figures));
    ok(snap.toasts.length === 0, "and it is the only message: no toast saying the same thing", JSON.stringify(snap.toasts));

    // Try Again is the way out, and it works.
    await h.page.evaluate(() => document.getElementById("loadFailRetryBtn").click());
    await settle(h.page, 900);
    const after = await h.page.evaluate(() => ({
      failBanner: document.getElementById("loadFailBanner").classList.contains("show"),
      avg: document.getElementById("monthAvg").textContent
    }));
    ok(!after.failBanner && after.avg !== "—", "Try Again loads the record and the notice goes", JSON.stringify(after));
    // Fail it again for what follows.
    h.backend.fail("/rest/v1/entries", { status: 500, message: "boom" }, 1);
    await h.page.evaluate(() => document.getElementById("loadFailRetryBtn").click());
    await settle(h.page, 900);

    // Save Settings must refuse to write the fallback defaults over the
    // still-unloaded real schedule.
    await goTab(h.page, "settings");
    await settle(h.page, 300);
    const before = h.backend.state.log.filter(r => r.path.includes("user_settings")).length;
    await h.page.evaluate(() => document.getElementById("saveSettingsBtn").click());
    await settle(h.page, 500);
    const afterSave = h.backend.state.log.filter(r => r.path.includes("user_settings")).length;
    ok(afterSave === before, "Save Settings is blocked while the real schedule never loaded");
    await h.close();
  }

  // ---- A request that never answers must still resolve, not hang forever -
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: D.entriesFor(me.id, 5),
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }, beforeLoad: ({ backend }) => backend.fail("/rest/v1/entries", { mode: "hang" }, 1) });
    await settle(h.page, 21500);   // past the app's 20s request timeout
    const snap = await h.page.evaluate(() => ({
      failBanner: document.getElementById("loadFailBanner").classList.contains("show")
    }));
    ok(snap.failBanner, "a request that never answers fails with the timeout banner instead of hanging forever");
    await h.close();
  }

  // ---- Double-submit: rapid same-tick clicks must write exactly once -----
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    await h.page.evaluate(() => { for(let i=0;i<10;i++) document.getElementById("qcClockBtn").click(); });
    await settle(h.page, 1000);
    ok(h.backend.state.entries.filter(e => e.user_id === me.id).length === 1,
      "10 same-tick clicks on Clock In write exactly one entry");

    await goTab(h.page, "settings");
    await settle(h.page, 300);
    let before = h.backend.state.log.filter(r => r.path.includes("user_settings")).length;
    await h.page.evaluate(() => { const b = document.getElementById("saveSettingsBtn"); for(let i=0;i<10;i++) b.click(); });
    await settle(h.page, 1000);
    let after = h.backend.state.log.filter(r => r.path.includes("user_settings")).length;
    ok(after - before <= 1, "10 same-tick clicks on Save Settings write at most once");
    await h.close();
  }

  // ---- Schedule: the day's hours are its Start to its End ----------------
  // There used to be an "hours a day" field beside Start and End, which
  // could only ever disagree with them: worked time is clock-out minus
  // clock-in, nothing taken off. The hours are the times now, on the main
  // schedule and on each Ramadan / shorter-days card, and lateness is judged
  // on them with no switch (an old saved `lateOnlyIfShort` is dropped).
  {
    // An admin: schedules are set by admins (see the next block for everyone else).
    const me = D.profile(1, { role: "admin" });
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: Object.assign({}, D.SETTINGS, { lateOnlyIfShort: false }) }]
    }});
    await goTab(h.page, "settings");
    await h.page.click("#cnav-hours");
    await settle(h.page, 300);
    const noteNow = () => h.page.evaluate(() => {
      const c = document.getElementById("sTargetCard");
      return c.querySelector("[data-target-value]").textContent + " | " + c.querySelector("[data-target-hint]").textContent +
        (c.classList.contains("is-invalid") ? " | invalid" : "");
    });
    ok(await noteNow() === "8h | From your Start to your End time.",
      "Start 08:00 to End 16:00 shows a daily target of 8h, and says where it comes from", await noteNow());
    ok(await h.page.evaluate(() => !document.getElementById("sLateOnlyShort")),
      "there is no \"don't mark me late\" switch: making the hours is the rule");

    // "+ Other Dates" offers three quarters of the day as a shorter Clock Out.
    await h.page.click("#addPeriodBtn");
    await settle(h.page, 200);
    const card = await h.page.evaluate(() => {
      const c = document.querySelector("#periodsList [data-period]");
      return { in: c.querySelector('[data-p="in"]').value, out: c.querySelector('[data-p="out"]').value,
               note: c.querySelector("[data-p-hours]").textContent,
               target: c.querySelectorAll('[data-p="th"], [data-p="tm"]').length };
    });
    ok(card.in === "08:00" && card.out === "14:00" && card.note === "6h" && card.target === 0,
      "a new shorter-days card is 08:00 to 14:00, states a 6h daily target, and has no separate target field", JSON.stringify(card));

    // The note follows the times as they are typed.
    await h.page.fill("#sIn", "07:30");
    await h.page.fill("#sOut", "07:30");
    ok(await noteNow() === "— | End has to be after Start. | invalid", "End equal to Start is called out on the target card", await noteNow());
    const writes = () => h.backend.state.log.filter(r => r.path.includes("user_settings") && r.method === "POST").length;
    let before = writes();
    await h.page.evaluate(() => document.getElementById("saveSettingsBtn").click());
    await settle(h.page, 500);
    ok(writes() === before, "and Save refuses it rather than storing a zero-hour day");

    await h.page.fill("#sOut", "15:00");
    ok(await noteNow() === "7h 30m | From your Start to your End time.", "07:30 to 15:00 shows a 7h 30m target", await noteNow());
    before = writes();
    await h.page.evaluate(() => document.getElementById("saveSettingsBtn").click());
    await settle(h.page, 700);
    const saved = (h.backend.state.user_settings.find(r => r.user_id === me.id) || {}).settings || {};
    ok(writes() === before + 1 && saved.targetMin === 450 && saved.standardIn === "07:30" && saved.standardOut === "15:00",
      "Save stores the day's hours as End minus Start", JSON.stringify({ targetMin: saved.targetMin, in: saved.standardIn, out: saved.standardOut }));
    ok(saved.periods && saved.periods[0] && saved.periods[0].targetMin === 360,
      "and each shorter-days card's hours as its Clock Out minus Clock In", JSON.stringify(saved.periods));
    ok(!("lateOnlyIfShort" in saved) && !("graceMin" in saved),
      "neither the old lateness switch nor the old grace period is written back", JSON.stringify(Object.keys(saved)));
    ok(await h.page.evaluate(() => !document.getElementById("sGrace")), "there is no grace period field");
    ok(await h.page.evaluate(() => !document.querySelector("#settingsConsole .console-commit-group").classList.contains("is-dirty")),
      "after a save the Save bar is no longer marked as holding unsaved changes");
    await h.close();
  }

  // ---- Schedules are set by admins; an employee's is read-only -------------
  // 20261118090000_schedules_set_by_admins: only an admin may write a
  // user_settings row. The scripted backend refuses anyone else's write the
  // way the database would, so this also fails if the app ever tries one.
  // The reminder switches are the employee's own, through set_my_reminder().
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: Object.assign({}, D.SETTINGS, { annualLeaveDays: 23 }) }]
    }});
    await goTab(h.page, "settings");
    await h.page.click("#cnav-hours");
    await settle(h.page, 300);
    const view = await h.page.evaluate(() => {
      const shown = el => !!(el && el.getClientRects().length);
      return {
        disabled: document.getElementById("scheduleForm").disabled,
        note: shown(document.getElementById("scheduleLockNote")),
        save: shown(document.getElementById("saveSettingsBtn")),
        add: shown(document.getElementById("addRamadanBtn")),
        apply: shown(document.getElementById("sApplyAll")),
        leave: document.getElementById("sLeaveDays").value,
        target: document.querySelector("#sTargetCard [data-target-value]").textContent
      };
    });
    ok(view.disabled && view.note && !view.save && !view.add && !view.apply,
      "an employee's Schedule is read-only: fields locked, a note saying who sets it, no Save, no add buttons",
      JSON.stringify(view));
    ok(view.leave === "23" && view.target === "8h", "and it still shows their schedule and daily target", JSON.stringify(view));
    ok(await h.page.evaluate(() => document.getElementById("firstRunSettingsBtn").textContent) === "Check your working week",
      "the first-run link offers to check the working week, not to set it");

    const posts = () => h.backend.state.log.filter(r => r.path.includes("/rest/v1/user_settings") && r.method !== "GET" && r.method !== "OPTIONS").length;
    const before = posts();
    await h.page.click("#cnav-notifications");
    await settle(h.page, 200);
    await h.page.click('label[for="sRemindOut"]');
    await settle(h.page, 600);
    const row = (h.backend.state.user_settings.find(r => r.user_id === me.id) || {}).settings || {};
    ok(row.remindClockOut === false && row.annualLeaveDays === 23 && posts() === before,
      "an employee's reminder switch saves through set_my_reminder, changing only that switch",
      JSON.stringify({ remindClockOut: row.remindClockOut, annualLeaveDays: row.annualLeaveDays, writes: posts() - before }));
    ok(await h.page.evaluate(() => document.getElementById("sRemindOut").checked === false),
      "and the switch stays where it was put");
    ok(h.errors.length === 0, "read-only schedule: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- An admin edits one person's schedule from People -------------------
  // New accounts start on the organisation default; an admin changes one
  // person's from Admin > People > Edit Schedule, which must land on THAT
  // person's schedule (loaded first, not the previous person's values under
  // their name) and save to their row alone.
  {
    const me = D.profile(1, { role: "admin" });
    const other = D.profile(2);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me, other], entries: [],
      user_settings: [
        { user_id: me.id, settings: D.SETTINGS },
        { user_id: other.id, settings: Object.assign({}, D.SETTINGS, { standardIn: "09:30", standardOut: "15:30", targetMin: 360, annualLeaveDays: 30 }) }
      ]
    }});
    await goTab(h.page, "admin");
    await h.page.click("#cnav-admin-people");
    await settle(h.page, 600);
    await h.page.click(`[data-uid="${other.id}"] .row-menu-btn`);
    await settle(h.page, 200);
    await h.page.click('#adminRowMenu [data-edit-schedule]');
    await settle(h.page, 900);
    const landed = await h.page.evaluate(() => ({
      tab: (document.querySelector(".tab-panel.active") || {}).id,
      section: (document.querySelector("#settingsConsole .console-section.active") || {}).getAttribute?.("data-section"),
      label: document.getElementById("settingsForLabel").textContent,
      start: document.getElementById("sIn").value,
      target: document.querySelector("#sTargetCard [data-target-value]").textContent,
      locked: document.getElementById("scheduleForm").disabled
    }));
    ok(landed.tab === "tab-settings" && landed.section === "hours",
      "People > Edit Schedule opens Settings on the Schedule", JSON.stringify(landed));
    ok(/Person 2/.test(landed.label) && landed.start === "09:30" && landed.target === "6h" && !landed.locked,
      "holding that person's own schedule, editable, and saying whose it is", JSON.stringify(landed));
    // Their sign-in is theirs: shown, not changeable, and the way to help.
    await h.page.click("#cnav-security");
    await settle(h.page, 300);
    const sec = await h.page.evaluate(() => ({
      email: document.getElementById("securityEmail").textContent,
      note: document.getElementById("securityOthers").textContent,
      change: !!document.getElementById("changePasswordOpenBtn").getClientRects().length,
      sessions: !!document.getElementById("signOutOthersBtn").getClientRects().length
    }));
    ok(/person2@/.test(sec.email) && /Only Person 2 can change their password/.test(sec.note) && /Reset Password/.test(sec.note) &&
       !sec.change && !sec.sessions,
      "an admin sees whose sign-in it is and how to send a reset link, with nothing to change", JSON.stringify(sec));
    await h.page.click("#cnav-hours");
    await settle(h.page, 200);
    await h.page.fill("#sLeaveDays", "28");
    await h.page.click("#saveSettingsBtn");
    await settle(h.page, 700);
    const rowOf = id => (h.backend.state.user_settings.find(r => r.user_id === id) || {}).settings || {};
    ok(rowOf(other.id).annualLeaveDays === 28 && rowOf(other.id).standardIn === "09:30" && rowOf(me.id).annualLeaveDays === D.SETTINGS.annualLeaveDays,
      "Save writes their row and leaves the admin's own alone",
      JSON.stringify({ theirs: rowOf(other.id).annualLeaveDays, mine: rowOf(me.id).annualLeaveDays }));
    ok(h.errors.length === 0, "edit schedule from People: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Settings > Sign-in & Security ---------------------------------------
  // The account's way in, in one section: the address, changing the password
  // (which needs the current one), a reset link for a forgotten one, Face ID,
  // and signing out the other devices. The backend is seeded with a password
  // so a wrong one is refused the way Auth would.
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: { password: "old-password-1",
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }] }});
    await goTab(h.page, "settings");
    await h.page.click("#cnav-security");
    await settle(h.page, 500);
    const first = await h.page.evaluate(() => ({
      email: document.getElementById("securityEmail").textContent,
      formHidden: document.getElementById("changePasswordForm").hidden,
      faceId: !!document.getElementById("passkeyBlock").getClientRects().length,
      inProfile: !!document.querySelector("#csec-profile #passkeyBlock"),
      others: !!document.getElementById("signOutOthersBtn").getClientRects().length
    }));
    ok(first.email === me.email && first.formHidden && first.faceId && !first.inProfile && first.others,
      "Sign-in & Security shows the sign-in address, a folded password form, Face ID sign-in and Sign Out Other Devices",
      JSON.stringify(first));

    const calls = () => h.backend.state.authCalls.map(c => c.call);
    const errorNow = () => h.page.evaluate(() => document.getElementById("changePasswordError").textContent);
    await h.page.click("#changePasswordOpenBtn");
    await h.page.fill("#currentPassword", "not-it-at-all");
    await h.page.fill("#changeNewPassword", "brand-new-pass-2");
    await h.page.fill("#changeNewPassword2", "brand-new-pass-2");
    await h.page.click("#changePasswordBtn");
    await settle(h.page, 600);
    ok(await errorNow() === "That isn't your current password." && !calls().includes("updateUser"),
      "a wrong current password is refused and nothing is changed", JSON.stringify({ error: await errorNow(), calls: calls() }));

    await h.page.fill("#currentPassword", "old-password-1");
    await h.page.fill("#changeNewPassword2", "something-else-3");
    const before = calls().length;
    await h.page.click("#changePasswordBtn");
    await settle(h.page, 300);
    ok(await errorNow() === "The two new passwords don't match." && calls().length === before,
      "two different new passwords are caught before anything is sent", await errorNow());

    await h.page.fill("#changeNewPassword2", "brand-new-pass-2");
    await h.page.click("#changePasswordBtn");
    await settle(h.page, 900);
    const update = h.backend.state.authCalls.find(c => c.call === "updateUser") || {};
    const after = await h.page.evaluate(() => ({
      formHidden: document.getElementById("changePasswordForm").hidden,
      signedIn: document.getElementById("appShell").style.display !== "none",
      toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent.trim()).join(" | ")
    }));
    ok(update.password === "brand-new-pass-2" && update.current_password === "old-password-1",
      "the right current password changes it, and the current one is sent along for Auth to check too", JSON.stringify(update));
    ok(after.formHidden && after.signedIn && /Password changed/.test(after.toasts),
      "the form folds away, the person stays signed in, and it says so", JSON.stringify(after));

    await h.page.click("#securityResetLinkBtn");
    await settle(h.page, 500);
    const recover = h.backend.state.authCalls.find(c => c.call === "recover") || {};
    ok(recover.email === me.email, "Forgot it? emails a reset link to the address the account signs in with", JSON.stringify(recover));

    await h.page.click("#signOutOthersBtn");
    await settle(h.page, 300);
    await h.page.click(".modal-overlay .modal-confirm");
    await settle(h.page, 700);
    const out = h.backend.state.authCalls.find(c => c.call === "logout") || {};
    ok(out.scope === "others" && await h.page.evaluate(() => document.getElementById("appShell").style.display !== "none"),
      "Sign Out Other Devices signs out everywhere else and keeps this one signed in", JSON.stringify(out));
    // The wrong current password above is answered 400, as Auth answers it;
    // the browser logs that as a failed resource, which is not a script error.
    const realErrors = h.errors.filter(e => !/status of 400/.test(e));
    ok(realErrors.length === 0, "sign-in & security: no script errors", realErrors.join(" | "));
    await h.close();
  }

  // ---- Settings: switches act at once; Save is the Schedule's alone ------
  // NN/g's toggle guidance: a switch never waits for a Save button, or
  // nobody can tell whether it took. The reminder switches used to wait for
  // Save Settings beside a notifications switch that did not.
  {
    const me = D.profile(1, { role: "admin" });
    const other = D.profile(2);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me, other], entries: [],
      user_settings: [
        { user_id: me.id, settings: D.SETTINGS },
        { user_id: other.id, settings: Object.assign({}, D.SETTINGS, { remindClockIn: false, remindClockOut: true }) }
      ]
    }});
    const mine = () => (h.backend.state.user_settings.find(r => r.user_id === me.id) || {}).settings || {};
    const theirs = () => (h.backend.state.user_settings.find(r => r.user_id === other.id) || {}).settings || {};
    const dirty = () => h.page.evaluate(() => ({
      bar: document.querySelector("#settingsConsole .console-commit-group").classList.contains("is-dirty"),
      discard: !document.getElementById("discardSettingsBtn").hidden }));
    await goTab(h.page, "settings");
    await h.page.click("#cnav-hours");
    await settle(h.page, 300);
    ok(JSON.stringify(await dirty()) === '{"bar":false,"discard":false}', "an untouched Schedule shows no unsaved-changes bar");

    // An edit left unsaved in Schedule...
    await h.page.fill("#sLeaveDays", "45");
    await settle(h.page, 100);
    ok(JSON.stringify(await dirty()) === '{"bar":true,"discard":true}',
      "editing a Schedule field marks the Save bar as holding unsaved changes, with Discard");

    // ...is neither saved nor lost by a reminder switch.
    await h.page.click("#cnav-notifications");
    await settle(h.page, 200);
    const savedBar = await h.page.evaluate(() => document.querySelector("#settingsConsole .console-commit-group").hidden);
    ok(savedBar, "Reminders has no Save button: its switches save themselves");
    await h.page.click('label[for="sRemindIn"]');
    await settle(h.page, 600);
    ok(mine().remindClockIn === false && mine().annualLeaveDays === D.SETTINGS.annualLeaveDays,
      "flipping the clock-in reminder saves that one choice at once, and not the unsaved leave days",
      JSON.stringify({ remindClockIn: mine().remindClockIn, annualLeaveDays: mine().annualLeaveDays }));
    ok(await h.page.evaluate(() => document.getElementById("sRemindIn").getAttribute("role") === "switch"),
      "and it is announced as a switch");
    await h.page.click("#cnav-hours");
    await settle(h.page, 200);
    ok(await h.page.evaluate(() => document.getElementById("sLeaveDays").value) === "45",
      "the unsaved leave days are still in the form afterwards");

    // Discard puts the saved values back.
    await h.page.click("#discardSettingsBtn");
    await settle(h.page, 200);
    ok(await h.page.evaluate(() => document.getElementById("sLeaveDays").value) === String(D.SETTINGS.annualLeaveDays)
      && JSON.stringify(await dirty()) === '{"bar":false,"discard":false}',
      "Discard puts the saved schedule back and clears the bar");

    ok(theirs().remindClockIn === false, "and someone else's reminder switch is still theirs", JSON.stringify(theirs()));
    ok(h.errors.length === 0, "switches and Save: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- One Team Schedule; a person is on it or has their own ---------------
  // Admin > Team Schedule replaced "Organisation Defaults" (a template copied
  // once at sign-up), "Apply to everyone" and "Give these to people with no
  // schedule". Saving it moves everyone on it -- same week, times and
  // Ramadan dates as the one being replaced, or no schedule row at all -- and
  // leaves anyone with their own alone. Leave days are each person's own.
  {
    const TEAM = Object.assign({}, D.SETTINGS, { annualLeaveDays: 21, periods: [
      { id: "r1", name: "Ramadan 2027", start: "2027-02-08", end: "2027-03-08", targetMin: 360, standardIn: "10:00", standardOut: "16:00" }] });
    const boss = D.profile(1, { role: "admin" });
    const onTeam = D.profile(2, { full_name: "Tara Team" });
    const ownOne = D.profile(3, { full_name: "Omar Own" });
    const noRow = D.profile(4, { full_name: "Nadia New" });
    const h = await boot({ meId: boss.id, seed: {
      profiles: [boss, onTeam, ownOne, noRow], entries: [],
      app_settings: [{ id: 1, default_settings: TEAM, allow_registration: true }],
      user_settings: [
        { user_id: boss.id, settings: TEAM },
        { user_id: onTeam.id, settings: Object.assign({}, TEAM, { annualLeaveDays: 30, remindClockIn: false }) },
        { user_id: ownOne.id, settings: Object.assign({}, TEAM, { standardIn: "07:00", standardOut: "15:00", targetMin: 480 }) }
      ]
    }});
    const rowOf = id => (h.backend.state.user_settings.find(r => r.user_id === id) || {}).settings || null;
    const source = () => h.page.evaluate(() => {
      const b = document.getElementById("scheduleSource");
      return b.hidden ? "hidden" : document.getElementById("scheduleSourcePill").textContent +
        (document.getElementById("useTeamScheduleBtn").hidden ? "" : " +use");
    });

    // Admin > Team Schedule: End 16:00 -> 15:00.
    await goTab(h.page, "admin");
    await h.page.click("#cnav-admin-defaults");
    await settle(h.page, 500);
    ok(await h.page.evaluate(() => document.querySelector("#cnav-admin-defaults .console-nav-title").textContent) === "Team Schedule",
      "the admin section is called Team Schedule");
    await h.page.fill("#dOut", "15:00");
    await h.page.click("#saveDefaultsBtn");
    await settle(h.page, 300);
    const ask = await h.page.evaluate(() => (document.querySelector(".modal-overlay .modal-msg") || {}).textContent || "");
    ok(/3 people are on the team schedule/.test(ask) && /1 with a schedule of their own keeps it/.test(ask),
      "saving asks first, saying who moves and who keeps their own", ask);
    await h.page.click(".modal-overlay .modal-confirm");
    await settle(h.page, 1200);
    ok(rowOf(onTeam.id).standardOut === "15:00" && rowOf(onTeam.id).targetMin === 420 &&
       rowOf(onTeam.id).annualLeaveDays === 30 && rowOf(onTeam.id).remindClockIn === false,
      "someone on the team schedule moves to the new hours, keeping their own leave days and reminders", JSON.stringify(rowOf(onTeam.id)));
    ok(rowOf(ownOne.id).standardIn === "07:00" && rowOf(ownOne.id).standardOut === "15:00" && rowOf(ownOne.id).targetMin === 480,
      "someone with their own schedule keeps it", JSON.stringify(rowOf(ownOne.id)));
    ok(rowOf(noRow.id) && rowOf(noRow.id).standardOut === "15:00" && rowOf(noRow.id).annualLeaveDays === 21,
      "someone with no schedule at all is put on the team schedule, with its leave days", JSON.stringify(rowOf(noRow.id)));
    ok((h.backend.state.app_settings[0].default_settings || {}).standardOut === "15:00", "and the Team Schedule itself is saved");

    // A person's Schedule says which they're on; an admin can bring the
    // odd one out back.
    const editSchedule = async who => {
      await goTab(h.page, "admin");
      await h.page.click("#cnav-admin-people");
      await settle(h.page, 500);
      await h.page.click(`[data-uid="${who.id}"] .row-menu-btn`);
      await settle(h.page, 200);
      await h.page.click('#adminRowMenu [data-edit-schedule]');
      await settle(h.page, 900);
    };
    await editSchedule(onTeam);
    ok(await source() === "Team schedule", "Tara's Schedule says Team schedule", await source());
    await editSchedule(ownOne);
    ok(await source() === "Own schedule +use", "Omar's says Own schedule, with Use the Team Schedule", await source());
    await h.page.click("#useTeamScheduleBtn");
    await settle(h.page, 200);
    ok(await h.page.evaluate(() => document.getElementById("sIn").value + "-" + document.getElementById("sOut").value) === "08:00-15:00",
      "Use the Team Schedule fills in the team's hours");
    await h.page.click("#saveSettingsBtn");
    await settle(h.page, 800);
    ok(rowOf(ownOne.id).standardIn === "08:00" && await source() === "Team schedule",
      "and once saved, Omar is on the team schedule", JSON.stringify({ row: rowOf(ownOne.id).standardIn, source: await source() }));
    ok(h.errors.length === 0, "team schedule: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Admin, laid out the way Settings is ----------------------------------
  // The People, Everyone, System order; no heading or refresh button of its
  // own; the sign-up setting as a switch that saves itself; the banner
  // posted and taken down rather than ticked and saved; who has their own
  // schedule marked on the list; Team Schedule's Save saying it has unsaved
  // changes, with Discard.
  {
    const boss = D.profile(1, { role: "admin", full_name: "Boss Admin" });
    const onTeam = D.profile(2, { full_name: "Tara Team" });
    const ownOne = D.profile(3, { full_name: "Omar Own" });
    const h = await boot({ meId: boss.id, seed: {
      profiles: [boss, onTeam, ownOne], entries: [],
      app_settings: [{ id: 1, default_settings: D.SETTINGS, allow_registration: true,
        announcement_active: false, announcement: null, announcement_until: null, announcement_posted_at: null }],
      user_settings: [
        { user_id: boss.id, settings: D.SETTINGS },
        { user_id: onTeam.id, settings: Object.assign({}, D.SETTINGS, { annualLeaveDays: 30 }) },
        { user_id: ownOne.id, settings: Object.assign({}, D.SETTINGS, { standardIn: "07:00", standardOut: "15:00" }) }
      ]
    }});
    const app = () => h.backend.state.app_settings[0];
    const shown = sel => h.page.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);
    await goTab(h.page, "admin");
    await settle(h.page, 600);

    const layout = await h.page.evaluate(() => ({
      groups: [...document.querySelectorAll("#adminConsole .console-nav-group-title")].map(e => e.textContent.trim()),
      first: document.querySelector("#adminConsole .console-nav-item").id,
      selected: (document.querySelector('#adminConsole .console-nav-item[aria-selected="true"]') || {}).id,
      headShown: [...document.querySelectorAll("#tab-admin .console-head > *")].some(e => e.getClientRects().length && getComputedStyle(e).position !== "absolute"),
      ownRefresh: !!document.getElementById("refreshStatsBtn")
    }));
    ok(layout.groups.join(",") === "People,Everyone,System", "Admin's sections run People, Everyone, System", JSON.stringify(layout.groups));
    ok(layout.first === "cnav-admin-people" && layout.selected === "cnav-admin-people",
      "People is first, and open on a wide screen", JSON.stringify(layout));
    ok(!layout.headShown && !layout.ownRefresh, "no second heading and no refresh button of Admin's own", JSON.stringify(layout));

    // The header's refresh reloads the console.
    const stats = () => h.backend.state.log.filter(r => /admin_db_stats/.test(r.path)).length;
    const before = stats();
    await h.page.evaluate(() => document.getElementById("refreshBtn").click());
    await settle(h.page, 900);
    ok(stats() > before, "the header's refresh reloads the Admin figures", `${before} -> ${stats()}`);

    // The warning about sign-ups with no team schedule stays hidden when
    // one is set. A display:flex rule used to show it to every admin.
    ok(!(await shown("#registrationDefaultsHint")), "with a team schedule set, there is no warning about one");

    // Sign-up: a switch that saves the moment it moves.
    ok(await shown("#csec-admin-people #setAllowRegistration"), "the sign-up switch is in People");
    await h.page.click('label[for="setAllowRegistration"]');
    await settle(h.page, 700);
    ok(app().allow_registration === false, "switching sign-up off saves at once, with no Save", JSON.stringify(app()));
    await h.page.click('label[for="setAllowRegistration"]');
    await settle(h.page, 700);
    ok(app().allow_registration === true, "and switching it back on saves at once too");

    // People marks the one on a schedule of their own, and can show only them.
    const marks = await h.page.evaluate(() => [...document.querySelectorAll("#adminUsersList .admin-user-row")]
      .map(r => r.querySelector(".admin-user-name").textContent.replace(/\s+/g, " ").trim()));
    ok(marks.filter(m => /Own schedule/.test(m)).length === 1 && marks.some(m => /Omar Own.*Own schedule/.test(m)),
      "only the person with their own schedule is marked", JSON.stringify(marks));
    await h.page.selectOption("#adminUserFilter", "own");
    await settle(h.page, 200);
    ok(await h.page.evaluate(() => document.querySelectorAll("#adminUsersList .admin-user-row").length) === 1,
      "Show: Own schedule lists just them");
    await h.page.selectOption("#adminUserFilter", "all");

    // Announcement: posted, then taken down.
    await h.page.click("#cnav-admin-app");
    await settle(h.page, 300);
    const state = () => h.page.evaluate(() => ({
      title: document.getElementById("announceStateTitle").textContent,
      takeDown: !document.getElementById("takeDownAnnouncementBtn").hidden,
      post: document.getElementById("postAnnouncementBtn").textContent,
      nav: document.getElementById("cnavDescApp").textContent
    }));
    let st = await state();
    ok(st.title === "Not showing" && !st.takeDown && st.post === "Post Announcement",
      "with no banner up, it says so and offers Post", JSON.stringify(st));
    await h.page.click("#postAnnouncementBtn");
    await settle(h.page, 400);
    ok(!app().announcement_active, "Post with no message is refused");
    await h.page.fill("#setAnnouncement", "Office closed Thursday");
    await h.page.click("#postAnnouncementBtn");
    await settle(h.page, 800);
    st = await state();
    ok(app().announcement_active && app().announcement === "Office closed Thursday" && !!app().announcement_posted_at,
      "Post puts the banner up", JSON.stringify(app()));
    ok(st.title === "Showing to everyone" && st.takeDown && st.post === "Update Announcement" && st.nav === "Banner on",
      "and the section says it is showing, with Take Down", JSON.stringify(st));
    await h.page.click("#takeDownAnnouncementBtn");
    await settle(h.page, 800);
    st = await state();
    ok(!app().announcement_active && app().announcement === "Office closed Thursday",
      "Take Down takes it down and keeps the message", JSON.stringify(app()));
    ok(st.title === "Not showing" && st.nav === "Banner off", "and the section says so", JSON.stringify(st));
    ok(!(await h.page.evaluate(() => document.getElementById("announcementBanner").classList.contains("show"))),
      "the banner is gone from the admin's own screen");

    // Team Schedule: Unsaved changes, and Discard puts the saved one back.
    await h.page.click("#cnav-admin-defaults");
    await settle(h.page, 300);
    ok(!(await shown("#discardDefaultsBtn")), "an untouched Team Schedule offers no Discard");
    await h.page.fill("#dOut", "15:30");
    await settle(h.page, 200);
    const dirty = await h.page.evaluate(() => ({
      dirty: document.getElementById("defaultsCommit").classList.contains("is-dirty"),
      note: getComputedStyle(document.getElementById("defaultsDirtyNote")).display !== "none"
    }));
    ok(dirty.dirty && dirty.note && await shown("#discardDefaultsBtn"),
      "an edit says Unsaved changes and offers Discard", JSON.stringify(dirty));
    // A refresh while editing leaves the edit where it is.
    await h.page.evaluate(() => document.getElementById("refreshBtn").click());
    await settle(h.page, 900);
    ok(await h.page.inputValue("#dOut") === "15:30", "a refresh does not write over an unsaved edit");
    await h.page.click("#discardDefaultsBtn");
    await settle(h.page, 300);
    ok(await h.page.inputValue("#dOut") === D.SETTINGS.standardOut && !(await shown("#discardDefaultsBtn")),
      "Discard puts the saved Team Schedule back", await h.page.inputValue("#dOut"));

    // The composer's message is drawn like every other field.
    await h.page.click("#cnav-admin-notifications");
    await settle(h.page, 300);
    const fonts = await h.page.evaluate(() => ({
      body: getComputedStyle(document.getElementById("notifyBody")).fontFamily,
      title: getComputedStyle(document.getElementById("notifyTitle")).fontFamily,
      when: getComputedStyle(document.getElementById("notifySchedule")).borderRadius,
      field: getComputedStyle(document.getElementById("notifyTitle")).borderRadius
    }));
    ok(fonts.body === fonts.title && fonts.when === fonts.field,
      "the message box and Send at are styled like the other fields", JSON.stringify(fonts));

    // System: the data checks and the backup are one section. Overview's
    // tiles repeated other rows (Users, Database Size) or were database
    // plumbing (connections, the Postgres version); they are gone.
    const sys = await h.page.evaluate(() => {
      const system = [...document.querySelectorAll("#adminConsole .console-nav-group")]
        .find(g => /System/.test(g.querySelector(".console-nav-group-title").textContent));
      return {
        items: [...system.querySelectorAll(".console-nav-title")].map(e => e.textContent.trim()),
        tiles: !!document.querySelector("#tab-admin .stat-card"),
        plumbing: /Postgres|connection limit/i.test(document.getElementById("tab-admin").textContent),
        nav: document.getElementById("cnavDescAdminData").textContent
      };
    });
    ok(sys.items.join(",") === "Data & Backup,Activity Log,Crash Reports",
      "System holds Data & Backup, Activity Log and Crash Reports", JSON.stringify(sys.items));
    ok(!sys.tiles && !sys.plumbing, "no figures that repeat other rows, and no database plumbing", JSON.stringify(sys));
    ok(sys.nav === "All clear · No backup yet", "its row says both halves: the checks, then the backup", sys.nav);

    // An empty list is a sentence: no filters, download or headings over it.
    await h.page.click("#cnav-admin-audit");
    await settle(h.page, 300);
    const empties = await h.page.evaluate(() => ({
      auditFilters: document.getElementById("adminAuditFilters").getClientRects().length,
      auditTools: document.getElementById("auditTools").getClientRects().length,
      auditTable: document.querySelector("#csec-admin-audit .table-wrap").getClientRects().length,
      auditSays: document.getElementById("auditEmpty").getClientRects().length ? document.getElementById("auditEmpty").textContent : "",
      crash: document.getElementById("adminCrashFilters").hidden && document.querySelector("#csec-admin-crashes .table-wrap").hidden,
      notify: document.querySelector("#csec-admin-notifications .notify-filter").hidden
    }));
    ok(!empties.auditFilters && !empties.auditTools && !empties.auditTable && empties.auditSays === "No activity recorded yet.",
      "an empty Activity Log is one sentence", JSON.stringify(empties));
    ok(empties.crash && empties.notify,
      "Crash Reports and the notification history hide their filters when there is nothing to filter", JSON.stringify(empties));

    // Company-Wide Days: no Sick Leave for a whole team, and the holidays the
    // menu row counts are named in the section.
    await h.page.click("#cnav-admin-bulk");
    await settle(h.page, 300);
    const kinds = await h.page.evaluate(() => [...document.querySelectorAll("#bulkApplyType option")].map(o => o.value));
    ok(!kinds.includes("sick"), "Mark as offers no Sick Leave for the whole team", JSON.stringify(kinds));
    ok(!(await shown("#companyDaysList")), "with no holidays marked, no list of them");
    await h.page.click("#bulkApplyBtn");
    await settle(h.page, 400);
    const ask = await h.page.evaluate(() => ({
      title: document.querySelector(".modal-overlay .modal-title").textContent,
      yes: document.querySelector(".modal-overlay .modal-confirm").textContent
    }));
    ok(ask.title === "Mark for everyone?" && ask.yes === "Mark for Everyone", "the dialog uses the button's words", JSON.stringify(ask));
    await h.page.click(".modal-overlay .modal-confirm");
    await settle(h.page, 900);
    const y = String(new Date().getFullYear());
    const marked = await h.page.evaluate(() => ({
      list: document.getElementById("companyDaysList").hidden ? "" : document.getElementById("companyDaysList").textContent,
      nav: document.getElementById("cnavDescBulk").textContent,
      away: document.getElementById("cnavDescAway").textContent
    }));
    ok(h.backend.state.entries.filter(e => e.type === "holiday").length === 3, "everyone gets the day", h.backend.state.entries.length);
    ok(marked.list.startsWith("Public holidays in " + y + ": ") && marked.nav === "1 public holiday in " + y,
      "the section names the day and the menu row counts it at once", JSON.stringify(marked));
    ok(marked.away === "Everyone away 1 day this week", "Who's Away's row says it without calling it a day off", marked.away);
    ok(h.errors.length === 0, "admin layout: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- An open shift says when you can leave --------------------------------
  // The rail card, the phone's Today line and the sticky bar used to show
  // hours so far and time to go. They show the time to leave now: clock-in
  // plus the day's target (owner, 2026-11-18), and when the shift began.
  {
    const pad = n => String(n).padStart(2, "0");
    const hhmm = m => pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60);
    const twelve = t => { const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + ":" + pad(m) + " " + (h >= 12 ? "PM" : "AM"); };
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const everyDay = Object.assign({}, D.SETTINGS, { workDays: [0,1,2,3,4,5,6] });
    const read = page => page.evaluate(() => ({
      label: document.getElementById("sealLabel").textContent,
      value: document.getElementById("sealValue").textContent,
      sub: document.getElementById("sealSub").hidden ? "" : document.getElementById("sealSub").textContent,
      line: document.getElementById("todayLineLabel").textContent + " " + document.getElementById("todayLineValue").textContent,
      sticky: document.getElementById("stickyClockShift").textContent
    }));
    const shiftFrom = async inMin => {
      const me = D.profile(1);
      const h = await boot({ meId: me.id, seed: {
        profiles: [me], user_settings: [{ user_id: me.id, settings: everyDay }],
        entries: [{ id: "open", user_id: me.id, date: today, clock_in: hhmm(inMin), clock_out: null, type: "regular", note: "" }]
      }});
      await settle(h.page, 400);
      const v = await read(h.page);
      v.errors = h.errors.slice();
      await h.close();
      return v;
    };

    // Two hours in (or since midnight, early in the day): eight hours to make.
    const inMin = Math.max(0, nowMin - 120);
    const early = await shiftFrom(inMin);
    const leave = twelve(hhmm(inMin + 480)), since = twelve(hhmm(inMin));
    ok(early.label === "Leave at" && early.value === leave && early.sub === "In since " + since,
      "an open shift shows when you can leave (clock-in plus the day's hours), and when it began", JSON.stringify(early));
    ok(early.line === "Leave at " + leave && early.sticky === "In since " + since + " · Leave at " + leave,
      "the phone's Today line and the sticky bar say the same", JSON.stringify(early));
    ok(!/to go|\dh \d+m$/.test(early.sub + early.value),
      "and neither hours so far nor time to go is shown", JSON.stringify(early));
    ok(early.errors.length === 0, "open shift readout: no script errors", early.errors.join(" | "));

    // Nine hours in: the hours are done.
    if(nowMin >= 540){
      const late = await shiftFrom(nowMin - 540);
      const at = twelve(hhmm(nowMin - 540 + 480));
      ok(late.label === "Leave at" && late.value === at && /^Hours done · in since /.test(late.sub) &&
         /Hours done at /.test(late.sticky),
        "once the hours are made it says so", JSON.stringify(late));
    }
  }

  // ---- Double-submit: the entry-add form must also write exactly once ----
  {
    const me = D.profile(1);
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    await goTab(h.page, "log");
    await h.page.evaluate(() => document.querySelector("[data-add-entry], #addEntryBtn")?.click());
    await settle(h.page, 300);
    await h.page.fill("#fDate", "2026-09-05").catch(() => {});
    await h.page.fill("#fIn", "08:00").catch(() => {});
    await h.page.fill("#fOut", "16:00").catch(() => {});
    await h.page.evaluate(() => { for(let i=0;i<10;i++) document.getElementById("submitBtn").click(); });
    await settle(h.page, 1200);
    const written = h.backend.state.entries.filter(e => e.user_id === me.id && e.date === "2026-09-05").length;
    ok(written === 1, "10 same-tick clicks on the entry form's Submit write exactly one entry",
      `entries written: ${written}`);
    await h.close();
  }

  // ---- Hostile names must not push the page into horizontal scroll -------
  for(const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]){
    const people = D.roster(12), me = people[0];
    const h = await boot({ viewport, meId: me.id, seed: {
      profiles: people,
      entries: D.entriesFor(me.id, 10),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});

    await goTab(h.page, "team");
    await settle(h.page, 500);
    let scrollX = await h.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(scrollX === 0, `Team tab has no horizontal overflow with hostile names (${label})`, `overflow: ${scrollX}px`);

    await goTab(h.page, "admin");
    await settle(h.page, 300);
    await h.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => /^People$/m.test(b.textContent.trim().split("\n")[0]));
      if(btn) btn.click();
    });
    await settle(h.page, 400);
    scrollX = await h.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(scrollX === 0, `Admin People list has no horizontal overflow with an unbroken name (${label})`, `overflow: ${scrollX}px`);

    await h.close();
  }

  // ---- PWA: offline outbox and a failed background load coexist ----------
  // Installed, portrait, opened with no connection but a persisted session —
  // clocking in must still queue (the outbox is the one thing this app does
  // offline) even while the background entries/settings fetch is failing and
  // showing its own banner; neither must hide or block the other.
  {
    const me = D.profile(1);
    const h = await boot({ viewport: PHONE, meId: me.id, seed: {
      profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }, beforeLoad: ({ backend }) => backend.fail("/rest/v1/", { mode: "offline" }, Infinity) });
    await settle(h.page, 1200);
    await h.page.evaluate(() => document.getElementById("qcClockBtn").click());
    await settle(h.page, 1000);
    const snap = await h.page.evaluate(() => ({
      outboxShown: document.getElementById("outboxBanner").classList.contains("show"),
      failBanner: document.getElementById("loadFailBanner").classList.contains("show"),
      loggedRow: document.querySelectorAll("#logBody tr").length
    }));
    ok(snap.outboxShown, "a punch made offline still queues while the background load is also failing");
    ok(snap.failBanner, "the load-failure banner still shows alongside the outbox banner");
    ok(snap.loggedRow === 1, "the queued punch renders in the log immediately, offline");
    await h.close();
  }

  // ---- The notification history has to show what was actually sent -------
  // Every check here is a thing the panel could not answer before: what the
  // message said, who it went to by name, who sent it, and — for a send still
  // queued — when it is due, which read "Just now" for a time that had not
  // arrived yet because fmtRelative only ever handled the past.
  {
    const people = D.roster(5).slice(0, 5);
    const me = people[0];
    me.role = "admin";
    const iso = m => new Date(Date.now() + m * 60000).toISOString();
    const notifications = [
      { id:"h1", created_by:me.id, title:"Early close today",
        body:"Shutting at 2pm for the building inspection.",
        target_type:"all", target_user_ids:null, action:null, action_payload:null,
        scheduled_for:iso(-30), status:"sent", sent_at:iso(-30),
        recipient_count:3, failure_count:0, error_detail:null, created_at:iso(-31) },
      { id:"h2", created_by:me.id, title:"Timesheet reminder",
        body:"September needs completing before Thursday.",
        target_type:"users", target_user_ids:[people[1].id, people[2].id],
        action:null, action_payload:null,
        scheduled_for:iso(-1440), status:"sent", sent_at:iso(-1440),
        recipient_count:1, failure_count:1, error_detail:null, created_at:iso(-1441) },
      { id:"h3", created_by:me.id, title:"Ramadan hours",
        body:"Reduced hours from Monday.",
        target_type:"all", target_user_ids:null, action:null, action_payload:null,
        scheduled_for:iso(2880), status:"pending", sent_at:null,
        recipient_count:null, failure_count:null, error_detail:null, created_at:iso(-60) },
      { id:"h4", created_by:null, title:"You're still clocked in",
        body:"You clocked in at 8:00 AM and haven't clocked out.",
        target_type:"users", target_user_ids:[people[3].id],
        action:"clock_out", action_payload:{date:"2026-09-08"},
        scheduled_for:iso(-120), status:"sent", sent_at:iso(-120),
        recipient_count:1, failure_count:0, error_detail:null, created_at:iso(-121) },
      { id:"h5", created_by:me.id, title:"Server maintenance",
        body:"Briefly unavailable tonight.",
        target_type:"all", target_user_ids:null, action:null, action_payload:null,
        scheduled_for:iso(-4000), status:"failed", sent_at:null,
        recipient_count:0, failure_count:0,
        error_detail:"VAPID credentials rejected by the push service (401).", created_at:iso(-4001) }
    ];

    const openNotifications = async page => {
      await goTab(page, "admin");
      await settle(page, 400);
      await page.evaluate(() => document.getElementById("cnav-admin-notifications").click());
      await settle(page, 600);
    };

    const h = await boot({ meId: me.id, seed: {
      profiles: people, entries: [],
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })),
      push_notifications: notifications,
      // h1 went to four devices belonging to three people; one of them is a
      // dead subscription, which is the case the reported "1 failed" was.
      push_deliveries: [
        { id:"pd1", notification_id:"h1", user_id:people[1].id, device:"Chrome on Windows",
          status:"delivered", status_code:null, error_detail:null, created_at:iso(-30) },
        { id:"pd2", notification_id:"h1", user_id:people[1].id, device:"Safari on iPhone",
          status:"delivered", status_code:null, error_detail:null, created_at:iso(-30) },
        { id:"pd3", notification_id:"h1", user_id:people[3].id, device:"Firefox on Mac",
          status:"delivered", status_code:null, error_detail:null, created_at:iso(-30) },
        { id:"pd4", notification_id:"h1", user_id:people[2].id, device:"Safari on iPhone",
          status:"expired", status_code:410,
          error_detail:"This device's subscription has expired or was revoked (410). It has been removed -- that person can switch notifications back on from Settings on that device.",
          created_at:iso(-30) }
      ],
      push_subscriptions: [
        { id:"s1", user_id:people[1].id, endpoint:"https://push.example/1", p256dh:"k", auth:"a", user_agent:"Chrome", created_at:iso(-500) },
        { id:"s2", user_id:people[1].id, endpoint:"https://push.example/2", p256dh:"k", auth:"a", user_agent:"Safari", created_at:iso(-500) },
        { id:"s3", user_id:people[3].id, endpoint:"https://push.example/3", p256dh:"k", auth:"a", user_agent:"Firefox", created_at:iso(-500) }
      ]
    }});
    await openNotifications(h.page);

    const view = await h.page.evaluate(() => ({
      history: document.getElementById("notifyHistoryList").innerText,
      reach: document.getElementById("notifyReach").hidden
        ? "" : document.getElementById("notifyReach").innerText,
      // The queued send is the only actionable row, so it leads regardless of
      // being older by created_at than two of the sends below it.
      firstTitle: (document.querySelector("#notifyHistoryList .attention-title") || {}).innerText || ""
    }));

    ok(view.history.includes("Shutting at 2pm for the building inspection."),
      "the history shows the message that was sent, not just its title");
    ok(view.history.includes(people[1].full_name) && view.history.includes(people[2].full_name),
      "a send to specific people names them instead of counting them");
    ok(/From\s/.test(view.history), "an admin-composed send says who composed it");
    ok(view.history.includes("Automatic"),
      "the automatic clock-out reminder is marked as automatic, not attributed to an admin");
    ok(/in\s\d+d/.test(view.history) && !/Scheduled\s+Just now/.test(view.history),
      "a scheduled send says how long until it goes, not \"Just now\"",
      view.history.split("\n").slice(0, 4).join(" | "));
    ok(view.history.includes("VAPID credentials rejected by the push service (401)."),
      "a failed send shows the reason it failed");
    ok(view.firstTitle.includes("Ramadan hours"),
      "the still-queued send sorts above sends that have already gone",
      view.firstTitle);
    ok(/2 of 5 people have notifications on/.test(view.reach) && /3 devices/.test(view.reach),
      "the composer says how many people can actually be reached", view.reach);

    // "3 devices · 1 failed" is a count nobody can act on: not whose device,
    // not why. The breakdown behind "Who got it" is what makes the number
    // mean something, so it has to name the person, the device and the reason.
    await h.page.evaluate(() => document.querySelector('[data-who-notify="h1"]').click());
    await settle(h.page, 400);
    const who = await h.page.evaluate(() => {
      const panel = document.querySelector('[data-people-for="h1"]');
      return {
        hidden: panel.hidden,
        text: panel.innerText,
        // Whoever had the problem is what this list is opened to find.
        firstPerson: (panel.querySelector(".notify-person") || {}).innerText || ""
      };
    });
    ok(!who.hidden, "\"Who got it\" opens the per-device breakdown");
    ok(who.text.includes(people[2].full_name) && /Safari on iPhone/.test(who.text),
      "the breakdown names whose device it was, and which device", who.text.slice(0, 120));
    ok(/expired or was revoked \(410\)/.test(who.text),
      "a failed device says why, in words rather than a status code", who.text.slice(0, 200));
    ok(who.firstPerson.includes(people[2].full_name),
      "the person with a problem sorts above the people who received it", who.firstPerson);
    ok(who.text.includes(people[1].full_name) && (who.text.match(/DELIVERED/g) || []).length >= 2,
      "someone with two devices is one person with two lines, not two people", who.text.slice(0, 200));

    // The filter exists because the automatic reminder writes one row per
    // person per open shift per day and would otherwise bury everything an
    // admin ever sent.
    await h.page.evaluate(() => document.querySelector('[data-notify-filter="admin"]').click());
    await settle(h.page, 200);
    const adminOnly = await h.page.evaluate(() => document.getElementById("notifyHistoryList").innerText);
    ok(!adminOnly.includes("You're still clocked in") && adminOnly.includes("Early close today"),
      "the \"sent by admins\" filter hides the automatic reminders");
    await h.page.evaluate(() => document.querySelector('[data-notify-filter="auto"]').click());
    await settle(h.page, 200);
    const autoOnly = await h.page.evaluate(() => document.getElementById("notifyHistoryList").innerText);
    ok(autoOnly.includes("You're still clocked in") && !autoOnly.includes("Early close today"),
      "the \"automatic\" filter shows only what the reminder job sent");
    await h.close();

    // Nobody subscribed is the state that made a send to everyone look
    // identical to a send to no one -- it must say so before the send.
    const h2 = await boot({ meId: me.id, seed: {
      profiles: people, entries: [],
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })),
      push_notifications: [], push_subscriptions: []
    }});
    await openNotifications(h2.page);
    const empty = await h2.page.evaluate(() => {
      const el = document.getElementById("notifyReach");
      return el.hidden ? "" : el.innerText;
    });
    ok(/reach no one/i.test(empty),
      "with nobody subscribed, the composer says a send would reach nobody", empty);
    await h2.close();
  }

  // ---- A person can see WHERE their notifications actually arrive --------
  // A push subscription is per device, per browser. The Settings toggle only
  // ever described the browser it was being read in, so enabling it at a desk
  // left the phone -- the device the reminders are for -- receiving nothing,
  // with every screen in the app agreeing notifications were on.
  {
    const me = D.profile(1, { role: "admin" });
    const sub = (n, ua, mins) => ({ id: "s" + n, user_id: me.id, endpoint: "https://push.example/" + n,
      p256dh: "k", auth: "a", user_agent: ua, created_at: new Date(Date.now() - mins * 60000).toISOString() });
    const FIREFOX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0";
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Safari/605.1";
    const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

    const openNotifications = async page => {
      await goTab(page, "settings");
      await settle(page, 400);
      await page.evaluate(() => document.querySelector(
        '#settingsConsole .console-nav-item[data-console-target="notifications"]').click());
      await settle(page, 600);
    };
    const readPanel = page => page.evaluate(() => {
      const w = document.getElementById("pushDevicesWrap");
      return { hidden: w.hidden, text: w.innerText,
        names: [...document.querySelectorAll(".push-device-name")].map(n => n.textContent.trim()) };
    });

    // One device is the misleading case: it reads as "notifications are on"
    // while the phone in your pocket is not on this list.
    const one = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
      push_subscriptions: [sub(1, FIREFOX, 2880)]
    }});
    await openNotifications(one.page);
    const solo = await readPanel(one.page);
    ok(!solo.hidden, "the device list is shown, not hidden behind a service worker that never became ready");
    ok(solo.names.join() === "Firefox on Linux",
      "each subscription is named as a device a person would recognise", JSON.stringify(solo.names));
    ok(/only device/.test(solo.text) && /per device/.test(solo.text) && /phone/.test(solo.text),
      "with one device it says so, and says to enable it on the phone as well",
      solo.text.replace(/\n/g, " | ").slice(0, 160));
    await one.close();

    // Three devices, including both phone platforms.
    const many = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
      push_subscriptions: [sub(1, FIREFOX, 2880), sub(2, IPHONE, 60), sub(3, ANDROID, 30)]
    }});
    await openNotifications(many.page);
    const all = await readPanel(many.page);
    ok(all.names.length === 3 && all.names.includes("Safari on iPhone") && all.names.includes("Chrome on Android"),
      "a phone on each platform is listed and told apart", JSON.stringify(all.names));
    ok(/not listed here/.test(all.text),
      "and it still says an unlisted device receives nothing", all.text.slice(0, 140));
    await many.close();

    // Nobody subscribed: the panel has to say that plainly rather than being
    // absent, which reads as "fine".
    const none = await boot({ meId: me.id, seed: {
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
      push_subscriptions: []
    }});
    await openNotifications(none.page);
    const empty = await readPanel(none.page);
    ok(!empty.hidden && /would not reach you anywhere/.test(empty.text),
      "with no devices at all it says notifications would reach nobody", empty.text.slice(0, 120));
    await none.close();
  }

  // ---- Enabling instructions are the platform's, not a generic sentence ---
  // "Enable notifications in your settings" is worth nothing on the two
  // platforms most people read it on: iOS needs the app on the Home Screen
  // before push exists at all, and Android hides the switch in the OS.
  {
    const lines = source();
    const grab = (a, b) => {
      const s = lines.findIndex(l => l.trim().startsWith(a));
      const e = s + lines.slice(s).findIndex(l => l.trim().startsWith(b));
      return lines.slice(s, e).join("\n");
    };
    const code = grab("function isIOS()", "function enableInstructionsFor") + "\n" +
                 grab("function enableInstructionsFor", "async function refreshPushDevices");
    const say = (ua, standalone, touchPoints) => {
      const sb = { navigator: { userAgent: ua, maxTouchPoints: touchPoints || 0 },
        isSafariBrowser: () => /^((?!chrome|android|crios|fxios|edgios|opios).)*safari/i.test(ua),
        isStandaloneDisplay: () => !!standalone };
      vm.createContext(sb); vm.runInContext(code, sb);
      return sb.enableInstructionsFor();
    };
    const ios = say("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Safari/605.1");
    ok(/Home Screen/.test(ios) && /Share/.test(ios),
      "iPhone is told the app must be added to the Home Screen first", ios.slice(0, 110));
    ok(/iOS Settings/.test(ios),
      "and that iOS itself must allow notifications for it too", ios.slice(0, 200));

    const android = say("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36");
    ok(/Android Settings/.test(android) && /Install app|Add to Home screen/.test(android),
      "Android is told where its own notification switch lives", android.slice(0, 140));
    ok(!/Home Screen: open it in Safari/.test(android),
      "and is not given the iPhone's instructions");

    const mac = say("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1", false);
    ok(/Add to Dock/.test(mac), "Mac Safari is told to add it to the Dock", mac.slice(0, 100));
    // iPadOS Safari reports itself as a Mac; only the touch screen gives it away.
    const ipad = say("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1", false, 5);
    ok(/Home Screen/.test(ipad) && !/Add to Dock/.test(ipad),
      "an iPad (which calls itself a Mac) gets the Home Screen steps", ipad.slice(0, 100));
  }

  // ---- "In today" lists people in the order they arrived ------------------
  // Earliest clock-in first, whether that person is still in or already done;
  // the pill beside each name says which. Run as the admin and as an employee,
  // because the two read today through different paths (the tables directly
  // versus list_today_presence()).
  {
    const pad2 = n => String(n).padStart(2, "0");
    const T = (d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)(new Date());
    const mk = (n, name, role) => ({ id: D.UUID(n), email: `a${n}@example.com`, full_name: name,
      role: role || "user", avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" });
    const people = [ mk(1, "Amy Late"), mk(2, "Zed Early"), mk(3, "Max Middle"),
      mk(4, "Kim Nothing"), mk(5, "Boss Admin", "admin") ];
    const entries = [
      { id: "t1", user_id: D.UUID(1), date: T, clock_in: "09:40:00", clock_out: null, type: "regular", note: "" },
      { id: "t2", user_id: D.UUID(2), date: T, clock_in: "07:15:00", clock_out: "15:00:00", type: "regular", note: "" },
      { id: "t3", user_id: D.UUID(3), date: T, clock_in: "08:05:00", clock_out: null, type: "regular", note: "" }
    ];
    for (const meId of [D.UUID(5), D.UUID(4)]) {
      const who = meId === D.UUID(5) ? "admin" : "employee";
      const h = await boot({ meId, seed: { profiles: people, entries,
        user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })) }});
      await settle(h.page, 900);
      const order = await h.page.evaluate(() =>
        [...document.querySelectorAll("#todayTeamList .tt-name")].map(n => n.textContent.trim().split(" ")[0]));
      ok(JSON.stringify(order) === JSON.stringify(["Zed", "Max", "Amy"]),
        `In today runs earliest arrival first, done or not (${who})`, JSON.stringify(order));
      await h.close();
    }
  }

  // ---- The roster leads with whoever is working today --------------------
  // Alphabetical put whoever had not logged anything among the people who
  // had, so the roster had to be read in full to find either. The default
  // sort is the tab's own question: who is in, who has finished, who is
  // legitimately not here, and — last — who has logged nothing.
  {
    const pad2 = n => String(n).padStart(2, "0");
    const dstr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const today = new Date(), T = dstr(today), dow = today.getDay();
    // Everyone is scheduled today except the one person who must read "Day
    // off", whose work days are every day but this one.
    const every = [0, 1, 2, 3, 4, 5, 6];
    const settings = Object.assign({}, D.SETTINGS, { workDays: every });
    const offToday = Object.assign({}, D.SETTINGS, { workDays: every.filter(d => d !== dow) });

    const mk = (n, name) => ({ id: D.UUID(n), email: `p${n}@example.com`, full_name: name,
      role: n === 7 ? "admin" : "user", avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" });
    const people = [ mk(1, "Zoe Clockedin"), mk(2, "Adam Done"), mk(3, "Nina Leave"),
      mk(4, "Wendy Weekend"), mk(5, "Bob Missing"), mk(6, "Yara Never"), mk(7, "Aseel Admin") ];

    const entries = [];
    let id = 1;
    const row = (uid, date, ci, co, type) => entries.push({ id: id++, user_id: uid, date,
      clock_in: ci, clock_out: co, type, note: "", updated_at: new Date().toISOString() });
    row(D.UUID(1), T, "08:00:00", null, "regular");        // still in
    row(D.UUID(2), T, "08:00:00", "16:05:00", "regular");  // finished
    row(D.UUID(3), T, null, null, "leave");                // excused
    // Nothing today for the last three. Bob has most of the month behind him,
    // the admin has a little, and Yara has never logged anything at all.
    // Drawn from this calendar month's other days rather than counted back
    // from today: the Team tab totals the month, so early in a month most of
    // "the last six days" fell in the previous one and Bob tied the admin.
    const monthDays = [];
    for(let n = 1; monthDays.length < 6; n++){
      const d = new Date(today.getFullYear(), today.getMonth(), n);
      if(dstr(d) !== T) monthDays.push(dstr(d));
    }
    monthDays.forEach(ds => row(D.UUID(5), ds, "08:00:00", "16:00:00", "regular"));
    monthDays.slice(0, 2).forEach(ds => row(D.UUID(7), ds, "08:00:00", "16:00:00", "regular"));

    const h = await boot({ meId: D.UUID(7), seed: {
      profiles: people, entries,
      user_settings: people.map(p => ({ user_id: p.id,
        settings: p.id === D.UUID(4) ? offToday : settings }))
    }});
    await goTab(h.page, "team");
    await settle(h.page, 700);
    const order = await h.page.evaluate(() =>
      [...document.querySelectorAll("#teamList .team-card .team-name")]
        .map(n => n.textContent.trim().split(" ")[0]));

    ok(order[0] === "Zoe", "whoever is still clocked in leads the roster", JSON.stringify(order));
    ok(order[1] === "Adam", "then whoever has finished for the day", JSON.stringify(order));
    ok(order.indexOf("Nina") < order.indexOf("Bob") && order.indexOf("Wendy") < order.indexOf("Bob"),
      "leave and a day off rank above nothing-logged: they are answers, not absences",
      JSON.stringify(order));
    ok(order[order.length - 1] === "Yara",
      "somebody who has never logged anything sorts last of all", JSON.stringify(order));
    ok(order.indexOf("Bob") < order.indexOf("Aseel"),
      "inside the un-logged group, more of the month behind you ranks higher",
      JSON.stringify(order));

    // The alphabetical sort is still there for anyone who wants the roster as
    // a list of names rather than as today.
    await h.page.evaluate(() => {
      const s = document.getElementById("teamSort");
      s.value = "name"; s.dispatchEvent(new Event("change"));
    });
    await settle(h.page, 300);
    const byName = await h.page.evaluate(() =>
      [...document.querySelectorAll("#teamList .team-card .team-name")]
        .map(n => n.textContent.trim().split(" ")[0]));
    ok(byName[0] === "Adam" && byName[byName.length - 1] === "Zoe",
      "choosing Name still sorts alphabetically", JSON.stringify(byName));
    await h.close();
  }

  // ---- The People list reports activity, not authentication -------------
  // The reported shape exactly: someone whose last actual sign-in was 27 days
  // ago because their session never expired, who used the app this morning.
  // auth.users.last_sign_in_at says 27 days and is not wrong -- it is
  // answering a different question than the one being asked of it.
  {
    const people = D.roster(3).slice(0, 3);
    const me = people[0];
    me.role = "admin";
    const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();
    people[1].last_sign_in_at = daysAgo(27);
    people[1].last_seen_at = new Date(Date.now() - 30 * 60000).toISOString();  // half an hour ago
    people[2].last_sign_in_at = daysAgo(40);
    people[2].last_seen_at = null;                                             // never seen since

    const h = await boot({ meId: me.id, seed: {
      profiles: people, entries: [],
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await goTab(h.page, "admin");
    await settle(h.page, 400);
    await h.page.evaluate(() => document.getElementById("cnav-admin-people").click());
    await settle(h.page, 600);

    const row = await h.page.evaluate(uid => {
      // data-uid on the row itself, not a scan of its markup: the actions
      // that used to carry the id inline moved into the row menu.
      const el = document.querySelector(`#adminUsersList .admin-user-row[data-uid="${uid}"]`);
      const meta = el && el.querySelector(".admin-user-meta");
      return meta ? {text: meta.innerText, title: meta.getAttribute("title") || ""} : null;
    }, people[1].id);

    ok(!!row, "the People list renders the row under test");
    ok(row && /Last active\s+30m ago/.test(row.text),
      "someone with a live session reads as active today, not 27 days ago",
      row && row.text);
    ok(row && /Last signed in\s+27d ago/.test(row.title),
      "the actual sign-in is still available, on hover, since it is a different fact",
      row && row.title);

    // Nobody has been seen since the column was added: it falls back to the
    // sign-in rather than rendering "Never" over a person who plainly did.
    const never = await h.page.evaluate(uid => {
      const el = document.querySelector(`#adminUsersList .admin-user-row[data-uid="${uid}"]`);
      const meta = el && el.querySelector(".admin-user-meta");
      return meta ? meta.innerText : "";
    }, people[2].id);
    ok(/Last active\s+40d ago|Last active\s+\w{3}\s\d/.test(never),
      "with no last_seen_at recorded yet, the sign-in stands in rather than \"Never\"", never);
    await h.close();
  }

  // ---- the People row menu flips above a row sitting low on the screen ----
  // Most menus in a real roster open in the lower half of the list, where a
  // menu that only ever drops downward runs off the bottom of the screen and
  // takes Delete with it. Twelve people and a phone, because three rows at
  // the top of a desktop viewport never need the flip and a check run there
  // passes with the flip deleted.
  {
    const people = D.roster(12);
    const me = people[0]; me.role = "admin";
    const h = await boot({ viewport: PHONE, meId: me.id, seed: {
      profiles: people, entries: [],
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await goTab(h.page, "admin");
    await h.page.evaluate(() => document.getElementById("cnav-admin-people").click());
    await settle(h.page, 600);

    const low = await h.page.evaluate(() => {
      const rows = [...document.querySelectorAll("#adminUsersList .admin-user-row")];
      // Not the last row: nothing below it to scroll past, so it can never
      // reach the bottom of the screen. One with rows under it can.
      const row = rows[Math.floor(rows.length * 0.7)];
      row.scrollIntoView({ block: "end" });
      const btn = row.querySelector(".row-menu-btn");
      btn.click();
      const menu = document.getElementById("adminRowMenu");
      const m = menu.getBoundingClientRect(), b = btn.getBoundingClientRect();
      return {
        rows: rows.length,
        gapBelow: Math.round(window.innerHeight - b.bottom), menuH: Math.round(m.height),
        top: Math.round(m.top), bottom: Math.round(m.bottom), vh: window.innerHeight,
        needsFlip: m.height > (window.innerHeight - b.bottom),
        aboveTheRow: m.bottom <= Math.round(b.top) + 1,
        inside: m.top >= 0 && m.bottom <= window.innerHeight
      };
    });
    ok(low.needsFlip,
      "the row under test really is too low for the menu to drop below it",
      "otherwise the flip never runs and the next two assertions prove nothing: " + JSON.stringify(low));
    ok(low.inside, "the row menu stays fully on screen", JSON.stringify(low));
    ok(low.aboveTheRow, "by opening above the row rather than below it", JSON.stringify(low));
    await h.close();
  }

  // ---- PWA: the safe-area rule survives at every breakpoint that overrides
  // header padding, not just the base one --------------------------------
  // env(safe-area-inset-*) reads as 0 in every test browser (there is no
  // notched device here to measure against), so this checks that the rule
  // is still WRITTEN at each place that redeclares header padding — a later,
  // narrower breakpoint silently dropping the addition is exactly how this
  // gap existed in the first place (see index.html's own comment on the base
  // header.ledger-head rule).
  {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
    // Two of header.ledger-head's breakpoints are deliberately exempt: the
    // min-width:761px compact-desktop-chrome rule (no notch on a desktop
    // browser) and the orientation:landscape rule (a notch in landscape sits
    // on the left/right, not the top — a separate, unaddressed inset this
    // suite doesn't claim to cover). Every portrait/phone-width breakpoint —
    // the shape an installed PWA actually runs in, per manifest.json's own
    // orientation:portrait-primary — must carry the fix.
    // The nearest preceding @media line, however far back it is — a fixed
    // character window undercounted a 40-line block full of comments and
    // missed the min-width:761px rule it needed to exempt entirely.
    const lines = html.split("\n");
    let idx = 0;
    const rules = [];
    while(true){
      const found = html.indexOf("header.ledger-head{", idx);
      if(found === -1) break;
      const close = html.indexOf("}", found);
      const uptoHere = html.slice(0, found).split("\n").length;
      let mediaLine = "";
      for(let i = uptoHere - 1; i >= 0; i--){
        if(/@media/.test(lines[i])){ mediaLine = lines[i]; break; }
      }
      rules.push({ text: html.slice(found, close + 1), context: mediaLine });
      idx = close + 1;
    }
    ok(rules.length >= 5, "header.ledger-head has the breakpoints this check expects",
      `found ${rules.length}`);
    const exempt = r => /min-width:761px/.test(r.context) || /orientation:landscape/.test(r.context);
    const portraitRules = rules.filter(r => !exempt(r));
    const missing = portraitRules.filter(r => !r.text.includes("safe-area-inset-top"));
    ok(portraitRules.length >= 4, "at least 4 portrait/phone breakpoints are covered by this check",
      `found ${portraitRules.length}`);
    ok(missing.length === 0, "every portrait-relevant header.ledger-head breakpoint reserves the top safe area",
      missing.map(r => r.text).join("\n     "));
    // The selector moved when the sign-in screen became two columns. It cannot
    // be .auth-screen any more: that is now the grid holding both the ink panel
    // and the form column, and padding there would inset the panel too, which
    // is meant to reach the screen edge exactly as the rail does. The guarantee
    // is unchanged and still checked -- the column that actually holds the form
    // at every width reserves the inset, and below 900px it IS the whole
    // screen. The panel is checked separately: its ground bleeds to the edge
    // while its contents clear the housing, which is the rail's own bargain.
    ok(html.includes(".auth-main{") && /\.auth-main\{[^}]*safe-area-inset-top/.test(html),
      "the sign-in screen (the first thing an installed PWA shows) reserves the top safe area too");
    ok(/\.auth-aside\{[^}]*safe-area-inset-top/.test(html),
      "and the ink panel keeps its own contents out of the sensor housing");
  }

  // ---- notification centre ------------------------------------------------
  // The bell is the only place the five notices live now, so a badge that
  // does not track them is a notice nobody ever sees. The badge is driven by
  // a MutationObserver on the stack; observe() used to be started as a side
  // effect of the fold logic's finally{}, and removing that fold silently
  // stopped the observation while leaving the observer object in place --
  // the badge stuck on its first value forever. This pins it down.
  {
    const pad = n => String(n).padStart(2, "0");
    const dt = new Date(Date.now() - 864e5);
    const yest = dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const me = D.profile(1, { full_name: "Aseel Thalnoon" });
    const other = D.profile(2, { full_name: "Sara N" });
    const iso = mins => new Date(Date.now() - mins * 60000).toISOString();

    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: {
      profiles: [me, other],
      entries: [{ id:"e1", user_id: me.id, date: yest, clock_in:"08:00", clock_out:"", type:"regular", note:"" }],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
      push_notifications: [
        { id:"n1", title:"Payday moved", body:"September pay lands on the 28th.",
          target_type:"all", status:"sent", sent_at: iso(90), created_by: me.id },
        { id:"n2", title:"You never clocked out", body:"Your shift is still open.",
          target_type:"users", target_user_ids:[me.id], status:"sent", sent_at: iso(30),
          created_by: null, action:"clock_out", action_payload:{ date: yest } },
        { id:"n3", title:"Not for you", body:"Addressed to someone else.",
          target_type:"users", target_user_ids:[other.id], status:"sent", sent_at: iso(10), created_by: me.id },
        { id:"n4", title:"Still a draft", body:"Scheduled, not sent.",
          target_type:"all", status:"pending", created_by: me.id }
      ],
      notification_reads: [{ user_id: me.id, notification_id:"n1", read_at: iso(80) }]
    }});
    await settle(h.page, 900);

    const before = await h.page.evaluate(() => ({
      badge: document.getElementById("notifBadge").textContent,
      titles: Array.from(document.querySelectorAll(".notif-item-title")).map(x => x.textContent),
      unread: document.querySelectorAll(".notif-item:not(.is-read)").length,
      stackInPanel: !!document.querySelector("#notifOverlay #noticeStack"),
      stackOnPage: !!document.getElementById("noticeStack").getClientRects().length
    }));
    ok(before.stackInPanel && !before.stackOnPage,
      "the notices live in the bell's panel, not stacked on top of every screen");
    ok(!before.titles.includes("Not for you"),
      "a message targeted at another user is not readable", JSON.stringify(before.titles));
    ok(!before.titles.includes("Still a draft"),
      "an unsent message is not readable", JSON.stringify(before.titles));
    ok(before.badge === "2",
      "the badge counts live notices plus unread messages", "badge=" + before.badge);
    ok(before.unread === 1, "a message already marked read renders as read", "unread=" + before.unread);

    await h.page.evaluate(() => document.getElementById("notifBtn").click());
    await settle(h.page, 700);
    const opened = await h.page.evaluate(() => ({
      bgHidden: document.getElementById("appShell").getAttribute("aria-hidden"),
      focus: document.activeElement && document.activeElement.id,
      unread: document.querySelectorAll(".notif-item:not(.is-read)").length,
      badge: document.getElementById("notifBadge").textContent
    }));
    ok(opened.bgHidden === "true", "opening the panel hides the page behind it from assistive tech");
    ok(opened.focus === "notifCloseBtn", "focus moves into the panel", "focus=" + opened.focus);
    ok(opened.unread === 1 && opened.badge === "2",
      "opening the panel leaves unread messages unread",
      "unread=" + opened.unread + " badge=" + opened.badge);

    await h.page.evaluate(() => document.getElementById("notifMarkAllBtn").click());
    await settle(h.page, 500);
    const markedAll = await h.page.evaluate(() => ({
      unread: document.querySelectorAll(".notif-item:not(.is-read)").length,
      badge: document.getElementById("notifBadge").textContent,
      btnDisabled: document.getElementById("notifMarkAllBtn").disabled
    }));
    ok(markedAll.unread === 0 && markedAll.badge === "1" && markedAll.btnDisabled,
      "Mark all read clears every message, drops the badge to the live notice, and greys itself out",
      "unread=" + markedAll.unread + " badge=" + markedAll.badge + " btnDisabled=" + markedAll.btnDisabled);

    // Clear one message, then the rest with the two-tap Clear all.
    await h.page.evaluate(() => document.querySelector('[data-notif-dismiss="n1"]').click());
    await settle(h.page, 500);
    const clearedOne = await h.page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll(".notif-item")).map(x => x.getAttribute("data-notif-id")),
      focus: document.activeElement && document.activeElement.id
    }));
    ok(clearedOne.ids.join() === "n2",
      "clearing one message removes only that one", JSON.stringify(clearedOne.ids));
    ok(clearedOne.focus === "notifCloseBtn",
      "focus lands inside the panel when the row it was on disappears", "focus=" + clearedOne.focus);

    await h.page.evaluate(() => document.getElementById("notifClearAllBtn").click());
    await settle(h.page, 300);
    const armed = await h.page.evaluate(() => document.querySelectorAll(".notif-item").length);
    ok(armed === 1, "the first tap on Clear all only asks, it clears nothing", "rows=" + armed);
    await h.page.evaluate(() => document.getElementById("notifClearAllBtn").click());
    await settle(h.page, 500);
    const clearedAll = await h.page.evaluate(() => ({
      rows: document.querySelectorAll(".notif-item").length,
      disabled: document.getElementById("notifClearAllBtn").disabled
    }));
    ok(clearedAll.rows === 0 && clearedAll.disabled,
      "the second tap clears every message and greys the button out",
      "rows=" + clearedAll.rows + " disabled=" + clearedAll.disabled);

    // Cleared stays cleared: a fresh fetch from the server brings nothing back.
    await h.page.evaluate(() => document.getElementById("refreshBtn").click());
    await settle(h.page, 1200);
    const afterRefresh = await h.page.evaluate(() => document.querySelectorAll(".notif-item").length);
    ok(afterRefresh === 0, "cleared messages do not come back on refresh", "rows=" + afterRefresh);

    // Resolve the live notice from inside the panel; the badge must follow.
    await h.page.evaluate(() => document.getElementById("reminderActions").querySelector("button").click());
    await settle(h.page, 1500);
    const after = await h.page.evaluate(() => ({
      badge: document.getElementById("notifBadge").textContent,
      hidden: document.getElementById("notifBadge").hidden,
      shown: Array.from(document.querySelectorAll("#noticeStack .reminder"))
        .filter(n => n.classList.contains("show")).length
    }));
    ok(after.shown === 0 && after.hidden && after.badge === "0",
      "the badge clears when the last notice resolves (the MutationObserver is actually observing)",
      "shown=" + after.shown + " badge=" + after.badge + " hidden=" + after.hidden);

    await h.close();
  }

  // ---- an announcement ends on its own, and anyone can hide it ------------
  // The banner used to stay up, for everyone, until an admin switched it off:
  // "Happy weekend!" was still in every bell's count the following Tuesday.
  {
    const pad2 = n => String(n).padStart(2, "0");
    const dstr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const today = new Date(), T = dstr(today);
    const yesterday = dstr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const me = { id: D.UUID(1), email: "a1@example.com", full_name: "Ann Nouncement", role: "user",
      avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" };
    const banner = until => [{ id: 1, default_settings: null, allow_registration: true,
      announcement_active: true, announcement: "Office closed Thursday", announcement_until: until,
      announcement_posted_at: new Date(Date.now() - 2 * 3600e3).toISOString() }];
    const seedWith = app_settings => ({ profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }], app_settings });
    const state = page => page.evaluate(() => {
      const b = document.getElementById("notifBadge");
      return { showing: document.getElementById("announcementBanner").classList.contains("show"),
               badge: b.hidden ? "" : b.textContent };
    });

    // Its last day still shows it; the day after does not.
    for(const [until, expect, label] of [[T, true, "through the end of its last day"],
                                         [yesterday, false, "and not the day after"]]){
      const e = await boot({ meId: me.id, seed: seedWith(banner(until)) });
      await settle(e.page, 900);
      const s = await state(e.page);
      ok(s.showing === expect, `an announcement with an end date shows ${label}`, JSON.stringify(s));
      await e.close();
    }

    // Hiding it: gone from the bell and its count, and still gone after a reload.
    const h = await boot({ meId: me.id, seed: seedWith(banner(null)) });
    await settle(h.page, 900);
    const before = await state(h.page);
    ok(before.showing && before.badge === "1",
      "a live announcement is in the bell and in its count", JSON.stringify(before));
    await h.page.evaluate(() => document.getElementById("notifBtn").click());
    await settle(h.page, 500);
    await h.page.evaluate(() => document.getElementById("announcementHideBtn").click());
    await settle(h.page, 600);
    const hidden = await state(h.page);
    ok(!hidden.showing && hidden.badge === "",
      "the x hides the announcement and the badge clears", JSON.stringify(hidden));
    ok(h.backend.state.announcement_hides.some(r => r.user_id === me.id),
      "the hide is saved to the account, so it holds on every device");
    await h.page.reload();
    await settle(h.page, 1200);
    ok(!(await state(h.page)).showing, "a hidden announcement stays hidden after a reload");

    // A new announcement is a new announcement: it shows again by itself.
    Object.assign(h.backend.state.app_settings[0], { announcement: "Payday is Thursday",
      announcement_posted_at: new Date(Date.now() + 1000).toISOString() });
    await h.page.reload();
    await settle(h.page, 1200);
    ok((await state(h.page)).showing, "a newer announcement shows again after the old one was hidden");
    await h.close();

    // Clear all covers it too, even with no messages in the list.
    const c = await boot({ meId: me.id, seed: seedWith(banner(null)) });
    await settle(c.page, 900);
    await c.page.evaluate(() => document.getElementById("notifBtn").click());
    await settle(c.page, 500);
    ok(await c.page.evaluate(() => !document.getElementById("notifClearAllBtn").disabled),
      "Clear all is available when the announcement is the only thing to clear");
    await c.page.evaluate(() => document.getElementById("notifClearAllBtn").click());
    await c.page.evaluate(() => document.getElementById("notifClearAllBtn").click());
    await settle(c.page, 600);
    ok(!(await state(c.page)).showing, "Clear all hides the announcement as well");
    await c.close();

    // The admin's side: an end date already in the past is refused; a real
    // one saves, and the banner counts as freshly posted.
    const boss = { id: D.UUID(2), email: "boss@example.com", full_name: "Boss Admin", role: "admin",
      avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" };
    const a = await boot({ meId: boss.id, seed: { profiles: [boss], entries: [],
      user_settings: [{ user_id: boss.id, settings: D.SETTINGS }],
      app_settings: [{ id: 1, default_settings: D.SETTINGS, allow_registration: false,
        announcement_active: false, announcement: null,
        announcement_until: null, announcement_posted_at: null }] } });
    await settle(a.page, 900);
    const save = (text, until) => a.page.evaluate(([t, u]) => {
      document.getElementById("setAnnouncement").value = t;
      document.getElementById("setAnnouncementUntil").value = u;
      document.getElementById("postAnnouncementBtn").click();
    }, [text, until]);
    await save("Old news", yesterday);
    await settle(a.page, 700);
    ok(!a.backend.state.app_settings[0].announcement_active,
      "an end date that has already passed is refused, not saved");
    await save("Office closed Thursday", T);
    await settle(a.page, 900);
    const row = a.backend.state.app_settings[0];
    ok(row.announcement_until === T && !!row.announcement_posted_at,
      "the end date saves, and the banner counts as posted", JSON.stringify(row));
    ok(await a.page.evaluate(() => document.getElementById("announcementBanner").classList.contains("show")),
      "the admin sees the banner they just posted");
    await a.close();

    // Before the database has the new columns, nothing new is offered: no end
    // date to send to a column that is not there, no hide that would fail.
    const pre = await boot({ meId: boss.id, seed: { profiles: [boss], entries: [],
      user_settings: [{ user_id: boss.id, settings: D.SETTINGS }],
      app_settings: [{ id: 1, default_settings: D.SETTINGS, allow_registration: false,
        announcement_active: true, announcement: "Office closed Thursday" }] } });
    await settle(pre.page, 900);
    const offered = await pre.page.evaluate(() => ({
      showing: document.getElementById("announcementBanner").classList.contains("show"),
      hide: !document.getElementById("announcementHideBtn").hidden,
      until: !document.getElementById("setAnnouncementUntilWrap").hidden
    }));
    ok(offered.showing && !offered.hide && !offered.until,
      "before the migration the banner still shows, with no hide button and no end date field",
      JSON.stringify(offered));
    await pre.close();
  }

  // ---- notifications off on this device: asked once, then a quiet line ------
  // A device without notifications misses the reminders and every admin
  // message. Until 2026-11-17 it was asked in a dialog on every launch and
  // every return after a real absence; the owner changed that. Now the dialog
  // comes once per person per device, straight after their first clock-in
  // there, and the rest of the time a line in the Overview's clock panel says
  // notifications are off and carries the button.
  {
    // A device that can receive push. The harness blocks the real service
    // worker, so the worker and its push manager are stood in for -- along
    // with a clock the test can move, for "came back after a while".
    const pushDevice = perm => async ({ page }) => {
      await page.addInitScript(initial => {
        // A real browser remembers the permission and the subscription across
        // a reload, so the stand-in keeps them in sessionStorage.
        const KEY = "__fakePush";
        const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
        let permission = saved ? saved.permission : initial, subscribed = null;
        const save = () => sessionStorage.setItem(KEY, JSON.stringify({ permission, subscribed: !!subscribed }));
        const sub = { endpoint: "https://push.example.test/me", options: null,
          toJSON(){ return { endpoint: this.endpoint, keys: { p256dh: "p256dh", auth: "auth" } }; },
          unsubscribe: async () => true };
        if(saved && saved.subscribed) subscribed = sub;
        const reg = { pushManager: {
          getSubscription: async () => subscribed,
          subscribe: async () => { subscribed = sub; save(); return sub; }
        } };
        Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, get: () => Promise.resolve(reg) });
        Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
        Notification.requestPermission = async () => {
          permission = permission === "denied" ? "denied" : "granted"; save(); return permission;
        };
        const realNow = Date.now.bind(Date);
        window.__skewMs = 0;
        Date.now = () => realNow() + window.__skewMs;
      }, perm);
    };
    const me = { id: D.UUID(3), email: "np@example.com", full_name: "No Push", role: "user",
      avatar_updated_at: null, created_at: "2026-01-01T00:00:00Z" };
    const seed = extra => Object.assign({ profiles: [me], entries: [],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }] }, extra || {});
    const dialog = page => page.evaluate(() => {
      const o = document.querySelector(".modal-overlay");
      if(!o) return null;
      const every = o.querySelector(".push-prompt-every");
      return { title: o.querySelector(".modal-title").textContent,
        every: every ? every.textContent : "",
        buttons: [...o.querySelectorAll(".modal-actions .btn")].map(b => b.textContent.trim()) };
    });
    const line = page => page.evaluate(() => {
      const l = document.getElementById("pushLine");
      return l && !l.hidden && l.getClientRects().length
        ? { text: document.getElementById("pushLineText").textContent, button: document.getElementById("pushLineBtn").textContent }
        : null;
    });
    // The day-one card's clock (the record starts empty). The flood plays
    // over the whole screen from it; the question waits for it to clear.
    const clockIn = async page => {
      await page.evaluate(() => document.getElementById("firstRunClockBtn").click());
      await settle(page, 2900);
    };

    const h = await boot({ meId: me.id, seed: seed(), beforeLoad: pushDevice("default") });
    await settle(h.page, 1200);
    ok(!(await dialog(h.page)), "a device without notifications is not asked at launch");
    const quiet = await line(h.page);
    ok(!!quiet && /off on this device/.test(quiet.text) && quiet.button === "Turn On",
      "the clock panel says notifications are off here, with Turn On", JSON.stringify(quiet));

    const awayFor = ms => h.page.evaluate(ms => {
      const set = v => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
      set("hidden"); document.dispatchEvent(new Event("visibilitychange"));
      window.__skewMs += ms;
      set("visible"); document.dispatchEvent(new Event("visibilitychange"));
    }, ms);
    await awayFor(11 * 60 * 1000);
    await settle(h.page, 800);
    ok(!(await dialog(h.page)), "coming back after a long absence does not ask either");

    await clockIn(h.page);
    const first = await dialog(h.page);
    ok(!!first && /Turn on notifications/.test(first.title) && /won't pop up again/.test(first.every),
      "the first clock-in on this device asks, once, and says it won't again", JSON.stringify(first));
    await h.page.evaluate(() => document.querySelector(".modal-overlay .modal-cancel").click());
    await settle(h.page, 400);
    ok(!(await dialog(h.page)), "Not Now closes it");
    ok(!!(await line(h.page)), "and the line stays");

    // A later clock-in on this device: no question. (Today's punch is taken
    // away on the server, so the day can be clocked into again.)
    h.backend.state.entries = [];
    await h.page.reload();
    await settle(h.page, 1200);
    ok(!(await dialog(h.page)), "a launch after it was asked does not ask");
    await clockIn(h.page);
    ok(!(await dialog(h.page)), "nor does the next clock-in");

    // The line's Turn On is what ends it.
    await h.page.evaluate(() => document.getElementById("pushLineBtn").click());
    await settle(h.page, 900);
    ok(h.backend.state.push_subscriptions.some(r => r.user_id === me.id), "the line's Turn On registers this device");
    ok(!(await line(h.page)), "and the line goes");
    await h.page.reload();
    await settle(h.page, 1200);
    ok(!(await line(h.page)) && !(await dialog(h.page)), "with a device registered, nothing asks at all");
    await h.close();

    // Blocked: the line says so, and its button explains how to undo it.
    const b = await boot({ meId: me.id, seed: seed(), beforeLoad: pushDevice("denied") });
    await settle(b.page, 1200);
    ok(!(await dialog(b.page)), "blocked: no dialog at launch");
    const bl = await line(b.page);
    ok(!!bl && /blocked/.test(bl.text) && bl.button === "How to Allow", "blocked: the line says so", JSON.stringify(bl));
    await b.page.evaluate(() => document.getElementById("pushLineBtn").click());
    await settle(b.page, 500);
    const blocked = await dialog(b.page);
    ok(!!blocked && /blocked/i.test(blocked.title) && blocked.buttons.join() === "Got It",
      "and How to Allow says how, with no button pretending it can ask again", JSON.stringify(blocked));
    await b.close();

    // Notifications on another device already: this device still says it,
    // because it is this one that would miss them.
    const o = await boot({ meId: me.id, beforeLoad: pushDevice("default"), seed: seed({
      push_subscriptions: [{ id: 1, user_id: me.id, endpoint: "https://push.example.test/phone",
        p256dh: "x", auth: "y", user_agent: "Mozilla/5.0 (iPhone)" }] }) });
    await settle(o.page, 1200);
    ok(!!(await line(o.page)), "someone with notifications on another device still sees the line on this one");
    // Hidden for a while by its ×, and still hidden after a reload.
    await o.page.evaluate(() => document.getElementById("pushLineHideBtn").click());
    await settle(o.page, 300);
    ok(!(await line(o.page)), "the × hides the line");
    await o.page.reload();
    await settle(o.page, 1200);
    ok(!(await line(o.page)), "and it stays hidden on the next launch");
    await o.close();

    // Allowed on this device, but its registration was removed (from the
    // device list, say): put back quietly, with no question and no line.
    const g = await boot({ meId: me.id, seed: seed(), beforeLoad: pushDevice("granted") });
    await settle(g.page, 1200);
    ok(!(await dialog(g.page)) && !(await line(g.page)), "permission already granted: no question, no line");
    ok(g.backend.state.push_subscriptions.some(r => r.user_id === me.id),
      "and this device is registered without asking");
    await g.close();

    // Another dialog open when the clock-in asks: the question waits for it
    // to close, rather than being lost -- it is the one time it is asked.
    const w = await boot({ meId: me.id, seed: seed(), beforeLoad: pushDevice("default") });
    await settle(w.page, 1200);
    await w.page.evaluate(() => {
      document.getElementById("firstRunClockBtn").click();
      const blocker = document.createElement("div");
      blocker.className = "modal-overlay"; blocker.id = "testBlocker";
      document.body.appendChild(blocker);
    });
    await settle(w.page, 2900);
    ok(!(await w.page.evaluate(() => !!document.querySelector(".modal-overlay .push-prompt-every"))),
      "not shown on top of another dialog");
    await w.page.evaluate(() => document.getElementById("testBlocker").remove());
    await settle(w.page, 2200);
    const after = await dialog(w.page);
    ok(!!after && /Turn on notifications/.test(after.title), "asked once that dialog closes", JSON.stringify(after));
    await w.close();
  }

  // ---- a notice inside the panel must still be readable -------------------
  // Above 761px the notice stack lays a notice out as an inline strip -- icon,
  // title, sentence and buttons as flex siblings on one line -- because on top
  // of the screen every row it costs is a row the tab below loses. Inside a
  // 480px panel that inverts: the sentence was squeezed into a column about
  // one character wide and wrapped ~100 characters straight down the page.
  // Nothing threw and no test caught it; it was visible only in a screenshot.
  for(const [vp, label] of [[DESKTOP, "desktop"], [PHONE, "phone"]]){
    const pad = n => String(n).padStart(2, "0");
    const dt = new Date(Date.now() - 864e5);
    const yest = dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const me = D.profile(1, { full_name: "Aseel Thalnoon" });
    const h = await boot({ viewport: vp, meId: me.id, seed: {
      profiles: [me],
      entries: [{ id:"e1", user_id: me.id, date: yest, clock_in:"08:00", clock_out:"", type:"regular", note:"" }],
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    await settle(h.page, 700);
    await h.page.evaluate(() => document.getElementById("notifBtn").click());
    await settle(h.page, 600);
    const m = await h.page.evaluate(() => {
      const t = document.getElementById("reminderText");
      const b = t.getBoundingClientRect();
      return {
        textW: Math.round(b.width),
        panelW: Math.round(document.querySelector(".notif-panel").getBoundingClientRect().width),
        lines: Math.round(b.height / parseFloat(getComputedStyle(t).lineHeight)),
        chars: (t.textContent || "").length
      };
    });
    ok(m.textW > m.panelW * 0.5,
      `[${label}] a notice's sentence gets the panel's width rather than being squeezed by its siblings`,
      `text ${m.textW}px inside a ${m.panelW}px panel`);
    ok(m.lines < 8,
      `[${label}] and wraps to a sane number of lines`,
      `${m.lines} lines for ${m.chars} characters`);
    await h.close();
  }

  // ---- the registration guard must not clobber the reset form -------------
  // refreshRegistrationVisibility() runs at boot, awaits public_app_flags, and
  // then backs out of the register form if sign-ups turn out to be closed. It
  // did that by calling showSignInForm(), which also hides the reset-password
  // form -- so arriving from a password-reset email with sign-ups closed was a
  // race between an RPC and the PASSWORD_RECOVERY event. When the RPC landed
  // second it wiped "choose a new password" and left the visitor on the
  // sign-in screen with nothing to explain it.
  //
  // The delay makes that ordering deterministic rather than hoping for it.
  {
    const people = D.roster(3), me = people[0];
    const h = await boot({ viewport: PHONE, meId: me.id, signedOut: true, waitForApp: false,
      seed: { profiles: people, entries: [], user_settings: [],
              app_settings: [{ id: 1, allow_registration: false }] },
      beforeLoad: ({ backend }) => backend.fail("rpc/public_app_flags", { delayMs: 900 }, 1)
    });
    // Put the reset screen up while the flags call is still in flight, which
    // is what the recovery event does.
    await h.page.evaluate(() => {
      document.getElementById("signInForm").style.display = "none";
      document.getElementById("registerForm").style.display = "none";
      document.getElementById("resetPasswordForm").style.display = "flex";
    });
    await settle(h.page, 1600);   // well past the delayed RPC
    const r = await h.page.evaluate(() => ({
      reset: document.getElementById("resetPasswordForm").style.display,
      signIn: document.getElementById("signInForm").style.display,
      register: document.getElementById("showRegisterBtn").style.display
    }));
    ok(r.reset === "flex",
      "a visible reset-password form survives the registration flags landing",
      `the form is display:${r.reset} -- the visitor cannot finish setting a password`);
    ok(r.signIn === "none",
      "and the sign-in form is not pulled back over it",
      `sign-in is display:${r.signIn}`);
    ok(r.register === "none",
      "while the flag itself still took effect",
      "Create an account is still offered with sign-ups closed");
    await h.close();
  }

  // ---- Crash reports render, and hostile ones do not break the page -------
  // The crash log is the one table whose contents are written by a machine
  // rather than a person. A thrown Error carries URLs, minified symbols and
  // file paths, and none of those contain a space to wrap at -- so the column
  // has to break mid-token or the whole admin panel goes sideways. It did:
  // a 70-character unbreakable string in this section pushed a 320px screen
  // 227px past its own edge.
  {
    const people = D.roster(3);
    const me = people[0];
    me.role = "admin";
    const NASTY = "Failed to fetch https://example.invalid/a/very/long/unbroken/path/that/has/nowhere/to/wrap/at/all/x.json";
    const h = await boot({ viewport: PHONE, meId: me.id, seed: {
      profiles: people,
      entries: D.entriesFor(me.id, 5),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })),
      client_errors: [
        { id:"c1", user_id: people[1].id, occurred_at:"2026-09-14T10:00:00Z", kind:"error",
          message:"Cannot read properties of undefined (reading 'length')",
          source:"https://example.com/app.js", line:4127, col:19, build:"crash-console-1",
          url:"/index.html", user_agent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
        { id:"c2", user_id: me.id, occurred_at:"2026-09-15T09:00:00Z", kind:"unhandledrejection",
          message: NASTY, source:null, line:null, col:null, build:"crash-console-1",
          url:"/index.html", user_agent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
        { id:"c3", user_id: me.id, occurred_at:"2026-09-13T08:00:00Z", kind:"resource",
          message:"Failed to load img: /missing.png", source:null, line:null, col:null,
          build:"modules-3", url:"/index.html", user_agent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/141.0" },
        // From the sign-up screen: no one was signed in, so no user.
        { id:"c4", user_id: null, occurred_at:"2026-09-12T08:00:00Z", kind:"error",
          message:"Cannot read properties of null (reading 'focus')", source:"https://example.com/app.js",
          line:6702, col:8, build:"v41", url:"/index.html",
          user_agent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
      ]
    }});
    await goTab(h.page, "admin");
    await settle(h.page, 500);
    await h.page.evaluate(() => document.getElementById("cnav-admin-crashes").click());
    await settle(h.page, 600);

    const view = await h.page.evaluate(() => ({
      rows: document.querySelectorAll("#crashBody tr").length,
      text: document.getElementById("crashBody").innerText,
      empty: getComputedStyle(document.getElementById("crashEmpty")).display,
      count: document.getElementById("crashCount").textContent,
      overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)
    }));

    ok(view.rows === 4, "every recorded crash is listed", JSON.stringify(view.rows));
    ok(view.empty === "none", "the empty state is not shown alongside rows", view.empty);
    ok(/4 reports/.test(view.count), "the nav row carries the count", view.count);
    // A signed-out crash says where it happened instead of showing a dash.
    ok(/Signed out/.test(view.text),
      "a crash from the signed-out screens is labelled as such", view.text.slice(0, 400));
    // Newest first: the unhandled rejection is the most recent of the three.
    ok(view.text.indexOf("Unhandled rejection") < view.text.indexOf("Uncaught error"),
      "the newest report is at the top");
    // The raw kind values are storage, not language.
    ok(!/unhandledrejection/.test(view.text) && /Missing file/.test(view.text),
      "the kind reads as words rather than as the stored value", view.text.slice(0, 120));
    // A 120-character user-agent answers "which browser" in about four.
    ok(/Safari 18 on iOS/.test(view.text) && /Firefox 141 on Windows/.test(view.text),
      "the user agent is reduced to the browser and platform", view.text.slice(0, 200));
    ok(/app\.js:4127/.test(view.text),
      "a report that knows where it came from says so", view.text.slice(0, 200));
    ok(view.overflow <= 1,
      "an unbreakable 100-character message does not push the page sideways",
      `document is ${view.overflow}px wider than the viewport`);

    // The kind filter is the reason the column exists: a missing file is a bad
    // deploy, an uncaught error is a bug, and they are not the same errand.
    await h.page.evaluate(() => {
      const sel = document.getElementById("crashFilterKind");
      sel.value = "resource";
      sel.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await settle(h.page, 500);
    const filtered = await h.page.evaluate(() => ({
      rows: document.querySelectorAll("#crashBody tr").length,
      text: document.getElementById("crashBody").innerText
    }));
    ok(filtered.rows === 1 && /Missing file/.test(filtered.text),
      "filtering by kind narrows the table to that kind", JSON.stringify(filtered.rows));

    await h.close();
  }

  // ---- A name in Arabic reads as a name in Arabic ------------------------
  // escapeHtml already strips bidi OVERRIDE characters, which is the spoofing
  // vector and a different job from this one. Stripping overrides does not set
  // direction: a name in Arabic or Hebrew still resolves its neutral
  // characters -- a separator, a bracket, a trailing dot, any Latin run inside
  // it -- against whatever direction the containing element has, and in an LTR
  // page that lands the punctuation on the wrong end of the name. Five render
  // sites were missing dir="auto" while eight others had it, which is the kind
  // of gap that only shows up on someone else's alphabet.
  {
    const people = D.roster(5);
    const me = people[0]; me.role = "admin"; me.full_name = "Aseel Thalnoon";
    people[1].full_name = "أسيل ذوالنون";        // pure Arabic
    people[2].full_name = "محمد (Admin)";        // Arabic wrapped around Latin
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: {
      profiles: people,
      entries: D.entriesFor(me.id, 8),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await goTab(h.page, "admin");
    await settle(h.page, 1200);

    const r = await h.page.evaluate(() => {
      const arabic = /[\u0600-\u06FF]/;
      const carriers = [...document.querySelectorAll('[dir="auto"]')]
        .filter(e => arabic.test(e.textContent));
      const stray = [...document.querySelectorAll("option, td, .team-name, .admin-user-name")]
        .filter(e => arabic.test(e.textContent) && e.closest('[dir="auto"]') === null
                     && e.getAttribute("dir") !== "auto");
      return {
        carriers: carriers.length,
        resolvedRtl: carriers.filter(e => getComputedStyle(e).direction === "rtl").length,
        strayCount: stray.length,
        strayFirst: stray.length ? (stray[0].className || stray[0].tagName) : null
      };
    });

    ok(r.carriers > 0, "the admin screens render the Arabic names at all", JSON.stringify(r));
    ok(r.carriers === r.resolvedRtl,
      "every element carrying an Arabic name resolves right-to-left",
      `${r.resolvedRtl} of ${r.carriers}`);
    ok(r.strayCount === 0,
      "no element renders an Arabic name without directional isolation",
      `${r.strayCount} stray, first: ${r.strayFirst}`);
    await h.close();
  }

  // ---- the printed timesheet ------------------------------------------------
  // The one artefact this app makes for somebody else, and the surface no test
  // had ever looked at. Three separate things were wrong at once and each was
  // invisible from the screen:
  //
  //   - The print stylesheet hid `header.ledger-head, main, footer.ledger-foot`,
  //     a list written before the Atrium redesign existed. The rail, the sticky
  //     clock and the bottom nav are SIBLINGS of main, so a printed timesheet
  //     led with a full page of the 236px near-black rail and put the report on
  //     page two. It is an allowlist now — everything hidden, #printArea shown —
  //     which is the shape that cannot go stale when a sibling is added.
  //   - #printArea lived inside #appShell, so hiding the shell took the report
  //     with it. display:none on an ancestor is not something a descendant's own
  //     display can answer. It is a body-level sibling now.
  //   - `tbody td` carries white-space:nowrap for the screen's Log, which
  //     scrolls sideways. Paper does not. A 500-character note — the database's
  //     own check-constraint ceiling, and in this fixture — took the table to
  //     3365px against 741px of printable A4 and carried four columns off the
  //     right edge.
  //
  // Driven from the DARK theme on purpose: the print block's color-scheme:light
  // lost to html[data-theme="dark"] on specificity, and a media query adds none.
  {
    const people = D.roster(3), me = people[0];
    const h = await boot({ meId: me.id, seed: {
      profiles: people,
      entries: D.entriesFor(me.id, 30, { extremes: true }),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await goTab(h.page, "log");
    await settle(h.page, 800);
    await h.page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    // beforeprint is what builds the report for Ctrl+P, so it is the real path.
    await h.page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await settle(h.page, 600);
    // A4 portrait at 96dpi less the stylesheet's own 14mm @page margin.
    await h.page.setViewportSize({ width: 794, height: 1123 });
    await h.page.emulateMedia({ media: "print" });
    await settle(h.page, 400);

    const r = await h.page.evaluate(() => {
      const pa = document.getElementById("printArea");
      const onPaper = [...document.querySelectorAll("body *")]
        .filter(e => e !== pa && !pa.contains(e) && e.getClientRects().length)
        .map(e => e.tagName.toLowerCase() + (e.id ? "#" + e.id : ""));
      return {
        rows: pa.querySelectorAll("tbody tr").length,
        signatures: pa.querySelectorAll(".p-sign div").length,
        top: Math.round(pa.getBoundingClientRect().top),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        strays: [...new Set(onPaper)]
      };
    });

    ok(r.rows > 0, "beforeprint builds the report", `rows: ${r.rows}`);
    ok(r.signatures === 2, "the report keeps its signature lines", `found ${r.signatures}`);
    ok(r.strays.length === 0,
      "nothing but the report is on the paper",
      `also printing: ${r.strays.join(", ")}`);
    ok(r.top === 0, "the report starts on page one", `starts at y=${r.top}`);
    ok(r.overflowX === 0,
      "the report fits the printable width with a maximum-length note",
      `${r.overflowX}px past the page`);
    ok(r.colorScheme === "light",
      "print forces color-scheme:light even from a dark theme", r.colorScheme);
    ok(r.bodyBg === "rgb(255, 255, 255)", "paper is white whatever the screen is", r.bodyBg);
    await h.close();
  }

  // ---- the first-run card's offers -------------------------------------------
  // The only screen a brand-new account sees, and its controls kept pointing
  // at the wrong thing.
  //
  // The big control was a dashed ring around a plus: first an aria-hidden
  // decoration with no handler, then a button that opened the hand-entry form
  // -- under a sentence telling the reader to clock in. Since 2026-11-17 it is
  // the clock itself (Clock In, then Clock Out while the first day is open),
  // and hand entry is a link beside "Set your working week first". That link
  // clicked the Settings tab and stopped at one point, which lands on Profile,
  // because Profile is deliberately the console's first section: the label
  // named the working week and delivered a name and a photo.
  {
    const people = D.roster(2), me = people[0];
    const h = await boot({ meId: me.id, seed: {
      profiles: [me],
      entries: [],                                   // first run: nothing logged
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    await goTab(h.page, "overview");
    await settle(h.page, 600);

    const card = await h.page.evaluate(() => {
      const panel = document.querySelector(".overview-panel");
      const clock = document.getElementById("firstRunClockBtn");
      if(!clock) return { firstRun: !!(panel && panel.classList.contains("is-first-run")), missing: true };
      const r = clock.getBoundingClientRect();
      const qc = document.getElementById("qcClockBtn");
      return {
        firstRun: !!(panel && panel.classList.contains("is-first-run")),
        missing: false,
        tag: clock.tagName,
        name: (clock.getAttribute("aria-label") || "").trim(),
        action: clock.getAttribute("data-clock-action"),
        w: Math.round(r.width), h: Math.round(r.height),
        hit: (() => { const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                      return !!(e && (e === clock || clock.contains(e))); })(),
        panelButtonShown: !!(qc && qc.getClientRects().length)
      };
    });
    ok(card.firstRun, "an account with no entries gets the first-run overview");
    ok(!card.missing, "the first-run card's big control is the clock");
    ok(card.tag === "BUTTON" && card.action === "in" && card.name === "Clock in",
      "it clocks in, and says so", JSON.stringify(card));
    ok(card.w >= 44 && card.h >= 44, "it clears the touch floor", `${card.w}x${card.h}`);
    ok(card.hit, "nothing is sitting on top of it");
    ok(!card.panelButtonShown, "the clock panel's own button steps aside while the card shows it");

    const modal = await h.page.evaluate(async () => {
      const hand = document.getElementById("firstRunHandBtn");
      if(hand) hand.click();
      await new Promise(r => setTimeout(r, 300));
      const m = document.getElementById("entryModal");
      return { open: !!(m && m.getClientRects().length), focus: document.activeElement.id };
    });
    await settle(h.page, 400);
    ok(modal.open, "\"Add a past day by hand\" opens the entry form");
    ok(modal.focus === "fDate", "the entry form starts on the date", modal.focus || "(none)");
    if(modal.open){ await h.page.keyboard.press("Escape"); await settle(h.page, 400); }

    // The Log shows the same ring for the same reason, and for a while it was
    // the identical glyph sitting inert one tab over: press it on the Overview
    // and a day opens, press it on the Log and nothing happens. Both are
    // .first-run-add now and one delegated handler covers them.
    await goTab(h.page, "log");
    await settle(h.page, 600);
    const logRing = await h.page.evaluate(() => {
      const panel = document.getElementById("tab-log");
      const btn = panel && panel.querySelector(".first-run-add");
      if(!btn) return { missing: true };
      const r = btn.getBoundingClientRect();
      btn.click();
      const m = document.getElementById("entryModal");
      return { missing: false, tag: btn.tagName, name: (btn.getAttribute("aria-label") || "").trim(),
               w: Math.round(r.width), h: Math.round(r.height),
               opens: !!(m && m.getClientRects().length) };
    });
    ok(!logRing.missing, "the Log's empty state offers the same ring");
    ok(logRing.tag === "BUTTON", "...and it is a control there too", String(logRing.tag));
    ok(!!logRing.name, "...with a name", JSON.stringify(logRing.name || null));
    ok(logRing.w >= 44 && logRing.h >= 44, "...clearing the touch floor", `${logRing.w}x${logRing.h}`);
    ok(logRing.opens, "...and opening the same entry form");
    if(logRing.opens){ await h.page.keyboard.press("Escape"); await settle(h.page, 400); }

    // Trends and Shortfall on an account with nothing in it. Both used to be
    // the full chart apparatus wrapped around no chart — sub-tabs, a year and
    // a month select, a Print Report button that would print a timesheet with
    // no rows, a legend naming four series that were never drawn, and the same
    // absence restated in an accordion underneath. Shortfall said it four
    // times, one of them in the positive green, which tells somebody who has
    // not taken the test that they passed it.
    for(const [tab, cardId] of [["trends", "trendsFirstRun"], ["punctuality", "punctFirstRun"]]){
      await goTab(h.page, tab);
      await settle(h.page, 600);
      const r = await h.page.evaluate(id => {
        const card = document.getElementById(id);
        const vis = el => !!(el && el.getClientRects().length);
        const panel = document.querySelector(".tab-panel.active");
        return {
          cardShown: !!(card && !card.hidden && card.getClientRects().length),
          subTabs: vis(document.getElementById("trendsSubTabs")),
          monthFilter: vis(document.getElementById("monthFilterWrap")),
          punctFilter: vis(document.getElementById("punctFilterWrap")),
          legend: panel ? [...panel.querySelectorAll(".chart-legend")].some(vis) : false,
          ring: !!(card && card.querySelector(".first-run-add"))
        };
      }, cardId);
      ok(r.cardShown, `${tab} shows one first-run state instead of an empty chart`);
      ok(r.ring, `${tab}'s first-run state offers the same ring as the others`);
      ok(!r.legend, `${tab} publishes no legend when it drew no chart`);
      ok(!r.subTabs && !r.monthFilter && !r.punctFilter,
        `${tab} drops the period chrome it has nothing to filter`,
        JSON.stringify(r));
    }

    // The Log keeps its chrome: that bar carries Add Entry, which is the action
    // its own empty state points at. A blanket rule would have taken it away.
    await goTab(h.page, "log");
    await settle(h.page, 400);
    ok(await h.page.evaluate(() => !!document.getElementById("monthFilterWrap").getClientRects().length),
      "the Log keeps the filter bar that carries its own empty state's action");

    await goTab(h.page, "overview");
    await settle(h.page, 400);
    await h.page.evaluate(() => {
      const b = document.getElementById("firstRunSettingsBtn");
      if(b) b.click();
    });
    await settle(h.page, 800);
    const landed = await h.page.evaluate(() => {
      const sec = document.querySelector("#settingsConsole .console-section.active");
      const nav = document.querySelector('#settingsConsole .console-nav-item[aria-selected="true"]');
      return { tab: (document.querySelector(".tab-panel.active") || {}).id,
               section: sec && sec.getAttribute("data-section"),
               nav: nav && nav.id };
    });
    ok(landed.tab === "tab-settings", "the working-week link opens Settings", landed.tab);
    ok(landed.section === "hours",
      "...and lands on Working Hours, which is what its label promises",
      `landed on: ${landed.section}`);
    ok(landed.nav === "cnav-hours", "the console nav agrees with the open section", landed.nav);
    await h.close();
  }

  // ---- the failed-load ring stays a picture ----------------------------------
  // "No attendance logged yet" and "couldn't read your record" share a block
  // and a dashed ring, and only the first one draws a plus. Wrapping the shared
  // shape without looking would offer "add a day" as the answer to a failed
  // load, which is the same confusion renderLoadFailure() exists to prevent.
  {
    const people = D.roster(2), me = people[0];
    const h = await boot({ meId: me.id, waitForApp: false, seed: {
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }, beforeLoad: async ({ backend }) => {
      backend.fail("/rest/v1/entries", { status: 500, message: "boom" });
    }});
    await h.page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
    await goTab(h.page, "log");
    await settle(h.page, 900);
    const r = await h.page.evaluate(() => {
      const panel = document.getElementById("tab-log");
      const svg = panel && panel.querySelector(".first-run-empty svg");
      const title = panel && panel.querySelector(".first-run-title");
      return { title: title ? title.textContent.trim() : null,
               isButton: svg ? !!svg.closest("button, a[href], [role=\"button\"]") : null,
               glyph: svg && svg.querySelector("path") ? svg.querySelector("path").getAttribute("d") : null };
    });
    ok(/couldn't load/i.test(r.title || ""), "a failed load says so rather than claiming an empty month", String(r.title));
    ok(r.isButton === false, "the failed-load ring is not a control", `isButton: ${r.isButton}`);
    ok(r.glyph === "M24 15v11M24 31.5h.01", "...and still draws an exclamation, not a plus", String(r.glyph));
    await h.close();
  }

  // ---- and it all comes back the moment there is data ------------------------
  // A first-run state that does not stand down is worse than none: it would
  // hide the charts from the person who has just earned them.
  {
    const people = D.roster(2), me = people[0];
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: D.entriesFor(me.id, 30),
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    for(const [tab, cardId] of [["trends", "trendsFirstRun"], ["punctuality", "punctFirstRun"]]){
      await goTab(h.page, tab);
      await settle(h.page, 800);
      const r = await h.page.evaluate(id => {
        const card = document.getElementById(id);
        const vis = el => !!(el && el.getClientRects().length);
        const panel = document.querySelector(".tab-panel.active");
        return { cardShown: !!(card && !card.hidden),
                 chrome: vis(document.getElementById(id === "trendsFirstRun" ? "trendsSubTabs" : "punctFilterWrap")),
                 legend: panel ? [...panel.querySelectorAll(".chart-legend")].some(vis) : false };
      }, cardId);
      ok(!r.cardShown, `${tab} stands the first-run state down once days are logged`);
      ok(r.chrome, `${tab} gets its period chrome back`);
      ok(r.legend, `${tab} keys the chart it actually drew`);
    }
    await h.close();
  }

  // ---- the two states the touch-floor sweep cannot reach ---------------------
  // tests/mobile/touch-floor.js measures every button at 44px and passes, but
  // its fixture hides #authScreen and seeds entries — so the auth screen's
  // links and the first-run card's link are controls it has never once seen.
  // Both shipped at 20px, under WCAG 2.2 SC 2.5.8's 24px AA floor and under
  // this project's own One Module rule. Measured here, where those states
  // actually exist.
  {
    const me = D.roster(1)[0];
    const FLOOR = 44;   // One Module: the touch size is the base below 1100px

    const h = await boot({ meId: me.id, viewport: PHONE, signedOut: true,
      waitForApp: false, seed: { profiles: [me] } });
    await settle(h.page, 1200);
    const auth = await h.page.evaluate(() => [...document.querySelectorAll(".link-btn")]
      .filter(b => b.getClientRects().length)
      .map(b => ({ id: b.id || b.textContent.trim().slice(0, 24),
                   h: Math.round(b.getBoundingClientRect().height) })));
    ok(auth.length > 0, "the sign-in screen has links to measure", JSON.stringify(auth));
    auth.forEach(l => ok(l.h >= FLOOR,
      `sign-in link "${l.id}" clears the ${FLOOR}px touch floor`, `it is ${l.h}px`));
    await h.close();

    const h2 = await boot({ meId: me.id, viewport: PHONE, seed: {
      profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }]
    }});
    await goTab(h2.page, "overview");
    await settle(h2.page, 600);
    const fr = await h2.page.evaluate(() => {
      const b = document.getElementById("firstRunSettingsBtn");
      return b && b.getClientRects().length ? Math.round(b.getBoundingClientRect().height) : null;
    });
    ok(fr !== null, "the first-run card's working-week link is on screen to measure");
    ok(fr >= FLOOR, `the first-run working-week link clears the ${FLOOR}px touch floor`, `it is ${fr}px`);

    // The one target SC 2.5.8 exempts: inline in a sentence. It must NOT be
    // grown into an inline-flex block, which would break the line it sits in.
    const inline = await h2.page.evaluate(() => {
      const b = document.getElementById("registrationDefaultsHintBtn");
      if(!b) return null;
      const s = getComputedStyle(b);
      return { display: s.display, minHeight: s.minHeight };
    });
    ok(inline && inline.display !== "inline-flex",
      "the link inside the registration warning's prose is not a flex box",
      JSON.stringify(inline));
    ok(inline && (inline.minHeight === "0px" || inline.minHeight === "auto"),
      "...and is not grown to the touch floor mid-sentence, which SC 2.5.8 exempts",
      JSON.stringify(inline));
    await h2.close();
  }

  // ---- a send says what it will reach, and what it did ----------------------
  // "Specific people" always named its real count; "Everyone" never did, so a
  // send that reached nobody was word-for-word a send that reached the whole
  // team — at the moment of deciding, and again at the moment of being told.
  // Push cannot be unsent. The composer had the figure on screen three lines
  // above the button the whole time.
  {
    const people = D.roster(6), me = people[0];
    const subsFor = n => people.slice(0, n).map((p, i) => ({
      endpoint: "https://push.example/" + i, user_id: p.id,
      user_agent: "UA" + i, created_at: "2026-09-01T09:00:00Z" }));

    const send = async (opts) => {
      const seed = { profiles: people, entries: D.entriesFor(me.id, 8),
        user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })) };
      if(opts.subs) seed.push_subscriptions = opts.subs;
      const h = await boot({ meId: me.id, seed,
        beforeLoad: opts.breakRpc
          ? async ({ backend }) => backend.fail("rpc/admin_push_reach", { status: 404, message: "not deployed" })
          : undefined });
      await goTab(h.page, "admin");
      await settle(h.page, 600);
      await h.page.evaluate(() => document.getElementById("cnav-admin-notifications").click());
      await settle(h.page, 700);
      await h.page.evaluate(() => { window.__t = [];
        new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
          if(n.nodeType === 1 && n.textContent) window.__t.push(n.textContent.trim().replace(/\s+/g, " ")); })))
          .observe(document.body, { childList: true, subtree: true }); });
      await h.page.fill("#notifyTitle", "Early close");
      await h.page.fill("#notifyBody", "Doors shut at 2pm.");
      if(opts.target === "users"){
        await h.page.evaluate(() => [...document.querySelectorAll("[data-notify-target]")]
          .find(b => b.dataset.notifyTarget === "users").click());
        await settle(h.page, 300);
        await h.page.evaluate(() => [...document.querySelectorAll("#notifyPeoplePicker input[type=checkbox]")]
          .slice(0, 2).forEach(b => b.click()));
      }
      await h.page.evaluate(() => [...document.querySelectorAll("#csec-admin-notifications button")]
        .find(x => x.textContent.trim() === "Send Notification").click());
      await settle(h.page, 900);
      const confirm = await h.page.evaluate(() => {
        const d = document.querySelector(".modal-overlay:not([hidden])");
        return d ? d.innerText.replace(/\s+/g, " ").trim() : "";
      });
      await h.page.evaluate(() => { const b = [...document.querySelectorAll(".modal-overlay button")]
        .find(x => /^send$/i.test(x.textContent.trim())); if(b) b.click(); });
      await settle(h.page, 1800);
      const result = await h.page.evaluate(() =>
        (window.__t || []).filter(t => /sent|scheduled|reached|nobody/i.test(t)).slice(-1)[0] || "");
      await h.close();
      return { confirm, result };
    };

    const three = await send({ subs: subsFor(3), target: "all" });
    ok(/\b3 people\b/.test(three.confirm), "sending to everyone names how many it will reach", three.confirm);
    ok(/\b3 people\b/.test(three.result), "...and the result says how many it reached", three.result);

    const none = await send({ target: "all" });
    ok(/reach no one|nobody/i.test(none.confirm),
      "sending to nobody says so before it happens", none.confirm);
    ok(/reached nobody/i.test(none.result) && !/^Notification sent\.$/.test(none.result),
      "...and is not reported as an ordinary success", none.result);
    ok(none.result !== three.result,
      "a send that reached nobody does not read the same as one that reached everyone",
      `${none.result} / ${three.result}`);

    // Unknown is not zero. admin_push_reach is best-effort on purpose, and a
    // composer that cannot reach it must claim nothing rather than report 0.
    const unknown = await send({ subs: subsFor(3), target: "all", breakRpc: true });
    ok(!/nobody|reach no one|\b0 people\b/i.test(unknown.confirm),
      "with the reach RPC unavailable the confirm claims no number", unknown.confirm);
    ok(!/reached nobody/i.test(unknown.result),
      "...and does not report a delivery to nobody it cannot know about", unknown.result);

    const picked = await send({ subs: subsFor(3), target: "users" });
    ok(/2 selected people/.test(picked.confirm),
      "the specific-people branch still names its own count", picked.confirm);

    // ...and says when those people cannot actually receive it. Only the first
    // two of the roster are subscribed here, so picking further down the list
    // picks somebody unreachable.
    const openPicker = async (h) => {
      await goTab(h.page, "admin");
      await settle(h.page, 600);
      await h.page.evaluate(() => document.getElementById("cnav-admin-notifications").click());
      await settle(h.page, 800);
      await h.page.evaluate(() => [...document.querySelectorAll("[data-notify-target]")]
        .find(b => b.dataset.notifyTarget === "users").click());
      await settle(h.page, 400);
    };
    const pick = async (opts) => {
      const seed = { profiles: people, entries: D.entriesFor(me.id, 8),
        user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })),
        push_subscriptions: subsFor(2) };
      if(opts.omitReachIds) seed.omitReachIds = true;
      const h = await boot({ meId: me.id, seed });
      await openPicker(h);
      const marked = await h.page.evaluate(() =>
        document.querySelectorAll("#notifyPeopleList .notify-off").length);
      const overflow = await h.page.evaluate(() => {
        const l = document.getElementById("notifyPeopleList");
        return l.scrollWidth - l.clientWidth;
      });
      await h.page.fill("#notifyTitle", "Early close");
      await h.page.fill("#notifyBody", "Doors shut at 2pm.");
      await h.page.evaluate(idx => { const b = [...document.querySelectorAll("#notifyPeopleList input[type=checkbox]")];
        idx.forEach(i => b[i] && b[i].click()); }, opts.idx);
      await settle(h.page, 400);
      const count = await h.page.evaluate(() =>
        document.getElementById("notifyPickedCount").textContent.trim());
      await h.page.evaluate(() => [...document.querySelectorAll("#csec-admin-notifications button")]
        .find(x => x.textContent.trim() === "Send Notification").click());
      await settle(h.page, 800);
      const confirm = await h.page.evaluate(() => {
        const d = document.querySelector(".modal-overlay:not([hidden])");
        return d ? d.innerText.replace(/\s+/g, " ").trim() : "";
      });
      await h.close();
      return { marked, overflow, count, confirm };
    };

    const mixed = await pick({ idx: [0, 3] });
    ok(mixed.marked > 0, "the picker marks who cannot be reached", `${mixed.marked} marked`);
    ok(/1 reachable/.test(mixed.count),
      "the picked count says how many of them can receive it", mixed.count);
    ok(/Only 1 of them/.test(mixed.confirm),
      "and the confirm says the rest will not see it", mixed.confirm);

    const noneReachable = await pick({ idx: [3, 4] });
    ok(/none reachable/i.test(noneReachable.count),
      "picking only unreachable people says so", noneReachable.count);
    ok(/reach no one/i.test(noneReachable.confirm),
      "...before the send, not after", noneReachable.confirm);

    const allReachable = await pick({ idx: [0, 1] });
    ok(!/reachable/.test(allReachable.count),
      "no second clause when every picked person can receive it", allReachable.count);

    // A project that has not run 20260917140000_push_reach_per_person.sql gets
    // the old function, which returns no ids. Unknown is not zero: nobody is
    // marked and nothing extra is claimed.
    const older = await pick({ idx: [3, 4], omitReachIds: true });
    ok(older.marked === 0,
      "with the pre-migration function nobody is marked unreachable", `${older.marked} marked`);
    ok(!/reachable|reach no one/i.test(older.count + " " + older.confirm),
      "...and neither the count nor the confirm invents one",
      `${older.count} / ${older.confirm}`);

    // A name with nowhere to wrap took this list 1248px past its own edge.
    ok(mixed.overflow === 0,
      "an unbroken name does not push the picker off its own edge",
      `${mixed.overflow}px over`);
  }

  // ---- the primary button is the loudest thing in its region, in both modes --
  // Asserted as DIRECTION, not ratio, because ratio cannot see it. The fill was
  // --gradient-ink, dark in both modes, which left the primary button 1.20:1
  // against its card and DARKER than it — the one surface running the wrong way
  // down the ladder this system sets ("a card is lighter than the canvas either
  // way"). A hairline was tried first and measured 1.40:1, and the contrast
  // figure moved by 0.00 between the broken and the fixed version, because
  // "lighter than" and "darker than" are the same number to a contrast ratio.
  // So this measures which side of the card the fill sits on.
  {
    const me = D.roster(1)[0];
    const h = await boot({ meId: me.id, seed: {
      profiles: [me], entries: D.entriesFor(me.id, 5),
      user_settings: [{ user_id: me.id, settings: D.SETTINGS }] } });

    const rows = await h.page.evaluate(() => {
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
        return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
      const num = s => (s.match(/[\d.]+/g) || []).map(Number);
      const hex = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
      const out = [];
      for(const pal of ["atrium","slate","terracotta","studio","moss","plum","ledger"]){
        for(const mode of ["light","dark"]){
          document.documentElement.setAttribute("data-palette", pal);
          document.documentElement.setAttribute("data-theme", mode);
          const b = document.createElement("button");
          b.className = "btn"; b.textContent = "X";
          document.body.appendChild(b);
          const cs = getComputedStyle(b);
          const fill = cs.backgroundImage !== "none"
            ? (cs.backgroundImage.match(/rgba?\([^)]*\)/g) || [])[0]
            : cs.backgroundColor;
          const label = cs.color;
          b.remove();
          const card = hex(getComputedStyle(document.documentElement).getPropertyValue("--card").trim());
          out.push({ pal, mode,
            fillL: lum(num(fill)), cardL: lum(card),
            labelOnFill: (() => { const a = lum(num(label)), c = lum(num(fill));
              return (Math.max(a,c)+0.05)/(Math.min(a,c)+0.05); })() });
        }
      }
      return out;
    });

    rows.forEach(r => {
      const raised = r.fillL > r.cardL;
      ok(r.mode === "dark" ? raised : !raised,
        `${r.pal}/${r.mode}: the primary button sits ${r.mode === "dark" ? "above" : "below"} its card`,
        `fill ${r.fillL.toFixed(4)} vs card ${r.cardL.toFixed(4)}`);
      ok(r.labelOnFill >= 4.5,
        `${r.pal}/${r.mode}: its label clears 4.5:1 on that fill`, `${r.labelOnFill.toFixed(2)}:1`);
    });

    // The accent is not spent on it. Clock In stays the one gold button.
    const gold = await h.page.evaluate(() => {
      document.documentElement.setAttribute("data-palette", "atrium");
      document.documentElement.setAttribute("data-theme", "dark");
      const w = document.createElement("div"); w.className = "quick-clock";
      const b = document.createElement("button"); b.className = "btn qc-btn";
      w.appendChild(b); document.body.appendChild(w);
      const qc = getComputedStyle(b).backgroundImage;
      const p = document.createElement("button"); p.className = "btn";
      document.body.appendChild(p);
      const pr = getComputedStyle(p).backgroundImage + getComputedStyle(p).backgroundColor;
      w.remove(); p.remove();
      return { qcUsesGradient: /gradient/.test(qc), differs: qc !== pr };
    });
    ok(gold.qcUsesGradient && gold.differs,
      "Clock In keeps the accent the primary button does not take", JSON.stringify(gold));
    await h.close();
  }

  console.log(`  hostile  pass ${pass}   fail ${fail}`);
  if(fail){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
