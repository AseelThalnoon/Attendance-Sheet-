// Every .form-grid cell must stay wide enough for a native date/time control.
// Chromium happily shrinks its own date input, so measuring the input proves
// nothing on its own — the floor is enforced on the grid TRACK, which is what
// a non-shrinking control (Safari/iOS) actually needs.
const { chromium } = require("playwright");
const { revealApp, showTab, listTabs } = require("./fixtures");

const FLOOR = 150;
const WIDTHS = [1280, 1024, 932, 900, 844, 820, 768, 760, 700, 600, 540, 481, 480, 430, 393, 375, 360, 320];

let fail = 0;
const problems = [];

(async () => {
  const browser = await chromium.launch();
  const rows = [];

  for(const width of WIDTHS){
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width <= 932, hasTouch: true });
    await page.goto("file:///workspaces/Attendance-Sheet-/index.html");
    await page.waitForTimeout(220);
    await revealApp(page, "light");

    const res = [];
    for(const tab of await listTabs(page)){
      await showTab(page, tab);
      await page.waitForTimeout(90);
      res.push(...await page.evaluate(floor => {
      const out = [];
      document.querySelectorAll(".form-grid").forEach((g, i) => {
        // An unrendered grid reports the unresolved "repeat(auto-fit, ...)"
        // string rather than pixel tracks, so only measure what is laid out.
        if(!g.getClientRects().length) return;
        const cs = getComputedStyle(g);
        const tracks = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).map(parseFloat);
        if(tracks.some(Number.isNaN)) return;
        const id = g.closest("[id]") ? g.closest("[id]").id : "grid" + i;
        // .full must still span the whole row.
        const full = g.querySelector(".full");
        let fullSpansRow = null;
        if(full){
          const fr = full.getBoundingClientRect();
          const gr = g.getBoundingClientRect();
          const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
          fullSpansRow = Math.abs(fr.width - (gr.width - padL - padR)) < 2;
        }
        out.push({
          id, tracks: tracks.map(t => +t.toFixed(1)),
          min: tracks.length ? +Math.min(...tracks).toFixed(1) : null,
          cols: tracks.length,
          fullSpansRow,
          belowFloor: tracks.some(t => t < floor - 0.5)
        });
      });
      return out;
      }, FLOOR));
    }

    const seen = new Set();
    res.filter(r => !seen.has(r.id) && seen.add(r.id)).forEach(r => {
      rows.push({ width, ...r });
      if(r.belowFloor){
        fail++;
        problems.push(`${width}px  ${r.id}: track ${r.min}px < ${FLOOR}px floor (${r.cols} cols)`);
      }
      if(r.fullSpansRow === false){
        fail++;
        problems.push(`${width}px  ${r.id}: .full no longer spans the full row`);
      }
    });
    await page.close();
  }

  const byWidth = {};
  rows.forEach(r => { (byWidth[r.width] ||= []).push(`${r.id}=${r.cols}col/${r.min}px`); });
  Object.keys(byWidth).sort((a, b) => b - a).forEach(w =>
    console.log(`  ${String(w).padStart(4)}px  ${byWidth[w].join("  ")}`));

  console.log(problems.length ? "\nPROBLEMS:" : `\nall ${rows.length} grid measurements >= ${FLOOR}px floor, .full spans intact`);
  problems.forEach(p => console.log("  " + p));

  await browser.close();
  process.exit(fail ? 1 : 0);
})();
