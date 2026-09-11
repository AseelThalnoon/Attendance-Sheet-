// The 44px touch floor, below the frame's 1100px breakpoint.
//
// DESIGN.md's One Module rule says the pointer-sized step-down is a property of
// the input device: above 1100px the frame is a pointer surface and controls
// shrink to the 32px Log row's scale; below it, every control keeps its 44px
// touch target. The rule was written and never enforced, and twelve controls
// carried their pointer size as their *base* — so the shrink applied at every
// width and the floor existed only in prose. A tablet at 1024px got a 30px
// sign-out disc, a 32px sub-tab, 36px row actions and a 30px "Back Up Now".
//
// Measured in a real browser against real rows, for two reasons. Two of the
// twelve were written correctly inside the frame's step-down block and still
// rendered small, because the component's own base rule appears later in the
// stylesheet and wins at equal specificity — reading the CSS said fixed. And
// the controls that drifted furthest (row actions, the day picker, the role
// switch) only exist once there is data, so a fixture that reveals the shell
// without it measures none of them and passes vacuously.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8961;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png",
  ".css":"text/css", ".woff2":"font/woff2"};

// The same admin-with-two-months fixture the frame suite uses: admin sees every
// tab, and a populated Log is what renders the row actions.
// The frame suite's stub answers `admin_list_users` with an empty array, so the
// Admin people list renders no rows and the role switch — one of the controls
// that drifted — is never on screen to measure. Two rows are enough, and the
// assertions below refuse to pass if the list is empty again.
const STUB = fs.readFileSync(path.join(ROOT, "tests", "regression", "one-screen.js"), "utf8")
  .split("const STUB = `")[1].split("`;")[0]
  .replace("function builder(t){",
`const ADMIN_USERS=[
  {id:UID,email:"frame@example.com",full_name:"Frame Tester",role:"admin",
    entry_count:42,last_sign_in_at:new Date().toISOString(),deactivated:false},
  {id:"44444444-4444-4444-4444-444444444444",email:"b@example.com",full_name:"Second Person",
    role:"user",entry_count:7,last_sign_in_at:new Date().toISOString(),deactivated:false}];
function builder(t){`)
  .replace("rpc:()=>builder(\"rpc\")",
    "rpc:(name)=>Promise.resolve(name===\"admin_list_users\"?{data:ADMIN_USERS,error:null}:{data:[],error:null})");

// 1099 is the width that matters most: one pixel below the frame, where the
// step-down must not have happened yet. 393 and 768 sit either side of the
// rail's own 760px handover.
const WIDTHS = [393, 768, 1024, 1099];
const FLOOR = 44;
// WCAG 2.2 SC 2.5.8 at AA — the floor under the pointer step-down, which the
// frame may approach but never cross.
const POINTER_FLOOR = 24;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail ? "\n     " + detail : ""}`); }
}

// Every control on screen, with the size a finger actually gets: a checkbox is
// as large as the label that activates it.
const MEASURE = (floor) => {
  const out = [];
  for(const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")){
    const r = el.getBoundingClientRect();
    if(!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if(cs.visibility === "hidden" || +cs.opacity === 0) continue;
    const lab = el.closest("label");
    const lr = lab ? lab.getBoundingClientRect() : null;
    const h = Math.max(r.height, lr ? lr.height : 0);
    const w = Math.max(r.width, lr ? lr.width : 0);
    // The month grid is the one documented exception: seven columns in a 393px
    // viewport leave 41.6px of width per cell, and the only routes to 44 are a
    // horizontal scrollbar on a month or a week that does not fit on a line.
    // Its height is not constrained that way and still has to make the floor.
    const isCell = el.classList.contains("cal-cell");
    if(h < floor - 0.5 || (!isCell && w < floor - 0.5 && el.matches(".icon-btn, [class*=logout]")))
      out.push({
        sel: el.tagName.toLowerCase() + "." + String(el.className || "").split(" ").filter(Boolean).slice(0, 2).join("."),
        t: (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 24),
        w: Math.round(w), h: Math.round(h)
      });
  }
  const seen = new Set();
  return out.filter(x => { const k = x.sel + x.h; if(seen.has(k)) return false; seen.add(k); return true; });
};

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
  const page = await (await browser.newContext()).newPage();
  await page.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB}));
  await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await page.waitForTimeout(700);

  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".tab-btn")).map(b => b.getAttribute("data-tab")));

  // A tab, and where asked a console section inside it: the Admin and Settings
  // tabs show one section at a time, so the role switch and the day picker are
  // not on screen until their section is selected. Half the controls that
  // drifted live behind one of these.
  async function openTab(t, section){
    await page.evaluate(([x, sec]) => {
      if(x === "admin") document.getElementById("adminBtn").click();
      else document.querySelector('.tab-btn[data-tab="' + x + '"]').click();
      if(sec) document.querySelector('[data-console-target="' + sec + '"]')?.click();
    }, [t, section || null]);
    // Past the panel's entrance and the calendar's staggered row reveal: both
    // animate transform, and getBoundingClientRect reports the visual box, so
    // a cell mid-reveal measures 43.9px and reads as a failure that is not one.
    await page.waitForTimeout(900);
  }

  // Every tab, plus the console sections that hold controls of their own.
  const STOPS = tabs.map(t => [t, null])
    .concat([["admin", null], ["admin", "admin-people"], ["admin", "admin-defaults"],
             ["settings", "hours"], ["settings", "data"]]);

  for(const width of WIDTHS){
    await page.setViewportSize({width, height: 900});
    for(const [tab, section] of STOPS){
      await openTab(tab, section);
      const small = await page.evaluate(MEASURE, FLOOR);
      ok(small.length === 0,
        `${tab}${section ? "/" + section : ""} @${width}px — every control clears the ${FLOOR}px touch floor`,
        small.map(x => `${x.w}x${x.h}  ${x.sel}  "${x.t}"`).join("\n     "));
    }
  }

  // The other half of the rule. If the module never steps down, the frame stops
  // being a pointer surface and the density that fits a month on one screen
  // goes with it — so this asserts the shrink happens, and that it stops at
  // the 24px accessibility floor rather than wherever the layout wanted.
  await page.setViewportSize({width: 1440, height: 900});
  const probes = {
    "sub-tab": [".sub-tab-btn", "trends"],
    "row action": [".row-actions button", "log"],
    "day picker": [".daypicker label", "settings", "hours"],
    "row menu": [".row-menu-btn", "admin", "admin-people"]
  };
  for(const [name, [sel, tab, section]] of Object.entries(probes)){
    await openTab(tab, section);
    const h = await page.evaluate(s => {
      const el = Array.from(document.querySelectorAll(s)).find(e => e.getClientRects().length);
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    }, sel);
    ok(h !== null, `@1440px — ${name} ("${sel}") is on screen to measure`,
      "nothing matched, so the step-down assertions below would pass vacuously");
    if(h === null) continue;
    ok(h < FLOOR, `@1440px — ${name} steps down to pointer size`, `it is still ${h}px`);
    ok(h >= POINTER_FLOOR, `@1440px — ${name} stays above the ${POINTER_FLOOR}px WCAG 2.5.8 floor`,
      `it is ${h}px`);
  }

  await browser.close();
  server.close();
  console.log(`  touch-floor  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
