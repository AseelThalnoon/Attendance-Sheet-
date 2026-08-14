// Overlap/collision scanner for form controls at phone widths.
//
// Checks three distinct failure shapes:
//   1. box overlap   — two rendered elements' rectangles intersect
//   2. content clip  — an element's own content is taller than its box
//                      (scrollHeight > clientHeight), which is what a fixed
//                      height does to a native date/time control that needs
//                      more room; the control then paints over its neighbour
//   3. label overlap — a field's label rectangle intersects its control
//
// Real phone metrics matter here: deviceScaleFactor and isMobile change how
// native controls are sized, and a control that fits at 14px desktop may not
// at the larger size mobile engines use.
const { chromium, devices } = require("playwright");
const PAGE_URL = process.env.ATTENDANCE_URL || "file:///workspaces/Attendance-Sheet-/index.html";
const { revealApp } = require("./fixtures");

const WIDTHS = [430, 414, 393, 390, 375, 360, 320];
const THEMES = ["light", "dark"];

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail ? "\n     " + detail : ""}`); }
}

const SCAN = () => {
  const out = { overlaps: [], clipped: [], labelOverlaps: [] };
  const name = el => el.id || (el.tagName.toLowerCase() + "." + String(el.className || "").trim().split(/\s+/)[0]);
  const rects = [];

  document.querySelectorAll(".form-grid").forEach(grid => {
    if(!grid.getClientRects().length) return;
    grid.querySelectorAll("input, select, label").forEach(el => {
      if(!el.getClientRects().length) return;
      const r = el.getBoundingClientRect();
      if(r.width <= 0 || r.height <= 0) return;
      rects.push({ el, r, tag: el.tagName, id: name(el) });

      // Content taller than the box it is given.
      if(el.tagName !== "LABEL"){
        const overflowY = el.scrollHeight - el.clientHeight;
        if(overflowY > 1){
          out.clipped.push({
            id: name(el), type: el.type,
            scrollH: el.scrollHeight, clientH: el.clientHeight, by: overflowY,
            declaredH: getComputedStyle(el).height
          });
        }
      }
    });
  });

  // Pairwise rectangle intersection, ignoring a label and the control it
  // belongs to being merely adjacent.
  const intersects = (a, b) =>
    a.left < b.right - 0.5 && b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  for(let i = 0; i < rects.length; i++){
    for(let j = i + 1; j < rects.length; j++){
      const A = rects[i], B = rects[j];
      if(!intersects(A.r, B.r)) continue;
      const pair = { a: A.id, b: B.id,
        aRect: { t: +A.r.top.toFixed(1), b: +A.r.bottom.toFixed(1), l: +A.r.left.toFixed(1), r: +A.r.right.toFixed(1) },
        bRect: { t: +B.r.top.toFixed(1), b: +B.r.bottom.toFixed(1), l: +B.r.left.toFixed(1), r: +B.r.right.toFixed(1) } };
      if(A.tag === "LABEL" || B.tag === "LABEL") out.labelOverlaps.push(pair);
      else out.overlaps.push(pair);
    }
  }
  return out;
};

(async () => {
  const browser = await chromium.launch();

  for(const theme of THEMES){
    for(const width of WIDTHS){
      const page = await browser.newPage({
        viewport: { width, height: 900 }, colorScheme: theme,
        deviceScaleFactor: 3, isMobile: true, hasTouch: true
      });
      await page.goto(PAGE_URL);
      await page.waitForTimeout(250);
      await revealApp(page, theme);
      await page.waitForTimeout(150);
      const res = await page.evaluate(SCAN);

      ok(res.overlaps.length === 0,
        `[${theme}/${width}px] no control-to-control overlap`,
        res.overlaps.slice(0, 3).map(o => `${o.a} vs ${o.b}  ${JSON.stringify(o.aRect)} / ${JSON.stringify(o.bRect)}`).join("\n     "));
      ok(res.labelOverlaps.length === 0,
        `[${theme}/${width}px] no label-to-control overlap`,
        res.labelOverlaps.slice(0, 3).map(o => `${o.a} vs ${o.b}`).join("\n     "));
      ok(res.clipped.length === 0,
        `[${theme}/${width}px] no control clips its own content`,
        res.clipped.slice(0, 4).map(c => `${c.id} (${c.type}) content ${c.scrollH}px in ${c.clientH}px box, over by ${c.by}px, height:${c.declaredH}`).join("\n     "));

      await page.close();
    }
  }

  // Chromium will not reproduce iOS's native date/time widget, which is
  // taller than Chromium's. Forcing the control font up is a proxy for that:
  // the layout must absorb a taller control instead of clipping it or letting
  // it paint over a neighbour. A fixed height:42px fails this; stretched grid
  // cells pass it.
  for(const fontPx of [17, 20]){
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true
    });
    await page.goto(PAGE_URL);
    await page.waitForTimeout(250);
    await revealApp(page, "light");
    await page.addStyleTag({ content:
      `input[type="date"],input[type="time"],input[type="text"],input[type="number"],select{font-size:${fontPx}px !important;}` });
    await page.waitForTimeout(200);
    const res = await page.evaluate(SCAN);
    ok(res.clipped.length === 0,
      `[390px, control font forced to ${fontPx}px] taller control is absorbed, not clipped`,
      res.clipped.slice(0, 4).map(c => `${c.id} (${c.type}) content ${c.scrollH}px in ${c.clientH}px box, height:${c.declaredH}`).join("\n     "));
    ok(res.overlaps.length === 0,
      `[390px, control font forced to ${fontPx}px] no control-to-control overlap`,
      res.overlaps.slice(0, 3).map(o => `${o.a} vs ${o.b}`).join("\n     "));
    await page.close();
  }

  // Also run one real device profile, whose metrics differ from a bare viewport.
  for(const profile of ["iPhone 13", "iPhone SE", "Pixel 7"]){
    const dev = devices[profile];
    if(!dev) continue;
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    await page.goto(PAGE_URL);
    await page.waitForTimeout(250);
    await revealApp(page, "light");
    await page.waitForTimeout(150);
    const res = await page.evaluate(SCAN);
    ok(res.overlaps.length === 0 && res.clipped.length === 0 && res.labelOverlaps.length === 0,
      `[${profile}] no overlap or clipped content`,
      [...res.overlaps.map(o => `overlap ${o.a} vs ${o.b}`),
       ...res.labelOverlaps.map(o => `label ${o.a} vs ${o.b}`),
       ...res.clipped.map(c => `clip ${c.id} (${c.type}) ${c.scrollH}>${c.clientH} height:${c.declaredH}`)].slice(0, 5).join("\n     "));
    await ctx.close();
  }

  await browser.close();
  console.log(`  collision pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
