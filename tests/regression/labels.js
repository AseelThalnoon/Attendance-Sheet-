// Admin › Labels (2026-11-22): the team's own wording for any text in the
// app, in English and Arabic, kept in app_settings.label_overrides.
//
// First src/i18n.js on its own: a reworded text shows in English and in
// Arabic, a pattern can be reworded, and taking the wording away gives the
// app's own text back. Then the app: the team's wording is there from the
// first screen, an admin rewords a label and everyone's copy of it moves,
// a pattern that loses its {n} is refused, Reset gives the text back, and an
// Arabic rewording shows in Arabic.
require("../no-network");
const path = require("path");
const { pathToFileURL } = require("url");
const { boot, settle, goTab, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

(async () => {
  // ---- src/i18n.js, in each language ----------------------------------------
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  const node = s => ({ nodeType: 3, nodeValue: s, parentNode: { nodeType: 1, nodeName: "DIV", getAttribute: () => null, hasAttribute: () => false, parentNode: null } });
  for(const lang of ["en", "ar"]){
    globalThis.localStorage = { getItem: k => (k === "attendance.language" ? lang : null), setItem(){} };
    // A fresh copy of the module per language: the query string makes it one.
    const base = f => pathToFileURL(path.join(ROOT, "src", f)).href + "?" + lang;
    const i18n = await import(base("i18n.js"));
    // The dictionaries import "./i18n.js" without the query, so give them this
    // copy by registering through it directly.
    const dicts = await Promise.all(["i18n-ar-1.js", "i18n-ar-2.js", "i18n-ar-3.js", "i18n-ar-4.js", "i18n-ar-5.js"]
      .map(f => import(pathToFileURL(path.join(ROOT, "src", f)).href)));
    void dicts;
    const shared = await import(pathToFileURL(path.join(ROOT, "src", "i18n.js")).href);
    i18n.register(shared.entries());
    const tr = s => { const n = node(s); i18n.translateTree(n); return n.nodeValue; };

    const before = tr("Overview"), beforePattern = tr("92 days logged");
    i18n.setOverrides({ en: { "Overview": "Home", "{n} days logged": "{n} days on record" }, ar: { "Overview": "صفحتي" } });
    if(lang === "en"){
      ok(before === "Overview", "en: with nothing reworded, English is the app's own", before);
      ok(tr("Overview") === "Home" && i18n.t("Overview") === "Home", "en: a reworded label shows the team's English", tr("Overview"));
      ok(tr("92 days logged") === "92 days on record", "en: a reworded pattern fills in its number", tr("92 days logged"));
      ok(tr("Log") === "Log", "en: everything else is left alone", tr("Log"));
    } else {
      ok(before === "الرئيسية", "ar: with nothing reworded, Arabic is the app's own", before);
      ok(tr("Overview") === "صفحتي", "ar: a reworded label shows the team's Arabic", tr("Overview"));
      ok(tr("Log") === "السجل", "ar: everything else keeps the app's Arabic", tr("Log"));
    }
    i18n.setOverrides({});
    ok(tr("Overview") === (lang === "en" ? "Overview" : "الرئيسية"), `${lang}: taking the wording away gives the app's own text back`, tr("Overview"));
    ok(tr("92 days logged") === beforePattern, `${lang}: and the app's own pattern`, tr("92 days logged") + " vs " + beforePattern);
  }

  // ---- The app --------------------------------------------------------------
  const me = D.profile(1, { role: "admin", full_name: "Rana Haddad" });
  const seed = (ov) => ({
    profiles: [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }],
    app_settings: [{ id: 1, default_settings: null, announcement: null, allow_registration: true, label_overrides: ov }]
  });
  const navText = (p, tab) => p.evaluate(t => {
    const el = document.querySelector('.rail-item[data-rail-tab="' + t + '"] span:last-child') || document.querySelector('.tab-btn[data-tab="' + t + '"]');
    return el ? el.textContent.trim() : null;
  }, tab);

  // The team's wording is on the first screen.
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed({ en: { "Trends": "Charts" } }) });
    const p = h.page;
    try {
      await settle(p, 600);
      ok(await navText(p, "trends") === "Charts", "the team's wording shows as the app opens", await navText(p, "trends"));

      // An admin rewords a label.
      await goTab(p, "admin");
      await p.evaluate(() => document.querySelector('[data-console-target="admin-labels"]').click());
      await settle(p, 600);
      const rows = await p.evaluate(() => document.querySelectorAll("#labelsList .label-row").length);
      ok(rows > 0, "Labels lists the app's text", rows);
      await p.fill("#labelsSearch", "Overview");
      await settle(p, 400);
      const row = '#labelsList .label-row[data-label-key="Overview"]';
      ok(await p.$(row) !== null, "search finds a label by its English");
      await p.fill(row + ' input[data-label-lang="en"]', "Home");
      ok(await p.evaluate(() => document.getElementById("labelsCommit").classList.contains("is-dirty")), "an edit shows Unsaved changes");
      await p.click("#saveLabelsBtn");
      await settle(p, 600);
      const stored = h.backend.state ? h.backend.state.app_settings[0].label_overrides : null;
      ok(stored && stored.en && stored.en.Overview === "Home" && stored.en.Trends === "Charts",
        "Save writes the team's wording, keeping what was there", JSON.stringify(stored));
      ok(await navText(p, "overview") === "Home", "and the screen says it at once", await navText(p, "overview"));

      // A pattern has to keep its {n}.
      await p.fill("#labelsSearch", "days logged");
      await settle(p, 400);
      const prow = '#labelsList .label-row[data-label-key="{n} days logged"]';
      await p.fill(prow + ' input[data-label-lang="en"]', "days on record");
      await p.click("#saveLabelsBtn");
      await settle(p, 400);
      const after = h.backend.state.app_settings[0].label_overrides;
      ok(!(after.en && after.en["{n} days logged"]), "a pattern that loses its {n} is not saved", JSON.stringify(after));
      ok(await p.evaluate(r => document.querySelector(r).classList.contains("is-invalid"), prow), "and its row says which one");
      await p.click("#discardLabelsBtn");
      await settle(p, 300);

      // Reset gives a label back.
      await p.fill("#labelsSearch", "Overview");
      await settle(p, 400);
      await p.click(row + " [data-label-reset]");
      await p.click("#saveLabelsBtn");
      await settle(p, 600);
      const reset = h.backend.state.app_settings[0].label_overrides;
      ok(!(reset.en && reset.en.Overview) && reset.en.Trends === "Charts", "Reset gives one label back and leaves the rest", JSON.stringify(reset));
      ok(await navText(p, "overview") === "Overview", "and the screen goes back to the app's own word", await navText(p, "overview"));
      ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  // An Arabic rewording shows in Arabic, and not in English.
  {
    const arabic = ({ page }) => page.addInitScript(() => { try{ if(!localStorage.getItem("attendance.language")) localStorage.setItem("attendance.language", "ar"); }catch(e){} });
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed({ ar: { "Trends": "الرسوم" } }), beforeLoad: arabic });
    try {
      await settle(h.page, 600);
      ok(await navText(h.page, "trends") === "الرسوم", "an Arabic rewording shows in Arabic", await navText(h.page, "trends"));
      ok(await navText(h.page, "log") === "السجل", "next to the app's own Arabic", await navText(h.page, "log"));
      ok(h.errors.length === 0, "Arabic: no script errors", h.errors.join(" | "));
    } finally { await h.close(); }
  }

  console.log(`  labels  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
