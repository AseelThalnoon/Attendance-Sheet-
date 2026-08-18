---
name: Attendance Ledger
description: A warm, editorial ledger-book system — teal ink and antique gold on aged paper — for a personal and small-team attendance record.
colors:
  teal-ink-deepest: "#062825"
  deep-teal-ink: "#0A3634"
  teal-ink-elevated: "#0E4A46"
  teal-ink-mid: "#145C57"
  teal-ink-bright: "#1B726B"
  teal-wash: "#E6EFEC"
  teal-wash-soft: "#F2F7F5"
  aged-paper: "#F6F2E8"
  card-surface: "#FFFFFE"
  antique-gold: "#AD8332"
  antique-gold-deep: "#75581D"
  antique-gold-light: "#E3CB8F"
  ink: "#1B2422"
  muted: "#68766F"
  muted-deep: "#5F6B65"
  line: "#DDD3BB"
  line-soft: "#EAE3D0"
  positive: "#256B42"
  positive-bg: "#E3F1E7"
  info: "#145C57"
  info-bg: "#E6EFEC"
  negative: "#AE3B3B"
  negative-bg: "#F7E9E7"
  excused: "#755B14"
  excused-bg: "#F2E9D2"
  warn: "#8A5F12"
  warn-bg: "#FBF1DC"
  warn-line: "#E4CB92"
  input-bg: "#FFFFFF"
typography:
  display:
    fontFamily: "\"Iowan Old Style\", \"Palatino Linotype\", Palatino, Georgia, \"Times New Roman\", serif"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 400
    lineHeight: 1.45
  numeral:
    fontFamily: "Calibri, \"Segoe UI\", Candara, Optima, \"Trebuchet MS\", sans-serif"
    fontWeight: 700
    lineHeight: 1
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  pill: "99px"
spacing:
  sm: "10px"
  md: "14px"
  lg: "22px"
components:
  button-primary:
    backgroundColor: "linear-gradient(135deg, {colors.teal-ink-mid} 0%, {colors.deep-teal-ink} 100%)"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-secondary:
    backgroundColor: "{colors.card-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  card:
    backgroundColor: "{colors.card-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "22px 22px 24px"
---

# Design System: Attendance Ledger

## Overview

**Creative North Star: "The Gilt Ledger"**

This is a physical ledger book rendered as an interface: an aged-paper page holding deep-teal-ink cards, closed with a wax-seal badge, trimmed in antique gold rather than filled with it. The dominant surface color is never white — it's `--paper`, a warm off-white — and the near-white `--card` sits on top of it as the "page" the ink is written on. Numbers get their own voice: a humanist sans with tabular figures for anything that has to line up in a column (hours, totals, times), while a serif display face carries every section title and heading, so a screen full of stats still reads like a page from a bound record book rather than a spreadsheet.

Gold is a trim, never a fill: the gradient accent bar across the top of a stat card, the diamond bullet before a card heading, the wax-seal's ring, the fill of a progress bar. It never becomes a background or a dominant surface. Motion is short and decisive on anything touch-driven (buttons, hovers: 130ms), longer and softer on anything that's arriving into place (panels, modals: 320–450ms) — captured as two named eases, `--ease-snap` and `--ease-soft`, rather than picked ad hoc per component.

Confirmed rejection: no generic SaaS/corporate-dashboard look — flat blue-and-white enterprise chrome is the explicit anti-reference. The ledger identity is a deliberate choice, not a placeholder waiting for a rebrand.

**Key Characteristics:**
- Aged paper page, not white canvas — cards read as pages sitting on the paper, not panels floating on white.
- Gold is trim and accent only, applied in thin, deliberate strokes, never as a fill.
- Serif for titles, tabular sans for numbers — a two-voice type system, not one font doing both jobs.
- A wax-seal circular badge as the app's one signature ornamental component.
- Full light/dark palettes as sibling token sets (`:root` and `body.dark`), not a filter over one source of truth.

## Colors

Warm and low-saturation at rest — teal and gold both read as aged/antique rather than saturated brand colors — with a small, high-discipline set of semantic status colors carrying all the meaning-bearing color in the interface.

### Primary
- **Deep Teal Ink** (`#0A3634`, `--teal-900`): the ink of the ledger. Dominant surface for the hero stat and quick-clock panel (as a dark gradient with `--teal-950`), primary button fill, card heading rule.
- **Antique Gold** (`#AD8332`, `--gold`): the gilt trim. Top accent bar on stat cards, the card-heading bullet, progress-bar fill, the wax-seal's ring glow, quick-clock's primary "Clock In" action.

### Neutral
- **Aged Paper** (`#F6F2E8`, `--paper`): the page itself — page background, never used for cards or text.
- **Card Surface** (`#FFFFFE`, `--card`): the "page within the page" — every card, panel, and input background sits here, one step lighter/cooler than the paper behind it.
- **Ink** (`#1B2422`, `--ink`): primary text.
- **Muted** (`#68766F` light / `#9DACA6` dark, `--muted`): secondary/label text, meets 4.5:1 against both `--card` and `--paper`.
- **Muted Deep** (`#5F6B65` light / `#A9B7B1` dark, `--muted-2`): a second secondary-text step for content that carries real meaning ("0 of 21 days used") rather than pure decoration — deliberately darkened past a first pass that measured under the 4.5:1 WCAG AA floor.
- **Line / Line Soft** (`#DDD3BB` / `#EAE3D0`): borders and card-heading rules.

### Status (semantic, not decorative)
- **Positive** (`#256B42` on `#E3F1E7`): met/over-target states — badges, calendar dots, team status.
- **Info** (`#145C57` on `#E6EFEC`): its own token pair rather than raw teal-100/teal-700, because those two invert independently between light and dark and would collapse into near-identical colors in dark mode.
- **Negative** (`#AE3B3B` on `#F7E9E7`): under-target, destructive actions, delete/error states.
- **Excused** (`#755B14` on `#F2E9D2`): excused-absence states, shares gold's hue family.
- **Warn** (`#8A5F12` on `#FBF1DC`, border `#E4CB92`): open-shift and data-health warnings.

### Named Rules
**The Gilt Trim Rule.** Gold never fills a surface larger than a bar, badge, ring, or bullet. The moment gold becomes a background, the system has stopped being a ledger and started being a jewelry box.

**The 4.5:1 Rule.** Every text/background pairing carrying real information — not just decorative labels — is measured against WCAG AA 4.5:1 for its actual rendered size, in both themes, and darkened/lightened until it clears the floor rather than left "close enough."

## Typography

**Display Font:** "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif
**Body Font:** Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
**Numeral Font:** Calibri, "Segoe UI", Candara, Optima, "Trebuchet MS", sans-serif

**Character:** A humanist old-style serif for anything that reads as a heading or label of record ("Overview", "Monthly Avg", first-run titles), against a plain, highly legible sans for body copy and UI chrome, with a third, distinct sans reserved exclusively for numerals so every figure in the app — clock time, hero stat, table cell, chart bar label — shares one tabular voice regardless of where it appears.

### Hierarchy
- **Hero value** (700, 52px / 42px on narrow phones, line-height 1, tabular nums): the single largest figure on screen — Monthly Avg on the hero stat.
- **Stat value** (700, 32px, tabular nums): the figure inside a standard stat card.
- **Display title** (400, 17–19px, serif): card headings, period titles, first-run titles — always paired with the gold diamond bullet or divider rule.
- **Body** (400, 13–14px): form labels' values, table cells, general copy.
- **Label** (uppercase, 9.5–10px, letter-spacing .06–.14em): field labels, stat labels, status pills, the seal's caption line — always uppercase, always tracked out.

### Named Rules
**The Two-Voice Rule.** A heading is never set in the numeral font, and a number of record is never set in the display serif. The two faces are not interchangeable stylistic options; they mark two different kinds of content.

## Layout

Single-column content capped at 1080px and centered (`main{max-width:1080px}`), with generous outer padding (24–26px) that collapses on narrow phones. Stat cards and the settings form both use `auto-fit` grids with a hard minmax floor (`minmax(160px,1fr)` for stats, `minmax(170px,1fr)` for form fields) rather than a fixed column count, so native date/time controls never get squeezed narrower than their intrinsic width on any engine.

On mobile, a fixed bottom navigation bar takes over primary navigation (the desktop tab strip stays for view-switching within a screen), with the center Clock action deterministically centered regardless of how many left/right slots surround it. The Admin console is a dedicated full screen reached from the header, not a tab — it manages the organization, while the tab strip is scoped to the signed-in person's own attendance.

## Elevation & Depth

Shadows are ambient, not structural: a four-step scale (`--shadow-sm/md/lg/glow`) that signals hover and hierarchy, never simulates physical stacking height. Every card sits flush on the paper at rest and lifts by exactly one shadow step (plus a 1–3px translateY) on hover — a state response, not a resting elevation. The one deliberate exception is the wax-seal badge, whose inset ring and outer glow are the system's single piece of true skeuomorphism, reserved for its one ornamental signature component. Dark mode's shadows swap pure-black for a soft gold-tinted glow, since a black shadow barely reads against an already-dark page.

### Shadow Vocabulary
- **sm** (`0 1px 2px rgba(10,54,52,.06), 0 1px 1px rgba(10,54,52,.04)`): resting card elevation.
- **md** (`0 6px 20px rgba(10,54,52,.08), 0 2px 6px rgba(10,54,52,.05)`): hover state for cards and buttons.
- **lg** (`0 16px 40px rgba(10,54,52,.14), 0 4px 12px rgba(10,54,52,.08)`): modals and panels arriving into place.
- **glow** (`0 0 0 1px rgba(173,131,50,.14), 0 8px 28px rgba(173,131,50,.16)`): the gold-tinted hover state reserved for stat cards.

### Named Rules
**The Ambient-Not-Structural Rule.** Shadows respond to interaction; they never encode a permanent z-order. If two elements need to visually rank against each other at rest, that's a surface-color or border decision, not a shadow decision.

## Shapes

A deliberate four-step radius scale — `--radius-xs` (6px), `--radius-sm` (8px), `--radius-md` (10px), `--radius` (14px) — replacing what used to be seven scattered ad-hoc values. Small interactive controls (inputs, small buttons, calendar cells) take `sm`; containers and grouped controls (sub-tab tray, calendar grid) take `md`; cards, the hero stat, and the quick-clock panel take the top step, `lg`. Fully round (`99px`) is reserved for pill-shaped elements: status badges, the progress-bar track and fill, the team-status label. The wax-seal badge is the one true circle (`border-radius:50%`), matching its role as the system's single ornamental exception.

## Components

### Buttons
- **Shape:** `--radius-sm` (8px), min-height 42px (36px for `.small`).
- **Primary:** teal gradient fill (`--gradient-teal`), white text, a diagonal light-sweep highlight that travels across on hover (`::before` translate), 1px lift plus `shadow-md` on hover.
- **Secondary:** card-surface background, ink text, line border — a quieter twin of primary for the second action in a pair (e.g. "Fill Standard Hours" beside "Add Entry").
- **Ghost:** transparent, muted text, line border; turns teal on hover (border, text, and a wash background) with no lift or shadow — the default for dense toolbars (filters, calendar nav, print/export).
- **Danger ghost / danger solid:** same ghost shape but negative-colored, for destructive actions (bulk delete); danger-solid is the ghost's filled twin for the single highest-stakes confirm.
- **Quick-clock variants:** the primary quick-clock button swaps the gradient for solid gold (`--gradient-gold`) against the dark teal panel — the app's one deliberate reversal of the gilt-trim rule, reserved for the single most important action on the page (clocking in).

### Cards
- **Corner style:** `--radius` (14px).
- **Background:** `--card` on `--line-soft` border, always sitting on `--paper`.
- **Shadow strategy:** `shadow-sm` at rest, `shadow-md` on hover (see Elevation & Depth).
- **Heading:** serif display title with a rotated gold-gradient diamond bullet, underlined by a `--line-soft` rule.
- **Stat card:** adds a 3px gold-gradient bar clipped to the card's top edge and swaps its hover shadow for `shadow-glow`.
- **Hero stat / quick-clock:** the two dark-surface exceptions — deep teal gradient background with a soft gold radial highlight in the far corner, white/gold-light text instead of ink/muted.
- **Team card:** a clickable card variant (button semantics) with the same shadow/hover language, built around a circular teal-gradient avatar initial, a right-aligned pill status badge, and a two-column figures row.

### Badges / Pills
- **Style:** fully rounded (`99px`), a tinted background paired with its matching status color for text, a small `currentColor` dot with a soft glow before the label.
- **States:** `over`/`under`/`onit`/`excused`/`open`, one per status color; team-status pills reuse the same shape with their own state set (`in`/`done`/`off`/`excused`/`missing`).

### Inputs / Fields
- **Style:** `--radius-sm` border, `--line` border, `--input-bg` background, min-height 42px (never a fixed height, so native iOS date/time controls aren't clipped).
- **Focus:** border shifts to `--teal-600` with a soft 3px teal focus ring.
- **Error:** border and focus ring switch to the negative color (`.field-invalid`).
- **Label:** uppercase, 10px, `.08em` tracking, muted color, always above the field.

### Tabs
- **Primary tabs:** underline style — transparent background, 2px bottom border that turns gold on the active tab, active tab also gets a subtle teal-wash background and bolds its label.
- **Sub-tabs:** segmented-control style — a teal-wash tray holding pill-shaped buttons; the active sub-tab gets a white/card background and `shadow-sm`, rather than the underline treatment.

### The Seal (signature component)
A circular wax-seal badge (82px, 58–70px on mobile) used for the day's status: dark teal fill with a soft radial highlight, a dashed gold ring just inside the edge, and a slow ambient glow pulse (disabled under `prefers-reduced-motion`). Its ring recolors to positive/negative tints for over/under status without losing the seal shape. It is the system's one piece of true ornament — every other surface stays flat-with-ambient-shadow; the seal is allowed to look stamped.

## Do's and Don'ts

### Do:
- **Do** treat gold as trim: bars, bullets, rings, pill fills, progress fills — never a background or large fill.
- **Do** keep numbers in the tabular numeral font and headings in the display serif; never swap them.
- **Do** give every card a resting `shadow-sm` and a hover `shadow-md`/`shadow-glow` — elevation is a response to interaction, not a static rank.
- **Do** use the four-step radius scale (`xs/sm/md/lg`) and reach for `pill` (99px) specifically for badges and progress fills.
- **Do** measure any new text/background pairing against 4.5:1 in both themes before shipping it, especially secondary/meaningful text.

### Don't:
- **Don't** introduce a generic SaaS-dashboard look — flat corporate blue-and-white is the confirmed anti-reference for this system.
- **Don't** pin a fixed height on a form control that has to render a native date/time picker; use `min-height` and let the grid row stretch instead.
- **Don't** add a second ornamental/skeuomorphic component to sit alongside the seal — its whole effect depends on being the only element allowed to look stamped.
- **Don't** invent a new accent hue. Status color needs are covered by positive/info/negative/excused/warn; a new meaning reuses one of these before a new token is added.
