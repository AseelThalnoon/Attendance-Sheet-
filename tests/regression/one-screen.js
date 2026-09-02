// Every tab is one screen: above 1100px the shell is a fixed frame the height
// of the viewport, so no tab may put a scrollbar on the page, and the frame
// around the panels must never scroll either. A tab whose content outgrows the
// frame scrolls inside its own panel — there is no pager any more, so this file
// also polices the density that made dropping it possible: thin rows, a compact
// header, and a month of Log entries arriving whole.
//
// Measured in a real browser against the real app — the frame is pure layout,
// and the two defects it already produced were both invisible to markup checks:
// main's `margin:0 auto` cancelled its flex stretch and collapsed the tab card
// to 699px, and #tabContentCard's display:flex outranked the [hidden] attribute
// the Overview relies on, leaving an empty card standing under the panel.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8953;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png",
  ".css":"text/css", ".woff2":"font/woff2"};

// An admin with a couple of months of entries: admin sees every tab, and a
// populated Log is the case that actually overflows.
const STUB = `
const UID="33333333-3333-3333-3333-333333333333";
const ENTRIES=(()=>{const out=[];const d=new Date();
  for(let i=0;i<60;i++){
    const dt=new Date(d.getFullYear(),d.getMonth(),d.getDate()-i);
    if(dt.getDay()===5||dt.getDay()===6) continue;
    const iso=dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
    out.push({id:"e"+i,user_id:UID,date:iso,clock_in:(i%7===0)?"09:05":"08:00",
      clock_out:(i%11===0)?null:(i%5===0?"17:10":"16:00"),
      type:(i%13===0)?"wfh":(i%17===0?"leave":"regular"),note:(i%9===0)?"Client visit":""});
  }return out;})();
const PROFILE={id:UID,email:"frame@example.com",full_name:"Frame Tester",role:"admin"};
const PEOPLE=[PROFILE,{id:"44444444-4444-4444-4444-444444444444",email:"b@example.com",full_name:"Second Person",role:"user"}];
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:PEOPLE,error:null};
  if(t==="user_settings") return {data:{settings:{}},error:null};
  if(t==="app_settings") return {data:{allow_registration:true,announcement_active:false,announcement:""},error:null};
  return {data:[],error:null};}
function builder(t){let k="list";
  const proxy=new Proxy(function(){},{get(_,p){
    if(p==="then") return (r,j)=>Promise.resolve(result(t,k)).then(r,j);
    if(p==="catch") return f=>Promise.resolve(result(t,k)).catch(f);
    if(p==="finally") return f=>Promise.resolve(result(t,k)).finally(f);
    if(p==="single"||p==="maybeSingle") return ()=>{k="single";return proxy;};
    return ()=>proxy;}});
  return proxy;}
export function createClient(){return{from:builder,rpc:()=>builder("rpc"),
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"frame@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"frame@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// Thirty people, so the roster and the People list have to page rather than
// simply fit. Six of them log time, to keep the fixture's month cheap.
const STUB_BIG_TEAM = `
const UID="55555555-5555-5555-5555-555555555555";
const PEOPLE=[{id:UID,email:"lead@example.com",full_name:"Frame Tester",role:"admin"}];
for(let i=1;i<30;i++) PEOPLE.push({id:"u"+i+"-0000-0000-0000-00000000000"+(i%10),
  email:"p"+i+"@example.com",full_name:"Person Number "+i,role:"user"});
const ENTRIES=(()=>{const out=[];const d=new Date();
  for(let i=0;i<40;i++){const dt=new Date(d.getFullYear(),d.getMonth(),d.getDate()-i);
    const iso=dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
    PEOPLE.slice(0,6).forEach(function(p,j){
      out.push({id:"e"+i+"_"+j,user_id:p.id,date:iso,clock_in:"08:00",clock_out:"16:00",type:"regular",note:""});});}
  return out;})();
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PEOPLE[0],error:null}:{data:PEOPLE,error:null};
  if(t==="user_settings") return {data:{settings:{}},error:null};
  if(t==="app_settings") return {data:{allow_registration:true,announcement_active:false,announcement:""},error:null};
  return {data:[],error:null};}
function builder(t){let k="list";
  const proxy=new Proxy(function(){},{get(_,p){
    if(p==="then") return (r,j)=>Promise.resolve(result(t,k)).then(r,j);
    if(p==="catch") return f=>Promise.resolve(result(t,k)).catch(f);
    if(p==="finally") return f=>Promise.resolve(result(t,k)).finally(f);
    if(p==="single"||p==="maybeSingle") return ()=>{k="single";return proxy;};
    return ()=>proxy;}});
  return proxy;}
export function createClient(){return{from:builder,rpc:()=>builder("rpc"),
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"lead@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"lead@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// 1280x720 with two banners up is the tightest the frame is asked to hold:
// below that the window is shorter than a single row of anything.
const SIZES = [[1920,1080], [1440,900], [1366,768], [1280,800], [1280,720]];

// A Log row is the unit everything else is measured in: the whole point of the
// density pass is that a month of them lands in one screenful. 34px allows the
// 32px row a couple of pixels of sub-pixel rounding; anything fatter means a
// touch target or a pill has crept back in and the month needs scrolling again.
const MAX_ROW_H = 34;
// WCAG 2.2 SC 2.5.8 at AA. The density pass shrinks the pointer-sized controls
// inside a row; this is the line it may not cross to do it. It was crossed once
// — Edit and Delete went to 21px — so it is asserted rather than commented.
const MIN_TARGET_H = 24;
// Header plus however many notice banners are up, above the tab card. This used
// to be 240px — a fifth of the window spent on a greeting and two alerts.
//
// Checked at every size in SIZES, not just at 1440x900. It was a single-viewport
// assertion once, and it passed at 1440 (123px) while 1280x720 sat at 165px and
// 1100x800 at 205px — the rule read as enforced and was not.
//
// 155, not 130: a notice is a title, a sentence and its buttons, and below about
// 1400px that sentence needs a second line. 130 is reachable at 1440 and above
// and unreachable at 1280 without truncating the sentence away, which is the
// part that tells you what to do. The ceiling is the one that holds everywhere.
const MAX_CHROME_H = 155;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond) pass++; else { fail++; failures.push(`${name}${detail ? "\n      " + detail : ""}`); }
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
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB}));
  await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await page.waitForTimeout(700);

  // Admin is a destination rather than a tab, so it has its own trigger.
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".tab-btn"))
    .filter(b => b.offsetParent !== null || b.style.display !== "none")
    .map(b => b.getAttribute("data-tab")));

  // The paging this file used to police is gone: a tab that outgrows the frame
  // scrolls inside its own panel now. So there must be no pager left anywhere —
  // a stray one would be a control with nothing behind it.
  ok(await page.evaluate(() => document.querySelectorAll(".pager").length) === 0,
    "no pager survives anywhere in the app");

  for(const [w, h] of SIZES){
    await page.setViewportSize({width: w, height: h});
    for(const tab of tabs.concat("admin")){
      await page.evaluate(t => {
        if(t === "admin") document.getElementById("adminBtn").click();
        else document.querySelector('.tab-btn[data-tab="' + t + '"]').click();
      }, tab);
      // Past the panel's 250ms entrance, not inside it. At 220ms this loop sat
      // in a blind spot: the .cell-label overflow that stretched the document
      // by 107px only showed up once the animation finished, so the page-scroll
      // assertion below read a settled-looking 0 and passed over a real
      // scrollbar. Measure what the person ends up looking at.
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const main = document.getElementById("main");
        const panel = document.querySelector(".tab-panel.active");
        const card = document.getElementById("tabContentCard");
        const cs = getComputedStyle(main);
        return {
          page: document.documentElement.scrollHeight - window.innerHeight,
          main: main.scrollHeight - main.clientHeight,
          panelId: panel ? panel.id : null,
          panelX: panel ? panel.scrollWidth - panel.clientWidth : 0,
          // Taller than its box is fine now — that is what the scrollbar is
          // for — but only if the panel actually scrolls. A panel that clips
          // instead is content nobody can reach.
          scrollable: panel
            ? (panel.scrollHeight - panel.clientHeight <= 1 ||
               ["auto","scroll"].includes(getComputedStyle(panel).overflowY))
            : true,
          cardW: card.hidden ? null : Math.round(card.getBoundingClientRect().width),
          // Everything above the tab card: the header plus whatever notices are
          // up. Measured at every size, because it is the narrow ones that blow it.
          chrome: Math.round(card.getBoundingClientRect().top -
            document.querySelector("header.ledger-head").getBoundingClientRect().top),
          // The bar is anchored to the viewport, but the rail owns the left
          // 236px of it. Overlapping put the rail's user block behind a dark
          // panel on every tab but the Overview.
          railOverlap: (() => {
            const bar = document.getElementById("stickyClock");
            const rail = document.querySelector(".rail");
            if(!bar.classList.contains("show") || getComputedStyle(rail).display === "none") return null;
            return Math.round(rail.getBoundingClientRect().right - bar.getBoundingClientRect().left);
          })(),
          // The sticky clock bar floats over the bottom of the frame on every
          // tab but the Overview. Scrolled all the way down, the last row must
          // still be readable rather than parked underneath it.
          clearance: (() => {
            const bar = document.getElementById("stickyClock");
            if(!bar.classList.contains("show") || !panel) return null;
            panel.scrollTop = panel.scrollHeight;
            const kids = Array.from(panel.children).filter(el => el.getClientRects().length);
            const last = kids[kids.length - 1];
            if(!last) return null;
            return Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom);
          })(),
          mainInnerW: Math.round(main.getBoundingClientRect().width -
            parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
        };
      });
      const at = `${tab} @ ${w}x${h}`;
      // 1px of slack: sub-pixel row heights round up into a phantom scrollbar.
      ok(m.page <= 1, `${at} — the page does not scroll`, `scrollHeight over viewport by ${m.page}px`);
      ok(m.main <= 1, `${at} — the frame holds, the panel scrolls`, `main overflows its own box by ${m.main}px`);
      ok(m.panelId === "tab-" + tab, `${at} — the tab actually opened`, `active panel is ${m.panelId}`);
      ok(m.scrollable, `${at} — content past the fold is reachable`, "the panel clips instead of scrolling");
      ok(m.panelX <= 1, `${at} — the panel does not scroll sideways`, `panel content is ${m.panelX}px wider than its box`);
      if(m.clearance !== null){
        ok(m.clearance >= 0, `${at} — the scrolled panel clears the sticky clock bar`,
          `panel ends ${-m.clearance}px behind the bar`);
      }
      if(m.cardW !== null){
        ok(Math.abs(m.cardW - m.mainInnerW) <= 1, `${at} — the tab card fills the content column`,
          `card ${m.cardW}px vs ${m.mainInnerW}px available`);
      }
      ok(m.chrome <= MAX_CHROME_H, `${at} — header and notices stay under ${MAX_CHROME_H}px`,
        `they take ${m.chrome}px before the tab starts`);
      if(m.railOverlap !== null){
        ok(m.railOverlap <= 0, `${at} — the sticky clock bar starts clear of the rail`,
          `it runs ${m.railOverlap}px underneath the rail`);
      }
    }
  }

  // The sized loop above only ever sees Trends' default Weekly sub-tab —
  // Monthly sits in the same panel with fewer, taller rows and is never
  // otherwise measured against the frame.
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="trends"]').click());
  for(const [w, h] of SIZES){
    await page.setViewportSize({width: w, height: h});
    await page.evaluate(() => document.querySelector('.sub-tab-btn[data-subtab="monthly"]').click());
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({
      page: document.documentElement.scrollHeight - window.innerHeight,
      main: document.getElementById("main").scrollHeight - document.getElementById("main").clientHeight
    }));
    ok(m.page <= 1, `trends/monthly @ ${w}x${h} — the page does not scroll`, `scrollHeight over viewport by ${m.page}px`);
    ok(m.main <= 1, `trends/monthly @ ${w}x${h} — the frame holds, the panel scrolls`, `main overflows its own box by ${m.main}px`);
  }

  // The Overview owns the whole frame: its card must not be left standing.
  await page.setViewportSize({width: 1440, height: 900});
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="overview"]').click());
  await page.waitForTimeout(220);
  {
    const s = await page.evaluate(() => {
      const card = document.getElementById("tabContentCard");
      const panel = document.getElementById("tab-overview");
      const main = document.getElementById("main");
      return {card: getComputedStyle(card).display, hidden: card.hidden,
        slack: Math.round(main.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom)};
    });
    ok(s.hidden && s.card === "none", "the tab card stays hidden behind the Overview",
      `hidden=${s.hidden} display=${s.card}`);
    ok(s.slack <= 2, "the Overview fills the frame", `${s.slack}px of the frame left unused`);
  }

  // ---------------------------------------------------------------- density
  // The reason the pager could go. Rows have to stay thin, the chrome above
  // the card has to stay out of the way, and the month you are looking at has
  // to arrive whole rather than a screenful at a time.
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="log"]').click());
  await page.waitForTimeout(250);
  {
    const d = await page.evaluate((MIN_TARGET_H) => {
      const rows = Array.from(document.querySelectorAll("#logBody tr"))
        .filter(tr => tr.style.display !== "none");
      const head = document.querySelector("header.ledger-head");
      // The notices live in #noticeStack now, not loose in main: on a phone the
      // first stays open and the rest fold behind a counted button, which needs
      // them to be one region. Still every notice that is up, which is what the
      // count below is actually asserting.
      const banners = Array.from(document.querySelectorAll("#noticeStack > .reminder"))
        .filter(el => el.classList.contains("show"));
      const card = document.getElementById("tabContentCard");
      return {
        rows: rows.length,
        hidden: document.querySelectorAll("#logBody tr[style*='display: none']").length,
        tallest: Math.max(...rows.map(tr => Math.round(tr.getBoundingClientRect().height))),
        banners: banners.length,
        // Every Edit/Delete in the table, so the density pass cannot buy row
        // height back by dropping a target under the 24px floor again.
        smallTargets: Array.from(document.querySelectorAll("#logBody .row-actions button"))
          .filter(bt => Math.round(bt.getBoundingClientRect().height) < MIN_TARGET_H).length,
        totalTargets: document.querySelectorAll("#logBody .row-actions button").length,
        stickyHead: getComputedStyle(document.querySelector("#tab-log thead th")).position
      };
    }, MIN_TARGET_H);
    ok(d.tallest <= MAX_ROW_H, `a Log row stays under ${MAX_ROW_H}px`, `tallest row is ${d.tallest}px`);
    ok(d.hidden === 0, "no Log row is hidden from you", `${d.hidden} rows are display:none`);
    ok(d.banners >= 2, "the fixture really does have two notices up", `${d.banners} showing`);
    ok(d.smallTargets === 0, `every row action clears the ${MIN_TARGET_H}px target floor`,
      `${d.smallTargets} of ${d.totalTargets} are shorter`);
    ok(d.stickyHead === "sticky", "the column headings stay put while the rows scroll",
      `thead th position is ${d.stickyHead}`);
  }

  // A month has to land in one screenful on a normal desktop window — the whole
  // point of the density pass. Measured at 1920x1080 rather than at the 720px
  // floor, where a long month legitimately scrolls.
  await page.setViewportSize({width: 1920, height: 1080});
  await page.waitForTimeout(300);
  {
    const m = await page.evaluate(() => {
      const panel = document.getElementById("tab-log");
      return {
        over: panel.scrollHeight - panel.clientHeight,
        rows: Array.from(document.querySelectorAll("#logBody tr")).length
      };
    });
    ok(m.over <= 1, "a month of entries fits one screen at 1920x1080",
      `${m.rows} rows leave ${m.over}px below the fold`);
  }
  await page.setViewportSize({width: 1440, height: 900});
  await page.waitForTimeout(250);

  // Opening a section is the other way a tab's height changes under the frame.
  // It no longer has to fit — it scrolls — but it does have to be shown whole
  // and be brought into view, or the click reads as "nothing happened".
  async function checkSections(tab, scope){
    const sections = await page.evaluate((s) =>
      Array.from(document.querySelectorAll(s + " .accordion-section"))
        .map(el => el.getAttribute("data-section")), scope);
    for(const name of sections){
      const r = await page.evaluate(async ([n, s]) => {
        const panel = document.querySelector(s);
        panel.querySelectorAll(".accordion-section.open .accordion-head").forEach(h => h.click());
        const sec = panel.querySelector('.accordion-section[data-section="' + n + '"]');
        sec.querySelector(".accordion-head").click();
        await new Promise(res => setTimeout(res, 400));
        const body = sec.querySelector(".accordion-body");
        const pr = document.querySelector(".tab-panel.active").getBoundingClientRect();
        const hr = sec.querySelector(".accordion-head").getBoundingClientRect();
        // A short window can flex-shrink a sibling instead of letting the
        // panel scroll — .accordion-section{overflow:hidden} then clips it
        // silently (body.scrollHeight looks fine; the section's own box is
        // just smaller than head+body need), so the section itself is what
        // has to be measured, not the body alone.
        const need = hr.height + (body ? body.scrollHeight : 0);
        // The other shape the same shrink bug takes: a sibling squeezed
        // below what IT needs spills out through overflow:visible instead of
        // clipping, and visually overlaps whatever comes after it.
        //
        // In-flow children only. An .sr-only heading is position:absolute and
        // sits wherever its static position landed — it cannot be flex-shrunk
        // and it cannot be spilled into, so measuring it as a flex sibling
        // reported a 113px "overlap" on Shortfall that no one can see.
        const siblings = Array.from(panel.children).filter(el =>
          el.getClientRects().length &&
          !["absolute","fixed"].includes(getComputedStyle(el).position));
        let overlap = null;
        for(let i = 0; i < siblings.length - 1; i++){
          const gap = siblings[i+1].getBoundingClientRect().top - siblings[i].getBoundingClientRect().bottom;
          if(gap < -1){ overlap = i; break; }
        }
        // And the version of that inside a single sibling: period-card can be
        // squeezed below what its own head + chart-holder need without ever
        // registering as "clipped" (overflow:visible reports no scrollable
        // overflow) — the chart just renders past its own card's bottom edge,
        // over whatever sits underneath it in the panel.
        let escapes = null;
        for(const el of siblings){
          for(const child of el.children){
            if(!child.getClientRects().length) continue;
            if(child.getBoundingClientRect().bottom > el.getBoundingClientRect().bottom + 1){
              escapes = child.className || child.tagName; break;
            }
          }
          if(escapes) break;
        }
        return {
          clipped: Math.round(need - sec.getBoundingClientRect().height),
          overlap, escapes,
          // and the section you clicked is on screen after opening
          inView: hr.top >= pr.top - 1 && hr.top <= pr.bottom,
          frameHeld: document.getElementById("main").scrollHeight -
                     document.getElementById("main").clientHeight
        };
      }, [name, scope]);
      ok(r.clipped <= 1, `${tab}: "${name}" shows its whole body`, `${r.clipped}px of it is clipped away`);
      ok(r.overlap === null, `${tab}: opening "${name}" leaves no sibling overlapping another`,
        `siblings ${r.overlap} and ${r.overlap + 1} overlap`);
      ok(r.escapes === null, `${tab}: opening "${name}" leaves no card squeezed below its own content`,
        `"${r.escapes}" renders past its own parent's bottom edge`);
      ok(r.inView, `${tab}: the section you open is scrolled into view`, `"${name}" is off screen`);
      ok(r.frameHeld <= 1, `${tab}: opening "${name}" keeps the frame intact`, `main scrolls by ${r.frameHeld}px`);
    }
  }

  // Settings and Admin are consoles rather than accordion stacks: a nav column
  // on the left, one section showing on the right. The failure they can still
  // have is the same one — a section shown but clipped, or one whose content
  // spills over whatever sits under it — so it is asserted the same way, just
  // driven by the nav instead of by a heading.
  async function checkConsole(tab, rootId){
    const names = await page.evaluate(id => Array.from(
      document.querySelectorAll("#" + id + " .console-nav-item"))
        .map(el => el.getAttribute("data-console-target")), rootId);
    ok(names.length > 0, `${tab}: the console has a nav`, "no nav items found");
    for(const name of names){
      const r = await page.evaluate(async ([n, id]) => {
        const root = document.getElementById(id);
        const item = root.querySelector('.console-nav-item[data-console-target="' + n + '"]');
        item.click();
        await new Promise(res => setTimeout(res, 350));
        const pane = root.querySelector(".console-pane");
        const shown = Array.from(root.querySelectorAll(".console-section"))
          .filter(el => el.getClientRects().length)
          .map(el => el.getAttribute("data-section"));
        // A section rendered shorter than its own content is the clipping bug
        // the accordion had; overflow:hidden anywhere up the chain brings it
        // back, silently.
        const sec = root.querySelector('.console-section[data-section="' + n + '"]');
        const clipped = Math.round(sec.scrollHeight - sec.getBoundingClientRect().height);
        // The same squeeze in its other form: a child spilling out through
        // overflow:visible and landing on top of whatever follows it.
        let escapes = null;
        for(const el of pane.children){
          if(!el.getClientRects().length) continue;
          for(const child of el.children){
            if(!child.getClientRects().length) continue;
            if(child.getBoundingClientRect().bottom > el.getBoundingClientRect().bottom + 1){
              escapes = child.className || child.tagName; break;
            }
          }
          if(escapes) break;
        }
        return {
          shown, clipped, escapes,
          selected: item.getAttribute("aria-selected"),
          frameHeld: document.getElementById("main").scrollHeight -
                     document.getElementById("main").clientHeight
        };
      }, [name, rootId]);
      ok(r.shown.length === 1 && r.shown[0] === name,
        `${tab}: picking "${name}" shows that section and only that one`, JSON.stringify(r.shown));
      ok(r.selected === "true", `${tab}: the nav row for "${name}" reports itself selected`, r.selected);
      ok(r.clipped <= 1, `${tab}: "${name}" shows its whole body`, `${r.clipped}px of it is clipped away`);
      ok(r.escapes === null, `${tab}: "${name}" leaves no card squeezed below its own content`,
        `"${r.escapes}" renders past its own parent's bottom edge`);
      ok(r.frameHeld <= 1, `${tab}: picking "${name}" keeps the frame intact`, `main scrolls by ${r.frameHeld}px`);
    }
  }

  for(const tab of ["settings", "admin", "punctuality"]){
    await page.evaluate(t => {
      if(t === "admin") document.getElementById("adminBtn").click();
      else document.querySelector('.tab-btn[data-tab="' + t + '"]').click();
    }, tab);
    await page.waitForTimeout(250);
    if(tab === "settings") await checkConsole(tab, "settingsConsole");
    else if(tab === "admin") await checkConsole(tab, "adminConsole");
    else await checkSections(tab, ".tab-panel.active");
  }

  // Trends keeps both sub-tab panels in the DOM at once, one of them
  // display:none — a section gathered from the inactive one would click a
  // zero-size accordion head and read every assertion below as a false pass.
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="trends"]').click());
  await page.waitForTimeout(250);
  for(const subtab of ["weekly", "monthly"]){
    await page.evaluate(s => document.querySelector('.sub-tab-btn[data-subtab="' + s + '"]').click(), subtab);
    await page.waitForTimeout(250);
    await checkSections(`trends/${subtab}`, ".sub-tab-panel.active");
  }

  // The chart-and-table tabs only actually get squeezed at the frame's short
  // end — 1440x900 has room for both in full, so the flex-shrink fight
  // between the chart and the table underneath it never triggers there.
  await page.setViewportSize({width: 1280, height: 720});
  await page.waitForTimeout(250);
  await checkSections("trends/weekly (short)", ".sub-tab-panel.active");
  await page.evaluate(() => document.querySelector('.sub-tab-btn[data-subtab="monthly"]').click());
  await page.waitForTimeout(250);
  await checkSections("trends/monthly (short)", ".sub-tab-panel.active");
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="punctuality"]').click());
  await page.waitForTimeout(250);
  await checkSections("punctuality (short)", ".tab-panel.active");
  await page.setViewportSize({width: 1440, height: 900});
  await page.waitForTimeout(250);

  // ------------------------------------------------------- the month grid's rows
  // The Calendar is the one tab drawn to the height it is given, so how that
  // height is divided is the whole layout. The grid's first row is the seven
  // SUN..SAT labels, and it has no grid-template-rows of its own — so
  // grid-auto-rows:minmax(0,1fr) sized that 19px strip of text like a week:
  // 97px, of which 77 were blank, banded across the top of the month while
  // every row that holds actual dates was 16px shorter to pay for it.
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="calendar"]').click());
  await page.waitForTimeout(600);
  {
    const g = await page.evaluate(() => {
      const grid = document.querySelector(".calendar-grid");
      if(!grid) return null;
      const rows = getComputedStyle(grid).gridTemplateRows.split(" ").map(parseFloat);
      // Over the text itself, not the box: the box is what the grid stretched,
      // so measuring it would report the bug as if it were the requirement.
      const dow = Array.from(grid.querySelectorAll(".cal-dow")).reduce((m, e) => {
        const r = document.createRange(); r.selectNodeContents(e);
        return Math.max(m, r.getBoundingClientRect().height);
      }, 0);
      // The grid renders whatever month is on screen when the suite runs, and
      // a month spans 4-6 week rows depending on where its first and last days
      // fall — the leading empty cells plus the day count, divided by 7 and
      // rounded up. Asserting a fixed 6 made this test pass only in months
      // that happened to need all six rows and fail in every other one.
      const leading = Array.from(grid.querySelectorAll(".cal-empty")).length;
      const dated = Array.from(grid.querySelectorAll(".cal-cell:not(.cal-empty)")).length;
      const expectedWeeks = Math.ceil((leading + dated) / 7);
      return {head: rows[0], weeks: rows.slice(1), dowContent: dow, expectedWeeks};
    });
    ok(g !== null, "the calendar grid is on screen to measure");
    if(g){
      // The labels get what they need and no more. 40px is generous for a 19px
      // strip and still nowhere near a week row.
      ok(g.head <= 40,
        "the day-of-week row is sized to its labels, not to a week",
        `header row is ${Math.round(g.head)}px for ${Math.round(g.dowContent)}px of label`);
      // And the week rows for whichever month is on screen split what is left
      // evenly between them — 4 to 6 of them, depending on the month.
      const lo = Math.min(...g.weeks), hi = Math.max(...g.weeks);
      ok(g.weeks.length === g.expectedWeeks, "the month's week rows share the rest of the grid",
        `${g.weeks.length} rows below the header, expected ${g.expectedWeeks} for this month`);
      ok(hi - lo <= 2, "every week row is the same height",
        `rows run ${Math.round(lo)}px to ${Math.round(hi)}px`);
      // The bug's signature was a header row indistinguishable from a week.
      ok(lo - g.head >= 40, "a week row is decisively taller than the header row",
        `header ${Math.round(g.head)}px vs week ${Math.round(lo)}px`);
    }
  }

  // ---------------------------------------------------------------- a real roster
  // Two people fit anywhere. Thirty is the case the paging used to exist for:
  // the roster arrives from the network after its tab is already on screen, and
  // its cards sit in a two-column grid beside a second list. Now that the panel
  // scrolls, every one of them has to actually be in it.
  {
    const ctx2 = await browser.newContext();
    const big = await ctx2.newPage();
    await big.setViewportSize({width: 1440, height: 900});
    await big.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_BIG_TEAM}));
    await big.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await big.waitForTimeout(1400);
    for(const tab of ["team", "admin"]){
      await big.evaluate(t => {
        if(t === "admin") document.getElementById("adminBtn").click();
        else document.querySelector('.tab-btn[data-tab="team"]').click();
      }, tab);
      await big.waitForTimeout(900);
      if(tab === "admin"){
        await big.evaluate(() =>
          document.querySelector('.console-nav-item[data-console-target="admin-people"]').click());
        await big.waitForTimeout(700);
      }
      const r = await big.evaluate(() => {
        const panel = document.querySelector(".tab-panel.active");
        const vis = sel => Array.from(document.querySelectorAll(sel)).filter(e => e.style.display !== "none").length;
        return {
          frame: document.getElementById("main").scrollHeight - document.getElementById("main").clientHeight,
          page: document.documentElement.scrollHeight - window.innerHeight,
          scrolls: ["auto","scroll"].includes(getComputedStyle(panel).overflowY),
          shownCards: vis("#teamList > *"),
          allCards: document.querySelectorAll("#teamList > *").length
        };
      });
      ok(r.frame <= 1, `${tab} with 30 people keeps the frame intact`, `main scrolls by ${r.frame}px`);
      ok(r.page <= 1, `${tab} with 30 people does not scroll the page`, `page over by ${r.page}px`);
      ok(r.scrolls, `${tab} with 30 people scrolls inside its panel`, "the panel does not scroll");
      if(tab === "team"){
        ok(r.shownCards === r.allCards && r.allCards >= 30,
          "every one of the 30 people is in the roster, none hidden",
          `${r.shownCards} shown of ${r.allCards} rendered`);
      }
    }
    await ctx2.close();
  }

  await browser.close();
  server.close();

  console.log(`  one-screen  pass ${pass}   fail ${fail}`);
  if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
})();
