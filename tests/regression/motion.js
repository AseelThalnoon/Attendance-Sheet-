// Motion that shows what just happened (2026-11-23, owner: "Do all"): a saved
// day lit where it landed, a deleted row leaving and Undo bringing it back,
// a month stepped from the side of the arrow pressed, segmented controls
// with one sliding highlight, Recap's charts drawing in, and a palette
// change crossfading. And the rules they keep: only on the person's own
// action -- a sync draws nothing -- and nothing at all under reduced motion.
//
// Every Web Animations call and View Transition the page starts is recorded
// by a wrapper installed before the app loads, so the checks read what the
// app asked for rather than racing the animations themselves.
require("../no-network");
const { boot, settle, goTab, PHONE, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const me = D.profile(1, { role: "admin", full_name: "Motion Tester" });
const now = new Date();
const prevMonth = ds(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);
// Every Sun-Thu workday of last month and this one to yesterday, 08:00-16:30.
const rows = [];
for(let d = new Date(now.getFullYear(), now.getMonth() - 1, 1); ds(d) < ds(now); d.setDate(d.getDate() + 1)){
  if(d.getDay() === 5 || d.getDay() === 6) continue;
  // String ids, as the real record has: the Edit button looks a row up by
  // its data attribute's text.
  rows.push({ id: "e" + (2000 + rows.length), user_id: me.id, date: ds(d), type: "regular", clock_in: "08:00:00", clock_out: "16:30:00",
    note: "", created_at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 1).toISOString(), updated_at: "2026-01-01T00:00:00Z" });
}
const seed = { profiles: [me], entries: rows, user_settings: [{ user_id: me.id, settings: D.SETTINGS }] };

// Records what the app asks for: element.animate() calls and View Transitions.
const record = ({ page }) => page.addInitScript(() => {
  window.__anims = [];
  const orig = Element.prototype.animate;
  Element.prototype.animate = function(frames, opts){
    window.__anims.push({ id: this.id || this.getAttribute("data-entry-id") || "", cls: String(this.className || ""), frames: JSON.stringify(frames) });
    return orig.call(this, frames, opts);
  };
  window.__vt = 0;
  const vt = document.startViewTransition;
  document.startViewTransition = function(cb){
    window.__vt++;
    if(vt) return vt.call(document, cb);
    cb(); return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
  };
});
const anims = (p, since) => p.evaluate(n => window.__anims.slice(n), since || 0);
const animCount = p => p.evaluate(() => window.__anims.length);
const toastAction = p => p.evaluate(() => { const a = [...document.querySelectorAll(".toast-action")].pop(); if(a) a.click(); return !!a; });
// Where a tray's pill sits against its active button.
const pillFit = (p, sel) => p.evaluate(s => {
  const tray = document.querySelector(s);
  const pill = tray && tray.querySelector(":scope > .seg-pill");
  const on = tray && tray.querySelector(":scope > .active, :scope > [aria-checked='true'], :scope > [aria-pressed='true']");
  if(!pill || !on) return null;
  const a = pill.getBoundingClientRect(), b = on.getBoundingClientRect();
  return { dx: Math.round(Math.abs(a.left - b.left)), dw: Math.round(Math.abs(a.width - b.width)), bg: getComputedStyle(on).backgroundColor };
}, sel);
const openRow = (p, id, phone) => p.evaluate(([i, ph]) => {
  const row = document.querySelector(`#logBody tr[data-entry-id="${i}"]`);
  if(ph) row.click(); else row.querySelector("button[data-edit]").click();
}, [id, phone]);
const pickMonth = (p, mk) => p.evaluate(k => {
  const s = document.getElementById("logPeriodSelect");
  s.value = k; s.dispatchEvent(new Event("change", { bubbles: true }));
}, mk);

(async () => {
  for(const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]){
    const phone = label === "phone";
    const h = await boot({ viewport, meId: me.id, seed, beforeLoad: record });
    const p = h.page;
    try {
      await settle(p, 700);

      // ---- Segmented controls: one sliding highlight each ------------------
      const trays = await p.evaluate(() => [".recap-mode", ".sub-tabs", "#langSeg", "#modeSeg"].map(s => {
        const t = document.querySelector(s);
        return s + ":" + (!!t && t.classList.contains("has-pill") && !!t.querySelector(":scope > .seg-pill"));
      }));
      ok(trays.every(t => /:true$/.test(t)), `${label}: every segmented control has its sliding highlight`, trays.join(" "));

      // ---- Recap: draws in when opened, steps from the arrow's side ---------
      await goTab(p, "recap");
      await settle(p, 150);
      ok(await p.evaluate(() => document.getElementById("recapBody").classList.contains("is-entering")),
        `${label}: opening Recap draws its cards and charts in`);
      await settle(p, 1300);
      ok(!(await p.evaluate(() => document.getElementById("recapBody").classList.contains("is-entering"))),
        `${label}: and stops, so a later repaint draws nothing twice`);
      let n = await animCount(p);
      await p.click("#recapPrevBtn");
      await settle(p, 200);
      const step = (await anims(p, n)).filter(a => a.id === "recapBody");
      ok(step.length === 1 && /translateX\(-12px\)/.test(step[0].frames), `${label}: the previous month comes in from the left`, JSON.stringify(step));
      await p.click('[data-recap-mode="year"]');
      await settle(p, 450);
      const yr = await pillFit(p, ".recap-mode");
      ok(yr && yr.dx <= 1 && yr.dw <= 1, `${label}: Month / Year's highlight slides to Year`, JSON.stringify(yr));
      ok(yr && /rgba\(0, 0, 0, 0\)|transparent/.test(yr.bg), `${label}: the button's own fill steps aside for it`, yr && yr.bg);
      await p.click('[data-recap-mode="month"]');
      await settle(p, 1300);

      // A sync is not the person's action: nothing draws in.
      await p.evaluate(() => {
        window.__entering = 0;
        new MutationObserver(() => { if(document.getElementById("recapBody").classList.contains("is-entering")) window.__entering++; })
          .observe(document.getElementById("recapBody"), { attributes: true, attributeFilter: ["class"] });
        document.getElementById("refreshBtn").click();
      });
      await settle(p, 1200);
      ok(await p.evaluate(() => window.__entering === 0), `${label}: a refresh repaints Recap without drawing it in again`);

      // ---- Trends: the sub-tabs' highlight follows the choice ---------------
      await goTab(p, "trends");
      await p.evaluate(() => { const b = [...document.querySelectorAll(".sub-tabs .sub-tab-btn")].find(x => !x.classList.contains("active")); if(b) b.click(); });
      await settle(p, 450);
      const st = await pillFit(p, ".sub-tabs");
      ok(st && st.dx <= 1 && st.dw <= 1, `${label}: Trends' highlight slides to the chosen view`, JSON.stringify(st));

      // ---- Log: a month picked comes in from its side ----------------------
      await goTab(p, "log");
      n = await animCount(p);
      await pickMonth(p, prevMonth);
      await settle(p, 300);
      const logStep = (await anims(p, n)).filter(a => a.id === "tab-log");
      ok(logStep.length === 1 && /translateX\(-12px\)/.test(logStep[0].frames), `${label}: an earlier month in the Log comes in from the left`, JSON.stringify(logStep));

      // ---- Save: the day is lit where it landed -----------------------------
      const target = rows.find(r => r.date.slice(0, 7) === prevMonth && r.date.slice(8) >= "10");
      await openRow(p, target.id, phone);
      await settle(p, 400);
      await p.evaluate(() => { document.getElementById("fNote").value = "moved"; document.getElementById("submitBtn").click(); });
      await settle(p, 900);
      const lit = await p.evaluate(id => {
        const r = document.querySelector(`#logBody tr[data-entry-id="${id}"]`);
        if(!r) return null;
        const box = r.getBoundingClientRect();
        const anim = getComputedStyle(r).animationName + "/" + (r.cells[0] ? getComputedStyle(r.cells[0]).animationName : "");
        // In view means clear of the phone's bottom bar too (html's
        // scroll-padding-bottom says how much of the screen it covers).
        const covered = parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
        return { cls: r.className, anim, inView: box.top >= 0 && box.bottom <= innerHeight - covered + 1 };
      }, target.id);
      ok(lit && /\bis-flash\b/.test(lit.cls) && /rowFlash/.test(lit.anim) && lit.inView, `${label}: a saved day is brought into view and lit`, JSON.stringify(lit));

      // ---- Delete: the row leaves, the rest close over it; Undo returns it ---
      const victim = rows.find(r => r.date.slice(0, 7) === prevMonth && r.date.slice(8) >= "15" && r.id !== target.id);
      await openRow(p, victim.id, phone);
      await settle(p, 400);
      n = await animCount(p);
      await p.evaluate(() => document.getElementById("deleteEntryBtn").click());
      await settle(p, 900);
      const del = await anims(p, n);
      ok(del.some(a => a.id === victim.id && /"opacity":0/.test(a.frames)), `${label}: the deleted row fades out first`, JSON.stringify(del.slice(0, 3)));
      ok(del.some(a => a.id && a.id !== victim.id && /translateY/.test(a.frames)), `${label}: and the rows below close over the gap`, JSON.stringify(del.map(a => a.id)));
      ok(!(await p.$(`#logBody tr[data-entry-id="${victim.id}"]`)), `${label}: then it is gone`);
      n = await animCount(p);
      ok(await toastAction(p), `${label}: the delete offers Undo`);
      await settle(p, 800);
      const back = h.backend.state.entries.some(e => e.date === victim.date);
      const und = await anims(p, n);
      ok(back && und.some(a => /translateY\(-6px\)/.test(a.frames)), `${label}: Undo brings the row back the same way`, JSON.stringify(und.map(a => a.frames.slice(0, 60))));
      ok(await p.evaluate(() => !!document.querySelector("#logBody tr.is-flash")), `${label}: and lights it`);

      // ---- Settings: a palette change crossfades -----------------------------
      await goTab(p, "settings");
      await p.evaluate(() => { const b = document.querySelector('[data-console-target="appearance"]'); if(b) b.click(); });
      await settle(p, 400);
      const vt0 = await p.evaluate(() => window.__vt);
      await p.evaluate(() => { const b = document.querySelector('#modeSeg [data-mode="dark"]'); if(b) b.click(); });
      await settle(p, 700);
      ok(await p.evaluate(v => window.__vt === v + 1, vt0), `${label}: picking Dark crossfades the whole screen`);
      ok(await p.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"), `${label}: and Dark is applied`);
      const md = await pillFit(p, "#modeSeg");
      ok(md && md.dx <= 1 && md.dw <= 1, `${label}: the mode's highlight slides to Dark`, JSON.stringify(md));

      ok(h.errors.length === 0, `${label}: no script errors`, h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // ---- Reduced motion: the same actions, nothing moves -----------------------
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed, beforeLoad: async ctx => {
      await record(ctx);
      await ctx.page.emulateMedia({ reducedMotion: "reduce" });
    } });
    const p = h.page;
    try {
      await settle(p, 700);
      await goTab(p, "recap");
      await settle(p, 100);
      ok(!(await p.evaluate(() => document.getElementById("recapBody").classList.contains("is-entering"))), "reduced motion: Recap does not draw in");
      let n = await animCount(p);
      await p.click("#recapPrevBtn");
      await settle(p, 200);
      ok((await anims(p, n)).length === 0, "reduced motion: a month step starts no animation", JSON.stringify(await anims(p, n)));
      await goTab(p, "log");
      await pickMonth(p, prevMonth);
      await settle(p, 300);
      const target = rows.find(r => r.date.slice(0, 7) === prevMonth && r.date.slice(8) >= "10");
      await openRow(p, target.id, false);
      await settle(p, 400);
      await p.evaluate(() => { document.getElementById("fNote").value = "still"; document.getElementById("submitBtn").click(); });
      await settle(p, 500);
      ok(await p.evaluate(id => { const r = document.querySelector(`#logBody tr[data-entry-id="${id}"]`); return !!r && r.classList.contains("is-marked") && !r.classList.contains("is-flash"); }, target.id),
        "reduced motion: a saved day is marked, not faded");
      n = await animCount(p);
      await openRow(p, rows.find(r => r.date.slice(0, 7) === prevMonth && r.date.slice(8) >= "15" && r.id !== target.id).id, false);
      await settle(p, 400);
      await p.evaluate(() => document.getElementById("deleteEntryBtn").click());
      await settle(p, 700);
      ok((await anims(p, n)).length === 0, "reduced motion: a delete starts no animation");
      await goTab(p, "settings");
      await p.evaluate(() => { const b = document.querySelector('[data-console-target="appearance"]'); if(b) b.click(); });
      await settle(p, 300);
      await p.evaluate(() => { const b = document.querySelector('#modeSeg [data-mode="dark"]'); if(b) b.click(); });
      await settle(p, 400);
      ok(await p.evaluate(() => window.__vt === 0 && document.documentElement.getAttribute("data-theme") === "dark"),
        "reduced motion: Dark is applied without a crossfade");
      ok(h.errors.length === 0, "reduced motion: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  console.log(`  motion  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
