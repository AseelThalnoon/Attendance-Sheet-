---
name: Atrium
description: A bright, warm office floor — a near-black rail down one side, a greige canvas holding white and cream cards, and three pastel accents that are only ever fills.
colors:
  rail: "#111110"
  ink: "#111110"
  ink-950: "#0A0A09"
  ink-800: "#1C1C1A"
  ink-700: "#2A2A27"
  ink-600: "#3D3D38"
  wash: "#E4E2DC"
  wash-soft: "#EFEDE8"
  canvas: "#E9E7E2"
  card: "#FFFFFF"
  surface-cream: "#F0EADA"
  surface-gray: "#DFDDD9"
  lime: "#D6E85C"
  lime-deep: "#5C6B12"
  lime-light: "#E4F27A"
  mint: "#A9DCC6"
  blush: "#F0B9C9"
  muted: "#61605A"
  muted-2: "#57554F"
  line: "#D5D2CB"
  line-soft: "#E2DFD8"
  positive: "#1B6C4D"
  positive-bg: "#DCF0E6"
  info: "#3A3A36"
  info-bg: "#E4E2DC"
  negative: "#A83A55"
  negative-bg: "#FBE4EA"
  negative-solid: "#C0405E"
  negative-deep: "#8E2A42"
  excused: "#6B6410"
  excused-bg: "#F2EFD2"
  warn: "#7A5510"
  warn-bg: "#F7EFDA"
  input-bg: "#FFFFFF"
  iris-1: "#E8DCC8"
  iris-2: "#DCD9E8"
  iris-3: "#CFE4DC"
  iris-4: "#EFDCE2"
  ink-on-lime: "#1A1E05"
  muted-on-dark: "#A8A69E"
  positive-on-dark: "#A9DCC6"
  negative-on-dark: "#F0B9C9"
typography:
  display:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 700
    lineHeight: 1.05
  body:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 400
    lineHeight: 1.45
  numeral:
    fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
    fontWeight: 900
    lineHeight: 1
rounded:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "22px"
  pill: "99px"
spacing:
  sm: "10px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "11px 20px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px 20px 18px"
---

# Design System: Atrium

## Overview

**Creative North Star: "The Atrium"**

A bright, warm office floor rendered as an interface. A near-black rail runs
down one side — the building's spine, carrying navigation, today's status, and
who you are. Everything else is a light-filled well: a warm greige canvas
holding white, cream and gray cards with generous corner radii and soft ambient
shadows. Three pastel accents (lime, mint, blush) carry all the meaning-bearing
colour, and they are **only ever fills** — a chart arc, a progress bar, a status
ring, the glow behind the active nav item. Text stays near-black. That single
rule is what lets the palette be pastel without being illegible.

Typography is one geometric grotesk doing every job: Switzer, self-hosted, at
four weights. Headings are heavy and tightly tracked; figures are heavier still;
labels are 10px uppercase with wide letter-spacing. There is no serif anywhere,
and no second family — where the previous system used three faces to separate
headings from numbers, Atrium separates them by weight and size alone.

**Key characteristics**
- One dark region only: the rail. Every other surface is light, and a second
  large dark mass anywhere on the page is a mistake.
- Accents are fills, never text and never a text colour on a light ground.
- Surfaces distinguish cards from each other — white, cream, gray — rather than
  borders, stripes or accent bars.
- Large radii (22px cards, 99px pills) and soft, neutral, ambient shadows.
- One typeface, four weights, no serif.

**Confirmed rejection:** the previous "Gilt Ledger" world (teal ink, antique
gold trim, wax-seal ornament, ruled-paper texture, a serif display face) is the
explicit anti-reference. So is its multi-theme machinery.

## Colors

### Structure
- **Rail / Ink** (`#111110`, `--rail`, `--ink`): the sidebar, primary text,
  event bars, filled check circles, the primary button. One token, because in
  Atrium the darkest surface and the darkest text are the same value.
- **Canvas** (`#E9E7E2`, `--paper`): the warm greige page ground. Cards sit on
  it; it is never used for a card or for text.
- **Card** (`#FFFFFF`, `--card`): the default card surface.
- **Cream** (`#F0EADA`) and **Gray** (`#DFDDD9`): the two alternate card
  surfaces, used to separate tiles in a row without drawing a border.

### Accents (fills only)
- **Lime** (`#D6E85C`, `--gold`): the active-nav glow and bar, progress fills,
  the clock-in button. Retains the `--gold` token name because ~40 component
  rules refer to it as "the accent".
- **Lime Deep** (`#5C6B12`, `--gold-deep`): the one lime dark enough to set text
  or a meaningful line in. Chart target-reference lines use this.
- **Mint** (`#A9DCC6`) / **Blush** (`#F0B9C9`): met-target and under-target
  rings on week-timeline bars and the rail's status card.

### The iridescent tile
`--gradient-iris` (`#E8DCC8 → #DCD9E8 → #CFE4DC → #EFDCE2`): the system's one
decorative gradient, reserved for a single highlight surface — currently the
hero stat — so it stays an event rather than a texture. Ink text sits on it at
15:1; it is a *surface*, which is why it is exempt from the fill-only rule that
governs lime, mint and blush.

### Text
- **Muted** (`#61605A`) and **Muted Deep** (`#57554F`): the two secondary-text
  steps. Both clear 4.5:1 on all six surfaces the app paints text on.
- **Muted on Dark** (`#A8A69E`): secondary text on the rail.

### Status (semantic, not decorative)
`--positive` `#1B6C4D` on `#DCF0E6` · `--negative` `#A83A55` on `#FBE4EA` ·
`--excused` `#6B6410` on `#F2EFD2` · `--warn` `#7A5510` on `#F7EFDA` ·
`--info` `#3A3A36` on `#E4E2DC`. Each foreground clears 4.5:1 both on its own
tint and on the plain card/canvas/wash surfaces, because these colours land on
both.

### Named Rules

**The Fill-Only Rule.** Lime, mint and blush are fills: bars, arcs, rings, dots,
progress tracks, nav glows. The moment one of them becomes a text colour on a
light ground, it fails contrast — lime measures 1.35:1 on white. Where a
lime-family *line* has to carry meaning (a chart's target reference), use
`--gold-deep` at 5.89:1, never `--gold`.

**The Measured Floor.** Every text/background pairing carrying real information
is measured against WCAG AA 4.5:1 for its rendered size, and every meaningful
graphical object against 1.4.11's 3:1, before it ships. This is not decorative
rigour: the first pass of this palette put `--muted` at `#6E6C66`, which cleared
the floor on white and failed on canvas, cream and gray (3.87–4.49:1), and put
`--positive` at `#1F7A57`, which failed on its own tint. Both were darkened.

**One Dark Region.** The rail is the only large dark surface. The quick-clock
panel is the single deliberate exception, because clocking in is the primary
action and it earns the emphasis. A third would flatten both.

## Typography

**One family:** Switzer (self-hosted woff2, weights 400/500/700/900), falling
back to the system UI stack.

Switzer ships **no `tnum` feature**, but its digits are natively uniform-width
(576/1000 em at every weight), so figures align in a column without one.
`font-variant-numeric: tabular-nums` stays on `.num` cells regardless: it is a
no-op in Switzer and a real fix if the stack ever falls back to a system face.

### Hierarchy
- **Hero value** (900, 56px, `-.04em`): the single largest figure on screen.
- **Stat value** (900, 34px, `-.035em`): the figure inside a stat card.
- **Page greeting** (700, 40px, `-.03em`): "Hello {name}".
- **Card heading** (700, 21px, `-.025em`): no rule beneath, no bullet.
- **Body** (400, 13–14px).
- **Label / kicker** (600, 9.5–10px, uppercase, `.08–.14em`): every stat label,
  field label, nav item, meta line and status caption.

### Named Rule
**The Weight Rule.** Hierarchy comes from weight, size and letter-spacing, not
from a second family. A heading is 700 and tight; a figure is 900 and tighter; a
label is 10px uppercase and wide. Introducing a display face to mark a heading
means the scale stopped doing its job.

## Layout

A fixed 236px rail on the left above 760px, with content in a `.shell` offset by
the same amount and capped at 1280px. Below 760px the rail is replaced by the
existing bottom navigation — with its centred clock button, which is the primary
moment on a phone and does not move — and cards stack to one column.

The rail and the bottom nav hand over at **the same** breakpoint. An earlier
draft hid the rail at 900px while the bottom nav appeared at 760px, leaving a
140px band with neither.

The tab strip still exists in the DOM but is never shown: it is the single
activation path both nav surfaces click through to, so every render, filter and
admin rule stays in one place. Because that removes the visible tablist, the
rail carries `aria-current="page"` on the active destination.

## Elevation & Depth

Shadows are ambient and neutral, never structural: `--shadow-sm` at rest,
`--shadow-md` on hover, `--shadow-lg` for modals. Cards have **no border** —
separation comes from surface colour and shadow. Dark-mode shadow variants no
longer exist; there is one theme.

## Components

### The Rail
Wordmark, uppercase nav items with icons, today's status card, and a user block
(avatar, name, role). The active item turns lime and grows a lime bar pinned to
the left edge with a soft glow — the rail's one flash of colour.

### Today's status
A small dark card in the rail's foot: an uppercase label and one large figure.
It replaces the old wax-seal badge, keeping the job (one glanceable number for
today) and dropping the skeuomorphism. Over/under status shows as a coloured
left edge, never a tinted panel.

### Cards
22px radius, no border, `--shadow-sm` at rest. Headings are 700/21px with no
underline rule. In a stat row, the second and third cards take the cream and
gray surfaces so a four-tile row reads as four tiles.

### Buttons
Primary is solid ink with white text; secondary is a white card surface;
ghost is transparent with a line border. Danger-solid uses its own fixed
`--negative-solid`/`--negative-deep` pair, because `--negative` is tuned as a
*text* colour and is too muted to carry white text as a fill. Pills (99px) for
segmented controls and header actions.

### Avatar
One component everywhere a person appears. A photo when there is one, initials
on an ink tile when there is not — same size and shape either way, so a mixed
roster still lines up.

**Photos are device-local.** They are downscaled to a 256px square, stored as a
data URL in `localStorage` keyed by user id, and never uploaded. That means: a
teammate always renders as initials (their photo lives in their browser), a
photo does not follow you to another device, and an admin cannot set anyone
else's. This was a deliberate choice to consume no storage quota; the Settings
copy states it plainly rather than letting someone assume otherwise.

### Week timeline
An hour axis and seven day columns; each entry is an ink bar spanning its real
clock-in to clock-out, ringed mint or blush for met/under, hatched while a shift
is still open. All-day entries with no clock times become a chip pinned to the
top of the column rather than a bar at an arbitrary hour. The frame adapts to
the week's data — a fixed 6am–10pm window clamps an overnight shift into an
unreadable sliver.

### Badges / Pills, Inputs, Tables, Modals
Unchanged in structure from the previous system and inherited via the token
layer; only their palette, radii and type moved.

## Do's and Don'ts

### Do
- **Do** keep accents as fills, and reach for `--gold-deep` when a lime-family
  element must carry meaning against a light surface.
- **Do** measure any new text/background pair against 4.5:1 on all six surfaces
  before shipping it.
- **Do** separate cards by surface colour rather than by adding a border or an
  accent stripe.
- **Do** let weight and size carry hierarchy.

### Don't
- **Don't** add a second large dark region. The rail is the dark; the
  quick-clock panel is the one exception.
- **Don't** set text in lime, mint or blush on a light ground.
- **Don't** reintroduce a second typeface to distinguish headings or numerals.
- **Don't** add a theme switch or a dark-mode toggle. Both were deliberately
  retired, along with `app_settings.theme`; one committed look is the point.
- **Don't** give a control the `.sub-tab-btn` class for its looks — that class
  carries the Trends sub-tab click handler and will throw on a button with no
  `data-subtab`.
