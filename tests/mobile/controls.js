// Form-control consistency.
//
// 1. Every control in a .form-grid must be the same height. A native
//    <input type=time> renders a segmented control taller than min-height,
//    so it sat at 42.69px beside 42px date/number/select fields in the same
//    row — visibly uneven boxes.
//
// 2. A <select> styled light-on-dark for a dark surface must still give its
//    <option> elements a readable pair: the open dropdown is painted by the
//    browser on a system background, not on the styled surface. Getting this
//    wrong makes the list invisible on desktop while mobile looks fine,
//    because mobile uses the OS picker.
const { chromium } = require("playwright");
const PAGE_URL = process.env.ATTENDANCE_URL || "file:///workspaces/Attendance-Sheet-/index.html";
const { revealApp } = require("./fixtures");

const WIDTHS = [1280, 900, 430, 375];
const THEMES = ["light", "dark"];

function lum([r, g, b]){
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
};
const px = c => { const m = String(c).match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail ? "\n     " + detail : ""}`); }
}

(async () => {
  const browser = await chromium.launch();

  for(const theme of THEMES){
    for(const width of WIDTHS){
      const page = await browser.newPage({ viewport: { width, height: 950 }, colorScheme: theme });
      await page.goto(PAGE_URL);
      await page.waitForTimeout(250);
      await revealApp(page, theme);
      await page.evaluate(() => {
        const vs = document.getElementById("viewerSwitchWrap");
        if(vs) vs.style.display = "flex";
        const sel = document.querySelector(".viewer-switch select");
        if(sel && !sel.options.length) ["Viewing: Me", "Sara Ahmed"].forEach(t => sel.add(new Option(t, t)));
      });
      await page.waitForTimeout(150);

      // --- 1. controls sharing a row must share a height ---
      // Per row, not globally: only fields sitting side by side are compared
      // by eye. Controls on different rows may legitimately differ by the
      // fraction of a pixel a native time widget adds, and forcing a single
      // global height means pinning a fixed height, which clips that widget
      // on engines that need more room.
      const rows = await page.evaluate(() => {
        const byRow = {};
        document.querySelectorAll(".form-grid input, .form-grid select").forEach(el => {
          if(!el.getClientRects().length) return;
          const r = el.getBoundingClientRect();
          const key = Math.round(r.top);
          (byRow[key] ||= []).push({ id: el.id || el.type, h: +r.height.toFixed(2) });
        });
        return byRow;
      });
      const badRows = Object.entries(rows)
        .filter(([, items]) => items.length > 1 && new Set(items.map(i => i.h)).size > 1)
        .map(([top, items]) => `row@${top}: ` + items.map(i => `${i.id}=${i.h}`).join(", "));
      ok(badRows.length === 0,
        `[${theme}/${width}px] controls sharing a row share a height`,
        badRows.slice(0, 3).join("\n     "));

      // --- 2. dropdown options readable on a system-painted popup ---
      const opt = await page.evaluate(() => {
        const sel = document.querySelector(".viewer-switch select");
        if(!sel || !sel.options.length) return null;
        const ocs = getComputedStyle(sel.options[0]);
        const scs = getComputedStyle(sel);
        return { color: ocs.color, bg: ocs.backgroundColor, selectColor: scs.color };
      });
      if(opt){
        const fg = px(opt.color), bg = px(opt.bg);
        const bgOpaque = bg && !/rgba\([^)]*,\s*0\s*\)/.test(opt.bg);
        ok(!!bgOpaque,
          `[${theme}/${width}px] viewer-switch option declares its own background`,
          `option bg = ${opt.bg} (transparent lets the popup's system colour show through)`);
        if(bgOpaque){
          const r = ratio(fg, bg);
          ok(r >= 4.5,
            `[${theme}/${width}px] viewer-switch option text is readable on its own background (${r}:1)`,
            `fg=${opt.color} bg=${opt.bg}`);
        }
        // The original bug shape: options silently inheriting the select's
        // near-white colour, which is styled for the dark header and lands
        // on a system-painted popup. The option pair must be independent of
        // it — checked as "not merely inherited", since a colour locked to
        // the popup (Canvas/CanvasText) may legitimately be light or dark
        // depending on the browser's own scheme.
        ok(opt.color !== opt.selectColor,
          `[${theme}/${width}px] option colour is not inherited from the select`,
          `option fg=${opt.color} select fg=${opt.selectColor}`);
      }

      await page.close();
    }
  }

  await browser.close();
  console.log(`  controls  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
