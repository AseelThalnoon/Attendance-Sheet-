// Whole-app layout integrity: nothing overlaps, nothing is pushed off screen,
// and no page scrolls sideways -- across every tab, both consoles, the
// notification panel, the entry modal, and both themes.
//
// The existing mobile/collision.js checks form controls inside .form-grid.
// This is the other half: the screens themselves. It exists because the bug it
// found first -- the Seasonal Hours title column collapsing to 55px at 320px
// while its two action buttons took the row -- produced no overlap, no
// overflow and no error. The column simply got narrow, and a description
// rendered one word per line. Nothing would ever have failed.
//
// Three deliberate patterns are NOT collisions and are filtered out, because
// each one looks exactly like clipping to a naive scan:
//   * visually-hidden text (.sr-only, .visually-hidden, .cell-label, and the
//     phone Log's .row-actions) is a 1px clipped box BY DEFINITION -- that is
//     the technique, and :focus-within restores the last one;
//   * anything inside a scrolling container is reachable, not clipped: the
//     Log's table, the console nav and this panel all scroll on purpose;
//   * anything under a fixed/sticky/absolute ancestor is an overlay doing its
//     job -- the bottom nav, the sticky clock, toasts.
const { boot, settle, goTab } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail ? "\n     " + detail : ""}`); }
}

const SCAN = () => {
  const out = { pageOverflow: 0, overlaps: [], offscreen: [], squeezed: [] };
  const doc = document.documentElement;
  out.pageOverflow = Math.round(doc.scrollWidth - doc.clientWidth);
  const vw = doc.clientWidth;

  const HIDDEN = ".sr-only, .visually-hidden, .cell-label, .row-actions";
  const nameOf = el => {
    const c = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
    return (el.id ? "#" + el.id : "") +
      (c.trim() ? "." + c.trim().split(/\s+/).slice(0, 2).join(".") : el.tagName.toLowerCase());
  };
  const vis = el => {
    if(el.matches && el.matches(HIDDEN)) return false;
    if(el.closest && el.closest(HIDDEN)) return false;
    if(!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const underPositioned = el => {
    let n = el.parentElement;
    while(n && n !== document.body){
      const p = getComputedStyle(n).position;
      if(p === "fixed" || p === "sticky" || p === "absolute") return true;
      n = n.parentElement;
    }
    return false;
  };
  const inScrollable = el => {
    let n = el.parentElement;
    while(n && n !== document.body){
      const cs = getComputedStyle(n);
      if(["auto","scroll"].includes(cs.overflowX) || ["auto","scroll"].includes(cs.overflowY)) return true;
      n = n.parentElement;
    }
    return false;
  };

  const all = Array.from(document.querySelectorAll("body *")).filter(vis);

  all.forEach(el => {
    const r = el.getBoundingClientRect();
    if(r.width < 1 || r.height < 1) return;
    const cs = getComputedStyle(el);
    if(r.right > vw + 1 && cs.position !== "fixed" && !inScrollable(el)){
      out.offscreen.push({ el: nameOf(el), right: Math.round(r.right), vw });
    }
    // A text block squeezed into a column too narrow to read. Measured in LINES,
    // not scrollHeight: squeezed text wraps rather than overflowing, so its
    // scrollHeight equals its height and every overflow-based check says it is
    // fine. What is actually wrong is the shape -- forty characters rendered
    // down a 55px column as a dozen one-word lines.
    const textLeaf = el.children.length === 0 && (el.textContent || "").trim().length > 40;
    if(textLeaf && !underPositioned(el) && r.width > 0 && r.width < 120){
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.4;
      const lines = Math.round(r.height / lh);
      if(lines >= 6){
        out.squeezed.push({ el: nameOf(el), w: Math.round(r.width), lines,
          txt: (el.textContent || "").trim().slice(0, 40) });
      }
    }
  });

  const leaves = all.filter(el => {
    const cs = getComputedStyle(el);
    if(["fixed","absolute","sticky"].includes(cs.position)) return false;
    if(cs.pointerEvents === "none") return false;
    if(el.closest("table")) return false;
    if(el.closest("[aria-hidden='true']")) return false;
    if(underPositioned(el) || inScrollable(el)) return false;
    const interactive = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName);
    const textLeaf = el.children.length === 0 && (el.textContent || "").trim().length > 0;
    return interactive || textLeaf;
  });
  for(let i = 0; i < leaves.length; i++){
    for(let j = i + 1; j < leaves.length; j++){
      const A = leaves[i], B = leaves[j];
      if(A.contains(B) || B.contains(A)) continue;
      const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if(ox > 1 && oy > 1) out.overlaps.push({ a: nameOf(A), b: nameOf(B), ox: Math.round(ox), oy: Math.round(oy) });
    }
  }
  return out;
};

const VIEWPORTS = [
  { w: 320, h: 700 }, { w: 393, h: 852 }, { w: 768, h: 1024 },
  { w: 1100, h: 800 }, { w: 1440, h: 900 }
];

(async () => {
  const people = D.roster(9);
  const me = people[0];

  for(const theme of ["light", "dark"]){
    for(const vp of VIEWPORTS){
      // Dark only needs one width: the palettes are generated and measured by
      // palette-contrast.js; what changes here is colour, not geometry.
      if(theme === "dark" && vp.w !== 393) continue;

      const h = await boot({ viewport: { width: vp.w, height: vp.h }, meId: me.id, seed: {
        profiles: people,
        entries: [].concat(D.entriesFor(me.id, 30), D.entriesFor(people[1].id, 10)),
        user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
      }});
      if(theme === "dark") await h.page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await settle(h.page, 600);

      const check = async (where) => {
        const r = await h.page.evaluate(SCAN);
        const at = `[${theme} ${vp.w}px] ${where}`;
        ok(r.pageOverflow <= 1, `${at} — the page does not scroll sideways`,
          `document is ${r.pageOverflow}px wider than the viewport`);
        ok(r.overlaps.length === 0, `${at} — nothing overlaps`,
          r.overlaps.slice(0, 3).map(o => `${o.a} over ${o.b} by ${o.ox}x${o.oy}px`).join("\n     "));
        ok(r.offscreen.length === 0, `${at} — nothing is pushed off the right edge`,
          r.offscreen.slice(0, 3).map(o => `${o.el} ends at ${o.right} in ${o.vw}`).join("\n     "));
        ok(r.squeezed.length === 0, `${at} — no text is squeezed into an unreadable column`,
          r.squeezed.slice(0, 3).map(o => `${o.el} is ${o.w}px wide over ${o.lines} lines: "${o.txt}"`).join("\n     "));
      };

      for(const tab of ["overview","log","trends","calendar","punctuality","team","settings","admin"]){
        try { await goTab(h.page, tab); } catch(e){ continue; }
        await settle(h.page, 400);
        await check(tab);
      }

      // Every console section, in both consoles: the Seasonal Hours collapse
      // only appeared once that section was the one showing.
      for(const [tab, rootId] of [["settings","settingsConsole"], ["admin","adminConsole"]]){
        await goTab(h.page, tab);
        await settle(h.page, 300);
        const names = await h.page.evaluate(id => Array.from(
          document.querySelectorAll("#" + id + " .console-nav-item"))
            .map(b => b.getAttribute("data-console-target")), rootId);
        for(const n of names){
          await h.page.evaluate(([id, nm]) => {
            document.querySelector("#" + id + ' .console-nav-item[data-console-target="' + nm + '"]').click();
          }, [rootId, n]);
          await settle(h.page, 250);
          await check(`${tab}:${n}`);
        }
      }

      await goTab(h.page, "overview");
      await settle(h.page, 250);
      await h.page.evaluate(() => document.getElementById("notifBtn").click());
      await settle(h.page, 400);
      await check("notification panel");
      await h.page.keyboard.press("Escape");
      await settle(h.page, 300);

      await goTab(h.page, "log");
      await settle(h.page, 300);
      await h.page.evaluate(() => { const b = document.getElementById("addEntryBtn"); if(b) b.click(); });
      await settle(h.page, 400);
      await check("entry modal");

      await h.close();
    }
  }

  // ---- the collision a DOM scan cannot see -------------------------------
  // Everything above measures elements against each other. The status bar is
  // not an element: standalone on iOS draws the page underneath it
  // (black-translucent + viewport-fit=cover), and Chromium resolves
  // env(safe-area-inset-top) to 0, so no amount of scanning the DOM will ever
  // show the Today bar sliding under the clock and the battery. It was
  // reported from a real phone, not found here.
  //
  // What is testable is the band that occludes it: that it exists, spans the
  // strip, outranks every overlay, costs nothing where there is no inset, and
  // actually PAINTS over scrolled content -- sampled from the rendered frame,
  // because pointer-events:none makes elementFromPoint skip it and paint order
  // is the whole question.
  {
    const h = await boot({ viewport: { width: 393, height: 852 }, meId: me.id, seed: {
      profiles: people, entries: D.entriesFor(me.id, 25),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await settle(h.page, 600);

    const base = await h.page.evaluate(() => {
      const s = document.querySelector(".status-bar-scrim");
      if(!s) return { missing: true };
      const cs = getComputedStyle(s), r = s.getBoundingClientRect();
      const others = Array.from(document.querySelectorAll("*"))
        .filter(e => !e.classList.contains("status-bar-scrim"))
        .map(e => parseInt(getComputedStyle(e).zIndex, 10))
        .filter(n => !isNaN(n) && n < 400);
      return { pos: cs.position, top: cs.top, h: Math.round(r.height),
               w: Math.round(r.width), z: parseInt(cs.zIndex, 10),
               maxOtherZ: Math.max(...others), pe: cs.pointerEvents,
               vw: document.documentElement.clientWidth };
    });
    ok(!base.missing, "a status-bar band exists", "nothing occludes content scrolling under the iOS status bar");
    ok(base.pos === "fixed" && base.top === "0px", "the band is pinned to the top of the viewport");
    ok(base.w === base.vw, "the band spans the full width", `${base.w} of ${base.vw}`);
    ok(base.h === 0, "the band is zero-height where there is no inset", `it is ${base.h}px, so it costs layout off iOS`);
    ok(base.z > base.maxOtherZ, "the band outranks every overlay",
      `z ${base.z} against a highest other of ${base.maxOtherZ} -- a dialog scrolls under the status bar too`);
    ok(base.pe === "none", "the band never intercepts a tap");

    // Drive the height the way a notch would and look at what is drawn.
    const NOTCH = 59;
    await h.page.evaluate(async px => {
      const st = document.createElement("style");
      st.textContent = ".status-bar-scrim{height:" + px + "px !important;}";
      document.head.appendChild(st);
      await new Promise(r => setTimeout(r, 120));
      window.scrollTo(0, 400);
      await new Promise(r => setTimeout(r, 200));
    }, NOTCH);
    const strip = await h.page.screenshot({ clip: { x: 0, y: 0, width: 393, height: NOTCH } });
    // Decode enough of the PNG to know it is one flat colour: re-encode via the
    // browser, which already has a decoder.
    const flat = await h.page.evaluate(async b64 => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
      let min = 255, max = 0;
      for(let i = 0; i < d.length; i += 4){
        const lum = d[i] + d[i+1] + d[i+2];
        if(lum < min) min = lum;
        if(lum > max) max = lum;
      }
      return { min, max };
    }, strip.toString("base64"));
    ok(flat.max < 60,
      "with a notch-sized inset, scrolled content is fully occluded by the band",
      `the strip contains pixels up to luminance ${flat.max} -- content is showing through`);

    await h.close();
  }

  console.log(`  collisions  pass ${pass}   fail ${fail}`);
  if(fail){ failures.forEach(f => console.log("  FAIL " + f)); process.exitCode = 1; }
})().catch(err => { console.error(err); process.exitCode = 1; });
