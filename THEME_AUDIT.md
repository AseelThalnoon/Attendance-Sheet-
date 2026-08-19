# Theme Audit — Velocity rebuild

Rebuild of the **Velocity** org theme from a marketing-style 3D car showcase
into a driver's instrument cluster. Baseline commit `5175cc3`.

The system itself is documented in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).

---

## 1. Scope decision

The brief asked to "completely redesign the existing web application." This
repo does not work that way, and following the brief literally would have
been destructive:

- Visual worlds here are **additive, opt-in org themes** (`ledger`,
  `kinetic`, `velocity`), selected by an admin and validated by a database
  `CHECK` constraint.
- `PRODUCT.md` records Ledger as *"a deliberate choice, not a placeholder
  waiting for a rebrand."*
- **Velocity already occupied most of the requested design space** — carbon
  surfaces, a red accent, sharp radii, mono + seven-segment type. A fourth
  dark performance theme would have duplicated it.

Chosen instead, and confirmed with the user before any code was written:
**rebuild Velocity in place.** Ledger and Kinetic are untouched, no migration
is required (`velocity` is already a valid `CHECK` value), and the change is
revertible with `git revert`.

The differentiator: the old Velocity was a **showroom** (hero showcase,
poster headline, a car on a stand). The new one is a **cockpit** (dial,
readouts, sector timing) — read from the driver's seat, not the stand.

---

## 2. What changed

### `themes/velocity/theme.css` — rewritten (348 → 746 lines)
Complete token overhaul (carbon/titanium/crimson), carbon-weave surfaces,
red stitching, machined button travel, sector-timing tables, telemetry chart
surfaces, restyled skeleton loading, system-voice empty states, and the
instrument cluster.

### `index.html`
- The `.v-hero` car showcase (a ~60-line hand-drawn car SVG, wheels,
  headlights, reflection, speed lines) replaced by the cluster: tachometer,
  flanking readouts, sector strip.
- `hero-progress-fill` now publishes `data-ratio` for the gauge.
- Theme option relabelled "Velocity — instrument cluster".

### `app.js`
- `velocityMotion` rewritten: pointer tracking removed, gauge driver added.
- `syncVelocitySpecs()` extended to drive needle, arc, percentage and state.
- `applyUiTheme()` now re-renders charts (**bug fix**, below).
- `UI_THEMES.velocity.hint` updated.

### Docs
`DESIGN.md` Velocity entry rewritten; `DESIGN_SYSTEM.md` and this file added.

**Not changed:** no schema change, no API change, no auth change, no routing
change, no business logic, no copy outside the theme selector's own label.
All 321 existing tests pass.

---

## 3. Bugs found and fixed

**① Charts kept the previous theme's palette after a theme switch.**
*Pre-existing.* Charts bake colours in at render time — `cssVar("--gold")`,
`--positive`, `--negative`, `--line` are read when the SVG string is built.
`applyTheme()` (light/dark) called `renderCharts()` for exactly this reason;
`applyUiTheme()` (org theme) never did. Switching Ledger → Velocity left
every chart drawn in Ledger gold on carbon. Fixed by re-rendering on org
theme change.

**② Needle parked at the wrong angle.**
*Introduced and fixed during this work.* The ignition sweep was a CSS
keyframe animation with `both` fill. A held animation frame outranks an
inline style, so once the sweep finished the needle sat at the keyframe's
angle (0°, straight up) rather than at the value — a gauge confidently
reporting the wrong number. Rebuilt as JS-stepped inline transforms over the
needle's CSS transition, so there is exactly one writer for the angle.
Verified: needle settles at `rotate(60.1deg)` for a 96.25%-of-target figure
(`−125 + (0.9625/1.3)×250 = 60.1` ✓).

**③ Gauge readout overflowed the dial.** Six characters of DSEG7 at the
original size spilled past the arc at every width, and the state chip
collided with it. Centre block constrained to the arc's inner diameter
(19% inset each side); chip moved into normal flow, in the dial's opening.

**④ ~74 units of dead space under the dial.** The gauge SVG was `300×300`
while the arc bottoms out at y≈214, pushing the sector strip away from the
cluster. `viewBox` cropped to `300×226`.

---

## 4. Pre-existing issues found (not fixed here)

**Hard-coded Ledger colours that no theme can reach.** Three literals in
`index.html` bypass the token system, so they survive any theme override and
had to be neutralised individually in the theme file:

| Location | Literal | Effect on carbon |
|---|---|---|
| `.hero-col-meta` border-left | `rgba(227,203,143,.5)` | stray olive divider |
| `.stat-label svg` box-shadow | `rgba(173,131,50,.35)` | warm glow |
| `.hero-stat .skeleton-overlay` bg | `rgba(6,40,37,.96)` | green loading panel |

**The real fix is to tokenise them in `index.html`.** That is a change to
the shared base stylesheet, which is out of scope for a theme rebuild —
recommended as a follow-up.

**`label.sr-only` reported as overflowing.** The project's `mobile/scan.js`
flags it at all five phone widths. This is a **scanner false positive**:
`.sr-only` is correctly defined (1×1, `clip: rect(0 0 0 0)`), and the
scanner is measuring its internal `scrollWidth`, which is inherent to the
visually-hidden idiom. Present in `HEAD`, unrelated to this work.

**`mobile/scan.js` only covers the light/dark preference, not org themes.**
Two of three org themes have never been contrast-scanned by the suite. This
rebuild's palette was verified with a purpose-built sweep (below), but that
coverage is not yet in the repo — the highest-value follow-up here.

---

## 5. Verification

Everything below was measured, not asserted.

| Check | Result |
|---|---|
| Existing test suite | **321/321 pass** (parsers 79, modal 12, clock 17, audit-logic 43, audit-dom 15, admin-tab 74, controls 32, collision 49) |
| Responsive grid suite | 108 measurements ≥170px floor, 18 widths (1280→320px) |
| WCAG AA, all 6 tabs | **0 failures** |
| Beyond-AAA probe (7.5:1) | 25 near-misses, lowest 5.58:1 |
| Horizontal page scroll | none at 1440px or 390px |
| JS console/page errors | none |
| Needle accuracy | `rotate(60.1deg)` — matches the formula exactly |
| Reduced motion | needle placed immediately at value, no sweep |
| **Ledger isolation** | tokens, gold divider (`rgba(227,203,143,.5)`) and circular icon badges (`50%`) all **identical** with Velocity on and off; `.v-hero` `display:none` |
| Dead CSS | no unused `.v-*` selectors, no unused keyframes |

Contrast was verified through the real production path — driving the Admin
theme `<select>`'s change handler rather than reimplementing the sync — so
what was measured is what ships.

---

## 6. Performance

**Net reduction.** The rebuild removed more runtime work than it added:

- **Removed** a global `mousemove` listener plus a permanent
  `requestAnimationFrame` loop that ran every frame for as long as the theme
  was active, whether or not anything moved. The cluster is **idle at rest**;
  the needle only moves when the underlying figures do.
- **Removed** per-card `getBoundingClientRect()` on every pointer move (the
  3D card tilt), a layout read in a mousemove handler.
- **Removed** the 3D card `perspective`/`preserve-3d` layers and the hero's
  blurred reflection (`filter: blur(16px)` over a large element).
- **Zero new network weight**: the three faces were already shipped and are
  reused; the cluster is inline SVG; the carbon weave, grid floor and speed
  language are all CSS gradients. **No raster assets were added.**
- `will-change` no longer appears in the theme at all.
- Panel arrival still uses `animation-timeline: view()` where supported —
  off the main thread — and is gated on `prefers-reduced-motion`.

---

## 7. Deliberate decisions worth knowing

**No per-card gauge arcs.** Mini-gauges on the six stat cards were planned.
They were dropped because the app has no per-card target data — a gauge
there would have to invent its denominator, i.e. render a fabricated
measurement. A cockpit that displays made-up numbers is worse than one with
fewer dials.

**No full-screen boot splash.** The app already has a loading experience
(per-card skeletons with a live region). A splash would be a second loading
state competing with the real one, and a fixed overlay only JS can remove is
a black screen for anyone whose JS fails — the exact failure the scroll-reveal
gate in `index.html` is deliberately written to avoid. The existing skeletons
were restyled into the cockpit language instead.

**No favicon/app-icon swap.** `favicon-*.png` and `apple-touch-icon.png` are
shared by all themes, and Ledger is still the default. Swapping them for a
Velocity mark would misrepresent the app in three of four configurations.
Velocity's identity stays inside Velocity.

**No trademarked material.** No manufacturer marks, badges, model names, or
artwork. The vocabulary is generic motorsport instrumentation.

**`theme.css` is 746 lines, over the repo's 500-line guidance.** Kept as one
file deliberately: the `themes/<name>/theme.css` convention is what
`index.html` links, and splitting it would add an HTTP request to a no-build
static PWA — working against the performance goal. Flagged rather than
silently ignored.

---

## 8. Remaining risks and recommended next steps

1. **Extend `mobile/scan.js` to cover org themes.** Highest value: two of
   three themes are currently unscanned for contrast and overflow by CI.
2. **Tokenise the three hard-coded Ledger literals** in `index.html` (§4) so
   themes stop needing per-case overrides.
3. **Verify against real data.** All rendering was verified with seeded
   figures through the production code path; no live Supabase session was
   exercised. Long values (e.g. a 3-digit overtime figure) should be spot-
   checked once against a real account.
4. **Charts were restyled via tokens and surface rules, not redrawn.** They
   adopt the palette and the mono label face correctly, but the SVG geometry
   (bar corners, tick density, tooltip shape) is still Ledger's. A genuine
   telemetry redraw would be a separate, larger piece of work.
5. **The `.seal` element** is Ledger's ornament; in Velocity it is squared
   and de-animated into a status housing rather than removed, since it holds
   the day's live status. Worth a look in a real session to confirm it reads
   as intended.
