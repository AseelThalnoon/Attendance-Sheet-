// Exploratory scan, not an assertion suite: renders every tab against hostile
// data at two widths and reports what overflows, what is clipped, and how tall
// the rows got. Use it to find things; hostile.js is what locks them down.
const { boot, goTab, settle, DESKTOP, PHONE } = require("./harness");
const D = require("./data");

const TABS = ["overview","log","trends","calendar","punctuality","team","settings","admin"];

const MEASURE = () => {
  const out = { pageScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                overflow: [], tallRows: [], clipped: [] };
  const vw = document.documentElement.clientWidth;

  document.querySelectorAll("#logBody tr, .roster-card, .tt-row, .audit-row, tbody tr").forEach(el => {
    const r = el.getBoundingClientRect();
    if(r.height > 60) out.tallRows.push({ id: el.className || el.tagName, h: Math.round(r.height),
      text: (el.textContent || "").trim().slice(0, 40) });
  });

  document.querySelectorAll("*").forEach(el => {
    if(!el.getClientRects().length) return;
    const r = el.getBoundingClientRect();
    if(r.width === 0) return;
    // Painted past the right edge of the viewport.
    if(r.right > vw + 1 && getComputedStyle(el).position !== "fixed"){
      out.overflow.push({ sel: el.id || el.tagName + "." + String(el.className||"").split(/\s+/)[0],
        right: Math.round(r.right), vw, by: Math.round(r.right - vw) });
    }
    // Content wider than its own box, with nothing to scroll it.
    const cs = getComputedStyle(el);
    if(el.scrollWidth - el.clientWidth > 2 && cs.overflowX === "visible" && el.children.length === 0){
      out.clipped.push({ sel: el.id || el.tagName + "." + String(el.className||"").split(/\s+/)[0],
        by: el.scrollWidth - el.clientWidth, text: (el.textContent||"").trim().slice(0,30) });
    }
  });
  const dedupe = a => { const seen = new Set(); return a.filter(x => { const k = JSON.stringify(x); if(seen.has(k)) return false; seen.add(k); return true; }); };
  out.overflow = dedupe(out.overflow).slice(0, 12);
  out.clipped = dedupe(out.clipped).slice(0, 12);
  out.tallRows = out.tallRows.slice(0, 8);
  return out;
};

(async () => {
  for(const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]){
    const people = D.roster(34), me = people[0];
    const h = await boot({ viewport, meId: me.id, seed: {
      profiles: people,
      entries: [].concat(
        D.entriesFor(me.id, 400, { extremes: true }),
        ...people.slice(1, 12).map(p => D.entriesFor(p.id, 20))
      ),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS })),
      audit_log: Array.from({ length: 120 }, (_, i) => ({
        id: i, actor_email: `person${i%30}@example.com`, action: "entry_update",
        table_name: "entries", record_id: String(i), target_email: D.LONG_NAME + "@x.example.com",
        entry_date: "2026-09-01", old_values: {}, new_values: {},
        created_at: new Date(Date.now() - i * 3600_000).toISOString()
      }))
    }});

    console.log(`\n================ ${label} (${viewport.width}x${viewport.height}) ================`);
    for(const tab of TABS){
      try{ await goTab(h.page, tab); }catch(e){ console.log(` ${tab}: nav failed — ${e.message}`); continue; }
      await settle(h.page, 500);
      const m = await h.page.evaluate(MEASURE);
      const bits = [];
      if(m.pageScrollX > 0) bits.push(`H-SCROLL ${m.pageScrollX}px`);
      if(m.tallRows.length) bits.push(`tall rows: ${m.tallRows.map(r => r.h + "px").join(",")}`);
      if(m.overflow.length) bits.push(`overflow: ${m.overflow.map(o => o.sel + "+" + o.by).join(" ")}`);
      if(m.clipped.length) bits.push(`clipped: ${m.clipped.map(o => o.sel + "+" + o.by).join(" ")}`);
      console.log(` ${tab.padEnd(12)} ${bits.length ? bits.join(" | ") : "ok"}`);
      await h.page.screenshot({ path: `/tmp/hostile-${label}-${tab}.png` });
    }
    if(h.errors.length) console.log(" page errors:", h.errors.slice(0, 6));
    await h.close();
  }
})();
