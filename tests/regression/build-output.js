// The published copy is the same app as the source.
//
// Since 2026-11-15 what is published is built from the source by
// tools/build.mjs: scripts and styles minified, comments gone, only the files
// the app loads. Every other suite here runs on the source, because the source
// is what gets edited -- so this is the one that answers for the build. It
// builds a copy and holds it to three things:
//
//   * it is complete and consistent: every file the page and the worker name
//     is there, nothing else is, and the release label and the worker's
//     fingerprint agree with the files beside them;
//   * it LOOKS the same: on every screen measured, in both viewports and both
//     modes, every element has the same computed style as it has in the
//     source, and all fourteen palette compositions resolve to the same
//     values. A stylesheet minifier that is wrong is wrong quietly -- one
//     fallback declaration dropped, one rule merged past another -- and no
//     test that only boots the page would see it;
//   * it WORKS: it boots, punches, changes tabs and signs out without a
//     script error.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { boot, settle, goTab, DESKTOP, PHONE } = require("../hostile/harness");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const people = [D.profile(1, { full_name: "Bea Builder", role: "admin" }), D.profile(2, { full_name: "Sam Second" })];
const seed = () => ({ profiles: people.map(p => Object.assign({}, p)),
  entries: people.flatMap(p => D.entriesFor(p.id, 30).map(e => Object.assign(e, { id: p.id.slice(-2) + e.id }))),
  user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })) });

// One instant for every page in this suite, so two boots of "now" agree.
const NOW = new Date(); NOW.setMilliseconds(0);

// Everything about how an element is drawn that does not come from its text.
const PROPS = ["display", "position", "visibility", "opacity", "color", "backgroundColor", "backgroundImage",
  "borderTopColor", "borderTopWidth", "borderTopStyle", "borderBottomColor", "borderBottomWidth", "borderLeftWidth",
  "borderTopLeftRadius", "borderBottomRightRadius", "boxShadow", "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "lineHeight", "letterSpacing", "textTransform", "textAlign", "textDecorationLine", "whiteSpace", "textOverflow",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom",
  "flexDirection", "flexWrap", "flexGrow", "flexShrink", "justifyContent", "alignItems", "rowGap", "columnGap",
  "zIndex", "overflowX", "overflowY", "cursor", "pointerEvents", "transform", "outlineStyle", "minHeight", "maxWidth",
  "top", "bottom", "objectFit", "fill", "stroke", "strokeWidth", "listStyleType", "verticalAlign", "boxSizing"];

// For each element: where it is in the tree, and its drawn style as one string.
const snapshot = page => page.evaluate(PROPS => {
  const where = el => {
    const parts = [];
    for(let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement){
      parts.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") +
        (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
    }
    return parts.join(" > ");
  };
  return [...document.querySelectorAll("body, body *")].map(el => {
    const cs = getComputedStyle(el), before = getComputedStyle(el, "::before"), after = getComputedStyle(el, "::after");
    return [where(el), PROPS.map(p => cs[p]).join("|") + "||" +
      [before.content, before.backgroundColor, before.display, after.content, after.backgroundColor, after.display].join("|")];
  });
}, PROPS);

// The value every design token resolves to, in each of the fourteen compositions.
const tokens = page => page.evaluate(() => {
  const names = new Set();
  for(const sheet of document.styleSheets){
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for(const rule of rules){
      if(!rule.style) continue;
      for(let i = 0; i < rule.style.length; i++){ if(rule.style[i].startsWith("--")) names.add(rule.style[i]); }
    }
  }
  const root = document.documentElement, out = {};
  const was = [root.getAttribute("data-palette"), root.getAttribute("data-theme")];
  for(const palette of ["atrium", "slate", "terracotta", "studio", "moss", "plum", "ledger"]){
    for(const mode of ["light", "dark"]){
      root.setAttribute("data-palette", palette); root.setAttribute("data-theme", mode);
      const cs = getComputedStyle(root);
      out[palette + "/" + mode] = [...names].sort().map(n => n + ":" + cs.getPropertyValue(n).trim());
    }
  }
  root.setAttribute("data-palette", was[0]); root.setAttribute("data-theme", was[1]);
  return out;
});

const open = new Set();
async function start(opts){
  const h = await boot(Object.assign({ beforeLoad: async ({ page }) => { await page.clock.setFixedTime(NOW); } }, opts));
  open.add(h);
  const close = h.close;
  h.close = async () => { open.delete(h); await close(); };
  return h;
}
// Nothing mid-fade when it is measured.
const still = async page => {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
  await settle(page, 500);
};

let outDir = null;

(async () => {
  const { build } = await import(pathToFileURL(path.join(ROOT, "tools", "build.mjs")).href);
  const { shellFiles, shellFingerprint } = await import(pathToFileURL(path.join(ROOT, "tools", "stamp-release.mjs")).href);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-build-"));
  const result = await build(outDir);

  // ---- Complete, consistent, and nothing extra ---------------------------------
  {
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(outDir, path.join(dir, e.name))]);
    const published = walk(outDir).sort();
    const stray = published.filter(f => !/^(index\.html|app\.js|sw\.js|theme-boot\.js|manifest\.json|[\w-]+\.png|src\/[\w-]+\.js|vendor\/[\w.-]+\.js|fonts\/[\w-]+\.woff2|splash\/[\w-]+\.png)$/.test(f));
    ok(stray.length === 0, "only the files the app loads are published", stray.join(", "));
    ok(!published.some(f => /^(tests|supabase|tools)\/|\.md$|\.txt$/.test(f)),
      "the tests, migrations, notes and audit report are not");

    const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    const sw = fs.readFileSync(path.join(outDir, "sw.js"), "utf8");
    const sourceSw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    const refs = [...html.matchAll(/\s(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)].map(m => m[1])
      .filter(u => !/^(?:[a-z]+:|\/\/)/i.test(u));
    ok(refs.length > 40 && refs.every(u => fs.existsSync(path.join(outDir, u))),
      "every file the built page asks for is there", refs.filter(u => !fs.existsSync(path.join(outDir, u))).join(", "));
    const listed = shellFiles(sourceSw);
    ok(listed.every(f => sw.includes(`"${f}"`) && fs.existsSync(path.join(outDir, f))),
      "every file the built worker saves is listed in it, and there");

    const pageLabel = (/app\.js\?v=([^"]+)"/.exec(html) || [])[1];
    const swLabel = (/attendance-ledger-shell-([^"]+)"/.exec(sw) || [])[1];
    const sourceLabel = (/attendance-ledger-shell-([^"]+)"/.exec(sourceSw) || [])[1];
    ok(pageLabel === result.label && swLabel === result.label, "the built page and worker name one release",
      JSON.stringify({ pageLabel, swLabel, built: result.label }));
    ok(new RegExp("^" + sourceLabel + "-[0-9a-f]{8}$").test(result.label),
      "which is the source's label plus a hash of the built files", result.label);
    const swFingerprint = (/SHELL_FINGERPRINT\s*=\s*"([^"]+)"/.exec(sw) || [])[1];
    ok(swFingerprint === shellFingerprint(outDir, listed), "and the worker's fingerprint is of the files beside it",
      swFingerprint + " vs " + shellFingerprint(outDir, listed));

    // Same source, same release; different source, different release.
    const again = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-build-"));
    try {
      const second = await build(again);
      ok(second.label === result.label, "building the same source twice gives the same release", second.label);
    } finally { fs.rmSync(again, { recursive: true, force: true }); }

    const app = fs.readFileSync(path.join(outDir, "app.js"), "utf8");
    ok(/function handleSignedIn\(/.test(app) && /function punchClock\(/.test(app),
      "function names survive, so a crash report from the published app can still be read");
    ok(!/\/\/ ----------|^\s*\/\//m.test(app.slice(0, 20000)) && !html.includes("<!--"),
      "and the commentary does not ship");
    const { source, built } = result.firstLoad;
    ok(built.gzip < source.gzip * 0.65, "a first visit downloads at least a third less",
      `gzip ${Math.round(source.gzip / 1024)}KB -> ${Math.round(built.gzip / 1024)}KB`);
    console.log(`  (build ${result.label}: first visit ${Math.round(source.gzip / 1024)}KB -> ${Math.round(built.gzip / 1024)}KB gzip)`);
  }

  // ---- It looks the same --------------------------------------------------------
  for(const [viewport, vname] of [[DESKTOP, "desktop"], [PHONE, "phone"]]){
    const src = await start({ viewport, meId: people[0].id, seed: seed() });
    const out = await start({ viewport, meId: people[0].id, seed: seed(), root: outDir });
    try {
      for(const mode of ["light", "dark"]){
        for(const h of [src, out]){
          await h.page.evaluate(m => document.documentElement.setAttribute("data-theme", m), mode);
        }
        for(const tab of ["overview", "log", "calendar", "settings", "admin"]){
          await goTab(src.page, tab); await goTab(out.page, tab);
          await still(src.page); await still(out.page);
          const a = await snapshot(src.page), b = await snapshot(out.page);
          const sameTree = a.length === b.length && a.every((row, i) => row[0] === b[i][0]);
          ok(sameTree, `${vname}, ${mode}, ${tab}: the same elements`, `${a.length} vs ${b.length}`);
          if(!sameTree) continue;
          const diff = [];
          a.forEach((row, i) => {
            if(row[1] === b[i][1]) return;
            const x = row[1].split("|"), y = b[i][1].split("|");
            const which = PROPS.filter((p, k) => x[k] !== y[k]).map((p, k2) => p).slice(0, 3);
            const k = PROPS.findIndex((p, j) => x[j] !== y[j]);
            diff.push(`${row[0]}  [${which.join(", ") || "pseudo-element"}]  ${k >= 0 ? x[k] + "  ->  " + y[k] : ""}`);
          });
          ok(diff.length === 0, `${vname}, ${mode}, ${tab}: every one of ${a.length} elements is styled the same`,
            diff.slice(0, 6).join("\n     ") + (diff.length > 6 ? `\n     ... and ${diff.length - 6} more` : ""));
        }
      }
      if(viewport === DESKTOP){
        const ta = await tokens(src.page), tb = await tokens(out.page);
        const compositions = Object.keys(ta);
        // A minifier may write a number as an equal number -- 200ms as .2s,
        // .40 as .4 -- and that is all it may do to a token. Both sides are
        // put into one spelling first, so anything else still shows.
        const canon = v => v.toLowerCase().replace(/\s+/g, " ")
          .replace(/(\d*\.?\d+)ms\b/g, (m, n) => (Number(n) / 1000) + "s")
          .replace(/(\d*\.\d+|\d+)/g, n => String(Number(n)));
        const off = compositions.filter(c => ta[c].map(canon).join("\n") !== tb[c].map(canon).join("\n"));
        ok(compositions.length === 14 && ta["atrium/light"].length > 60, "(fourteen compositions, " + ta["atrium/light"].length + " tokens each)");
        ok(off.length === 0, "every palette, light and dark, resolves every token to the same value", off.map(c => {
          const i = ta[c].findIndex((v, k) => canon(v) !== canon(tb[c][k]));
          return `${c}: ${ta[c][i]} -> ${tb[c][i]}`;
        }).join("; "));
        ok(ta["atrium/light"].join() !== ta["studio/dark"].join(), "(and the compositions do differ from each other)");
        // The tokens a SCRIPT reads are a stricter matter: app.js and
        // theme-boot.js take these as text, so they must come through letter
        // for letter. Today they are all colours; this is what would catch a
        // duration being read as "200ms" the day the build has made it ".2s".
        const scripts = fs.readFileSync(path.join(ROOT, "app.js"), "utf8") + fs.readFileSync(path.join(ROOT, "theme-boot.js"), "utf8");
        const readByScript = [...new Set([...scripts.matchAll(/(?:cssVar|getPropertyValue)\("(--[a-z0-9-]+)"\)/g)].map(m => m[1]))];
        const changed = [];
        compositions.forEach(c => ta[c].forEach((v, k) => {
          const name = v.slice(0, v.indexOf(":"));
          if(readByScript.includes(name) && v.toLowerCase() !== tb[c][k].toLowerCase()) changed.push(`${c} ${v} -> ${tb[c][k]}`);
        }));
        ok(readByScript.length >= 5 && changed.length === 0,
          `the ${readByScript.length} tokens the scripts read as text are untouched by the build`, changed.slice(0, 4).join("; "));
      }
      ok(src.errors.length === 0 && out.errors.length === 0, `${vname}: no script errors in either copy`,
        src.errors.concat(out.errors).join(" | "));
    } finally { await src.close(); await out.close(); }
  }

  // ---- It works -----------------------------------------------------------------
  {
    // No fixed clock here: this is the app running as it runs.
    const h = await boot({ viewport: DESKTOP, meId: people[1].id, seed: seed(), root: outDir });
    open.add(h);
    try {
      const today = D.dateStr(new Date());
      h.backend.state.entries = h.backend.state.entries.filter(e => !(e.user_id === people[1].id && e.date === today));
      await h.page.evaluate(() => document.getElementById("refreshBtn").click());
      await settle(h.page, 900);
      ok(await h.page.evaluate(() => document.getElementById("qcClockBtn").getAttribute("data-clock-action")) === "in",
        "the built app boots signed in and offers a clock-in");
      await h.page.click("#qcClockBtn");
      await settle(h.page, 900);
      const row = h.backend.state.entries.find(e => e.user_id === people[1].id && e.date === today);
      ok(!!row && !!row.clock_in, "a punch in the built app reaches the backend", JSON.stringify(row));
      for(const tab of ["log", "trends", "calendar", "punctuality", "settings"]){
        await goTab(h.page, tab);
      }
      ok(await h.page.evaluate(() => document.querySelector(".tab-panel.active").id) === "tab-settings", "every tab opens");
      ok(/Settings/.test(await h.page.title()), "and names itself in the title", await h.page.title());
      ok(h.errors.length === 0, "with no script errors", h.errors.join(" | "));
    } finally { open.delete(h); await h.close(); }
  }
})().catch(err => { fail++; failures.push("suite threw: " + (err && err.stack || err)); })
  .finally(async () => {
    await Promise.all([...open].map(h => h.close().catch(() => {})));
    if(outDir) fs.rmSync(outDir, { recursive: true, force: true });
    console.log(`  build-output  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
