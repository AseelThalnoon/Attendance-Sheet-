// Palette authoring tool — run by hand, output pasted into index.html.
//
// This is NOT part of the app's runtime and NOT a build step: PRODUCT.md
// commits to "a static front end with no build step", so the shipped artefact
// stays plain CSS. This file exists because twelve compositions (six palettes
// x light/dark) is roughly 540 colour values, and DESIGN.md's Measured Floor
// rule says every text/surface pair carrying information is measured against
// WCAG AA before it ships. Five hundred hand-picked hexes do not survive that.
//
// So the split is: character is authored, contrast is solved.
//   - Authored by hand: canvas, card, the two alternate card surfaces, the
//     rail, the accent trio, and the ink the world is written in. These carry
//     the palette's point of view and no algorithm should be choosing them.
//   - Solved here: every secondary-text step, the text-capable accent, and
//     each status foreground — each one binary-searched down its own hue until
//     it clears its ratio against the WORST surface it can land on in that
//     composition, not just against one convenient background.
//
// Working space is OKLCH, per the reason colorize.md gives: lightness and
// chroma move predictably there, so "darken this until it clears 4.5:1 while
// staying the same colour" is one axis rather than three. Values are gamut-
// mapped by reducing chroma, never by clipping channels, which is what keeps a
// solved colour recognisably the hue it was authored as.
//
// Usage:  node tools/palettes.mjs           # print the CSS block
//         node tools/palettes.mjs --report  # print the contrast table

// ---------------------------------------------------------------- colour math

function hexToRgb(hex){
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return [parseInt(n.slice(0,2),16), parseInt(n.slice(2,4),16), parseInt(n.slice(4,6),16)];
}
function rgbToHex(rgb){
  return "#" + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,"0")).join("").toUpperCase();
}
const srgbToLinear = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
const linearToSrgb = c => (c <= 0.0031308 ? c*12.92 : 1.055*Math.pow(c, 1/2.4) - 0.055) * 255;

function rgbToOklab([r,g,b]){
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb);
  const m = Math.cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb);
  const s = Math.cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb);
  return [
    0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
    1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
    0.0259040371*l + 0.7827717662*m - 0.8086757660*s
  ];
}
function oklabToRgb([L,a,b]){
  const l = Math.pow(L + 0.3963377774*a + 0.2158037573*b, 3);
  const m = Math.pow(L - 0.1055613458*a - 0.0638541728*b, 3);
  const s = Math.pow(L - 0.0894841775*a - 1.2914855480*b, 3);
  return [
    linearToSrgb( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
    linearToSrgb(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
    linearToSrgb(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)
  ];
}
const oklchToOklab = ([L,C,H]) => [L, C*Math.cos(H*Math.PI/180), C*Math.sin(H*Math.PI/180)];
function oklabToOklch([L,a,b]){
  const H = Math.atan2(b,a) * 180/Math.PI;
  return [L, Math.hypot(a,b), H < 0 ? H + 360 : H];
}
const hexToOklch = hex => oklabToOklch(rgbToOklab(hexToRgb(hex)));
const inGamut = rgb => rgb.every(v => v >= -0.5 && v <= 255.5);

// Gamut-map by walking chroma down, not by clipping channels: clipping shifts
// the hue, which is exactly what a solved colour must not do.
function oklchToHex([L,C,H]){
  let c = C;
  for(let i = 0; i < 80; i++){
    const rgb = oklabToRgb(oklchToOklab([L,c,H]));
    if(inGamut(rgb)) return rgbToHex(rgb);
    c *= 0.94;
  }
  return rgbToHex(oklabToRgb(oklchToOklab([L,0,H])));
}

const relLum = hex => {
  const [r,g,b] = hexToRgb(hex);
  return 0.2126*srgbToLinear(r) + 0.7152*srgbToLinear(g) + 0.0722*srgbToLinear(b);
};
export function contrast(a, b){
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la,lb) + 0.05) / (Math.min(la,lb) + 0.05);
}

// Binary-search lightness along a fixed hue/chroma until the colour clears
// `ratio` against every surface in `grounds`. `dir` is which way to walk:
// "down" for dark text on light grounds, "up" for light text on dark grounds.
function solve(hue, chroma, grounds, ratio, dir, bounds){
  let lo = bounds && bounds.min != null ? bounds.min : 0;
  let hi = bounds && bounds.max != null ? bounds.max : 1;
  const worst = L => Math.min(...grounds.map(g => contrast(oklchToHex([L, chroma, hue]), g)));
  // 60 halvings is far past the precision of an 8-bit channel.
  for(let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    const ok = worst(mid) >= ratio;
    if(dir === "down"){ if(ok) lo = mid; else hi = mid; }
    else { if(ok) hi = mid; else lo = mid; }
  }
  let L = dir === "down" ? lo : hi;
  // The search moves lightness only. Near white and near black a hue cannot
  // hold its chroma (colorize.md: do not keep high chroma at extreme lightness
  // merely to make the math uniform), so if the target is still missed, bleed
  // chroma off until it lands.
  let c = chroma;
  while(worstOf(L, c) < ratio && c > 0.004){ c *= 0.9; }
  function worstOf(l, ch){ return Math.min(...grounds.map(g => contrast(oklchToHex([l, ch, hue]), g))); }
  return oklchToHex([L, c, hue]);
}

// A tint: the palette's hue at a lightness near the canvas, used as the ground
// under a status foreground. Authored as "how far from the canvas", so a tint
// sits in the same light as everything else in that composition.
const tint = (hue, chroma, L) => oklchToHex([L, chroma, hue]);

// The dark elevation ladder.
//
// Dark mode is composed, not inverted. In light mode the rail is the ONE dark
// region and it separates from everything by 15:1 — that is what makes it read
// as the building's spine rather than a wide border. Nothing in a dark theme
// can buy separation that cheaply, so it has to be designed: five surfaces on
// an explicit lightness ladder, deepest at the rail and stepping up with
// elevation, in the same direction as light mode (a card is lighter than the
// canvas in both). A first pass authored these as hand-picked near-blacks and
// put the rail 1.06:1 from the canvas, which is a rail you cannot see.
//
// Lightness is authored in OKLCH because these steps have to be perceptually
// even; the same steps in sRGB bunch up badly at the bottom of the range.
//
// How far apart the steps can be is not a free choice. WCAG contrast is
// (L1+.05)/(L2+.05), and near black that constant dominates, so a dark theme
// buys less measurable separation per step the darker it gets — chasing a
// 1.3:1 rail against the canvas walked the whole ladder up until --card landed
// on #373732 and the "dark" theme read as mid-grey. The ratio a dark surface
// pair can actually hold is ~1.2:1, which is where real dark interfaces sit,
// and they make up the difference with an EDGE rather than more lightness.
// So this ladder stays genuinely dark and the stylesheet draws a hairline
// between the planes in dark mode (see .rail and .card there). That is the
// translation of "separation comes from surface colour and shadow" into a mode
// where shadows do not read — not an abandonment of it.
const LADDER = { rail:0.130, paper:0.235, card:0.285, cream:0.320, gray:0.305 };
const surf = (L, C, H) => oklchToHex([L, C, H]);

// ------------------------------------------------------------ the six worlds
//
// Each entry authors only what carries the world's character. `hues` names the
// hue angle each solved role walks down; status hues stay near their
// conventional meanings (colorize.md: keep semantic meanings consistent) while
// the surfaces around them move.

const STATUS_HUES = { positive: 155, negative: 5, excused: 95, warn: 65, info: null };

const PALETTES = [
  {
    id: "atrium",
    name: "Atrium",
    blurb: "A bright, warm office floor. Greige canvas, white and cream cards, lime.",
    light: {
      // Atrium's light composition is the app's committed identity and is
      // reproduced here verbatim rather than re-solved: these exact values are
      // the ones DESIGN.md's Measured Floor rule was written against, and a
      // regenerated approximation of them would be a redesign nobody asked for.
      verbatim: {
        "ink-950":"#0A0A09", "ink-900":"#111110", "ink-800":"#1C1C1A", "ink-700":"#2A2A27",
        "ink-600":"#3D3D38", "ink-100":"#E4E2DC", "ink-50":"#EFEDE8",
        rail:"#111110", paper:"#E9E7E2", card:"#FFFFFF",
        "surface-cream":"#F0EADA", "surface-gray":"#DFDDD9",
        // Two values are one step off what ships today. Running the incumbent
        // through this file's own measurement caught --gold-deep at 4.34:1 and
        // --excused at 4.48:1 on --surface-gray, both just under the floor
        // DESIGN.md says every informational pair is held to. Darkened by four
        // hex steps each — visually indistinguishable, and now the rule the
        // file states is the rule the file keeps.
        gold:"#D6E85C", "gold-deep":"#586610", "gold-light":"#E4F27A",
        mint:"#A9DCC6", blush:"#F0B9C9",
        ink:"#111110", muted:"#61605A", "muted-2":"#57554F",
        line:"#D5D2CB", "line-soft":"#E2DFD8",
        positive:"#1B6C4D", "positive-bg":"#DCF0E6",
        info:"#3A3A36", "info-bg":"#E4E2DC",
        negative:"#A83A55", "negative-bg":"#FBE4EA",
        excused:"#68610E", "excused-bg":"#F2EFD2",
        warn:"#7A5510", "warn-bg":"#F7EFDA", "warn-line":"#E4CB92",
        "input-bg":"#FFFFFF", rule:"rgba(17,17,16,.05)",
        "ink-on-gold":"#1A1E05", "muted-on-dark":"#A8A69E",
        "positive-on-dark":"#A9DCC6", "negative-on-dark":"#F0B9C9",
        "negative-solid":"#C0405E", "negative-deep":"#8E2A42",
        iris:"linear-gradient(135deg, #E8DCC8 0%, #DCD9E8 38%, #CFE4DC 68%, #EFDCE2 100%)"
      }
    },
    dark: {
      rail:surf(LADDER.rail,.008,100), paper:surf(LADDER.paper,.008,100),
      card:surf(LADDER.card,.008,100), cream:surf(LADDER.cream,.030,85),
      gray:surf(LADDER.gray,.006,100),
      ink:"#F1EFE8", accent:"#D6E85C", accentLight:"#E4F27A", mint:"#8FC9AE", blush:"#E4A6B8",
      onAccent:"#1A1E05", neutralHue:100, neutralChroma:0.012, accentHue:110, accentChroma:0.14,
      iris:"linear-gradient(135deg, #33301F 0%, #2C2B38 38%, #24332E 68%, #33272D 100%)"
    }
  },
  {
    id: "slate",
    name: "Slate",
    blurb: "A cool, quiet early morning. Blue-grey canvas, white cards, soft sky.",
    light: {
      rail:"#0F1520", paper:"#E3E7EC", card:"#FFFFFF", cream:"#E8EEF4", gray:"#D8DDE4",
      ink:"#0F1520", accent:"#86C9EC", accentLight:"#A9DCF4", mint:"#8FCFC0", blush:"#E9AFC0",
      onAccent:"#062033", neutralHue:250, neutralChroma:0.016, accentHue:235, accentChroma:0.10,
      iris:"linear-gradient(135deg, #DCE6EF 0%, #D9DEEC 38%, #CFE4E8 68%, #E4DEEC 100%)"
    },
    dark: {
      rail:surf(LADDER.rail,.020,250), paper:surf(LADDER.paper,.020,250),
      card:surf(LADDER.card,.020,250), cream:surf(LADDER.cream,.032,240),
      gray:surf(LADDER.gray,.014,250),
      ink:"#E9EEF5", accent:"#7CC3EA", accentLight:"#9FD6F2", mint:"#84C7B8", blush:"#E2A3B6",
      onAccent:"#04121D", neutralHue:250, neutralChroma:0.018, accentHue:235, accentChroma:0.11,
      iris:"linear-gradient(135deg, #2A303C 0%, #2A2D42 38%, #24343A 68%, #322B3C 100%)"
    }
  },
  {
    id: "terracotta",
    name: "Terracotta",
    blurb: "Clay and plaster. Sandy canvas, warm white cards, burnt orange.",
    light: {
      rail:"#241B16", paper:"#EDE3D9", card:"#FFFDFB", cream:"#F6E9D8", gray:"#E2D8CD",
      ink:"#241B16", accent:"#EFA469", accentLight:"#F7C094", mint:"#A9C79B", blush:"#F0B3A6",
      onAccent:"#2E1405", neutralHue:60, neutralChroma:0.018, accentHue:52, accentChroma:0.13,
      iris:"linear-gradient(135deg, #F0DFC6 0%, #E6DAD2 38%, #DCE1D0 68%, #F2DBD0 100%)"
    },
    dark: {
      rail:surf(LADDER.rail,.022,60), paper:surf(LADDER.paper,.022,60),
      card:surf(LADDER.card,.022,60), cream:surf(LADDER.cream,.038,55),
      gray:surf(LADDER.gray,.016,60),
      ink:"#F4EAE0", accent:"#E89C5F", accentLight:"#F2B683", mint:"#9DBE8F", blush:"#E5A79A",
      onAccent:"#250F03", neutralHue:60, neutralChroma:0.020, accentHue:52, accentChroma:0.13,
      iris:"linear-gradient(135deg, #3A2C1E 0%, #352C28 38%, #2C3628 68%, #3A2A26 100%)"
    }
  },
  {
    id: "studio",
    name: "Studio",
    blurb: "A bright white studio. Pure neutral surfaces, one electric blue.",
    light: {
      rail:"#111111", paper:"#F2F2F0", card:"#FFFFFF", cream:"#F7F7F5", gray:"#E6E6E4",
      ink:"#111111", accent:"#1F4FD8", accentLight:"#4C74E8", mint:"#8FC9A8", blush:"#EDA9B4",
      // Studio's accent is the one saturated colour in an otherwise achromatic
      // world, and at that saturation no dark text clears the floor on it — so
      // this palette's on-accent text is white, and the accent is chosen dark
      // enough to carry it. Per-palette on-accent text is exactly why the token
      // exists rather than a hardcoded near-black.
      onAccent:"#FFFFFF", neutralHue:0, neutralChroma:0.000, accentHue:265, accentChroma:0.19,
      iris:"linear-gradient(135deg, #E9E9E7 0%, #E2E4EA 38%, #E4EAE7 68%, #EDE7E9 100%)"
    },
    dark: {
      rail:surf(LADDER.rail,0,0), paper:surf(LADDER.paper,0,0),
      card:surf(LADDER.card,0,0), cream:surf(LADDER.cream,0,0),
      gray:surf(LADDER.gray,0,0),
      ink:"#F5F5F3", accent:"#6D91F5", accentLight:"#93AFF9", mint:"#84C4A0", blush:"#E9A3B0",
      onAccent:"#04102E", neutralHue:0, neutralChroma:0.000, accentHue:265, accentChroma:0.14,
      iris:"linear-gradient(135deg, #333333 0%, #2F313B 38%, #2E3936 68%, #3A3235 100%)"
    }
  },
  {
    id: "moss",
    name: "Moss",
    blurb: "A green study. Pale sage canvas, off-white cards, brass.",
    light: {
      rail:"#12211A", paper:"#E4E9E1", card:"#FDFDF9", cream:"#EFEEDC", gray:"#DADFD6",
      ink:"#12211A", accent:"#D9B45C", accentLight:"#E9CE86", mint:"#9CCBAE", blush:"#E7B2B8",
      onAccent:"#2A2005", neutralHue:150, neutralChroma:0.014, accentHue:85, accentChroma:0.11,
      iris:"linear-gradient(135deg, #E8E2CC 0%, #DCE0DE 38%, #D2E4D4 68%, #E9E0D6 100%)"
    },
    dark: {
      rail:surf(LADDER.rail,.020,150), paper:surf(LADDER.paper,.020,150),
      card:surf(LADDER.card,.020,150), cream:surf(LADDER.cream,.032,110),
      gray:surf(LADDER.gray,.014,150),
      ink:"#E9F0E8", accent:"#D2AC56", accentLight:"#E3C57C", mint:"#8FC2A3", blush:"#DFA8AF",
      onAccent:"#221A03", neutralHue:150, neutralChroma:0.016, accentHue:85, accentChroma:0.11,
      iris:"linear-gradient(135deg, #35331F 0%, #2C3630 38%, #26382C 68%, #37322E 100%)"
    }
  },
  {
    id: "plum",
    name: "Plum",
    blurb: "Dusk. Soft mauve canvas, white and rose cards, apricot.",
    light: {
      rail:"#1E1622", paper:"#E8E2EA", card:"#FFFFFF", cream:"#F3E8EE", gray:"#DED8E2",
      ink:"#1E1622", accent:"#F0B27A", accentLight:"#F8CDA1", mint:"#A6D3C6", blush:"#EDAFC4",
      onAccent:"#2E1605", neutralHue:310, neutralChroma:0.016, accentHue:58, accentChroma:0.12,
      iris:"linear-gradient(135deg, #EADDD2 0%, #E0DAEC 38%, #D6E6E0 68%, #F0DCE6 100%)"
    },
    dark: {
      rail:surf(LADDER.rail,.022,310), paper:surf(LADDER.paper,.022,310),
      card:surf(LADDER.card,.022,310), cream:surf(LADDER.cream,.032,340),
      gray:surf(LADDER.gray,.016,310),
      ink:"#F1EAF4", accent:"#E9AB73", accentLight:"#F3C79C", mint:"#9BC9BC", blush:"#E4A5BA",
      onAccent:"#2A1304", neutralHue:310, neutralChroma:0.018, accentHue:58, accentChroma:0.12,
      iris:"linear-gradient(135deg, #392E26 0%, #322C3E 38%, #293834 68%, #3A2C37 100%)"
    }
  },
  {
    id: "ledger",
    name: "Ledger",
    blurb: "The original ledger. Teal ink, antique gold, warm cream paper.",
    // A revival, not a new composition: these are the values that shipped on
    // main before the Atrium redesign replaced them (see DESIGN.md's own
    // "confirmed rejection" of this identity as an anti-reference — reversed
    // on request, the same way the six-palette switch itself reversed an
    // earlier "one committed look" decision). Kept verbatim for the same
    // reason Atrium's own light composition is verbatim: re-solving an
    // already-shipped identity through this file's algorithm would produce a
    // plausible teal theme, not the one that actually existed. Kinetic
    // (scroll-reveal motion) and Velocity (a full dark/3D alternate world)
    // existed alongside this one on main and are not revived — Ledger is the
    // pre-redesign base the other two varied from, and the only one asked
    // for. Unlike the other six, this one also carries its own type and
    // shape character (see the trailing keys below) rather than sharing
    // Atrium's Switzer/radius/shadow system — that fidelity was the point of
    // asking for "full character" over a same-shape recolour.
    light: {
      verbatim: {
        "ink-950":"#062825", "ink-900":"#0A3634", "ink-800":"#0E4A46", "ink-700":"#145C57",
        "ink-600":"#1B726B", "ink-100":"#E6EFEC", "ink-50":"#F2F7F5",
        rail:"#0A3634", paper:"#F6F2E8", card:"#FFFFFE",
        // main never had a third/fourth card surface — that's an Atrium-era
        // idea (DESIGN.md: "the second and third cards take the cream and
        // gray surfaces"). Derived in OKLCH at the same lightness/chroma
        // offset from this palette's own paper that Atrium's cream/gray sit
        // at from ITS paper, so a stat row reads as four tiles here too.
        "surface-cream":"#FDF5E0", "surface-gray":"#ECE8DF",
        gold:"#AD8332", "gold-deep":"#75581D", "gold-light":"#E3CB8F",
        // Also new since main: the met/under-target rings on the week
        // timeline. Kept inside the teal/negative hue families already in
        // this palette rather than borrowed from Atrium's lime world.
        mint:"#9CC9BE", blush:"#E8B4B0",
        ink:"#1B2422",
        // #68766F, main's own shipped value, measured 4.26:1 on this exact
        // paper — under the 4.5:1 floor every other palette here is held to,
        // despite a comment on main claiming it had already been fixed (it
        // had, from a worse #8B968F; paper's own hex moved afterward and this
        // was never re-measured against the new value). Darkened four hex
        // steps, the same size correction Atrium's own first draft needed —
        // visually the same colour, now actually clearing the floor.
        // #637069 (one step darker than main's own #68766F) still measured
        // 4.24:1 against this palette's own surface-gray, which main never
        // had to clear since that surface didn't exist yet. One more step.
        muted:"#5E6A64", "muted-2":"#5F6B65",
        line:"#DDD3BB", "line-soft":"#EAE3D0",
        positive:"#256B42", "positive-bg":"#E3F1E7",
        info:"#145C57", "info-bg":"#E6EFEC",
        negative:"#AE3B3B", "negative-bg":"#F7E9E7",
        excused:"#755B14", "excused-bg":"#F2E9D2",
        warn:"#8A5F12", "warn-bg":"#FBF1DC", "warn-line":"#E4CB92",
        "input-bg":"#FFFFFF", rule:"rgba(173,131,50,.05)",
        "ink-on-gold":"#20180A", "muted-on-dark":"#C6D6D2",
        "positive-on-dark":"#9FD8A8", "negative-on-dark":"#E0A5A5",
        "negative-solid":"#C24A4A", "negative-deep":"#9C3434",
        "shadow-sm":"0 1px 2px rgba(10,54,52,.06), 0 1px 1px rgba(10,54,52,.04)",
        "shadow-md":"0 6px 20px rgba(10,54,52,.08), 0 2px 6px rgba(10,54,52,.05)",
        "shadow-lg":"0 16px 40px rgba(10,54,52,.14), 0 4px 12px rgba(10,54,52,.08)",
        "shadow-glow":"0 0 0 1px rgba(173,131,50,.14), 0 8px 28px rgba(173,131,50,.16)",
        "gradient-gold":"linear-gradient(135deg, #C7A155 0%, #AD8332 55%, #75581D 100%)",
        "gradient-ink":"linear-gradient(135deg, #145C57 0%, #0A3634 100%)",
        // The one decorative highlight surface Atrium reserves for the hero
        // stat (see DESIGN.md's "iridescent tile"). No equivalent on main —
        // authored here in the same warm-cream/gold/teal family as the rest
        // of this palette rather than left to fall back to Atrium's lime one.
        iris:"linear-gradient(135deg, #F2E4C8 0%, #E3CB8F 38%, #E6EFEC 68%, #F2E4C8 100%)",
        // Character beyond colour. Radius: main's own four-step scale, tighter
        // than Atrium's soft-cornered system throughout. Type: main's own
        // three-family split (a serif display face is exactly what Atrium's
        // Weight Rule forbids itself — Ledger is not bound by a rule written
        // for a different world). Both are system-font stacks, matching how
        // main actually shipped rather than substituting a self-hosted face
        // it never had.
        "radius-xs":"6px", "radius-sm":"8px", "radius-md":"10px", "radius-lg":"14px",
        "font-display":'"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif',
        "font-num":'Calibri,"Segoe UI",Candara,Optima,"Trebuchet MS",sans-serif'
      }
    },
    dark: {
      verbatim: {
        "ink-950":"#04201E", "ink-900":"#0B2E2C", "ink-800":"#124440", "ink-700":"#1A5B55",
        // Main's own --teal-600 (#2A8079) filled this ramp step, but main
        // never held it to being independently legible as a foreground the
        // way Atrium's ink-600 is (DESIGN.md: eleven color: uses, seven
        // border-color: ones) — it measured 2.36:1 on the ink-100 wash,
        // a wash this exact composition didn't exist against on main. Same
        // hue, lightened until it clears everywhere ink-600 has to.
        "ink-600":"#3DBAAF", "ink-100":"#1A423D", "ink-50":"#163831",
        rail:"#0B2E2C", paper:"#0B1917", card:"#152C29",
        // Darkened toward paper from main's #1D2B27, which measured only
        // 1.002:1 against card — indistinguishable, since main never carried
        // a third dark surface for this step to separate from.
        "surface-cream":"#2A2415", "surface-gray":"#17332C",
        gold:"#C79E4C",
        // Main's own #A8823A (the same hex used as the light-mode gold-deep,
        // reused rather than re-tuned for dark) measured 3.13:1 against the
        // ink-100 wash — a surface old Ledger's dark mode had no equivalent
        // of. Lightened until it clears; still reads as a deeper gold than
        // the fill above it.
        "gold-deep":"#CFA047", "gold-light":"#E7D3A0",
        mint:"#6FA898", blush:"#D99B94",
        ink:"#E8EDEA", muted:"#9DACA6",
        // Already correct on main — its own comment records fixing this one
        // (#7D8D87 at 4.14:1) before Ledger was ever retired.
        "muted-2":"#A9B7B1",
        line:"#35564F", "line-soft":"#2A4A44",
        positive:"#6BC08D", "positive-bg":"#183A28",
        info:"#7FD0C6", "info-bg":"#1A423D",
        // Main's #E08585 measured 4.16:1 against ink-100, the same
        // never-existed-on-main surface gold-deep just missed on. Lightened.
        negative:"#ED8D8D", "negative-bg":"#3C1F1F",
        excused:"#D9BC72", "excused-bg":"#38301A",
        warn:"#E0BE73", "warn-bg":"#33290F", "warn-line":"#5C4A20",
        "input-bg":"#0E201E", rule:"rgba(199,158,76,.05)",
        "ink-on-gold":"#20180A", "muted-on-dark":"#9DACA6",
        "positive-on-dark":"#6BC08D", "negative-on-dark":"#ED8D8D",
        "negative-solid":"#C24A4A", "negative-deep":"#9C3434",
        "shadow-sm":"0 1px 2px rgba(0,0,0,.45), 0 0 0 1px rgba(199,158,76,.04)",
        "shadow-md":"0 6px 20px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.4), 0 0 0 1px rgba(199,158,76,.05)",
        "shadow-lg":"0 18px 44px rgba(0,0,0,.6), 0 6px 16px rgba(0,0,0,.45), 0 0 0 1px rgba(199,158,76,.06)",
        "shadow-glow":"0 0 0 1px rgba(199,158,76,.28), 0 8px 30px rgba(199,158,76,.18)",
        "gradient-gold":"linear-gradient(135deg, #DDBB72 0%, #C79E4C 55%, #A8823A 100%)",
        "gradient-ink":"linear-gradient(135deg, #1A5B55 0%, #04201E 100%)",
        iris:"linear-gradient(135deg, #2E2A1C 0%, #3A3220 38%, #16302B 68%, #2E2A1C 100%)"
      }
    }
  }
];

// ------------------------------------------------------------------- compose
//
// Given an authored composition, solve the rest of the contract against it.

function compose(a, mode){
  const dark = mode === "dark";
  const nh = a.neutralHue, nc = a.neutralChroma;

  // Every surface a body-text colour can actually land on in this composition.
  // Solving against the worst of these — rather than against the card alone —
  // is the whole point: DESIGN.md records a pass where --muted cleared the
  // floor on white and failed on the canvas, cream and grey.
  const textGrounds = [a.paper, a.card, a.cream, a.gray];
  const L = hex => hexToOklch(hex)[0];

  // The neutral ramp. Its steps do not all mean the same KIND of thing, which
  // is what makes flipping it wholesale for dark mode wrong — a first pass did
  // exactly that and put the backup notice's title, `color:var(--ink-600)`, in
  // a mid-dark grey on a dark tint, where it was unreadable. Counting the
  // actual uses in the stylesheet settles each step:
  //
  //   ink-950/900/800/700 — dark FILLS that carry white text: the avatar tile,
  //     the admin pill, --gradient-ink, the open-shift hatch, and the
  //     accent-color of the checkboxes. A fill that carries #fff has to stay
  //     dark in both modes or the white text on it goes with it.
  //   ink-600 — a FOREGROUND: eleven `color:` uses (the backup title, the
  //     info toast's icon, the announcement icon, every ghost/tab hover) and
  //     seven `border-color:` ones (input focus, the active toggles). It is
  //     the step that has to invert, and it is the only one.
  //   ink-100/50 — WASHES, background-only, twenty-six uses between them:
  //     table headings, zebra rows, the sub-tab tray. They sit just under the
  //     card in light mode, so in dark they sit just under it too.
  const ramp = dark
    ? { "ink-950": oklchToHex([Math.max(L(a.rail)-0.03, 0), nc, nh]),
        "ink-900": a.rail,
        "ink-800": oklchToHex([L(a.rail)+0.045, nc, nh]),
        "ink-700": oklchToHex([L(a.rail)+0.09, nc, nh]),
        // Solved, not stepped: this one is read, so it owes the floor. 6:1
        // rather than 4.6 because it is also the focus border and the active
        // toggle's edge, and those want to be unmistakable rather than merely
        // legible.
        "ink-600": solve(nh, Math.min(nc*1.6, 0.03),
                    [a.paper, a.card, a.cream, a.gray], 6.0, "up"),
        "ink-100": oklchToHex([L(a.card)-0.045, nc, nh]),
        "ink-50":  oklchToHex([L(a.card)-0.025, nc, nh]) }
    : { "ink-950": oklchToHex([L(a.rail)-0.02, nc, nh]),
        "ink-900": a.rail,
        "ink-800": oklchToHex([L(a.rail)+0.04, nc, nh]),
        "ink-700": oklchToHex([L(a.rail)+0.09, nc, nh]),
        "ink-600": oklchToHex([L(a.rail)+0.16, nc, nh]),
        "ink-100": oklchToHex([L(a.paper)-0.01, nc, nh]),
        "ink-50":  oklchToHex([L(a.paper)+0.02, nc, nh]) };

  const washes = [ramp["ink-100"], ramp["ink-50"]];
  const allGrounds = textGrounds.concat(washes);

  // Secondary text: two steps, both cleared against every surface. 4.6 and 5.6
  // rather than 4.5 and 5.5 — a tenth of headroom, so a later nudge to a
  // surface does not silently drop a pair under the line.
  const muted   = solve(nh, Math.min(nc*1.6, 0.03), allGrounds, 4.6, dark ? "up" : "down");
  const muted2  = solve(nh, Math.min(nc*1.6, 0.03), allGrounds, 5.6, dark ? "up" : "down");

  // The text-capable accent. Its ROLE is constant — "the accent value you may
  // set a line or a word in" — but its direction flips with the mode: on a
  // light ground that means darker than the fill, on a dark ground lighter.
  // A palette that kept a dark accent in dark mode would have a chart's target
  // line disappear into the canvas.
  //
  // It also has to stay TELLABLE APART from the fill, which clearing a ratio
  // does not guarantee: solved unbounded, Terracotta's dark pair came out
  // #E28A51 against a #E89C5F fill — two shades of the same orange, so the
  // chart's target reference line would have vanished into the data drawn over
  // it. Bounding the search away from the fill's own lightness is what keeps
  // the two readable as different marks.
  const accentL = L(a.accent);
  const accentDeep = solve(a.accentHue, a.accentChroma, allGrounds, 4.6, dark ? "up" : "down",
    dark ? { min: Math.min(accentL + 0.09, 0.95) } : { max: Math.max(accentL - 0.09, 0.05) });

  // Status. Each foreground is solved against its own tint AND the plain
  // surfaces, because these land on both — a badge sits on its tint, the same
  // colour sets a figure straight on a card.
  //
  // The tint sits at a FIXED lightness, not at "canvas plus a bit". Derived
  // from the canvas it broke on the two palettes with the lightest canvases:
  // Studio's #F2F2F0 canvas pushed its tints past L=1.0 and every status
  // ground clipped to pure white, so a "leave" badge and an "under target"
  // badge were the same colourless chip. A tint is its own step in the system,
  // and it belongs at the lightness a tint reads at.
  const statusChroma = dark ? 0.11 : 0.13;
  const tintL = dark ? 0.255 : 0.930;
  const status = {};
  for(const [role, hue] of Object.entries(STATUS_HUES)){
    // `info` is the quiet one: it means "noted", not "good" or "wrong", and in
    // Atrium it is a plain dark neutral on a plain wash. Running it through the
    // status chroma turned that neutral into a colour — a pink info badge in
    // Studio, a green one in Moss, each reading as a meaning the role does not
    // have. It keeps the palette's own hue at the palette's own low chroma.
    const neutral = hue === null;
    const h = neutral ? nh : hue;
    const fgChroma = neutral ? Math.min(nc * 1.6, 0.03) : statusChroma;
    const bg = neutral
      ? (dark ? oklchToHex([L(a.card) - 0.015, nc, nh]) : ramp["ink-100"])
      : tint(h, dark ? 0.035 : 0.055, tintL);
    status[role] = {
      fg: solve(h, fgChroma, allGrounds.concat([bg]), 4.6, dark ? "up" : "down"),
      bg
    };
  }

  // A solid danger button is a FILL, and --negative is tuned as a text colour:
  // too light to carry white text at body size. Solve its own pair instead of
  // reusing the text value, which is the mistake DESIGN.md records.
  const negSolid = solve(STATUS_HUES.negative, 0.16, ["#FFFFFF"], 4.6, "down");
  const negDeep  = solve(STATUS_HUES.negative, 0.16, ["#FFFFFF"], 7.0, "down");

  // Lines are graphical, not text: 1.4.11's 3:1 applies to the ones that carry
  // meaning. --line does; --line-soft is decorative separation and sits below.
  const line     = dark ? oklchToHex([L(a.card)+0.09, nc, nh]) : oklchToHex([L(a.paper)-0.055, nc, nh]);
  const lineSoft = dark ? oklchToHex([L(a.card)+0.045, nc, nh]) : oklchToHex([L(a.paper)-0.02, nc, nh]);

  // Shadows. On a light ground they are ambient depth; on a dark one they are
  // nearly invisible and elevation comes from the surface steps instead — so
  // dark keeps a shadow only to seat a modal, and leans on the ramp for the
  // rest. Mechanically inverting the light shadows would give dark mode a set
  // of grey halos that read as fog.
  const sh = dark
    ? { sm:"0 1px 2px rgba(0,0,0,.40), 0 1px 3px rgba(0,0,0,.30)",
        md:"0 8px 24px rgba(0,0,0,.46), 0 2px 8px rgba(0,0,0,.34)",
        lg:"0 20px 48px rgba(0,0,0,.60), 0 6px 16px rgba(0,0,0,.44)" }
    : { sm:`0 1px 2px ${rgba(a.ink,.04)}, 0 1px 3px ${rgba(a.ink,.03)}`,
        md:`0 8px 24px ${rgba(a.ink,.07)}, 0 2px 8px ${rgba(a.ink,.04)}`,
        lg:`0 20px 48px ${rgba(a.ink,.13)}, 0 6px 16px ${rgba(a.ink,.08)}` };

  return {
    ...ramp,
    rail: a.rail, paper: a.paper, card: a.card,
    "surface-cream": a.cream, "surface-gray": a.gray,
    gold: a.accent, "gold-light": a.accentLight, "gold-deep": accentDeep,
    mint: a.mint, blush: a.blush,
    ink: a.ink, muted, "muted-2": muted2,
    line, "line-soft": lineSoft,
    positive: status.positive.fg, "positive-bg": status.positive.bg,
    negative: status.negative.fg, "negative-bg": status.negative.bg,
    excused: status.excused.fg, "excused-bg": status.excused.bg,
    warn: status.warn.fg, "warn-bg": status.warn.bg,
    "warn-line": oklchToHex([dark ? L(a.card)+0.14 : L(a.paper)-0.09, 0.06, STATUS_HUES.warn]),
    info: status.info.fg, "info-bg": status.info.bg,
    "input-bg": dark ? oklchToHex([L(a.card)+0.015, nc, nh]) : a.card,
    rule: rgba(a.ink, dark ? .16 : .05),
    "ink-on-gold": a.onAccent,
    // On a dark surface in LIGHT mode these are the rail's text colours. In
    // dark mode the whole app is that surface, so they converge on the general
    // secondary/status values rather than staying a separate set.
    "muted-on-dark": dark ? muted : solve(nh, Math.min(nc*1.6,0.03), [a.rail], 4.6, "up"),
    "positive-on-dark": dark ? status.positive.fg : solve(STATUS_HUES.positive, 0.09, [a.rail], 4.6, "up"),
    "negative-on-dark": dark ? status.negative.fg : solve(STATUS_HUES.negative, 0.09, [a.rail], 4.6, "up"),
    "negative-solid": negSolid, "negative-deep": negDeep,
    "shadow-sm": sh.sm, "shadow-md": sh.md, "shadow-lg": sh.lg,
    "shadow-glow": `0 0 0 1px ${rgba(a.accent,.55)}, 0 8px 28px ${rgba(a.accent,.22)}`,
    "gradient-gold": `linear-gradient(135deg, ${a.accentLight} 0%, ${a.accent} 55%, ${oklchToHex([hexToOklch(a.accent)[0]-0.07, hexToOklch(a.accent)[1], hexToOklch(a.accent)[2]])} 100%)`,
    "gradient-ink": `linear-gradient(135deg, ${ramp["ink-700"]} 0%, ${ramp["ink-900"]} 100%)`,
    "gradient-iris": a.iris
  };
}

function rgba(hex, alpha){
  const [r,g,b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${String(alpha).replace(/^0/,"")})`;
}

// ---------------------------------------------------------------- emit / test

const ORDER = ["ink-950","ink-900","ink-800","ink-700","ink-600","ink-100","ink-50",
  "rail","paper","card","surface-cream","surface-gray","gold","gold-deep","gold-light",
  "mint","blush","ink","muted","muted-2","line","line-soft","positive","positive-bg",
  "info","info-bg","negative","negative-bg","excused","excused-bg","warn","warn-bg",
  "warn-line","input-bg","rule","ink-on-gold","muted-on-dark","positive-on-dark",
  "negative-on-dark","negative-solid","negative-deep","shadow-sm","shadow-md",
  "shadow-lg","shadow-glow","gradient-gold","gradient-ink","gradient-iris",
  // Character tokens beyond colour: only Ledger's verbatim block populates
  // these (see its own comment), so they emit nothing for the other six —
  // block() skips any key a palette doesn't set. Light-only is deliberate:
  // both selectors match the same <html> element at once, and a custom
  // property a later (dark) rule doesn't redeclare keeps whatever an earlier
  // (light) matching rule set, so these survive into dark mode without
  // needing a second copy.
  "radius-xs","radius-sm","radius-md","radius-lg","font-display","font-num"];

export function build(){
  const out = {};
  for(const p of PALETTES){
    out[p.id] = {
      name: p.name, blurb: p.blurb,
      light: p.light.verbatim
        ? (p.id === "atrium"
            ? { ...p.light.verbatim,
                "shadow-sm":`0 1px 2px rgba(17,17,16,.04), 0 1px 3px rgba(17,17,16,.03)`,
                "shadow-md":`0 8px 24px rgba(17,17,16,.07), 0 2px 8px rgba(17,17,16,.04)`,
                "shadow-lg":`0 20px 48px rgba(17,17,16,.13), 0 6px 16px rgba(17,17,16,.08)`,
                "shadow-glow":`0 0 0 1px rgba(214,232,92,.55), 0 8px 28px rgba(214,232,92,.22)`,
                "gradient-gold":`linear-gradient(135deg, var(--gold-light) 0%, var(--gold) 55%, #B9CF3E 100%)`,
                "gradient-ink":`linear-gradient(135deg, var(--ink-700) 0%, var(--ink-900) 100%)`,
                "gradient-iris": p.light.verbatim.iris }
            : { ...p.light.verbatim, "gradient-iris": p.light.verbatim.iris })
        : compose(p.light, "light"),
      // Ledger's dark composition is a second verbatim block, not solved: it
      // is a real, previously-shipped design (main's body.dark) with its own
      // already-correct contrast decisions (its own comment records fixing
      // --muted-2 the same way), and re-deriving it through compose() would
      // produce a plausible teal theme rather than the one that actually
      // existed. The other five palettes have no dark.verbatim, so this is a
      // no-op for them.
      dark: p.dark.verbatim ? p.dark.verbatim : compose(p.dark, "dark")
    };
    delete out[p.id].light.iris;
    if(out[p.id].dark.iris) delete out[p.id].dark.iris;
  }
  return out;
}

function css(){
  const built = build();
  const lines = [];
  const block = (sel, tokens, indent = "  ") => {
    lines.push(`${indent}${sel}{`);
    for(const k of ORDER){
      if(tokens[k] == null) continue;
      lines.push(`${indent}  --${k}:${tokens[k]};`);
    }
    lines.push(`${indent}}`);
  };
  for(const [id, p] of Object.entries(built)){
    block(`html[data-palette="${id}"], .theme-preview[data-palette="${id}"]`, p.light);
  }
  for(const [id, p] of Object.entries(built)){
    block(`html[data-theme="dark"][data-palette="${id}"], .theme-preview[data-theme="dark"][data-palette="${id}"]`, p.dark);
  }
  return lines.join("\n");
}

function report(){
  const built = build();
  const rows = [];
  for(const [id, p] of Object.entries(built)){
    for(const mode of ["light","dark"]){
      const t = p[mode];
      const grounds = { card:t.card, paper:t.paper, cream:t["surface-cream"],
                        gray:t["surface-gray"], w100:t["ink-100"], w50:t["ink-50"] };
      const check = (fg, ratio, only) => {
        let worst = Infinity, where = "";
        for(const [n,g] of Object.entries(only ? {[only]:grounds[only]} : grounds)){
          const c = contrast(t[fg], g);
          if(c < worst){ worst = c; where = n; }
        }
        rows.push({ palette:id, mode, token:fg, worst:worst.toFixed(2), on:where,
                    need:ratio, pass: worst >= ratio });
      };
      check("ink", 4.5); check("muted", 4.5); check("muted-2", 4.5); check("gold-deep", 4.5);
      for(const s of ["positive","negative","excused","warn","info"]){
        let worst = Infinity, where = "";
        for(const [n,g] of Object.entries({ ...grounds, own: t[s+"-bg"] })){
          const c = contrast(t[s], g);
          if(c < worst){ worst = c; where = n; }
        }
        rows.push({ palette:id, mode, token:s, worst:worst.toFixed(2), on:where, need:4.5, pass: worst >= 4.5 });
      }
      rows.push({ palette:id, mode, token:"ink-on-gold", worst:contrast(t["ink-on-gold"], t.gold).toFixed(2),
                  on:"gold", need:4.5, pass: contrast(t["ink-on-gold"], t.gold) >= 4.5 });
      rows.push({ palette:id, mode, token:"muted-on-dark", worst:contrast(t["muted-on-dark"], t.rail).toFixed(2),
                  on:"rail", need:4.5, pass: contrast(t["muted-on-dark"], t.rail) >= 4.5 });
      rows.push({ palette:id, mode, token:"white-on-neg-solid", worst:contrast("#FFFFFF", t["negative-solid"]).toFixed(2),
                  on:"fill", need:4.5, pass: contrast("#FFFFFF", t["negative-solid"]) >= 4.5 });

      // Structural separation. Atrium separates cards from the canvas and from
      // each other by SURFACE, not by borders — "Cards have no border" and "In
      // a stat row, the second and third cards take the cream and gray
      // surfaces so a four-tile row reads as four tiles". A palette whose
      // surfaces collapse into each other loses the mechanism the whole system
      // uses to group things, so the steps are asserted rather than assumed.
      const sep = (a, b, label, need) => {
        const c = contrast(t[a], t[b]);
        rows.push({ palette:id, mode, token:label, worst:c.toFixed(3), on:b, need, pass: c >= need });
      };
      sep("card", "paper", "card/canvas step", 1.05);
      sep("surface-cream", "card", "cream/card step", 1.02);
      sep("surface-gray", "card", "gray/card step", 1.02);
      // 1.30 on a light canvas, where the rail is the one dark region and
      // clears it by 15:1 with room to spare; 1.18 on a dark one, which is the
      // most a near-black pair can hold (see LADDER) and is backed by a
      // hairline in the stylesheet.
      sep("rail", "paper", "rail/canvas step", mode === "dark" ? 1.18 : 1.30);

      // --line is a decorative hairline, not a WCAG 1.4.11 graphical object:
      // the marks that carry facts here are the calendar dot (--muted-2), the
      // chart's target line (--gold-deep) and today's cell border (--ink), all
      // of which are measured above at text grade. Holding a separator to 3:1
      // would fail the shipped Atrium too, which sits at 1.2:1 deliberately.
      // What a line does owe is being visible at all.
      sep("line", "paper", "line visible", 1.12);
    }
  }
  const bad = rows.filter(r => !r.pass);
  for(const r of rows){
    console.log(`${r.pass ? "  ok " : "FAIL "}${r.palette.padEnd(11)} ${r.mode.padEnd(5)} ${r.token.padEnd(20)} ${String(r.worst).padStart(6)} : 1  (need ${r.need}, worst on ${r.on})`);
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} pairs clear the floor.`);
  if(bad.length) process.exitCode = 1;
}

// Only when run directly. This file also exports build() and contrast(), and
// an unguarded top-level console.log meant importing it printed 600 lines of
// CSS into the importer's stdout.
if(process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href){
  const arg = process.argv[2];
  if(arg === "--report") report();
  else if(arg === "--json") console.log(JSON.stringify(build(), null, 2));
  else console.log(css());
}
