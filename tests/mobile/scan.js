// Mobile layout + contrast scanner for the real index.html.
//
// Reports, per theme and phone width:
//   - overflow: elements escaping the viewport, and containers whose content
//     overflows them horizontally
//   - contrast: visible text whose colour is too close to the background it
//     actually sits on (ancestors walked until something opaque)
//
// Run:  npm run test:mobile          (fails the run if anything is found)
//       node mobile/scan.js --json   (machine-readable)
const { chromium } = require("playwright");
const { revealApp, showTab, listTabs, buildGallery } = require("./fixtures");

const WIDTHS = [430, 393, 375, 360, 320];
const THEMES = ["light", "dark"];
const AS_JSON = process.argv.includes("--json");

function lum([r, g, b]){
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (fg, bg) => {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const COLLECT = () => {
  const parse = c => {
    const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const effectiveBg = el => {
    let node = el;
    while(node && node.nodeType === 1){
      const cs = getComputedStyle(node);
      if(cs.backgroundImage && cs.backgroundImage !== "none") return { gradient: true };
      const p = parse(cs.backgroundColor);
      if(p && p.a >= 0.95) return { rgb: p.rgb };
      node = node.parentElement;
    }
    return { rgb: [255, 255, 255] };
  };
  const visible = el => {
    const cs = getComputedStyle(el);
    if(cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const path = el => {
    const bits = [];
    let n = el;
    for(let i = 0; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement){
      const cls = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      bits.unshift(n.id ? "#" + n.id : n.tagName.toLowerCase() + cls);
    }
    return bits.join(" > ");
  };
  const inScroller = el => {
    let n = el.parentElement;
    while(n){
      if(/(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
      n = n.parentElement;
    }
    return false;
  };

  const overflow = [], contrast = [];
  const docW = document.documentElement.clientWidth;

  document.querySelectorAll("body *").forEach(el => {
    if(el.closest("#__probeGallery") || el.id === "__probeGallery"){
      // Gallery probes are synthetic: scan them for contrast only.
    } else if(visible(el)){
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if(r.width > 0 && (r.right > docW + 1 || r.left < -1) && cs.position !== "fixed" && !inScroller(el)){
        overflow.push({
          kind: "viewport", sel: path(el),
          right: +r.right.toFixed(1), docW, overBy: +(r.right - docW).toFixed(1),
          text: (el.textContent || "").trim().slice(0, 40)
        });
      }
      if(el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !/(auto|scroll)/.test(cs.overflowX)){
        overflow.push({
          kind: "content", sel: path(el),
          clientW: el.clientWidth, scrollW: el.scrollWidth,
          overBy: el.scrollWidth - el.clientWidth,
          text: (el.textContent || "").trim().slice(0, 40)
        });
      }
    }

    if(!visible(el)) return;
    const cs = getComputedStyle(el);
    const ownText = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3 && n.textContent.trim())
      .map(n => n.textContent.trim()).join(" ");
    if(!ownText) return;
    const fg = parse(cs.color);
    const bg = effectiveBg(el);
    if(!fg || bg.gradient || fg.a < 0.95) return;
    contrast.push({
      sel: el.dataset && el.dataset.probe ? el.dataset.probe : path(el),
      probe: !!(el.dataset && el.dataset.probe),
      text: ownText.slice(0, 40),
      fg: fg.rgb, bg: bg.rgb,
      fontSize: parseFloat(cs.fontSize),
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 700
    });
  });

  return { overflow, contrast };
};

(async () => {
  const browser = await chromium.launch();
  const overflows = new Map(), contrasts = new Map();
  let selectorCount = 0;

  for(const theme of THEMES){
    for(const width of WIDTHS){
      const page = await browser.newPage({
        viewport: { width, height: 860 }, colorScheme: theme,
        deviceScaleFactor: 2, isMobile: true, hasTouch: true
      });
      await page.goto("file:///workspaces/Attendance-Sheet-/index.html");
      await page.waitForTimeout(300);
      await revealApp(page, theme);
      selectorCount = await buildGallery(page);

      for(const tab of await listTabs(page)){
        await showTab(page, tab);
        await page.waitForTimeout(120);
        const res = await page.evaluate(COLLECT);

        res.overflow.forEach(o => {
          const key = `${theme}|${o.kind}|${o.sel}`;
          if(!overflows.has(key)) overflows.set(key, { ...o, theme, tab, widths: new Set() });
          overflows.get(key).widths.add(width);
        });
        res.contrast.forEach(c => {
          const r = ratio(c.fg, c.bg);
          const large = c.fontSize >= 24 || (c.bold && c.fontSize >= 18.66);
          const min = large ? 3 : 4.5;
          if(r >= min) return;
          const key = `${theme}|${c.sel}|${c.text}`;
          if(!contrasts.has(key)) contrasts.set(key, { ...c, theme, ratio: +r.toFixed(2), min, widths: new Set() });
          contrasts.get(key).widths.add(width);
        });
      }
      await page.close();
    }
  }

  const ov = [...overflows.values()].sort((a, b) => b.overBy - a.overBy);
  const ct = [...contrasts.values()].sort((a, b) => a.ratio - b.ratio);
  const fmt = s => [...s].join(",");

  if(AS_JSON){
    console.log(JSON.stringify({
      overflow: ov.map(o => ({ ...o, widths: fmt(o.widths) })),
      contrast: ct.map(c => ({ ...c, widths: fmt(c.widths) }))
    }, null, 2));
  } else {
    console.log(`\nprobed ${selectorCount} colour-setting selectors from the real stylesheet`);
    console.log(`\n=== HORIZONTAL OVERFLOW (${ov.length}) ===`);
    ov.forEach(o => console.log(
      `  [${o.theme}/${o.tab}] ${o.kind} over by ${o.overBy}px @ ${fmt(o.widths)}\n      ${o.sel}\n      "${o.text}"`));
    if(!ov.length) console.log("  none");

    console.log(`\n=== LOW CONTRAST (${ct.length}) ===`);
    ct.forEach(c => console.log(
      `  [${c.theme}] ${c.ratio}:1 (needs ${c.min})${c.probe ? " PROBE" : ""}  ${c.sel}\n      "${c.text}" fg=rgb(${c.fg}) bg=rgb(${c.bg})`));
    if(!ct.length) console.log("  none");
  }

  await browser.close();
  process.exit(ov.length || ct.length ? 1 : 0);
})();
