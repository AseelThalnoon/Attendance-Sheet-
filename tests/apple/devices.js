// The app on Apple devices, in Safari's own engine.
//
// Everything else in tests/ runs in Chromium. Chromium is not Safari: it does
// not share WebKit's layout, its CSS support, or its JavaScript surface, and
// the differences are exactly the ones that reach an iPhone and nothing else.
// This suite boots the real app in WebKit across Playwright's Apple device
// profiles -- which carry the viewport, DPR, touch flags and user agent
// together -- and checks it works there.
//
// WebKit on Linux needs five system packages. Without them this suite SKIPS
// rather than fails, and says so loudly, because a silent skip is how a suite
// stops testing anything without anyone noticing:
//   sudo apt-get install -y libevent-2.1-7t64 libflite1 libavif16 \
//       libmanette-0.2-0 gstreamer1.0-libav
//
// What this still cannot see, and a phone can: safe-area insets, standalone
// PWA mode, Add to Home Screen, the launch screen, iOS push, and the
// zoom-on-focus behaviour tests/regression/ios.js exists to guard against.
// WebKit-on-Linux is the engine, not the operating system.
const { devices } = require("playwright");
const { boot, settle, goTab } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

// A spread rather than everything: the oldest screen still in use, the current
// phones, the two notch generations, and an iPad for the wide layout.
const TARGETS = [
  "iPhone SE",            // 320px -- the narrowest screen the app must survive
  "iPhone 12",            // the 390px class
  "iPhone 14 Pro Max",    // the largest phone
  "iPad Pro 11"           // the tablet layout, where the rail appears
];

(async () => {
  let engine = "webkit";
  try {
    const { webkit } = require("playwright");
    const b = await webkit.launch();
    await b.close();
  } catch (err) {
    console.log("  apple     SKIPPED — WebKit cannot launch on this host");
    console.log("            " + String(err).split("\n")[0]);
    console.log("            Install the system packages and re-run:");
    console.log("            sudo apt-get install -y libevent-2.1-7t64 libflite1 \\");
    console.log("                libavif16 libmanette-0.2-0 gstreamer1.0-libav");
    console.log("            Until then the app is untested in Safari's engine.");
    return;
  }

  const people = D.roster(6);
  const me = people[0];

  for(const name of TARGETS){
    const device = devices[name];
    if(!device){ ok(false, `${name}: profile exists in Playwright`); continue; }

    const h = await boot({ engine, device, meId: me.id, seed: {
      profiles: people,
      entries: [].concat(D.entriesFor(me.id, 20), D.entriesFor(people[1].id, 6)),
      user_settings: people.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    await settle(h.page, 900);

    // It booted at all. In WebKit this is not a formality: a CSS or JS feature
    // Chromium has and Safari does not takes the whole app down here.
    const alive = await h.page.evaluate(() => ({
      shell: !!document.getElementById("appShell"),
      shellShown: document.getElementById("appShell").style.display !== "none",
      engine: navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome"),
      tabs: document.querySelectorAll(".tab-btn").length
    }));
    ok(alive.shell && alive.shellShown, `[${name}] the app boots in WebKit`);
    ok(alive.engine, `[${name}] and it really is Safari's engine`, "user agent: not WebKit");
    ok(alive.tabs >= 6, `[${name}] the tab strip is built`, `found ${alive.tabs}`);

    // Every tab renders without a script error. A page error in WebKit means a
    // JS feature that works in Chromium is missing or behaves differently.
    for(const tab of ["overview","log","trends","calendar","punctuality","settings"]){
      try { await goTab(h.page, tab); } catch(e){ continue; }
      await settle(h.page, 350);
      const painted = await h.page.evaluate(t => {
        const p = document.getElementById("tab-" + t);
        return !!(p && p.getClientRects().length);
      }, tab);
      ok(painted, `[${name}] the ${tab} tab paints in WebKit`);
    }

    // The layout holds: WebKit's flex and grid differ from Chromium's often
    // enough that this is the check most likely to catch something real.
    const layout = await h.page.evaluate(() => {
      const doc = document.documentElement;
      return { overflow: Math.round(doc.scrollWidth - doc.clientWidth),
               vw: doc.clientWidth };
    });
    ok(layout.overflow <= 1, `[${name}] no sideways scroll in WebKit`,
      `document is ${layout.overflow}px wider than its ${layout.vw}px viewport`);

    // The clock is the product. If it does not work here it does not work.
    await goTab(h.page, "overview");
    await settle(h.page, 400);
    const clock = await h.page.evaluate(() => {
      const b = document.getElementById("qcClockBtn");
      return { present: !!b, action: b && b.getAttribute("data-clock-action"),
               label: b && (document.getElementById("qcClockLabel")||{}).textContent };
    });
    ok(clock.present && clock.action, `[${name}] the clock control renders with a state`,
      JSON.stringify(clock));

    const errs = h.errors.filter(e => !e.includes("404"));
    ok(errs.length === 0, `[${name}] no script errors in WebKit`,
      errs.slice(0, 3).join("\n     "));

    await h.close();
  }

  // ---- dismissing the People row menu by tapping away from it ----------
  // iOS Safari only synthesises a click for elements it considers
  // interactive. A tap on a plain <div> -- another person's row, the section
  // heading -- produces no click event at all, so a click-only
  // outside-dismiss listener never hears it and the menu cannot be closed.
  // Chromium fires a click for every tap and shows none of this; so does a
  // test that dismisses with document.body.click(), which dispatches the
  // event directly and would pass against the broken code.
  //
  // This taps the screen the way a thumb does.
  {
    const device = devices["iPhone 14 Pro Max"];
    const admins = D.roster(6);
    admins[0].role = "admin";
    const h = await boot({ engine, device, meId: admins[0].id, seed: {
      profiles: admins, entries: [],
      user_settings: admins.map(p => ({ user_id: p.id, settings: D.SETTINGS }))
    }});
    try{
      // The Add to Home Screen / notifications prompt shows on a phone
      // profile and covers the list. Dismiss it first, or every tap below
      // lands on the modal instead of on the row it names.
      await settle(h.page, 900);
      await h.page.evaluate(() => {
        document.querySelectorAll(".modal-overlay").forEach(o => {
          const no = [...o.querySelectorAll("button")]
            .find(b => /not now|later|cancel|no thanks|dismiss|close/i.test(b.textContent || ""));
          if(no) no.click(); else o.remove();
        });
      });
      await settle(h.page, 300);
      const covered = await h.page.evaluate(() => document.querySelectorAll(".modal-overlay").length);
      ok(covered === 0, "[iOS tap] the prompt modal is out of the way first", `${covered} still open`);

      await goTab(h.page, "admin");
      await h.page.evaluate(() => {
        const b = document.getElementById("cnav-admin-people");
        if(b) b.click();
      });
      await settle(h.page, 600);

      // Scrolled into view before measuring: on a phone the People rows start
      // well below the fold, and a coordinate taken from an offscreen element
      // taps whatever happens to be at that point instead.
      const at = async sel => {
        await h.page.evaluate(s => {
          const el = document.querySelector(s);
          if(el) el.scrollIntoView({ block: "center" });
        }, sel);
        await settle(h.page, 250);
        return h.page.evaluate(s => {
          const el = document.querySelector(s);
          if(!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(12, r.height / 2)),
                   tag: el.tagName, onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
                   interactive: !!el.closest("button, a, input, select, textarea, label") };
        }, sel);
      };
      // Painted, not .hidden -- see the same note in regression/admin-tab.js.
      const menuOpen = () => h.page.evaluate(() => {
        const m = document.getElementById("adminRowMenu");
        return !!(m && m.getClientRects().length);
      });

      const kebab = await at("#adminUsersList .admin-user-row:nth-child(2) .row-menu-btn");
      ok(!!kebab && kebab.onScreen,
        "[iOS tap] the People list has a row menu button on screen to tap", JSON.stringify(kebab));
      if(kebab){
        await h.page.touchscreen.tap(kebab.x, kebab.y);
        await settle(h.page, 400);
        ok(await menuOpen(), "[iOS tap] tapping the three dots opens the menu");

        // The target has to be a plain, non-interactive element -- tapping a
        // button would produce a click on any engine and prove nothing.
        // Deliberately NOT scrolled into view: scrolling closes the menu on
        // its own (the menu cannot follow a row inside a scroller), so a
        // helper that scrolls first dismisses it before the tap and the
        // assertion below passes no matter what the listener does. This was
        // that mistake once already. Find a spot that is already on screen,
        // is genuinely non-interactive, and is not underneath the menu.
        const elsewhere = await h.page.evaluate(() => {
          const menu = document.getElementById("adminRowMenu").getBoundingClientRect();
          for(const main of document.querySelectorAll("#adminUsersList .admin-user-main")){
            const r = main.getBoundingClientRect();
            const x = Math.round(r.left + 20), y = Math.round(r.top + 6);
            if(r.top < 60 || r.bottom > window.innerHeight - 60) continue;
            if(y > menu.top - 8 && y < menu.bottom + 8) continue;   // under the popover
            const hit = document.elementFromPoint(x, y);
            if(!hit || hit.closest(".row-menu")) continue;
            return { x, y, tag: hit.tagName,
                     interactive: !!hit.closest("button, a, input, select, textarea, label") };
          }
          return null;
        });
        ok(elsewhere && !elsewhere.interactive,
          "[iOS tap] and there is a plain, on-screen spot to tap away to",
          JSON.stringify(elsewhere));
        // Nothing since the open should have dismissed it. If this fails the
        // tap below is meaningless.
        ok(await menuOpen(), "[iOS tap] the menu is still open right before the tap-away");
        if(elsewhere && !elsewhere.interactive){
          await h.page.touchscreen.tap(elsewhere.x, elsewhere.y);
          await settle(h.page, 400);
          ok(!(await menuOpen()),
            "[iOS tap] tapping away from it closes the menu",
            "the menu is still painted — .row-menu is display:flex, which outranks " +
            "the UA sheet's [hidden]{display:none}, so closing it in the DOM leaves " +
            "it on the screen");
        }
      }
    } finally { await h.close(); }
  }

  console.log(`  apple     pass ${pass}   fail ${fail}`);
  if(fail){ failures.forEach(f => console.log("  FAIL " + f)); process.exitCode = 1; }
})().catch(err => { console.error(err); process.exitCode = 1; });
