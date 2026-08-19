# Velocity — Design System

The **Velocity** org theme: the Attendance Ledger rendered as a driver's
instrument cluster.

This document covers Velocity only. The app's default world is **Ledger**,
documented in [`DESIGN.md`](DESIGN.md); Velocity deliberately does not follow
it. Both ship simultaneously — an administrator picks the org-wide theme in
Admin → Themes & Layouts, and the database is the authority on which values
are valid (`app_settings.theme`, guarded by a `CHECK` constraint).

---

## 1. Brand concept

> A cockpit, not a showroom.

Velocity's reference is the instrument binnacle of a high-performance car:
the surfaces a driver actually touches and reads at speed. Machined
housings, a woven carbon panel, seven-segment readouts, and one crimson that
only ever marks something live.

It is an **original identity**. Nothing in it reproduces any manufacturer's
marks, badges, model names, or artwork. The vocabulary is generic motorsport
and instrumentation: tachometer arcs, redline zones, sector timing, carbon
weave, lap deltas.

### The three invariants

| Rule | Statement |
|---|---|
| **Redline** | Crimson marks live state, peak values, the primary action, and the over-target arc. It is never a surface fill. *If crimson is covering area, it is wrong.* |
| **Carbon** | Elevated surfaces carry a woven twill, never a flat grey. |
| **Instrument** | Numbers of record are seven-segment; labels are monospace and tracked out. The two never swap faces. |

**Confirmed anti-reference:** the previous Velocity world — a marketing-style
hero with a pointer-tracked 3D car showcase. Velocity is now read from the
driver's seat, not the stand.

---

## 2. Colour

Everything is defined as a token override inside
`body[data-ui-theme="velocity"]`. Because the app is token-driven, redefining
this block re-skins every existing component — cards, tables, forms, modals,
pills, and the hand-rolled SVG charts — without touching a component rule.

### Base — carbon, graphite, gunmetal
| Token | Value | Role |
|---|---|---|
| `--paper` | `#08090C` | the deepest ground |
| `--card` | `#0F1216` | carbon panel |
| `--input-bg` | `#0A0C10` | recessed control |
| `--teal-800/700` | `#12151B` / `#181C23` | machined housings (header, hero) |

### Titanium — text
| Token | Value | Measured on `--card` |
|---|---|---|
| `--ink` | `#E6E9EE` | primary readout |
| `--muted` | `#8B939F` | 4.6:1 — secondary |
| `--muted-2` | `#A6AEBA` | 6.6:1 — meaningful secondary |

### Redline — the accent
| Token | Value | Role |
|---|---|---|
| `--gold` | `#D5082A` | the app's single accent slot; progress fills, stat-card top bar, chart target line |
| `--gold-deep` | `#8E0119` | gradient shadow |
| `--gold-light` | `#FF4A62` | gradient highlight |
| `--teal-600` | `#E01836` | live/active/focus accent |
| `--v-redline` | `#FF2D46` | needle, peak, over-target |

### Status — restrained by design
Red is the theme's voice, so a shouting green would fight it. These sit one
step back and let crimson lead.

`--positive` `#31C07A` · `--negative` `#FF4658` · `--warn` / `--excused`
`#D9A441` · `--info` `#7FB2D9`

### Measured accessibility
A full WCAG sweep across all six tabs, computing each text node's contrast
against its true effective background (walking ancestors until something
opaque is found):

- **AA (4.5:1 normal / 3:1 large): 0 failures.**
- At a 7.5:1 bar (beyond AAA), 25 near-misses, the lowest at **5.58:1**.

So the palette clears AA everywhere and clears AAA nearly everywhere.

---

## 3. Typography

Three faces, all self-hosted in `themes/velocity/fonts/`. They are referenced
only by elements that are `display:none` in other themes, so **no font file
is fetched unless Velocity is actually on.**

| Face | Role |
|---|---|
| **Big Shoulders Display** | the app title — poster-condensed |
| **JetBrains Mono** | the technical voice: labels, eyebrows, buttons, card titles, table headers, form fields |
| **DSEG7 Classic** | seven-segment readouts: stat values, hero value, numeric table cells, the clock |

### The fallback contract
DSEG7 draws digits and a little punctuation — no letterforms. Every
seven-segment stack is therefore
`"DSEG7 Classic","JetBrains Mono",ui-monospace,monospace`, which lets
JetBrains Mono pick up `%`, `—`, parentheses and the rest *per character*.

**Corollary — the `is-text` opt-out.** A readout that is mostly words (a
month name) would render as mono letters with seven-segment digits spliced
in. Any value that is not a number of record takes `.v-sector.is-text` and
leaves the segment face entirely, set a size down as a label.

---

## 4. Geometry, depth, motion

**Radius** — near-square, because a cockpit is milled, not moulded:
`--radius` 4px · `--radius-md` / `--radius-sm` 3px · `--radius-xs` 2px.

**Depth** — black for mass plus a hairline top highlight, so a panel reads as
a lit edge rather than a floating rectangle. `--shadow-glow` is crimson.

**Motion** — mechanical: fast out, settled arrival, nothing floats.

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 110ms | button/hover feedback |
| `--dur-base` | 180ms | state transitions |
| `--dur-slow` | 300ms | panel arrival |
| `--ease-snap` | `cubic-bezier(.2,.7,.3,1)` | touch-driven |
| `--ease-soft` | `cubic-bezier(.16,1,.3,1)` | settling |

Buttons **travel** rather than scale: `:active` moves the control 1px down
and swaps its top highlight for an inset shadow. A switch has travel; it
does not shrink.

**Every animation sits behind `prefers-reduced-motion: no-preference`.** A
device asking for calm gets the complete interface with no movement — never
a degraded or hidden one. The tachometer needle is still placed at its exact
value; it simply doesn't perform the sweep on the way there.

---

## 5. The instrument cluster (signature component)

A tachometer whose sweep is **this month's average against the daily
target**, with an over-target redline band.

### Geometry
- 250° sweep, opening at the bottom. At `r=100` the circumference is 628.32,
  so the visible arc is **436.33** units.
- The needle is drawn pointing straight up, so its travel is **−125°** at
  zero to **+125°** at full.
- **Full deflection is 130% of target.** That places the 100% mark at 0.769
  of the sweep — exactly where the redline band starts. This is what makes
  the redline *mean* "over target" instead of being decoration.

### Data contract
The cluster never computes a figure. `renderStats()` publishes the
month-average-over-target ratio once, as `data-ratio` on the hero progress
bar; the needle, the arc offset, the "target met" percentage and the
over/on/under chip all derive from that single value. The bar stays clamped
to 100%; the gauge deliberately takes the overshoot.

### Accessibility
The whole section is `aria-hidden="true"`. Every number it shows is
announced once, from the real stat cards below it — the cluster is a visual
echo, never a second source of truth.

### One writer for the needle
The ignition self-test (zero → full → settle) is stepped from JavaScript
using the same inline transform the value sync writes, with the needle's CSS
transition doing the interpolation. It is **not** a keyframe animation: an
animation with any fill mode that holds its last frame outranks an inline
style, which parks the needle at the keyframe's angle instead of at the
figure it is reporting.

---

## 6. Components

**Cards** — carbon gradient panel, hairline border, a 2px crimson bar clipped
to the top edge of a stat card. A woven twill sits in a `::before` (so it
never tints text) and is masked to fade downward, catching light at the top.

**Red stitching** — a dashed crimson hairline inset from the edge of the
headline panel, the way a seat bolster is stitched. **One** panel only; it
stops being a detail if it is everywhere.

**Tables → sector timing** — the base theme tints a flagged row across its
whole width, which on carbon becomes mud. Here the tint drops to a trace and
the meaning moves to a **3px sector bar on the leading edge**, coloured per
status, exactly the way a timing screen colours a sector.

**Pills** — outlined rather than filled, uppercase mono, with a glowing
`currentColor` dot as a live-channel indicator.

**Loading** — the app's existing per-card skeletons, restyled: the soft
shimmer becomes a hard crimson edge scanning a dark channel, the way a
readout populates. There is deliberately **no full-screen boot splash** —
see `THEME_AUDIT.md`.

**Empty states** — uppercase tracked mono inside a dashed rule: a system
reporting no signal rather than a page apologising.

---

## 7. Responsive

The cluster is redesigned per breakpoint, not shrunk.

| Width | Behaviour |
|---|---|
| ≥900px | three columns — readouts, gauge, readouts |
| <900px | gaps and readout type step down |
| <760px | the gauge takes a full-width row of its own, the flanking readouts drop beneath it as a two-column strip, and sectors stack. The gauge keeps its size instead of being squeezed by its siblings. |
| <380px | eyebrow and label tracking tighten |

Verified: **no horizontal page scroll at 1440px or 390px**, and the project's
grid suite passes at all 18 measured widths from 1280px down to 320px.

---

## 8. Extending

A new theme is five touchpoints:

1. `themes/<name>/theme.css` (plus `fonts/` if it needs any)
2. a `<link>` in `index.html`
3. an `<option>` in the Admin `#setTheme` select
4. an entry in `UI_THEMES` in `app.js` (with a `hint`)
5. a migration extending `app_settings_theme_check`

Scope **every** rule to `body[data-ui-theme="<name>"]`, or to an element that
is `display:none` outside the theme. This is what guarantees a theme cannot
leak into the other three — verified for Velocity by asserting that Ledger's
tokens, its gold divider, and its circular icon badges are all byte-identical
with the theme on and off.
