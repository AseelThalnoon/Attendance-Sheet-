// Tests for the rebuilt Admin console.
//
// The console is the only place in the product where one person's action lands
// on everyone else's data — roles, deletions, company-wide days, the schedule
// every new account inherits. So these drive the real page in a real browser
// against a stubbed backend, rather than asserting that a function was called.
//
// The stub takes ?role= from the page URL so the same build can be booted as an
// employee and as an admin, which is what makes the "employees see none of it"
// assertions meaningful.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8952;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png",
  ".css":"text/css", ".woff2":"font/woff2"};

const STUB = `
const ROLE = new URLSearchParams(location.search).get("role") || "admin";
const DEFAULTS = new URLSearchParams(location.search).get("defaults");
const UID = "u-self";
const PROFILE = {id:UID, email:"boss@example.com", full_name:"Ada Boss", role:ROLE};
const PROFILES = [
  PROFILE,
  {id:"u-2", email:"kim@example.com",  full_name:"Kim Rivera", role:"user"},
  {id:"u-3", email:"sam@example.com",  full_name:"Sam Osei",   role:"user"},
];
// Only two of the three have a schedule of their own — Sam is the unconfigured
// case the People filter and the health panel both have to notice.
// Kim works Mon–Fri on a 7h day; the signed-in admin works Sun–Thu on 8h. The
// Team roster has to measure each of them against their own week, which is the
// thing the old roster got wrong for everybody.
const SETTINGS_ROWS = [
  {user_id:UID,   settings:{workDays:[0,1,2,3,4], targetMin:480, standardIn:"08:00", standardOut:"16:00"}},
  {user_id:"u-2", settings:{workDays:[1,2,3,4,5], targetMin:420, standardIn:"09:00", standardOut:"17:00"}},
];
// One Friday and one Sunday in the current month: a working day for exactly one
// of those two schedules each, so a card computed with the wrong settings shows
// a different target.
const MONTH = (() => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); })();
function nthDow(dow){
  const d = new Date(); d.setDate(1);
  while(d.getDay() !== dow) d.setDate(d.getDate()+1);
  return MONTH + "-" + String(d.getDate()).padStart(2,"0");
}
const FRIDAY = nthDow(5), SUNDAY = nthDow(0);
const TEAM_ENTRIES = [
  {user_id:"u-2", date:FRIDAY, clock_in:"09:00", clock_out:"17:00", type:"regular"},
  {user_id:"u-2", date:SUNDAY, clock_in:"09:00", clock_out:"13:00", type:"regular"},
];
const APP_SETTINGS = {
  allow_registration:true, announcement_active:false, announcement:"",
  default_settings: DEFAULTS === "none" ? {} : {workDays:[1,2,3,4,5], targetMin:450, graceMin:5,
    standardIn:"09:00", standardOut:"17:00", remindAfterHours:9, annualLeaveDays:25}
};
const AUDIT = [
  {created_at:new Date().toISOString(), actor_email:"boss@example.com", action:"role_change",
   target_email:"kim@example.com", entry_date:null, old_values:{role:"user"}, new_values:{role:"admin"}},
  {created_at:new Date().toISOString(), actor_email:"kim@example.com", action:"insert",
   target_email:"kim@example.com", entry_date:"2026-08-10", new_values:{type:"regular", clock_in:"08:00", clock_out:"16:00"}},
  {created_at:new Date().toISOString(), actor_email:"boss@example.com", action:"delete",
   target_email:"sam@example.com", entry_date:"2026-08-11", old_values:{type:"regular"}},
];
// Answered in call order to the three counted health queries: open shifts,
// blank working days, implausible dates. Cycles rather than draining, so a
// second render of the console reports the same picture as the first.
const HEAD_COUNTS = [3, 0, 0];
let headIdx = 0;
const RPC = {
  admin_db_stats: {db_size_bytes: 12582912, counts:{profiles:3, admins:1, entries:345},
    active_connections:4, max_connections:60, postgres_version:"17.6", generated_at:new Date().toISOString(),
    tables:[{name:"entries", rows:345, total_bytes:229376},{name:"profiles", rows:3, total_bytes:32768}]},
  admin_list_users: PROFILES.map((p,i) => Object.assign({}, p, {
    entry_count: 100 + i, last_sign_in_at: new Date().toISOString(), deactivated: i === 2
  })),
  admin_audit_log: AUDIT,
};

function builder(table, rpcName){
  let kind = "list", head = false;
  const settle = () => {
    if(rpcName) return {data: RPC[rpcName] !== undefined ? RPC[rpcName] : [], error:null};
    if(table === "entries"){
      if(head) return {data:null, count: HEAD_COUNTS[headIdx++ % HEAD_COUNTS.length], error:null};
      return {data: TEAM_ENTRIES, error:null};
    }
    if(table === "profiles") return kind === "single" ? {data:PROFILE, error:null} : {data:PROFILES, error:null};
    if(table === "user_settings") return kind === "single"
      ? {data:{settings:{}}, error:null} : {data:SETTINGS_ROWS, error:null};
    if(table === "app_settings") return {data:APP_SETTINGS, error:null};
    return {data:[], error:null};
  };
  const proxy = new Proxy(function(){}, {get(_, p){
    if(p === "then")    return (r,j) => Promise.resolve(settle()).then(r,j);
    if(p === "catch")   return f => Promise.resolve(settle()).catch(f);
    if(p === "finally") return f => Promise.resolve(settle()).finally(f);
    if(p === "single" || p === "maybeSingle") return () => { kind = "single"; return proxy; };
    if(p === "select")  return (_c, opts) => { if(opts && opts.head) head = true; return proxy; };
    return () => proxy;
  }});
  return proxy;
}
export function createClient(){
  return {
    from: t => builder(t, null),
    rpc: name => builder(null, name),
    auth: {
      onAuthStateChange: cb => { setTimeout(() => cb("SIGNED_IN", {user:{id:UID, email:PROFILE.email}}), 0);
        return {data:{subscription:{unsubscribe(){}}}}; },
      signInWithPassword: async () => ({data:{}, error:null}),
      signUp: async () => ({data:{}, error:null}),
      signOut: async () => ({error:null}),
      resetPasswordForEmail: async () => ({data:{}, error:null}),
      getSession: async () => ({data:{session:null}, error:null})
    }
  };
}`;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond) pass++; else { fail++; failures.push(`${name}${detail ? "\n      " + detail : ""}`); }
}

async function boot(browser, server, query){
  const ctx = await browser.newContext({viewport:{width:1280, height:900}});
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e).split("\n")[0]));
  await page.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status:200, contentType:"text/javascript", body:STUB}));
  await page.goto(`http://localhost:${PORT}/index.html${query}`, {waitUntil:"load"});
  await page.waitForTimeout(900);
  return {ctx, page, errors};
}

(async () => {
  const server = http.createServer((req, res) => {
    let u = req.url.split("?")[0];
    if(u === "/") u = "/index.html";
    const f = path.join(ROOT, u);
    if(!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"content-type": MIME[path.extname(f)] || "text/plain"});
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();

  // ------------------------------------------------------------ admin-only
  {
    const {ctx, page} = await boot(browser, server, "?role=user");
    const s = await page.evaluate(() => ({
      adminBtn: getComputedStyle(document.getElementById("adminBtn")).display,
      teamBtn: getComputedStyle(document.getElementById("teamTabBtn")).display,
      panelVisible: document.getElementById("tab-admin").classList.contains("active"),
      people: document.querySelectorAll("#adminUsersList .admin-user-row").length,
      audit: document.querySelectorAll("#auditBody tr").length,
    }));
    ok(s.adminBtn === "none", "an employee cannot see the header Admin button", JSON.stringify(s));
    ok(s.teamBtn === "none", "an employee cannot see the Team tab button", JSON.stringify(s));
    ok(!s.panelVisible, "the Admin panel is not the active tab for an employee", JSON.stringify(s));
    ok(s.people === 0 && s.audit === 0,
      "no accounts or audit rows are rendered for an employee", JSON.stringify(s));

    // Forcing the panel open must still not populate it: renderAdmin() bails on
    // !isAdmin, so a stale tab across a demotion cannot keep painting the console.
    const after = await page.evaluate(async () => {
      document.getElementById("tab-admin").classList.add("active");
      const btn = document.getElementById("adminBtn");
      btn.style.display = "";
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      return {
        people: document.querySelectorAll("#adminUsersList .admin-user-row").length,
        audit: document.querySelectorAll("#auditBody tr").length,
      };
    });
    ok(after.people === 0 && after.audit === 0,
      "forcing the Admin panel open as an employee renders nothing", JSON.stringify(after));
    await ctx.close();
  }

  // ------------------------------------------------------------ admin console
  const {ctx, page, errors} = await boot(browser, server, "?role=admin");
  await page.evaluate(() => document.getElementById("adminBtn").click());
  await page.waitForTimeout(700);

  ok(errors.length === 0, "the Admin tab renders with no uncaught errors", errors.join(" | "));

  // The Team & Access card was absorbed; its controls must exist exactly once,
  // inside the Admin panel. A leftover duplicate would mean two sources of truth.
  {
    const s = await page.evaluate(() => ({
      oldCard: !!document.getElementById("accessCard"),
      oldList: !!document.getElementById("usersList"),
      bulkInAdmin: !!document.getElementById("tab-admin").querySelector("#bulkApplyBtn"),
      bulkCount: document.querySelectorAll("#bulkApplyBtn").length,
      roleToggles: document.querySelectorAll("#tab-admin .role-toggle").length,
    }));
    ok(!s.oldCard && !s.oldList, "the old Team & Access card is gone", JSON.stringify(s));
    ok(s.bulkInAdmin && s.bulkCount === 1, "Apply to Everyone lives in the Admin tab, once", JSON.stringify(s));
    ok(s.roleToggles === 3, "every account has a role toggle in the People list", JSON.stringify(s));
  }

  // ------------------------------------------------------------ header
  // Theme, schedule settings and sign-out were behind a "More" overflow menu.
  // They are buttons on the bar now, and Admin sits with them rather than in the
  // tab strip — so none of the old menu machinery may survive.
  {
    const s = await page.evaluate(() => ({
      menu: !!document.getElementById("headMenu"),
      menuBtn: !!document.getElementById("headMenuBtn"),
      onBar: ["themeBtn","settingsBtn","logoutBtn","adminBtn"].map(id => {
        const el = document.getElementById(id);
        if(!el) return `${id}: MISSING`;
        const r = el.getBoundingClientRect();
        const named = (el.getAttribute("aria-label") || el.textContent).trim();
        return r.width > 0 && r.height > 0 && named ? null : `${id}: ${r.width}x${r.height} "${named}"`;
      }).filter(Boolean),
      adminInStrip: !!document.querySelector('.tab-btn[data-tab="admin"]'),
      adminInBottomNav: !!document.querySelector('.bn-item[data-bn-tab="admin"]'),
      strip: [...document.querySelectorAll(".tabs .tab-btn")].map(b => b.getAttribute("data-tab")),
    }));
    ok(!s.menu && !s.menuBtn, "the header overflow menu is gone", JSON.stringify(s));
    const deskHeader = await page.evaluate(() => Math.round(
      document.querySelector("header.ledger-head").getBoundingClientRect().height));
    ok(deskHeader <= 130, "the header stays under 130px on a laptop", `${deskHeader}px`);
    ok(s.onBar.length === 0, "theme, settings, sign out and admin are visible, named header buttons",
      JSON.stringify(s.onBar));
    ok(!s.adminInStrip, "Admin is no longer a tab", JSON.stringify(s.strip));
    ok(!s.adminInBottomNav, "Admin is no longer in the mobile bottom nav", JSON.stringify(s));
    ok(s.strip.join(",") === "log,trends,calendar,punctuality,team",
      "the tab strip keeps the attendance views", JSON.stringify(s.strip));
  }
  {
    // The header button drives the same activation path as a tab, and carries
    // the "you are here" state itself since it sits outside the tablist.
    const s = await page.evaluate(() => {
      document.querySelector('.tab-btn[data-tab="log"]').click();
      const before = document.getElementById("adminBtn").getAttribute("aria-current");
      document.getElementById("adminBtn").click();
      return {
        before,
        after: document.getElementById("adminBtn").getAttribute("aria-current"),
        panel: document.getElementById("tab-admin").classList.contains("active"),
        logPanel: document.getElementById("tab-log").classList.contains("active"),
        stripSelected: [...document.querySelectorAll(".tabs .tab-btn")]
          .filter(b => b.getAttribute("aria-selected") === "true").length,
      };
    });
    ok(s.panel && !s.logPanel, "the header Admin button opens the Admin panel", JSON.stringify(s));
    ok(s.before === "false" && s.after === "page",
      "the Admin button shows when it is the open screen", JSON.stringify(s));
    ok(s.stripSelected === 0, "no tab claims selection while Admin is open", JSON.stringify(s));
  }
  {
    // Icon-only: the accessible name must describe the action and follow it.
    const s = await page.evaluate(() => {
      const b = document.getElementById("themeBtn");
      const before = b.getAttribute("aria-label");
      b.click();
      const mid = {label: b.getAttribute("aria-label"), dark: document.body.classList.contains("dark")};
      b.click();
      return {before, mid, after: b.getAttribute("aria-label"),
        light: !document.body.classList.contains("dark")};
    });
    ok(/dark/i.test(s.before) && s.mid.dark && /light/i.test(s.mid.label),
      "the theme button toggles and renames itself to the next action", JSON.stringify(s));
    ok(s.light && /dark/i.test(s.after), "toggling back restores light mode", JSON.stringify(s));
  }
  {
    // At phone width the Admin label is hidden to save the bar, so the button
    // must still carry a name for anyone who cannot see the icon.
    await page.setViewportSize({width: 390, height: 850});
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => {
      const b = document.getElementById("adminBtn");
      const r = b.getBoundingClientRect();
      return {w: Math.round(r.width), h: Math.round(r.height),
        labelShown: getComputedStyle(b.querySelector("span")).display,
        name: (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim()};
    });
    ok(s.w >= 40 && s.h >= 40, "the Admin button stays a 40px touch target on a phone", JSON.stringify(s));
    ok(s.labelShown === "none" && s.name.length > 0,
      "the collapsed Admin button keeps an accessible name", JSON.stringify(s));

    // The header was eating a third of a phone screen before any attendance
    // showed. These are the budgets it was trimmed to; they are the point of
    // the change, so they are asserted rather than eyeballed once.
    const phone = await page.evaluate(() => Math.round(
      document.querySelector("header.ledger-head").getBoundingClientRect().height));
    ok(phone <= 200, "the header stays under 200px on a phone", `${phone}px`);
    await page.setViewportSize({width: 1280, height: 900});
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById("adminBtn").click());
    await page.waitForTimeout(300);
  }

  // ------------------------------------------------------------ collapsing
  // Seven sections open at once was several thousand pixels of scrolling to
  // reach the log. Collapsed, the console is one screen you can scan.
  {
    const s = await page.evaluate(() => {
      const secs = [...document.querySelectorAll("#tab-admin .accordion-section")];
      const head = s => s.querySelector(".accordion-head");
      return {
        count: secs.length,
        open: secs.filter(x => x.classList.contains("open"))
                  .map(x => x.getAttribute("data-section")),
        panelHeight: Math.round(document.getElementById("tab-admin").getBoundingClientRect().height),
        aria: secs.map(x => head(x).getAttribute("aria-expanded") ===
                            (x.classList.contains("open") ? "true" : "false")).every(Boolean),
        controls: secs.every(x => {
          const id = head(x).getAttribute("aria-controls");
          return id && x.querySelector(".accordion-body").id === id;
        }),
      };
    });
    ok(s.count === 8, "the console is split into collapsible sections", JSON.stringify(s.count));
    ok(s.open.join(",") === "admin-overview,admin-people",
      "only the two everyday sections start open", JSON.stringify(s.open));
    ok(s.panelHeight < 1800, "the collapsed console fits a scannable page", `${s.panelHeight}px`);
    ok(s.aria, "each head reports its expanded state", JSON.stringify(s.aria));
    ok(s.controls, "each head points at the body it controls", JSON.stringify(s.controls));
  }
  {
    const s = await page.evaluate(() => {
      const sec = document.querySelector('#tab-admin [data-section="admin-audit"]');
      const head = sec.querySelector(".accordion-head");
      const body = sec.querySelector(".accordion-body");
      const shut = getComputedStyle(body).display;
      head.click();
      const opened = {display: getComputedStyle(body).display, aria: head.getAttribute("aria-expanded")};
      head.click();
      return {shut, opened, reshut: getComputedStyle(body).display,
        aria: head.getAttribute("aria-expanded")};
    });
    ok(s.shut === "none" && s.opened.display !== "none" && s.reshut === "none",
      "a section opens and closes on its heading", JSON.stringify(s));
    ok(s.opened.aria === "true" && s.aria === "false",
      "the heading's expanded state follows it", JSON.stringify(s));
  }

  // ------------------------------------------------------------ People
  {
    const s = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#adminUsersList .admin-user-row")];
      return {
        count: rows.length,
        badges: rows.map(r => [...r.querySelectorAll(".admin-badge")].map(b => b.textContent.trim())),
        countLabel: document.getElementById("adminUserCount").textContent,
        selfHasDelete: !!rows[0].querySelector("[data-delete-user]"),
      };
    });
    ok(s.count === 3, "the People list renders every account", JSON.stringify(s));
    ok(!s.selfHasDelete, "you cannot delete or deactivate your own account", JSON.stringify(s));
    ok(s.badges.some(b => b.includes("No schedule")),
      "someone with no user_settings row is flagged", JSON.stringify(s.badges));
    ok(s.badges.some(b => b.includes("Deactivated")), "a deactivated account is flagged", JSON.stringify(s.badges));
    ok(/1 admin/.test(s.countLabel), "the header counts admins", s.countLabel);
  }
  {
    const s = await page.evaluate(async () => {
      const search = document.getElementById("adminUserSearch");
      search.value = "kim";
      search.dispatchEvent(new Event("input"));
      const searched = document.querySelectorAll("#adminUsersList .admin-user-row").length;
      search.value = "";
      search.dispatchEvent(new Event("input"));

      const filter = document.getElementById("adminUserFilter");
      filter.value = "unconfigured";
      filter.dispatchEvent(new Event("change"));
      const unconfigured = document.querySelectorAll("#adminUsersList .admin-user-row").length;
      filter.value = "admin";
      filter.dispatchEvent(new Event("change"));
      const admins = document.querySelectorAll("#adminUsersList .admin-user-row").length;
      filter.value = "all";
      filter.dispatchEvent(new Event("change"));
      return {searched, unconfigured, admins,
        restored: document.querySelectorAll("#adminUsersList .admin-user-row").length};
    });
    ok(s.searched === 1, "search narrows the People list", JSON.stringify(s));
    ok(s.unconfigured === 1, "the 'no schedule set' filter finds exactly the unconfigured account", JSON.stringify(s));
    ok(s.admins === 1, "the admins filter finds exactly the admins", JSON.stringify(s));
    ok(s.restored === 3, "clearing the filter restores everyone", JSON.stringify(s));
  }

  // ------------------------------------------------------------ data health
  {
    const s = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#adminAttentionList .attention-item")];
      return {
        count: items.length,
        first: items[0] ? items[0].querySelector(".attention-count").textContent.trim() : null,
        titles: items.map(i => i.querySelector(".attention-title").textContent.trim()),
        clears: items.filter(i => i.querySelector(".attention-count.is-clear")).length,
      };
    });
    ok(s.count === 4, "every health check reports, clean or not", JSON.stringify(s));
    ok(s.first === "3", "the worst finding sorts first", JSON.stringify(s));
    ok(s.titles.some(t => /open shift/i.test(t)), "open shifts are reported", JSON.stringify(s.titles));
    ok(s.titles.some(t => /no schedule of their own/i.test(t)),
      "people with no schedule are reported", JSON.stringify(s.titles));
    ok(s.clears === 2, "checks that passed are shown as clear rather than hidden", JSON.stringify(s));
  }

  // ------------------------------------------------------------ org defaults
  {
    const s = await page.evaluate(() => ({
      days: [...document.querySelectorAll("#defaultsDayPicker input")].map(i => i.checked),
      targetH: document.getElementById("dTargetH").value,
      targetM: document.getElementById("dTargetM").value,
      start: document.getElementById("dIn").value,
      leave: document.getElementById("dLeaveDays").value,
      state: document.getElementById("adminDefaultsState").textContent,
    }));
    ok(s.days.join(",") === "false,true,true,true,true,true,false",
      "the defaults form loads the stored working week", JSON.stringify(s.days));
    ok(s.targetH === "7" && s.targetM === "30", "450 minutes renders as 7h 30m", JSON.stringify(s));
    ok(s.start === "09:00" && s.leave === "25", "stored start time and leave allowance load", JSON.stringify(s));
    ok(/^Set/.test(s.state), "a configured default is reported as set", s.state);
  }

  // ------------------------------------------------------------ activity log
  {
    const s = await page.evaluate(() => ({
      rows: document.querySelectorAll("#auditBody tr").length,
      people: document.querySelectorAll("#auditFilterUser option").length,
      count: document.getElementById("auditCount").textContent,
      detail: document.querySelector("#auditBody tr .audit-detail").textContent,
      hasExport: !!document.getElementById("auditExportBtn"),
      labelled: [...document.querySelectorAll("#auditBody tr:first-child td")]
        .every(td => td.querySelector(".cell-label")),
    }));
    ok(s.rows === 3, "the activity log renders its rows", JSON.stringify(s));
    ok(s.people === 4, "the person filter is populated from the account list", JSON.stringify(s));
    ok(/3 entries/.test(s.count), "the log reports how much is on screen", s.count);
    ok(/user . admin/.test(s.detail) || /→/.test(s.detail), "a role change spells out the transition", s.detail);
    ok(s.hasExport, "the log can be exported", JSON.stringify(s));
    ok(s.labelled, "log cells carry real DOM column labels for mobile screen readers", JSON.stringify(s));
  }

  // ------------------------------------------------------------ accessibility
  {
    const s = await page.evaluate(() => {
      const panel = document.getElementById("tab-admin");
      const controls = [...panel.querySelectorAll("input, select, textarea")];
      const unlabelled = controls.filter(c => {
        if(c.getAttribute("aria-label") || c.getAttribute("aria-labelledby")) return false;
        if(c.id && panel.querySelector(`label[for="${c.id}"]`)) return false;
        return !c.closest("label");
      }).map(c => c.id || c.type);
      const buttons = [...panel.querySelectorAll("button")]
        .filter(b => !b.textContent.trim() && !b.getAttribute("aria-label")).length;
      return {controls: controls.length, unlabelled, buttons};
    });
    ok(s.controls > 15, "the panel really was scanned", JSON.stringify({controls:s.controls}));
    ok(s.unlabelled.length === 0, "every admin control has an accessible name", JSON.stringify(s.unlabelled));
    ok(s.buttons === 0, "every admin button has an accessible name", JSON.stringify(s));
  }

  // ------------------------------------------------------------ Team roster
  // The other admin-only surface. Its old form was a flat list of three numbers
  // per person, all computed against whichever schedule the VIEWER happened to
  // hold — so a Sun–Thu admin looking at a Mon–Fri employee saw a target for a
  // week that employee does not work.
  {
    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="team"]').click());
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#teamList .team-card")];
      return {
        cards: cards.length,
        tags: cards.map(c => c.tagName),
        focusable: cards.every(c => c.tabIndex >= 0),
        named: cards.every(c => (c.getAttribute("aria-label") || "").length > 10),
        month: document.getElementById("teamMonthLabel").textContent,
        nextDisabled: document.getElementById("teamNextMonth").disabled,
        summary: document.getElementById("teamSummary").textContent.replace(/\s+/g, " ").trim(),
        statuses: cards.map(c => (c.querySelector(".team-status") || {}).textContent),
        bars: cards.map(c => (c.querySelector(".team-bar span") || {}).style?.width),
      };
    });
    ok(s.cards === 3, "the roster renders a card per person", JSON.stringify(s.cards));
    ok(s.tags.every(t => t === "BUTTON") && s.focusable,
      "cards are real buttons, reachable from a keyboard", JSON.stringify(s.tags));
    ok(s.named, "each card says whose record it opens", JSON.stringify(s.named));
    ok(s.nextDisabled, "the roster cannot walk into future months", JSON.stringify(s));
    ok(/people/.test(s.summary) && /on time/.test(s.summary) && /target/.test(s.summary),
      "a team-wide summary sits above the cards", s.summary.slice(0, 120));
    ok(s.statuses.every(x => typeof x === "string" && x.length),
      "every card says what that person is doing today", JSON.stringify(s.statuses));
    ok(s.bars.every(w => /%$/.test(w || "")), "every card shows progress against target",
      JSON.stringify(s.bars));
  }
  {
    // Kim is Mon–Fri 7h with one Friday (8h worked) and one Sunday (4h) logged.
    // Under her OWN schedule the Friday is a working day and the Sunday is not:
    // target 7h, worked 12h, diff +5h. Under the viewer's Sun–Thu 8h schedule it
    // would read target 8h and diff +4h — which is what the old roster showed.
    const s = await page.evaluate(() => {
      const card = [...document.querySelectorAll("#teamList .team-card")]
        .find(c => /Kim/.test(c.textContent));
      const fig = {};
      card.querySelectorAll(".team-card-figures > div").forEach(d => {
        fig[d.querySelector(".label").textContent.trim()] = d.querySelector(".value").textContent.trim();
      });
      return {note: card.querySelector(".team-bar-note").textContent.trim(), fig};
    });
    ok(/of 7h target/.test(s.note),
      "a card is measured against that person's own schedule, not the viewer's", JSON.stringify(s));
    ok(s.fig.Diff === "+5h", "the difference follows from their own target", JSON.stringify(s.fig));
    ok(s.fig.Days === "2", "both logged days count", JSON.stringify(s.fig));
  }
  {
    const s = await page.evaluate(async () => {
      const names = () => [...document.querySelectorAll("#teamList .team-card .team-name")]
        .map(n => n.textContent.trim().split(" ")[0]);
      const search = document.getElementById("teamSearch");
      search.value = "kim"; search.dispatchEvent(new Event("input"));
      const searched = names();
      search.value = ""; search.dispatchEvent(new Event("input"));

      const sort = document.getElementById("teamSort");
      sort.value = "worked"; sort.dispatchEvent(new Event("change"));
      const byWorked = names();
      sort.value = "name"; sort.dispatchEvent(new Event("change"));
      return {searched, byWorked, byName: names()};
    });
    ok(s.searched.length === 1 && /Kim/.test(s.searched[0]), "search narrows the roster", JSON.stringify(s));
    ok(s.byWorked[0] === "Kim", "sorting by hours puts the only logger first", JSON.stringify(s.byWorked));
    ok(s.byName.join(",") === "Ada,Kim,Sam", "sorting by name is alphabetical", JSON.stringify(s.byName));
  }
  {
    // The month control must actually re-query, and the label must follow.
    const s = await page.evaluate(async () => {
      const label = () => document.getElementById("teamMonthLabel").textContent;
      const before = label();
      document.getElementById("teamPrevMonth").click();
      await new Promise(r => setTimeout(r, 400));
      const prev = label();
      document.getElementById("teamNextMonth").click();
      await new Promise(r => setTimeout(r, 400));
      return {before, prev, back: label(), nextDisabled: document.getElementById("teamNextMonth").disabled};
    });
    ok(s.prev !== s.before && s.back === s.before,
      "the month arrows move the roster and come back", JSON.stringify(s));
    ok(s.nextDisabled, "forward is disabled again on the current month", JSON.stringify(s));
    await page.evaluate(() => document.getElementById("adminBtn").click());
    await page.waitForTimeout(300);
  }

  // ------------------------------------------------------------ dark mode
  // A search box is not covered by input[type=text] and keeps the UA's white
  // field unless it is styled explicitly — a bright hole in the dark theme.
  {
    const s = await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      document.body.classList.add("dark");
      const search = getComputedStyle(document.getElementById("adminUserSearch"));
      const plain = getComputedStyle(document.getElementById("bulkApplyNote"));
      return {search: search.backgroundColor, plain: plain.backgroundColor, colour: search.color};
    });
    ok(s.search === s.plain,
      "the People search field is themed like every other input", JSON.stringify(s));
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-theme");
      document.body.classList.remove("dark");
    });
  }

  // ------------------------------------------------------------ unset defaults
  await ctx.close();
  {
    const {ctx: c2, page: p2} = await boot(browser, server, "?role=admin&defaults=none");
    await p2.evaluate(() => document.getElementById("adminBtn").click());
    await p2.waitForTimeout(500);
    const state = await p2.evaluate(() => document.getElementById("adminDefaultsState").textContent);
    ok(/Not set/.test(state), "an empty default_settings is called out, not hidden", state);
    await c2.close();
  }

  await browser.close();
  server.close();

  console.log(`  admin-tab   pass ${pass}   fail ${fail}`);
  failures.forEach(f => console.log("    ✗ " + f));
  process.exit(fail ? 1 : 0);
})();
