// Regression tests for the rendering / accessibility / boot defects found in
// the 2026-08-15 audit. These measure the real page in a real browser, because
// several of the original bugs were invisible to any check that only asked
// "was the class toggled?" — the class WAS toggled; an inline style outranked it.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8951;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png"};

// Stubs the vendored Supabase module with one that returns realistic rows, so
// the app renders a populated dashboard through its own code paths.
const STUB = `
const UID="11111111-1111-1111-1111-111111111111";
const ENTRIES=(()=>{const out=[];const d=new Date();
  for(let i=0;i<40;i++){
    const dt=new Date(d.getFullYear(),d.getMonth(),d.getDate()-i);
    if(dt.getDay()===5||dt.getDay()===6) continue;
    const iso=dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
    out.push({id:"e"+i,user_id:UID,date:iso,clock_in:(i%7===0)?"09:05":"08:00",
      clock_out:(i%11===0)?null:(i%5===0?"17:10":"16:00"),
      type:(i%13===0)?"wfh":(i%17===0?"leave":"regular"),note:(i%9===0)?"Client visit":""});
  }return out;})();
const PROFILE={id:UID,email:"tester@example.com",full_name:"Test User",role:"admin"};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"tester@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

function contrast(a, b){
  const lum = c => { const s = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2]; };
  const x = lum(a), y = lum(b);
  return (Math.max(x,y) + 0.05) / (Math.min(x,y) + 0.05);
}
const rgb = s => s.match(/\d+(\.\d+)?/g).slice(0,3).map(Number);

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

  // ---------------------------------------------------------------- C-2
  // The app must not depend on a third-party CDN, and a boot failure must be
  // reported instead of leaving a perfect-looking form that ignores you.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("**esm.sh**", r => r.abort());
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      warn: getComputedStyle(document.getElementById("authConfigWarning")).display,
      btn: document.getElementById("signInBtn").textContent.trim(),
    }));
    ok(s.warn === "none" && s.btn === "Sign In",
      "C-2 the app boots with the old CDN fully blocked", JSON.stringify(s));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("**/vendor/**", r => r.abort());
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      warn: getComputedStyle(document.getElementById("authConfigWarning")).display,
      disabled: document.getElementById("signInBtn").disabled,
    }));
    ok(s.warn !== "none" && s.disabled === true,
      "C-2 an unreachable dependency is reported, not silent", JSON.stringify(s));
    await ctx.close();
  }

  // ---------------------------------------------------------------- populated app
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await ctx.newPage();
  await page.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB}));
  const errors = [];
  page.on("pageerror", e => errors.push(String(e).split("\n")[0]));
  await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await page.waitForTimeout(1200);

  ok(errors.length === 0, "app boots with no uncaught errors", errors.join(" | "));
  {
    const rows = await page.evaluate(() => document.querySelectorAll("#logBody tr").length);
    ok(rows > 0, "app renders a populated log end to end", `log rows = ${rows}`);
  }

  // ---------------------------------------------------------------- H-1
  // The banner carried an inline style="display:none" that outranked the .show
  // class the JS toggles, so this warning had never rendered once.
  {
    const r = await page.evaluate(() => {
      const el = document.getElementById("viewingOtherBanner");
      el.classList.add("show");
      return {d: getComputedStyle(el).display, h: el.getBoundingClientRect().height};
    });
    ok(r.d === "flex" && r.h > 0,
      "H-1 the 'viewing another employee' warning actually renders", JSON.stringify(r));
  }

  // ---------------------------------------------------------------- H-6
  // .show only set transform/opacity; the base rule's display:none stood, so the
  // whole sticky-clock feature was unreachable at every viewport width.
  {
    const r = await page.evaluate(() => {
      const el = document.getElementById("stickyClock");
      el.classList.add("show");
      return {d: getComputedStyle(el).display, h: el.getBoundingClientRect().height};
    });
    ok(r.d === "flex" && r.h > 0, "H-6 the sticky clock bar can be shown", JSON.stringify(r));
  }

  // ---------------------------------------------------------------- H-11
  {
    const samples = await page.evaluate(() => {
      const sels = [".stat-detail", ".foot-note", ".copyright", ".settings-hint",
                    ".filter-count", ".bn-clock-label", ".team-email", ".admin-user-meta"];
      return sels.map(sel => {
        const el = document.querySelector(sel);
        if(!el) return null;
        const cs = getComputedStyle(el);
        let e = el, bg = cs.backgroundColor;
        while(e && (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")){
          e = e.parentElement; if(!e) break; bg = getComputedStyle(e).backgroundColor;
        }
        return {sel, color: cs.color, bg, opacity: cs.opacity};
      }).filter(Boolean);
    });
    let worst = 99, worstSel = "";
    for(const s of samples){
      let fg = rgb(s.color); const bg = rgb(s.bg);
      if(parseFloat(s.opacity) < 1){
        const o = parseFloat(s.opacity);
        fg = fg.map((v, i) => v*o + bg[i]*(1-o));
      }
      const c = contrast(fg, bg);
      if(c < worst){ worst = c; worstSel = s.sel; }
    }
    ok(worst >= 4.5, "H-11 secondary text meets the 4.5:1 WCAG AA floor",
      `worst = ${worst.toFixed(2)}:1 at ${worstSel}`);
  }

  // ---------------------------------------------------------------- M-7 / M-8 / M-9
  {
    const t = await page.evaluate(() => {
      const b = document.querySelector(".tab-btn"), p = document.querySelector(".tab-panel");
      return {role: b.getAttribute("role"), sel: b.getAttribute("aria-selected"),
              ctrl: b.getAttribute("aria-controls"), list: document.getElementById("tabsBar").getAttribute("role"),
              panel: p.getAttribute("role")};
    });
    ok(t.role === "tab" && t.sel !== null && t.list === "tablist" && t.panel === "tabpanel" && !!t.ctrl,
      "M-7 the tab widget exposes role and selected state", JSON.stringify(t));
  }
  {
    const charts = await page.evaluate(() => {
      document.querySelector('.tab-btn[data-tab="trends"]').click();
      return [...document.querySelectorAll(".chart-holder svg")].map(s => ({
        labelledby: !!s.getAttribute("aria-labelledby"),
        title: !!s.querySelector(":scope > title"),
        desc: !!s.querySelector(":scope > desc"),
      }));
    });
    ok(charts.length > 0 && charts.every(c => c.labelledby && c.title && c.desc),
      "M-8 every chart has an accessible name and description",
      `${charts.length} charts inspected`);
  }
  {
    const labels = await page.evaluate(() => {
      document.querySelector('.tab-btn[data-tab="log"]').click();
      return [...document.querySelectorAll("#logBody .row-actions button")]
        .slice(0, 2).map(b => b.getAttribute("aria-label"));
    });
    ok(labels.length > 0 && labels.every(l => l && /\d/.test(l)),
      "M-9 row Edit/Delete buttons name the day they act on", JSON.stringify(labels));
  }

  // ---------------------------------------------------------------- H-10
  // Below 700px the table becomes display:block, which strips the table role.
  // The column name must therefore be a real element, not ::before content,
  // which assistive technology does not announce.
  {
    await page.setViewportSize({width: 390, height: 844});
    const r = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("#logBody td")].slice(0, 4);
      return cells.map(td => {
        const lab = td.querySelector(".cell-label");
        return {has: !!lab, shown: lab ? getComputedStyle(lab).position !== "absolute" : false};
      });
    });
    ok(r.length > 0 && r.every(c => c.has && c.shown),
      "H-10 mobile table cells carry a real, announceable column label", JSON.stringify(r));
    await page.setViewportSize({width: 1280, height: 900});
  }

  // ---------------------------------------------------------------- M-23 / L-16
  {
    const csp = await page.evaluate(() => {
      const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return m ? m.getAttribute("content").replace(/\s+/g, " ") : null;
    });
    ok(!!csp && /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
      "M-23 a CSP is present and script-src excludes unsafe-inline",
      csp ? csp.slice(0, 90) : "no CSP");
  }
  {
    const r = await page.evaluate(() => ["fNote","bulkApplyNote","setAnnouncement","searchInput","regName"]
      .map(id => document.getElementById(id) && document.getElementById(id).getAttribute("maxlength")));
    ok(r.every(Boolean), "L-16 free-text inputs are length-bounded", JSON.stringify(r));
  }

  await browser.close();
  server.close();

  console.log(`  audit-dom    pass ${pass}   fail ${fail}`);
  if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
})();
