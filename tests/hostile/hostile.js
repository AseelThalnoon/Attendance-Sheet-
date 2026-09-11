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

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

async function run(){
  // ---- initialsOf: astral emoji must not produce a lone surrogate --------
  {
    const APP_SRC = process.env.ATTENDANCE_APP_SRC || path.join(__dirname, "..", "..", "app.js");
    const src = fs.readFileSync(APP_SRC, "utf8").split("\n");
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
    const APP_SRC = process.env.ATTENDANCE_APP_SRC || path.join(__dirname, "..", "..", "app.js");
    const lines = fs.readFileSync(APP_SRC, "utf8").split("\n");
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
      grab("function explainedError", "// ---------- Bulk-operation guard"), fe);
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
      const hours = cards.find(c => c.querySelector(".stat-label").textContent.includes("Avg Hours / Day"));
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
      `Avg Hours / Day: ${t.hoursWorked}`);
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

    const snap = await h.page.evaluate(() => ({
      failBanner: document.getElementById("loadFailBanner").classList.contains("show"),
      badge: document.getElementById("railNotifBadge").textContent,
      badgeHidden: document.getElementById("railNotifBadge").hidden,
      retryExists: !!document.getElementById("loadFailRetryBtn")
    }));
    ok(snap.failBanner, "a failed load shows the persistent failure banner");
    // The banner lives in the notification panel now, so it is no longer
    // painted on the page. The failure still has to reach someone who opens
    // nothing, and the badge is what does that -- if this ever reads 0, a
    // failed load has gone completely silent, which is the whole defect this
    // block exists to prevent.
    ok(!snap.badgeHidden && snap.badge !== "0",
      "a failed load is announced on the bell without opening anything", "badge=" + snap.badge);
    ok(snap.retryExists, "the failure banner still carries its Try Again button");

    const reachable = await h.page.evaluate(() => {
      document.getElementById("railNotifBtn").click();
      return new Promise(r => setTimeout(() => r(
        !!document.getElementById("loadFailRetryBtn").getClientRects().length), 350));
    });
    ok(reachable, "and Try Again is visible once the panel is open");
    await h.page.keyboard.press("Escape");
    await settle(h.page, 300);

    // The toast clearing must not clear the banner too — that was the bug:
    // a 7-second toast was the only signal the load had failed.
    await h.page.waitForTimeout(7600);
    const after = await h.page.evaluate(() => ({
      toasts: document.querySelectorAll(".toast").length,
      failBanner: document.getElementById("loadFailBanner").classList.contains("show")
    }));
    ok(after.toasts === 0 && after.failBanner, "the failure banner outlives the toast that reported it");

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
    const APP_SRC = process.env.ATTENDANCE_APP_SRC || path.join(__dirname, "..", "..", "app.js");
    const lines = fs.readFileSync(APP_SRC, "utf8").split("\n");
    const grab = (a, b) => {
      const s = lines.findIndex(l => l.trim().startsWith(a));
      const e = s + lines.slice(s).findIndex(l => l.trim().startsWith(b));
      return lines.slice(s, e).join("\n");
    };
    const code = grab("function isIOS()", "function enableInstructionsFor") + "\n" +
                 grab("function enableInstructionsFor", "async function refreshPushDevices");
    const say = (ua, standalone) => {
      const sb = { navigator: { userAgent: ua },
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
    for(let b = 1; b <= 6; b++){
      const d = new Date(today); d.setDate(d.getDate() - b);
      row(D.UUID(5), dstr(d), "08:00:00", "16:00:00", "regular");
    }
    for(let b = 1; b <= 2; b++){
      const d = new Date(today); d.setDate(d.getDate() - b);
      row(D.UUID(7), dstr(d), "08:00:00", "16:00:00", "regular");
    }

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
    ok(html.includes(".auth-screen{") && /\.auth-screen\{[^}]*safe-area-inset-top/.test(html),
      "the sign-in screen (the first thing an installed PWA shows) reserves the top safe area too");
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
      badge: document.getElementById("railNotifBadge").textContent,
      titles: Array.from(document.querySelectorAll(".notif-item-title")).map(x => x.textContent),
      unread: document.querySelectorAll(".notif-item:not(.is-read)").length,
      stackInPanel: !!document.querySelector("#notifOverlay #noticeStack"),
      stackOnPage: !!document.getElementById("noticeStack").getClientRects().length,
      viewingBannerOutside: !document.querySelector("#notifOverlay #viewingOtherBanner")
    }));
    ok(before.stackInPanel && !before.stackOnPage,
      "the notices live in the bell's panel, not stacked on top of every screen");
    ok(before.viewingBannerOutside,
      "the viewing-someone-else banner is NOT in the panel: it is a mode indicator, and below 760px it is the only thing saying edits land on another person's record");
    ok(!before.titles.includes("Not for you"),
      "a message targeted at another user is not readable", JSON.stringify(before.titles));
    ok(!before.titles.includes("Still a draft"),
      "an unsent message is not readable", JSON.stringify(before.titles));
    ok(before.badge === "2",
      "the badge counts live notices plus unread messages", "badge=" + before.badge);
    ok(before.unread === 1, "a message already marked read renders as read", "unread=" + before.unread);

    await h.page.evaluate(() => document.getElementById("railNotifBtn").click());
    await settle(h.page, 700);
    const opened = await h.page.evaluate(() => ({
      bgHidden: document.getElementById("appShell").getAttribute("aria-hidden"),
      focus: document.activeElement && document.activeElement.id,
      unread: document.querySelectorAll(".notif-item:not(.is-read)").length,
      badge: document.getElementById("railNotifBadge").textContent
    }));
    ok(opened.bgHidden === "true", "opening the panel hides the page behind it from assistive tech");
    ok(opened.focus === "notifCloseBtn", "focus moves into the panel", "focus=" + opened.focus);
    ok(opened.unread === 0 && opened.badge === "1",
      "opening marks messages read and the badge drops to the live notice",
      "unread=" + opened.unread + " badge=" + opened.badge);

    // Resolve the live notice from inside the panel; the badge must follow.
    await h.page.evaluate(() => document.getElementById("reminderActions").querySelector("button").click());
    await settle(h.page, 1500);
    const after = await h.page.evaluate(() => ({
      badge: document.getElementById("railNotifBadge").textContent,
      hidden: document.getElementById("railNotifBadge").hidden,
      shown: Array.from(document.querySelectorAll("#noticeStack .reminder"))
        .filter(n => n.classList.contains("show")).length
    }));
    ok(after.shown === 0 && after.hidden && after.badge === "0",
      "the badge clears when the last notice resolves (the MutationObserver is actually observing)",
      "shown=" + after.shown + " badge=" + after.badge + " hidden=" + after.hidden);

    await h.close();
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

  console.log(`  hostile  pass ${pass}   fail ${fail}`);
  if(fail){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
}

run().catch(err => { console.error(err); process.exitCode = 1; });
