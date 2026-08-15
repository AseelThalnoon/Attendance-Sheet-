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
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png"};

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
const SETTINGS_ROWS = [{user_id:UID}, {user_id:"u-2"}];
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
// Consumed in call order by the three counted health queries: open shifts,
// blank working days, implausible dates.
const HEAD_COUNTS = [3, 0, 0];
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
      if(head) return {data:null, count: HEAD_COUNTS.length ? HEAD_COUNTS.shift() : 0, error:null};
      return {data:[], error:null};
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
      tabBtn: getComputedStyle(document.getElementById("adminTabBtn")).display,
      teamBtn: getComputedStyle(document.getElementById("teamTabBtn")).display,
      panelVisible: document.getElementById("tab-admin").classList.contains("active"),
      people: document.querySelectorAll("#adminUsersList .admin-user-row").length,
      audit: document.querySelectorAll("#auditBody tr").length,
    }));
    ok(s.tabBtn === "none", "an employee cannot see the Admin tab button", JSON.stringify(s));
    ok(s.teamBtn === "none", "an employee cannot see the Team tab button", JSON.stringify(s));
    ok(!s.panelVisible, "the Admin panel is not the active tab for an employee", JSON.stringify(s));
    ok(s.people === 0 && s.audit === 0,
      "no accounts or audit rows are rendered for an employee", JSON.stringify(s));

    // Forcing the panel open must still not populate it: renderAdmin() bails on
    // !isAdmin, so a stale tab across a demotion cannot keep painting the console.
    const after = await page.evaluate(async () => {
      document.getElementById("tab-admin").classList.add("active");
      const btn = document.getElementById("adminTabBtn");
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
  await page.evaluate(() => document.getElementById("adminTabBtn").click());
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
    await p2.evaluate(() => document.getElementById("adminTabBtn").click());
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
