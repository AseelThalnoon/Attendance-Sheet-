// Pull to refresh on phones, and the refresh button it stands in for.
//
// Real touch input, sent through Chromium's input pipeline (CDP
// Input.dispatchTouchEvent), so the page sees touchstart / touchmove /
// touchend exactly as a finger makes them -- including whether its
// preventDefault() is honoured. A refresh is counted by the fresh read of
// /rest/v1/entries it makes against the scripted backend.
const { boot, settle, PHONE, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Pat Pull" });
const seed = () => ({ profiles: [me],
  entries: D.entriesFor(me.id, 60).map(e => Object.assign(e, { note: "", id: "e" + e.id })),
  user_settings: [{ user_id: me.id, settings: D.SETTINGS }] });
const entryReads = h => h.backend.state.log.filter(l => l.method === "GET" && l.path === "/rest/v1/entries").length;

// One finger: down at (x, y0), dragged to (x + dx, y0 + dy) in steps, up.
async function drag(page, cdp, x, y0, dy, dx){
  dx = dx || 0;
  const steps = 12;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for(let i = 1; i <= steps; i++){
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: x + dx * i / steps, y: y0 + dy * i / steps }] });
    await page.waitForTimeout(16);
  }
  const mid = await page.evaluate(() => {
    const ind = document.getElementById("pullRefresh");
    return { shown: getComputedStyle(ind).display !== "none", armed: ind.classList.contains("is-armed") };
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return mid;
}

(async () => {
  // ---- Phone ---------------------------------------------------------------
  {
    const h = await boot({ viewport: PHONE, meId: me.id, seed: seed() });
    const cdp = await h.page.context().newCDPSession(h.page);
    await settle(h.page, 800);

    const head = await h.page.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect();
      return { refreshW: r("refreshBtn").width, bellW: r("notifBtn").width, gearW: r("settingsBtn").width };
    });
    ok(head.refreshW <= 1 && head.bellW === 44 && head.gearW === 44,
      "phone header: the refresh button gives way to the gesture; bell and gear stay", JSON.stringify(head));

    let before = entryReads(h);
    const full = await drag(h.page, cdp, 196, 160, 220);
    await settle(h.page, 1200);
    const toast = await h.page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" "));
    ok(full.shown && full.armed, "pulling down far enough shows the disc, armed", JSON.stringify(full));
    ok(entryReads(h) === before + 1, "letting go refreshes once", `reads ${before} -> ${entryReads(h)}`);
    ok(/Up to date/.test(toast), "and says it is up to date", toast);
    const after = await h.page.evaluate(() => getComputedStyle(document.getElementById("pullRefresh")).display);
    ok(after === "none", "the disc goes away when the refresh is done", after);

    before = entryReads(h);
    const short = await drag(h.page, cdp, 196, 160, 80);
    await settle(h.page, 900);
    ok(short.shown && !short.armed && entryReads(h) === before, "a short pull shows the disc but lets go without refreshing",
      JSON.stringify(short) + ` reads ${before} -> ${entryReads(h)}`);

    before = entryReads(h);
    await drag(h.page, cdp, 300, 300, 40, -200);
    await settle(h.page, 700);
    ok(entryReads(h) === before, "a sideways swipe is not a pull");

    await h.page.evaluate(() => window.scrollTo(0, 400));
    await settle(h.page, 300);
    before = entryReads(h);
    const scrolled = await drag(h.page, cdp, 196, 300, 200);
    await settle(h.page, 900);
    ok(!scrolled.shown && entryReads(h) === before, "scrolled down the page, dragging down just scrolls back up",
      JSON.stringify(scrolled));
    const top = await h.page.evaluate(() => window.scrollY);
    ok(top < 400, "and the page did scroll", "scrollY=" + top);

    // Keyboard users still have the button: it reappears when focused.
    await h.page.evaluate(() => window.scrollTo(0, 0));
    let focused = false;
    for(let i = 0; i < 25 && !focused; i++){
      await h.page.keyboard.press("Tab");
      focused = await h.page.evaluate(() => document.activeElement && document.activeElement.id === "refreshBtn");
    }
    const kb = await h.page.evaluate(() => document.getElementById("refreshBtn").getBoundingClientRect().width);
    ok(focused && kb === 44, "the refresh button is still reachable by keyboard, and shows itself when focused", `focused=${focused} w=${kb}`);
    ok(h.errors.length === 0, "phone: no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Desktop: the button, no gesture ---------------------------------------
  {
    const h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed() });
    await settle(h.page, 700);
    const d = await h.page.evaluate(() => ({
      w: document.getElementById("refreshBtn").getBoundingClientRect().width,
      overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY
    }));
    ok(d.w === 44 && d.overscroll !== "contain", "desktop keeps its refresh button and the browser's own scrolling", JSON.stringify(d));
    await h.close();
  }

  console.log(`  pull-refresh  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
