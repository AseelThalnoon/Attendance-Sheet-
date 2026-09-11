// The iOS/iPadOS integration, which is mostly invisible until it is wrong on a
// real device -- and the device is not in this environment. So each of these
// asserts the thing that CAN be checked here: that the declaration exists, that
// the file it points at is real, and where it is measurable, that the rendered
// value is right on a touch pointer.
//
// The one that is genuinely measured is the control font size. iOS Safari zooms
// the whole page in when a control smaller than 16px takes focus and never
// zooms back out, which is the difference between a usable form on a phone and
// a magnified one.
//
// Regenerate the launch screens with (from the repo root):
//   python3 - <<'PY'
//   from PIL import Image
//   ... see the block in this file's git history, or scale icon-512.png onto a
//   #111110 ground at each device size and save as splash/<w>x<h>.png
//   PY
const fs = require("fs");
const path = require("path");
const { boot, settle, PHONE } = require("../hostile/harness");
const D = require("../hostile/data");

const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

(async () => {
  // ---- meta ----
  ok(/viewport-fit=cover/.test(html),
    "the viewport opts into the full screen, so env(safe-area-inset-*) is non-zero");
  ok(/name="apple-mobile-web-app-capable"\s+content="yes"/.test(html),
    "iOS is told the app runs standalone");
  ok(/name="mobile-web-app-capable"\s+content="yes"/.test(html),
    "and so is every other engine, through the standardised spelling");
  ok(/name="format-detection"[^>]*telephone=no/.test(html) &&
     /name="format-detection"[^>]*date=no/.test(html),
    "iOS is stopped from turning dates and times into tappable links",
    "this app is made of them: 'Sep 10, 2026', '08:00', '4h 30m' all qualify");
  ok(/name="apple-mobile-web-app-title"/.test(html),
    "the home-screen name is set rather than derived from <title>");
  ok(/rel="apple-touch-icon"[^>]*180x180/.test(html),
    "a 180x180 home-screen icon is declared");

  // ---- CSS that only matters on iOS ----
  ok(/-webkit-text-size-adjust:\s*100%/.test(html),
    "text is not inflated when an iPhone is rotated");
  ok(/-webkit-tap-highlight-color:\s*transparent/.test(html),
    "the grey tap rectangle is suppressed in favour of the app's own :active states");

  // 100vh is the viewport with the address bar HIDDEN on iOS, so a 100vh box is
  // taller than the screen. Every use needs a dvh companion.
  const vhUses = (html.match(/[^d]100vh/g) || []).length;
  const dvhUses = (html.match(/100dvh/g) || []).length;
  ok(dvhUses >= vhUses, "every 100vh has a 100dvh companion",
    `${vhUses} uses of 100vh against ${dvhUses} of 100dvh -- an unpaired one is cut off under Safari's chrome`);

  // ---- landscape ----
  // Rotate an iPhone and the sensor housing takes one END of every full-width
  // fixed bar. The bottom inset was already handled for the home indicator.
  ok(/safe-area-inset-left/.test(html) && /safe-area-inset-right/.test(html),
    "fixed bars reserve the landscape notch insets");
  const navRule = html.slice(html.indexOf(".bottom-nav{"), html.indexOf(".bottom-nav{") + 600);
  ok(/safe-area-inset-left/.test(navRule) && /safe-area-inset-right/.test(navRule),
    "the bottom nav specifically does -- it is the bar a thumb uses",
    "in landscape its first or last destination sits under the notch");

  // ---- properties Safari still wants prefixed ----
  // WebKit either needs the -webkit- form or has only ever had it. An
  // unprefixed declaration on its own is not a degraded effect on Apple
  // hardware, it is no effect: backdrop-filter does nothing, a mask does not
  // clip, a themed scrollbar stays the system one. Checked per CSS block, so
  // "the file contains both somewhere" is not mistaken for "this rule has
  // both".
  {
    const css = html.slice(html.indexOf("<style>"), html.lastIndexOf("</style>"));
    // Crude but sufficient: split on "}" and treat each fragment as a block.
    const blocks = css.split("}");
    const NEED = ["backdrop-filter", "mask", "appearance", "user-select", "box-decoration-break"];
    const unpaired = [];
    for(const b of blocks){
      for(const prop of NEED){
        // the property, not preceded by a dash (so -webkit-mask does not match "mask")
        const bare = new RegExp("(^|[;{\\s])" + prop + "\\s*:", "m");
        if(!bare.test(b)) continue;
        if(b.includes("-webkit-" + prop + ":")) continue;
        const sel = (b.split("{")[0] || "").trim().split("\n").pop().slice(0, 60);
        unpaired.push(`${prop} in "${sel}"`);
      }
    }
    ok(unpaired.length === 0,
      "every Safari-prefixed property is declared in both forms in the same rule",
      unpaired.slice(0, 5).join(", "));

    // scrollbar-width/-color is the inverse case: Safari only gained the
    // standard properties in 18.2, so a themed scrollbar needs the -webkit-
    // pseudo-element or it stays the system one on every Apple device.
    // Per selector, not per count: "the file has 14 -webkit- rules somewhere"
    // says nothing about whether THIS scroll surface has one, and a count
    // comparison stays green while an individual rule is deleted.
    const unthemed = [];
    for(const b of blocks){
      if(!/scrollbar-width\s*:\s*thin/.test(b)) continue;
      const sel = (b.split("{")[0] || "").trim().split("\n").pop().trim();
      if(!sel) continue;
      // The selector may be compound; take its last simple part, which is what
      // the ::-webkit- rule is written against.
      const base = sel.split(",")[0].trim();
      if(!css.includes(base + "::-webkit-scrollbar-thumb")) unthemed.push(base);
    }
    ok(unthemed.length === 0,
      "every themed scrollbar has its own ::-webkit-scrollbar-thumb rule",
      unthemed.join(", ") + " -- Safari only gained scrollbar-width in 18.2, so these " +
      "show the system scrollbar beside themed ones on Apple hardware");
  }

  // ---- launch screens ----
  const splash = [...html.matchAll(/rel="apple-touch-startup-image"\s+href="([^"]+)"/g)].map(m => m[1]);
  ok(splash.length > 0, "launch screens are declared",
    "without one matching EXACTLY, an installed iOS PWA boots to a blank white rectangle");
  const missing = splash.filter(f => !fs.existsSync(path.join(ROOT, f)));
  ok(missing.length === 0, "every declared launch screen exists on disk",
    missing.slice(0, 4).join(", "));
  const withMedia = [...html.matchAll(/rel="apple-touch-startup-image"[^>]*media="([^"]+)"/g)];
  ok(withMedia.length === splash.length,
    "every launch screen carries a media query",
    "iOS matches on the query alone; one without it is never used");
  ok(withMedia.every(m => /orientation:\s*(portrait|landscape)/.test(m[1])),
    "each names an orientation, so a rotated launch is covered too");

  // Precaching 800KB of launch screens would bloat the offline shell, and
  // cache.addAll rejects the whole precache if any single entry 404s.
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  ok(!/splash\//.test(sw), "launch screens are kept out of the service worker precache",
    "cache.addAll is all-or-nothing, and none of these are needed offline");

  // ---- the one thing worth measuring in a browser ----
  const people = D.roster(4), me = people[0];
  const h = await boot({ viewport: PHONE, meId: me.id, seed: {
    profiles: people, entries: D.entriesFor(me.id, 6),
    user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
  }});
  await settle(h.page, 600);
  // Go where the controls actually are. Measured on the landing screen this
  // check found nothing visible and passed while the rule it tests was
  // deleted -- a vacuous pass, which is worse than no test. The count guard
  // below is what stops that recurring.
  const { goTab } = require("../hostile/harness");
  await goTab(h.page, "settings");
  await settle(h.page, 400);
  await h.page.evaluate(() => {
    const b = document.querySelector('#settingsConsole .console-nav-item[data-console-target="hours"]');
    if(b) b.click();
  });
  await settle(h.page, 350);
  const r = await h.page.evaluate(() => {
    const coarse = matchMedia("(pointer: coarse)").matches;
    const small = [];
    document.querySelectorAll("input, select, textarea").forEach(el => {
      if(!el.getClientRects().length) return;
      if(el.type === "checkbox" || el.type === "radio") return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if(fs < 16) small.push({ id: el.id || el.name || el.type, fs });
    });
    let visible = 0;
    document.querySelectorAll("input, select, textarea").forEach(el => {
      if(!el.getClientRects().length) return;
      if(el.type === "checkbox" || el.type === "radio") return;
      visible++;
    });
    return { coarse, small, visible };
  });
  ok(r.coarse, "the harness really is emulating a touch pointer",
    "without pointer:coarse this measurement proves nothing");
  ok(r.visible >= 5, "there are real controls on screen to measure",
    `only ${r.visible} visible -- this check would pass without proving anything`);
  ok(r.small.length === 0,
    "no visible control is under 16px on a touch device",
    r.small.slice(0, 6).map(c => `${c.id} at ${c.fs}px`).join(", ") +
      " -- iOS zooms the page in on focus and does not zoom back out");
  await h.close();

  console.log(`  ios       pass ${pass}   fail ${fail}`);
  if(fail){ failures.forEach(f => console.log("  FAIL " + f)); process.exitCode = 1; }
})().catch(err => { console.error(err); process.exitCode = 1; });
