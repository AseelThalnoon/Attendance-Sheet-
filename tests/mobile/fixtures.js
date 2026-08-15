// Puts the real page into a state worth scanning.
//
// revealApp() unhides the app shell (normally gated behind auth) and opens the
// accordions. showTab() activates exactly one tab at a time — activating all of
// them at once stacks panels and produces layout that never occurs in the app.
//
// buildGallery() renders a probe for every colour-setting rule in the real
// stylesheet, on the surfaces those elements really sit on, so invisible-text
// bugs surface without needing a live backend.

async function revealApp(page, theme){
  await page.evaluate(t => {
    document.documentElement.setAttribute("data-theme", t);
    document.body.classList.toggle("dark", t === "dark");

    const shell = document.getElementById("appShell");
    if(shell) shell.style.display = "";
    const auth = document.getElementById("authScreen");
    if(auth) auth.style.display = "none";

    document.querySelectorAll(".accordion-section").forEach(el => el.classList.add("open"));
    // Schedule Settings is a panel toggled by .open, not a tab.
    document.querySelectorAll(".settings-card").forEach(el => el.classList.add("open"));
    document.querySelectorAll(".accordion-body").forEach(el => {
      el.style.maxHeight = "none";
      el.style.overflow = "visible";
    });

    // Realistic content: an empty select or date input measures narrower than
    // a populated one, which would hide exactly the overflow being hunted.
    document.querySelectorAll("select").forEach(s => {
      if(!s.options.length) ["All Years", "All Months", "September"].forEach(x => s.add(new Option(x, x)));
    });
    document.querySelectorAll("input[type=date]").forEach(i => { if(!i.value) i.value = "2026-08-14"; });
    document.querySelectorAll("input[type=time]").forEach(i => { if(!i.value) i.value = "08:00"; });
  }, theme);
}

async function listTabs(page){
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".tab-panel")).map(el => el.id).filter(Boolean));
}

async function showTab(page, id){
  await page.evaluate(tabId => {
    document.querySelectorAll(".tab-panel").forEach(el => el.classList.toggle("active", el.id === tabId));
    // Filter bars belong to specific tabs; reveal the ones inside this panel.
    const panel = document.getElementById(tabId);
    if(panel) panel.querySelectorAll(".filter-bar").forEach(el => { el.style.display = "flex"; });
  }, id);
}

// Walks the real stylesheet and returns every selector whose rule sets BOTH a
// text colour and its own background. Those are self-contained, deliberate
// pairs — a badge, pill or chip — so they can be judged without guessing what
// they sit on. Colour-only rules are excluded on purpose: something like
// .hero-value is white text meant for a dark gradient, and probing it against
// an arbitrary surface produces a false alarm, not a finding.
//
// Note: in browsers supporting CSS nesting, a plain CSSStyleRule also exposes
// an (empty) .cssRules, so grouping rules must be detected by the absence of
// selectorText — keying on .cssRules would skip every style rule.
const COLLECT_COLOUR_SELECTORS = () => {
  const found = new Set();
  const walk = list => {
    for(let i = 0; i < list.length; i++){
      const rule = list[i];
      if(!rule.selectorText){
        if(rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        continue;
      }
      if(rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
      if(!rule.style) continue;
      const hasColour = !!rule.style.getPropertyValue("color");
      const hasBg = !!(rule.style.getPropertyValue("background") ||
                       rule.style.getPropertyValue("background-color") ||
                       rule.style.getPropertyValue("background-image"));
      if(!hasColour || !hasBg) continue;
      rule.selectorText.split(",").forEach(sel => {
        sel = sel.trim();
        // Class chains and id-anchored chains alike — an earlier version
        // matched only classes and silently missed two real bugs on
        // #advancedFiltersToggle.active / #selectModeToggle.active.
        if(/^#?[A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(sel) && /[.#]/.test(sel)) found.add(sel);
      });
    }
  };
  for(const sheet of document.styleSheets){
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    walk(rules);
  }
  return [...found];
};

async function buildGallery(page){
  return page.evaluate(collectSrc => {
    const collect = new Function("return (" + collectSrc + ")()");
    const selectors = collect();

    const old = document.getElementById("__probeGallery");
    if(old) old.remove();

    const gallery = document.createElement("div");
    gallery.id = "__probeGallery";
    // Wraps so the gallery itself never registers as page overflow.
    gallery.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; max-width:100%";

    // Each probe carries its own background, so no surface context is needed.
    selectors.forEach(sel => {
      const span = document.createElement("span");
      // "#someId.active" -> id plus the class part, so id-anchored rules match.
      const idMatch = sel.match(/^#([A-Za-z0-9_-]+)/);
      if(idMatch) span.id = "__probe_" + idMatch[1];
      span.className = sel.replace(/^#[A-Za-z0-9_-]+/, "").split(".").filter(Boolean).join(" ");
      span.dataset.probe = sel;
      span.textContent = "Sample";
      gallery.appendChild(span);
    });

    // Id-anchored rules can't match a renamed id, so replay their declarations
    // onto the probe directly from the stylesheet — still the real values.
    gallery.querySelectorAll("[data-probe^='#']").forEach(span => {
      const sel = span.dataset.probe;
      for(const sheet of document.styleSheets){
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for(let i = 0; i < rules.length; i++){
          const rule = rules[i];
          if(!rule.selectorText || !rule.style) continue;
          if(rule.selectorText.split(",").some(s => s.trim() === sel)){
            const colour = rule.style.getPropertyValue("color");
            const bg = rule.style.getPropertyValue("background") ||
                       rule.style.getPropertyValue("background-color");
            if(colour) span.style.color = colour;
            if(bg) span.style.background = bg;
          }
        }
      }
    });

    document.body.appendChild(gallery);
    return selectors.length;
  }, COLLECT_COLOUR_SELECTORS.toString());
}

module.exports = { revealApp, showTab, listTabs, buildGallery };
