// Every palette, in both modes, measured against the floor DESIGN.md claims.
//
// This reads the palette blocks out of index.html and measures WHAT SHIPS. It
// deliberately does not import tools/palettes.mjs: that file generates the
// values, and a test that asks the generator whether the generator was right
// only ever proves it is self-consistent. If someone hand-edits a hex in
// index.html — which the comment there asks them not to do, and which is
// exactly the moment this needs to fail — the generator would still report a
// clean sheet and this file will not.
//
// The floor is DESIGN.md's Measured Floor rule: every text/background pairing
// carrying real information clears WCAG AA 4.5:1 against every surface it can
// land on, not just against one convenient background. That "every surface"
// part is the whole point — the first Atrium pass shipped a --muted that
// cleared the floor on white and failed on the canvas, cream and grey, and
// this pass found --gold-deep at 4.34:1 and --excused at 4.48:1 on
// --surface-gray in the palette that was already live.
const fs = require("fs");
const path = require("path");

const INDEX = path.join(__dirname, "..", "..", "index.html");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; return; }
  fail++;
  failures.push("    x " + name + (detail ? "\n      " + detail : ""));
}

// ---------------------------------------------------------------- colour math
const hexToRgb = hex => {
  const h = hex.replace("#","");
  const n = h.length === 3 ? h.split("").map(c => c+c).join("") : h;
  return [parseInt(n.slice(0,2),16), parseInt(n.slice(2,4),16), parseInt(n.slice(4,6),16)];
};
const lin = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
const relLum = hex => { const [r,g,b] = hexToRgb(hex); return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b); };
function contrast(a, b){
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la,lb) + 0.05) / (Math.min(la,lb) + 0.05);
}
// Composite a translucent colour over an opaque one. A wash a component lays
// over a surface makes a THIRD surface, and that is the one its text sits on.
function over(baseHex, topHex, alpha){
  const b = hexToRgb(baseHex), t = hexToRgb(topHex);
  return "#" + b.map((v, i) => Math.round(v + (t[i] - v) * alpha)
    .toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------- parsing
const html = fs.readFileSync(INDEX, "utf8");

// One block per palette per mode. The dark selector carries both attributes,
// so it is matched first and the light pattern is anchored to reject it.
function blocksFor(mode){
  const out = {};
  const re = mode === "dark"
    ? /html\[data-theme="dark"\]\[data-palette="([a-z]+)"\][^{]*\{([^}]*)\}/g
    : /html\[data-palette="([a-z]+)"\][^{]*\{([^}]*)\}/g;
  let m;
  while((m = re.exec(html)) !== null){
    const [, id, body] = m;
    // The light regex also matches inside the dark selector's prefix; skip any
    // hit whose full match began with the dark attribute.
    if(mode === "light" && m[0].indexOf('data-theme="dark"') !== -1) continue;
    const tokens = {};
    const tre = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    let t;
    while((t = tre.exec(body)) !== null) tokens[t[1]] = t[2].trim();
    out[id] = tokens;
  }
  return out;
}

const PALETTES = ["atrium", "slate", "terracotta", "studio", "moss", "plum", "ledger"];
const light = blocksFor("light");
const dark = blocksFor("dark");

ok(Object.keys(light).length === PALETTES.length,
  "every palette has a light composition",
  `found ${Object.keys(light).join(", ") || "none"}`);
ok(Object.keys(dark).length === PALETTES.length,
  "every palette has a dark composition",
  `found ${Object.keys(dark).join(", ") || "none"}`);

// ------------------------------------------------------------------- the floor
// Surfaces this app actually paints text on. DESIGN.md names six; they are the
// two washes plus the four card/canvas surfaces.
const SURFACE_TOKENS = ["card", "paper", "surface-cream", "surface-gray", "ink-100", "ink-50"];

// Body text and every status foreground. A status colour lands both on its own
// tint (a badge) and straight on a card (a figure), so it is measured on both.
//
// --ink-600 is in here because it is a foreground despite living in a ramp
// whose other steps are fills: eleven `color:` uses and seven `border-color:`
// ones. Flipping the whole ramp for dark mode put it at mid-grey on a dark
// tint and made the backup notice's title unreadable, which no amount of
// measuring the OTHER tokens would have caught.
const TEXT_TOKENS = ["ink", "muted", "muted-2", "gold-deep", "ink-600"];

// The other end of that ramp: every one of these is painted behind white text
// somewhere (the avatar's initials tile, the admin pill, --gradient-ink), so
// they have to stay dark in BOTH modes. This is the assertion that stops a
// future "invert the ramp for dark mode" from looking reasonable.
const FILL_TOKENS = ["ink-950", "ink-900", "ink-800", "ink-700"];
const STATUS_TOKENS = ["positive", "negative", "excused", "warn", "info"];

for(const mode of ["light", "dark"]){
  const set = mode === "light" ? light : dark;
  for(const id of PALETTES){
    const t = set[id];
    if(!t){ continue; }
    const label = `${id}/${mode}`;

    const surfaces = SURFACE_TOKENS.map(k => t[k]).filter(Boolean);
    ok(surfaces.length === SURFACE_TOKENS.length, `${label}: all six surfaces present`);

    const worstOn = (fg, grounds) => grounds.reduce((acc, g) => {
      const c = contrast(fg, g);
      return c < acc.c ? {c, g} : acc;
    }, {c: Infinity, g: null});

    for(const token of TEXT_TOKENS){
      if(!t[token]) { ok(false, `${label}: --${token} is defined`); continue; }
      const w = worstOn(t[token], surfaces);
      ok(w.c >= 4.5, `${label}: --${token} clears 4.5:1 on every surface`,
        `${w.c.toFixed(2)}:1 on ${w.g}`);
    }

    for(const token of STATUS_TOKENS){
      if(!t[token]) { ok(false, `${label}: --${token} is defined`); continue; }
      const grounds = surfaces.concat(t[token + "-bg"] ? [t[token + "-bg"]] : []);
      const w = worstOn(t[token], grounds);
      ok(w.c >= 4.5, `${label}: --${token} clears 4.5:1 on every surface and its own tint`,
        `${w.c.toFixed(2)}:1 on ${w.g}`);
    }

    for(const token of FILL_TOKENS){
      if(!t[token]) { ok(false, `${label}: --${token} is defined`); continue; }
      const c = contrast("#FFFFFF", t[token]);
      ok(c >= 4.5, `${label}: --${token} stays a dark fill that carries white text`,
        `${c.toFixed(2)}:1`);
    }

    // Text ON the accent fill. Studio answers this with white and everything
    // else with a near-black, which is the reason it is a per-palette token
    // rather than one hardcoded ink.
    if(t["ink-on-gold"] && t.gold){
      const c = contrast(t["ink-on-gold"], t.gold);
      ok(c >= 4.5, `${label}: --ink-on-gold clears 4.5:1 on the accent fill`, `${c.toFixed(2)}:1`);
    }
    // The rail is dark in both modes and carries its own secondary text — on
    // TWO grounds, not one. .seal and the viewer switcher lay
    // `rgba(255,255,255,.06)` over the rail, and that wash is not a token, so
    // measuring bare rail was measuring a surface the text does not sit on:
    // the solver landed this family at 4.60-4.65:1, the 6% lift cost about
    // 0.65, and "TODAY" shipped at 3.89-4.05:1 in the five solved palettes
    // while Atrium and Ledger — both authored, both with 6.7:1 of headroom —
    // showed nothing. A ground a token lands on is a ground that gets measured.
    const railWash = over(t.rail, "#FFFFFF", 0.06);
    for(const token of ["muted-on-dark", "positive-on-dark", "negative-on-dark"]){
      if(!t[token] || !t.rail){ ok(false, `${label}: --${token} is defined`); continue; }
      const w = worstOn(t[token], [t.rail, railWash]);
      ok(w.c >= 4.5, `${label}: --${token} clears 4.5:1 on the rail and on the rail's 6% wash`,
        `${w.c.toFixed(2)}:1 on ${w.g}`);
    }

    // The accent where the Fill-Only Rule is deliberately broken.
    //
    // This file used to skip --gold on the reasoning that the rule guarantees
    // it is only ever a fill. The rule is right and the stylesheet breaks it
    // twice on purpose: .rail-item.active sets the current-page label in it,
    // and the focus ring inside the rail and the quick-clock is drawn in it,
    // because --ink IS the rail and an ink ring there is invisible. Both read
    // at 14:1 in Atrium because lime on near-black does — not because accents
    // do. Studio's dark electric blue measured 2.42:1 as that label and 2.85:1
    // as that ring, under 1.4.11's 3:1 for an indicator. --gold-on-dark is the
    // token those two use, and --ink-700 is the quick-clock gradient's lighter
    // end, the other dark ground the ring lands on.
    if(t["gold-on-dark"] && t.rail && t["ink-700"]){
      const w = worstOn(t["gold-on-dark"], [t.rail, t["ink-700"]]);
      ok(w.c >= 4.5, `${label}: --gold-on-dark carries the current-page label and the rail's focus ring`,
        `${w.c.toFixed(2)}:1 on ${w.g}`);
    } else {
      ok(false, `${label}: --gold-on-dark is defined`);
    }

    // The channel triplets the stylesheet writes its alphas through, and the
    // guarantee that each one actually matches the colour it is named for. A
    // triplet that drifts from its own token is worse than a literal: it looks
    // like it follows the palette and does not.
    for(const [triplet, source] of [["gold-rgb","gold"], ["ink-rgb","ink"],
                                    ["mint-rgb","mint"], ["ink-950-rgb","ink-950"],
                                    ["surface-gray-rgb","surface-gray"],
                                    ["ink-600-rgb","ink-600"], ["negative-rgb","negative"],
                                    ["negative-on-dark-rgb","negative-on-dark"]]){
      if(!t[triplet] || !t[source]){ ok(false, `${label}: --${triplet} is defined`); continue; }
      const want = hexToRgb(t[source]).join(",");
      ok(t[triplet].replace(/\s/g, "") === want,
        `${label}: --${triplet} is --${source}'s own channels`,
        `${t[triplet]} vs ${want}`);
    }
    // A solid danger button is a fill, and --negative is tuned as text: too
    // light to carry white at body size. Its own pair is what gets measured.
    if(t["negative-solid"]){
      const c = contrast("#FFFFFF", t["negative-solid"]);
      ok(c >= 4.5, `${label}: white clears 4.5:1 on --negative-solid`, `${c.toFixed(2)}:1`);
    }

    // The Fill-Only Rule's whole content is that a lime-family mark carrying
    // meaning uses --gold-deep, "never --gold" — and that is a claim about
    // contrast against the SURFACE, which the --gold-deep row above already
    // measures at 4.5:1 on all six.
    //
    // An earlier version of this file also demanded the two be 1.25:1 apart
    // from each other, and Atrium's dark composition failed it at 1.19:1. That
    // assertion was inventing a requirement: the two tokens are never adjacent
    // anywhere in this app — --gold-deep draws the chart's target reference and
    // its legend swatch, --gold draws the nav glow, progress fills and the
    // clock-in button — and on a dark ground lime clears the floor on its own,
    // so the two legitimately converge there. What is still worth catching is
    // the solver handing back the fill itself, which would mean the search
    // never ran.
    if(t.gold && t["gold-deep"]){
      ok(t.gold.toLowerCase() !== t["gold-deep"].toLowerCase(),
        `${label}: --gold-deep was actually solved, not copied from --gold`);
    }

    // Structural separation. Atrium groups by SURFACE, not by borders — "Cards
    // have no border", and a stat row reads as four tiles because the second
    // and third take the cream and grey surfaces. A palette whose surfaces
    // collapse loses the mechanism the whole system groups with.
    if(t.card && t.paper){
      const c = contrast(t.card, t.paper);
      ok(c >= 1.05, `${label}: a card is distinguishable from the canvas`, `${c.toFixed(3)}:1`);
    }
    for(const alt of ["surface-cream", "surface-gray"]){
      if(t[alt] && t.card){
        const c = contrast(t[alt], t.card);
        ok(c >= 1.02, `${label}: --${alt} is distinguishable from --card`, `${c.toFixed(3)}:1`);
      }
    }
    // The rail is the spine. In light mode it is the one dark region and
    // clears the canvas by a mile; in dark mode ~1.2:1 is the most a near-black
    // pair can hold (WCAG's +0.05 dominates down there), and the stylesheet
    // draws a hairline to carry the rest.
    if(t.rail && t.paper){
      const c = contrast(t.rail, t.paper);
      const need = mode === "dark" ? 1.18 : 1.30;
      ok(c >= need, `${label}: the rail reads as its own region`, `${c.toFixed(3)}:1, need ${need}`);
    }
  }
}

// The dark theme's hairlines are what the relaxed rail/canvas step above is
// backed by, so their absence is a real regression rather than a style nit.
ok(/html\[data-theme="dark"\][^{]*\.rail\s*\{[^}]*border-right/.test(html),
  "dark mode draws the rail's edge");
ok(/html\[data-theme="dark"\][^{]*\.card[\s\S]{0,120}?border-color/.test(html),
  "dark mode draws the card's edge");
// color-scheme is what makes the browser's OWN surfaces follow the theme:
// form controls, the caret, scrollbars, the overscroll ground.
ok(/html\[data-theme="dark"\]\{color-scheme:dark;\}/.test(html),
  "dark mode declares color-scheme to the browser");
ok(/html\[data-theme="light"\]\{color-scheme:light;\}/.test(html),
  "light mode declares color-scheme to the browser");

// --ink is a FOREGROUND in dark mode and a near-black in light. A rule that
// paints it as a BACKGROUND and then hardcodes #fff on top is legible in light
// and blank in dark: three of them shipped that way — the header pill naming
// the screen you are on, the "clocked out" tick in the In-today roster, and the
// phone's Today line — at 1.09-1.19:1 across all seven dark palettes. The two
// rules that got it right (.wl-dayhead.is-today b, .cal-cell.cal-today
// .cal-daynum) use --card, the token that moves opposite --ink in both
// directions. No palette value can catch this, which is why it is asserted on
// the stylesheet instead.
{
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const offenders = [];
  for(const block of css.split("}")){
    const open = block.lastIndexOf("{");
    if(open === -1) continue;
    const body = block.slice(open + 1);
    if(!/background(-color)?\s*:\s*var\(--ink\)\s*[;}]/.test(body)) continue;
    if(!/color\s*:\s*#fff\b/i.test(body)) continue;
    offenders.push(block.slice(0, open).trim().split("\n").pop().trim().slice(0, 60));
  }
  ok(offenders.length === 0,
    "no rule paints #fff on a var(--ink) background (use --card: --ink flips in dark)",
    offenders.join(" | "));
}

// prefers-reduced-motion must STOP the infinite animations, not speed them up.
// The blanket `animation-duration:.001ms` turns a 1.6s infinite loop into about
// a million iterations a second — the trap this stylesheet documents for its
// two auth loops and missed for the skeletons, 13 of which are on screen during
// every data load, i.e. the people who asked for less motion paid the most for
// it. Every selector that declares an infinite animation owes a matching
// `animation:none` inside a reduced-motion block; a new one is a new exemption.
{
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

  // Selectors that declare an infinite animation.
  const declared = [];
  const declRe = /([^{}]*)\{([^{}]*)\}/g;
  let d;
  while((d = declRe.exec(css)) !== null){
    if(!/animation\s*:/.test(d[2]) || !/\binfinite\b/.test(d[2])) continue;
    const sel = d[1].trim().split("\n").map(x => x.trim()).filter(Boolean).pop();
    if(sel) declared.push(sel);
  }

  // Selectors a reduced-motion block switches off. Brace-matched, because
  // these blocks nest rules and a lazy regex stops at the first inner "}".
  const exempt = [];
  let at = -1;
  while((at = css.indexOf("@media (prefers-reduced-motion: reduce)", at + 1)) !== -1){
    let i = css.indexOf("{", at), depth = 0, endAt = i;
    for(; i < css.length; i++){
      if(css[i] === "{") depth++;
      else if(css[i] === "}" && --depth === 0){ endAt = i; break; }
    }
    const body = css.slice(css.indexOf("{", at) + 1, endAt);
    const innerRe = /([^{}]*)\{([^{}]*)\}/g;
    let r;
    while((r = innerRe.exec(body)) !== null){
      if(!/animation\s*:\s*none/.test(r[2])) continue;
      r[1].split(",").forEach(x => { const t = x.trim().split("\n").pop().trim(); if(t) exempt.push(t); });
    }
  }

  ok(declared.length > 0, "the stylesheet still declares infinite animations to guard");
  ok(exempt.length > 0, "a reduced-motion block switches infinite animations off");
  for(const sel of declared){
    ok(exempt.indexOf(sel) !== -1,
      `reduced motion stops "${sel}" rather than spinning it at .001ms`,
      `exempted: ${exempt.join(", ") || "nothing"}`);
  }
}

// No hand-written rule may hardcode a colour the palette owns.
//
// This is the hole every finding in this file's history came through. A literal
// like rgba(214,232,92,.13) is Atrium's lime frozen into all fourteen
// compositions, and nothing that measures TOKENS can see it: the generator
// emits a clean sheet, this file measured clean, and Studio still drew a lime
// bloom behind a blue clock panel and a 1.000:1 white hover on a white card.
//
// Scope is the hand-written stylesheet only — the generated palette blocks and
// the :root Atrium fallback are where literals belong. Neutral white/black
// overlays are allowed: they are used deliberately on surfaces that are dark in
// both modes, and DESIGN.md says so. Everything else has to come from a token,
// through var(--x) or rgba(var(--x-rgb), a).
{
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const genFrom = css.indexOf('html[data-palette="atrium"], .theme-preview');
  const genTo = css.indexOf("/* ---- Theme plumbing");
  const rootFrom = css.indexOf("--ink-950:#0A0A09");
  const rootTo = css.indexOf("--negative-deep:#8E2A42");
  const authored = css.split("\n").filter((line, i, all) => {
    const at = css.indexOf(line);
    if(at >= genFrom && at < genTo) return false;
    if(at >= rootFrom - 400 && at <= rootTo + 400) return false;
    return true;
  }).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

  // A shadow is allowed to be a plain darkening: it is depth, not identity,
  // and the generator already emits per-mode --shadow-* for the ones that are.
  const offenders = [];
  for(const line of authored.split("\n")){
    for(const m of line.match(/rgba?\(\s*\d[^)]*\)/g) || []){
      if(/^rgba?\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/.test(m)) continue;
      if(/box-shadow|drop-shadow|text-shadow/.test(line)) continue;
      if(/,\s*0\s*\)$/.test(m)) continue;   // an alpha-0 gradient stop paints nothing
      offenders.push(line.trim().slice(0, 80));
    }
  }
  ok(offenders.length === 0,
    "no hand-written rule hardcodes a palette colour (use var(--x) or rgba(var(--x-rgb), a))",
    offenders.join("\n      "));
}

console.log(`  palette-contrast  pass ${pass}   fail ${fail}`);
if(failures.length) console.log(failures.join("\n"));
process.exit(fail ? 1 : 0);
