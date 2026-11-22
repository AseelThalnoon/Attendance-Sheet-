// Arabic (2026-11-22): the owner chose a per-person language switch, Western
// digits, the Gregorian calendar, and the app first (push notifications and
// the sign-up email stay English for now).
//
// Two halves. The first runs src/i18n.js and the dictionaries themselves:
// Arabic plurals, the patterns that translate sentences app.js builds from
// parts, times and durations, and every dictionary entry's placeholders. The
// second boots the app in Arabic on a phone and a desktop and walks every tab:
// right to left, nothing left in English on screen (names and product names
// aside), nothing hanging off the side, Recap's first card actually in view,
// no script errors -- and the switch back to English.
require("../no-network");
const path = require("path");
const { pathToFileURL } = require("url");
const { boot, settle, goTab, PHONE, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);

(async () => {
  // ---- The module, in Node --------------------------------------------------
  globalThis.localStorage = { getItem: k => (k === "attendance.language" ? "ar" : null), setItem(){} };
  const url = f => pathToFileURL(path.join(ROOT, "src", f)).href;
  const i18n = await import(url("i18n.js"));
  for(const f of ["i18n-ar-1.js", "i18n-ar-2.js", "i18n-ar-3.js", "i18n-ar-4.js", "i18n-ar-5.js"]) await import(url(f));
  const time = await import(url("time.js"));

  ok(i18n.getLang() === "ar" && i18n.locale() === "ar-SA-u-ca-gregory-nu-latn",
    "Arabic is Saudi Arabic on the Gregorian calendar with Western digits", i18n.locale());
  const plurals = [1, 2, 3, 11, 100].map(n => i18n.count(n, "day"));
  ok(plurals.join(" | ") === "يوم واحد | يومان | 3 أيام | 11 يومًا | 100 يوم",
    "a count takes the Arabic form its number needs", plurals.join(" | "));
  ok(time.formatTime12("16:06") === "4:06 م" && time.formatTime12("07:48") === "7:48 ص",
    "times read ص and م", time.formatTime12("16:06"));
  ok(time.minutesToHoursStr(485) === "8س 5د" && time.minutesToHoursStr(15) === "15د",
    "durations read س and د", time.minutesToHoursStr(485));
  ok(/نوفمبر/.test(time.fmtDate("2026-11-19")) && /2026/.test(time.fmtDate("2026-11-19")),
    "dates use Arabic month names and Western digits", time.fmtDate("2026-11-19"));

  // translateTree() on a single text node: the path every screen takes.
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  const tr = s => {
    const node = { nodeType: 3, nodeValue: s, parentNode: { nodeType: 1, nodeName: "DIV", getAttribute: () => null, hasAttribute: () => false, parentNode: null } };
    i18n.translateTree(node);
    return node.nodeValue;
  };
  ok(tr("Clock In") === "تسجيل الحضور", "fixed text is swapped where it lands", tr("Clock In"));
  ok(tr("92 days logged") === "92 يومًا مسجّلة", "a sentence built from parts is matched by its pattern", tr("92 days logged"));
  ok(tr("16d") === "16 يومًا" && tr("Logged") === "مسجّل", "a number placeholder never eats a word", tr("Logged"));
  ok(tr("usually about 2 a month") === "عادةً نحو 2 في الشهر", "the more specific pattern wins", tr("usually about 2 a month"));
  const english = "Hours, punctuality and leave start from there.";
  ok(tr(english) === english, "a sentence nobody translated stays whole, not half-Arabic", tr(english));
  ok(tr("Couldn't save that entry: Something went wrong.") === "تعذّر حفظ السجل: حدث خطأ غير متوقع.",
    "an error inside a message is translated too", tr("Couldn't save that entry: Something went wrong."));

  // Every entry's Arabic uses only placeholders its English has.
  const bad = [];
  const dict = i18n.entries();
  for(const [en, ar] of Object.entries(dict)){
    const have = new Set((en.match(/\{(\w+)\}/g) || []).map(s => s.slice(1, -1)));
    (ar.match(/\{(\w+)(?:\|[^}]+)?\}/g) || []).forEach(s => {
      const name = s.slice(1).split(/[|}]/)[0];
      if(!have.has(name)) bad.push(en + " -> " + s);
    });
    if(/^\s|\s$/.test(ar) && !/^\s|\s$/.test(en)) bad.push("stray space: " + en);
  }
  ok(bad.length === 0, "every Arabic entry's placeholders exist in its English", bad.slice(0, 5).join(" | "));
  ok(Object.keys(dict).length > 900, "the dictionary covers the app", Object.keys(dict).length + " entries");

  // ---- The app, in a browser ------------------------------------------------
  const me = D.profile(1, { role: "admin", full_name: "Rana Haddad" });
  const now = new Date();
  const rows = [];
  for(let n = 100; n >= 1; n--){
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    if(d.getDay() === 5 || d.getDay() === 6) continue;
    const start = 470 + (n % 7) * 3;
    rows.push({ id: "a" + n, user_id: me.id, date: ds(d), type: n % 23 === 0 ? "leave" : "regular",
      clock_in: n % 23 === 0 ? null : hm(start), clock_out: n % 23 === 0 ? null : hm(start + 478 + (n % 5) * 4), note: "",
      created_at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, start + 1).toISOString(), updated_at: "2026-01-01T00:00:00Z" });
  }
  const seed = { profiles: [me], entries: rows, user_settings: [{ user_id: me.id, settings: D.SETTINGS }] };
  // Arabic unless a language is already saved, so the switch back to English
  // survives the reload it causes.
  const arabic = ({ page }) => page.addInitScript(() => { try{ if(!localStorage.getItem("attendance.language")) localStorage.setItem("attendance.language", "ar"); }catch(e){} });
  // What may stay Latin on an Arabic screen: the person's own name and email,
  // and names of products.
  const ALLOWED = /Rana Haddad|Rana|RH|person1@example\.com|Excel|CSV|JSON|Face ID|Touch ID|Windows Hello|Supabase Auth|PDF/g;

  for(const [label, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]){
    const h = await boot({ viewport, meId: me.id, seed, beforeLoad: arabic });
    const p = h.page;
    try {
      const root = await p.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
      ok(root.dir === "rtl" && root.lang === "ar", `${label}: the page is Arabic, right to left`, JSON.stringify(root));
      for(const tab of ["overview", "log", "trends", "punctuality", "recap", "team", "settings", "admin"]){
        await goTab(p, tab);
        await settle(p, 500);
        const s = await p.evaluate((allowedSrc) => {
          const allowed = new RegExp(allowedSrc, "g");
          const left = new Set();
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while((n = w.nextNode())){
            const v = n.nodeValue.trim();
            if(!v || !/[A-Za-z]{2,}/.test(v.replace(allowed, ""))) continue;
            const el = n.parentElement;
            if(!el || !el.getClientRects().length || el.closest("script,style,[dir=auto],[data-no-i18n],code")) continue;
            const r = el.getBoundingClientRect();
            if(r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
            if(getComputedStyle(el).visibility === "hidden") continue;
            left.add(v.slice(0, 80));
          }
          // A box's placeholder is the app's words even when the box is
          // dir="auto" for what gets typed into it.
          for(const el of document.querySelectorAll("input[placeholder], textarea[placeholder]")){
            const v = el.getAttribute("placeholder").trim();
            if(!/[A-Za-z]{2,}/.test(v.replace(allowed, "")) || el.closest("[data-no-i18n]") || !el.getClientRects().length) continue;
            const r = el.getBoundingClientRect();
            if(r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
            left.add("placeholder: " + v.slice(0, 60));
          }
          const vw = document.documentElement.clientWidth;
          const track = document.getElementById("recapTrack");
          const off = [...document.querySelectorAll(".shell *, .rail *")].filter(el => {
            if(!el.getClientRects().length || (track && track.contains(el))) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > vw + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed";
          }).slice(0, 3).map(el => el.tagName + "." + String(el.className).split(" ")[0]);
          return { english: [...left].slice(0, 8), off, scrollX: document.documentElement.scrollWidth > vw + 1 };
        }, ALLOWED.source);
        ok(s.english.length === 0, `${label} ${tab}: nothing left in English`, JSON.stringify(s.english));
        ok(!s.off.length && !s.scrollX, `${label} ${tab}: nothing hangs off the side`, JSON.stringify(s));
      }
      // Recap, right to left: the first card is the one on screen.
      await goTab(p, "recap");
      await settle(p, 500);
      const card = await p.evaluate(() => {
        const c = document.querySelector("#recapTrack > .recap-card");
        const r = c.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, label: c.getAttribute("aria-label") };
      });
      ok(card.left >= 0 && card.right <= card.vw, `${label}: Recap's first card is in view, right to left`, JSON.stringify(card));
      ok(h.errors.length === 0, `${label}: no script errors`, h.errors.join(" | "));

      if(label === "desktop"){
        // Back to English, from Settings › Appearance.
        await goTab(p, "settings");
        await p.evaluate(() => { const b = document.querySelector('[data-console-target="appearance"]'); if(b) b.click(); });
        await settle(p, 300);
        await Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click('#langSeg [data-lang="en"]')]);
        await p.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 });
        await settle(p, 400);
        const en = await p.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang,
          tab: document.querySelector('.tab-btn[data-tab="overview"]').textContent.trim(),
          saved: localStorage.getItem("attendance.language") }));
        ok(en.dir === "ltr" && en.lang === "en" && en.tab === "Overview" && en.saved === "en",
          "the switch in Settings puts the app back in English, and remembers it", JSON.stringify(en));
      }
    } finally { await h.close(); }
  }

  console.log(`  arabic  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
