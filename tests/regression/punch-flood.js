// The punch, shown.
//
// Clocking in or out is what most people open this app to do, and on a phone
// its confirmation was a line of small text below the bottom of the screen. A
// saved punch now floods the colour of the action out from the control that
// was pressed, states the minute that was recorded, and drains back into it.
//
// What is held here, against the real app and the scripted backend:
//   * it comes from the control that was pressed and reaches every corner of
//     its stage -- the whole screen on a phone, the clock panel or the sticky
//     bar above that -- and says the minute the server was actually sent;
//   * it goes back to where that control is BY THEN. The page moves under it:
//     the save repaints the Overview and the "In today" card redraws a moment
//     later, which on a phone shifts the card's button by 30px mid-flood;
//   * it is decoration and behaves like it: it leaves by itself, a tap sends
//     it away without reaching whatever is underneath, and on a desktop the
//     rest of the page stays usable while it plays;
//   * on the Overview panel its three lines sit exactly on the three they
//     replace, at the widths where the panel's own sizes change;
//   * someone who asked for less motion gets none, and still gets the punch.
//
// A punch that was refused plays nothing; that is held in clock/test-clock.js,
// where the save can be made to fail on demand.
//
// Everything timed is measured INSIDE the page, by a callback or a timer on
// the same clock the flood runs on. The flood lasts two seconds and its way
// back half of one; asking about it from here, one round trip at a time, found
// nothing left to ask about when four suites were sharing the machine.
const { boot, settle, goTab, PHONE } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Pat Punch" });
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ds(new Date());

// Twelve ordinary days ending yesterday, and nothing for today.
function history(){
  const out = [];
  for(let i = 12; i >= 1; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push({ id: "h" + i, user_id: me.id, date: ds(d), clock_in: "08:00", clock_out: "16:00",
      type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z" });
  }
  return out;
}
const seed = () => ({ profiles: [me], entries: history(),
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] });

const todays = h => h.backend.state.entries.filter(e => e.user_id === me.id && e.date === TODAY);
// "20:07" or "20:07:00" as the app shows it, without the space: "8:07PM".
const as12 = t => { const [h, m] = String(t).split(":"); return ((+h % 12) || 12) + ":" + m + (+h >= 12 ? "PM" : "AM"); };
const floodCount = page => page.evaluate(() => document.querySelectorAll(".punch-flood").length);
const clockAction = page => page.evaluate(() => document.getElementById("bnClockBtn").getAttribute("data-clock-action"));
const centreOf = (page, sel) => page.evaluate(sel => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}, sel);
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= (tol == null ? 1 : tol);

// Press a clock control and report the flood as it arrives: what it is, where
// it started, and where the control stood at that same instant. Null if none
// came. Also leaves window.__floodAt behind, the moment it arrived, which the
// timed questions below count from.
const press = (page, id) => page.evaluate(id => new Promise(resolve => {
  const btn = document.getElementById(id);
  const seen = new MutationObserver(() => {
    const el = document.querySelector(".punch-flood");
    if(!el) return;
    seen.disconnect();
    window.__floodAt = performance.now();
    const box = el.getBoundingClientRect();
    const b = btn.getClientRects().length ? btn.getBoundingClientRect() : null;
    const hostBox = el.parentElement.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const num = name => parseFloat(el.style.getPropertyValue(name));
    // The toast stack is only built by the first toast; a stand-in reads the
    // same rule without waiting for one.
    const stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
    const zToast = Number(getComputedStyle(stack).zIndex);
    stack.remove();
    const scrim = document.querySelector(".status-bar-scrim");
    resolve({
      count: document.querySelectorAll(".punch-flood").length,
      cls: el.className,
      ariaHidden: el.getAttribute("aria-hidden"),
      parent: el.parentElement === document.body ? "body" : (el.parentElement.id || el.parentElement.className),
      position: cs.position,
      box: [box.left, box.top, box.width, box.height],
      host: [hostBox.left, hostBox.top, hostBox.width, hostBox.height],
      view: [window.innerWidth, window.innerHeight],
      px: num("--px"), py: num("--py"), pr: num("--pr"),
      // The control's centre, measured from the flood's own corner.
      cx: b ? b.left + b.width / 2 - box.left : null,
      cy: b ? b.top + b.height / 2 - box.top : null,
      label: el.querySelector(".punch-flood-label").textContent,
      time: Array.from(el.querySelectorAll(".punch-flood-time span")).map(s => s.textContent).join(""),
      sub: el.querySelector(".punch-flood-sub").textContent,
      period: parseFloat(getComputedStyle(el.querySelector(".punch-flood-period")).fontSize),
      z: Number(cs.zIndex), zToast, zScrim: scrim ? Number(getComputedStyle(scrim).zIndex) : null,
      liveDate: document.getElementById("liveDate").textContent
    });
  });
  seen.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { seen.disconnect(); resolve(null); }, 4000);
  btn.click();
}), id);

// `ms` after the flood arrived, run `what` in the page and hand back its
// answer. `what` is the name of one of the questions below.
const at = (page, ms, what, arg) => page.evaluate(([ms, what, arg]) => new Promise(resolve => {
  const ask = {
    // Is the thing under each point part of the flood?
    covered(points){
      return points.map(([x, y]) => { const t = document.elementFromPoint(x, y); return !!(t && t.closest(".punch-flood")); });
    },
    // Each line of the flood beside the line of the panel it replaces.
    lines(){
      const r = sel => { const n = document.querySelector(sel); if(!n) return null; const b = n.getBoundingClientRect(); return [b.left, b.top, b.height]; };
      return { label: [r(".quick-clock-time .qc-label"), r(".punch-flood-label")],
               time:  [r("#liveClock"), r(".punch-flood-time")],
               date:  [r("#liveDate"), r(".punch-flood-sub")] };
    },
    // A click on whatever is under the point, exactly as the browser would
    // deliver one, and what had become of things 400ms later.
    tap(point){
      const t = document.elementFromPoint(point[0], point[1]);
      const onFlood = !!(t && t.closest(".punch-flood"));
      if(t) t.click();
      return new Promise(done => setTimeout(() => done({
        onFlood,
        floods: document.querySelectorAll(".punch-flood").length,
        formOpen: !document.getElementById("entryModal").hidden
      }), 400));
    }
  };
  const wait = Math.max(0, ms - (performance.now() - window.__floodAt));
  setTimeout(() => resolve(ask[what](arg)), wait);
}), [ms, what, arg]);

// The origin and the control once more, at the instant the flood turns back:
// taken by the observer that sees .is-leaving arrive.
const leaving = (page, id) => page.evaluate(id => new Promise(resolve => {
  const el = document.querySelector(".punch-flood");
  if(!el){ resolve(null); return; }
  const measure = () => {
    const box = el.getBoundingClientRect();
    const btn = document.getElementById(id);
    const b = btn.getClientRects().length ? btn.getBoundingClientRect() : null;
    return {
      px: parseFloat(el.style.getPropertyValue("--px")), py: parseFloat(el.style.getPropertyValue("--py")),
      pr: parseFloat(el.style.getPropertyValue("--pr")),
      cx: b ? b.left + b.width / 2 - box.left : null, cy: b ? b.top + b.height / 2 - box.top : null,
      w: box.width, h: box.height
    };
  };
  if(el.classList.contains("is-leaving")){ resolve(measure()); return; }
  const seen = new MutationObserver(() => {
    if(!el.classList.contains("is-leaving")) return;
    seen.disconnect();
    resolve(measure());
  });
  seen.observe(el, { attributes: true, attributeFilter: ["class"] });
  setTimeout(() => { seen.disconnect(); resolve(null); }, 4000);
}), id);

// Resolves once no flood is left, or reports how long it waited.
const gone = (page, withinMs) => page.evaluate(withinMs => new Promise(resolve => {
  const began = performance.now();
  (function look(){
    if(!document.querySelector(".punch-flood")) return resolve({ gone: true, after: Math.round(performance.now() - window.__floodAt) });
    if(performance.now() - began > withinMs) return resolve({ gone: false, after: Math.round(performance.now() - window.__floodAt) });
    setTimeout(look, 40);
  })();
}), withinMs);

// Every app this suite opens, so the ones still open can be closed if a step
// throws: a failure has to fail the run, not leave a browser up.
const open = new Set();
async function start(opts){
  const h = await boot(opts);
  open.add(h);
  const close = h.close;
  h.close = async () => { open.delete(h); await close(); };
  return h;
}

(async () => {

  // ---- A phone: the bar button, clocking in -----------------------------------
  {
    const h = await start({ viewport: PHONE, meId: me.id, seed: seed() });
    ok(await floodCount(h.page) === 0, "nothing is drawn before a punch");
    const bn = await centreOf(h.page, "#bnClockBtn");
    const log = await centreOf(h.page, '.bn-item[data-bn-tab="log"]');

    const f = await press(h.page, "bnClockBtn");
    ok(!!f, "a saved punch draws the flood");
    if(f){
      const row = todays(h)[0];
      ok(f.count === 1, "one flood for one punch", String(f.count));
      ok(/\bis-in\b/.test(f.cls) && /\bis-screen\b/.test(f.cls), "phone clock-in: the accent flood, on the screen stage", f.cls);
      ok(f.ariaHidden === "true", "it is hidden from assistive tech: the note and the toast are the spoken confirmation");
      ok(f.parent === "body" && f.position === "fixed", "on a phone it belongs to the page, not to a panel", f.parent + " / " + f.position);
      ok(near(f.box[0], 0) && near(f.box[1], 0) && near(f.box[2], f.view[0]) && near(f.box[3], f.view[1]),
        "and its box is the whole screen", JSON.stringify(f.box) + " in " + JSON.stringify(f.view));
      ok(near(f.px, f.cx) && near(f.py, f.cy), "it starts at the centre of the button that was pressed",
        `origin ${f.px},${f.py}  button ${f.cx},${f.cy}`);
      const reach = Math.hypot(Math.max(f.px, f.box[2] - f.px), Math.max(f.py, f.box[3] - f.py));
      ok(f.pr >= reach, "and reaches the farthest corner of the screen", `radius ${f.pr}, needed ${reach.toFixed(1)}`);
      ok(f.z > f.zToast, "it sits over the toast stack", `${f.z} vs ${f.zToast}`);
      ok(f.zScrim !== null && f.z < f.zScrim, "and under the status-bar strip, which nothing may cover", `${f.z} vs ${f.zScrim}`);

      ok(!!row && !!row.clock_in, "the punch itself was saved", JSON.stringify(row));
      ok(f.label === "Clocked in", "it says which punch it was", f.label);
      ok(!!row && f.time === as12(row.clock_in), "and the minute the server was sent, not a second reading of the clock",
        `${f.time} vs ${row && row.clock_in}`);
      ok(f.sub === f.liveDate && f.sub.length > 8, "with the day it belongs to underneath", f.sub);

      // Fully out by 700ms: nothing under it can be pressed by mistake.
      const hit = await at(h.page, 700, "covered", [bn, log, [30, 30]]);
      ok(hit[0], "while it is up, a second tap on the clock button meets the flood");
      ok(hit[1], "and so does a tap on the bar beside it");
      ok(hit[2], "and one at the far corner");

      const back = await leaving(h.page, "bnClockBtn");
      ok(!!back && near(back.px, back.cx) && near(back.py, back.cy), "it turns back toward the same button", JSON.stringify(back));
      const end = await gone(h.page, 3000);
      ok(end.gone, "it leaves by itself", JSON.stringify(end));
      // Not before its two seconds are up. The upper bound is loose on purpose:
      // a busy machine delays the page's timers, and 2.6s read as a failure
      // once when nothing was wrong.
      ok(end.after >= 1900 && end.after <= 3500, "about two seconds after it arrived", end.after + "ms");
      ok((await at(h.page, 0, "covered", [bn]))[0] === false, "and the screen is the app's again");
      ok(await h.page.evaluate(() => document.getElementById("bnClockBtn").classList.contains("punch-landed")),
        "the button it drained back into takes the landing");
      ok(await clockAction(h.page) === "out", "and now offers Clock Out");
      ok(todays(h).length === 1, "still exactly one row for today", String(todays(h).length));
    }

    // ---- Clocking out, and a tap that sends it away ---------------------------
    const out = await press(h.page, "bnClockBtn");
    ok(!!out, "clocking out draws it again");
    if(out){
      const done = todays(h)[0];
      ok(/\bis-out\b/.test(out.cls) && /\bis-screen\b/.test(out.cls), "clock-out: the positive flood", out.cls);
      ok(out.label === "Clocked out", "it says the day was closed", out.label);
      ok(!!done.clock_out && out.time === as12(done.clock_out), "at the minute that was saved", `${out.time} vs ${done.clock_out}`);
      ok(/ worked$/.test(out.sub), "with what the day came to underneath", out.sub);
      const doneText = await h.page.evaluate(() => document.getElementById("qcDoneText").textContent);
      ok(doneText.indexOf(out.sub) !== -1, "the same figure the panel reports for the finished day", `"${out.sub}" in "${doneText}"`);

      // The button under the flood is now "Done", which opens today's entry. A
      // tap there must spend itself on the flood.
      const tap = await at(h.page, 600, "tap", bn);
      ok(tap.onFlood, "a tap where the clock button is lands on the flood");
      ok(tap.floods === 0, "and sends it away early", String(tap.floods));
      ok(tap.formOpen === false, "without reaching the button underneath");
      ok(todays(h).length === 1 && !!todays(h)[0].clock_out, "or punching a second time", JSON.stringify(todays(h)));
    }
    ok(h.errors.length === 0, "phone: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- A phone: the Overview card's own button ---------------------------------
  {
    const h = await start({ viewport: PHONE, meId: me.id, seed: seed() });
    await h.page.evaluate(() => document.getElementById("qcClockBtn").scrollIntoView({ block: "center" }));
    await settle(h.page);
    const f = await press(h.page, "qcClockBtn");
    ok(!!f && /\bis-screen\b/.test(f.cls) && f.parent === "body", "phone, the card's button: still the whole screen", f && (f.cls + " in " + f.parent));
    ok(!!f && near(f.px, f.cx) && near(f.py, f.cy), "from that button, not from the bar", f && `origin ${f.px},${f.py}  button ${f.cx},${f.cy}`);
    // By the time it turns, the "In today" card above has redrawn with this
    // person in it and the button is somewhere else on the screen. The way
    // back is aimed at where it is, not at where it was.
    const back = await leaving(h.page, "qcClockBtn");
    ok(!!back && near(back.px, back.cx) && near(back.py, back.cy), "and it drains back into the button where the button now is",
      JSON.stringify(back) + (f ? `  (it began at ${f.px},${f.py})` : ""));
    const reach = back ? Math.hypot(Math.max(back.px, back.w - back.px), Math.max(back.py, back.h - back.py)) : Infinity;
    ok(!!back && back.pr >= reach, "still covering the screen from its new centre as it turns", back && `radius ${back.pr}, needed ${reach.toFixed(1)}`);
    await h.close();
  }

  // ---- A desktop: the Overview panel ---------------------------------------------
  for(const width of [1440, 1100, 900, 780]){
    const h = await start({ viewport: { width, height: 900 }, meId: me.id, seed: seed() });
    const f = await press(h.page, "qcClockBtn");
    ok(!!f, `${width}px: a saved punch draws the flood`);
    if(f){
      ok(/\bis-in\b/.test(f.cls) && !/\bis-screen\b/.test(f.cls) && !/\bis-bar\b/.test(f.cls),
        `${width}px: the flood is the panel's, not the screen's`, f.cls);
      ok(/quick-clock/.test(f.parent) && f.position === "absolute", `${width}px: it lives inside the clock panel`, f.parent);
      ok(near(f.box[0], f.host[0]) && near(f.box[1], f.host[1]) && near(f.box[2], f.host[2]) && near(f.box[3], f.host[3]),
        `${width}px: and is exactly the panel's box`, JSON.stringify(f.box) + " vs " + JSON.stringify(f.host));
      ok(near(f.px, f.cx) && near(f.py, f.cy), `${width}px: it starts at the button`, `origin ${f.px},${f.py}  button ${f.cx},${f.cy}`);
      const reach = Math.hypot(Math.max(f.px, f.box[2] - f.px), Math.max(f.py, f.box[3] - f.py));
      ok(f.pr >= reach, `${width}px: and reaches the panel's far corner`, `radius ${f.pr}, needed ${reach.toFixed(1)}`);

      // The live clock freezes into the recorded time: each line of the flood
      // sits on the line of the panel it replaces. Asked at 950ms, once the
      // lines have finished arriving -- they slide 8px into place.
      const lines = await at(h.page, 950, "lines");
      for(const name of ["label", "time", "date"]){
        const [panel, flood] = lines[name];
        ok(!!panel && !!flood && near(panel[0], flood[0], 0.6) && near(panel[1], flood[1], 0.6) && near(panel[2], flood[2], 0.6),
          `${width}px: the flood's ${name} line lands on the panel's`,
          `panel ${panel && panel.map(n => n.toFixed(1))}  flood ${flood && flood.map(n => n.toFixed(1))}`);
      }
    }

    if(width === 1440){
      // The rest of the page is not held up by a flourish in one panel.
      const rail = await centreOf(h.page, '.rail-item[data-rail-tab="log"]');
      ok((await at(h.page, 0, "covered", [rail]))[0] === false, "desktop: the rail is not under it");
      await goTab(h.page, "log");
      const onLog = await h.page.evaluate(() => document.getElementById("tab-log").classList.contains("active"));
      ok(onLog, "desktop: and another tab opens while it plays");
      const end = await gone(h.page, 3000);
      ok(end.gone, "desktop: it is gone afterwards, wherever the person went", JSON.stringify(end));

      // The dark clock bar belongs to the Overview alone (owner, 2026-11-23).
      await settle(h.page);
      const sticky = await h.page.evaluate(() => document.getElementById("stickyClock").classList.contains("show"));
      ok(!sticky, "desktop, Log tab: no sticky clock bar");
    }
    ok(h.errors.length === 0, `${width}px: no script errors`, h.errors.join(" | "));
    await h.close();
  }

  // ---- The sticky bar: the Overview, its clock panel below the fold -----------
  // A window under 1100px scrolls as a page, and at 900x700 the Overview's
  // clock panel starts below the fold, which is when the bar comes up.
  {
    const h = await start({ viewport: { width: 900, height: 700 }, meId: me.id, seed: seed() });
    await settle(h.page);
    const sticky = await h.page.evaluate(() => document.getElementById("stickyClock").classList.contains("show"));
    ok(sticky, "900x700 Overview, clock panel below the fold: the sticky bar is up");
    const s = await press(h.page, "stickyClockBtn");
    ok(!!s && /\bis-(in|out)\b/.test(s.cls) && /\bis-bar\b/.test(s.cls), "sticky bar: the flood is the bar's own", s && s.cls);
    ok(!!s && s.parent === "stickyClock", "sticky bar: and lives inside it", s && s.parent);
    ok(!!s && near(s.box[2], s.host[2]) && near(s.box[3], s.host[3]), "sticky bar: at the bar's size", s && (JSON.stringify(s.box) + " vs " + JSON.stringify(s.host)));
    ok(!!s && near(s.px, s.cx) && near(s.py, s.cy), "sticky bar: from the bar's button", s && `origin ${s.px},${s.py}  button ${s.cx},${s.cy}`);
    ok(!!s && s.period >= 11, "sticky bar: AM/PM holds the 11px floor", s && (s.period + "px"));
    ok(h.errors.length === 0, "900x700: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Heard and felt -------------------------------------------------------------
  // The chime is two notes ending on C6; the phone ticks at the press and beats
  // twice when the punch lands. Both are spied on rather than performed: what
  // the app asked the browser for is the thing under test. Real taps, because
  // a browser only starts sound from one.
  {
    const spy = ({ page }) => page.addInitScript(() => {
      window.__audio = []; window.__buzz = [];
      const Real = window.AudioContext;
      window.AudioContext = function(){
        const c = new Real(), rec = { notes: [], closed: false };
        window.__audio.push(rec);
        const mk = c.createOscillator.bind(c);
        c.createOscillator = () => {
          const o = mk(), set = o.frequency.setValueAtTime.bind(o.frequency);
          o.frequency.setValueAtTime = (f, t) => { rec.notes.push(Math.round(f)); return set(f, t); };
          return o;
        };
        const close = c.close.bind(c);
        c.close = () => { rec.closed = true; return close(); };
        return c;
      };
      navigator.vibrate = p => { window.__buzz.push(p); return true; };
    });
    const heard = page => page.evaluate(() => ({ audio: window.__audio.splice(0), buzz: window.__buzz.splice(0) }));
    const h = await start({ viewport: PHONE, meId: me.id, seed: seed(), beforeLoad: spy });

    await h.page.tap("#bnClockBtn");
    await h.page.waitForTimeout(2600);
    let got = await heard(h.page);
    ok(JSON.stringify(got.audio.map(a => a.notes)) === "[[784,1568,1047,2093]]", "clock-in: G5 then C6, each with its octave", JSON.stringify(got.audio));
    ok(got.audio.length === 1 && got.audio[0].closed, "and the audio device is let go afterwards");
    ok(JSON.stringify(got.buzz) === "[12,[16,70,28]]", "the phone ticks at the press and beats twice when it is saved", JSON.stringify(got.buzz));
    ok(await h.page.evaluate(() => document.getElementById("bnClockBtn").classList.contains("punch-pressed")), "and the button shows the press");

    await h.page.tap("#bnClockBtn");
    await h.page.waitForTimeout(2600);
    got = await heard(h.page);
    ok(JSON.stringify(got.audio.map(a => a.notes)) === "[[1319,2637,1047,2093]]", "clock-out: E6 down to the same C6", JSON.stringify(got.audio));

    // Switched off in Settings: remembered on this device, and silent.
    await h.page.evaluate(() => {
      // Two switches now (they were On/Off pairs); a click turns each off.
      for(const id of ["punchSoundSwitch", "punchHapticsSwitch"]){
        const sw = document.getElementById(id);
        if(sw.checked) sw.click();
      }
    });
    ok(await h.page.evaluate(() => localStorage.getItem("attendance.punchFeedback")) === '{"sound":false,"haptics":false}', "the two switches are saved in this browser");
    // They have a section of their own, Sound & Haptics, and its row in the
    // Settings list says what they are set to without opening it.
    const where = await h.page.evaluate(() => ({
      sound: document.getElementById("punchSoundSwitch").closest(".console-section").getAttribute("data-section"),
      haptics: document.getElementById("punchHapticsSwitch").closest(".console-section").getAttribute("data-section"),
      desc: document.getElementById("cnavDescFeedback").textContent }));
    ok(where.sound === "feedback" && where.haptics === "feedback" && where.desc === "Sound off · vibration off",
      "the switches live in Settings > Sound & Haptics, whose row reads \"Sound off · vibration off\"", JSON.stringify(where));
    await h.close();

    const quiet = await start({ viewport: PHONE, meId: me.id, seed: seed(), beforeLoad: async ctx => {
      await spy(ctx);
      await ctx.page.addInitScript(() => localStorage.setItem("attendance.punchFeedback", '{"sound":false,"haptics":false}'));
    } });
    await quiet.page.tap("#bnClockBtn");
    await quiet.page.waitForTimeout(900);
    got = await heard(quiet.page);
    ok(got.audio.length === 0 && got.buzz.length === 0, "switched off: no sound and no vibration", JSON.stringify(got));
    ok(await floodCount(quiet.page) === 1 && todays(quiet).length === 1, "switched off: the punch and its flood are untouched");
    await quiet.close();

    // A punch the server refuses: the press is felt, nothing is celebrated.
    const refused = await start({ viewport: PHONE, meId: me.id, seed: seed(), beforeLoad: spy });
    refused.backend.fail("/rest/v1/entries", { status: 403, message: "permission denied for table entries" }, 1);
    await refused.page.tap("#bnClockBtn");
    await refused.page.waitForTimeout(900);
    got = await heard(refused.page);
    ok(JSON.stringify(got.buzz) === "[12]" && got.audio.every(a => a.notes.length === 0), "refused: the tick of the press, and no chime or second beat", JSON.stringify(got));
    ok(await floodCount(refused.page) === 0, "refused: and no flood");
    await refused.close();

    // Less motion is not less sound: the flood stays away, the rest plays.
    const still = await start({ viewport: PHONE, meId: me.id, seed: seed(), beforeLoad: spy });
    await still.page.emulateMedia({ reducedMotion: "reduce" });
    await still.page.tap("#bnClockBtn");
    await still.page.waitForTimeout(900);
    got = await heard(still.page);
    ok(got.audio.length === 1 && got.audio[0].notes.length === 4 && got.buzz.length === 2, "reduced motion: the chime and the vibration still play", JSON.stringify(got));
    await still.close();

    // A device that cannot vibrate (every iPhone) is not offered the switch.
    const mute = await start({ viewport: PHONE, meId: me.id, seed: seed(),
      beforeLoad: ({ page }) => page.addInitScript(() => { Object.defineProperty(Navigator.prototype, "vibrate", { value: undefined, configurable: true }); }) });
    ok(await mute.page.evaluate(() => document.getElementById("punchHapticsGroup").hidden === true && document.getElementById("punchSoundGroup").hidden === false),
      "no vibration on this device: the Vibration switch is hidden, the sound switch is not");
    await mute.close();
  }

  // ---- No connection: saved on this device ---------------------------------------
  {
    const h = await start({ viewport: PHONE, meId: me.id, seed: seed() });
    await h.page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", { get: () => false, configurable: true });
    });
    const f = await press(h.page, "bnClockBtn");
    ok(!!f && f.label === "Clocked in" && f.sub === "Saved on this device",
      "offline: the punch is shown as made, and as kept on the device", f && (f.label + " / " + f.sub));
    ok(todays(h).length === 0, "offline: nothing reached the server, and the flood does not claim it did");
    await h.close();
  }

  // ---- Asked for less motion -----------------------------------------------------
  {
    const h = await start({ viewport: PHONE, meId: me.id, seed: seed() });
    await h.page.emulateMedia({ reducedMotion: "reduce" });
    // Watched from inside the page for a full second: a node that came and
    // went between two looks from here would have gone unseen.
    const seen = await h.page.evaluate(() => new Promise(resolve => {
      let built = 0;
      const watch = new MutationObserver(list => {
        list.forEach(m => m.addedNodes.forEach(n => { if(n.classList && n.classList.contains("punch-flood")) built++; }));
      });
      watch.observe(document.body, { childList: true, subtree: true });
      document.getElementById("bnClockBtn").click();
      setTimeout(() => { watch.disconnect(); resolve(built); }, 1000);
    }));
    ok(seen === 0, "reduced motion: no flood is built at any point", String(seen));
    ok(todays(h).length === 1 && !!todays(h)[0].clock_in, "reduced motion: the punch is saved all the same");
    const note = await h.page.evaluate(() => document.getElementById("qcStatusNote").textContent);
    ok(/^Clocked in at /.test(note), "reduced motion: and still confirmed in words", note);
    ok(await clockAction(h.page) === "out", "reduced motion: the control moves on to Clock Out");
    ok(h.errors.length === 0, "reduced motion: no script errors", h.errors.join(" | "));
    await h.close();
  }

})().catch(err => { fail++; failures.push("suite threw: " + (err && err.stack || err)); })
  .finally(async () => {
    await Promise.all([...open].map(h => h.close().catch(() => {})));
    console.log(`  punch-flood  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
