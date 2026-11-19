// Regression tests for the rendering / accessibility / boot defects found in
// the 2026-08-15 audit. These measure the real page in a real browser, because
// several of the original bugs were invisible to any check that only asked
// "was the class toggled?" — the class WAS toggled; an inline style outranked it.
// Answers anything this suite does not route itself to *.supabase.co, so a
// direct run never reaches the live project (see ../no-network.js).
require("../no-network");
const { chromium } = require("playwright");
const vm = require("vm");
const { slice } = require("../extract");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8951;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png",
  ".css":"text/css", ".woff2":"font/woff2"};

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
  auth:{onAuthStateChange:(cb)=>{window.__authCb=cb; setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"tester@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"tester@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// A single day two minutes short of an 8h target — 478/480 = 99.58%. Rounded
// that reads as "100%", falsely claiming the target was fully met; floored
// it correctly reads "99%". workDays covers all seven days so the entry
// counts regardless of which weekday the suite happens to run on.
const STUB_NEAR_TARGET = `
const UID="22222222-2222-2222-2222-222222222222";
const D=new Date();
const TODAY=D.getFullYear()+"-"+String(D.getMonth()+1).padStart(2,"0")+"-"+String(D.getDate()).padStart(2,"0");
const ENTRIES=[{id:"e1",user_id:UID,date:TODAY,clock_in:"08:00",clock_out:"15:58",type:"regular",note:""}];
const PROFILE={id:UID,email:"near@example.com",full_name:"Near Target",role:"admin"};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
  if(t==="user_settings") return {data:{settings:{workDays:[0,1,2,3,4,5,6],targetMin:480}},error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"near@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"near@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// A week with a half-day leave in it, on a clock pinned to Thursday 20 August
// 2026 (Sun-Thu week, 08:00-16:00, so an 8h target and a 4h half day):
//   Sun 16  08:00-16:30  8h 30m of 8h  +30m
//   Mon 17  08:00-12:00  4h     of 4h   0     (half-day leave)
//   Tue 18  08:00-15:45  7h 45m of 8h  -15m
//   Wed 19  08:00-16:00  8h     of 8h   0
// 28h 15m worked against 28h owed: the bank is +15m. Over 3.5 days (the half
// day counts half) that is 8h 4m a day against 8h. Divided by four whole days
// it read 7h 4m against "7h" -- under the 8h target beside a positive bank.
const STUB_HALF_DAY = `
const UID="66666666-6666-6666-6666-666666666666";
const ENTRIES=[
  {id:"h1",user_id:UID,date:"2026-08-16",clock_in:"08:00",clock_out:"16:30",type:"regular",note:""},
  {id:"h2",user_id:UID,date:"2026-08-17",clock_in:"08:00",clock_out:"12:00",type:"halfleave",note:""},
  {id:"h3",user_id:UID,date:"2026-08-18",clock_in:"08:00",clock_out:"15:45",type:"regular",note:""},
  {id:"h4",user_id:UID,date:"2026-08-19",clock_in:"08:00",clock_out:"16:00",type:"regular",note:""}];
const PROFILE={id:UID,email:"half@example.com",full_name:"Half Day",role:"admin"};
const SETTINGS={workDays:[0,1,2,3,4],standardIn:"08:00",standardOut:"16:00",targetMin:480};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
  if(t==="user_settings") return k==="single"?{data:{settings:SETTINGS},error:null}:{data:[{user_id:UID,settings:SETTINGS}],error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"half@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"half@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// A week with a gap and two days whose hours do not count, on a clock pinned
// to Thursday 20 August 2026 (Sun-Thu, 08:00-16:00):
//   Fri 14  09:00-12:00  3h on a day off       -- not counted
//   Sun 16  08:00-16:00  8h of 8h
//   Mon 17  (no entry)                         -- not logged
//   Tue 18  08:00-16:00  8h remote (wfh)       -- not counted
//   Wed 19  08:00-16:00  8h of 8h
const STUB_GAPS = `
const UID="77777777-7777-7777-7777-777777777777";
const ENTRIES=[
  {id:"g0",user_id:UID,date:"2026-08-14",clock_in:"09:00",clock_out:"12:00",type:"regular",note:""},
  {id:"g1",user_id:UID,date:"2026-08-16",clock_in:"08:00",clock_out:"16:00",type:"regular",note:""},
  {id:"g3",user_id:UID,date:"2026-08-18",clock_in:"08:00",clock_out:"16:00",type:"wfh",note:""},
  {id:"g4",user_id:UID,date:"2026-08-19",clock_in:"08:00",clock_out:"16:00",type:"regular",note:""}];
const PROFILE={id:UID,email:"gaps@example.com",full_name:"Gap Week",role:"admin"};
const SETTINGS={workDays:[0,1,2,3,4],standardIn:"08:00",standardOut:"16:00",targetMin:480};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
  if(t==="user_settings") return k==="single"?{data:{settings:SETTINGS},error:null}:{data:[{user_id:UID,settings:SETTINGS}],error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"gaps@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"gaps@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// One open half-day shift, for the clock-out reminder (Sun-Thu, 08:00-16:00,
// so a half day owes 4h). Built per case: today's shift, or yesterday's.
const STUB_HALF_OPEN = (entry) => `
const UID="88888888-8888-8888-8888-888888888888";
const ENTRIES=[Object.assign({id:"o1",user_id:UID,type:"halfleave",clock_out:null,note:""}, ${JSON.stringify(entry)})];
const PROFILE={id:UID,email:"open@example.com",full_name:"Open Half",role:"admin"};
const SETTINGS={workDays:[0,1,2,3,4],standardIn:"08:00",standardOut:"16:00",targetMin:480};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
  if(t==="user_settings") return k==="single"?{data:{settings:SETTINGS},error:null}:{data:[{user_id:UID,settings:SETTINGS}],error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"open@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"open@example.com"}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;

// Two entries in the same year, one inside a 5h seasonal period (January),
// one at the base 8h target (June) — so the Yearly chart's dashed target
// reference has to actually change height across the year, not draw one
// flat number for every month.
const STUB_MIXED_TARGET = `
const UID="44444444-4444-4444-4444-444444444444";
const YR=new Date().getFullYear();
const ENTRIES=[
  {id:"e1",user_id:UID,date:YR+"-01-08",clock_in:"08:00",clock_out:"13:00",type:"regular",note:""},
  {id:"e2",user_id:UID,date:YR+"-06-08",clock_in:"08:00",clock_out:"16:00",type:"regular",note:""}
];
const PROFILE={id:UID,email:"mixed@example.com",full_name:"Mixed Target",role:"admin"};
const SETTINGS={workDays:[0,1,2,3,4,5,6],targetMin:480,
  periods:[{start:YR+"-01-01",end:YR+"-01-31",targetMin:300,name:"Short hours"}]};
function result(t,k){
  if(t==="entries") return {data:ENTRIES,error:null};
  if(t==="profiles") return k==="single"?{data:PROFILE,error:null}:{data:[PROFILE],error:null};
  if(t==="user_settings") return {data:{settings:SETTINGS},error:null};
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
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:UID,email:"mixed@example.com"}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}),signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:UID,email:"mixed@example.com"}},error:null}),
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

  // ---------------------------------------------------------------- reset password
  // The "Forgot password?" email link signs the browser into a short-lived
  // PASSWORD_RECOVERY session. The app used to have no handling for that
  // event at all — it fell into the same path as a normal sign-in and
  // silently dropped the visitor into the dashboard on their old password,
  // with no form anywhere to actually set a new one.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB}));
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(300); // let the stub's auto SIGNED_IN settle first

    await page.evaluate(() => window.__authCb("PASSWORD_RECOVERY",
      {user: {id: "11111111-1111-1111-1111-111111111111", email: "tester@example.com"}}));
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => ({
      reset: getComputedStyle(document.getElementById("resetPasswordForm")).display,
      signIn: getComputedStyle(document.getElementById("signInForm")).display,
      app: getComputedStyle(document.getElementById("appShell")).display,
    }));
    ok(shown.reset !== "none" && shown.signIn === "none" && shown.app === "none",
      "a PASSWORD_RECOVERY event shows the new-password form, not the dashboard", JSON.stringify(shown));

    await page.fill("#newPassword", "brandNewPassword1");
    await page.fill("#newPassword2", "brandNewPassword1");
    await page.click("#resetPasswordBtn");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => getComputedStyle(document.getElementById("appShell")).display);
    ok(after !== "none", "submitting the new password signs the visitor straight into the app", after);
    await ctx.close();
  }

  // ---------------------------------------------------------------- floored percentages
  // 478 of 480 target minutes is 99.58% — rounding that reads as "100%",
  // falsely claiming the day's target was fully met.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_NEAR_TARGET}));
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      heroLabel: document.getElementById("avgMeter").getAttribute("aria-label"),
    }));
    ok(!/100%/.test(s.heroLabel), "the hero progress label does not round 99.58% up to 100%",
      JSON.stringify(s));
    ok(/99%/.test(s.heroLabel), "the hero progress label floors 99.58% to 99%", JSON.stringify(s));
    await ctx.close();
  }

  // ---------------------------------------------------------------- half days in every average
  // A half-day leave counts as half a day wherever the app shows hours per
  // day, so no screen puts an average under target beside a positive bank:
  // Overview, Trends (weekly and monthly), Team (each row and the team tile)
  // and the printed report. Same four days everywhere: 8h 4m against 8h.
  {
    const ctx = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(2026, 7, 20, 10, 0, 0));
    await page.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_HALF_DAY}));
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(1200);

    const ov = await page.evaluate(() => ({
      avg: document.getElementById("monthAvg").textContent,
      detail: document.getElementById("monthAvgDetail").textContent,
      met: document.getElementById("avgMeter").classList.contains("is-met"),
      label: document.getElementById("avgMeter").getAttribute("aria-label"),
      bank: document.getElementById("otBank").textContent
    }));
    ok(ov.bank === "+15m", "half day: the bank is +15m", JSON.stringify(ov.bank));
    ok(ov.avg === "8h 4m", "half day: Overview's average counts the half day as half (8h 4m, not 7h 4m)", JSON.stringify(ov.avg));
    ok(/^Target 8h · 3\.5 days$/.test(ov.detail),
      "half day: the target stays 8h and the four days count as 3.5 (the half day is half)", JSON.stringify(ov));
    ok(ov.met && /^100% of the 8h daily target$/.test(ov.label),
      "half day: a positive bank shows the average bar as met", JSON.stringify(ov));

    const trends = await page.evaluate(async () => {
      const col = (id, label) => Array.from(document.querySelectorAll("#" + id + " td[data-label='" + label + "']"))
        .map(td => td.textContent.replace(label, "").trim()).filter(t => t !== "—");
      const cells = id => ({avg: col(id, "Avg / Day"), days: col(id, "Days"), total: col(id, "Total")});
      document.querySelector('.tab-btn[data-tab="trends"]').click();
      document.querySelector('.sub-tab-btn[data-subtab="weekly"]').click();
      await new Promise(r => setTimeout(r, 300));
      const weekly = cells("weeklyBody");
      document.querySelector('.sub-tab-btn[data-subtab="monthly"]').click();
      await new Promise(r => setTimeout(r, 300));
      return {weekly, monthly: cells("monthlyBody")};
    });
    ok(trends.weekly.avg.length === 1 && trends.weekly.avg[0] === "8h 4m",
      "half day: the Weekly table's Avg / Day is 8h 4m", JSON.stringify(trends));
    ok(trends.monthly.avg.length === 1 && trends.monthly.avg[0] === "8h 4m",
      "half day: the Monthly table's Avg / Day is 8h 4m", JSON.stringify(trends));
    // Days x Avg / Day = Total, in the row itself: 3.5 x 8h 4m = 28h 15m.
    ok(trends.weekly.days[0] === "3.5" && trends.weekly.total[0] === "28h 15m" &&
       trends.monthly.days[0] === "3.5" && trends.monthly.total[0] === "28h 15m",
      "half day: both Trends tables count the days as 3.5, so Days x Avg / Day is the Total", JSON.stringify(trends));

    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="team"]').click());
    await page.waitForTimeout(800);
    const team = await page.evaluate(() => {
      const tile = Array.from(document.querySelectorAll("#teamSummary .stat-card"))
        .find(c => /Avg Hours \/ Day/.test(c.textContent));
      const daysTile = Array.from(document.querySelectorAll("#teamSummary .stat-card"))
        .find(c => /Days Logged/.test(c.textContent));
      const card = document.querySelector("#teamList .team-card");
      return {
        tileValue: tile ? tile.querySelector(".stat-value").textContent : null,
        tileDetail: tile ? tile.querySelector(".stat-detail").textContent : null,
        daysTile: daysTile ? daysTile.querySelector(".stat-value").textContent : null,
        rowDays: card ? card.querySelector(".f-days .value").textContent : null,
        rowCount: card ? card.querySelector(".team-daycount").textContent : null,
        rows: document.getElementById("teamList").textContent
      };
    });
    ok(team.tileValue === "8h 4m", "half day: Team's Avg Hours / Day tile is 8h 4m", JSON.stringify(team.tileValue));
    ok(team.tileDetail === "Of 8h target", "half day: Team's tile measures against 8h", JSON.stringify(team.tileDetail));
    ok(/8h 4m\s*\/day/.test(team.rows) && !/7h 4m/.test(team.rows),
      "half day: the person's Team row reads 8h 4m a day", team.rows.slice(0, 300));
    ok(team.daysTile === "3.5" && team.rowDays === "3.5" && team.rowCount === "3.5 days",
      "half day: Team's Days Logged tile and the person's row count 3.5 days", JSON.stringify(team));

    const sheet = await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
      const v = label => {
        const row = Array.from(document.querySelectorAll("#printArea .p-summary div"))
          .find(d => d.querySelector(".k") && d.querySelector(".k").textContent === label);
        return row ? row.querySelector(".v").textContent : null;
      };
      return {avg: v("Average / Day"), days: v("Days Logged")};
    });
    ok(sheet.avg === "8h 4m", "half day: the printed report's Average / Day is 8h 4m", JSON.stringify(sheet));
    ok(sheet.days === "3.5", "half day: the printed report counts 3.5 days", JSON.stringify(sheet));

    const cal = await page.evaluate(async () => {
      window.dispatchEvent(new Event("afterprint"));
      document.querySelector('.tab-btn[data-tab="calendar"]').click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById("calSummary").textContent;
    });
    ok(/^3\.5 workdays logged/.test(cal), "half day: the Calendar's month line counts 3.5 workdays", cal);
    ok(errors.length === 0, "half day: no script errors", errors.join(" | "));
    await ctx.close();
  }

  // ---------------------------------------------------------------- days the figures leave out
  // A workday with no entry, and hours that do not count, must be said where
  // the figures that leave them out are shown -- not only on Shortfall.
  {
    const ctx = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(2026, 7, 20, 10, 0, 0));
    await page.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_GAPS}));
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(1200);

    const ov = await page.evaluate(() => ({
      avg: document.getElementById("monthAvg").textContent,
      detail: document.getElementById("monthAvgDetail").textContent,
      bank: document.getElementById("otBank").textContent
    }));
    ok(ov.avg === "8h" && ov.bank === "+0h" && ov.detail === "Target 8h · 2 days · 1 not logged",
      "gaps: Overview's average says a workday went unlogged (Mon 17)", JSON.stringify(ov));

    const names = await page.evaluate(async () => {
      document.querySelector('.tab-btn[data-tab="trends"]').click();
      document.querySelector('.sub-tab-btn[data-subtab="shortfall"]').click();
      await new Promise(r => setTimeout(r, 300));
      const shortfall = document.getElementById("pMetRate").closest(".stat-card").querySelector(".stat-label").textContent;
      const rate = document.getElementById("pMetRate").textContent;
      document.querySelector('.tab-btn[data-tab="team"]').click();
      await new Promise(r => setTimeout(r, 800));
      const tile = Array.from(document.querySelectorAll("#teamSummary .stat-card"))
        .find(c => /Hours Met/.test(c.textContent));
      return {shortfall, rate,
        team: tile ? tile.querySelector(".stat-label").textContent : null,
        teamRate: tile ? tile.querySelector(".stat-value").textContent : null};
    });
    ok(names.rate === "66%" && names.teamRate === "100%",
      "gaps: Shortfall counts the unlogged day as short (66%), Team does not (100%)", JSON.stringify(names));
    ok(names.shortfall === "Workday Hours Met" && names.team === "Target Hours Met",
      "gaps: so the two figures carry different names", JSON.stringify(names));

    const grid = await page.evaluate(async () => {
      document.querySelector('.tab-btn[data-tab="calendar"]').click();
      await new Promise(r => setTimeout(r, 400));
      const cell = d => {
        const el = document.querySelector('.cal-cell[data-date="' + d + '"]');
        const val = el && el.querySelector(".cal-val");
        const note = el && el.querySelector(".cal-short");
        return {cls: el ? el.className : null,
          val: val ? val.querySelector(".cal-val-full").textContent : null,
          valMuted: !!val && val.classList.contains("is-uncounted"),
          note: note ? note.textContent : null,
          label: el ? el.getAttribute("aria-label") : null};
      };
      return {fri: cell("2026-08-14"), sun: cell("2026-08-16"), tue: cell("2026-08-18"),
        summary: document.getElementById("calSummary").textContent};
    });
    ok(grid.tue.val === "8h" && grid.tue.valMuted && grid.tue.note === "Remote" && /hours not counted/.test(grid.tue.label),
      "gaps: the remote day's 8h is muted, named, and read out as not counted", JSON.stringify(grid.tue));
    ok(grid.fri.val === "3h" && grid.fri.valMuted && grid.fri.note === "Day off",
      "gaps: the Friday's 3h is muted and marked as a day off", JSON.stringify(grid.fri));
    ok(grid.sun.val === "8h" && !grid.sun.valMuted && /met target/.test(grid.sun.label),
      "gaps: a counted day is unchanged", JSON.stringify(grid.sun));
    ok(/2 workdays logged/.test(grid.summary) && /16h worked/.test(grid.summary) &&
       /11h on remote days and days off not counted/.test(grid.summary),
      "gaps: the month line says the 11h it leaves out, and on what", grid.summary);

    const log = await page.evaluate(async () => {
      document.querySelector('.tab-btn[data-tab="log"]').click();
      await new Promise(r => setTimeout(r, 400));
      const status = id => {
        const btn = document.querySelector('#logBody button[data-edit="' + id + '"]');
        const td = btn && btn.closest("tr").querySelector("td.c-status");
        return td ? td.textContent.replace("Status", "").trim() : null;
      };
      return {fri: status("g0"), sun: status("g1"), tue: status("g3")};
    });
    ok(log.fri === "Not counted" && log.tue === "Not counted" && log.sun === "On target",
      "gaps: the Log says Not counted for those two days, On target for a counted one", JSON.stringify(log));
    ok(errors.length === 0, "gaps: no script errors", errors.join(" | "));
    await ctx.close();
  }

  // ---------------------------------------------------------------- a half day's clock-out reminder
  // A half-day leave owes 4 of the 8 hours, and Overview says "Leave at" four
  // hours after clock-in. The reminder used the full day's 8h 30m, and its
  // one-tap Clock Out wrote the 4 PM standard end -- a full day on a half day.
  {
    const reminderAt = async (entry, when) => {
      const ctx = await browser.newContext({viewport: {width: 1440, height: 900}});
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.clock.setFixedTime(when);
      await page.route("**/vendor/supabase-js.min.js",
        r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_HALF_OPEN(entry)}));
      await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const btn = document.querySelector("#reminderActions button");
        return {
          shown: document.getElementById("reminderBanner").classList.contains("show"),
          title: document.getElementById("reminderTitle").textContent,
          button: btn ? btn.textContent : null,
          leaveAt: (document.getElementById("todayLineValue") || {}).textContent || null
        };
      });
      await ctx.close();
      return Object.assign(r, {errors});
    };
    const today = {date: "2026-08-20", clock_in: "08:00"};
    const before = await reminderAt(today, new Date(2026, 7, 20, 12, 29, 0));
    ok(!before.shown && before.leaveAt === "12:00 PM",
      "half day: Leave at 12:00 PM, and no reminder at 12:29", JSON.stringify(before));
    const after = await reminderAt(today, new Date(2026, 7, 20, 12, 31, 0));
    ok(after.shown && after.title === "Still clocked in",
      "half day: reminded 30 minutes after its 4 hours, not its 8", JSON.stringify(after));
    const past = await reminderAt({date: "2026-08-19", clock_in: "07:44"}, new Date(2026, 7, 20, 10, 0, 0));
    ok(past.shown && /never clocked out/.test(past.title) && past.button === "Clock Out at 11:44 AM",
      "half day left open yesterday: one tap clocks out when its 4 hours were done, not at 4 PM", JSON.stringify(past));
    ok(before.errors.length + after.errors.length + past.errors.length === 0, "half-day reminder: no script errors",
      before.errors.concat(after.errors, past.errors).join(" | "));
  }

  // ---------------------------------------------------------------- chart target steps
  // A January logged against a 5h seasonal period and a June logged against
  // the base 8h target must draw two different heights for the dashed target
  // reference, not one flat line for the whole year. Measured on the Monthly
  // chart since the Yearly view was removed; it plots the same twelve months
  // of one year that the Yearly chart did.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("**/vendor/supabase-js.min.js",
      r => r.fulfill({status: 200, contentType: "text/javascript", body: STUB_MIXED_TARGET}));
    await page.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
    await page.waitForTimeout(1000);
    const ys = await page.evaluate(() => {
      document.querySelector('.tab-btn[data-tab="trends"]').click();
      document.querySelector('.sub-tab-btn[data-subtab="monthly"]').click();
      const svg = document.getElementById("monthlyChart").querySelector("svg");
      return [...svg.querySelectorAll('line[stroke-dasharray]')].map(l => l.getAttribute("y1"));
    });
    const distinct = new Set(ys);
    ok(ys.length >= 2 && distinct.size >= 2,
      "the Monthly chart's target reference steps between the 5h period and the 8h base",
      JSON.stringify(ys));
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

  // ---------------------------------------------------------------- iOS date/time sizing
  // Reported from a real iPhone: the Standard Start / Standard End fields in
  // Schedule Settings ran past the right edge of their card while every other
  // field sat inside it. iOS Safari lays a native date/time control out from its
  // own shadow DOM and ignores box-sizing on it, so width:100% resolved to 100%
  // plus 24px of padding. Chromium sizes them correctly, so the overflow itself
  // cannot be reproduced here — what CAN be checked is that the rules which
  // disable that behaviour are present and that nothing overflows once a
  // pessimistic intrinsic width is forced on the control.
  {
    const css = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const hasReset = /input\[type="date"\], input\[type="time"\]\{[^}]*appearance:none/.test(css);
    const hasClamp = /input\[type="date"\], input\[type="time"\]\{[^}]*max-width:100%/.test(css);
    ok(hasReset && hasClamp,
      "date/time controls opt out of the UA box model that overflows on iOS",
      JSON.stringify({hasReset, hasClamp}));
  }
  {
    const worst = await page.evaluate(() => {
      // Settings is a real .tab-panel now, inside #tabContentCard like every
      // other non-Overview tab — .active alone isn't enough to make its date/
      // time fields measurable if that shared ancestor is still [hidden].
      const settingsPanel = document.getElementById("tab-settings");
      if(settingsPanel) settingsPanel.classList.add("active");
      const tabContentCard = document.getElementById("tabContentCard");
      if(tabContentCard) tabContentCard.hidden = false;
      document.querySelectorAll(".accordion-section").forEach(e => e.classList.add("open"));
      // Settings and Admin are consoles now — one section shows at a time. The
      // fields in the six that are hidden still have to survive a narrow
      // screen, so every section is made measurable at once here.
      document.querySelectorAll(".console-section").forEach(e => e.classList.add("active"));
      // Model what iOS does and Chromium will not: resolve the control to a
      // width far larger than its cell. Forced as `width`, not `min-width` —
      // min-width beats max-width in the cascade, so pinning it that way would
      // model something no clamp could ever fix and fail for free.
      const st = document.createElement("style");
      st.textContent = 'input[type="time"]{width:220px !important;} input[type="date"]{width:240px !important;}';
      document.head.appendChild(st);
      let over = 0, who = "";
      document.querySelectorAll('input[type="date"], input[type="time"]').forEach(i => {
        if(!i.getClientRects().length) return;
        const p = i.parentElement, cs = getComputedStyle(p);
        const inner = p.getBoundingClientRect().width -
          (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        const diff = Math.round(i.getBoundingClientRect().width - inner);
        if(diff > over){ over = diff; who = i.id || i.type; }
      });
      st.remove();
      return {over, who, page: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)};
    });
    ok(worst.over <= 1 && worst.page === 0,
      "no date or time field can outgrow its cell, even refusing to shrink", JSON.stringify(worst));
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
  //
  // This used to also require the label to be visually rendered
  // (position !== "absolute"), which was true of the stacked-card layout that
  // printed every column as its own labelled line. The phone layout is one
  // row per record now (.mobile-rows), where the row's shape tells a sighted
  // reader what a time or an hours figure is and the printed label is the
  // redundancy. What must not change is the half that was always the point:
  // the label is a real element carrying real text, and it stays IN the
  // accessibility tree. So the check is the accessible fact directly —
  // present, non-empty, not display:none, not aria-hidden — which still fails
  // for the ::before content this test exists to prevent, and no longer fails
  // for a visually-hidden label that screen readers announce perfectly well.
  {
    await page.setViewportSize({width: 390, height: 844});
    const r = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("#logBody td")].slice(0, 4);
      return cells.map(td => {
        const lab = td.querySelector(".cell-label");
        if(!lab) return {has: false, text: "", announced: false};
        const cs = getComputedStyle(lab);
        return {
          has: true,
          text: (lab.textContent || "").trim(),
          announced: cs.display !== "none" && cs.visibility !== "hidden" &&
            !lab.closest("[aria-hidden='true']")
        };
      });
    });
    ok(r.length > 0 && r.every(c => c.has && c.text && c.announced),
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

  {
    // Every day type the picker offers must have a TYPE_LABELS entry. This has
    // failed once already: an unrecognised value rendered the literal string
    // "undefined" in the log, the calendar tooltip, the print report and the
    // audit detail, which is why typeLabel() has a fallback at all. Renaming a
    // label on one side and not the other is the way back into that state.
    const labels = (() => {
      // The shipping TYPE_LABELS object, extracted rather than retyped — a copy
      // here could not see a rename, which is the whole thing being guarded.
      const sandbox = {};
      vm.createContext(sandbox);
      vm.runInContext(slice("var TYPE_LABELS = {", "// An entry's type"), sandbox);
      return sandbox.TYPE_LABELS;
    })();
    const opts = await page.evaluate(() =>
      [...document.querySelectorAll('#fType option')].map(o => ({v: o.value, text: o.textContent.trim()})));
    const orphans = opts.filter(o => !labels[o.v]);
    const mismatched = opts.filter(o => labels[o.v] && labels[o.v] !== o.text);
    ok(opts.length >= 9 && orphans.length === 0 && mismatched.length === 0,
      "every day type the picker offers has a matching TYPE_LABELS entry",
      `${opts.length} options; orphans ${JSON.stringify(orphans)}; mismatched ${JSON.stringify(mismatched)}`);
  }
  {
    // The day's hours are its Start to its End. A separate hours/minutes
    // target sat beside them and could only ever disagree with them (worked
    // time is clock-out minus clock-in, nothing taken off), so it is gone from
    // the Schedule, the seasonal cards and the organisation defaults, and the
    // line under Start/End says what they add up to.
    const r = await page.evaluate(() => ({
      gone: ["sTargetH","sTargetM","dTargetH","dTargetM"].filter(id => document.getElementById(id)),
      periodTargets: document.querySelectorAll('[data-p="th"], [data-p="tm"]').length,
      note: (document.getElementById("sHoursNote") || {}).textContent,
      label: ((document.querySelector("#sTargetCard .target-card-label") || {}).textContent || "").trim(),
      labelled: ["sIn","sOut"].every(id => {
        const lab = document.querySelector(`label[for="${id}"]`);
        return !!(lab && lab.textContent.trim());
      })
    }));
    ok(r.gone.length === 0 && r.periodTargets === 0 && r.labelled && r.note === "8h" && r.label === "Your daily target",
      "no separate daily-target field: Start and End are labelled and the card under them states \"Your daily target 8h\"",
      JSON.stringify(r));
  }
  {
    // The 10-character rule is enforced by minlength AND by the submit handler,
    // but used to be stated nowhere: you discovered it by being rejected.
    const r = await page.evaluate(() => ["regPassword","newPassword"].map(id => {
      const el = document.getElementById(id);
      const hint = el && document.getElementById(el.getAttribute("aria-describedby") || "");
      return {id, min: el && el.getAttribute("minlength"),
              hint: hint && hint.textContent.trim()};
    }));
    ok(r.every(x => x.min === "10" && x.hint && /10/.test(x.hint)),
      "both password fields state their length rule before it is enforced",
      JSON.stringify(r));
  }

  await browser.close();
  server.close();

  console.log(`  audit-dom    pass ${pass}   fail ${fail}`);
  if(fail){ console.log(failures.map(f => "    x " + f).join("\n")); process.exit(1); }
})();
